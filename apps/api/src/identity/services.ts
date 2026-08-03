// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The identity service container: a single injectable bundle of the stores +
// config the auth/privacy routes depend on.  A module singleton (mirroring the
// CSRF `getTokenStore` pattern) lets routes and middleware resolve services
// without threading them through every handler; tests swap in a fresh in-memory
// bundle per case.

import { InMemoryUnitOfWork } from '../lib/in-memory-unit-of-work.js';
import { type AuditStore, InMemoryAuditStore } from './audit.js';
import type { AuthMethodInventory } from './auth-methods.js';
import { type EphemeralStore, InMemoryEphemeralStore } from './ephemeral-store.js';
import { SesMailer, type SesMailerConfig } from './mailer-ses.js';
import { InMemoryObjectStore, type ObjectStore } from './object-store.js';
import {
  DEFAULT_SIGNUP_POW_MAX_NUMBER,
  type PowCaptchaConfig,
  TEST_SIGNUP_POW_MAX_NUMBER,
} from './pow-captcha.js';
import { AuthRateLimiter, InMemoryAuthRateLimitStore } from './rate-limit-auth.js';
import { createLocalSecretBox, type SecretBox } from './secrets.js';
import type { AlertTransports } from './security-alerts.js';
import { InMemorySessionStore, type SessionStore } from './sessions.js';
import type { SiweConfig } from './siwe.js';
import { type IdentityStore, InMemoryIdentityStore } from './store.js';
import type { WebAuthnConfig } from './webauthn.js';

export interface IdentityConfig {
  /** Master secret (SESSION_SECRET) all keyed hashes derive from. */
  masterSecret: string;
  webauthn: WebAuthnConfig;
  siwe: SiweConfig;
  /** Sign-up proof-of-work CAPTCHA work factor (identity/pow-captcha.ts);
   *  0 = explicitly disabled. */
  signupPow: PowCaptchaConfig;
}

/** Outbound code/alert delivery.  Production wires SMTP/push; tests record. */
export interface Mailer {
  sendCode(to: string, code: string, kind: 'login' | 'verify'): Promise<void>;
  /** A notice (e.g. a deletion-cancellation link).  `payload` carries link tokens. */
  sendNotice(to: string, kind: string, payload?: Record<string, string>): Promise<void>;
}

/**
 * A mailer that only emits structured observability — it NEVER logs the code or
 * the recipient address (§19.1 minimization).  It is the SILENT mailer used for
 * CI / NODE_ENV=test and for an explicit mail-less deployment
 * (`ALLOW_INSECURE_NULL_MAILER`); a real SMTP/email provider swaps in behind the
 * {@link Mailer} interface in production.  Genuine LOCAL development instead uses
 * {@link createDevMailer} (which surfaces the code so the email flows are
 * testable without a mail server) — selected only under NODE_ENV=development by
 * {@link selectMailer}.  This keeps observability honest without leaking secrets
 * or PII into logs anywhere a log line could outlive the developer's machine.
 */
export function createLoggingMailer(
  log: (event: string, meta: Record<string, unknown>) => void,
): Mailer {
  return {
    async sendCode(_to: string, _code: string, kind: 'login' | 'verify'): Promise<void> {
      log('auth.mail.code_requested', { kind });
    },
    // The cancellation-link token in `payload` is NEVER logged (§19.1).
    async sendNotice(_to: string, kind: string): Promise<void> {
      log('auth.mail.notice_requested', { kind });
    },
  };
}

/**
 * A DEVELOPMENT-ONLY mailer that SURFACES one-time codes and notice payloads to
 * the local server log instead of delivering email.  Without it, a `pnpm dev`
 * machine has no mail provider, so the passwordless email flows are dead ends:
 * an email registration logs the account in with a REDUCED-capability,
 * unconfirmed-email session (WS-D.1.1a) that can never become verified, and an
 * email sign-in code can never be redeemed.  Surfacing the code lets the
 * developer read it from the API terminal and complete the SAME real,
 * rate-limited, attempt-bound verify flow production uses (`/profile/security`
 * "Verify", or the sign-in code panel) — no special-case verification bypass,
 * so dev exercises the production path exactly.
 *
 * SECURITY: reachable ONLY through {@link selectMailer} under
 * NODE_ENV=development with no SES binding and no `ALLOW_INSECURE_NULL_MAILER`
 * opt-out — never in production, staging, CI, or test (where the silent
 * {@link createLoggingMailer} / {@link RecordingMailer} are used instead).
 * Logging the code + recipient is therefore not a §19.1 leak: the data is the
 * developer's own ephemeral in-memory test account on their own machine, and the
 * environment gate guarantees these lines can never appear in a deployed system.
 */
export function createDevMailer(
  log: (event: string, meta: Record<string, unknown>) => void,
): Mailer {
  const note = 'DEV ONLY — no email was sent; use this to continue the flow locally.';
  return {
    async sendCode(to: string, code: string, kind: 'login' | 'verify'): Promise<void> {
      log('auth.mail.dev_code', { to, kind, code, note });
    },
    async sendNotice(to: string, kind: string, payload?: Record<string, string>): Promise<void> {
      log('auth.mail.dev_notice', { to, kind, ...(payload ?? {}), note });
    },
  };
}

/**
 * Select the production mailer, FAILING CLOSED.  With an SES config (the
 * all-or-none `SES_*` env group) the real provider binding is used in any
 * environment.  Without one:
 *
 *   - production refuses to boot — returning a sendless mailer would let email
 *     login/verification/deletion-cancel flows report success while no mail is
 *     ever delivered, a silent, dangerous no-op — unless the operator EXPLICITLY
 *     opts into a mail-less deployment (`ALLOW_INSECURE_NULL_MAILER=true`, e.g. a
 *     passkey/wallet-only instance), in which case it warns loudly and stays
 *     silent;
 *   - local development (NODE_ENV=development) uses {@link createDevMailer},
 *     which SURFACES the one-time code to the API log so the passwordless email
 *     flows (sign-in, email-factor verification, deletion-cancel) are testable
 *     end-to-end without a mail server — there is otherwise no way to become a
 *     verified account on a `pnpm dev` box;
 *   - every other case (CI / NODE_ENV=test) uses the silent logging mailer.
 */
export function selectMailer(opts: {
  nodeEnv: string;
  allowNullMailer: boolean;
  ses?: SesMailerConfig | null;
  log: (event: string, meta: Record<string, unknown>) => void;
  warn: (msg: string) => void;
}): Mailer {
  if (opts.ses) return new SesMailer(opts.ses);
  if (opts.nodeEnv === 'production' && !opts.allowNullMailer) {
    throw new Error(
      'No email provider is configured: email login codes, verification, and ' +
        'deletion-cancellation links cannot be delivered. Set the SES_* env group, ' +
        'or set ALLOW_INSECURE_NULL_MAILER=true to run an email-less ' +
        '(passkey/wallet-only) deployment.',
    );
  }
  // An explicit mail-less opt-out wins over the dev convenience: it means "this
  // instance intentionally sends nothing", so stay silent even in development.
  if (opts.allowNullMailer) {
    opts.warn(
      'Email delivery is DISABLED (ALLOW_INSECURE_NULL_MAILER): email-based ' +
        'login/verification/deletion links will NOT be sent.',
    );
    return createLoggingMailer(opts.log);
  }
  // No real provider and not production: surface codes locally so dev email
  // flows work; production never reaches here (it threw above).
  if (opts.nodeEnv === 'development') {
    return createDevMailer(opts.log);
  }
  return createLoggingMailer(opts.log);
}

/** A no-op mailer that records every send, for assertions in tests. */
export class RecordingMailer implements Mailer {
  readonly codes: Array<{ to: string; code: string; kind: 'login' | 'verify' }> = [];
  readonly notices: Array<{ to: string; kind: string; payload?: Record<string, string> }> = [];
  async sendCode(to: string, code: string, kind: 'login' | 'verify'): Promise<void> {
    this.codes.push({ to, code, kind });
  }
  async sendNotice(to: string, kind: string, payload?: Record<string, string>): Promise<void> {
    this.notices.push({ to, kind, ...(payload ? { payload } : {}) });
  }
}

/**
 * The stores one identity UNIT writes through, bound to a single handle.
 *
 * A WS-D handler rarely changes one thing: disabling email sign-in writes the
 * user row AND the auth row and appends the record of it, and those three are
 * one fact about one action. Sequential writes make every failure a different
 * half-applied account — an email cleared with `emailVerified` still true, or a
 * credential removed with nothing in the trail to say who did it.
 */
export interface IdentityTx {
  readonly store: IdentityStore;
  /** The audit append, bound to the SAME handle as the writes above. */
  readonly audit: AuditStore;
  /**
   * The §19.3 attention purge, bound to THIS handle.
   *
   * Erasing attention history is the one identity action whose durable change
   * lives in a different workstream's stores (WS-E events, aggregates, ledger,
   * behaviour). Calling the ordinary hook from inside the unit only LOOKS
   * transactional: it writes through separately-composed stores, so a purge
   * that succeeded followed by a commit that failed destroyed the user's data
   * irreversibly, rolled the `attention_delete` record back, and answered 500 —
   * an erasure that happened, is denied, and has no record.
   *
   * The WS-E Drizzle stores all take an executor, so the production root binds
   * them to the identity transaction and the two commit or fail together.
   * Optional because a root that cannot bind them (a future split database)
   * must say so by absence rather than by pretending.
   */
  readonly purgeAttention?: (userId: string, mode: 'delete' | 'reset') => Promise<number>;
}

export interface IdentityServices {
  config: IdentityConfig;
  store: IdentityStore;
  /**
   * Commit an identity change WITH its record — and with its own other writes.
   *
   * The same seam WS-J and WS-H carry (`ModerationTransactor`,
   * `InvariantPlatformServices.transact`) over the shared
   * `lib/in-memory-unit-of-work.ts`: one `db.transaction` in production, an
   * atomic + serialised fold in the in-memory twin.
   */
  transact<T>(work: (tx: IdentityTx) => Promise<T>): Promise<T>;
  sessions: SessionStore;
  /** WebAuthn challenges + SIWE nonces. */
  challenges: EphemeralStore;
  /** Email one-time codes + resend cooldowns. */
  otp: EphemeralStore;
  rateLimit: AuthRateLimiter;
  audit: AuditStore;
  mailer: Mailer;
  /** Authenticated encryption for secrets at rest (the steward TOTP secret). */
  secretBox: SecretBox;
  /** Encrypted object storage for DSAR export archives (WS-D.2.2c). */
  objectStore: ObjectStore;
  /** WS-E: the user's own attention aggregates for the export (default none). */
  exportAttention?: (userId: string) => Promise<unknown[]>;
  /** WS-G: the user's own contributions for the export (default none). */
  exportContributions?: (userId: string) => Promise<unknown[]>;
  /** WS-J: moderation notices received (reason only, never reporter identity). */
  exportModerationNotices?: (userId: string) => Promise<unknown[]>;
  /** WS-L: the user's own financial wallet links + receipts for the export —
   *  truncated display address only, never the address hash (default none). */
  exportFinancialWallets?: (userId: string) => Promise<Record<string, unknown[]>>;
  /** WS-N: the user's compliance footprint for the export — region
   *  declaration + disclosure acknowledgments + case METADATA only (no notes,
   *  never SAR/investigation detail — the anti-tipping-off exclusion is a
   *  documented legal-obligation carve-out) (default none). */
  exportComplianceData?: (userId: string) => Promise<Record<string, unknown>>;
  /** WS-G: anonymize the user's contributions on hard deletion (default no-op). */
  anonymizeContributions?: (userId: string) => Promise<void>;
  /** WS-L: purge the user's financial wallet rows + receipts on hard deletion
   *  (default no-op) — so a linked wallet never outlives the account. */
  purgeFinancialWallets?: (userId: string) => Promise<void>;
  /** WS-N: the compliance erasure sweep — declarations delete, acks
   *  anonymize, case subjects scrub EXCEPT under a legal hold (the audited
   *  carve-out; erased when the hold lapses) (default no-op). */
  purgeCompliance?: (userId: string) => Promise<void>;
  /**
   * Downstream propagation hook (WS-E): invoked when a settings change affects
   * collection, so disabling personalization / setting retention to `none`
   * actually stops collection rather than just flipping a UI toggle (§19.3).
   */
  onPrivacyChange?: (change: {
    userId: string;
    personalizationEnabled: boolean;
    retention: string;
  }) => void;
  /** Attention-history purge (WS-E owns the store); returns the rows removed. */
  purgeAttention?: (userId: string, mode: 'delete' | 'reset') => Promise<number>;
  /** WS-C client-state purge on hard deletion: push subscriptions +
   *  notification preferences + settings-sync rows (default no-op).  Explicit
   *  — production deletion TOMBSTONES the users row, so FK cascades never
   *  fire there. */
  purgeClientState?: (userId: string) => Promise<void>;
  /** WS-S §21.4 private-room DIRECTORY purge on hard deletion (default no-op).
   *  A stub carries its creator's account reference, public display metadata
   *  and timestamps; deletion tombstones the users row, so the FK `set null`
   *  never fires and the record would otherwise outlive the account as exactly
   *  the durable "this account created a private room at time T" trace that
   *  `remove()` exists to erase. Removes the shell with the stub; member
   *  devices keep the room, because the server never held it. */
  purgePrivateRoomStubs?: (userId: string) => Promise<void>;
  /** WS-S §21 private-room DIRECTORY export (GDPR Art. 15), the READ mirror of
   *  `purgePrivateRoomStubs`: the same durable rows the purge removes reach the
   *  archive as `private_room_directory`.  Deletion and disclosure are one
   *  obligation seen from two sides — a record the purge can find is a record
   *  the export must declare.  Room CONTENT is absent because the server never
   *  held any; what is here is the bootstrap POINTER the account created
   *  (default absent ⇒ an empty list). */
  exportPrivateRoomStubs?: (userId: string) => Promise<unknown[]>;
  /** WS-C/WS-T client-state DSAR export (GDPR Art. 15): the SAME durable
   *  per-user rows purgeClientState removes — settings sync, notification
   *  preferences, the reply-notification inbox — included in the export
   *  archive as `client_state` (default absent ⇒ empty object). */
  exportClientState?: (userId: string) => Promise<Record<string, unknown>>;
  /** WS-D.1.4d out-of-band security-alert delivery (email via the mailer, push
   *  via a bodyless Web Push wake).  Wired at boot; absent ⇒ the in-app
   *  security-activity log entry (always written) is the only channel. */
  alertTransports?: AlertTransports;
  /** True when the user currently holds ≥1 push subscription AND Web Push is
   *  configured — the `hasPush` input to the alert channel selection. */
  hasPushChannel?: (userId: string) => boolean | Promise<boolean>;
}

const DEFAULT_CHAIN_ALLOWLIST = [1, 8453, 42161, 10] as const; // mainnet, Base, Arbitrum, Optimism
// A NON-PRODUCTION box never accepts a mainnet/L2 sign-in: dev/test wallet login is
// scoped to the Knomosis L2 (8357) + its Sepolia L1 (11155111), so a dev never signs
// a mainnet-bound message.  Production keeps the multi-chain default above.
const DEV_CHAIN_ALLOWLIST = [8357, 11155111] as const; // Knomosis L2, Ethereum Sepolia

/** Parse the optional per-chain RPC JSON map; tolerate malformed input → {}. */
export function parseChainRpcUrls(raw: string | undefined): Record<number, string> {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return {};
    const out: Record<number, string> = {};
    for (const [k, v] of Object.entries(parsed)) {
      const chainId = Number(k);
      if (Number.isInteger(chainId) && typeof v === 'string' && /^https?:\/\//.test(v)) {
        out[chainId] = v;
      }
    }
    return out;
  } catch {
    return {};
  }
}

/** Derive identity config from the validated server env (origin → rpID/domain). */
export function identityConfigFromEnv(env: {
  SESSION_SECRET: string;
  CORS_ORIGIN: string;
  CHAIN_RPC_URLS?: string | undefined;
  NODE_ENV?: string | undefined;
  SIGNUP_POW_MAX_NUMBER?: number | undefined;
}): IdentityConfig {
  const origin = env.CORS_ORIGIN.replace(/\/$/, '');
  const host = (() => {
    try {
      return new URL(origin).host;
    } catch {
      return origin;
    }
  })();
  return {
    masterSecret: env.SESSION_SECRET,
    webauthn: { rpName: 'Licio', rpID: host.split(':')[0] ?? host, origin },
    siwe: {
      domain: host,
      uri: origin,
      chainAllowlist:
        env.NODE_ENV === 'production' ? [...DEFAULT_CHAIN_ALLOWLIST] : [...DEV_CHAIN_ALLOWLIST],
      chainRpcUrls: parseChainRpcUrls(env.CHAIN_RPC_URLS),
    },
    signupPow: {
      // The gate is ON by default in every environment (production-complete
      // posture); 0 is the explicit operator opt-out.  Tests run the REAL flow
      // at a negligible work factor.
      maxNumber:
        env.SIGNUP_POW_MAX_NUMBER ??
        (env.NODE_ENV === 'test' ? TEST_SIGNUP_POW_MAX_NUMBER : DEFAULT_SIGNUP_POW_MAX_NUMBER),
    },
  };
}

/** Build a fresh, fully in-memory service bundle (tests/CI; prod swaps adapters). */
export function createInMemoryIdentityServices(config: IdentityConfig): IdentityServices {
  const store = new InMemoryIdentityStore();
  const audit = new InMemoryAuditStore();
  // The stores are read from `services` at RUN time: the production boot swaps
  // the Drizzle adapters in afterwards, and a unit that captured the in-memory
  // ones would keep writing where nothing else reads.
  const unit = new InMemoryUnitOfWork<IdentityTx>(
    {
      get store(): IdentityStore {
        return services.store;
      },
      get audit(): AuditStore {
        return services.audit;
      },
      // In-memory: the same hook, run inside the unit so the ORDER holds (the
      // record is appended first, and a failing purge aborts it). It is NOT the
      // full guarantee — the WS-E in-memory stores register no rollback, so a
      // purge that succeeded before a later failure stays done here. The
      // rollback is the PRODUCTION binding's, where the WS-E stores are built
      // over the identity transaction's own executor; this twin deliberately
      // does not pretend to more than it has.
      purgeAttention: (userId, mode) =>
        services.purgeAttention?.(userId, mode) ?? Promise.resolve(0),
    },
    () => [
      ...(services.store instanceof InMemoryIdentityStore ? [services.store] : []),
      ...(services.audit instanceof InMemoryAuditStore ? [services.audit] : []),
    ],
  );
  const services: IdentityServices = {
    config,
    store,
    transact: (work) => unit.run(work),
    sessions: new InMemorySessionStore(),
    challenges: new InMemoryEphemeralStore(),
    otp: new InMemoryEphemeralStore(),
    rateLimit: new AuthRateLimiter(new InMemoryAuthRateLimitStore()),
    audit,
    mailer: new RecordingMailer(),
    secretBox: createLocalSecretBox(config.masterSecret),
    objectStore: new InMemoryObjectStore(createLocalSecretBox(config.masterSecret)),
  };
  return services;
}

let _services: IdentityServices | undefined;

// A FIXED, NON-SECRET test config used ONLY under NODE_ENV=test, so unit tests
// that touch an identity route without explicitly wiring services still run.
// Production must call `setIdentityServices` with a real, env-derived config; the
// getter throws otherwise (no hardcoded secret can ever reach production).
const TEST_CONFIG: IdentityConfig = {
  masterSecret: 'test-master-secret-at-least-32-characters-long',
  webauthn: { rpName: 'Licio', rpID: 'localhost', origin: 'http://localhost' },
  siwe: { domain: 'localhost', uri: 'http://localhost', chainAllowlist: [1] },
  signupPow: { maxNumber: TEST_SIGNUP_POW_MAX_NUMBER },
};

export function getIdentityServices(): IdentityServices {
  if (_services) return _services;
  if (process.env['NODE_ENV'] === 'test') {
    _services = createInMemoryIdentityServices(TEST_CONFIG);
    return _services;
  }
  throw new Error(
    'Identity services not configured — call setIdentityServices() at startup (apps/api/src/index.ts)',
  );
}

export function setIdentityServices(services: IdentityServices): void {
  _services = services;
}

/**
 * Build the identity services from the validated server env.  The master secret
 * and RP-ID/SIWE bindings come from SESSION_SECRET/CORS_ORIGIN — never a hardcoded
 * value.  When a Redis client is supplied, the live session, ephemeral-secret, and
 * rate-limit stores are Redis-backed (durable across restarts); otherwise they are
 * in-memory (suitable for local single-process dev).
 */
export function buildIdentityServicesFromEnv(
  env: {
    SESSION_SECRET: string;
    CORS_ORIGIN: string;
    CHAIN_RPC_URLS?: string | undefined;
    NODE_ENV?: string | undefined;
    SIGNUP_POW_MAX_NUMBER?: number | undefined;
  },
  adapters?: Partial<
    Pick<
      IdentityServices,
      'sessions' | 'challenges' | 'otp' | 'rateLimit' | 'store' | 'audit' | 'mailer'
    >
  >,
): IdentityServices {
  const base = createInMemoryIdentityServices(identityConfigFromEnv(env));
  return { ...base, ...adapters };
}

/** Build the auth-method inventory for the last-method guard / verified check. */
export async function authMethodInventory(
  services: IdentityServices,
  userId: string,
): Promise<AuthMethodInventory> {
  const auth = await services.store.getAuth(userId);
  return {
    passkeys: (await services.store.listWebauthn(userId)).length,
    emailVerified: auth?.emailVerified ?? false,
    authWallets: (await services.store.listWalletAuth(userId)).length,
  };
}

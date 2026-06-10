// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The identity service container: a single injectable bundle of the stores +
// config the auth/privacy routes depend on.  A module singleton (mirroring the
// CSRF `getTokenStore` pattern) lets routes and middleware resolve services
// without threading them through every handler; tests swap in a fresh in-memory
// bundle per case.

import { type AuditStore, InMemoryAuditStore } from './audit.js';
import type { AuthMethodInventory } from './auth-methods.js';
import { type EphemeralStore, InMemoryEphemeralStore } from './ephemeral-store.js';
import { InMemoryObjectStore, type ObjectStore } from './object-store.js';
import { AuthRateLimiter, InMemoryAuthRateLimitStore } from './rate-limit-auth.js';
import { createLocalSecretBox, type SecretBox } from './secrets.js';
import { InMemorySessionStore, type SessionStore } from './sessions.js';
import type { SiweConfig } from './siwe.js';
import { IdentityStore } from './store.js';
import type { WebAuthnConfig } from './webauthn.js';

export interface IdentityConfig {
  /** Master secret (SESSION_SECRET) all keyed hashes derive from. */
  masterSecret: string;
  webauthn: WebAuthnConfig;
  siwe: SiweConfig;
}

/** Outbound code/alert delivery.  Production wires SMTP/push; tests record. */
export interface Mailer {
  sendCode(to: string, code: string, kind: 'login' | 'verify'): Promise<void>;
  /** A notice (e.g. a deletion-cancellation link).  `payload` carries link tokens. */
  sendNotice(to: string, kind: string, payload?: Record<string, string>): Promise<void>;
}

/**
 * A mailer that only emits structured observability — it NEVER logs the code or
 * the recipient address (§19.1 minimization).  Production swaps a real SMTP/email
 * provider behind the {@link Mailer} interface; this keeps dev/observability honest
 * without leaking secrets or PII into logs.
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
 * Select the production mailer, FAILING CLOSED.  The real SMTP/provider mailer is
 * a deferred cloud adapter; until it lands, the only implementation is the
 * dev/CI logging mailer (which sends nothing).  Returning that in production would
 * let email login/verification/deletion-cancel flows report success while no mail
 * is ever delivered — a silent, dangerous no-op.  So in production we refuse to
 * boot unless the operator EXPLICITLY opts into a mail-less deployment
 * (`ALLOW_INSECURE_NULL_MAILER=true`, e.g. a passkey/wallet-only instance), in
 * which case we log a prominent warning.  Dev/test always use the logging mailer.
 */
export function selectMailer(opts: {
  nodeEnv: string;
  allowNullMailer: boolean;
  log: (event: string, meta: Record<string, unknown>) => void;
  warn: (msg: string) => void;
}): Mailer {
  if (opts.nodeEnv === 'production' && !opts.allowNullMailer) {
    throw new Error(
      'No email provider is configured: email login codes, verification, and ' +
        'deletion-cancellation links cannot be delivered. Configure a real mailer ' +
        'before production, or set ALLOW_INSECURE_NULL_MAILER=true to run an ' +
        'email-less (passkey/wallet-only) deployment.',
    );
  }
  if (opts.allowNullMailer) {
    opts.warn(
      'Email delivery is DISABLED (ALLOW_INSECURE_NULL_MAILER): email-based ' +
        'login/verification/deletion links will NOT be sent.',
    );
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

export interface IdentityServices {
  config: IdentityConfig;
  store: IdentityStore;
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
  /** WS-G: anonymize the user's contributions on hard deletion (default no-op). */
  anonymizeContributions?: (userId: string) => Promise<void>;
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
}

const DEFAULT_CHAIN_ALLOWLIST = [1, 8453, 42161, 10] as const; // mainnet, Base, Arbitrum, Optimism

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
  CHAIN_RPC_URLS?: string;
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
      chainAllowlist: [...DEFAULT_CHAIN_ALLOWLIST],
      chainRpcUrls: parseChainRpcUrls(env.CHAIN_RPC_URLS),
    },
  };
}

/** Build a fresh, fully in-memory service bundle (tests/CI; prod swaps adapters). */
export function createInMemoryIdentityServices(config: IdentityConfig): IdentityServices {
  return {
    config,
    store: new IdentityStore(),
    sessions: new InMemorySessionStore(),
    challenges: new InMemoryEphemeralStore(),
    otp: new InMemoryEphemeralStore(),
    rateLimit: new AuthRateLimiter(new InMemoryAuthRateLimitStore()),
    audit: new InMemoryAuditStore(),
    mailer: new RecordingMailer(),
    secretBox: createLocalSecretBox(config.masterSecret),
    objectStore: new InMemoryObjectStore(createLocalSecretBox(config.masterSecret)),
  };
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
  env: { SESSION_SECRET: string; CORS_ORIGIN: string },
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
export function authMethodInventory(
  services: IdentityServices,
  userId: string,
): AuthMethodInventory {
  const auth = services.store.getAuth(userId);
  return {
    passkeys: services.store.listWebauthn(userId).length,
    emailVerified: auth?.emailVerified ?? false,
    authWallets: services.store.listWalletAuth(userId).length,
  };
}

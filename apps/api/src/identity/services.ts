// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The identity service container: a single injectable bundle of the stores +
// config the auth/privacy routes depend on.  A module singleton (mirroring the
// CSRF `getTokenStore` pattern) lets routes and middleware resolve services
// without threading them through every handler; tests swap in a fresh in-memory
// bundle per case.

import { type AuditStore, InMemoryAuditStore } from './audit.js';
import type { AuthMethodInventory } from './auth-methods.js';
import { deriveKey, hmacHex, KEY_DOMAINS } from './crypto.js';
import { type EphemeralStore, InMemoryEphemeralStore } from './ephemeral-store.js';
import { AuthRateLimiter, InMemoryAuthRateLimitStore } from './rate-limit-auth.js';
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
  sendNotice(to: string, kind: string): Promise<void>;
}

/** A no-op mailer that records every send, for assertions in tests. */
export class RecordingMailer implements Mailer {
  readonly codes: Array<{ to: string; code: string; kind: 'login' | 'verify' }> = [];
  readonly notices: Array<{ to: string; kind: string }> = [];
  async sendCode(to: string, code: string, kind: 'login' | 'verify'): Promise<void> {
    this.codes.push({ to, code, kind });
  }
  async sendNotice(to: string, kind: string): Promise<void> {
    this.notices.push({ to, kind });
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

/** Derive identity config from the validated server env (origin → rpID/domain). */
export function identityConfigFromEnv(env: {
  SESSION_SECRET: string;
  CORS_ORIGIN: string;
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
    siwe: { domain: host, uri: origin, chainAllowlist: [...DEFAULT_CHAIN_ALLOWLIST] },
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
  };
}

let _services: IdentityServices | undefined;

const TEST_CONFIG: IdentityConfig = {
  masterSecret: 'test-master-secret-at-least-32-characters-long',
  webauthn: { rpName: 'Licio', rpID: 'localhost', origin: 'http://localhost' },
  siwe: { domain: 'localhost', uri: 'http://localhost', chainAllowlist: [1] },
};

export function getIdentityServices(): IdentityServices {
  if (!_services) _services = createInMemoryIdentityServices(TEST_CONFIG);
  return _services;
}

export function setIdentityServices(services: IdentityServices): void {
  _services = services;
}

/** Keyed, non-reversible IP hash (never a plaintext IP in storage, §19.5). */
export function hashIp(masterSecret: string, ip: string): string {
  return hmacHex(deriveKey(masterSecret, KEY_DOMAINS.ipHash), ip);
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

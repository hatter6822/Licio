// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import * as auth from '../schemas/auth-api.js';
import {
  type AuthMethod,
  authAssuranceSchema,
  canTransitionUnlinkState,
  sessionRecordSchema,
  sessionSummarySchema,
  UNLINK_STATES,
  UNLINK_TRANSITIONS,
  type UnlinkState,
  userAuthRecordSchema,
  walletAccountSchema,
  walletAuthCredentialSchema,
  webauthnCredentialSchema,
} from '../schemas/identity-records.js';

const UUID = '11111111-1111-4111-8111-111111111111';
const TS = '2026-01-01T00:00:00.000Z';

describe('unlink state machine', () => {
  it('permits exactly the declared transitions and rejects all others', () => {
    for (const from of UNLINK_STATES) {
      for (const to of UNLINK_STATES) {
        const allowed = UNLINK_TRANSITIONS[from].includes(to);
        expect(canTransitionUnlinkState(from as UnlinkState, to as UnlinkState)).toBe(allowed);
      }
    }
  });

  it('treats `finalized` as terminal', () => {
    expect(UNLINK_TRANSITIONS.finalized).toHaveLength(0);
  });

  it('allows active → pending_unlink → finalized and a cancel back to active', () => {
    expect(canTransitionUnlinkState('active', 'pending_unlink')).toBe(true);
    expect(canTransitionUnlinkState('pending_unlink', 'finalized')).toBe(true);
    expect(canTransitionUnlinkState('pending_unlink', 'active')).toBe(true);
    expect(canTransitionUnlinkState('active', 'finalized')).toBe(false);
  });
});

describe('sessionRecordSchema', () => {
  const base = {
    user_id: UUID,
    auth_method: 'webauthn' as AuthMethod,
    credential_ref: 'abcd',
    created_at: TS,
    last_active_at: TS,
    device_label: 'MacBook',
    remember_me: true,
    mfa_verified: false,
    auth_assurance: { level: 'full' as const, last_verified_at: TS },
    absolute_expires_at: TS,
  };

  it('round-trips a valid record', () => {
    expect(() => sessionRecordSchema.parse(base)).not.toThrow();
  });

  it('records NO ip_hash, country, or raw user-agent (privacy amendment §19.1)', () => {
    const parsed = sessionRecordSchema.parse(base);
    for (const forbidden of ['ip_hash', 'country', 'user_agent_truncated']) {
      expect(forbidden in parsed).toBe(false);
    }
    expect(() => sessionRecordSchema.parse({ ...base, ip_hash: 'x' })).toThrow();
    expect(() => sessionRecordSchema.parse({ ...base, country: 'US' })).toThrow();
  });

  it('allows a null credential_ref (email_otp sessions)', () => {
    expect(() =>
      sessionRecordSchema.parse({ ...base, auth_method: 'email_otp', credential_ref: null }),
    ).not.toThrow();
  });

  it('rejects an unknown auth method', () => {
    expect(() => sessionRecordSchema.parse({ ...base, auth_method: 'password' })).toThrow();
  });

  it('rejects extra keys', () => {
    expect(() => sessionRecordSchema.parse({ ...base, ip: '1.2.3.4' })).toThrow();
  });
});

describe('authAssuranceSchema', () => {
  it('accepts reduced and full', () => {
    expect(authAssuranceSchema.parse({ level: 'reduced', last_verified_at: TS }).level).toBe(
      'reduced',
    );
    expect(authAssuranceSchema.parse({ level: 'full', last_verified_at: TS }).level).toBe('full');
  });
});

describe('sessionSummarySchema', () => {
  it('exposes only a non-reversible ref + coarse device descriptor (no IP, no location)', () => {
    const summary = sessionSummarySchema.parse({
      session_ref: 'a1b2c3',
      device_label: 'iPhone',
      auth_method: 'email_otp',
      created_at: TS,
      last_active_at: TS,
      current: true,
    });
    expect(summary.session_ref).toBe('a1b2c3');
    // The summary shape has no token, IP, or location field.
    expect('ip_hash' in summary).toBe(false);
    expect('country' in summary).toBe(false);
    expect('token' in summary).toBe(false);
  });
});

describe('webauthnCredentialSchema', () => {
  it('round-trips a platform credential', () => {
    expect(() =>
      webauthnCredentialSchema.parse({
        credential_id: 'Y3JlZA',
        user_id: UUID,
        public_key: 'cHVibGlj',
        counter: 5,
        device_type: 'platform',
        device_name: 'Touch ID',
        transports: ['internal', 'hybrid'],
        backed_up: true,
        created_at: TS,
        last_used_at: null,
      }),
    ).not.toThrow();
  });

  it('rejects a negative counter', () => {
    expect(() =>
      webauthnCredentialSchema.parse({
        credential_id: 'Y3JlZA',
        user_id: UUID,
        public_key: 'cHVibGlj',
        counter: -1,
        device_type: 'platform',
        device_name: null,
        transports: [],
        backed_up: false,
        created_at: TS,
        last_used_at: null,
      }),
    ).toThrow();
  });
});

describe('walletAuthCredentialSchema and walletAccountSchema store no plaintext address', () => {
  it('carry only a hash + truncated display form', () => {
    const authCred = walletAuthCredentialSchema.parse({
      credential_id: UUID,
      user_id: UUID,
      address_hash: 'hmachex',
      address_truncated: '0x12ab…cd34',
      chain_id: 1,
      wallet_type: 'eoa',
      created_at: TS,
      last_used_at: null,
    });
    expect('address' in authCred).toBe(false);

    const account = walletAccountSchema.parse({
      wallet_account_id: UUID,
      user_id: UUID,
      address_hash: 'hmachex',
      address_truncated: '0x12ab…cd34',
      chain_id: 1,
      wallet_type: 'contract',
      unlink_state: 'active',
      risk_state: 'pending',
      label: null,
      linked_at: TS,
      last_used_at: null,
    });
    expect('address' in account).toBe(false);
  });
});

describe('userAuthRecordSchema has no password material', () => {
  it('parses email/MFA flags and forbids a password column', () => {
    const record = userAuthRecordSchema.parse({
      user_id: UUID,
      email_verified: true,
      email_verified_at: TS,
      mfa_enabled: false,
      mfa_enrolled_at: null,
    });
    const keys = Object.keys(record);
    expect(keys.some((k) => /pass(word|hash)/i.test(k))).toBe(false);
  });
});

describe('no identity schema exposes a password field', () => {
  it('sweeps every exported zod object shape', () => {
    const schemas = [
      sessionRecordSchema,
      sessionSummarySchema,
      userAuthRecordSchema,
      webauthnCredentialSchema,
      walletAuthCredentialSchema,
      walletAccountSchema,
      auth.emailRegisterRequestSchema,
      auth.siweVerifyRequestSchema,
    ];
    for (const schema of schemas) {
      const shape = (schema as unknown as { shape?: Record<string, unknown> }).shape;
      if (shape) {
        expect(Object.keys(shape).some((k) => /pass(word|phrase)/i.test(k))).toBe(false);
      }
    }
  });
});

describe('auth-api wire schemas', () => {
  it('validates a SIWE verify request and rejects a non-hex signature', () => {
    expect(() =>
      auth.siweVerifyRequestSchema.parse({ message: 'msg', signature: '0xabcdef' }),
    ).not.toThrow();
    expect(() =>
      auth.siweVerifyRequestSchema.parse({ message: 'msg', signature: 'not-hex' }),
    ).toThrow();
  });

  it('normalizes and validates an 8-char one-time code', () => {
    expect(() => auth.emailVerifyRequestSchema.parse({ code: 'ABCD2345' })).not.toThrow();
    expect(() => auth.emailVerifyRequestSchema.parse({ code: 'short' })).toThrow();
  });

  it('validates a TOTP 6-digit code and rejects non-digits', () => {
    expect(() => auth.totpConfirmRequestSchema.parse({ code: '123456' })).not.toThrow();
    expect(() => auth.totpConfirmRequestSchema.parse({ code: '12345' })).toThrow();
    expect(() => auth.totpConfirmRequestSchema.parse({ code: 'abcdef' })).toThrow();
  });

  it('requires a YYYY-MM-DD date of birth on email registration', () => {
    expect(() =>
      auth.emailRegisterRequestSchema.parse({
        handle: 'newuser',
        display_name: 'New User',
        email: 'user@example.com',
        date_of_birth: '2000-01-01',
      }),
    ).not.toThrow();
    expect(() =>
      auth.emailRegisterRequestSchema.parse({
        handle: 'newuser',
        display_name: 'New User',
        email: 'user@example.com',
        date_of_birth: '01/01/2000',
      }),
    ).toThrow();
  });
});

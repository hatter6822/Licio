// SPDX-License-Identifier: AGPL-3.0-or-later
import { beforeEach, describe, expect, it } from 'vitest';
import { InMemoryEphemeralStore } from '../ephemeral-store.js';
import {
  createAuthenticationOptions,
  createRegistrationOptions,
  verifyAuthentication,
  verifyRegistration,
  type WebAuthnConfig,
} from '../webauthn.js';
import { SoftwareAuthenticator } from './software-authenticator.js';

const CONFIG: WebAuthnConfig = {
  rpName: 'Licio',
  rpID: 'licio.app',
  origin: 'https://licio.app',
};
const USER = '11111111-1111-4111-8111-111111111111';

describe('createRegistrationOptions', () => {
  let store: InMemoryEphemeralStore;
  beforeEach(() => {
    store = new InMemoryEphemeralStore();
  });

  it('builds options with UV required, ES256/RS256, none attestation, and stores the challenge', async () => {
    const options = await createRegistrationOptions(store, CONFIG, {
      userId: USER,
      userName: 'user@example.com',
      userDisplayName: 'User',
      existingCredentials: [{ id: 'existing-cred', transports: ['internal'] }],
    });
    expect(options.rp.id).toBe('licio.app');
    expect(options.authenticatorSelection?.userVerification).toBe('required');
    expect(options.attestation).toBe('none');
    expect(options.pubKeyCredParams.map((p) => p.alg)).toEqual(expect.arrayContaining([-7, -257]));
    expect(options.excludeCredentials?.[0]?.id).toBe('existing-cred');
    expect(await store.get(`webauthn:reg-challenge:${USER}`)).toBe(options.challenge);
  });
});

describe('registration ceremony (real attestation)', () => {
  let store: InMemoryEphemeralStore;
  beforeEach(() => {
    store = new InMemoryEphemeralStore();
  });

  it('verifies a genuine none-attestation registration and extracts the credential', async () => {
    const authenticator = new SoftwareAuthenticator();
    const options = await createRegistrationOptions(store, CONFIG, {
      userId: USER,
      userName: 'u',
      userDisplayName: 'U',
      existingCredentials: [],
    });
    const response = authenticator.register(options.challenge, CONFIG.rpID, CONFIG.origin);
    const result = await verifyRegistration(store, CONFIG, { userId: USER, response });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.credential.credentialId).toBe(authenticator.credentialIdB64);
      expect(result.credential.counter).toBe(0);
      expect(result.credential.deviceType).toBe('platform');
      expect(result.credential.publicKey.length).toBeGreaterThan(0);
    }
  });

  it('rejects when the challenge is missing/expired (single-use consumed)', async () => {
    const authenticator = new SoftwareAuthenticator();
    const options = await createRegistrationOptions(store, CONFIG, {
      userId: USER,
      userName: 'u',
      userDisplayName: 'U',
      existingCredentials: [],
    });
    const response = authenticator.register(options.challenge, CONFIG.rpID, CONFIG.origin);
    await verifyRegistration(store, CONFIG, { userId: USER, response }); // consumes
    const second = await verifyRegistration(store, CONFIG, { userId: USER, response });
    expect(second).toEqual({ ok: false, reason: 'no_challenge' });
  });

  it('rejects an attestation made for a different origin', async () => {
    const authenticator = new SoftwareAuthenticator();
    const options = await createRegistrationOptions(store, CONFIG, {
      userId: USER,
      userName: 'u',
      userDisplayName: 'U',
      existingCredentials: [],
    });
    const response = authenticator.register(options.challenge, CONFIG.rpID, 'https://evil.example');
    const result = await verifyRegistration(store, CONFIG, { userId: USER, response });
    expect(result).toEqual({ ok: false, reason: 'verification_failed' });
  });
});

describe('authentication ceremony (real assertion + counter regression)', () => {
  let store: InMemoryEphemeralStore;
  let authenticator: SoftwareAuthenticator;
  let publicKey: Uint8Array;

  beforeEach(async () => {
    store = new InMemoryEphemeralStore();
    authenticator = new SoftwareAuthenticator();
    const regOptions = await createRegistrationOptions(store, CONFIG, {
      userId: USER,
      userName: 'u',
      userDisplayName: 'U',
      existingCredentials: [],
    });
    const regResponse = authenticator.register(regOptions.challenge, CONFIG.rpID, CONFIG.origin);
    const reg = await verifyRegistration(store, CONFIG, { userId: USER, response: regResponse });
    if (!reg.ok) throw new Error('registration fixture failed');
    publicKey = reg.credential.publicKey;
  });

  async function authOnce(challengeRef: string, signCount: number, storedCounter: number) {
    const options = await createAuthenticationOptions(store, CONFIG, {
      challengeRef,
      allowCredentials: [{ id: authenticator.credentialIdB64 }],
    });
    const response = authenticator.authenticate(
      options.challenge,
      CONFIG.rpID,
      CONFIG.origin,
      signCount,
    );
    return verifyAuthentication(store, CONFIG, {
      challengeRef,
      response,
      credential: {
        credentialId: authenticator.credentialIdB64,
        publicKey,
        counter: storedCounter,
      },
    });
  }

  it('verifies a genuine assertion and reports the new counter', async () => {
    const result = await authOnce('s1', 5, 0);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.newCounter).toBe(5);
  });

  it('detects a cloned authenticator (counter regression) as a distinct reason', async () => {
    // Stored counter is already 5; presenting signCount 5 (not strictly greater) regresses.
    const result = await authOnce('s2', 5, 5);
    expect(result).toEqual({ ok: false, reason: 'counter_regression' });
  });

  it('rejects when the auth challenge is absent', async () => {
    const response = authenticator.authenticate('never-stored', CONFIG.rpID, CONFIG.origin, 1);
    const result = await verifyAuthentication(store, CONFIG, {
      challengeRef: 'no-such-ref',
      response,
      credential: { credentialId: authenticator.credentialIdB64, publicKey, counter: 0 },
    });
    expect(result).toEqual({ ok: false, reason: 'no_challenge' });
  });
});

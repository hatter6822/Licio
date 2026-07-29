// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The USER-VERIFICATION policy, on its own, for both ceremonies.
//
// `verifyRegistration` and `verifyAuthentication` both pass
// `requireUserVerification: true` — the rule that a passkey ceremony must have
// been gated by a PIN or biometric, not merely by a touch.  Until the
// SoftwareAuthenticator fixture grew a UV switch, every response in the suite
// carried the UV bit set, so `requireUserVerification: true` and `false`
// produced byte-identical results everywhere: dropping the flag (or a
// @simplewebauthn major flipping its default) left CI fully green while a
// stolen, unlocked, PIN-less security key completed
// `/v1/auth/webauthn/authenticate/verify` — and `createSession` stamps
// `auth_assurance: { level: 'full' }` unconditionally, so that touch-only
// assertion would also satisfy `requireStepUp()` on account deletion,
// credential removal, and TOTP enrolment.
//
// Each case pairs the UV-clear denial with the otherwise-identical UV-set
// acceptance, so the flag is provably the discriminator.
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

describe('WebAuthn requires USER VERIFICATION, not merely user presence', () => {
  let store: InMemoryEphemeralStore;
  let authenticator: SoftwareAuthenticator;

  beforeEach(() => {
    store = new InMemoryEphemeralStore();
    authenticator = new SoftwareAuthenticator();
  });

  async function registerWith(userVerified: boolean) {
    const options = await createRegistrationOptions(store, CONFIG, {
      userId: USER,
      userName: 'u',
      userDisplayName: 'U',
      existingCredentials: [],
    });
    const response = authenticator.register(options.challenge, CONFIG.rpID, CONFIG.origin, {
      userVerified,
    });
    return verifyRegistration(store, CONFIG, { userId: USER, response });
  }

  it('rejects a registration whose authenticator only proved presence', async () => {
    expect(await registerWith(false)).toEqual({ ok: false, reason: 'verification_failed' });
  });

  it('accepts the same registration once the UV bit is set (the control)', async () => {
    expect((await registerWith(true)).ok).toBe(true);
  });

  describe('authentication (over a properly UV-registered credential)', () => {
    let publicKey: Uint8Array;

    beforeEach(async () => {
      const reg = await registerWith(true);
      if (!reg.ok) throw new Error('registration fixture failed');
      publicKey = reg.credential.publicKey;
    });

    async function assertWith(challengeRef: string, userVerified: boolean) {
      const options = await createAuthenticationOptions(store, CONFIG, {
        challengeRef,
        allowCredentials: [{ id: authenticator.credentialIdB64 }],
      });
      const response = authenticator.authenticate(
        options.challenge,
        CONFIG.rpID,
        CONFIG.origin,
        1,
        { userVerified },
      );
      return verifyAuthentication(store, CONFIG, {
        challengeRef,
        response,
        credential: {
          credentialId: authenticator.credentialIdB64,
          publicKey,
          counter: 0,
        },
      });
    }

    it('rejects an assertion that proved presence but not verification', async () => {
      // The signature is genuine and the counter advances — only the UV bit is
      // clear.  This is the stolen-unlocked-key shape.
      expect(await assertWith('uv-clear', false)).toEqual({
        ok: false,
        reason: 'verification_failed',
      });
    });

    it('accepts the same assertion once the UV bit is set (the control)', async () => {
      expect((await assertWith('uv-set', true)).ok).toBe(true);
    });
  });
});

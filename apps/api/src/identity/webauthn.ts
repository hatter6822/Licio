// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WebAuthn registration + authentication ceremonies (WS-D.1.2/1.3).  All COSE/CBOR
// decoding and signature verification is delegated to the audited
// @simplewebauthn/server (never home-grown).  This module owns the Licio-specific
// policy: single-use TTL'd challenges in the ephemeral store, origin/RP-ID
// binding to the canonical domain, `userVerification: 'required'`, attestation
// `none` (no device fingerprinting), and cloned-authenticator (counter-regression)
// detection surfaced as a distinct result so the caller can raise a security alert.

import type {
  AuthenticationResponseJSON,
  AuthenticatorTransportFuture,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
} from '@simplewebauthn/server';
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from '@simplewebauthn/server';
import type { EphemeralStore } from './ephemeral-store.js';

export interface WebAuthnConfig {
  rpName: string;
  /** Canonical RP ID (the registrable domain, e.g. "licio.app"). */
  rpID: string;
  /** Canonical origin (e.g. "https://licio.app"). */
  origin: string;
  challengeTtlMs?: number;
}

export const WEBAUTHN_CHALLENGE_TTL_MS = 5 * 60_000;
const ES256 = -7;
const RS256 = -257;

const regChallengeKey = (userId: string): string => `webauthn:reg-challenge:${userId}`;
const authChallengeKey = (ref: string): string => `webauthn:auth-challenge:${ref}`;

export interface ExistingCredentialRef {
  id: string; // base64url credential id
  transports?: AuthenticatorTransportFuture[];
}

/** Build registration options and store the single-use challenge (WS-D.1.2a). */
export async function createRegistrationOptions(
  store: EphemeralStore,
  config: WebAuthnConfig,
  params: {
    userId: string;
    userName: string;
    userDisplayName: string;
    existingCredentials: ExistingCredentialRef[];
  },
): Promise<PublicKeyCredentialCreationOptionsJSON> {
  const options = await generateRegistrationOptions({
    rpName: config.rpName,
    rpID: config.rpID,
    userName: params.userName,
    userDisplayName: params.userDisplayName,
    userID: new TextEncoder().encode(params.userId),
    attestationType: 'none', // no attestation cert retained — no device fingerprinting
    excludeCredentials: params.existingCredentials.map((c) => ({
      id: c.id,
      ...(c.transports ? { transports: c.transports } : {}),
    })),
    authenticatorSelection: { residentKey: 'preferred', userVerification: 'required' },
    supportedAlgorithmIDs: [ES256, RS256],
  });
  await store.set(
    regChallengeKey(params.userId),
    options.challenge,
    config.challengeTtlMs ?? WEBAUTHN_CHALLENGE_TTL_MS,
  );
  return options;
}

export interface VerifiedRegistrationCredential {
  credentialId: string; // base64url
  publicKey: Uint8Array;
  counter: number;
  transports: AuthenticatorTransportFuture[];
  deviceType: 'platform' | 'cross-platform';
  backedUp: boolean;
}

export type RegistrationResult =
  | { ok: true; credential: VerifiedRegistrationCredential }
  | { ok: false; reason: 'no_challenge' | 'verification_failed' };

/** Verify a registration attestation (WS-D.1.2b); single-use challenge is consumed. */
export async function verifyRegistration(
  store: EphemeralStore,
  config: WebAuthnConfig,
  params: { userId: string; response: RegistrationResponseJSON },
): Promise<RegistrationResult> {
  const expectedChallenge = await store.take(regChallengeKey(params.userId));
  if (!expectedChallenge) return { ok: false, reason: 'no_challenge' };

  let verification: Awaited<ReturnType<typeof verifyRegistrationResponse>>;
  try {
    verification = await verifyRegistrationResponse({
      response: params.response,
      expectedChallenge,
      expectedOrigin: config.origin,
      expectedRPID: config.rpID,
      requireUserVerification: true,
    });
  } catch {
    return { ok: false, reason: 'verification_failed' };
  }
  if (!verification.verified || !verification.registrationInfo) {
    return { ok: false, reason: 'verification_failed' };
  }

  const { credential, credentialBackedUp } = verification.registrationInfo;
  return {
    ok: true,
    credential: {
      credentialId: credential.id,
      publicKey: credential.publicKey,
      counter: credential.counter,
      transports: credential.transports ?? [],
      deviceType:
        params.response.authenticatorAttachment === 'cross-platform'
          ? 'cross-platform'
          : 'platform',
      backedUp: credentialBackedUp,
    },
  };
}

/** Build authentication options and store the single-use challenge (WS-D.1.3a). */
export async function createAuthenticationOptions(
  store: EphemeralStore,
  config: WebAuthnConfig,
  params: { challengeRef: string; allowCredentials?: ExistingCredentialRef[] },
): Promise<PublicKeyCredentialRequestOptionsJSON> {
  const options = await generateAuthenticationOptions({
    rpID: config.rpID,
    userVerification: 'required',
    ...(params.allowCredentials
      ? {
          allowCredentials: params.allowCredentials.map((c) => ({
            id: c.id,
            ...(c.transports ? { transports: c.transports } : {}),
          })),
        }
      : {}),
  });
  await store.set(
    authChallengeKey(params.challengeRef),
    options.challenge,
    config.challengeTtlMs ?? WEBAUTHN_CHALLENGE_TTL_MS,
  );
  return options;
}

export interface StoredAuthCredential {
  credentialId: string; // base64url
  publicKey: Uint8Array;
  counter: number;
  transports?: AuthenticatorTransportFuture[];
}

export type AuthenticationResult =
  | { ok: true; credentialId: string; newCounter: number }
  | { ok: false; reason: 'no_challenge' | 'verification_failed' | 'counter_regression' };

/**
 * Verify an authentication assertion (WS-D.1.3a).  The library performs the
 * signature check against the stored public key and the counter-regression check;
 * a regression is surfaced as a distinct `counter_regression` reason so the caller
 * can fire a cloned-authenticator security alert.
 */
export async function verifyAuthentication(
  store: EphemeralStore,
  config: WebAuthnConfig,
  params: {
    challengeRef: string;
    response: AuthenticationResponseJSON;
    credential: StoredAuthCredential;
  },
): Promise<AuthenticationResult> {
  const expectedChallenge = await store.take(authChallengeKey(params.challengeRef));
  if (!expectedChallenge) return { ok: false, reason: 'no_challenge' };

  let verification: Awaited<ReturnType<typeof verifyAuthenticationResponse>>;
  try {
    verification = await verifyAuthenticationResponse({
      response: params.response,
      expectedChallenge,
      expectedOrigin: config.origin,
      expectedRPID: config.rpID,
      requireUserVerification: true,
      credential: {
        id: params.credential.credentialId,
        // Coerce to an ArrayBuffer-backed Uint8Array (the library's exact type
        // under TS6's stricter typed-array generics).
        publicKey: Uint8Array.from(params.credential.publicKey),
        counter: params.credential.counter,
        ...(params.credential.transports ? { transports: params.credential.transports } : {}),
      },
    });
  } catch (err) {
    // The library throws on counter regression (cloned authenticator).
    return {
      ok: false,
      reason: /counter/i.test(String(err)) ? 'counter_regression' : 'verification_failed',
    };
  }
  if (!verification.verified) return { ok: false, reason: 'verification_failed' };
  return {
    ok: true,
    credentialId: verification.authenticationInfo.credentialID,
    newCounter: verification.authenticationInfo.newCounter,
  };
}

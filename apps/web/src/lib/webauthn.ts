// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WebAuthn browser plumbing (WS-D.1.2d).  The BFF speaks the W3C JSON wire
// shape (base64url fields — what @simplewebauthn/server emits and
// PublicKeyCredential.toJSON() produces); the browser credential API speaks
// ArrayBuffers.  This module runs the ceremonies, preferring the native
// WebAuthn Level 3 JSON methods and falling back to a manual converter on
// engines that lack them.  No client-side webauthn dependency: the wire format
// is small and precisely specified, and the cryptographic verification happens
// SERVER-side only (WS-D.1.2b/1.3a).

export function base64urlToBytes(value: string): Uint8Array<ArrayBuffer> {
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
  const raw = atob(padded);
  const bytes = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i += 1) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

export function bytesToBase64url(input: ArrayBuffer | Uint8Array): string {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  let raw = '';
  for (const b of bytes) raw += String.fromCharCode(b);
  return btoa(raw).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** True when the platform can run a WebAuthn ceremony at all. */
export function isWebAuthnAvailable(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.PublicKeyCredential !== 'undefined' &&
    typeof navigator.credentials?.create === 'function' &&
    typeof navigator.credentials?.get === 'function'
  );
}

// --- Manual converters (fallback for engines without the L3 JSON methods) ----

function descriptorsToNative(
  list: PublicKeyCredentialDescriptorJSON[] | undefined,
): PublicKeyCredentialDescriptor[] | undefined {
  if (!list || list.length === 0) return undefined;
  return list.map((d) => ({
    type: 'public-key' as const,
    id: base64urlToBytes(d.id),
    ...(d.transports ? { transports: d.transports as AuthenticatorTransport[] } : {}),
  }));
}

export function creationOptionsToNative(
  json: PublicKeyCredentialCreationOptionsJSON,
): PublicKeyCredentialCreationOptions {
  const { challenge, user, excludeCredentials, extensions: _ext, ...rest } = json;
  const exclude = descriptorsToNative(excludeCredentials);
  return {
    ...(rest as unknown as Omit<
      PublicKeyCredentialCreationOptions,
      'challenge' | 'user' | 'excludeCredentials' | 'extensions'
    >),
    challenge: base64urlToBytes(challenge),
    user: { name: user.name, displayName: user.displayName, id: base64urlToBytes(user.id) },
    ...(exclude ? { excludeCredentials: exclude } : {}),
  };
}

export function requestOptionsToNative(
  json: PublicKeyCredentialRequestOptionsJSON,
): PublicKeyCredentialRequestOptions {
  const { challenge, allowCredentials, extensions: _ext, ...rest } = json;
  const allow = descriptorsToNative(allowCredentials);
  return {
    ...(rest as unknown as Omit<
      PublicKeyCredentialRequestOptions,
      'challenge' | 'allowCredentials' | 'extensions'
    >),
    challenge: base64urlToBytes(challenge),
    ...(allow ? { allowCredentials: allow } : {}),
  };
}

interface AttestationLike extends AuthenticatorResponse {
  attestationObject: ArrayBuffer;
  getTransports?: () => string[];
  getAuthenticatorData?: () => ArrayBuffer;
  getPublicKeyAlgorithm?: () => number;
}

interface AssertionLike extends AuthenticatorResponse {
  authenticatorData: ArrayBuffer;
  signature: ArrayBuffer;
  userHandle: ArrayBuffer | null;
}

export function registrationToJson(cred: PublicKeyCredential): RegistrationResponseJSON {
  const response = cred.response as AttestationLike;
  const transports = response.getTransports?.();
  return {
    id: cred.id,
    rawId: bytesToBase64url(cred.rawId),
    type: cred.type,
    response: {
      clientDataJSON: bytesToBase64url(response.clientDataJSON),
      attestationObject: bytesToBase64url(response.attestationObject),
      // Best-effort on old engines: the server verifies from the attestation
      // object itself, so these L3 companion fields may be empty.
      authenticatorData: response.getAuthenticatorData
        ? bytesToBase64url(response.getAuthenticatorData())
        : '',
      publicKeyAlgorithm: response.getPublicKeyAlgorithm?.() ?? 0,
      transports: transports ?? [],
    },
    clientExtensionResults:
      cred.getClientExtensionResults() as unknown as AuthenticationExtensionsClientOutputsJSON,
    ...(cred.authenticatorAttachment
      ? { authenticatorAttachment: cred.authenticatorAttachment }
      : {}),
  };
}

export function authenticationToJson(cred: PublicKeyCredential): AuthenticationResponseJSON {
  const response = cred.response as AssertionLike;
  return {
    id: cred.id,
    rawId: bytesToBase64url(cred.rawId),
    type: cred.type,
    response: {
      clientDataJSON: bytesToBase64url(response.clientDataJSON),
      authenticatorData: bytesToBase64url(response.authenticatorData),
      signature: bytesToBase64url(response.signature),
      ...(response.userHandle ? { userHandle: bytesToBase64url(response.userHandle) } : {}),
    },
    clientExtensionResults:
      cred.getClientExtensionResults() as unknown as AuthenticationExtensionsClientOutputsJSON,
    ...(cred.authenticatorAttachment
      ? { authenticatorAttachment: cred.authenticatorAttachment }
      : {}),
  };
}

// --- Ceremonies ----------------------------------------------------------------

type MaybeJsonCredential = PublicKeyCredential & { toJSON?: () => unknown };

/** Run the CREATE ceremony for the server's registration options. */
export async function createPasskey(
  options: PublicKeyCredentialCreationOptionsJSON,
): Promise<RegistrationResponseJSON> {
  const publicKey =
    'parseCreationOptionsFromJSON' in PublicKeyCredential
      ? PublicKeyCredential.parseCreationOptionsFromJSON(options)
      : creationOptionsToNative(options);
  const cred = (await navigator.credentials.create({ publicKey })) as MaybeJsonCredential | null;
  if (!cred) throw new Error('passkey_creation_cancelled');
  if (typeof cred.toJSON === 'function') return cred.toJSON() as RegistrationResponseJSON;
  return registrationToJson(cred);
}

/** Run the GET ceremony (discoverable-credential login) for the server's options. */
export async function getPasskeyAssertion(
  options: PublicKeyCredentialRequestOptionsJSON,
): Promise<AuthenticationResponseJSON> {
  const publicKey =
    'parseRequestOptionsFromJSON' in PublicKeyCredential
      ? PublicKeyCredential.parseRequestOptionsFromJSON(options)
      : requestOptionsToNative(options);
  const cred = (await navigator.credentials.get({ publicKey })) as MaybeJsonCredential | null;
  if (!cred) throw new Error('passkey_assertion_cancelled');
  if (typeof cred.toJSON === 'function') return cred.toJSON() as AuthenticationResponseJSON;
  return authenticationToJson(cred);
}

// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WebAuthn plumbing (WS-D.1.2d): byte/base64url round-trips, the manual
// JSON↔ArrayBuffer converters (the fallback for engines without the WebAuthn L3
// JSON methods), and both ceremony paths (native toJSON vs manual) against a
// stubbed credential API.  jsdom has no PublicKeyCredential, so the stubs ARE
// the no-native-support environment.
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  authenticationToJson,
  base64urlToBytes,
  bytesToBase64url,
  createPasskey,
  creationOptionsToNative,
  getPasskeyAssertion,
  isWebAuthnAvailable,
  registrationToJson,
  requestOptionsToNative,
} from './webauthn.js';

const bytes = (...values: number[]): Uint8Array => new Uint8Array(values);

afterEach(() => {
  vi.unstubAllGlobals();
  Reflect.deleteProperty(navigator, 'credentials');
});

describe('base64url codec', () => {
  it('round-trips bytes through base64url without padding', () => {
    const input = bytes(0, 1, 2, 250, 251, 252, 253, 254, 255);
    const encoded = bytesToBase64url(input);
    expect(encoded).not.toMatch(/[+/=]/); // url-safe alphabet, unpadded
    expect([...base64urlToBytes(encoded)]).toEqual([...input]);
  });

  it.each([1, 2, 3, 4, 5])('round-trips %d-byte values (padding cases)', (n) => {
    const input = new Uint8Array(Array.from({ length: n }, (_, i) => i * 37));
    expect([...base64urlToBytes(bytesToBase64url(input))]).toEqual([...input]);
  });

  it('decodes the - and _ alphabet (where base64 would use + and /)', () => {
    expect([...base64urlToBytes('-_8')]).toEqual([251, 255]);
  });
});

describe('manual option converters', () => {
  it('decodes challenge, user id, and exclude-list ids for creation options', () => {
    const native = creationOptionsToNative({
      challenge: bytesToBase64url(bytes(1, 2, 3)),
      rp: { name: 'Licio', id: 'localhost' },
      user: { id: bytesToBase64url(bytes(9, 9)), name: 'ada', displayName: 'Ada' },
      pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
      excludeCredentials: [
        { type: 'public-key', id: bytesToBase64url(bytes(7)), transports: ['internal'] },
      ],
    });
    expect([...new Uint8Array(native.challenge as ArrayBuffer)]).toEqual([1, 2, 3]);
    expect([...new Uint8Array(native.user.id as ArrayBuffer)]).toEqual([9, 9]);
    expect(native.excludeCredentials).toHaveLength(1);
    expect(native.excludeCredentials?.[0]?.transports).toEqual(['internal']);
    expect(native.rp.name).toBe('Licio'); // untouched fields pass through
  });

  it('decodes request options and omits an empty allow list', () => {
    const native = requestOptionsToNative({
      challenge: bytesToBase64url(bytes(4, 5)),
      rpId: 'localhost',
      allowCredentials: [],
    });
    expect([...new Uint8Array(native.challenge as ArrayBuffer)]).toEqual([4, 5]);
    expect(native.allowCredentials).toBeUndefined();
    expect(native.rpId).toBe('localhost');
  });
});

// --- Synthetic credentials for the response converters -----------------------

function fakeAttestationCredential(): PublicKeyCredential {
  return {
    id: 'cred-id',
    rawId: bytes(1, 2).buffer,
    type: 'public-key',
    authenticatorAttachment: 'platform',
    response: {
      clientDataJSON: bytes(3).buffer,
      attestationObject: bytes(4).buffer,
      getTransports: () => ['internal', 'hybrid'],
    },
    getClientExtensionResults: () => ({}),
  } as unknown as PublicKeyCredential;
}

function fakeAssertionCredential(): PublicKeyCredential {
  return {
    id: 'cred-id',
    rawId: bytes(1, 2).buffer,
    type: 'public-key',
    authenticatorAttachment: null,
    response: {
      clientDataJSON: bytes(3).buffer,
      authenticatorData: bytes(4).buffer,
      signature: bytes(5).buffer,
      userHandle: bytes(6).buffer,
    },
    getClientExtensionResults: () => ({}),
  } as unknown as PublicKeyCredential;
}

describe('manual response converters', () => {
  it('encodes a registration response with transports', () => {
    const json = registrationToJson(fakeAttestationCredential());
    expect(json.id).toBe('cred-id');
    expect(json.rawId).toBe(bytesToBase64url(bytes(1, 2)));
    expect(json.response.clientDataJSON).toBe(bytesToBase64url(bytes(3)));
    expect(json.response.attestationObject).toBe(bytesToBase64url(bytes(4)));
    expect(json.response.transports).toEqual(['internal', 'hybrid']);
    expect(json.authenticatorAttachment).toBe('platform');
  });

  it('encodes an authentication response including the user handle', () => {
    const json = authenticationToJson(fakeAssertionCredential());
    expect(json.response.signature).toBe(bytesToBase64url(bytes(5)));
    expect(json.response.userHandle).toBe(bytesToBase64url(bytes(6)));
    expect(json.authenticatorAttachment).toBeUndefined(); // null never serialized
  });
});

describe('ceremonies against a stubbed credential API', () => {
  function stubCredentialApi(overrides: {
    create?: () => Promise<unknown>;
    get?: () => Promise<unknown>;
    statics?: Record<string, unknown>;
  }): void {
    vi.stubGlobal('PublicKeyCredential', Object.assign(class {}, overrides.statics ?? {}));
    Object.defineProperty(navigator, 'credentials', {
      value: { create: overrides.create ?? vi.fn(), get: overrides.get ?? vi.fn() },
      configurable: true,
    });
  }

  it('isWebAuthnAvailable reflects the credential API presence', () => {
    expect(isWebAuthnAvailable()).toBe(false); // bare jsdom
    stubCredentialApi({});
    expect(isWebAuthnAvailable()).toBe(true);
  });

  it('createPasskey uses the manual path when no JSON statics exist', async () => {
    const create = vi.fn(async () => fakeAttestationCredential());
    stubCredentialApi({ create });
    const json = await createPasskey({
      challenge: bytesToBase64url(bytes(1)),
      rp: { name: 'Licio' },
      user: { id: bytesToBase64url(bytes(2)), name: 'ada', displayName: 'Ada' },
      pubKeyCredParams: [],
    });
    expect(create).toHaveBeenCalledOnce();
    const arg = create.mock.calls[0]?.[0] as { publicKey: PublicKeyCredentialCreationOptions };
    expect([...new Uint8Array(arg.publicKey.challenge as ArrayBuffer)]).toEqual([1]);
    expect(json.response.attestationObject).toBe(bytesToBase64url(bytes(4)));
  });

  it('createPasskey prefers the native parse + toJSON path when present', async () => {
    const parsed = { challenge: bytes(9) } as unknown as PublicKeyCredentialCreationOptions;
    const toJSON = vi.fn(() => ({ id: 'native', type: 'public-key' }));
    const create = vi.fn(async () => ({ ...fakeAttestationCredential(), toJSON }));
    stubCredentialApi({
      create,
      statics: { parseCreationOptionsFromJSON: vi.fn(() => parsed) },
    });
    const json = await createPasskey({
      challenge: 'x',
      rp: { name: 'Licio' },
      user: { id: 'eQ', name: 'ada', displayName: 'Ada' },
      pubKeyCredParams: [],
    });
    expect(create).toHaveBeenCalledWith({ publicKey: parsed });
    expect(json).toEqual({ id: 'native', type: 'public-key' });
  });

  it('getPasskeyAssertion runs the manual path and rejects on cancellation', async () => {
    stubCredentialApi({ get: vi.fn(async () => fakeAssertionCredential()) });
    const json = await getPasskeyAssertion({ challenge: bytesToBase64url(bytes(1)) });
    expect(json.response.signature).toBe(bytesToBase64url(bytes(5)));

    stubCredentialApi({ get: vi.fn(async () => null) });
    await expect(getPasskeyAssertion({ challenge: 'AA' })).rejects.toThrow(
      'passkey_assertion_cancelled',
    );
  });
});

// SPDX-License-Identifier: AGPL-3.0-or-later
//
// A pure-crypto software WebAuthn authenticator for tests.  It mints genuine
// `none`-attestation registration responses and ES256 authentication assertions
// using node:crypto + @simplewebauthn's CBOR/base64url helpers — no browser, no
// external service — so the real verification paths run in CI.
import {
  createHash,
  sign as cryptoSign,
  generateKeyPairSync,
  type KeyObject,
  randomBytes,
} from 'node:crypto';
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from '@simplewebauthn/server';
import { isoBase64URL, isoCBOR } from '@simplewebauthn/server/helpers';

/** The value type isoCBOR.encode accepts (CBORType), aliased for the test maps. */
type CborValue = Parameters<typeof isoCBOR.encode>[0];

const FLAG_UP = 0x01;
const FLAG_UV = 0x04;
const FLAG_AT = 0x40;

function sha256(data: Uint8Array | string): Uint8Array {
  return new Uint8Array(createHash('sha256').update(data).digest());
}

function u32be(n: number): Uint8Array {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n, false);
  return b;
}

export class SoftwareAuthenticator {
  readonly #privateKey: KeyObject;
  readonly #cosePublicKey: Uint8Array;
  readonly credentialId: Uint8Array;
  readonly credentialIdB64: string;

  constructor() {
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    this.#privateKey = privateKey;
    this.credentialId = Uint8Array.from(randomBytes(20));
    this.credentialIdB64 = isoBase64URL.fromBuffer(Uint8Array.from(this.credentialId));

    const jwk = publicKey.export({ format: 'jwk' }) as { x: string; y: string };
    const x = isoBase64URL.toBuffer(jwk.x);
    const y = isoBase64URL.toBuffer(jwk.y);
    // COSE_Key (EC2/ES256/P-256) with integer map keys.
    this.#cosePublicKey = isoCBOR.encode(
      new Map<number, number | Uint8Array>([
        [1, 2], // kty: EC2
        [3, -7], // alg: ES256
        [-1, 1], // crv: P-256
        [-2, x],
        [-3, y],
      ]),
    );
  }

  #authData(rpID: string, flags: number, signCount: number, includeAttested: boolean): Uint8Array {
    const rpIdHash = sha256(rpID);
    const head = new Uint8Array([...rpIdHash, flags, ...u32be(signCount)]);
    if (!includeAttested) return head;
    const aaguid = new Uint8Array(16); // zeros (attestation 'none')
    const idLen = new Uint8Array(2);
    new DataView(idLen.buffer).setUint16(0, this.credentialId.length, false);
    return new Uint8Array([
      ...head,
      ...aaguid,
      ...idLen,
      ...this.credentialId,
      ...this.#cosePublicKey,
    ]);
  }

  #clientDataJSON(
    type: 'webauthn.create' | 'webauthn.get',
    challenge: string,
    origin: string,
  ): Uint8Array {
    return new TextEncoder().encode(
      JSON.stringify({ type, challenge, origin, crossOrigin: false }),
    );
  }

  /** Produce a registration (attestation) response for the given options challenge. */
  register(challenge: string, rpID: string, origin: string): RegistrationResponseJSON {
    const authData = this.#authData(rpID, FLAG_UP | FLAG_UV | FLAG_AT, 0, true);
    const attestationObject = isoCBOR.encode(
      new Map<string, CborValue>([
        ['fmt', 'none'],
        ['attStmt', new Map<string, CborValue>()],
        ['authData', Uint8Array.from(authData)],
      ]),
    );
    const clientDataJSON = this.#clientDataJSON('webauthn.create', challenge, origin);
    return {
      id: this.credentialIdB64,
      rawId: this.credentialIdB64,
      type: 'public-key',
      response: {
        clientDataJSON: isoBase64URL.fromBuffer(Uint8Array.from(clientDataJSON)),
        attestationObject: isoBase64URL.fromBuffer(Uint8Array.from(attestationObject)),
        transports: ['internal'],
      },
      clientExtensionResults: {},
      authenticatorAttachment: 'platform',
    };
  }

  /** Produce an authentication (assertion) response with the given signature counter. */
  authenticate(
    challenge: string,
    rpID: string,
    origin: string,
    signCount: number,
  ): AuthenticationResponseJSON {
    const authData = this.#authData(rpID, FLAG_UP | FLAG_UV, signCount, false);
    const clientDataJSON = this.#clientDataJSON('webauthn.get', challenge, origin);
    const signedData = new Uint8Array([...authData, ...sha256(clientDataJSON)]);
    const signature = cryptoSign('sha256', signedData, this.#privateKey); // DER ECDSA
    return {
      id: this.credentialIdB64,
      rawId: this.credentialIdB64,
      type: 'public-key',
      response: {
        clientDataJSON: isoBase64URL.fromBuffer(Uint8Array.from(clientDataJSON)),
        authenticatorData: isoBase64URL.fromBuffer(Uint8Array.from(authData)),
        signature: isoBase64URL.fromBuffer(Uint8Array.from(signature)),
      },
      clientExtensionResults: {},
      authenticatorAttachment: 'platform',
    };
  }
}

// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-S.3.7 — crypto property + fuzz suite.  Ties the §10.5 two-AEAD pipeline
// together end-to-end (derive epoch keys → seal body → wrap key → sign → unwrap
// → open → verify), proves the §10.9 forward-secrecy property ("a removed member
// cannot decrypt a future-epoch object"), asserts nonce/object-key uniqueness
// across a combined generated workload, and fuzzes every open/decode path to
// confirm it FAILS CLOSED (a typed error, never a silently-wrong value) on
// malformed input.
import { describe, expect, it } from 'vitest';
import {
  type BodyAadInput,
  openBody,
  PrivateAeadError,
  sealBody,
  unwrapKey,
  type WrapAadInput,
  wrapKey,
} from '../crypto/aead.js';
import { CanonicalDecodeError, decodeCanonical } from '../crypto/canonical.js';
import { deriveRoomEpochKeys } from '../crypto/hkdf.js';
import { generateRecipientKeyPair, HpkeError, openInvite } from '../crypto/hpke.js';
import { fromBase64Url, randomBytes, toBase64Url, utf8 } from '../crypto/runtime.js';
import { generateDeviceSigningKeyPair, signEd25519, verifyEd25519 } from '../crypto/signatures.js';

const toHex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

function bodyAad(roomEpoch: number, commitment: Uint8Array): BodyAadInput {
  return {
    envelopeVersion: 1,
    roomIdCommitment: commitment,
    roomEpoch,
    objectType: 'contribution_op',
    plaintextSchema: 'licio.private.contribution_op.v1',
    parentOpIds: ['op-1'],
    authorDeviceIdBlind: 'device-blind',
    authorSeq: 1,
    capabilityRootAtSeq: utf8('cap-root'),
    chunkIndex: 0,
    chunkTotal: 1,
  };
}

function wrapAad(wrappingEpoch: number, commitment: Uint8Array): WrapAadInput {
  return { wrappingEpoch, roomIdCommitment: commitment, objectType: 'contribution_op' };
}

describe('full §10.5 envelope crypto pipeline', () => {
  it('seals → wraps → signs → unwraps → opens → verifies end-to-end', async () => {
    const roomEpochSecret = randomBytes(32);
    const commitment = randomBytes(32);
    const epoch = 9;
    const keys = await deriveRoomEpochKeys(roomEpochSecret, commitment);
    const device = await generateDeviceSigningKeyPair();

    const plaintext = utf8('a private contribution that survives the full pipeline');
    const sealed = await sealBody(plaintext, bodyAad(epoch, commitment), 'small-op-4k');
    const wrapped = await wrapKey(
      sealed.objectKey,
      keys.contentWrapKey,
      wrapAad(epoch, commitment),
    );

    // The author signs over the body ciphertext + wrapped key (here, directly).
    const signingInput = new Uint8Array([...sealed.ciphertext, ...wrapped]);
    const signature = await signEd25519(device.privateKey, signingInput);

    // Recipient: verify signature, unwrap the object key, open the body.
    expect(await verifyEd25519(device.publicKey, signingInput, signature)).toBe(true);
    const objectKey = await unwrapKey(wrapped, keys.contentWrapKey, wrapAad(epoch, commitment));
    const opened = await openBody(
      objectKey,
      sealed.nonce,
      sealed.ciphertext,
      bodyAad(epoch, commitment),
    );
    expect(new TextDecoder().decode(opened)).toBe(
      'a private contribution that survives the full pipeline',
    );
  });
});

describe('§10.9 forward secrecy after removal', () => {
  it('a removed member (old epoch key) cannot decrypt a future-epoch object', async () => {
    const commitment = randomBytes(32);
    // Two distinct epoch secrets (a membership change rotates the MLS exporter).
    const keysEpochE = await deriveRoomEpochKeys(randomBytes(32), commitment);
    const keysEpochE1 = await deriveRoomEpochKeys(randomBytes(32), commitment);
    expect(toHex(keysEpochE.contentWrapKey)).not.toBe(toHex(keysEpochE1.contentWrapKey));

    // An object created at epoch E+1, after the member was removed.
    const sealed = await sealBody(
      utf8('post-removal secret'),
      bodyAad(11, commitment),
      'small-op-4k',
    );
    const wrapped = await wrapKey(
      sealed.objectKey,
      keysEpochE1.contentWrapKey,
      wrapAad(11, commitment),
    );

    // The removed member retains only epoch E's content_wrap_key → cannot unwrap.
    await expect(
      unwrapKey(wrapped, keysEpochE.contentWrapKey, wrapAad(11, commitment)),
    ).rejects.toMatchObject({ reason: 'aead_open_failed' });

    // A current member (epoch E+1 key) opens it normally.
    const objectKey = await unwrapKey(wrapped, keysEpochE1.contentWrapKey, wrapAad(11, commitment));
    const opened = await openBody(
      objectKey,
      sealed.nonce,
      sealed.ciphertext,
      bodyAad(11, commitment),
    );
    expect(new TextDecoder().decode(opened)).toBe('post-removal secret');
  });
});

describe('nonce / object-key uniqueness across a combined workload', () => {
  it('never repeats a body nonce, object key, or wrap nonce', async () => {
    const keys = await deriveRoomEpochKeys(randomBytes(32), randomBytes(32));
    const commitment = randomBytes(32);
    const bodyNonces = new Set<string>();
    const objectKeys = new Set<string>();
    const wrapNonces = new Set<string>();
    for (let i = 0; i < 300; i++) {
      const sealed = await sealBody(utf8(`m${i}`), bodyAad(1, commitment), 'small-op-4k');
      const wrapped = await wrapKey(sealed.objectKey, keys.contentWrapKey, wrapAad(1, commitment));
      const bn = toHex(sealed.nonce);
      const ok = toHex(sealed.objectKey);
      const wn = toHex(wrapped.subarray(0, 12));
      expect(bodyNonces.has(bn)).toBe(false);
      expect(objectKeys.has(ok)).toBe(false);
      expect(wrapNonces.has(wn)).toBe(false);
      bodyNonces.add(bn);
      objectKeys.add(ok);
      wrapNonces.add(wn);
    }
    expect(bodyNonces.size + objectKeys.size + wrapNonces.size).toBe(900);
  });
});

describe('fuzz: every open/decode path fails closed', () => {
  it('decodeCanonical rejects (or cleanly decodes) random bytes, never crashes', () => {
    for (let i = 0; i < 500; i++) {
      const bytes = randomBytes(1 + (i % 48));
      try {
        decodeCanonical(bytes);
      } catch (e) {
        expect(e).toBeInstanceOf(CanonicalDecodeError);
      }
    }
  });

  it('openBody / unwrapKey reject random inputs with a typed PrivateAeadError', async () => {
    const commitment = randomBytes(32);
    for (let i = 0; i < 64; i++) {
      await expect(
        openBody(
          randomBytes(32),
          randomBytes(12),
          randomBytes(40 + (i % 100)),
          bodyAad(1, commitment),
        ),
      ).rejects.toBeInstanceOf(PrivateAeadError);
      await expect(
        unwrapKey(randomBytes(60 + (i % 50)), randomBytes(32), wrapAad(1, commitment)),
      ).rejects.toBeInstanceOf(PrivateAeadError);
    }
  });

  it('openInvite rejects random sealed blobs with a typed HpkeError', async () => {
    const recipient = await generateRecipientKeyPair();
    for (let i = 0; i < 48; i++) {
      const blob = toBase64Url(randomBytes(48 + (i % 80)));
      await expect(
        openInvite(recipient.privateKey, recipient.publicKey, blob),
      ).rejects.toBeInstanceOf(HpkeError);
    }
  });

  it('fromBase64Url rejects non-base64url input', () => {
    expect(() => fromBase64Url('not valid!!')).toThrow();
  });
});

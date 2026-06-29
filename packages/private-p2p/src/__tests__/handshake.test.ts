// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-S.6.3 — membership-proving handshake tests (PRIVATE_SPEC §15.5): a member
// handshake succeeds and both peers derive the SAME epoch-bound session key; a
// non-member / removed device / forged proof / version mismatch / self-handshake
// is rejected BEFORE any block exchange; and a proof is bound to room + epoch so
// it cannot be replayed across rooms.
import { describe, expect, it } from 'vitest';
import { generateX25519KeyPair } from '../crypto/ecdh.js';
import { randomBytes } from '../crypto/runtime.js';
import { generateDeviceSigningKeyPair } from '../crypto/signatures.js';
import {
  buildHandshakeHello,
  deriveHandshakeSessionKey,
  HANDSHAKE_PROTOCOL_VERSION,
  type HandshakeContext,
  type HandshakeHello,
  signHandshakeProof,
  verifyPeerHandshake,
} from '../sync/handshake.js';

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

async function makePeer(deviceId: string) {
  const device = await generateDeviceSigningKeyPair();
  const eph = await generateX25519KeyPair();
  const hello = buildHandshakeHello({
    deviceId,
    ephemeralPublicKey: eph.publicKey,
    helloNonce: randomBytes(16),
  });
  return { deviceId, device, eph, hello };
}

function ctxFor(roomIdCommitment: Uint8Array, epoch = 5): HandshakeContext {
  return { protocolVersion: HANDSHAKE_PROTOCOL_VERSION, roomIdCommitment, epoch };
}

describe('buildHandshakeHello', () => {
  it('builds a valid hello at the current protocol version', async () => {
    const eph = await generateX25519KeyPair();
    const hello = buildHandshakeHello({
      deviceId: 'd1',
      ephemeralPublicKey: eph.publicKey,
      helloNonce: randomBytes(16),
    });
    expect(hello.protocol_version).toBe(HANDSHAKE_PROTOCOL_VERSION);
    expect(hello.author_device_id).toBe('d1');
  });
});

describe('a successful member handshake', () => {
  it('both peers verify each other and derive the same session key', async () => {
    const a = await makePeer('alice-dev');
    const b = await makePeer('bob-dev');
    const ctx = ctxFor(randomBytes(32));

    const aProof = await signHandshakeProof(a.device.privateKey, a.hello, b.hello, ctx);
    const bProof = await signHandshakeProof(b.device.privateKey, b.hello, a.hello, ctx);

    // B verifies A; A verifies B.
    const bVerifiesA = await verifyPeerHandshake({
      localHello: b.hello,
      remoteHello: a.hello,
      remoteProofSignature: aProof,
      ctx,
      resolveDevice: (id) =>
        id === 'alice-dev' ? { publicKey: a.device.publicKey, activeAtEpoch: true } : undefined,
    });
    const aVerifiesB = await verifyPeerHandshake({
      localHello: a.hello,
      remoteHello: b.hello,
      remoteProofSignature: bProof,
      ctx,
      resolveDevice: (id) =>
        id === 'bob-dev' ? { publicKey: b.device.publicKey, activeAtEpoch: true } : undefined,
    });
    expect(bVerifiesA).toStrictEqual({ ok: true });
    expect(aVerifiesB).toStrictEqual({ ok: true });

    const aKey = await deriveHandshakeSessionKey(
      a.eph.privateKey,
      b.eph.publicKey,
      a.hello,
      b.hello,
      ctx,
    );
    const bKey = await deriveHandshakeSessionKey(
      b.eph.privateKey,
      a.eph.publicKey,
      b.hello,
      a.hello,
      ctx,
    );
    expect(hex(aKey)).toBe(hex(bKey));
  });

  it('the session key is epoch-bound (a different epoch yields a different key)', async () => {
    const a = await makePeer('a');
    const b = await makePeer('b');
    const room = randomBytes(32);
    const k5 = await deriveHandshakeSessionKey(
      a.eph.privateKey,
      b.eph.publicKey,
      a.hello,
      b.hello,
      ctxFor(room, 5),
    );
    const k6 = await deriveHandshakeSessionKey(
      a.eph.privateKey,
      b.eph.publicKey,
      a.hello,
      b.hello,
      ctxFor(room, 6),
    );
    expect(hex(k5)).not.toBe(hex(k6));
  });
});

describe('the §15.5 reject matrix', () => {
  async function verifyAgainst(
    resolveDevice: (id: string) => { publicKey: CryptoKey; activeAtEpoch: boolean } | undefined,
    over: { ctx?: HandshakeContext; remoteHello?: HandshakeHello; sig?: Uint8Array } = {},
  ) {
    const a = await makePeer('alice-dev');
    const b = await makePeer('bob-dev');
    const ctx = over.ctx ?? ctxFor(randomBytes(32));
    const sig = over.sig ?? (await signHandshakeProof(a.device.privateKey, a.hello, b.hello, ctx));
    return verifyPeerHandshake({
      localHello: b.hello,
      remoteHello: over.remoteHello ?? a.hello,
      remoteProofSignature: sig,
      ctx,
      resolveDevice,
    });
  }

  it('rejects an unknown (non-member) device', async () => {
    expect(await verifyAgainst(() => undefined)).toStrictEqual({
      ok: false,
      reason: 'unknown_device',
    });
  });

  it('rejects a removed device (not active at the epoch)', async () => {
    const a = await makePeer('alice-dev');
    const b = await makePeer('bob-dev');
    const ctx = ctxFor(randomBytes(32));
    const sig = await signHandshakeProof(a.device.privateKey, a.hello, b.hello, ctx);
    const result = await verifyPeerHandshake({
      localHello: b.hello,
      remoteHello: a.hello,
      remoteProofSignature: sig,
      ctx,
      resolveDevice: () => ({ publicKey: a.device.publicKey, activeAtEpoch: false }),
    });
    expect(result).toStrictEqual({ ok: false, reason: 'device_not_active' });
  });

  it('rejects a forged proof (signed by a different key)', async () => {
    const a = await makePeer('alice-dev');
    const b = await makePeer('bob-dev');
    const impostor = await generateDeviceSigningKeyPair();
    const ctx = ctxFor(randomBytes(32));
    const forged = await signHandshakeProof(impostor.privateKey, a.hello, b.hello, ctx);
    const result = await verifyPeerHandshake({
      localHello: b.hello,
      remoteHello: a.hello,
      remoteProofSignature: forged,
      ctx,
      // The verifier looks up A's REAL key; the forged signature won't match.
      resolveDevice: () => ({ publicKey: a.device.publicKey, activeAtEpoch: true }),
    });
    expect(result).toStrictEqual({ ok: false, reason: 'proof_invalid' });
  });

  it('rejects a protocol-version mismatch', async () => {
    const a = await makePeer('alice-dev');
    const b = await makePeer('bob-dev');
    // The hellos are built at HANDSHAKE_PROTOCOL_VERSION; the ctx demands a DIFFERENT version
    // (robust to the constant's value — modelling a peer on an incompatible build).
    const ctx: HandshakeContext = {
      protocolVersion: HANDSHAKE_PROTOCOL_VERSION + 1,
      roomIdCommitment: randomBytes(32),
      epoch: 5,
    };
    const sig = await signHandshakeProof(a.device.privateKey, a.hello, b.hello, ctx);
    const result = await verifyPeerHandshake({
      localHello: b.hello,
      remoteHello: a.hello,
      remoteProofSignature: sig,
      ctx,
      resolveDevice: () => ({ publicKey: a.device.publicKey, activeAtEpoch: true }),
    });
    expect(result).toStrictEqual({ ok: false, reason: 'protocol_version_mismatch' });
  });

  it('rejects a self/reflected handshake (same device id)', async () => {
    const a = await makePeer('same-dev');
    const ctx = ctxFor(randomBytes(32));
    const sig = await signHandshakeProof(a.device.privateKey, a.hello, a.hello, ctx);
    const result = await verifyPeerHandshake({
      localHello: a.hello,
      remoteHello: a.hello,
      remoteProofSignature: sig,
      ctx,
      resolveDevice: () => ({ publicKey: a.device.publicKey, activeAtEpoch: true }),
    });
    expect(result).toStrictEqual({ ok: false, reason: 'self_handshake' });
  });

  it('quarantines a malformed hello field as a closed verdict (never throws)', async () => {
    const a = await makePeer('alice-dev');
    const b = await makePeer('bob-dev');
    const ctx = ctxFor(randomBytes(32));
    const sig = await signHandshakeProof(a.device.privateKey, a.hello, b.hello, ctx);
    // 'A' passes the loose base64url regex but is an invalid encoding length, so
    // the proof-message builder's `fromBase64Url` would throw; this wire-facing
    // pre-block-exchange check must return a typed verdict, not abort.
    const malformedRemote: HandshakeHello = { ...a.hello, ephemeral_public_key: 'A' };
    const result = await verifyPeerHandshake({
      localHello: b.hello,
      remoteHello: malformedRemote,
      remoteProofSignature: sig,
      ctx,
      resolveDevice: () => ({ publicKey: a.device.publicKey, activeAtEpoch: true }),
    });
    expect(result).toStrictEqual({ ok: false, reason: 'proof_invalid' });
  });

  it('a proof is bound to the room (it cannot be replayed into another room)', async () => {
    const a = await makePeer('alice-dev');
    const b = await makePeer('bob-dev');
    const ctxA = ctxFor(randomBytes(32));
    const ctxB = ctxFor(randomBytes(32)); // a different room commitment
    const sigForRoomA = await signHandshakeProof(a.device.privateKey, a.hello, b.hello, ctxA);
    const result = await verifyPeerHandshake({
      localHello: b.hello,
      remoteHello: a.hello,
      remoteProofSignature: sigForRoomA,
      ctx: ctxB, // verify under room B
      resolveDevice: () => ({ publicKey: a.device.publicKey, activeAtEpoch: true }),
    });
    expect(result).toStrictEqual({ ok: false, reason: 'proof_invalid' });
  });
});

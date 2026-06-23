// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-S.6.2/6.3 — pairwise secure-channel tests (PRIVATE_SPEC §15.4, §15.5): both
// peers derive the SAME key from opposite-order ephemeral inputs (sorted
// transcript + ECDH symmetry); the key is bound to the transcript (room-id
// commitment, epoch, protocol version) and domain-separated by label, so any
// difference yields a different key — the cross-room/epoch confusion + replay
// defense.
import { describe, expect, it } from 'vitest';
import { generateX25519KeyPair } from '../crypto/ecdh.js';
import { randomBytes } from '../crypto/runtime.js';
import {
  CHANNEL_LABEL_HANDSHAKE,
  CHANNEL_LABEL_SIGNALING,
  type ChannelTranscript,
  channelTranscriptBytes,
  deriveChannelKey,
} from '../sync/secure-channel.js';

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

async function twoPeers() {
  const a = await generateX25519KeyPair();
  const b = await generateX25519KeyPair();
  const roomIdCommitment = randomBytes(32);
  return { a, b, roomIdCommitment };
}

describe('channelTranscriptBytes', () => {
  it('is order-independent in the two ephemeral keys (sorted internally)', () => {
    const room = randomBytes(32);
    const pubA = Uint8Array.of(1, 2, 3);
    const pubB = Uint8Array.of(9, 9, 9);
    const base: Omit<ChannelTranscript, 'ephemeralPublicKeyA' | 'ephemeralPublicKeyB'> = {
      protocolVersion: 1,
      roomIdCommitment: room,
      epoch: 4,
    };
    const forward = channelTranscriptBytes({
      ...base,
      ephemeralPublicKeyA: pubA,
      ephemeralPublicKeyB: pubB,
    });
    const swapped = channelTranscriptBytes({
      ...base,
      ephemeralPublicKeyA: pubB,
      ephemeralPublicKeyB: pubA,
    });
    expect(hex(forward)).toBe(hex(swapped));
  });
});

describe('deriveChannelKey', () => {
  it('both peers derive the same key from opposite-order inputs', async () => {
    const { a, b, roomIdCommitment } = await twoPeers();
    const base = { protocolVersion: 1, roomIdCommitment, epoch: 7 };
    // A holds (a.priv, b.pub) and lists itself first; B holds (b.priv, a.pub)
    // and lists itself first — sorting + ECDH symmetry make the keys equal.
    const keyA = await deriveChannelKey(
      a.privateKey,
      b.publicKey,
      { ...base, ephemeralPublicKeyA: a.publicKey, ephemeralPublicKeyB: b.publicKey },
      CHANNEL_LABEL_SIGNALING,
    );
    const keyB = await deriveChannelKey(
      b.privateKey,
      a.publicKey,
      { ...base, ephemeralPublicKeyA: b.publicKey, ephemeralPublicKeyB: a.publicKey },
      CHANNEL_LABEL_SIGNALING,
    );
    expect(keyA).toHaveLength(32);
    expect(hex(keyA)).toBe(hex(keyB));
  });

  it('a different label yields a different key (signaling vs handshake)', async () => {
    const { a, b, roomIdCommitment } = await twoPeers();
    const transcript: ChannelTranscript = {
      protocolVersion: 1,
      roomIdCommitment,
      epoch: 7,
      ephemeralPublicKeyA: a.publicKey,
      ephemeralPublicKeyB: b.publicKey,
    };
    const sig = await deriveChannelKey(
      a.privateKey,
      b.publicKey,
      transcript,
      CHANNEL_LABEL_SIGNALING,
    );
    const hs = await deriveChannelKey(
      a.privateKey,
      b.publicKey,
      transcript,
      CHANNEL_LABEL_HANDSHAKE,
    );
    expect(hex(sig)).not.toBe(hex(hs));
  });

  it('a different room/epoch/version yields a different key', async () => {
    const { a, b, roomIdCommitment } = await twoPeers();
    const mk = (over: Partial<ChannelTranscript>) =>
      deriveChannelKey(
        a.privateKey,
        b.publicKey,
        {
          protocolVersion: 1,
          roomIdCommitment,
          epoch: 7,
          ephemeralPublicKeyA: a.publicKey,
          ephemeralPublicKeyB: b.publicKey,
          ...over,
        },
        CHANNEL_LABEL_SIGNALING,
      );
    const baseKey = hex(await mk({}));
    expect(hex(await mk({ epoch: 8 }))).not.toBe(baseKey);
    expect(hex(await mk({ protocolVersion: 2 }))).not.toBe(baseKey);
    expect(hex(await mk({ roomIdCommitment: randomBytes(32) }))).not.toBe(baseKey);
  });
});

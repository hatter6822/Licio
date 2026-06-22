// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-S.6.2/6.3 — the pairwise secure channel (PRIVATE_SPEC §15.4, §15.5): the
// transcript-bound key agreement shared by §15.4 encrypted signaling and the
// §15.5 membership-proving handshake.  A pairwise key is HKDF over the X25519
// ECDH shared secret, bound to a transcript (protocol version, room-id
// commitment, epoch, BOTH ephemeral public keys) so it is fresh per connection,
// epoch-bound, and impossible to replay into a different room/epoch.  Both peers
// derive the SAME key because the two ephemeral public keys are sorted before
// binding.  A per-channel `label` domain-separates the signaling key from the
// handshake session key even when they share a transcript.

import { type CanonicalValue, canonical, compareBytes } from '../crypto/canonical.js';
import { x25519SharedSecret } from '../crypto/ecdh.js';
import { hkdfExpandLabel, hkdfExtract } from '../crypto/hkdf.js';

/** Pairwise channel key length, in bytes (an AES-256 key). */
export const CHANNEL_KEY_LENGTH = 32;

/** §15.4 — the signaling channel's KDF label (SDP/ICE seal). */
export const CHANNEL_LABEL_SIGNALING = 'channel-signaling.v1';
/** §15.5 — the handshake data-channel session key's KDF label. */
export const CHANNEL_LABEL_HANDSHAKE = 'channel-handshake.v1';

const EMPTY_SALT = new Uint8Array(0);

/**
 * The transcript a pairwise channel key binds (§15.4/§15.5): the protocol
 * version, the room-id commitment, the epoch, and BOTH ephemeral public keys.
 * Binding the room + epoch defeats cross-room/cross-epoch confusion; binding the
 * ephemeral keys defeats replay across connections.
 */
export interface ChannelTranscript {
  readonly protocolVersion: number;
  readonly roomIdCommitment: Uint8Array;
  readonly epoch: number;
  readonly ephemeralPublicKeyA: Uint8Array;
  readonly ephemeralPublicKeyB: Uint8Array;
}

/** Order the two ephemeral public keys deterministically (bytewise) so both
 *  peers — each holding the pair in the opposite local order — build identical
 *  transcript bytes. */
function sortedPubs(a: Uint8Array, b: Uint8Array): [Uint8Array, Uint8Array] {
  return compareBytes(a, b) <= 0 ? [a, b] : [b, a];
}

/** The canonical transcript byte string (fixed shape, sorted ephemeral keys). */
export function channelTranscriptBytes(transcript: ChannelTranscript): Uint8Array {
  const [lo, hi] = sortedPubs(transcript.ephemeralPublicKeyA, transcript.ephemeralPublicKeyB);
  const fields: CanonicalValue[] = [
    transcript.protocolVersion,
    transcript.roomIdCommitment,
    transcript.epoch,
    lo,
    hi,
  ];
  return canonical(fields);
}

/**
 * Derive a pairwise channel key: `HKDF-Expand-Label(HKDF-Extract(0, ECDH), label,
 * transcript, 32)`.  The X25519 shared secret is the IKM; the transcript is the
 * bound context; `label` separates the signaling key from the handshake key.
 * Deterministic for a fixed (ECDH, transcript, label), so both peers agree.
 */
export async function deriveChannelKey(
  myEphemeralPrivateKey: CryptoKey,
  peerEphemeralPublicKey: Uint8Array,
  transcript: ChannelTranscript,
  label: string,
): Promise<Uint8Array> {
  const shared = await x25519SharedSecret(myEphemeralPrivateKey, peerEphemeralPublicKey);
  const prk = await hkdfExtract(EMPTY_SALT, shared);
  return hkdfExpandLabel(prk, label, channelTranscriptBytes(transcript), CHANNEL_KEY_LENGTH);
}

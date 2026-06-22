// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-S.3.2 — the HKDF key schedule (PRIVATE_SPEC §10.2).  Two layers:
//
//   1. RFC 5869 HKDF-SHA256 primitives (`hkdfExtract`, `hkdfExpand`) built on
//      WebCrypto HMAC — shared with the HPKE bootstrap (WS-S.3.4);
//   2. `HKDF-Expand-Label`, the TLS-1.3 / MLS labeled expansion (RFC 8446 §7.1,
//      RFC 9420 §8), and `deriveRoomEpochKeys`, which derives the five
//      per-purpose room keys from the MLS-exporter `room_epoch_secret`.
//
// The `room_epoch_secret` itself is produced by the MLS epoch exporter
// (WS-S.3.1b) — `roomEpochSecret(epoch)` = MLS-Exporter("licio.private-room.v1.
// epoch", canonical([room_id_commitment, epoch, manifest_commitment]), 32).
// That secret is uniformly random, so HKDF-Expand-Label uses it DIRECTLY as the
// PRK (no separate Extract, exactly as the §10.2 definition states).  This
// module owns only the derivation math; MLS supplies the secret at the seam.

import { concatBytes, getSubtle, toBufferSource, utf8 } from './runtime.js';

/** SHA-256 output length, in bytes. */
export const HASH_LEN = 32;

/** All five operational room keys are 32 bytes (PRIVATE_SPEC §10.2). */
export const ROOM_KEY_LENGTH = 32;

/**
 * The domain-separation prefix for `HKDF-Expand-Label` (PRIVATE_SPEC §10.2).
 * Note the REQUIRED trailing space: the full label is `"licio-priv1 " || label`
 * so the version-and-protocol prefix is unambiguously delimited from the label.
 */
export const HKDF_LABEL_PREFIX = 'licio-priv1 ';

const HMAC_PARAMS = { name: 'HMAC', hash: 'SHA-256' } as const;

/** HMAC-SHA256 over `data` keyed by `key`. */
async function hmacSha256(key: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  const cryptoKey = await getSubtle().importKey('raw', toBufferSource(key), HMAC_PARAMS, false, [
    'sign',
  ]);
  return new Uint8Array(await getSubtle().sign('HMAC', cryptoKey, toBufferSource(data)));
}

/**
 * RFC 5869 §2.2 HKDF-Extract: `PRK = HMAC-Hash(salt, IKM)`.  An EMPTY salt is
 * the RFC's "salt not provided" case, defined as `HashLen` zero bytes; WebCrypto
 * additionally rejects a zero-length HMAC key, so we substitute 32 zero bytes —
 * which is byte-identical for SHA-256 (HMAC zero-pads any key ≤ blocksize to the
 * same 64-byte block, so empty, 32-zero, and 64-zero keys all coincide).
 */
export function hkdfExtract(salt: Uint8Array, ikm: Uint8Array): Promise<Uint8Array> {
  const effectiveSalt = salt.length === 0 ? new Uint8Array(HASH_LEN) : salt;
  return hmacSha256(effectiveSalt, ikm);
}

/**
 * RFC 5869 §2.3 HKDF-Expand: expand a pseudorandom key `prk` to `length` bytes
 * under the context `info`.  `T(i) = HMAC(prk, T(i-1) || info || i)`, output the
 * first `length` bytes of `T(1) || T(2) || …`.  `length` is capped at the RFC's
 * `255 * HashLen` ceiling.
 */
export async function hkdfExpand(
  prk: Uint8Array,
  info: Uint8Array,
  length: number,
): Promise<Uint8Array> {
  if (!Number.isInteger(length) || length < 0) {
    throw new RangeError(`hkdfExpand: invalid length ${length}`);
  }
  const blocks = Math.ceil(length / HASH_LEN);
  if (blocks > 255) {
    throw new RangeError(`hkdfExpand: length ${length} exceeds 255 * HashLen`);
  }
  const out = new Uint8Array(blocks * HASH_LEN);
  let previous: Uint8Array = new Uint8Array(0);
  for (let i = 1; i <= blocks; i++) {
    previous = await hmacSha256(prk, concatBytes(previous, info, Uint8Array.of(i)));
    out.set(previous, (i - 1) * HASH_LEN);
  }
  return out.slice(0, length);
}

/**
 * Build the TLS-1.3 / MLS `HkdfLabel` structure (RFC 8446 §7.1):
 * `uint16(length) || opaque label<…> || opaque context<…>`, each opaque vector
 * length-prefixed by a single byte.  This length-delimited structure is the
 * canonical, NON-ad-hoc framing the §10.2 acceptance criterion requires (it
 * removes any `room_id || epoch` boundary ambiguity without a separate
 * `canonical(...)` pass — the full label and context are explicitly delimited).
 */
export function hkdfLabel(length: number, label: string, context: Uint8Array): Uint8Array {
  if (!Number.isInteger(length) || length < 0 || length > 0xffff) {
    throw new RangeError(`hkdfLabel: length ${length} out of uint16 range`);
  }
  const fullLabel = utf8(HKDF_LABEL_PREFIX + label);
  if (fullLabel.length > 255) throw new RangeError('hkdfLabel: label exceeds 255 bytes');
  if (context.length > 255) throw new RangeError('hkdfLabel: context exceeds 255 bytes');
  return concatBytes(
    Uint8Array.of((length >> 8) & 0xff, length & 0xff),
    Uint8Array.of(fullLabel.length),
    fullLabel,
    Uint8Array.of(context.length),
    context,
  );
}

/**
 * `HKDF-Expand-Label(secret, label, context, length)` (PRIVATE_SPEC §10.2): a
 * labeled HKDF-Expand where the `info` is the `HkdfLabel` structure.  `secret`
 * is used directly as the PRK (it is the already-uniform MLS exporter output).
 */
export function hkdfExpandLabel(
  secret: Uint8Array,
  label: string,
  context: Uint8Array,
  length: number,
): Promise<Uint8Array> {
  return hkdfExpand(secret, hkdfLabel(length, label, context), length);
}

/**
 * The five per-purpose room keys (PRIVATE_SPEC §10.2).  Each is derived with its
 * own `"<purpose>.v1"` label so a key minted for one purpose, room, or version
 * can never collide with another; `context` is the `room_id_commitment` (framed
 * unambiguously by `HkdfLabel`).  A single MLS Commit rotates the
 * `room_epoch_secret`, which rotates ALL FIVE keys at once (§10.9).
 */
export interface RoomEpochKeys {
  /** Wraps every per-object content key (the §10.4 `key_wrap`). */
  readonly contentWrapKey: Uint8Array;
  /** Derives the per-epoch sync topic / pubsub channel. */
  readonly syncTopicKey: Uint8Array;
  /** Derives the per-epoch blind rendezvous ids (§15.3). */
  readonly rendezvousKey: Uint8Array;
  /** Encrypts room snapshots (§14.5). */
  readonly snapshotKey: Uint8Array;
  /** Encrypts a voluntary report package (§19.4). */
  readonly reportKey: Uint8Array;
}

/** The §10.2 derivation labels, pinned so they cannot drift from the spec. */
export const ROOM_KEY_LABELS = {
  contentWrapKey: 'content-wrap.v1',
  syncTopicKey: 'sync-topic.v1',
  rendezvousKey: 'rendezvous.v1',
  snapshotKey: 'snapshot.v1',
  reportKey: 'voluntary-report.v1',
} as const satisfies Record<keyof RoomEpochKeys, string>;

/**
 * Derive all five operational keys from the epoch's `room_epoch_secret` and the
 * `room_id_commitment`.  Deterministic: identical inputs yield byte-identical
 * keys on every device, which is the basis for cross-device convergence.
 */
export async function deriveRoomEpochKeys(
  roomEpochSecret: Uint8Array,
  roomIdCommitment: Uint8Array,
): Promise<RoomEpochKeys> {
  const [contentWrapKey, syncTopicKey, rendezvousKey, snapshotKey, reportKey] = await Promise.all([
    hkdfExpandLabel(
      roomEpochSecret,
      ROOM_KEY_LABELS.contentWrapKey,
      roomIdCommitment,
      ROOM_KEY_LENGTH,
    ),
    hkdfExpandLabel(
      roomEpochSecret,
      ROOM_KEY_LABELS.syncTopicKey,
      roomIdCommitment,
      ROOM_KEY_LENGTH,
    ),
    hkdfExpandLabel(
      roomEpochSecret,
      ROOM_KEY_LABELS.rendezvousKey,
      roomIdCommitment,
      ROOM_KEY_LENGTH,
    ),
    hkdfExpandLabel(
      roomEpochSecret,
      ROOM_KEY_LABELS.snapshotKey,
      roomIdCommitment,
      ROOM_KEY_LENGTH,
    ),
    hkdfExpandLabel(roomEpochSecret, ROOM_KEY_LABELS.reportKey, roomIdCommitment, ROOM_KEY_LENGTH),
  ]);
  return { contentWrapKey, syncTopicKey, rendezvousKey, snapshotKey, reportKey };
}

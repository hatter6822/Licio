// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-S — the §10.4 `author_device_id_blind` derivation (PRIVATE_SPEC §10.4,
// §10.2).  Every op envelope carries an `author_device_id_blind` — a per-epoch
// device PSEUDONYM so a passive observer of ciphertext cannot link a device's
// ops across epochs.  PRIVATE_SPEC §10.4 names the field but (like the rendezvous
// blind ids it parallels) does not pin the derivation; this is the chosen
// construction, built from the SAME two primitives the spec already pins:
//
//   1. a per-epoch device-blind KEY via the §10.2 labeled HKDF (so it rotates
//      with the epoch secret exactly like the five operational keys, §10.9), and
//   2. an HMAC-SHA256 blind id over a CANONICAL message (never `||`) — the same
//      shape as the §15.3 rendezvous blind ids.
//
// The result is DETERMINISTIC (every member computes the same blind for a given
// device+epoch, so a verifier can map a blind back to a device's signing key) and
// per-epoch UNLINKABLE (a fresh epoch secret ⇒ an unrelated blind).  The epoch is
// bound into the HMAC too (defense in depth: even a key-reuse bug cannot collide
// two epochs' blinds for one device).

import { canonical } from './canonical.js';
import { hkdfExpandLabel } from './hkdf.js';
import { hmacSha256, toBase64Url } from './runtime.js';

/** The §10.2 HKDF-Expand-Label label for the per-epoch device-blind key. */
export const AUTHOR_DEVICE_BLIND_LABEL = 'author-device-blind.v1';

/** The author-device-blind key length (an HMAC key), in bytes. */
export const AUTHOR_DEVICE_BLIND_KEY_LENGTH = 32;

/**
 * Derive the per-epoch device-blind KEY from the epoch's `room_epoch_secret`
 * (the §10.2 labeled HKDF, `room_id_commitment` as context).  A single MLS commit
 * rotates `room_epoch_secret`, which rotates this key with the five operational
 * keys (§10.9), so a device's blind id is unlinkable across epochs.
 */
export function deriveAuthorDeviceBlindKey(
  roomEpochSecret: Uint8Array,
  roomIdCommitment: Uint8Array,
): Promise<Uint8Array> {
  return hkdfExpandLabel(
    roomEpochSecret,
    AUTHOR_DEVICE_BLIND_LABEL,
    roomIdCommitment,
    AUTHOR_DEVICE_BLIND_KEY_LENGTH,
  );
}

/**
 * The `author_device_id_blind` for `deviceId` at `epoch` under a pre-derived
 * `deviceBlindKey` (use this form to map many devices for one epoch without
 * re-deriving the key): `base64url(HMAC-SHA256(deviceBlindKey,
 * canonical(["author-device", device_id, epoch])))`.
 */
export async function authorDeviceIdBlindFrom(
  deviceBlindKey: Uint8Array,
  deviceId: string,
  epoch: number,
): Promise<string> {
  return toBase64Url(
    await hmacSha256(deviceBlindKey, canonical(['author-device', deviceId, epoch])),
  );
}

/**
 * The `author_device_id_blind` for `deviceId` at `epoch`, deriving the per-epoch
 * key from `roomEpochSecret` first (the convenience one-shot form).
 */
export async function deriveAuthorDeviceIdBlind(
  roomEpochSecret: Uint8Array,
  roomIdCommitment: Uint8Array,
  deviceId: string,
  epoch: number,
): Promise<string> {
  const key = await deriveAuthorDeviceBlindKey(roomEpochSecret, roomIdCommitment);
  return authorDeviceIdBlindFrom(key, deviceId, epoch);
}

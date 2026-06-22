// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-S.3.1b — the epoch bridge: MLS exporter → `room_epoch_secret` → the §10.2
// five-key schedule.  This is the seam where the MLS group keying (WS-S.3.1a)
// meets the WebCrypto key schedule (WS-S.3.2).
//
//   room_epoch_secret = MLS-Exporter(
//     "licio.private-room.v1.epoch",
//     canonical([room_id_commitment, epoch, manifest_commitment]),
//     32)                                            // RFC 9420 §8.5 (§10.2)
//
// The exporter context binds `manifest_commitment`, so a fork of the manifest
// yields a DIFFERENT secret — cross-fork content cannot be opened (§10.2).  A
// single MLS commit changes the epoch, which changes the exporter secret, which
// rotates `room_epoch_secret` and therefore ALL FIVE operational keys at once
// (§10.9).  `deriveEpochState` is a PURE function of the group's current epoch,
// so the new key state atomically replaces the old (no window where the two
// coexist) — that is the §10.2 "epoch-transition event" expressed without
// mutable state.

import { type CanonicalValue, canonical } from './canonical.js';
import { deriveRoomEpochKeys, type RoomEpochKeys } from './hkdf.js';
import { currentEpoch, type MlsGroup, mlsRoomEpochSecret } from './mls.js';

/** The full operational key state for one room epoch. */
export interface RoomEpochState {
  /** The MLS epoch this state was derived at. */
  readonly epoch: bigint;
  /** The §10.2 `room_epoch_secret` (the exporter output). */
  readonly roomEpochSecret: Uint8Array;
  /** The five per-purpose keys derived from `room_epoch_secret`. */
  readonly keys: RoomEpochKeys;
}

/**
 * Build the §10.2 MLS-Exporter context: `canonical([room_id_commitment, epoch,
 * manifest_commitment])`.  `epoch` is the MLS epoch (a bigint); the canonical
 * encoding removes any field-boundary ambiguity and binds the manifest.
 */
export function roomEpochExporterContext(
  roomIdCommitment: Uint8Array,
  epoch: bigint,
  manifestCommitment: Uint8Array,
): Uint8Array {
  const context: CanonicalValue[] = [roomIdCommitment, epoch, manifestCommitment];
  return canonical(context);
}

/**
 * Derive `room_epoch_secret` for the group's CURRENT epoch.  Deterministic: two
 * devices at the same epoch with the same `(room_id_commitment,
 * manifest_commitment)` derive the identical secret.
 */
export function roomEpochSecret(
  group: MlsGroup,
  roomIdCommitment: Uint8Array,
  manifestCommitment: Uint8Array,
): Promise<Uint8Array> {
  const context = roomEpochExporterContext(
    roomIdCommitment,
    currentEpoch(group),
    manifestCommitment,
  );
  return mlsRoomEpochSecret(group, context);
}

/**
 * Derive the full `RoomEpochState` (secret + five keys) for the group's current
 * epoch.  Call this once per epoch transition; the returned state atomically
 * supersedes the previous epoch's state (§10.2 epoch-transition semantics).
 */
export async function deriveEpochState(
  group: MlsGroup,
  roomIdCommitment: Uint8Array,
  manifestCommitment: Uint8Array,
): Promise<RoomEpochState> {
  const epoch = currentEpoch(group);
  const secret = await roomEpochSecret(group, roomIdCommitment, manifestCommitment);
  const keys = await deriveRoomEpochKeys(secret, roomIdCommitment);
  return { epoch, roomEpochSecret: secret, keys };
}

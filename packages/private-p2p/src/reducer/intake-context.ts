// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-S — build the §14.2 stage-1 `OpIntakeContext` from REDUCED room state + the
// epoch keys the local device holds.  This is the glue that makes `sealOp` /
// `openOp` (`validate-op.ts`) compose against a real room: the verifier resolves
// an envelope's `author_device_id_blind` back to a device's Ed25519 verify key by
// recomputing every known device's blind id (per held epoch) from the §10.4
// derivation (`crypto/device-blind.ts`) and the device's `signing_public_key`
// recorded in state — never a hand-built lookup table.
//
// Removed-device enforcement stays the reducer's job: this only resolves the
// VERIFY KEY, so a removed device's op opens at stage-1 then is rejected at the
// fold (the existing `reduce.ts` `author_device_not_active` path) — exactly as a
// wire-fetched op would be.

import { authorDeviceIdBlindFrom, deriveAuthorDeviceBlindKey } from '../crypto/device-blind.js';
import { fromBase64Url } from '../crypto/runtime.js';
import { importPublicKeyRaw } from '../crypto/signatures.js';
import type { RoomReducerState } from './state.js';
import type { OpIntakeContext } from './validate-op.js';

/** The keys the local device holds for one epoch: the secret (to re-derive the
 *  device-blind key) + the `content_wrap_key` (to AEAD-open that epoch's bodies). */
export interface HeldEpochKeys {
  readonly roomEpochSecret: Uint8Array;
  readonly contentWrapKey: Uint8Array;
}

export interface BuildOpIntakeContextParams {
  readonly state: RoomReducerState;
  readonly roomIdCommitment: Uint8Array;
  /** epoch number → the keys held for that epoch (the device may hold several). */
  readonly epochs: ReadonlyMap<number, HeldEpochKeys>;
}

/**
 * Build the §14.2 stage-1 context.  For each held epoch, derive the device-blind
 * key and map EVERY device in state (its `author_device_id_blind` at that epoch) →
 * its imported verify key; `contentWrapKeyForEpoch` returns the held wrap key.  A
 * device whose recorded `signing_public_key` is not a valid Ed25519 key is
 * skipped (its ops then quarantine as `unknown_device`, never a crash).
 */
export async function buildOpIntakeContext(
  params: BuildOpIntakeContextParams,
): Promise<OpIntakeContext> {
  const { state, roomIdCommitment, epochs } = params;
  const blindToKey = new Map<string, CryptoKey>();
  const wrapByEpoch = new Map<number, Uint8Array>();
  // The same raw verify key imports once, then is reused across epochs.
  const importedByDevice = new Map<string, CryptoKey | null>();

  for (const [epoch, held] of epochs) {
    wrapByEpoch.set(epoch, held.contentWrapKey);
    const blindKey = await deriveAuthorDeviceBlindKey(held.roomEpochSecret, roomIdCommitment);
    for (const device of state.devices.values()) {
      let key = importedByDevice.get(device.deviceId);
      if (key === undefined) {
        try {
          key = await importPublicKeyRaw(fromBase64Url(device.signingPublicKey));
        } catch {
          key = null; // malformed recorded key → leave the device unresolvable
        }
        importedByDevice.set(device.deviceId, key);
      }
      if (key === null) continue;
      const blind = await authorDeviceIdBlindFrom(blindKey, device.deviceId, epoch);
      blindToKey.set(blind, key);
    }
  }

  return {
    roomIdCommitment,
    contentWrapKeyForEpoch: (epoch) => wrapByEpoch.get(epoch),
    deviceSigningKey: (blind) => blindToKey.get(blind),
  };
}

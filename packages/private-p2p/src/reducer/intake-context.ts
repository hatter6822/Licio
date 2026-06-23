// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-S — build the §14.2 stage-1 `OpIntakeContext` from REDUCED room state + the
// epoch keys the local device holds.  This is the glue that makes `sealOp` /
// `openOp` (`validate-op.ts`) compose against a real room: the verifier resolves
// an envelope's `author_device_id_blind` back to a device's Ed25519 verify key
// AND its real device id by recomputing every known device's blind id (per held
// epoch) from the §10.4 derivation (`crypto/device-blind.ts`) and the device's
// `signing_public_key` recorded in state — never a hand-built lookup table.
//
// The blind→device-id half is a SECURITY binding, not a convenience: the §10.4
// blind is derived from the SHARED `room_epoch_secret`, so ANY member can compute
// ANY device's blind.  The blind therefore identifies WHO SIGNED (the resolved
// verify key), but the reducer's authority decisions key off the op's PLAINTEXT
// `author_device_id`.  Without binding the two, a member could sign an op under
// their OWN blind (valid signature) while putting a higher-privilege device's id
// in the plaintext — impersonation.  `openOp` closes this by requiring
// `deviceIdForBlind(blind) === op.author_device_id`.
//
// Removed-device enforcement stays the reducer's job: this only resolves the
// VERIFY KEY + device id, so a removed device's op opens at stage-1 then is
// rejected at the fold (the existing `reduce.ts` `author_device_not_active` path)
// — exactly as a wire-fetched op would be.

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

/** A device whose verify key is known OUT OF BAND (the genesis bootstrap): the
 *  creator's own device, or the member devices a joiner reads from the verified
 *  room manifest.  Needed because the FOUNDER's key cannot come from reduced
 *  state when opening the genesis op (the founder is not in state until genesis
 *  is reduced, which requires opening it first). */
export interface BootstrapDevice {
  readonly deviceId: string;
  readonly signingPublicKey: string;
}

export interface BuildOpIntakeContextParams {
  readonly state: RoomReducerState;
  readonly roomIdCommitment: Uint8Array;
  /** epoch number → the keys held for that epoch (the device may hold several). */
  readonly epochs: ReadonlyMap<number, HeldEpochKeys>;
  /** Out-of-band device keys (the genesis bootstrap; state wins on a clash). */
  readonly extraDevices?: ReadonlyArray<BootstrapDevice>;
}

/**
 * Build the §14.2 stage-1 context.  For each held epoch, derive the device-blind
 * key and map EVERY known device (its `author_device_id_blind` at that epoch) →
 * its imported verify key; `contentWrapKeyForEpoch` returns the held wrap key.
 * "Known devices" = the devices in reduced state PLUS the out-of-band
 * `extraDevices` (the genesis bootstrap), state winning a `deviceId` clash.  A
 * device whose recorded `signing_public_key` is not a valid Ed25519 key is
 * skipped (its ops then quarantine as `unknown_device`, never a crash).
 */
export async function buildOpIntakeContext(
  params: BuildOpIntakeContextParams,
): Promise<OpIntakeContext> {
  const { state, roomIdCommitment, epochs } = params;
  const blindToKey = new Map<string, CryptoKey>();
  // Same blind → the device id it resolves to (the impersonation binding).
  const blindToDevice = new Map<string, string>();
  const wrapByEpoch = new Map<number, Uint8Array>();
  // The same raw verify key imports once, then is reused across epochs.
  const importedByDevice = new Map<string, CryptoKey | null>();

  // Union of state devices + the out-of-band bootstrap (state wins a clash).
  const deviceKeys = new Map<string, string>();
  for (const bootstrap of params.extraDevices ?? []) {
    deviceKeys.set(bootstrap.deviceId, bootstrap.signingPublicKey);
  }
  for (const device of state.devices.values()) {
    deviceKeys.set(device.deviceId, device.signingPublicKey);
  }

  for (const [epoch, held] of epochs) {
    wrapByEpoch.set(epoch, held.contentWrapKey);
    const blindKey = await deriveAuthorDeviceBlindKey(held.roomEpochSecret, roomIdCommitment);
    for (const [deviceId, signingPublicKey] of deviceKeys) {
      let key = importedByDevice.get(deviceId);
      if (key === undefined) {
        try {
          key = await importPublicKeyRaw(fromBase64Url(signingPublicKey));
        } catch {
          key = null; // malformed recorded key → leave the device unresolvable
        }
        importedByDevice.set(deviceId, key);
      }
      if (key === null) continue;
      const blind = await authorDeviceIdBlindFrom(blindKey, deviceId, epoch);
      blindToKey.set(blind, key);
      blindToDevice.set(blind, deviceId);
    }
  }

  return {
    roomIdCommitment,
    contentWrapKeyForEpoch: (epoch) => wrapByEpoch.get(epoch),
    deviceSigningKey: (blind) => blindToKey.get(blind),
    deviceIdForBlind: (blind) => blindToDevice.get(blind),
  };
}

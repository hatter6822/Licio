// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Bundle-export authorization (OFFLINE_SPEC §29.8 export gate, WS-R.12.4).  A server-side
// room export discloses the room's accepted content closure (which may hold in_room
// content), so it is gated by a room capability, not open to anyone who knows a room id.
// The requesting device signs a freshness-windowed `export_request` (a `device_signature`
// detached proof over its canonical body); this verifier checks, over the server's
// registered identity state, that:
//   1. the request is fresh (within the window around `issued_at_ms`);
//   2. the cited capability is FOR the requested room, authority-signed (not a forged
//      content-addressed body), unexpired, and grants `may_export_bundle`;
//   3. the request signature verifies against the capability's subject device key (whose
//      certificate is itself authority-verified at registration); and
//   4. neither the device, the capability, nor the account is revoked.
// Any failure denies the export.  Pure: the caller injects the resolvers + clock.

import { type DetachedProofV2, verifyDetached } from '../cose/sign1.js';
import type { ExportRequestV2 } from '../schemas/export-request.js';
import { type CapabilityBundle, verifyCapability } from './capability.js';
import type { RevocationIndex } from './revocation.js';

export type ExportAuthorizationStatus =
  | 'rejected_wrong_proof_kind'
  | 'rejected_stale_request'
  | 'rejected_unknown_capability'
  | 'rejected_room_mismatch'
  | 'rejected_export_not_permitted'
  | 'rejected_capability_unverifiable'
  | 'rejected_unknown_device'
  | 'rejected_bad_signature'
  | 'rejected_revoked';

export type ExportAuthorizationResult =
  | { readonly ok: true; readonly roomId: string; readonly capabilityId: string }
  | { readonly ok: false; readonly status: ExportAuthorizationStatus };

/** The registered identity state the export gate reads. */
export interface ExportAuthorizationDeps {
  resolveCapability(capabilityCid: string): CapabilityBundle | undefined;
  resolveRoomAuthorityKey(roomId: string, policyEpoch: number): CryptoKey | undefined;
  /** The authority-verified public key for a device key id (the cert-imported key). */
  resolveDevicePublicKey(deviceKeyId: string): CryptoKey | undefined;
  readonly revocations: RevocationIndex;
}

export interface ExportAuthorizationContext {
  readonly networkId: string;
  readonly nowMs: number;
  /** The accepted clock-skew window around `issued_at_ms` (default 60s). */
  readonly freshnessWindowMs?: number;
}

const DEFAULT_FRESHNESS_WINDOW_MS = 60_000;

/** Verify a device-signed `export_request` against the registered identity state. */
export async function verifyExportAuthorization(params: {
  readonly request: ExportRequestV2;
  /** The canonical LDC body of `request` (the bytes `proof.record_cid` addresses). */
  readonly body: Uint8Array;
  readonly proof: DetachedProofV2;
  readonly deps: ExportAuthorizationDeps;
  readonly ctx: ExportAuthorizationContext;
}): Promise<ExportAuthorizationResult> {
  const { request, body, proof, deps, ctx } = params;
  if (proof.proof_kind !== 'device_signature') {
    return { ok: false, status: 'rejected_wrong_proof_kind' };
  }

  // 1. Freshness — a captured request expires outside the window (replay bound).
  const window = ctx.freshnessWindowMs ?? DEFAULT_FRESHNESS_WINDOW_MS;
  if (Math.abs(ctx.nowMs - request.issued_at_ms) > window) {
    return { ok: false, status: 'rejected_stale_request' };
  }

  // 2. The capability: registered, for THIS room, authority-signed, unexpired, exportable.
  const capBundle = deps.resolveCapability(request.capability_cid);
  if (!capBundle) return { ok: false, status: 'rejected_unknown_capability' };
  const { capability } = capBundle;
  if (capability.room_id !== request.room_id) {
    return { ok: false, status: 'rejected_room_mismatch' };
  }
  if (!capability.transfer_policy.may_export_bundle) {
    return { ok: false, status: 'rejected_export_not_permitted' };
  }
  const roomKey = deps.resolveRoomAuthorityKey(capability.room_id, capability.policy_epoch);
  if (!roomKey) return { ok: false, status: 'rejected_capability_unverifiable' };
  const capVerified = await verifyCapability(capBundle, roomKey, {
    networkId: ctx.networkId,
    nowMs: ctx.nowMs,
  });
  if (!capVerified.ok) return { ok: false, status: 'rejected_capability_unverifiable' };

  // 3. The request signature must be by the capability's SUBJECT device key.
  const deviceKey = deps.resolveDevicePublicKey(capability.subject_device_key_id);
  if (!deviceKey) return { ok: false, status: 'rejected_unknown_device' };
  const sigVerified = await verifyDetached(proof, body, deviceKey, {
    networkId: ctx.networkId,
    expectedRecordKind: 'export_request',
  });
  if (!sigVerified.ok) return { ok: false, status: 'rejected_bad_signature' };

  // 4. Revocations — a revoked device / capability / account can never export.
  if (
    deps.revocations.isRevoked('device', capability.subject_device_key_id) ||
    deps.revocations.isRevoked('capability', capability.capability_id) ||
    deps.revocations.isRevoked('account', capability.subject_account_id)
  ) {
    return { ok: false, status: 'rejected_revoked' };
  }

  return { ok: true, roomId: capability.room_id, capabilityId: capability.capability_id };
}

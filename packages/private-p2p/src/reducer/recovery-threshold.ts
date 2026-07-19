// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-S.3.6c — capability-based threshold recovery (PRIVATE_SPEC §12.6.1).  M
// distinct admin-signed `recovery.authorize` ops combine to authorize re-
// admitting a recovering member — explicitly NOT Shamir/secret-sharing: NO key
// material is ever reconstructed or transmitted (the `recovery.authorize` op
// schema carries only ids, never a key).  Each authorization is an ordinary
// authority-validated op (WS-S.5.1) recorded by the reducer; this module reads
// that accumulated state and decides whether the room-configured M-of-N
// threshold is met.  A successful recovery then proceeds through the NORMAL
// membership path (a `member.add` = an MLS Add + epoch rotation, WS-S.3.1b),
// so removed/old epochs stay sealed and no root key is shared or rebuilt.
//
// STATUS (tracked debt — see docs/private-p2p/README.md): this evaluator is the
// COMPLETE decision function, but the reducer does not yet CONSUME it to GATE a
// re-admit — `applyMemberAdd` has neither the manifest-configured M nor a
// recovery linkage from `member.add` to a recovery request.  Until that wiring
// lands, the M-of-N gate is NOT enforced; WS-S.3.6c is not yet shipped-enforced.

import type { RoomReducerState } from './state.js';

export interface RecoveryThresholdResult {
  /** Whether the room-configured M-of-N threshold is satisfied. */
  readonly authorized: boolean;
  /** The count of DISTINCT recover-capable admins who authorized (via active devices). */
  readonly distinctAdmins: number;
  /** The configured threshold M. */
  readonly threshold: number;
  /** The member being recovered (if the request exists). */
  readonly recoveringMemberId: string | null;
}

/**
 * Evaluate the §12.6.1 threshold for `recoveryRequestId` against `threshold` (M).
 * Counts DISTINCT members (not devices) who (a) authorized the request, (b) are
 * still active, and (c) currently hold the `recover` capability — so M
 * authorizations from one admin's several devices do NOT satisfy M-of-N, and a
 * since-revoked authorizer no longer counts.  `threshold` must be ≥ 1.
 */
export function evaluateRecoveryThreshold(
  state: RoomReducerState,
  recoveryRequestId: string,
  threshold: number,
): RecoveryThresholdResult {
  const request = state.recoveryRequests.get(recoveryRequestId);
  if (!request) {
    return { authorized: false, distinctAdmins: 0, threshold, recoveringMemberId: null };
  }

  const distinctAdmins = new Set<string>();
  for (const deviceId of request.authorizingDeviceIds) {
    const device = state.devices.get(deviceId);
    if (!device || device.removed) continue;
    const member = state.members.get(device.memberId);
    if (member && !member.removed && member.capabilities.has('recover')) {
      distinctAdmins.add(member.memberId);
    }
  }

  return {
    authorized: threshold >= 1 && distinctAdmins.size >= threshold,
    distinctAdmins: distinctAdmins.size,
    threshold,
    recoveringMemberId: request.recoveringMemberId,
  };
}

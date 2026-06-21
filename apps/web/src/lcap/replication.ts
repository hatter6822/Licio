// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-R.11.5 — privacy-aware replication eligibility (OFFLINE_SPEC §21.4, §26.4).  The
// gate that decides whether a record MAY be exported / relayed / advertised / sent to
// a courier or peer:
//
//   - public content MAY replicate opportunistically;
//   - in-room content follows room policy;
//   - PRIVATE-room content MUST NOT be exported/relayed/advertised UNLESS it is
//     encrypted AND room-policy-permitted AND explicitly user-selected;
//   - the transfer policy (capability) gates EVERY decision; an unknown visibility
//     defaults to "do not replicate."
//
// Encrypted private content still leaks size/timing/contact/room-access patterns, so
// every allowed private replication carries a metadata-risk flag for WS-R.14 to
// surface.  WS-S owns the encryption itself; this is the LCAP-side policy gate.

export type Visibility = 'public' | 'in_room' | 'private';
export type ReplicationChannel = 'export' | 'relay' | 'courier' | 'advertise' | 'peer';

/** The capability's §18.1 transfer policy — what channels its content may take. */
export interface TransferPolicy {
  readonly mayExportBundle: boolean;
  readonly mayShareWithRelay: boolean;
  readonly mayShareWithCourier: boolean;
  readonly mayShareWithUnknownPeer: boolean;
}

export interface ReplicationRequest {
  /** The content's visibility scope; anything but the three known values default-denies. */
  readonly visibility: Visibility | (string & {});
  /** Whether the content is ciphertext (required for any private-room replication). */
  readonly encrypted: boolean;
  readonly transferPolicy: TransferPolicy;
  /** Whether room policy permits this channel (gates in-room + private). */
  readonly roomPolicyPermits: boolean;
  /** Whether the user explicitly selected to share (required for private). */
  readonly userSelected: boolean;
  readonly channel: ReplicationChannel;
}

export interface ReplicationDecision {
  readonly allowed: boolean;
  readonly reason: string;
  /** Private content leaks size/timing/contact/room-access even when encrypted (§21.4). */
  readonly metadataRisk: boolean;
}

function transferAllows(channel: ReplicationChannel, tp: TransferPolicy): boolean {
  switch (channel) {
    case 'export':
      return tp.mayExportBundle;
    case 'relay':
      return tp.mayShareWithRelay;
    case 'courier':
    case 'advertise': // advertising offers content to couriers/relays → courier-gated
      return tp.mayShareWithCourier;
    case 'peer':
      return tp.mayShareWithUnknownPeer;
  }
}

/** Decide whether a record may replicate over `channel` (§21.4).  Default-deny. */
export function replicationDecision(req: ReplicationRequest): ReplicationDecision {
  const metadataRisk = req.visibility === 'private';

  // Default-deny an unknown visibility.
  if (req.visibility !== 'public' && req.visibility !== 'in_room' && req.visibility !== 'private') {
    return { allowed: false, reason: 'unknown_visibility_default_deny', metadataRisk };
  }

  // The transfer policy gates EVERY decision (a missing/false field denies).
  if (!transferAllows(req.channel, req.transferPolicy)) {
    return { allowed: false, reason: 'transfer_policy_denied', metadataRisk };
  }

  if (req.visibility === 'public') {
    return { allowed: true, reason: 'public_opportunistic', metadataRisk };
  }

  if (req.visibility === 'in_room') {
    return req.roomPolicyPermits
      ? { allowed: true, reason: 'in_room_policy_permitted', metadataRisk }
      : { allowed: false, reason: 'in_room_policy_denied', metadataRisk };
  }

  // private: encrypted AND room-policy-permitted AND user-selected, all required.
  if (!req.encrypted) {
    return { allowed: false, reason: 'private_plaintext_forbidden', metadataRisk };
  }
  if (!req.roomPolicyPermits) {
    return { allowed: false, reason: 'private_policy_denied', metadataRisk };
  }
  if (!req.userSelected) {
    return { allowed: false, reason: 'private_not_user_selected', metadataRisk };
  }
  return { allowed: true, reason: 'private_encrypted_permitted_selected', metadataRisk };
}

/** Shorthand: whether a record may replicate over `channel`. */
export function mayReplicate(req: ReplicationRequest): boolean {
  return replicationDecision(req).allowed;
}

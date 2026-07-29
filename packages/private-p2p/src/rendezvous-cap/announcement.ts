// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-S Tier-2 — the announce-side glue between a `RendezvousMember` and the cap field
// embedded in a sealed rendezvous announcement (sync/rendezvous.ts). On announce the member
// produces the cap; the VERIFY side is the §6.8 serverless cap `filterVerifiedPresence`
// (poll-filter.ts), which verifies + dedups the OPENED caps under the issuer key. The epoch +
// time bucket come from the rendezvous record context (not re-sent), so announce + verify
// agree by construction.

import { toBase64Url } from '../crypto/runtime.js';
import { pseudonymToBytes } from './credential.js';
import type { RendezvousMember } from './session.js';

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

/** The cap embedded in a `rendezvous_announcement` (base64url proof + pseudonym). */
export interface AnnouncementCap {
  readonly proof: string;
  readonly pseudonym: string;
}

/**
 * Build the cap to seal into an announcement for `member` at `(roomBlindId, epoch, bucket)`,
 * BOUND to `signalingPublicKey` — the ephemeral dial identity this announcement publishes —
 * or `null` if the member is not enrolled for the epoch (the announcement then rides Tier-1).
 *
 * The binding is what stops a polled cap being lifted onto someone else's dial info and
 * evicting the honest device from discovery by taking its pseudonym slot; see
 * `rendezvousContext`.
 */
export function buildAnnouncementCap(
  member: RendezvousMember,
  roomBlindId: string,
  epoch: number,
  bucket: number,
  signalingPublicKey: Uint8Array,
): AnnouncementCap | null {
  const presence = member.announce(enc(roomBlindId), String(epoch), bucket, signalingPublicKey);
  if (presence === null) return null;
  return {
    proof: toBase64Url(presence.proof),
    pseudonym: toBase64Url(pseudonymToBytes(presence.pseudonym)),
  };
}

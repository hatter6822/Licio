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
 * The DIAL-CRITICAL fields a cap is bound to, canonically encoded.
 *
 * Binding the signalling key ALONE left a gap: a hostile member could open an
 * honest announcement, keep its `signaling_public_key` so the proof still
 * verified, swap `peer_device_id`, and re-seal under the room key with a later
 * expiry — the dial then reached the honest peer, failed the §15.5 claimed-device
 * check, and cooled down the honest device's now-deterministic key.  A cap that
 * authorises a dial has to cover everything the dial acts on.
 *
 * The binding does not, on its own, close the EVICTION: the carrier used to dedup
 * by signalling key before verifying any cap, so a forgery keeping that key won the
 * slot whatever the binding said, and was then dropped for failing verification —
 * the honest device in neither set.  That is fixed in the carrier
 * (`connect-peer.ts`: verify first, dedup within each tier), not here.  Two
 * different holes; this note used to read as though the binding covered both.
 *
 * Length-prefixed, never `||`: a field boundary that can move is a field
 * boundary an attacker can move.
 */
export function dialBinding(signalingPublicKey: Uint8Array, peerDeviceId: string): Uint8Array {
  const device = enc(peerDeviceId);
  const out = new Uint8Array(4 + signalingPublicKey.length + 4 + device.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, signalingPublicKey.length, false);
  out.set(signalingPublicKey, 4);
  view.setUint32(4 + signalingPublicKey.length, device.length, false);
  out.set(device, 8 + signalingPublicKey.length);
  return out;
}

/**
 * Build the cap to seal into an announcement for `member` at `(roomBlindId, epoch, bucket)`,
 * BOUND to the announcement's dial-critical fields (`dialBinding`) — or `null` if the member
 * is not enrolled for the epoch (the announcement then rides Tier-1).
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
  peerDeviceId: string,
): AnnouncementCap | null {
  const presence = member.announce(
    enc(roomBlindId),
    String(epoch),
    bucket,
    dialBinding(signalingPublicKey, peerDeviceId),
  );
  if (presence === null) return null;
  return {
    proof: toBase64Url(presence.proof),
    pseudonym: toBase64Url(pseudonymToBytes(presence.pseudonym)),
  };
}

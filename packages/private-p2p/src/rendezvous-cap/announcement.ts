// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-S Tier-2 — the carrier glue between a `RendezvousMember`/issuer key and the cap field
// embedded in a sealed rendezvous announcement (sync/rendezvous.ts). On announce the member
// produces the cap; on poll a peer verifies the OPENED announcement's cap and dedups by the
// returned pseudonym. The epoch + time bucket come from the rendezvous record context (not
// re-sent), so the announce + verify agree by construction.

import { fromBase64Url, toBase64Url } from '../crypto/runtime.js';
import {
  issuerKeyFromBytes,
  pseudonymFromBytes,
  pseudonymToBytes,
  rendezvousContext,
  verifyRendezvousPresence,
} from './credential.js';
import type { RendezvousMember } from './session.js';

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

/** The cap embedded in a `rendezvous_announcement` (base64url proof + pseudonym). */
export interface AnnouncementCap {
  readonly proof: string;
  readonly pseudonym: string;
}

/**
 * Build the cap to seal into an announcement for `member` at `(roomBlindId, epoch, bucket)`,
 * or `null` if the member is not enrolled for the epoch (the announcement then rides Tier-1).
 */
export function buildAnnouncementCap(
  member: RendezvousMember,
  roomBlindId: string,
  epoch: number,
  bucket: number,
): AnnouncementCap | null {
  const presence = member.announce(enc(roomBlindId), String(epoch), bucket);
  if (presence === null) return null;
  return {
    proof: toBase64Url(presence.proof),
    pseudonym: toBase64Url(pseudonymToBytes(presence.pseudonym)),
  };
}

/**
 * Verify an OPENED announcement's cap under `issuerKey` for `(roomBlindId, epoch, bucket)`.
 * Returns the canonical pseudonym bytes (the dedup key a poller keys verified peers by) if
 * the proof binds the pseudonym to the context under the issuer key, else `null` (a fake /
 * malformed cap — the poller skips it).
 */
export function verifyAnnouncementCap(
  cap: AnnouncementCap,
  issuerKey: Uint8Array,
  roomBlindId: string,
  epoch: number,
  bucket: number,
): Uint8Array | null {
  try {
    const pseudonym = pseudonymFromBytes(fromBase64Url(cap.pseudonym));
    const epochBytes = enc(String(epoch));
    const context = rendezvousContext(enc(roomBlindId), epochBytes, bucket);
    const ok = verifyRendezvousPresence(
      issuerKeyFromBytes(issuerKey),
      fromBase64Url(cap.proof),
      pseudonym,
      epochBytes,
      context,
    );
    return ok ? pseudonymToBytes(pseudonym) : null;
  } catch {
    return null; // malformed encoding
  }
}

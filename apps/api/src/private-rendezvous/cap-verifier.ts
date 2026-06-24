// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-S Tier-2 — the server-side presence VERIFIER binding (the cap's enforcement).
//
// This is the one place the rendezvous server reaches into `@licio/private-p2p`, and only
// for the BLINDNESS-PRESERVING `rendezvous-cap` subpath (the BBS verify + context
// derivation — NOT the room engine / MLS). Verifying a zero-knowledge presence proof
// reveals NOTHING to the server beyond the per-epoch pseudonym it already stores (the proof
// is ZK; the pseudonym is a discrete-log image of a secret the server never holds), so the
// §15.3.1 server-blindness property is preserved. Analogous to the Gate-19 `lcap-p2p`
// binding apps/api carries (a server-side value import a browser-safe package cannot host
// itself). The verifier is a PURE function; the rendezvous service stays free of this import.

import {
  issuerKeyFromBytes,
  pseudonymFromBytes,
  rendezvousContext,
  verifyRendezvousPresence,
} from '@licio/private-p2p/rendezvous-cap';
import type { PresenceVerifier } from './service.js';

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
/** Decode a base64url string to bytes (no padding). */
function b64urlToBytes(s: string): Uint8Array {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/');
  return Uint8Array.from(Buffer.from(b64, 'base64'));
}

/**
 * The production Tier-2 presence verifier: reconstructs the per-`(room, epoch, bucket)`
 * context server-side (binding the proof to the server's OWN `room_blind_id`, so a
 * pseudonym cannot be replayed across rooms) and checks the BBS pseudonym-bound proof
 * against the pinned per-epoch issuer key. Any malformed input ⇒ `false` (fail-closed on
 * THIS record; the service then rejects it, and the client may retry without a proof to
 * ride Tier-1).
 */
export function createPresenceVerifier(): PresenceVerifier {
  return (ctx) => {
    try {
      const issuerPk = issuerKeyFromBytes(b64urlToBytes(ctx.issuerPubKey));
      const pseudonym = pseudonymFromBytes(b64urlToBytes(ctx.nym));
      const proof = b64urlToBytes(ctx.proof);
      const epochBytes = enc(ctx.epoch);
      // The server derives the context from ITS room_blind_id (cross-room replay defence).
      const context = rendezvousContext(enc(ctx.roomBlindId), epochBytes, ctx.bucket);
      return verifyRendezvousPresence(issuerPk, proof, pseudonym, epochBytes, context);
    } catch {
      return false;
    }
  };
}

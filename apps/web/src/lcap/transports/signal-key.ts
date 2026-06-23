// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Signaling-key provisioning for the PUBLIC LCAP WebRTC transport (OFFLINE_SPEC §16.3,
// §19.1, §26.4, WS-R.15.6).
//
// The WebRTC rendezvous server is a DUMB relay: it forwards an AES-256-GCM-sealed
// envelope between two opaque peer keys and parses no SDP/ICE/peer-IP (§19.1).  That
// seal needs a key BOTH peers hold.  For PRIVATE (WS-S) content the key comes from the
// private plane's own MLS-derived key schedule and is NEVER derivable from public data.
//
// For PUBLIC LCAP content there is no such secret — and there does not need to be.  The
// signaling encryption's ONLY job for public content is to keep SDP/ICE out of the
// rendezvous server's view; the content's integrity and authenticity come from LCAP's
// content-addressing (every block is a CID) + COSE_Sign1 signatures on the records, NOT
// from signaling secrecy.  So the public signaling key is DERIVED DETERMINISTICALLY from
// the public `room_id_hash` via HKDF-SHA-256 over a fixed, domain-separated label:
//
//     signal_key = HKDF-SHA-256(ikm = room_id_hash,
//                               salt = "" /* none — room_id_hash is the domain input */,
//                               info = "lcap:p2p:signal-key:public:v1",
//                               L = 32 bytes)
//
// Any participant who can compute the room's public `room_id_hash` (i.e. anyone who knows
// the public room) can independently derive the SAME 32-byte key and join the rendezvous.
// This is INTENTIONAL: it lets arbitrary public peers establish a channel without a prior
// secret exchange.  Because public content carries no confidentiality expectation, an
// observer learning the key buys nothing — they could already read the public content via
// the HTTPS anchor.  The seal still hides SDP/ICE from the rendezvous server, the AAD
// still binds an envelope to (room, from, to) so a captured blob cannot be replayed into
// another room/peer, and the live datachannel still carries content the receiver
// re-validates against its CIDs/signatures (storage/transport confers no trust, §8.3).
//
// HARD INVARIANT: this derivation is for the PUBLIC plane only.  A private (WS-S) room
// MUST NOT route its signaling through a key derived here — that plane owns its own keyed
// channel.  The runtime consumer (`sync-over-p2p.ts`) only ever calls this for a public
// `room_id_hash`; the WS-S engine never imports it.

/** The HKDF info string domain-separating the public signaling key from any other use. */
const PUBLIC_SIGNAL_KEY_INFO = 'lcap:p2p:signal-key:public:v1';

/** Adapt a `Uint8Array` to the `ArrayBuffer`-backed view WebCrypto's `BufferSource` wants. */
function bufferSource(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  return bytes.buffer instanceof ArrayBuffer
    ? (bytes as Uint8Array<ArrayBuffer>)
    : new Uint8Array(bytes);
}

function subtle(): SubtleCrypto {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (!c || typeof c.subtle?.deriveBits !== 'function') {
    throw new Error('WebCrypto (crypto.subtle) is unavailable');
  }
  return c.subtle;
}

/**
 * Derive the 32-byte deterministic PUBLIC signaling secret from a public `room_id_hash`.
 * Both peers in a public room compute the identical bytes, so either may seed the
 * rendezvous; the seal it keys only obscures SDP/ICE from the relay (see the file header).
 * NEVER call this for private (WS-S) content.
 */
export async function derivePublicSignalKeyBytes(roomIdHash: Uint8Array): Promise<Uint8Array> {
  const s = subtle();
  const ikm = await s.importKey('raw', bufferSource(roomIdHash), 'HKDF', false, ['deriveBits']);
  const bits = await s.deriveBits(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: new Uint8Array(0),
      info: new TextEncoder().encode(PUBLIC_SIGNAL_KEY_INFO),
    },
    ikm,
    32 * 8,
  );
  return new Uint8Array(bits);
}

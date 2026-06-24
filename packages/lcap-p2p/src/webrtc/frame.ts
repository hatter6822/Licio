// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Wire codecs for the server-blind WebRTC rendezvous (OFFLINE_SPEC §16.3, §19.1,
// WS-R.15.6a).  Two codecs live here:
//
//   1. The OUTER envelope frame: a `SignalEnvelopeV2` ⇄ bytes mapping.  The server
//      stores/forwards the envelope as an opaque octet-stream body (it parses nothing),
//      so the client serializes the whole envelope — including the AAD-bound routing
//      fields `from`/`to`/`room_id_hash` the recipient re-checks — into one bounded,
//      length-prefixed frame.  Decode is FAIL-CLOSED (any truncation / over-cap / bad
//      version is rejected, never normalized).
//
//   2. The INNER signaling message: the plaintext `{offer|answer|ice}` payload that is
//      AES-256-GCM-sealed INSIDE the envelope (so the server, which only ever sees the
//      ciphertext, learns no SDP/ICE/peer-IP — §19.1).  It is a strict, bounded zod
//      union; a member peer (who holds the key) still cannot feed a malformed message
//      past the decoder.

import { z } from 'zod';
import { type SignalEnvelopeV2, signalEnvelopeV2Schema } from './signaling.js';

// --- bounds (§27 DoS; the server mailbox already caps a blob at 32 KiB) -------------
const MAX_ROOM_ID_HASH = 64;
const MAX_PEER_KEY = 256;
const MAX_NONCE = 16;
const MAX_CIPHERTEXT = 32 * 1024;
/** SDP offers/answers are a few KB; cap generously but bounded. */
const MAX_SDP = 32 * 1024;
const MAX_ICE_CANDIDATE = 4 * 1024;
const MAX_SDP_MID = 256;

// --- inner signaling message --------------------------------------------------------

export const webrtcSignalMessageSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('offer'), sdp: z.string().min(1).max(MAX_SDP) }).strict(),
  z.object({ kind: z.literal('answer'), sdp: z.string().min(1).max(MAX_SDP) }).strict(),
  z
    .object({
      kind: z.literal('ice'),
      candidate: z.string().max(MAX_ICE_CANDIDATE),
      sdp_mid: z.string().max(MAX_SDP_MID).nullable(),
      sdp_m_line_index: z.number().int().nonnegative().max(1024).nullable(),
    })
    .strict(),
]);

export type WebrtcSignalMessage = z.infer<typeof webrtcSignalMessageSchema>;

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder('utf-8', { fatal: true });

/** Serialize an inner signaling message to the plaintext bytes that get sealed. */
export function encodeSignalMessage(message: WebrtcSignalMessage): Uint8Array {
  return textEncoder.encode(JSON.stringify(webrtcSignalMessageSchema.parse(message)));
}

/** Parse a decrypted inner signaling message; throws (fail-closed) on anything malformed. */
export function decodeSignalMessage(bytes: Uint8Array): WebrtcSignalMessage {
  const json: unknown = JSON.parse(textDecoder.decode(bytes));
  return webrtcSignalMessageSchema.parse(json);
}

// --- outer envelope frame -----------------------------------------------------------

class FrameError extends Error {
  override readonly name = 'FrameError';
}

/**
 * Encode a `SignalEnvelopeV2` as a self-describing, length-prefixed binary frame:
 *   version(1) ‖ u16 len ‖ room_id_hash ‖ u16 len ‖ from ‖ u16 len ‖ to
 *           ‖ u8 len ‖ nonce ‖ u32 len ‖ ciphertext
 * All lengths are big-endian.  The fields are bounded so a hostile/garbage frame can
 * never drive an unbounded allocation on decode.
 */
export function encodeSignalEnvelope(env: SignalEnvelopeV2): Uint8Array {
  const from = textEncoder.encode(env.from);
  const to = textEncoder.encode(env.to);
  if (env.room_id_hash.length > MAX_ROOM_ID_HASH) throw new FrameError('room_id_hash too long');
  if (from.length > MAX_PEER_KEY || to.length > MAX_PEER_KEY)
    throw new FrameError('peer key too long');
  if (env.nonce.length > MAX_NONCE) throw new FrameError('nonce too long');
  if (env.ciphertext.length > MAX_CIPHERTEXT) throw new FrameError('ciphertext too long');
  const total =
    1 +
    2 +
    env.room_id_hash.length +
    2 +
    from.length +
    2 +
    to.length +
    1 +
    env.nonce.length +
    4 +
    env.ciphertext.length;
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  let o = 0;
  out[o++] = 2; // version
  view.setUint16(o, env.room_id_hash.length, false);
  o += 2;
  out.set(env.room_id_hash, o);
  o += env.room_id_hash.length;
  view.setUint16(o, from.length, false);
  o += 2;
  out.set(from, o);
  o += from.length;
  view.setUint16(o, to.length, false);
  o += 2;
  out.set(to, o);
  o += to.length;
  out[o++] = env.nonce.length;
  out.set(env.nonce, o);
  o += env.nonce.length;
  view.setUint32(o, env.ciphertext.length, false);
  o += 4;
  out.set(env.ciphertext, o);
  return out;
}

/** Decode an envelope frame fail-closed, then validate it against the strict schema. */
export function decodeSignalEnvelope(bytes: Uint8Array): SignalEnvelopeV2 {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let o = 0;
  const u8 = (): number => {
    if (o + 1 > bytes.length) throw new FrameError('truncated frame');
    return bytes[o++] as number;
  };
  const u16 = (): number => {
    if (o + 2 > bytes.length) throw new FrameError('truncated frame');
    const v = view.getUint16(o, false);
    o += 2;
    return v;
  };
  const u32 = (): number => {
    if (o + 4 > bytes.length) throw new FrameError('truncated frame');
    const v = view.getUint32(o, false);
    o += 4;
    return v;
  };
  const take = (n: number, cap: number, what: string): Uint8Array => {
    if (n > cap) throw new FrameError(`${what} over cap`);
    if (o + n > bytes.length) throw new FrameError('truncated frame');
    const slice = bytes.subarray(o, o + n);
    o += n;
    return slice;
  };
  if (u8() !== 2) throw new FrameError('unsupported envelope version');
  const roomIdHash = take(u16(), MAX_ROOM_ID_HASH, 'room_id_hash').slice();
  const from = textDecoder.decode(take(u16(), MAX_PEER_KEY, 'from'));
  const to = textDecoder.decode(take(u16(), MAX_PEER_KEY, 'to'));
  const nonce = take(u8(), MAX_NONCE, 'nonce').slice();
  const ciphertext = take(u32(), MAX_CIPHERTEXT, 'ciphertext').slice();
  if (o !== bytes.length) throw new FrameError('trailing bytes');
  return signalEnvelopeV2Schema.parse({
    v: 2,
    room_id_hash: roomIdHash,
    to,
    from,
    nonce,
    ciphertext,
  });
}

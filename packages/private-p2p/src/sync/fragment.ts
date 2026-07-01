// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-S.4.3 (carrier) — datachannel message fragmentation for the private-room WebRTC
// carrier (PRIVATE_SPEC §15.6/§15.7).  An SCTP datachannel message has a finite,
// browser-dependent size limit; the conservative cross-browser-safe size is 16 KiB.  A
// private §15.7 sync message (an `op_response` / `block_response` full of §13.6 media
// chunks, or a §14.5 `snapshot_response` archive) can be far larger than that, so the
// carrier splits an outbound (already AEAD-SEALED) message into ≤ `FRAGMENT_PAYLOAD_BYTES`
// fragments here, each self-describing, and the receiver reassembles the EXACT original
// ciphertext before it is AEAD-opened.  Without this the carrier could send only whole
// messages ≤ the SCTP limit, so the media / snapshot exchange silently stalled for any
// realistic size (the crown-jewel bug PRIV-SYNC-FRAGMENT closes).
//
// This is the private-plane analogue of `@licio/lcap-p2p`'s WebRTC fragmenter (the two
// decentralization planes never share code), and it is DELIBERATELY IDENTICAL in shape so
// the proven fail-closed properties carry over.  A fragment header binds it to ITS message:
//
//   version(1) ‖ u32 message_id ‖ u32 fragment_seq ‖ u32 fragment_total
//             ‖ u32 message_total_len ‖ payload
//
// All integers are big-endian.  The framing is bounded and fail-closed: a bad version,
// truncated header, over-cap payload, out-of-order seq, a fragment disagreeing with the
// in-flight message, an over-cap declared length, or a reassembly that does not EXACTLY
// equal the declared length all THROW (a protocol-error DoS bound) rather than silently
// mis-stitching bytes.  The fragment framing is PLAINTEXT over the sealed ciphertext — the
// AEAD open after reassembly is the confidentiality/integrity boundary; a relay that
// tampers with the framing only makes reassembly (or the subsequent open) fail closed.

/** The conservative cross-browser-safe SCTP message size (the per-fragment payload). */
export const PRIVATE_FRAGMENT_PAYLOAD_BYTES = 16 * 1024;

/** The fixed fragment-header length: version(1) + 4×u32. */
export const PRIVATE_FRAGMENT_HEADER_BYTES = 1 + 4 * 4;

const PRIVATE_FRAGMENT_VERSION = 1;

/**
 * The absolute ceiling on a single reassembled (sealed) message — the §27 DoS bound on the memory
 * ONE inbound sync message may pin before it is AEAD-opened + decoded.  Chosen to match the private
 * sync-message decode budget (16 MiB), so any message that fits `decodeSyncMessage` also fits here.
 */
export const PRIVATE_MAX_REASSEMBLY_BYTES = 16 * 1024 * 1024;

/** The maximum fragment count an inbound message may declare (derived from the caps). */
const PRIVATE_MAX_FRAGMENT_TOTAL =
  Math.ceil(PRIVATE_MAX_REASSEMBLY_BYTES / PRIVATE_FRAGMENT_PAYLOAD_BYTES) + 1;

/** A malformed/oversized fragment or reassembly; the carrier treats it as fatal for that message. */
export class PrivateFragmentError extends Error {
  override readonly name = 'PrivateFragmentError';
}

/**
 * Split `message` (an AEAD-sealed sync frame) into ordered, self-describing datachannel fragments,
 * each ≤ `PRIVATE_FRAGMENT_HEADER_BYTES + PRIVATE_FRAGMENT_PAYLOAD_BYTES`.  `messageId` distinguishes
 * consecutive messages on the same channel (a monotonically increasing per-send id).  A zero-length
 * message still emits exactly ONE fragment (so the receiver always gets a complete-message signal).
 */
export function fragmentPrivateMessage(message: Uint8Array, messageId: number): Uint8Array[] {
  if (message.length > PRIVATE_MAX_REASSEMBLY_BYTES) {
    throw new PrivateFragmentError(
      `message of ${message.length} bytes exceeds the ${PRIVATE_MAX_REASSEMBLY_BYTES}-byte send cap`,
    );
  }
  const total = Math.max(1, Math.ceil(message.length / PRIVATE_FRAGMENT_PAYLOAD_BYTES));
  const fragments: Uint8Array[] = [];
  for (let seq = 0; seq < total; seq++) {
    const start = seq * PRIVATE_FRAGMENT_PAYLOAD_BYTES;
    const end = Math.min(start + PRIVATE_FRAGMENT_PAYLOAD_BYTES, message.length);
    const payload = message.subarray(start, end);
    const frame = new Uint8Array(PRIVATE_FRAGMENT_HEADER_BYTES + payload.length);
    const view = new DataView(frame.buffer);
    let o = 0;
    frame[o] = PRIVATE_FRAGMENT_VERSION;
    o += 1;
    view.setUint32(o, messageId, false);
    o += 4;
    view.setUint32(o, seq, false);
    o += 4;
    view.setUint32(o, total, false);
    o += 4;
    view.setUint32(o, message.length, false);
    o += 4;
    frame.set(payload, o);
    fragments.push(frame);
  }
  return fragments;
}

interface PrivateFragmentHeader {
  readonly messageId: number;
  readonly seq: number;
  readonly total: number;
  readonly messageLen: number;
  readonly payload: Uint8Array;
}

/** Parse one fragment frame fail-closed (throws {@link PrivateFragmentError} on anything off). */
function parsePrivateFragment(frame: Uint8Array): PrivateFragmentHeader {
  if (frame.length < PRIVATE_FRAGMENT_HEADER_BYTES) {
    throw new PrivateFragmentError('fragment header truncated');
  }
  const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
  let o = 0;
  const version = frame[o] as number;
  o += 1;
  if (version !== PRIVATE_FRAGMENT_VERSION) {
    throw new PrivateFragmentError(`unsupported fragment version ${version}`);
  }
  const messageId = view.getUint32(o, false);
  o += 4;
  const seq = view.getUint32(o, false);
  o += 4;
  const total = view.getUint32(o, false);
  o += 4;
  const messageLen = view.getUint32(o, false);
  o += 4;
  const payload = frame.subarray(o);
  if (total < 1 || total > PRIVATE_MAX_FRAGMENT_TOTAL) {
    throw new PrivateFragmentError(`fragment_total ${total} out of bounds`);
  }
  if (seq >= total)
    throw new PrivateFragmentError(`fragment_seq ${seq} >= fragment_total ${total}`);
  if (messageLen > PRIVATE_MAX_REASSEMBLY_BYTES) {
    throw new PrivateFragmentError(`message_total_len ${messageLen} exceeds the reassembly cap`);
  }
  // `fragment_total` MUST be exactly the count `message_total_len` implies: an over-declared total
  // would let a peer hold the reassembler open awaiting fragments that, by the length math, can never
  // complete — bind them so a mismatch fails closed up front.
  if (total !== Math.max(1, Math.ceil(messageLen / PRIVATE_FRAGMENT_PAYLOAD_BYTES))) {
    throw new PrivateFragmentError(
      `fragment_total ${total} disagrees with message_total_len ${messageLen}`,
    );
  }
  if (payload.length > PRIVATE_FRAGMENT_PAYLOAD_BYTES) {
    throw new PrivateFragmentError(
      `fragment payload ${payload.length} exceeds the per-fragment cap`,
    );
  }
  return { messageId, seq, total, messageLen, payload };
}

/**
 * Stateful reassembler for ONE ordered, reliable datachannel.  Feed each inbound frame to `accept`;
 * it returns the completed (sealed) message bytes once the final fragment of a message arrives, or
 * `null` while a message is still in flight.  Any inconsistency (wrong order, a conflicting header
 * for the in-flight message, an over-cap total, or a final length that disagrees with the declared
 * `message_total_len`) throws {@link PrivateFragmentError} — a hostile peer cannot mis-stitch a
 * partial message (the reassembled bytes are then AEAD-opened, the real trust boundary).
 */
export class PrivateFragmentReassembler {
  private messageId: number | null = null;
  private total = 0;
  private messageLen = 0;
  private nextSeq = 0;
  private received = 0;
  private chunks: Uint8Array[] = [];

  private reset(): void {
    this.messageId = null;
    this.total = 0;
    this.messageLen = 0;
    this.nextSeq = 0;
    this.received = 0;
    this.chunks = [];
  }

  /** Accept one inbound fragment; returns the assembled message when complete, else null. */
  accept(frame: Uint8Array): Uint8Array | null {
    const header = parsePrivateFragment(frame);

    if (this.messageId === null) {
      // The first fragment of a new message MUST be seq 0.
      if (header.seq !== 0) {
        throw new PrivateFragmentError(
          `first fragment of a message has seq ${header.seq}, expected 0`,
        );
      }
      this.messageId = header.messageId;
      this.total = header.total;
      this.messageLen = header.messageLen;
      this.nextSeq = 0;
    } else if (
      header.messageId !== this.messageId ||
      header.total !== this.total ||
      header.messageLen !== this.messageLen
    ) {
      // A continuation fragment MUST match the in-flight message exactly.
      this.reset();
      throw new PrivateFragmentError('fragment does not match the in-flight message');
    }

    if (header.seq !== this.nextSeq) {
      this.reset();
      throw new PrivateFragmentError(
        `out-of-order fragment seq ${header.seq}, expected ${this.nextSeq}`,
      );
    }

    this.received += header.payload.length;
    if (this.received > this.messageLen) {
      this.reset();
      throw new PrivateFragmentError('reassembled bytes exceed the declared message length');
    }
    this.chunks.push(header.payload.slice());
    this.nextSeq += 1;

    if (this.nextSeq < this.total) return null; // more fragments expected

    // Final fragment: the reassembly must EXACTLY equal the declared length.
    if (this.received !== this.messageLen) {
      this.reset();
      throw new PrivateFragmentError(
        `reassembled ${this.received} bytes != declared ${this.messageLen}`,
      );
    }
    const out = new Uint8Array(this.messageLen);
    let o = 0;
    for (const chunk of this.chunks) {
      out.set(chunk, o);
      o += chunk.length;
    }
    this.reset();
    return out;
  }
}

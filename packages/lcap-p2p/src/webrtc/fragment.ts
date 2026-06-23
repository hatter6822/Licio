// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Datachannel message fragmentation for the WebRTC transport (OFFLINE_SPEC §22.6,
// WS-R.15.6).  An SCTP datachannel message has a finite size limit that varies by
// browser (Chrome historically ~256 KiB, but the cross-browser *interoperable* safe
// size is far smaller — 16 KiB is the conservative limit recommended for portable
// data channels).  An LCAP `§16` exchange pack can be far larger than that, so an
// outbound message is split into ≤ `FRAGMENT_PAYLOAD_BYTES`-payload fragments here, each
// self-describing, and the receiver reassembles the EXACT original bytes.
//
// Every fragment carries a header binding it to ITS message:
//
//   version(1) ‖ u32 message_id ‖ u32 fragment_seq ‖ u32 fragment_total
//             ‖ u32 message_total_len ‖ payload
//
// All integers are big-endian.  The framing is bounded and fail-closed:
//   * a fragment with a bad version / truncated header / payload longer than the cap is
//     rejected;
//   * the receiver tracks ONE in-flight message at a time on a single ordered datachannel
//     (datachannels are reliable + ordered by default), keyed by `message_id`; a fragment
//     whose `fragment_total`/`message_total_len` disagrees with the in-flight message, or
//     whose `fragment_seq` arrives out of order, aborts the reassembly (a protocol-error
//     DoS bound) rather than silently mis-stitching bytes;
//   * the declared `message_total_len` is checked against an absolute cap BEFORE any
//     buffer is grown, so a hostile header can never drive an unbounded allocation;
//   * the reassembled length must EXACTLY equal the declared `message_total_len`, and the
//     declared total must equal `fragment_total * payload` accounting — a truncated or
//     over-long reassembly fails closed.

/** The conservative cross-browser safe SCTP message size (the per-fragment payload). */
export const FRAGMENT_PAYLOAD_BYTES = 16 * 1024;

/** The fixed fragment-header length: version(1) + 4×u32. */
export const FRAGMENT_HEADER_BYTES = 1 + 4 * 4;

const FRAGMENT_VERSION = 1;

/**
 * The absolute ceiling on a single reassembled message — the §27 DoS bound that caps the
 * memory ONE inbound exchange may pin before it is handed to the validator.  Matches the
 * transport's advertised `maxExchangeBytes` (16 MiB).
 */
export const MAX_REASSEMBLY_BYTES = 16 * 1024 * 1024;

/** The maximum fragment count an inbound message may declare (derived from the caps). */
const MAX_FRAGMENT_TOTAL = Math.ceil(MAX_REASSEMBLY_BYTES / FRAGMENT_PAYLOAD_BYTES) + 1;

/** A malformed/oversized fragment or reassembly; the transport treats it as fatal. */
export class FragmentError extends Error {
  override readonly name = 'FragmentError';
}

/**
 * Split `message` into ordered, self-describing datachannel fragments, each ≤
 * `FRAGMENT_HEADER_BYTES + FRAGMENT_PAYLOAD_BYTES`.  `messageId` distinguishes
 * consecutive messages on the same channel (a monotonically increasing per-send id).  A
 * zero-length message still emits exactly ONE fragment (so the receiver always gets a
 * complete-message signal).
 */
export function fragmentMessage(message: Uint8Array, messageId: number): Uint8Array[] {
  if (message.length > MAX_REASSEMBLY_BYTES) {
    throw new FragmentError(
      `message of ${message.length} bytes exceeds the ${MAX_REASSEMBLY_BYTES}-byte send cap`,
    );
  }
  const total = Math.max(1, Math.ceil(message.length / FRAGMENT_PAYLOAD_BYTES));
  const fragments: Uint8Array[] = [];
  for (let seq = 0; seq < total; seq++) {
    const start = seq * FRAGMENT_PAYLOAD_BYTES;
    const end = Math.min(start + FRAGMENT_PAYLOAD_BYTES, message.length);
    const payload = message.subarray(start, end);
    const frame = new Uint8Array(FRAGMENT_HEADER_BYTES + payload.length);
    const view = new DataView(frame.buffer);
    let o = 0;
    frame[o] = FRAGMENT_VERSION;
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

interface FragmentHeader {
  readonly messageId: number;
  readonly seq: number;
  readonly total: number;
  readonly messageLen: number;
  readonly payload: Uint8Array;
}

/** Parse one fragment frame fail-closed (throws {@link FragmentError} on anything off). */
function parseFragment(frame: Uint8Array): FragmentHeader {
  if (frame.length < FRAGMENT_HEADER_BYTES) throw new FragmentError('fragment header truncated');
  const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
  let o = 0;
  const version = frame[o] as number;
  o += 1;
  if (version !== FRAGMENT_VERSION)
    throw new FragmentError(`unsupported fragment version ${version}`);
  const messageId = view.getUint32(o, false);
  o += 4;
  const seq = view.getUint32(o, false);
  o += 4;
  const total = view.getUint32(o, false);
  o += 4;
  const messageLen = view.getUint32(o, false);
  o += 4;
  const payload = frame.subarray(o);
  if (total < 1 || total > MAX_FRAGMENT_TOTAL) {
    throw new FragmentError(`fragment_total ${total} out of bounds`);
  }
  if (seq >= total) throw new FragmentError(`fragment_seq ${seq} >= fragment_total ${total}`);
  if (messageLen > MAX_REASSEMBLY_BYTES) {
    throw new FragmentError(`message_total_len ${messageLen} exceeds the reassembly cap`);
  }
  if (payload.length > FRAGMENT_PAYLOAD_BYTES) {
    throw new FragmentError(`fragment payload ${payload.length} exceeds the per-fragment cap`);
  }
  return { messageId, seq, total, messageLen, payload };
}

/**
 * Stateful reassembler for ONE ordered, reliable datachannel.  Feed each inbound frame to
 * `accept`; it returns the completed message bytes once the final fragment of a message
 * arrives, or `null` while a message is still in flight.  Any inconsistency (wrong order,
 * a conflicting header for the in-flight message, an over-cap total, or a final length
 * that disagrees with the declared `message_total_len`) throws {@link FragmentError} — the
 * transport surfaces that as fatal (a hostile peer cannot mis-stitch a partial message).
 */
export class FragmentReassembler {
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
    const header = parseFragment(frame);

    if (this.messageId === null) {
      // The first fragment of a new message MUST be seq 0.
      if (header.seq !== 0) {
        throw new FragmentError(`first fragment of a message has seq ${header.seq}, expected 0`);
      }
      this.messageId = header.messageId;
      this.total = header.total;
      this.messageLen = header.messageLen;
      this.nextSeq = 0;
    } else {
      // A continuation fragment MUST match the in-flight message exactly.
      if (
        header.messageId !== this.messageId ||
        header.total !== this.total ||
        header.messageLen !== this.messageLen
      ) {
        this.reset();
        throw new FragmentError('fragment does not match the in-flight message');
      }
    }

    if (header.seq !== this.nextSeq) {
      this.reset();
      throw new FragmentError(`out-of-order fragment seq ${header.seq}, expected ${this.nextSeq}`);
    }

    this.received += header.payload.length;
    if (this.received > this.messageLen) {
      this.reset();
      throw new FragmentError('reassembled bytes exceed the declared message length');
    }
    this.chunks.push(header.payload.slice());
    this.nextSeq += 1;

    if (this.nextSeq < this.total) return null; // more fragments expected

    // Final fragment: the reassembly must EXACTLY equal the declared length.
    if (this.received !== this.messageLen) {
      this.reset();
      throw new FragmentError(`reassembled ${this.received} bytes != declared ${this.messageLen}`);
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

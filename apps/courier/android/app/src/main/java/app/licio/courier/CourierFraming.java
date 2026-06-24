// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-R.15.4 — the PURE, transport-independent courier framing.  The length-prefixed frame
// protocol and the MTU chunk-sizing shared by every radio transport (Bluetooth RFCOMM, BLE
// GATT, Wi-Fi Direct), with NO Android / radio / Capacitor / root dependency — so it is
// fully unit-testable on a plain JVM (`./gradlew :app:testDebugUnitTest`), with no emulator
// and no privileged radio setup.
//
// This is the "humble object" split (GOOS): all the logic that USED to live inside the
// native radio plugins (where it forced a real radio to test) lives here as pure code; the
// native plugins become thin pipes that only move the bytes this produces over their radio.
//
// Wire format (identical across all stream/chunked transports): a frame is a 4-byte
// big-endian length prefix followed by exactly that many payload bytes.  `framePrefixed`
// is byte-identical to `DataOutputStream.writeInt(len) + write(payload)`, so swapping a
// plugin's inline framing for this changes no bytes on the wire.

package app.licio.courier;

import java.io.DataInputStream;
import java.io.EOFException;
import java.io.IOException;
import java.io.InputStream;
import java.util.Arrays;
import java.util.function.BooleanSupplier;

public final class CourierFraming {

    private CourierFraming() {}

    /** §22.5 bounded frame — a declared length beyond this is rejected fail-closed. */
    public static final int MAX_FRAME_BYTES = 64 * 1024 * 1024;

    /** The default ATT MTU before negotiation (BLE). */
    public static final int DEFAULT_ATT_MTU = 23;

    /** A single GATT attribute value is capped at 512 bytes regardless of a larger MTU. */
    public static final int MAX_ATTR_VALUE = 512;

    /** The 4-byte length prefix overhead. */
    public static final int LENGTH_PREFIX_BYTES = 4;

    /**
     * Prefix a payload with its 4-byte big-endian length — the on-wire frame.  Byte-identical
     * to `DataOutputStream.writeInt(payload.length)` followed by `write(payload)`.
     */
    public static byte[] framePrefixed(byte[] payload) {
        byte[] out = new byte[LENGTH_PREFIX_BYTES + payload.length];
        out[0] = (byte) (payload.length >>> 24);
        out[1] = (byte) (payload.length >>> 16);
        out[2] = (byte) (payload.length >>> 8);
        out[3] = (byte) payload.length;
        System.arraycopy(payload, 0, out, LENGTH_PREFIX_BYTES, payload.length);
        return out;
    }

    /**
     * The per-write BLE chunk size for a negotiated MTU: the ATT write overhead is 3 bytes,
     * and a single attribute value never exceeds 512 bytes regardless of a larger MTU.  A
     * sub-minimal MTU is floored at 20 (the pre-negotiation usable payload).
     */
    public static int chunkSize(int mtu) {
        return Math.min(MAX_ATTR_VALUE, Math.max(20, mtu - 3));
    }

    /** Sink for a complete reassembled frame (one call per length-prefixed unit). */
    public interface FrameSink {
        void onFrame(byte[] frame);
    }

    /**
     * Read length-prefixed frames from a BLOCKING byte stream (the RFCOMM / Wi-Fi-Direct socket
     * read path) until {@code shouldContinue} goes false, the stream cleanly ends, or a frame
     * declares an out-of-range length (fail-closed, bounded by {@link #MAX_FRAME_BYTES}); a
     * truncated frame mid-read raises {@link IOException} (the caller treats that as a drop).
     * Pure over an {@link InputStream}, so it is unit-testable with a `ByteArrayInputStream` —
     * no socket, no thread.  Mirrors the chunk-based {@link FrameAssembler} for the same wire
     * protocol.
     */
    public static void readFramedStream(InputStream input, FrameSink sink,
            BooleanSupplier shouldContinue) throws IOException {
        DataInputStream in =
                input instanceof DataInputStream ? (DataInputStream) input : new DataInputStream(input);
        while (shouldContinue.getAsBoolean()) {
            int len;
            try {
                len = in.readInt();
            } catch (EOFException endOfStream) {
                return; // a clean end between frames — not an error
            }
            if (len < 0 || len > MAX_FRAME_BYTES) return; // fail-closed bounded frame
            byte[] bytes = new byte[len];
            in.readFully(bytes); // a partial frame raises EOFException → propagates as a drop
            sink.onFrame(bytes);
        }
    }

    /** A transport I/O failure raised by the pure send state machine (radio-agnostic). */
    public static final class CourierIoException extends Exception {
        public CourierIoException(String message) {
            super(message);
        }
    }

    /**
     * The injected I/O for {@link #sendChunked}: write one chunk over the radio, then block
     * for its delivery ack.  Both may fail (a write rejection, an ack timeout, a non-success
     * ack status) — the implementation raises {@link CourierIoException}; the loop in
     * {@code sendChunked} is otherwise pure and testable with a fake sender (no radio/root).
     */
    public interface ChunkSender {
        /** A successful per-chunk ack status (== BluetoothGatt.GATT_SUCCESS). */
        int ACK_OK = 0;

        /** Transmit one chunk; raise on an immediate write failure. */
        void sendChunk(byte[] chunk) throws CourierIoException;

        /** Block for THIS chunk's delivery ack; raise on timeout; return the ack status. */
        int awaitAck() throws CourierIoException;
    }

    /**
     * Send one length-prefixed frame as serialized, ack-gated chunks of at most {@code
     * chunkSize} bytes — split the framed payload, send each chunk, wait for its ack before
     * the next (so a large pack never overruns the controller's queue), and fail closed on a
     * write failure, an ack timeout, or a non-success ack.  This is PURE control flow; the
     * radio write + the ack wait are the injected {@link ChunkSender}, so the loop is fully
     * unit-testable on the JVM with a fake sender (no radio, no root).
     */
    public static void sendChunked(byte[] payload, int chunkSize, ChunkSender sender)
            throws CourierIoException {
        if (chunkSize <= 0) throw new CourierIoException("non_positive_chunk_size");
        byte[] framed = framePrefixed(payload);
        for (int off = 0; off < framed.length; off += chunkSize) {
            byte[] chunk = Arrays.copyOfRange(framed, off, Math.min(off + chunkSize, framed.length));
            sender.sendChunk(chunk);
            int ack = sender.awaitAck();
            if (ack != ChunkSender.ACK_OK) throw new CourierIoException("ack_status_" + ack);
        }
    }

    /**
     * Reassembles the length-prefixed frame stream delivered as a sequence of ARBITRARY-sized
     * chunks (BLE characteristic writes/notifications, or stream reads), emitting one frame per
     * complete length-prefixed unit — regardless of how the chunk boundaries fall relative to
     * the frame boundaries.  Fail-closed: an out-of-range declared length (negative or beyond
     * {@link #MAX_FRAME_BYTES}) resets the buffer and drops the rest of the chunk, so a hostile
     * peer cannot make the reassembler allocate or block unboundedly.  Single-threaded per
     * instance (callers serialize `feed`).
     */
    public static final class FrameAssembler {
        // A growable accumulation buffer with a live length; `buf[0..len)` are the unconsumed
        // bytes.  Appends grow by doubling (amortized O(1)) and we compact ONLY when a frame is
        // consumed — so trickling one large frame in tiny chunks is O(n) total, not O(n²) (the
        // previous `toByteArray()`-every-feed copied the whole accumulation per chunk).
        private static final int INITIAL_CAP = 512;
        private static final int SHRINK_THRESHOLD = 64 * 1024;
        private byte[] buf = new byte[INITIAL_CAP];
        private int len;

        public void feed(byte[] chunk, FrameSink sink) {
            ensureCapacity(len + chunk.length);
            System.arraycopy(chunk, 0, buf, len, chunk.length);
            len += chunk.length;

            int off = 0;
            while (len - off >= LENGTH_PREFIX_BYTES) {
                int frameLen = ((buf[off] & 0xFF) << 24) | ((buf[off + 1] & 0xFF) << 16)
                        | ((buf[off + 2] & 0xFF) << 8) | (buf[off + 3] & 0xFF);
                if (frameLen < 0 || frameLen > MAX_FRAME_BYTES) {
                    len = 0; // fail-closed: bounded frame, drop the corrupt stream
                    shrinkIfLarge();
                    return;
                }
                if (len - off - LENGTH_PREFIX_BYTES < frameLen) break; // frame incomplete
                sink.onFrame(Arrays.copyOfRange(buf, off + LENGTH_PREFIX_BYTES,
                        off + LENGTH_PREFIX_BYTES + frameLen));
                off += LENGTH_PREFIX_BYTES + frameLen;
            }
            if (off > 0) { // compact: drop the consumed prefix [0, off)
                System.arraycopy(buf, off, buf, 0, len - off);
                len -= off;
                shrinkIfLarge();
            }
        }

        private void ensureCapacity(int needed) {
            if (buf.length < needed) {
                buf = Arrays.copyOf(buf, Math.max(needed, buf.length * 2));
            }
        }

        /** Release a large accumulation once it has drained, so a one-off big frame doesn't
         *  pin its buffer for the connection's lifetime. */
        private void shrinkIfLarge() {
            if (len < buf.length / 4 && buf.length > SHRINK_THRESHOLD) {
                byte[] smaller = new byte[Math.max(INITIAL_CAP, len * 2)];
                System.arraycopy(buf, 0, smaller, 0, len);
                buf = smaller;
            }
        }
    }
}

// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-R.15.4 — the BLE outbound send engine: a PURE, callback-driven chunked-send pump, the
// symmetric counterpart of `CourierFraming.FrameAssembler` (inbound reassembly).
//
// BLE GATT is inherently asynchronous and allows exactly ONE outstanding operation per
// connection: a write must wait for its completion callback (`onCharacteristicWrite` /
// `onNotificationSent`) before the next write is issued, or the second write is silently
// dropped.  This pump expresses that natively — `enqueue` writes the first chunk, `onAck`
// advances to the next chunk (or the next queued send), `onTimeout` fails a stalled write, and
// `failAll` aborts everything when the endpoint drops — with NO worker thread, NO blocking
// queue, and NO blocking poll (the previous design forced this async API into a blocking loop
// on a background thread, which leaked a thread, paid a 30s blocking timeout, and could not be
// unit-tested without a cross-thread rendezvous).
//
// It is PURE (no Android, no threads): the GATT write is the injected `ChunkWriter`, the ack
// timeout is the injected `Timeout` (the radio wires a scheduler; tests pass none), and the
// result is the injected `Completion`.  So the entire send state machine — serialization,
// chunk advance, write-rejection, timeout, disconnect — is unit-tested on a plain JVM by
// driving `onAck`/`onTimeout`/`failAll` directly, deterministically, with no radio/root.

package app.licio.courier;

import java.util.ArrayDeque;
import java.util.Arrays;
import java.util.Deque;

public final class BleSendPump {

    /** Writes one chunk over the radio; returns false if the write was REJECTED synchronously
     *  (no completion callback will follow — the pump fails the in-flight send at once). */
    public interface ChunkWriter {
        boolean write(byte[] chunk);
    }

    /** Reports a queued send's terminal outcome exactly once (ok, or failed with a reason). */
    public interface Completion {
        void onResult(boolean ok, String reason);
    }

    /** The per-write ack timeout (the radio backs this with a scheduler; pure tests pass
     *  {@code null} → no timeout, and drive {@link #onTimeout()} explicitly).  {@link #arm()}
     *  RE-ARMS — it cancels any pending timeout before scheduling a fresh one — so a multi-chunk
     *  send never leaves a stale timeout from the previous chunk pending. */
    public interface Timeout {
        void arm();

        void cancel();
    }

    private static final Timeout NO_TIMEOUT = new Timeout() {
        @Override
        public void arm() {}

        @Override
        public void cancel() {}
    };

    private final int chunkSize;
    private final ChunkWriter writer;
    private final Timeout timeout;
    private final Deque<Pending> queue = new ArrayDeque<>();

    // The in-flight send (null ⇒ idle): its framed bytes + how far we have written + its result.
    private byte[] framed;
    private int offset;
    private Completion done;

    public BleSendPump(int chunkSize, ChunkWriter writer, Timeout timeout) {
        if (chunkSize <= 0) throw new IllegalArgumentException("non_positive_chunk_size");
        this.chunkSize = chunkSize;
        this.writer = writer;
        this.timeout = timeout != null ? timeout : NO_TIMEOUT;
    }

    /** Queue one frame for this endpoint; starts it immediately if the pump is idle. */
    public synchronized void enqueue(byte[] payload, Completion completion) {
        queue.add(new Pending(CourierFraming.framePrefixed(payload), completion));
        if (framed == null) {
            startNext();
        }
    }

    /** A write completed with {@code status} (0 == success; non-zero fails the in-flight send). */
    public synchronized void onAck(int status) {
        if (framed == null) {
            return; // a stray/duplicate ack — nothing in flight
        }
        if (status != 0) {
            finish(false, "ack_status_" + status);
            return;
        }
        if (offset >= framed.length) {
            finish(true, null); // the final chunk was acked
            return;
        }
        writeChunk(); // arms a fresh timeout (re-arm cancels the prior chunk's)
    }

    /** The armed ack timeout expired (the write stalled with no completion). */
    public synchronized void onTimeout() {
        if (framed == null) {
            return;
        }
        finish(false, "ble_ack_timeout");
    }

    /** The endpoint dropped: fail the in-flight send AND everything still queued. */
    public synchronized void failAll(String reason) {
        timeout.cancel();
        if (framed != null) {
            Completion d = done;
            framed = null;
            done = null;
            d.onResult(false, reason);
        }
        Pending p;
        while ((p = queue.poll()) != null) {
            p.completion.onResult(false, reason);
        }
    }

    private void startNext() {
        Pending p = queue.poll();
        if (p == null) {
            framed = null;
            done = null;
            return;
        }
        framed = p.framed;
        offset = 0;
        done = p.completion;
        writeChunk();
    }

    private void writeChunk() {
        int end = Math.min(offset + chunkSize, framed.length);
        byte[] chunk = Arrays.copyOfRange(framed, offset, end);
        offset = end;
        if (!writer.write(chunk)) {
            finish(false, "write_rejected");
            return;
        }
        timeout.arm();
    }

    private void finish(boolean ok, String reason) {
        timeout.cancel();
        Completion d = done;
        framed = null;
        done = null;
        // Start the NEXT queued send before reporting this one, so a re-entrant enqueue from the
        // completion just appends (it cannot double-start an already-in-flight send).
        startNext();
        d.onResult(ok, reason);
    }

    private static final class Pending {
        final byte[] framed;
        final Completion completion;

        Pending(byte[] framed, Completion completion) {
            this.framed = framed;
            this.completion = completion;
        }
    }
}

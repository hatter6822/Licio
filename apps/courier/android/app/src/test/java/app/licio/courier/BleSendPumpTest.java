// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Layer-1 (pure JVM) tests of the BLE send engine `BleSendPump` — NO Android, NO threads, NO
// Robolectric.  Because the pump is callback-driven (not a blocking loop on a worker thread),
// its ENTIRE state machine — serialized chunking, ack advance, write-rejection, timeout,
// disconnect-failure, and concurrent-enqueue ordering — is driven deterministically by calling
// onAck/onTimeout/failAll directly, with the GATT write + the timeout injected as fakes.

package app.licio.courier;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertThrows;
import static org.junit.Assert.assertTrue;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.util.ArrayList;
import java.util.List;

import org.junit.Test;

public class BleSendPumpTest {

    /** Records every chunk handed to the radio; can be set to reject a write synchronously. */
    private static final class RecordingWriter implements BleSendPump.ChunkWriter {
        final List<byte[]> chunks = new ArrayList<>();
        boolean acceptWrites = true;

        @Override
        public boolean write(byte[] chunk) {
            if (!acceptWrites) return false;
            chunks.add(chunk.clone());
            return true;
        }
    }

    /** Records arm/cancel + the armed epochs, so we can assert the timeout is armed per write,
     *  cancelled on ack, and fire a SPECIFIC (current or stale) epoch back at the pump. */
    private static final class CountingTimeout implements BleSendPump.Timeout {
        int armed;
        int cancelled;
        long lastEpoch = -1;

        @Override
        public void arm(long epoch) {
            armed++;
            lastEpoch = epoch;
        }

        @Override
        public void cancel() {
            cancelled++;
        }
    }

    private static final class Result {
        Boolean ok;
        String reason;
        int count;

        BleSendPump.Completion sink() {
            return (isOk, why) -> {
                ok = isOk;
                reason = why;
                count++;
            };
        }
    }

    /** Concatenate the recorded chunks back into one byte stream. */
    private static byte[] joined(List<byte[]> chunks) {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        for (byte[] c : chunks) out.write(c, 0, c.length);
        return out.toByteArray();
    }

    /** Drive acks until the pump reports a result (success path), returning the # of writes. */
    private static void ackToCompletion(BleSendPump pump, Result r) {
        int guard = 0;
        while (r.count == 0 && guard++ < 10_000) {
            pump.onAck(0);
        }
    }

    @Test
    public void aSmallPayloadSendsAsOneChunkThenAcksSuccess() {
        RecordingWriter w = new RecordingWriter();
        CountingTimeout t = new CountingTimeout();
        BleSendPump pump = new BleSendPump(512, w, t);
        Result r = new Result();

        byte[] payload = {1, 2, 3};
        pump.enqueue(payload, r.sink()); // writes the single chunk synchronously
        assertEquals("one chunk written on enqueue", 1, w.chunks.size());
        assertEquals("no result yet (ack pending)", 0, r.count);
        assertEquals("timeout armed for the write", 1, t.armed);

        pump.onAck(0);
        assertEquals(Boolean.TRUE, r.ok);
        assertEquals(1, r.count);
        assertTrue("the send's timeout was cancelled on completion", t.cancelled >= 1);
        // The single chunk IS the framed payload (4-byte length prefix + bytes).
        assertArrayEquals(CourierFraming.framePrefixed(payload), w.chunks.get(0));
    }

    @Test
    public void aLargePayloadIsChunkedAndReassemblesExactly() {
        RecordingWriter w = new RecordingWriter();
        BleSendPump pump = new BleSendPump(64, w, null); // chunkSize 64 forces many chunks
        Result r = new Result();

        byte[] payload = new byte[1000];
        for (int i = 0; i < payload.length; i++) payload[i] = (byte) (i * 7);
        pump.enqueue(payload, r.sink());
        ackToCompletion(pump, r);

        assertEquals(Boolean.TRUE, r.ok);
        assertTrue("split into multiple chunks", w.chunks.size() > 1);
        for (byte[] c : w.chunks) assertTrue("each chunk respects the size cap", c.length <= 64);
        // The chunks concatenated equal the framed payload, and parse back to exactly it.
        assertArrayEquals(CourierFraming.framePrefixed(payload), joined(w.chunks));
        List<byte[]> frames = new ArrayList<>();
        try {
            CourierFraming.readFramedStream(new ByteArrayInputStream(joined(w.chunks)),
                    frames::add, () -> true);
        } catch (Exception e) {
            throw new AssertionError(e);
        }
        assertEquals(1, frames.size());
        assertArrayEquals(payload, frames.get(0));
    }

    @Test
    public void anEmptyPayloadStillSendsTheLengthPrefixFrame() {
        RecordingWriter w = new RecordingWriter();
        BleSendPump pump = new BleSendPump(512, w, null);
        Result r = new Result();
        pump.enqueue(new byte[0], r.sink());
        assertEquals(1, w.chunks.size());
        assertArrayEquals(new byte[] {0, 0, 0, 0}, w.chunks.get(0)); // 4-byte zero length prefix
        pump.onAck(0);
        assertEquals(Boolean.TRUE, r.ok);
    }

    @Test
    public void aRejectedWriteFailsTheSendImmediately() {
        RecordingWriter w = new RecordingWriter();
        w.acceptWrites = false;
        CountingTimeout t = new CountingTimeout();
        BleSendPump pump = new BleSendPump(512, w, t);
        Result r = new Result();
        pump.enqueue(new byte[] {1, 2, 3}, r.sink());
        assertEquals(Boolean.FALSE, r.ok);
        assertEquals("write_rejected", r.reason);
        assertEquals("no chunk recorded (write rejected)", 0, w.chunks.size());
        assertEquals("a rejected write never armed a timeout", 0, t.armed);
    }

    @Test
    public void aNonSuccessAckFailsTheSend() {
        RecordingWriter w = new RecordingWriter();
        BleSendPump pump = new BleSendPump(512, w, null);
        Result r = new Result();
        pump.enqueue(new byte[] {1, 2, 3}, r.sink());
        pump.onAck(7); // a non-zero GATT status
        assertEquals(Boolean.FALSE, r.ok);
        assertEquals("ack_status_7", r.reason);
    }

    @Test
    public void aTimeoutFailsTheStalledSend() {
        RecordingWriter w = new RecordingWriter();
        CountingTimeout t = new CountingTimeout();
        BleSendPump pump = new BleSendPump(512, w, t);
        Result r = new Result();
        pump.enqueue(new byte[] {1, 2, 3}, r.sink());
        pump.onTimeout(t.lastEpoch); // the CURRENT chunk's timeout fired
        assertEquals(Boolean.FALSE, r.ok);
        assertEquals("ble_ack_timeout", r.reason);
        // A late ack after the timeout is a no-op (does not double-report).
        pump.onAck(0);
        assertEquals(1, r.count);
    }

    @Test
    public void aStaleTimeoutDoesNotFailAnAdvancedSend() {
        // The race: chunk N's 30s timeout had ALREADY started running when its ack arrived and the
        // pump advanced to chunk N+1 (cancel cannot stop a running task).  The stale timeout's
        // captured epoch ≠ the current one, so it MUST be a no-op — not fail the still-progressing
        // send.  (Without the epoch guard this fails the send spuriously.)
        RecordingWriter w = new RecordingWriter();
        CountingTimeout t = new CountingTimeout();
        BleSendPump pump = new BleSendPump(20, w, t); // 20-byte chunks
        Result r = new Result();

        byte[] payload = new byte[50]; // framed 54 bytes → 3 chunks
        pump.enqueue(payload, r.sink());
        long staleEpoch = t.lastEpoch; // chunk 0's epoch
        pump.onAck(0); // chunk 0 acked → chunk 1 written, the timeout re-armed with a NEW epoch
        assertTrue("the send advanced to a new epoch", t.lastEpoch != staleEpoch);

        // The STALE chunk-0 timeout fires now (it was already running when chunk 1 re-armed):
        pump.onTimeout(staleEpoch);
        assertEquals("a stale timeout does not report a result", 0, r.count);

        // The send completes normally on its remaining acks.
        pump.onAck(0); // chunk 2
        pump.onAck(0); // final
        assertEquals(Boolean.TRUE, r.ok);
        assertEquals(1, r.count);
    }

    @Test
    public void failAllFailsTheInFlightAndQueuedSends() {
        RecordingWriter w = new RecordingWriter();
        BleSendPump pump = new BleSendPump(512, w, null);
        Result a = new Result();
        Result b = new Result();
        pump.enqueue(new byte[] {1}, a.sink()); // in flight
        pump.enqueue(new byte[] {2}, b.sink()); // queued behind a
        pump.failAll("disconnected");
        assertEquals(Boolean.FALSE, a.ok);
        assertEquals("disconnected", a.reason);
        assertEquals(Boolean.FALSE, b.ok);
        assertEquals("disconnected", b.reason);
    }

    @Test
    public void concurrentEnqueuesSerializeWithoutInterleaving() {
        RecordingWriter w = new RecordingWriter();
        BleSendPump pump = new BleSendPump(64, w, null);
        Result a = new Result();
        Result b = new Result();

        byte[] pa = new byte[300];
        java.util.Arrays.fill(pa, (byte) 0xAA);
        byte[] pb = new byte[300];
        java.util.Arrays.fill(pb, (byte) 0xBB);

        pump.enqueue(pa, a.sink()); // starts A (writes A chunk 0)
        pump.enqueue(pb, b.sink()); // B is QUEUED — must not start until A finishes
        int aChunks = w.chunks.size();
        assertEquals("only A's first chunk so far (B is queued)", 1, aChunks);

        // Drive A to completion; the pump then auto-starts B.
        while (a.count == 0) pump.onAck(0);
        assertEquals(Boolean.TRUE, a.ok);
        // Drive B to completion.
        while (b.count == 0) pump.onAck(0);
        assertEquals(Boolean.TRUE, b.ok);

        // The recorded chunks are A's full frame followed by B's full frame — never interleaved.
        byte[] all = joined(w.chunks);
        byte[] framedA = CourierFraming.framePrefixed(pa);
        byte[] framedB = CourierFraming.framePrefixed(pb);
        byte[] expected = new byte[framedA.length + framedB.length];
        System.arraycopy(framedA, 0, expected, 0, framedA.length);
        System.arraycopy(framedB, 0, expected, framedA.length, framedB.length);
        assertArrayEquals("A's frame then B's frame, no interleaving", expected, all);
    }

    @Test
    public void aStrayAckWithNothingInFlightIsIgnored() {
        RecordingWriter w = new RecordingWriter();
        BleSendPump pump = new BleSendPump(512, w, null);
        pump.onAck(0); // nothing enqueued — must be a safe no-op
        assertEquals(0, w.chunks.size());
    }

    @Test
    public void aNonPositiveChunkSizeIsRejected() {
        assertThrows(IllegalArgumentException.class,
                () -> new BleSendPump(0, new RecordingWriter(), null));
    }
}

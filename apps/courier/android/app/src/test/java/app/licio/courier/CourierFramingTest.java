// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Pure-JVM unit tests for the transport-independent courier framing (Layer 1 of the courier
// test pyramid).  These run via `./gradlew :app:testDebugUnitTest` — NO emulator, NO radio,
// NO root — and cover the framing/reassembly logic that previously could only be exercised by
// driving a real radio.  The radio plugins are thin pipes over exactly this logic, so a green
// run here proves the bulk of the courier's correctness without any privileged setup.

package app.licio.courier;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.EOFException;
import java.util.ArrayList;
import java.util.List;
import java.util.Random;
import java.util.concurrent.atomic.AtomicInteger;

import org.junit.Test;

public class CourierFramingTest {

    /** Collects reassembled frames for assertions. */
    private static final class Collector implements CourierFraming.FrameSink {
        final List<byte[]> frames = new ArrayList<>();

        @Override
        public void onFrame(byte[] frame) {
            frames.add(frame);
        }
    }

    // The reference encoder: DataOutputStream.writeInt(len) + write(payload).  framePrefixed
    // MUST be byte-identical (so swapping it into a plugin changes no bytes on the wire).
    private static byte[] referenceFrame(byte[] payload) throws Exception {
        ByteArrayOutputStream bos = new ByteArrayOutputStream();
        java.io.DataOutputStream out = new java.io.DataOutputStream(bos);
        out.writeInt(payload.length);
        out.write(payload);
        out.flush();
        return bos.toByteArray();
    }

    @Test
    public void framePrefixed_isByteIdenticalToWriteIntPlusPayload() throws Exception {
        Random r = new Random(1);
        for (int size : new int[] {0, 1, 4, 255, 256, 8192, 65535, 100_000}) {
            byte[] payload = new byte[size];
            r.nextBytes(payload);
            assertArrayEquals("size=" + size, referenceFrame(payload),
                    CourierFraming.framePrefixed(payload));
        }
    }

    @Test
    public void chunkSize_clampsToAttBounds() {
        assertEquals(20, CourierFraming.chunkSize(23)); // default MTU → 20-byte usable
        assertEquals(20, CourierFraming.chunkSize(10)); // sub-minimal MTU floored at 20
        assertEquals(244, CourierFraming.chunkSize(247)); // common negotiated MTU − 3
        assertEquals(512, CourierFraming.chunkSize(517)); // max MTU capped at the 512 attr cap
        assertEquals(512, CourierFraming.chunkSize(1000)); // never exceeds the attribute cap
    }

    @Test
    public void assembler_reassemblesASingleFrame() {
        Collector c = new Collector();
        byte[] payload = "hello-courier".getBytes();
        new CourierFraming.FrameAssembler().feed(CourierFraming.framePrefixed(payload), c);
        assertEquals(1, c.frames.size());
        assertArrayEquals(payload, c.frames.get(0));
    }

    @Test
    public void assembler_reassemblesMultipleFramesInOneChunk() {
        Collector c = new Collector();
        ByteArrayOutputStream bos = new ByteArrayOutputStream();
        byte[][] payloads = {"a".getBytes(), "bb".getBytes(), "ccc".getBytes()};
        for (byte[] p : payloads) bos.write(CourierFraming.framePrefixed(p), 0, 4 + p.length);
        new CourierFraming.FrameAssembler().feed(bos.toByteArray(), c);
        assertEquals(3, c.frames.size());
        for (int i = 0; i < payloads.length; i++) assertArrayEquals(payloads[i], c.frames.get(i));
    }

    @Test
    public void assembler_reassemblesAFrameSplitAcrossChunks() {
        Collector c = new Collector();
        byte[] payload = "split-me-across-chunks".getBytes();
        byte[] framed = CourierFraming.framePrefixed(payload);
        CourierFraming.FrameAssembler asm = new CourierFraming.FrameAssembler();
        // Feed the framed bytes one at a time — the worst-case fragmentation.
        for (byte b : framed) {
            assertTrue(c.frames.isEmpty() || c.frames.size() == 1);
            asm.feed(new byte[] {b}, c);
        }
        assertEquals(1, c.frames.size());
        assertArrayEquals(payload, c.frames.get(0));
    }

    @Test
    public void assembler_handlesAPartialTrailingFrame() {
        Collector c = new Collector();
        CourierFraming.FrameAssembler asm = new CourierFraming.FrameAssembler();
        byte[] full = CourierFraming.framePrefixed("first".getBytes());
        byte[] partial = CourierFraming.framePrefixed("second-but-incomplete".getBytes());
        ByteArrayOutputStream bos = new ByteArrayOutputStream();
        bos.write(full, 0, full.length);
        bos.write(partial, 0, partial.length - 5); // drop the last 5 bytes of the 2nd frame
        asm.feed(bos.toByteArray(), c);
        assertEquals("only the complete frame emits", 1, c.frames.size());
        assertArrayEquals("first".getBytes(), c.frames.get(0));
        // Deliver the remaining 5 bytes → the second frame completes.
        asm.feed(java.util.Arrays.copyOfRange(partial, partial.length - 5, partial.length), c);
        assertEquals(2, c.frames.size());
        assertArrayEquals("second-but-incomplete".getBytes(), c.frames.get(1));
    }

    @Test
    public void assembler_reassemblesEmptyPayloadFrames() {
        Collector c = new Collector();
        byte[] framed = CourierFraming.framePrefixed(new byte[0]);
        assertEquals(4, framed.length);
        new CourierFraming.FrameAssembler().feed(framed, c);
        assertEquals(1, c.frames.size());
        assertEquals(0, c.frames.get(0).length);
    }

    @Test
    public void assembler_failsClosedOnAnOversizedDeclaredLength() {
        Collector c = new Collector();
        // A length prefix declaring > MAX_FRAME_BYTES must reset the buffer, not allocate.
        byte[] hostile = new byte[] {(byte) 0x7f, (byte) 0xff, (byte) 0xff, (byte) 0xff, 1, 2, 3};
        new CourierFraming.FrameAssembler().feed(hostile, c);
        assertTrue("no frame emitted for an out-of-range length", c.frames.isEmpty());
    }

    @Test
    public void assembler_failsClosedOnANegativeDeclaredLength() {
        Collector c = new Collector();
        byte[] hostile = new byte[] {(byte) 0xff, 0, 0, 0, 9, 9}; // top bit set ⇒ negative int
        new CourierFraming.FrameAssembler().feed(hostile, c);
        assertTrue(c.frames.isEmpty());
    }

    // --- the pure serialize-on-ack send state machine ------------------------------

    /** A fake ChunkSender that records the chunks and returns a scripted ack per chunk. */
    private static final class FakeSender implements CourierFraming.ChunkSender {
        final List<byte[]> sent = new ArrayList<>();
        final int[] acks; // ack to return for the Nth awaitAck
        int sendThrowAt = -1; // index at which sendChunk throws (or -1)
        int i = 0;

        FakeSender(int... acks) {
            this.acks = acks;
        }

        @Override
        public void sendChunk(byte[] chunk) throws CourierFraming.CourierIoException {
            if (sent.size() == sendThrowAt) throw new CourierFraming.CourierIoException("send_failed");
            sent.add(chunk);
        }

        @Override
        public int awaitAck() {
            return acks[i++];
        }
    }

    @Test
    public void sendChunked_splitsAFrameIntoAckGatedChunksReassemblingExactly() throws Exception {
        byte[] payload = new byte[2500];
        new Random(7).nextBytes(payload);
        byte[] expectedFramed = CourierFraming.framePrefixed(payload);
        int chunkSize = 244;
        int expectedChunks = (expectedFramed.length + chunkSize - 1) / chunkSize;
        FakeSender s = new FakeSender(new int[expectedChunks]); // all ACK_OK (0)
        CourierFraming.sendChunked(payload, chunkSize, s);
        assertEquals(expectedChunks, s.sent.size());
        ByteArrayOutputStream reassembled = new ByteArrayOutputStream();
        for (byte[] c : s.sent) {
            assertTrue("chunk within size bound", c.length <= chunkSize);
            reassembled.write(c, 0, c.length);
        }
        assertArrayEquals("the sent chunks reassemble to the exact framed payload",
                expectedFramed, reassembled.toByteArray());
    }

    @Test
    public void sendChunked_emptyPayloadStillSendsThePrefixFrame() throws Exception {
        FakeSender s = new FakeSender(0);
        CourierFraming.sendChunked(new byte[0], 512, s);
        assertEquals(1, s.sent.size());
        assertEquals(4, s.sent.get(0).length); // just the 4-byte length prefix
    }

    @Test(expected = CourierFraming.CourierIoException.class)
    public void sendChunked_failsClosedOnANonSuccessAck() throws Exception {
        // First chunk acks OK, second returns a non-success status → abort.
        CourierFraming.sendChunked(new byte[1000], 244, new FakeSender(0, 7));
    }

    @Test(expected = CourierFraming.CourierIoException.class)
    public void sendChunked_propagatesAWriteFailure() throws Exception {
        FakeSender s = new FakeSender(0, 0, 0, 0, 0);
        s.sendThrowAt = 1; // the second sendChunk throws
        CourierFraming.sendChunked(new byte[1000], 244, s);
    }

    @Test(expected = CourierFraming.CourierIoException.class)
    public void sendChunked_rejectsANonPositiveChunkSize() throws Exception {
        CourierFraming.sendChunked(new byte[10], 0, new FakeSender(0));
    }

    // --- the blocking-stream length-prefixed reader (RFCOMM / Wi-Fi socket path) ----

    private static byte[] streamOf(byte[]... payloads) {
        ByteArrayOutputStream bos = new ByteArrayOutputStream();
        for (byte[] p : payloads) {
            byte[] f = CourierFraming.framePrefixed(p);
            bos.write(f, 0, f.length);
        }
        return bos.toByteArray();
    }

    @Test
    public void readFramedStream_readsEveryFrameThenStopsCleanlyAtEof() throws Exception {
        byte[][] payloads = {"alpha".getBytes(), new byte[0], "gamma-frame".getBytes()};
        Collector c = new Collector();
        CourierFraming.readFramedStream(
                new ByteArrayInputStream(streamOf(payloads)), c::onFrame, () -> true);
        assertEquals(3, c.frames.size());
        for (int i = 0; i < payloads.length; i++) assertArrayEquals(payloads[i], c.frames.get(i));
    }

    @Test
    public void readFramedStream_failsClosedOnAnOversizedLength() throws Exception {
        // [0x7fffffff length][garbage] — must stop without emitting or allocating.
        byte[] hostile = {(byte) 0x7f, (byte) 0xff, (byte) 0xff, (byte) 0xff, 1, 2, 3};
        Collector c = new Collector();
        CourierFraming.readFramedStream(new ByteArrayInputStream(hostile), c::onFrame, () -> true);
        assertTrue(c.frames.isEmpty());
    }

    @Test(expected = EOFException.class)
    public void readFramedStream_throwsOnATruncatedFrame() throws Exception {
        byte[] full = streamOf("complete".getBytes());
        byte[] truncated = java.util.Arrays.copyOf(full, full.length - 2); // drop 2 payload bytes
        CourierFraming.readFramedStream(new ByteArrayInputStream(truncated), f -> {}, () -> true);
    }

    @Test
    public void readFramedStream_stopsWhenShouldContinueGoesFalse() throws Exception {
        byte[] stream = streamOf("one".getBytes(), "two".getBytes(), "three".getBytes());
        final AtomicInteger budget = new AtomicInteger(2); // allow exactly two frames
        Collector c = new Collector();
        CourierFraming.readFramedStream(new ByteArrayInputStream(stream),
                f -> {
                    c.onFrame(f);
                    budget.decrementAndGet();
                },
                () -> budget.get() > 0);
        assertEquals(2, c.frames.size());
        assertArrayEquals("one".getBytes(), c.frames.get(0));
        assertArrayEquals("two".getBytes(), c.frames.get(1));
    }

    @Test
    public void assembler_roundTripsManyFramesAcrossRandomChunkBoundaries() {
        Random r = new Random(0xC0FFEE);
        // Encode N random payloads into one byte stream.
        List<byte[]> payloads = new ArrayList<>();
        ByteArrayOutputStream stream = new ByteArrayOutputStream();
        for (int i = 0; i < 200; i++) {
            byte[] p = new byte[r.nextInt(3000)];
            r.nextBytes(p);
            payloads.add(p);
            byte[] framed = CourierFraming.framePrefixed(p);
            stream.write(framed, 0, framed.length);
        }
        byte[] all = stream.toByteArray();
        // Feed it in arbitrary-sized chunks; every frame must come back byte-exact, in order.
        Collector c = new Collector();
        CourierFraming.FrameAssembler asm = new CourierFraming.FrameAssembler();
        int off = 0;
        while (off < all.length) {
            int n = 1 + r.nextInt(257);
            n = Math.min(n, all.length - off);
            asm.feed(java.util.Arrays.copyOfRange(all, off, off + n), c);
            off += n;
        }
        assertEquals(payloads.size(), c.frames.size());
        for (int i = 0; i < payloads.size(); i++) {
            assertArrayEquals("frame " + i, payloads.get(i), c.frames.get(i));
        }
    }
}

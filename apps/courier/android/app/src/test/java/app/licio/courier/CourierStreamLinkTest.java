// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Tests of the shared blocking-stream courier data-path `CourierStreamLink` over IN-MEMORY
// PIPES — NO socket, NO port, NO radio.  This is the single data-path used by RFCOMM, Wi-Fi
// Direct, and USB, so testing it once here (deterministically) covers the inbound framing +
// outbound routing + lifecycle for all three, and removes any need for a real-socket / fixed-
// port test seam in the per-transport radios.

package app.licio.courier;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotSame;
import static org.junit.Assert.assertSame;
import static org.junit.Assert.assertTrue;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.Closeable;
import java.io.DataOutputStream;
import java.io.PipedInputStream;
import java.io.PipedOutputStream;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;

import org.junit.Test;

public class CourierStreamLinkTest {

    private static final class Recorder implements CourierRadio.Events {
        final CountDownLatch connected = new CountDownLatch(1);
        final CountDownLatch disconnected = new CountDownLatch(1);
        final CountDownLatch payloads;
        final List<String> received = new ArrayList<>();
        volatile boolean connectedFlag;

        Recorder(int expectedPayloads) {
            this.payloads = new CountDownLatch(expectedPayloads);
        }

        @Override
        public void onConnectionResult(String endpointId, boolean isConnected) {
            connectedFlag = isConnected;
            connected.countDown();
        }

        @Override
        public synchronized void onPayload(String endpointId, byte[] bytes) {
            received.add(new String(bytes));
            payloads.countDown();
        }

        @Override
        public void onDisconnected(String endpointId) {
            disconnected.countDown();
        }
    }

    @Test
    public void deliversFramedPayloadsRoutesOutboundThenCleansUpOnClose() throws Exception {
        Recorder rec = new Recorder(2);
        PipedInputStream in = new PipedInputStream();
        PipedOutputStream peer = new PipedOutputStream(in);
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        AtomicBoolean closed = new AtomicBoolean(false);
        Closeable conn = () -> closed.set(true);
        Map<String, DataOutputStream> outbound = new ConcurrentHashMap<>();

        Thread link = new Thread(() ->
                CourierStreamLink.run(in, out, conn, "ep", outbound, rec, () -> true));
        link.start();

        assertTrue("connection announced", rec.connected.await(5, TimeUnit.SECONDS));
        assertTrue("connected flag is true", rec.connectedFlag);
        assertTrue("outbound stream registered for the endpoint", outbound.containsKey("ep"));

        peer.write(CourierFraming.framePrefixed("hello".getBytes()));
        peer.write(CourierFraming.framePrefixed("world".getBytes()));
        peer.flush();
        assertTrue("both framed payloads delivered", rec.payloads.await(5, TimeUnit.SECONDS));

        peer.close(); // EOF between frames → the read loop returns cleanly → cleanup runs
        link.join(5000);
        assertTrue("the connection was closed", closed.get());
        assertTrue("disconnect announced", rec.disconnected.await(5, TimeUnit.SECONDS));
        assertFalse("outbound entry dropped on cleanup", outbound.containsKey("ep"));
        assertEquals(List.of("hello", "world"), rec.received);
    }

    @Test
    public void anAlreadyDeadLinkAnnouncesConnectThenDisconnectsWithoutReading() throws Exception {
        // alive=false up front: the read loop does no read; the link still announces connect then
        // immediately disconnects + closes (the lifecycle is symmetric).
        Recorder rec = new Recorder(1);
        PipedInputStream in = new PipedInputStream();
        new PipedOutputStream(in); // keep the pipe valid (never written)
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        AtomicBoolean closed = new AtomicBoolean(false);
        Map<String, DataOutputStream> outbound = new ConcurrentHashMap<>();

        CourierStreamLink.run(in, out, () -> closed.set(true), "ep", outbound, rec, () -> false);

        assertTrue(rec.connected.await(1, TimeUnit.SECONDS));
        assertTrue("disconnect still announced", rec.disconnected.await(1, TimeUnit.SECONDS));
        assertTrue("connection closed", closed.get());
        assertFalse(outbound.containsKey("ep"));
    }

    @Test
    public void aReconnectingEndpointKeepsItsNewerOutboundEntry() throws Exception {
        // Two links for the SAME endpoint id (a reconnect).  When the OLDER link tears down, its
        // by-value remove must NOT clobber the newer link's outbound entry — otherwise send()
        // would route to a dead/absent stream.  (A remove-by-KEY would clobber it.)
        Map<String, DataOutputStream> outbound = new ConcurrentHashMap<>();

        Recorder recA = new Recorder(1);
        PipedInputStream inA = new PipedInputStream();
        PipedOutputStream peerA = new PipedOutputStream(inA);
        Thread linkA = new Thread(() -> CourierStreamLink.run(
                inA, new ByteArrayOutputStream(), () -> {}, "ep", outbound, recA, () -> true));
        linkA.start();
        assertTrue(recA.connected.await(5, TimeUnit.SECONDS));
        DataOutputStream streamA = outbound.get("ep");

        Recorder recB = new Recorder(1);
        PipedInputStream inB = new PipedInputStream();
        PipedOutputStream peerB = new PipedOutputStream(inB);
        Thread linkB = new Thread(() -> CourierStreamLink.run(
                inB, new ByteArrayOutputStream(), () -> {}, "ep", outbound, recB, () -> true));
        linkB.start();
        assertTrue(recB.connected.await(5, TimeUnit.SECONDS));
        DataOutputStream streamB = outbound.get("ep");
        assertNotSame("the reconnect registered a fresh outbound stream", streamA, streamB);

        // Tear the OLDER link (A) down — its finally must remove only its own stale entry.
        peerA.close();
        assertTrue(recA.disconnected.await(5, TimeUnit.SECONDS));
        assertSame("the reconnected link's outbound entry survived the old link's teardown",
                streamB, outbound.get("ep"));

        peerB.close();
        linkA.join(2000);
        linkB.join(2000);
    }

    @Test
    public void theRegisteredOutboundStreamCarriesFramedSends() throws Exception {
        // The outbound stream registered by the link is the real frame writer a radio's send()
        // uses — writing through it produces an exact on-wire frame.
        Recorder rec = new Recorder(1);
        PipedInputStream in = new PipedInputStream();
        PipedOutputStream peer = new PipedOutputStream(in);
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        Map<String, DataOutputStream> outbound = new ConcurrentHashMap<>();

        Thread link = new Thread(() ->
                CourierStreamLink.run(in, out, () -> {}, "ep", outbound, rec, () -> true));
        link.start();
        assertTrue(rec.connected.await(5, TimeUnit.SECONDS));

        DataOutputStream dos = outbound.get("ep");
        byte[] payload = {7, 8, 9};
        dos.write(CourierFraming.framePrefixed(payload));
        dos.flush();
        assertArrayEquals(CourierFraming.framePrefixed(payload), out.toByteArray());

        peer.close();
        link.join(5000);
    }

    // --- the bounded send executor (replaces unbounded thread-per-send) -----------------

    @Test
    public void sendWritesAFramedPayloadAndReportsSuccess() throws Exception {
        ExecutorService exec = CourierStreamLink.newSendExecutor("test-send");
        try {
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            DataOutputStream dos = new DataOutputStream(out);
            CountDownLatch ok = new CountDownLatch(1);
            byte[] payload = {1, 2, 3};
            CourierStreamLink.send(exec, dos, payload, new CourierRadio.SendResult() {
                @Override
                public void onSuccess() {
                    ok.countDown();
                }

                @Override
                public void onError(String reason, Exception cause) {}
            });
            assertTrue("the send reported success", ok.await(5, TimeUnit.SECONDS));
            assertArrayEquals("the framed payload was written",
                    CourierFraming.framePrefixed(payload), out.toByteArray());
        } finally {
            exec.shutdownNow();
        }
    }

    @Test
    public void concurrentSendsToOneStreamDoNotInterleave() throws Exception {
        // Two overlapping sends to ONE stream through the shared executor: the per-stream
        // synchronized guard must keep each length-prefixed frame ATOMIC (no byte interleaving).
        ExecutorService exec = CourierStreamLink.newSendExecutor("test-send");
        try {
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            DataOutputStream dos = new DataOutputStream(out);
            byte[] p1 = new byte[3000];
            Arrays.fill(p1, (byte) 0x11);
            byte[] p2 = new byte[3000];
            Arrays.fill(p2, (byte) 0x22);
            CountDownLatch done = new CountDownLatch(2);
            CourierRadio.SendResult r = new CourierRadio.SendResult() {
                @Override
                public void onSuccess() {
                    done.countDown();
                }

                @Override
                public void onError(String reason, Exception cause) {}
            };
            CourierStreamLink.send(exec, dos, p1, r);
            CourierStreamLink.send(exec, dos, p2, r);
            assertTrue("both sends completed", done.await(5, TimeUnit.SECONDS));

            List<byte[]> frames = new ArrayList<>();
            CourierFraming.readFramedStream(new ByteArrayInputStream(out.toByteArray()),
                    frames::add, () -> true);
            assertEquals("exactly two intact frames", 2, frames.size());
            boolean has1 = Arrays.equals(frames.get(0), p1) || Arrays.equals(frames.get(1), p1);
            boolean has2 = Arrays.equals(frames.get(0), p2) || Arrays.equals(frames.get(1), p2);
            assertTrue("both payloads present + uncorrupted", has1 && has2);
        } finally {
            exec.shutdownNow();
        }
    }

    @Test
    public void theSendExecutorIsBoundedNotThreadPerSend() {
        ExecutorService exec = CourierStreamLink.newSendExecutor("test-send");
        try {
            // The whole point of the executor: thread count is BOUNDED (was unbounded per-send).
            assertTrue("the executor caps its thread pool", exec instanceof ThreadPoolExecutor);
            assertTrue("a finite max pool size", ((ThreadPoolExecutor) exec).getMaximumPoolSize() <= 16);
        } finally {
            exec.shutdownNow();
        }
    }
}

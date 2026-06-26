// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Layer-2 of the courier test pyramid: Robolectric tests of `UsbCourierRadio` — NO USB
// hardware, NO root.  The accessory open is OTG-physical-only, but the data path (the
// length-prefixed stream framing + send/receive wiring) is driven over an IN-MEMORY PIPE via
// the package-visible `attach(in, out, endpointId)` seam, so it is fully unit-tested on the JVM.

package app.licio.courier;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

import android.content.Context;

import androidx.test.core.app.ApplicationProvider;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.PipedInputStream;
import java.io.PipedOutputStream;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;

import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 34)
public class UsbCourierRadioTest {

    private static final class Recorder implements CourierRadio.Events {
        final CountDownLatch connected = new CountDownLatch(1);
        final CountDownLatch payloadLatch = new CountDownLatch(1);
        final CountDownLatch disconnected = new CountDownLatch(1);
        final AtomicReference<byte[]> payload = new AtomicReference<>();
        final AtomicReference<String> startFailedOp = new AtomicReference<>();
        boolean anyConnectionResult;

        @Override
        public void onConnectionResult(String endpointId, boolean isConnected) {
            anyConnectionResult = true;
            if (isConnected) connected.countDown();
        }

        @Override
        public void onPayload(String endpointId, byte[] bytes) {
            payload.set(bytes);
            payloadLatch.countDown();
        }

        @Override
        public void onDisconnected(String endpointId) {
            disconnected.countDown();
        }

        @Override
        public void onStartFailed(String operation, Exception cause) {
            startFailedOp.set(operation);
        }
    }

    private static Context ctx() {
        return ApplicationProvider.getApplicationContext();
    }

    @Test
    public void attachReceivesAFramedPayloadOverThePipe() throws Exception {
        Recorder rec = new Recorder();
        UsbCourierRadio radio = new UsbCourierRadio(ctx(), rec);

        // The "accessory" input is one end of an in-memory pipe; the test writes the other end.
        PipedInputStream radioIn = new PipedInputStream();
        PipedOutputStream peerOut = new PipedOutputStream(radioIn);
        ByteArrayOutputStream radioOut = new ByteArrayOutputStream();
        try {
            radio.attach(radioIn, radioOut, "usb-test");
            assertTrue("the radio reported the accessory connected",
                    rec.connected.await(5, TimeUnit.SECONDS));

            byte[] payload = "usb-courier-frame".getBytes();
            peerOut.write(CourierFraming.framePrefixed(payload));
            peerOut.flush();
            assertTrue("the radio received the framed payload",
                    rec.payloadLatch.await(5, TimeUnit.SECONDS));
            assertArrayEquals(payload, rec.payload.get());
        } finally {
            radio.stop();
            peerOut.close();
        }
    }

    @Test
    public void sendWritesAFramedPayloadToTheAccessoryStream() throws Exception {
        Recorder rec = new Recorder();
        UsbCourierRadio radio = new UsbCourierRadio(ctx(), rec);
        PipedInputStream radioIn = new PipedInputStream();
        new PipedOutputStream(radioIn); // keep the pipe open
        ByteArrayOutputStream radioOut = new ByteArrayOutputStream();
        radio.attach(radioIn, radioOut, "usb-test");
        // Send only AFTER the link is announced (as production does) — the outbound stream is
        // registered by the link thread before onConnectionResult fires.
        assertTrue(rec.connected.await(5, TimeUnit.SECONDS));

        byte[] payload = {5, 6, 7, 8};
        CountDownLatch sent = new CountDownLatch(1);
        radio.send("usb-test", payload, new CourierRadio.SendResult() {
            @Override
            public void onSuccess() {
                sent.countDown();
            }

            @Override
            public void onError(String reason, Exception cause) {}
        });
        assertTrue(sent.await(5, TimeUnit.SECONDS));
        assertArrayEquals("the outbound stream carries the exact framed payload",
                CourierFraming.framePrefixed(payload), radioOut.toByteArray());
        radio.stop();
    }

    @Test
    public void concurrentSendsToOneEndpointAreNotInterleaved() throws Exception {
        // Two overlapping sends to one stream: the `synchronized (out)` guard must keep each
        // length-prefixed frame ATOMIC on the wire (no byte interleaving / corruption).
        Recorder rec = new Recorder();
        UsbCourierRadio radio = new UsbCourierRadio(ctx(), rec);
        PipedInputStream radioIn = new PipedInputStream();
        PipedOutputStream keepOpen = new PipedOutputStream(radioIn);
        ByteArrayOutputStream radioOut = new ByteArrayOutputStream();
        radio.attach(radioIn, radioOut, "usb-test");
        assertTrue(rec.connected.await(5, TimeUnit.SECONDS)); // outbound registered before send

        byte[] p1 = new byte[2000];
        Arrays.fill(p1, (byte) 0x11);
        byte[] p2 = new byte[2000];
        Arrays.fill(p2, (byte) 0x22);
        CountDownLatch done = new CountDownLatch(2);
        CourierRadio.SendResult result = new CourierRadio.SendResult() {
            @Override
            public void onSuccess() {
                done.countDown();
            }

            @Override
            public void onError(String reason, Exception cause) {}
        };
        radio.send("usb-test", p1, result);
        radio.send("usb-test", p2, result); // concurrent with the first (each send spawns a thread)
        assertTrue("both sends completed", done.await(5, TimeUnit.SECONDS));

        // Parse the outbound stream back into frames — exactly two, each byte-intact.
        List<byte[]> frames = new ArrayList<>();
        CourierFraming.readFramedStream(new ByteArrayInputStream(radioOut.toByteArray()),
                frames::add, () -> true);
        assertEquals("exactly two intact frames on the wire", 2, frames.size());
        boolean has1 = Arrays.equals(frames.get(0), p1) || Arrays.equals(frames.get(1), p1);
        boolean has2 = Arrays.equals(frames.get(0), p2) || Arrays.equals(frames.get(1), p2);
        assertTrue("both payloads present + uncorrupted (order is nondeterministic)", has1 && has2);
        radio.stop();
        keepOpen.close();
    }

    /** An InputStream that PARKS in read() until closed, then throws — modelling a real
     *  accessory fd/socket whose blocking read IS interrupted by close() (a PipedInputStream is
     *  not, so it cannot model this).  Lets us verify stop() closes the read stream to unblock it. */
    private static final class BlockingClosableStream extends InputStream {
        private final CountDownLatch closed = new CountDownLatch(1);

        @Override
        public int read() throws IOException {
            try {
                closed.await();
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
            }
            throw new IOException("stream closed");
        }

        @Override
        public void close() {
            closed.countDown();
        }
    }

    @Test
    public void stopClosesTheReadStreamToUnblockTheReadThreadAndFireDisconnect() throws Exception {
        // The read thread is PARKED in read() (no data, no EOF).  stop() must close the READ stream
        // to unblock it — closing only the accessory descriptor would leak the thread + never fire
        // onDisconnected.  This catches the regression where stop() closed the wrong Closeable.
        Recorder rec = new Recorder();
        UsbCourierRadio radio = new UsbCourierRadio(ctx(), rec);
        radio.attach(new BlockingClosableStream(), new ByteArrayOutputStream(), "usb-test");
        assertTrue("link announced", rec.connected.await(5, TimeUnit.SECONDS));

        radio.stop();
        assertTrue("stop() closed the read stream → unblocked the read → onDisconnected fired",
                rec.disconnected.await(5, TimeUnit.SECONDS));
    }

    @Test
    public void sendBeforeAttachFailsClosed() {
        UsbCourierRadio radio = new UsbCourierRadio(ctx(), new Recorder());
        final String[] error = {null};
        radio.send("usb-accessory", new byte[] {1}, new CourierRadio.SendResult() {
            @Override
            public void onSuccess() {
                error[0] = "UNEXPECTED_SUCCESS";
            }

            @Override
            public void onError(String reason, Exception cause) {
                error[0] = reason;
            }
        });
        assertEquals("endpoint_not_connected", error[0]);
    }

    @Test
    public void usbManagerIsAvailableUnderRobolectric() {
        assertTrue(new UsbCourierRadio(ctx(), new Recorder()).isAvailable());
    }

    @Test
    public void startDiscoveryWithNoAccessoryReportsAStartFailureNotAConnectionEvent() {
        // No accessory attached + no attach watcher that could connect later ⇒ a START FAILURE
        // (so the controller surfaces radio_unavailable), NOT a negative connectionResult it ignores.
        Recorder rec = new Recorder();
        UsbCourierRadio radio = new UsbCourierRadio(ctx(), rec);
        radio.startDiscovery();
        assertEquals("discover", rec.startFailedOp.get());
        assertEquals("no (false) connection result is emitted", false, rec.anyConnectionResult);
    }
}

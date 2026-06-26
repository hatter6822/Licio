// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-R.15.4f — the two-device Nearby Connections courier radio E2E (OFFLINE_SPEC §22.5,
// §32.3).  These instrumentation tests exercise the SAME Google Nearby Connections API the
// production `NearbyCourierPlugin` wraps (P2P_CLUSTER, BYTES payloads), over the emulator's
// EMULATED radios (netsim BLE/BT + virtio-wifi), proving payloads cross between two devices
// with NO internet.
//
// Each scenario is a pair of coordinated methods launched concurrently — one per emulator
// sharing the netsim radio bus (`am instrument -e class …#methodA` on A, `#methodB` on B):
//
//   * basic           advertiseAndReceive   / discoverAndSend          — one BYTES frame
//   * chunked+integrity advertiseReceiveChunked / discoverSendChunked  — a 512 KiB payload
//                       streamed as 64 ordered 8 KiB BYTES frames, reassembled by sequence
//                       and asserted BYTE-EXACT (the §13.2 chunked-pack-streaming path)
//   * duplex          serveBidirectionalA   / serveBidirectionalB      — both directions
//   * lifecycle       advertiseAwaitDisconnect / discoverConnectThenDisconnect — the
//                       onDisconnected event the plugin emits
//
// The plugin is a thin wrapper over exactly this flow (advertise/discover → accept →
// sendPayload → receive, the TS layer chunking per §13.2), so a green run validates the
// courier's radio path, its framing, its duplex behaviour, and its lifecycle signalling.

package app.licio.courier;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;

import android.content.Context;

import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;

import com.google.android.gms.nearby.Nearby;
import com.google.android.gms.nearby.connection.AdvertisingOptions;
import com.google.android.gms.nearby.connection.ConnectionInfo;
import com.google.android.gms.nearby.connection.ConnectionLifecycleCallback;
import com.google.android.gms.nearby.connection.ConnectionResolution;
import com.google.android.gms.nearby.connection.ConnectionsClient;
import com.google.android.gms.nearby.connection.DiscoveredEndpointInfo;
import com.google.android.gms.nearby.connection.DiscoveryOptions;
import com.google.android.gms.nearby.connection.EndpointDiscoveryCallback;
import com.google.android.gms.nearby.connection.Payload;
import com.google.android.gms.nearby.connection.PayloadCallback;
import com.google.android.gms.nearby.connection.PayloadTransferUpdate;
import com.google.android.gms.nearby.connection.Strategy;

import java.nio.charset.StandardCharsets;
import java.util.Random;
import java.util.concurrent.BlockingQueue;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;

import org.junit.Test;
import org.junit.runner.RunWith;

@RunWith(AndroidJUnit4.class)
public class NearbyConnectionsRadioTest {

    private static final String SERVICE_ID = "app.licio.courier.lcap.v2";
    private static final Strategy STRATEGY = Strategy.P2P_CLUSTER;
    private static final byte[] FERRIED = "LICIO-COURIER-WS-R.15.4f-PING".getBytes(StandardCharsets.UTF_8);
    private static final byte[] PAYLOAD_A = "LICIO-COURIER-A->B-DUPLEX".getBytes(StandardCharsets.UTF_8);
    private static final byte[] PAYLOAD_B = "LICIO-COURIER-B->A-DUPLEX".getBytes(StandardCharsets.UTF_8);
    private static final long TIMEOUT_SECONDS = 150;

    // The §13.2 chunked-pack-streaming shape: a 512 KiB pack streamed as ordered 8 KiB BYTES
    // frames (Nearby BYTES payloads are bounded ~32 KiB, so the TS layer chunks below that).
    private static final int PAYLOAD_SIZE = 512 * 1024;
    private static final int CHUNK = 8 * 1024;
    private static final int CHUNK_COUNT = (PAYLOAD_SIZE + CHUNK - 1) / CHUNK;

    private static Context ctx() {
        return InstrumentationRegistry.getInstrumentation().getTargetContext();
    }

    // --- a reusable Nearby connection: connect (as advertiser or discoverer), send BYTES,
    //     queue received BYTES, observe disconnect — so each scenario shares one flow -------

    private static final class Conn {
        final ConnectionsClient client;
        final BlockingQueue<byte[]> inbox = new LinkedBlockingQueue<>();
        final CountDownLatch connected = new CountDownLatch(1);
        final CountDownLatch disconnected = new CountDownLatch(1);
        final AtomicReference<String> endpoint = new AtomicReference<>();

        final PayloadCallback payloadCb = new PayloadCallback() {
            @Override
            public void onPayloadReceived(String ep, Payload payload) {
                byte[] bytes = payload.asBytes();
                if (bytes != null) inbox.offer(bytes);
            }

            @Override
            public void onPayloadTransferUpdate(String ep, PayloadTransferUpdate update) {}
        };

        final ConnectionLifecycleCallback lifecycle = new ConnectionLifecycleCallback() {
            @Override
            public void onConnectionInitiated(String ep, ConnectionInfo info) {
                client.acceptConnection(ep, payloadCb);
            }

            @Override
            public void onConnectionResult(String ep, ConnectionResolution resolution) {
                if (resolution.getStatus().isSuccess()) {
                    endpoint.set(ep);
                    connected.countDown();
                }
            }

            @Override
            public void onDisconnected(String ep) {
                disconnected.countDown();
            }
        };

        Conn(Context ctx) {
            client = Nearby.getConnectionsClient(ctx);
        }

        void send(byte[] bytes) {
            client.sendPayload(endpoint.get(), Payload.fromBytes(bytes));
        }

        byte[] poll(long seconds) throws InterruptedException {
            return inbox.poll(seconds, TimeUnit.SECONDS);
        }

        void close() {
            client.stopAllEndpoints();
            client.stopAdvertising();
            client.stopDiscovery();
        }
    }

    private static Conn advertise() throws InterruptedException {
        Conn c = new Conn(ctx());
        c.client.startAdvertising(
                "licio-courier-A",
                SERVICE_ID,
                c.lifecycle,
                new AdvertisingOptions.Builder().setStrategy(STRATEGY).build());
        assertTrue("advertiser never connected over the emulated radios",
                c.connected.await(TIMEOUT_SECONDS, TimeUnit.SECONDS));
        return c;
    }

    private static Conn discover() throws InterruptedException {
        Conn c = new Conn(ctx());
        EndpointDiscoveryCallback discovery = new EndpointDiscoveryCallback() {
            @Override
            public void onEndpointFound(String ep, DiscoveredEndpointInfo info) {
                if (SERVICE_ID.equals(info.getServiceId())) {
                    c.client.requestConnection("licio-courier-B", ep, c.lifecycle);
                }
            }

            @Override
            public void onEndpointLost(String ep) {}
        };
        c.client.startDiscovery(
                SERVICE_ID,
                discovery,
                new DiscoveryOptions.Builder().setStrategy(STRATEGY).build());
        assertTrue("discoverer never connected to the advertiser over the emulated radios",
                c.connected.await(TIMEOUT_SECONDS, TimeUnit.SECONDS));
        return c;
    }

    // The SAME bytes on both devices (Java's Random is spec-deterministic given a seed), so
    // the receiver can assert the reassembled stream BYTE-EXACT without transmitting a hash.
    private static byte[] deterministicPayload() {
        byte[] b = new byte[PAYLOAD_SIZE];
        new Random(0xC0FFEEL).nextBytes(b);
        return b;
    }

    private static void writeInt(byte[] a, int off, int v) {
        a[off] = (byte) (v >>> 24);
        a[off + 1] = (byte) (v >>> 16);
        a[off + 2] = (byte) (v >>> 8);
        a[off + 3] = (byte) v;
    }

    private static int readInt(byte[] a, int off) {
        return ((a[off] & 0xFF) << 24) | ((a[off + 1] & 0xFF) << 16)
                | ((a[off + 2] & 0xFF) << 8) | (a[off + 3] & 0xFF);
    }

    // --- scenario 1: basic single-frame exchange ------------------------------------

    /** Device A: advertise, accept, and receive the ferried bytes. */
    @Test
    public void advertiseAndReceive() throws InterruptedException {
        Conn c = advertise();
        try {
            byte[] got = c.poll(TIMEOUT_SECONDS);
            assertNotNull("advertiser did not receive a payload over the emulated radios", got);
            assertArrayEquals("ferried bytes corrupted in transit", FERRIED, got);
        } finally {
            c.close();
        }
    }

    /** Device B: discover A, connect, and send the ferried bytes. */
    @Test
    public void discoverAndSend() throws InterruptedException {
        Conn c = discover();
        try {
            c.send(FERRIED);
            Thread.sleep(5000); // let the BYTES payload flush before teardown
        } finally {
            c.close();
        }
    }

    // --- scenario 2: large chunked payload, reassembled + integrity-checked ----------

    /** Device A: reassemble 64 ordered 8 KiB chunks into a 512 KiB pack, assert byte-exact. */
    @Test
    public void advertiseReceiveChunked() throws InterruptedException {
        Conn c = advertise();
        try {
            byte[] expected = deterministicPayload();
            byte[] buf = new byte[PAYLOAD_SIZE];
            boolean[] seen = new boolean[CHUNK_COUNT];
            int got = 0;
            while (got < CHUNK_COUNT) {
                byte[] frame = c.poll(TIMEOUT_SECONDS);
                assertNotNull("missing chunk after " + got + "/" + CHUNK_COUNT, frame);
                int seq = readInt(frame, 0);
                assertTrue("chunk seq out of range: " + seq, seq >= 0 && seq < CHUNK_COUNT);
                if (seen[seq]) continue; // ignore a duplicate
                System.arraycopy(frame, 4, buf, seq * CHUNK, frame.length - 4);
                seen[seq] = true;
                got++;
            }
            assertArrayEquals("reassembled chunked pack corrupted or out of order", expected, buf);
        } finally {
            c.close();
        }
    }

    /** Device B: stream a 512 KiB pack as 64 ordered, sequence-tagged 8 KiB BYTES frames. */
    @Test
    public void discoverSendChunked() throws InterruptedException {
        Conn c = discover();
        try {
            byte[] payload = deterministicPayload();
            for (int seq = 0; seq < CHUNK_COUNT; seq++) {
                int off = seq * CHUNK;
                int len = Math.min(CHUNK, PAYLOAD_SIZE - off);
                byte[] frame = new byte[4 + len];
                writeInt(frame, 0, seq);
                System.arraycopy(payload, off, frame, 4, len);
                c.send(frame);
            }
            Thread.sleep(10000); // let all 64 frames flush across the emulated medium
        } finally {
            c.close();
        }
    }

    // --- scenario 3: bidirectional (duplex) exchange --------------------------------

    /** Device A: send A→B, then receive B→A. */
    @Test
    public void serveBidirectionalA() throws InterruptedException {
        Conn c = advertise();
        try {
            c.send(PAYLOAD_A);
            byte[] got = c.poll(TIMEOUT_SECONDS);
            assertNotNull("A never received B's payload (duplex failed)", got);
            assertArrayEquals("B->A payload corrupted", PAYLOAD_B, got);
        } finally {
            c.close();
        }
    }

    /** Device B: send B→A, then receive A→B. */
    @Test
    public void serveBidirectionalB() throws InterruptedException {
        Conn c = discover();
        try {
            c.send(PAYLOAD_B);
            byte[] got = c.poll(TIMEOUT_SECONDS);
            assertNotNull("B never received A's payload (duplex failed)", got);
            assertArrayEquals("A->B payload corrupted", PAYLOAD_A, got);
        } finally {
            c.close();
        }
    }

    // --- scenario 4: disconnect lifecycle -------------------------------------------

    /** Device A: receive a warmup frame, then assert onDisconnected fires when B leaves. */
    @Test
    public void advertiseAwaitDisconnect() throws InterruptedException {
        Conn c = advertise();
        try {
            assertNotNull("no warmup frame before disconnect", c.poll(TIMEOUT_SECONDS));
            assertTrue("onDisconnected never fired after the peer left",
                    c.disconnected.await(TIMEOUT_SECONDS, TimeUnit.SECONDS));
        } finally {
            c.close();
        }
    }

    /** Device B: connect, send a frame, then explicitly disconnect. */
    @Test
    public void discoverConnectThenDisconnect() throws InterruptedException {
        Conn c = discover();
        try {
            c.send(FERRIED);
            Thread.sleep(3000);
            c.client.disconnectFromEndpoint(c.endpoint.get());
            Thread.sleep(3000);
        } finally {
            c.close();
        }
    }
}

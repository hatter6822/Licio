// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Layer-2 of the courier test pyramid: Robolectric (JVM, shadowed Android) tests of the
// `WifiDirectRadio` driver — NO device, NO radio, NO root.  Wi-Fi Direct GROUP FORMATION can't
// run on two stock netsim emulators, so unit coverage matters most here.  These tests cover the
// availability check, the post-group-formation CLIENT socket data path over a real LOOPBACK
// socket (driving the package-visible `onConnectionInfo` with a group-owner address), and the
// send-routing decision — all deterministic, no radio.  The framing itself is the pure
// `CourierFraming.readFramedStream` (covered by `CourierFramingTest`).

package app.licio.courier;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

import android.content.Context;
import android.net.wifi.p2p.WifiP2pInfo;

import androidx.test.core.app.ApplicationProvider;

import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;

import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 34)
public class WifiDirectRadioJvmTest {

    private static final class Recorder implements CourierRadio.Events {
        final CountDownLatch connected = new CountDownLatch(1);
        final CountDownLatch payloadLatch = new CountDownLatch(1);
        final AtomicReference<String> connectedEndpoint = new AtomicReference<>();
        final AtomicReference<byte[]> payload = new AtomicReference<>();

        @Override
        public void onConnectionResult(String endpointId, boolean isConnected) {
            if (isConnected) {
                connectedEndpoint.set(endpointId);
                connected.countDown();
            }
        }

        @Override
        public void onPayload(String endpointId, byte[] bytes) {
            payload.set(bytes);
            payloadLatch.countDown();
        }

        @Override
        public void onDisconnected(String endpointId) {}
    }

    private static Context ctx() {
        return ApplicationProvider.getApplicationContext();
    }

    @Test
    public void wifiP2pIsAvailableUnderRobolectric() {
        assertTrue(new WifiDirectRadio(ctx(), new Recorder()).isAvailable());
    }

    @Test
    public void clientDialsTheGroupOwnerAndReceivesAFramedPayload() throws Exception {
        Recorder rec = new Recorder();
        WifiDirectRadio radio = new WifiDirectRadio(ctx(), rec);
        // Stand up a loopback "group owner" on an EPHEMERAL port (no fixed 8989 collision), and
        // point the radio's client dial at it via the test seam.
        ServerSocket owner = new ServerSocket(0, 1, InetAddress.getByName("127.0.0.1"));
        radio.setDataPortForTest(owner.getLocalPort());
        try {
            radio.startDiscovery(); // sets running=true (and registers the WifiP2p receiver)

            // Drive the connection-info as a NON-owner whose group owner is our loopback server.
            WifiP2pInfo info = new WifiP2pInfo();
            info.groupFormed = true;
            info.isGroupOwner = false;
            info.groupOwnerAddress = InetAddress.getByName("127.0.0.1");
            radio.onConnectionInfo(info); // → connectClientSocket("127.0.0.1") on a thread

            Socket accepted = owner.accept(); // blocks until the radio's client dials in
            assertTrue("the radio reported the connection",
                    rec.connected.await(5, TimeUnit.SECONDS));

            // The group owner streams one length-prefixed frame → the radio emits the payload.
            byte[] payload = "wifi-direct-courier-frame".getBytes();
            accepted.getOutputStream().write(CourierFraming.framePrefixed(payload));
            accepted.getOutputStream().flush();
            assertTrue("the radio received the framed payload",
                    rec.payloadLatch.await(5, TimeUnit.SECONDS));
            assertArrayEquals(payload, rec.payload.get());
            accepted.close();
        } finally {
            radio.stop();
            owner.close();
        }
    }

    @Test
    public void groupOwnerAcceptsAPeerSocketAndReceivesAFramedPayload() throws Exception {
        Recorder rec = new Recorder();
        WifiDirectRadio radio = new WifiDirectRadio(ctx(), rec);
        radio.setDataPortForTest(0); // the radio's group-owner server binds an EPHEMERAL port
        try {
            radio.startDiscovery(); // running=true

            // Drive the connection-info as the GROUP OWNER → the radio opens its ServerSocket.
            WifiP2pInfo info = new WifiP2pInfo();
            info.groupFormed = true;
            info.isGroupOwner = true;
            radio.onConnectionInfo(info); // → startServerSocket() on a thread

            // Wait for the radio's server to bind, then dial it as the "client" peer.
            int port = -1;
            for (int i = 0; i < 100 && port < 0; i++) {
                port = radio.boundServerPort();
                if (port < 0) Thread.sleep(20);
            }
            assertTrue("the group-owner server bound a port", port > 0);
            try (Socket peer = new Socket(InetAddress.getByName("127.0.0.1"), port)) {
                assertTrue("the radio reported the inbound peer connection",
                        rec.connected.await(5, TimeUnit.SECONDS));
                byte[] payload = "wifi-direct-go-frame".getBytes();
                peer.getOutputStream().write(CourierFraming.framePrefixed(payload));
                peer.getOutputStream().flush();
                assertTrue("the radio received the framed payload",
                        rec.payloadLatch.await(5, TimeUnit.SECONDS));
                assertArrayEquals(payload, rec.payload.get());
            }
        } finally {
            radio.stop();
        }
    }

    @Test
    public void sendToAnUnknownEndpointFailsClosed() {
        WifiDirectRadio radio = new WifiDirectRadio(ctx(), new Recorder());
        final String[] error = {null};
        radio.send("192.168.49.1", new byte[] {1, 2, 3}, new CourierRadio.SendResult() {
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
}

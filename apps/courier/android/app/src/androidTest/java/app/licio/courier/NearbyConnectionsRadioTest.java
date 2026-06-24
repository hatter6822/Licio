// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-R.15.4f — the two-device courier radio E2E (OFFLINE_SPEC §22.5, §32.3).  This
// instrumentation test exercises the SAME Google Nearby Connections API the production
// `NearbyCourierPlugin` wraps, over the emulator's EMULATED radios (netsim BLE/BT +
// virtio-wifi), proving a payload crosses from one device to another with NO internet.
//
// It runs as two coordinated methods on two emulators sharing the netsim radio bus:
//   * `advertiseAndReceive` (device A) advertises + accepts a connection + asserts it
//     receives the exact ferried bytes;
//   * `discoverAndSend` (device B) discovers A, connects, and sends those bytes.
// Launch them concurrently (one `am instrument` per emulator).  The plugin is a thin
// wrapper over exactly this flow, so a green run validates the courier's radio path.

package app.licio.courier;

import static org.junit.Assert.assertArrayEquals;
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
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;

import org.junit.Test;
import org.junit.runner.RunWith;

@RunWith(AndroidJUnit4.class)
public class NearbyConnectionsRadioTest {

    private static final String SERVICE_ID = "app.licio.courier.lcap.v2";
    private static final Strategy STRATEGY = Strategy.P2P_CLUSTER;
    private static final byte[] FERRIED = "LICIO-COURIER-WS-R.15.4f-PING".getBytes(StandardCharsets.UTF_8);
    private static final long TIMEOUT_SECONDS = 150;

    private static Context ctx() {
        return InstrumentationRegistry.getInstrumentation().getTargetContext();
    }

    /** Device A: advertise, accept the inbound connection, and receive the ferried bytes. */
    @Test
    public void advertiseAndReceive() throws InterruptedException {
        final ConnectionsClient client = Nearby.getConnectionsClient(ctx());
        final CountDownLatch payloadLatch = new CountDownLatch(1);
        final AtomicReference<byte[]> received = new AtomicReference<>();

        final PayloadCallback payloadCb = new PayloadCallback() {
            @Override
            public void onPayloadReceived(String endpointId, Payload payload) {
                byte[] bytes = payload.asBytes();
                if (bytes != null) {
                    received.set(bytes);
                    payloadLatch.countDown();
                }
            }

            @Override
            public void onPayloadTransferUpdate(String endpointId, PayloadTransferUpdate update) {}
        };

        final ConnectionLifecycleCallback lifecycle = new ConnectionLifecycleCallback() {
            @Override
            public void onConnectionInitiated(String endpointId, ConnectionInfo info) {
                client.acceptConnection(endpointId, payloadCb);
            }

            @Override
            public void onConnectionResult(String endpointId, ConnectionResolution resolution) {}

            @Override
            public void onDisconnected(String endpointId) {}
        };

        try {
            client.startAdvertising(
                    "licio-courier-A",
                    SERVICE_ID,
                    lifecycle,
                    new AdvertisingOptions.Builder().setStrategy(STRATEGY).build());
            boolean got = payloadLatch.await(TIMEOUT_SECONDS, TimeUnit.SECONDS);
            assertTrue("advertiser did not receive a payload over the emulated radios", got);
            assertArrayEquals("ferried bytes corrupted in transit", FERRIED, received.get());
        } finally {
            client.stopAllEndpoints();
            client.stopAdvertising();
        }
    }

    /** Device B: discover A, connect, and send the ferried bytes. */
    @Test
    public void discoverAndSend() throws InterruptedException {
        final ConnectionsClient client = Nearby.getConnectionsClient(ctx());
        final CountDownLatch connectedLatch = new CountDownLatch(1);
        final AtomicReference<String> connectedEndpoint = new AtomicReference<>();

        final PayloadCallback payloadCb = new PayloadCallback() {
            @Override
            public void onPayloadReceived(String endpointId, Payload payload) {}

            @Override
            public void onPayloadTransferUpdate(String endpointId, PayloadTransferUpdate update) {}
        };

        final ConnectionLifecycleCallback lifecycle = new ConnectionLifecycleCallback() {
            @Override
            public void onConnectionInitiated(String endpointId, ConnectionInfo info) {
                client.acceptConnection(endpointId, payloadCb);
            }

            @Override
            public void onConnectionResult(String endpointId, ConnectionResolution resolution) {
                if (resolution.getStatus().isSuccess()) {
                    connectedEndpoint.set(endpointId);
                    connectedLatch.countDown();
                }
            }

            @Override
            public void onDisconnected(String endpointId) {}
        };

        final EndpointDiscoveryCallback discovery = new EndpointDiscoveryCallback() {
            @Override
            public void onEndpointFound(String endpointId, DiscoveredEndpointInfo info) {
                if (SERVICE_ID.equals(info.getServiceId())) {
                    client.requestConnection("licio-courier-B", endpointId, lifecycle);
                }
            }

            @Override
            public void onEndpointLost(String endpointId) {}
        };

        try {
            client.startDiscovery(
                    SERVICE_ID,
                    discovery,
                    new DiscoveryOptions.Builder().setStrategy(STRATEGY).build());
            boolean connected = connectedLatch.await(TIMEOUT_SECONDS, TimeUnit.SECONDS);
            assertTrue("discoverer never connected to the advertiser over the emulated radios", connected);
            client.sendPayload(connectedEndpoint.get(), Payload.fromBytes(FERRIED));
            // Give the BYTES payload time to flush across the emulated medium before teardown.
            Thread.sleep(5000);
        } finally {
            client.stopDiscovery();
            client.stopAllEndpoints();
        }
    }
}

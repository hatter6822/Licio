// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-R.15.4d/f — the two-device Wi-Fi Direct courier radio E2E (OFFLINE_SPEC §22.5).  This
// exercises the SAME WifiP2pManager group-formation + length-prefixed-socket data path the
// production `WifiDirectCourierPlugin` uses (discoverPeers → connect → group owner opens a
// ServerSocket on a fixed port, the client dials the group-owner IP, both read/write
// `DataOutputStream.writeInt(len)` + bytes), over the emulator's EMULATED virtio-wifi.
//
// Two coordinated methods on two emulators sharing the netsim radio bus:
//   * wifiDirectReceive (device A): form a group, obtain the duplex socket (as group owner
//     or client), read a length-prefixed 16 KiB frame, and assert it BYTE-EXACT.
//   * wifiDirectSend (device B): form a group, obtain the socket, and write the frame.
//
// NOTE: this is exercisable on the emulator ONLY against a real peer — NOT between two stock
// AVD emulators.  Empirically (verified on this host): the Wi-Fi Direct FRAMEWORK works on the
// emulator (`discoverPeers` returns SUCCESS; a `p2p-dev-wlan0` interface exists), but the two
// emulators never DISCOVER each other because **netsim bridges only Bluetooth (RootCanal), not
// Wi-Fi** — there is no shared Wi-Fi medium carrying P2P probe frames between AVD instances
// (this is why the Bluetooth-based legs — BLE GATT, RFCOMM, Nearby — DO cross, but Wi-Fi Direct
// does not).  So this test is gated behind `-e includeWifiDirect 1` and run on real radios (or
// a Cuttlefish/wmediumd shared-Wi-Fi-medium setup); its post-group length-prefixed socket path
// is byte-identical to the RFCOMM leg, which IS proven over netsim.  No content trust is
// conferred — every frame is re-validated on the TS side (§18.4).

package app.licio.courier;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assume.assumeTrue;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.net.wifi.p2p.WifiP2pConfig;
import android.net.wifi.p2p.WifiP2pInfo;
import android.net.wifi.p2p.WifiP2pManager;

import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;

import java.io.DataInputStream;
import java.io.DataOutputStream;
import java.io.IOException;
import java.net.InetSocketAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.util.Random;
import java.util.concurrent.BlockingQueue;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;

import org.junit.Test;
import org.junit.runner.RunWith;

@RunWith(AndroidJUnit4.class)
public class WifiDirectRadioTest {

    private static final int DATA_PORT = 8989;
    private static final int SOCKET_TIMEOUT_MS = 10_000;
    private static final int PAYLOAD_SIZE = 16 * 1024;
    private static final long TIMEOUT_SECONDS = 150;

    private static Context ctx() {
        return InstrumentationRegistry.getInstrumentation().getTargetContext();
    }

    /**
     * Cross-device Wi-Fi Direct group formation can't be exercised between two stock AVD
     * emulators — the framework works (`discoverPeers` SUCCESS) but netsim bridges only
     * Bluetooth (RootCanal), not Wi-Fi, so the emulators never discover each other.  It needs
     * real radios (or a Cuttlefish/wmediumd shared-Wi-Fi medium).  So this test SKIPS (a JUnit
     * assumption — a genuinely-unmet environment precondition, NOT a masked code defect) unless
     * the runner explicitly opts in with `-e includeWifiDirect 1` (the matrix passes it only
     * under `RADIO_E2E_INCLUDE_WIFI_DIRECT=1`), keeping a full `connectedAndroidTest` green on an
     * emulator while still running for real on hardware.
     */
    private static void assumeWifiDirectRequested() {
        assumeTrue("Wi-Fi Direct is physical-radio-only; pass -e includeWifiDirect 1 on real radios",
                "1".equals(InstrumentationRegistry.getArguments().getString("includeWifiDirect")));
    }

    private static byte[] deterministicPayload() {
        byte[] b = new byte[PAYLOAD_SIZE];
        new Random(0xD15EC7L).nextBytes(b);
        return b;
    }

    private final BlockingQueue<Socket> socketQ = new LinkedBlockingQueue<>();
    private final AtomicBoolean serverStarted = new AtomicBoolean(false);
    private final AtomicBoolean clientStarted = new AtomicBoolean(false);
    private WifiP2pManager manager;
    private WifiP2pManager.Channel channel;
    private BroadcastReceiver receiver;
    private ServerSocket serverSocket;

    @SuppressWarnings("MissingPermission") // runtime-granted by the radio harness
    private Socket formGroupAndConnect() throws InterruptedException {
        Context ctx = ctx();
        manager = (WifiP2pManager) ctx.getSystemService(Context.WIFI_P2P_SERVICE);
        assertNotNull("Wi-Fi Direct (WifiP2pManager) unavailable", manager);
        channel = manager.initialize(ctx, ctx.getMainLooper(), null);
        assertNotNull("Wi-Fi Direct channel init failed", channel);

        IntentFilter filter = new IntentFilter();
        filter.addAction(WifiP2pManager.WIFI_P2P_PEERS_CHANGED_ACTION);
        filter.addAction(WifiP2pManager.WIFI_P2P_CONNECTION_CHANGED_ACTION);
        receiver = new BroadcastReceiver() {
            @Override
            @SuppressWarnings("MissingPermission")
            public void onReceive(Context c, Intent intent) {
                String action = intent.getAction();
                if (action == null) return;
                if (WifiP2pManager.WIFI_P2P_PEERS_CHANGED_ACTION.equals(action)) {
                    manager.requestPeers(channel, peers -> {
                        if (peers.getDeviceList().isEmpty()) return;
                        WifiP2pConfig config = new WifiP2pConfig();
                        config.deviceAddress = peers.getDeviceList().iterator().next().deviceAddress;
                        manager.connect(channel, config, null);
                    });
                } else if (WifiP2pManager.WIFI_P2P_CONNECTION_CHANGED_ACTION.equals(action)) {
                    manager.requestConnectionInfo(channel, this::onConnectionInfo);
                }
            }

            private void onConnectionInfo(WifiP2pInfo info) {
                if (info == null || !info.groupFormed) return;
                if (info.isGroupOwner) {
                    if (serverStarted.compareAndSet(false, true)) startServer();
                } else if (clientStarted.compareAndSet(false, true)) {
                    connectClient(info.groupOwnerAddress.getHostAddress());
                }
            }
        };
        ctx.registerReceiver(receiver, filter);
        manager.discoverPeers(channel, null);
        return socketQ.poll(TIMEOUT_SECONDS, TimeUnit.SECONDS);
    }

    private void startServer() {
        new Thread(() -> {
            try {
                serverSocket = new ServerSocket(DATA_PORT);
                socketQ.offer(serverSocket.accept());
            } catch (IOException ignored) {
                // never accepted — formGroupAndConnect() times out and the test fails
            }
        }).start();
    }

    private void connectClient(String host) {
        new Thread(() -> {
            try {
                Socket socket = new Socket();
                socket.bind(null);
                socket.connect(new InetSocketAddress(host, DATA_PORT), SOCKET_TIMEOUT_MS);
                socketQ.offer(socket);
            } catch (IOException ignored) {
                // never connected — formGroupAndConnect() times out and the test fails
            }
        }).start();
    }

    @SuppressWarnings("MissingPermission")
    private void teardown() {
        try {
            if (manager != null && channel != null) {
                manager.cancelConnect(channel, null);
                manager.removeGroup(channel, null);
                manager.stopPeerDiscovery(channel, null);
            }
            if (serverSocket != null) serverSocket.close();
            if (receiver != null) ctx().unregisterReceiver(receiver);
        } catch (Exception ignored) {
            // best-effort cleanup
        }
    }

    // --- device A: form group, read one length-prefixed frame -----------------------

    @Test
    public void wifiDirectReceive() throws Exception {
        assumeWifiDirectRequested();
        Socket socket = formGroupAndConnect();
        assertNotNull("Wi-Fi Direct group/socket never formed over netsim virtio-wifi", socket);
        try {
            DataInputStream in = new DataInputStream(socket.getInputStream());
            int len = in.readInt();
            byte[] buf = new byte[len];
            in.readFully(buf);
            assertArrayEquals("Wi-Fi Direct frame corrupted in transit", deterministicPayload(), buf);
            Thread.sleep(1000);
        } finally {
            socket.close();
            teardown();
        }
    }

    // --- device B: form group, write one length-prefixed frame ----------------------

    @Test
    public void wifiDirectSend() throws Exception {
        assumeWifiDirectRequested();
        Socket socket = formGroupAndConnect();
        assertNotNull("Wi-Fi Direct group/socket never formed over netsim virtio-wifi", socket);
        try {
            DataOutputStream out = new DataOutputStream(socket.getOutputStream());
            byte[] payload = deterministicPayload();
            out.writeInt(payload.length);
            out.write(payload);
            out.flush();
            Thread.sleep(3000);
        } finally {
            socket.close();
            teardown();
        }
    }
}

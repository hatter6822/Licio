// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-R.15.4d — the Wi-Fi Direct courier transport (OFFLINE_SPEC §22.5).  A second native
// radio channel beside Nearby Connections, following the SAME plugin pattern + the SAME
// JS-facing event surface (`connectionResult` / `payloadReceived` / `disconnected`,
// base64 BYTES), so the TS `NativeChannelMedium` + `CourierController` drive it
// identically.  It is a DUMB byte pipe: no content validation here; every frame is
// re-validated against its CIDs/COSE signatures on the TS side (§18.4, no transport
// trust).  PUBLIC-ONLY at the seam; off by default; no radio/peer identifier ever leaves
// to an LCAP schema (a WifiP2p device address is a live-connection routing handle only).
//
// Data path: `WifiP2pManager.discoverPeers` finds nearby peers; `connect` forms a group;
// the group OWNER opens a `ServerSocket` on a fixed port and the client dials the group-
// owner IP.  Each side reads/writes length-prefixed BYTES frames over the socket.  This
// mirrors the canonical Android Wi-Fi Direct file-transfer pattern.
//
// Verification: exercisable on the emulator's virtio-wifi via netsim (the WS-R.15.4f
// radio bus) — the same approach the Nearby radio E2E uses.

package app.licio.courier;

import android.Manifest;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.net.wifi.p2p.WifiP2pConfig;
import android.net.wifi.p2p.WifiP2pInfo;
import android.net.wifi.p2p.WifiP2pManager;
import android.util.Base64;

import androidx.annotation.NonNull;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;

import java.io.DataInputStream;
import java.io.DataOutputStream;
import java.io.IOException;
import java.net.InetSocketAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * Wi-Fi Direct courier bridge.  Permissions: the modern NEARBY_WIFI_DEVICES (API 33+,
 * neverForLocation), fine location for pre-33 Wi-Fi scanning, and the Wi-Fi/network state
 * the WifiP2pManager needs.  A `cluster`-equivalent many-device flow is not native to
 * Wi-Fi Direct (one group at a time), so this connects to a single peer per session.
 */
@CapacitorPlugin(
    name = "WifiDirectCourier",
    permissions = {
        @Permission(alias = "nearbyWifi", strings = { Manifest.permission.NEARBY_WIFI_DEVICES }),
        @Permission(alias = "location", strings = {
            Manifest.permission.ACCESS_FINE_LOCATION,
            Manifest.permission.ACCESS_COARSE_LOCATION
        })
    }
)
public class WifiDirectCourierPlugin extends Plugin {

    private static final int DATA_PORT = 8989;
    private static final int SOCKET_TIMEOUT_MS = 10_000;
    private static final int MAX_FRAME_BYTES = 64 * 1024 * 1024; // §22.5 bounded pack

    private WifiP2pManager manager;
    private WifiP2pManager.Channel channel;
    private final AtomicBoolean running = new AtomicBoolean(false);
    private BroadcastReceiver receiver;
    // endpointId (the group-owner host) -> the connected data socket's output stream.
    private final ConcurrentHashMap<String, DataOutputStream> outbound = new ConcurrentHashMap<>();
    private ServerSocket serverSocket;

    @Override
    public void load() {
        manager = (WifiP2pManager) getContext().getSystemService(Context.WIFI_P2P_SERVICE);
        if (manager != null) {
            channel = manager.initialize(getContext(), getContext().getMainLooper(), null);
        }
    }

    // --- §22.5 advertise / discover -------------------------------------------------

    @PluginMethod
    @SuppressWarnings("MissingPermission") // declared per-API in the manifest; runtime-granted by the gate
    public void startAdvertising(PluginCall call) {
        // Wi-Fi Direct has no separate advertise vs. discover — discoverPeers makes the
        // device both visible and a discoverer.  We register the connection-info receiver
        // and start discovery so the group can form.
        startDiscovery(call);
    }

    @PluginMethod
    @SuppressWarnings("MissingPermission")
    public void startDiscovery(PluginCall call) {
        if (manager == null || channel == null) {
            call.reject("wifi_direct_unavailable");
            return;
        }
        registerReceiver();
        running.set(true);
        manager.discoverPeers(channel, new WifiP2pManager.ActionListener() {
            @Override
            public void onSuccess() {
                call.resolve();
            }

            @Override
            public void onFailure(int reason) {
                call.reject("discovery_failed_" + reason);
            }
        });
    }

    @PluginMethod
    public void stop(PluginCall call) {
        running.set(false);
        if (manager != null && channel != null) {
            manager.stopPeerDiscovery(channel, null);
            manager.cancelConnect(channel, null);
            manager.removeGroup(channel, null);
        }
        closeServerSocket();
        outbound.clear();
        unregisterReceiver();
        call.resolve();
    }

    // --- chunked payload send -------------------------------------------------------

    @PluginMethod
    public void send(PluginCall call) {
        String endpointId = call.getString("endpointId");
        String message = call.getString("message");
        if (endpointId == null || message == null) {
            call.reject("missing endpointId or message");
            return;
        }
        DataOutputStream out = outbound.get(endpointId);
        if (out == null) {
            call.reject("endpoint_not_connected");
            return;
        }
        byte[] bytes = Base64.decode(message, Base64.NO_WRAP);
        new Thread(() -> {
            try {
                synchronized (out) {
                    out.writeInt(bytes.length);
                    out.write(bytes);
                    out.flush();
                }
                call.resolve();
            } catch (IOException e) {
                call.reject("send_failed", e);
            }
        }).start();
    }

    // --- Wi-Fi Direct connection plumbing -------------------------------------------

    private void registerReceiver() {
        if (receiver != null) return;
        IntentFilter filter = new IntentFilter();
        filter.addAction(WifiP2pManager.WIFI_P2P_PEERS_CHANGED_ACTION);
        filter.addAction(WifiP2pManager.WIFI_P2P_CONNECTION_CHANGED_ACTION);
        receiver = new BroadcastReceiver() {
            @Override
            @SuppressWarnings("MissingPermission")
            public void onReceive(Context context, Intent intent) {
                String action = intent.getAction();
                if (action == null || manager == null || channel == null) return;
                if (WifiP2pManager.WIFI_P2P_PEERS_CHANGED_ACTION.equals(action)) {
                    manager.requestPeers(channel, peers -> {
                        if (!running.get() || peers.getDeviceList().isEmpty()) return;
                        // Connect to the first discovered peer (single-group transport).
                        WifiP2pConfig config = new WifiP2pConfig();
                        config.deviceAddress = peers.getDeviceList().iterator().next().deviceAddress;
                        manager.connect(channel, config, null);
                    });
                } else if (WifiP2pManager.WIFI_P2P_CONNECTION_CHANGED_ACTION.equals(action)) {
                    manager.requestConnectionInfo(channel, WifiDirectCourierPlugin.this::onConnectionInfo);
                }
            }
        };
        getContext().registerReceiver(receiver, filter);
    }

    private void unregisterReceiver() {
        if (receiver != null) {
            try {
                getContext().unregisterReceiver(receiver);
            } catch (IllegalArgumentException ignored) {
                // not registered
            }
            receiver = null;
        }
    }

    private void onConnectionInfo(WifiP2pInfo info) {
        if (info == null || !info.groupFormed) return;
        if (info.isGroupOwner) {
            startServerSocket();
        } else {
            String host = info.groupOwnerAddress.getHostAddress();
            connectClientSocket(host);
        }
    }

    /** The group owner accepts inbound data sockets and reads length-prefixed frames. */
    private void startServerSocket() {
        new Thread(() -> {
            try {
                closeServerSocket();
                serverSocket = new ServerSocket(DATA_PORT);
                while (running.get()) {
                    Socket socket = serverSocket.accept();
                    handleSocket(socket, socket.getInetAddress().getHostAddress());
                }
            } catch (IOException ignored) {
                // socket closed on stop — non-fatal
            }
        }).start();
    }

    /** The client dials the group-owner host and reads length-prefixed frames. */
    private void connectClientSocket(String host) {
        new Thread(() -> {
            try {
                Socket socket = new Socket();
                socket.bind(null);
                socket.connect(new InetSocketAddress(host, DATA_PORT), SOCKET_TIMEOUT_MS);
                handleSocket(socket, host);
            } catch (IOException e) {
                emitConnectionResult(host, false);
            }
        }).start();
    }

    private void handleSocket(Socket socket, String endpointId) {
        try {
            DataOutputStream out = new DataOutputStream(socket.getOutputStream());
            DataInputStream in = new DataInputStream(socket.getInputStream());
            outbound.put(endpointId, out);
            emitConnectionResult(endpointId, true);
            while (running.get() && !socket.isClosed()) {
                int len = in.readInt();
                if (len < 0 || len > MAX_FRAME_BYTES) break; // bounded frame, fail-closed
                byte[] bytes = new byte[len];
                in.readFully(bytes);
                emitPayload(endpointId, bytes);
            }
        } catch (IOException ignored) {
            // peer closed — fall through to disconnect
        } finally {
            outbound.remove(endpointId);
            try {
                socket.close();
            } catch (IOException ignored) {
                // already closed
            }
            emitDisconnected(endpointId);
        }
    }

    private void closeServerSocket() {
        if (serverSocket != null) {
            try {
                serverSocket.close();
            } catch (IOException ignored) {
                // already closed
            }
            serverSocket = null;
        }
    }

    // --- JS events (identical surface to NearbyCourier) -----------------------------

    private void emitConnectionResult(String endpointId, boolean connected) {
        JSObject ev = new JSObject();
        ev.put("endpointId", endpointId);
        ev.put("connected", connected);
        notifyListeners("connectionResult", ev);
    }

    private void emitPayload(String endpointId, @NonNull byte[] bytes) {
        JSObject ev = new JSObject();
        ev.put("endpointId", endpointId);
        ev.put("message", Base64.encodeToString(bytes, Base64.NO_WRAP));
        notifyListeners("payloadReceived", ev);
    }

    private void emitDisconnected(String endpointId) {
        JSObject ev = new JSObject();
        ev.put("endpointId", endpointId);
        notifyListeners("disconnected", ev);
    }
}

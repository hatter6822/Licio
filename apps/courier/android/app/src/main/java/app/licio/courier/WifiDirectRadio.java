// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-R.15.4d — the Wi-Fi Direct courier RADIO DRIVER (OFFLINE_SPEC §22.5), decoupled from
// Capacitor.  The testable companion of the humble-object split: the `WifiP2pManager`
// group-formation orchestration (discoverPeers → requestPeers → connect → connectionInfo →
// the group OWNER opens a `ServerSocket`, the client dials the group-owner IP) + the
// length-prefixed socket data path all live here over a `Context` + a `CourierRadio.Events`
// callback — NO Capacitor, NO base64.  `WifiDirectCourierPlugin` is the thin Capacitor shim.
//
// This is the leg that CANNOT run on two stock netsim emulators (netsim bridges only
// Bluetooth, not Wi-Fi), so unit coverage matters most here: the Layer-2 Robolectric test
// (shadowed `WifiP2pManager`) drives the orchestration, and the socket data path is the pure
// `CourierFraming.readFramedStream` (covered by `CourierFramingTest`) over a loopback socket —
// all with NO radio / device / root.  DUMB byte pipe (frames re-validated on the TS side,
// §18.4); PUBLIC-ONLY; off by default.

package app.licio.courier;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.net.wifi.p2p.WifiP2pConfig;
import android.net.wifi.p2p.WifiP2pInfo;
import android.net.wifi.p2p.WifiP2pManager;

import java.io.DataOutputStream;
import java.io.IOException;
import java.net.InetSocketAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.atomic.AtomicBoolean;

public class WifiDirectRadio implements CourierRadio {

    static final int DATA_PORT = 8989;
    private static final int SOCKET_TIMEOUT_MS = 10_000;

    private final Context ctx;
    private final CourierRadio.Events events;
    private final WifiP2pManager manager;
    private final WifiP2pManager.Channel channel;
    private final AtomicBoolean running = new AtomicBoolean(false);
    // Claimed when a formed group's socket is set up; blocks duplicate CONNECTION_CHANGED callbacks
    // for the SAME group from racing a second server/client socket.  Reset when the group dissolves.
    private final AtomicBoolean groupActive = new AtomicBoolean(false);
    private BroadcastReceiver receiver;
    // endpointId (the peer host) -> the connected data socket's output stream.
    private final ConcurrentHashMap<String, DataOutputStream> outbound = new ConcurrentHashMap<>();
    private volatile ServerSocket serverSocket;
    // Live data sockets, closed on stop() so a thread blocked in a socket read unblocks.
    private final Set<Socket> liveSockets = ConcurrentHashMap.newKeySet();
    // Bounded daemon executor for sends (replaces unbounded thread-per-send).
    private final ExecutorService sendExecutor = CourierStreamLink.newSendExecutor("wifi-direct-send");

    public WifiDirectRadio(Context ctx, CourierRadio.Events events) {
        this.ctx = ctx;
        this.events = events;
        this.manager = (WifiP2pManager) ctx.getSystemService(Context.WIFI_P2P_SERVICE);
        this.channel = manager != null ? manager.initialize(ctx, ctx.getMainLooper(), null) : null;
    }

    @Override
    public boolean isAvailable() {
        return manager != null && channel != null;
    }

    /** Wi-Fi Direct has no separate advertise vs. discover — discovery makes the device both. */
    @Override
    public void startAdvertising() {
        startDiscovery();
    }

    @Override
    @SuppressWarnings("MissingPermission") // declared per-API in the manifest; runtime-granted by the gate
    public void startDiscovery() {
        if (manager == null || channel == null) return;
        // Idempotent: the controller may call startAdvertising() AND startDiscovery(), and advertise
        // delegates here — without this guard a second discoverPeers is issued, which Android can
        // reject as busy, and the onStartFailed path would then tear down the discovery the first
        // call already started.
        if (running.getAndSet(true)) return;
        registerReceiver();
        // A discovery failure (async onFailure, or a framework throw — SecurityException /
        // DeadObjectException / IllegalStateException — for missing permission, Wi-Fi Direct
        // disabled, or framework state) means no discovery is running, so SURFACE it via
        // onStartFailed rather than dropping it (else the caller believes the radio is running).
        try {
            manager.discoverPeers(channel, new WifiP2pManager.ActionListener() {
                @Override
                public void onSuccess() {}

                @Override
                public void onFailure(int reason) {
                    events.onStartFailed("discover",
                            new IllegalStateException("wifi_p2p_discover_failed_" + reason));
                }
            });
        } catch (RuntimeException e) {
            events.onStartFailed("discover", e);
        }
    }

    @Override
    public void stop() {
        running.set(false);
        groupActive.set(false); // a fresh start must be able to set up the group's sockets again
        if (manager != null && channel != null) {
            // Best-effort teardown — the framework can throw if the channel is mid-operation;
            // a stop must never propagate (it runs on a PluginCall + in cleanup paths).
            try {
                manager.stopPeerDiscovery(channel, null);
                manager.cancelConnect(channel, null);
                manager.removeGroup(channel, null);
            } catch (RuntimeException ignored) {
                // channel not fully established / framework state — non-fatal
            }
        }
        closeServerSocket();
        // Close live data sockets so a thread blocked mid-frame read unblocks + exits.
        for (Socket s : liveSockets) {
            try {
                s.close();
            } catch (IOException ignored) {
                // already closed
            }
        }
        liveSockets.clear();
        outbound.clear();
        unregisterReceiver();
    }

    @Override
    public void send(String endpointId, byte[] payload, CourierRadio.SendResult result) {
        DataOutputStream out = outbound.get(endpointId);
        if (out == null) {
            result.onError("endpoint_not_connected", null);
            return;
        }
        CourierStreamLink.send(sendExecutor, out, payload, result); // bounded executor (not thread-per-send)
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
                    manager.requestConnectionInfo(channel, WifiDirectRadio.this::onConnectionInfo);
                }
            }
        };
        ctx.registerReceiver(receiver, filter);
    }

    private void unregisterReceiver() {
        if (receiver != null) {
            try {
                ctx.unregisterReceiver(receiver);
            } catch (IllegalArgumentException ignored) {
                // not registered
            }
            receiver = null;
        }
    }

    /** Decide the role once the group forms: owner runs the server, the client dials it.  The
     *  socket data path both branches dispatch to is unit-tested via `CourierStreamLink` (pipes);
     *  this thin role decision + the bind/accept/connect socket setup are exercised on real radios
     *  (a unit test would have to bind the fixed `DATA_PORT`, which the no-fixed-port policy avoids). */
    void onConnectionInfo(WifiP2pInfo info) {
        if (info == null || !info.groupFormed) {
            // The group dissolved — allow the NEXT formation to set up its sockets again.
            groupActive.set(false);
            return;
        }
        // Android may deliver CONNECTION_CHANGED more than once for the SAME formed group; claim the
        // setup atomically and only ONCE per group, so the owner doesn't reopen its server socket and
        // the client doesn't dial twice (duplicate links/events).  The claim happens only when a
        // socket is actually started, so a client callback whose owner address isn't known yet does
        // not consume the slot — a later callback with the address can still dial.
        if (info.isGroupOwner) {
            if (groupActive.compareAndSet(false, true)) startServerSocket();
        } else if (info.groupOwnerAddress != null) {
            if (groupActive.compareAndSet(false, true)) {
                connectClientSocket(info.groupOwnerAddress.getHostAddress());
            }
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
                // No socket was established (owner not listening yet / connect refused) — RELEASE the
                // per-group claim so a later CONNECTION_CHANGED for the still-formed group can retry
                // the dial instead of being skipped until the group dissolves.
                groupActive.set(false);
                events.onConnectionResult(host, false);
            }
        }).start();
    }

    private void handleSocket(Socket socket, String endpointId) {
        liveSockets.add(socket); // tracked so stop() can unblock the read below
        try {
            // The shared blocking-stream data-path (CourierStreamLinkTest covers it via pipes).
            CourierStreamLink.run(socket.getInputStream(), socket.getOutputStream(), socket,
                    endpointId, outbound, events, () -> running.get() && !socket.isClosed());
        } catch (IOException e) {
            // opening the streams failed before the link ran — still announce the drop
            try {
                socket.close();
            } catch (IOException ignored) {
                // already closed
            }
            events.onDisconnected(endpointId);
        } finally {
            liveSockets.remove(socket);
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
}

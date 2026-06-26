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
    // Held while a manager.connect() request is outstanding so a PEERS_CHANGED refresh during group
    // formation does not issue a duplicate connect (which Android rejects BUSY, whose failure handler
    // would tear down the forming courier).  Cleared once the connection state resolves.
    private final AtomicBoolean connectPending = new AtomicBoolean(false);
    // The controller calls startAdvertising() and/or startDiscovery() — possibly as SEPARATE async
    // PluginCalls — so these record WHICH were requested; applyMode() picks ONE coherent Wi-Fi mode
    // and UPGRADES advertise-only → discovery if discovery arrives second.  Reset on stop().
    private final AtomicBoolean advertiseRequested = new AtomicBoolean(false);
    private final AtomicBoolean discoverRequested = new AtomicBoolean(false);

    /** The active Wi-Fi Direct mode: NONE, GROUP (advertise-only group owner, no scan), or DISCOVER
     *  (discoverPeers — scans + discoverable).  Tracked so applyMode() can upgrade GROUP→DISCOVER.
     *  Package-private so the JVM test can assert the upgrade landed (a benign read of the enum). */
    enum WifiMode { NONE, GROUP, DISCOVER }

    volatile WifiMode currentMode = WifiMode.NONE;
    // A monotonic START GENERATION bumped on every start (applyMode) and stop().  A native
    // WifiP2pManager.ActionListener captures the generation it was issued under; a STALE failure
    // (e.g. a previous discoverPeers refusal) arriving after a quick Stop→Start / live restart is
    // then dropped BEFORE it emits onStartFailed — otherwise the plugin would forward it to the new
    // controller's listener and tear the FRESH Wi-Fi Direct courier down (#1).
    // Package-private so the JVM test can assert the guard (a captured generation goes stale across
    // a stop/restart) — the native ActionListener cannot itself be invoked under Robolectric.
    volatile long startGeneration = 0;
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

    @Override
    public void startAdvertising() {
        advertiseRequested.set(true);
        applyMode();
    }

    @Override
    public void startDiscovery() {
        discoverRequested.set(true);
        applyMode();
    }

    /**
     * Pick (and UPGRADE) the Wi-Fi Direct mode from the requested directions.  Wi-Fi Direct has no
     * PASSIVE advertise: {@code discoverPeers()} ALSO scans, so advertising via discovery would
     * violate a discovery-OFF privacy choice.  So: when DISCOVERY is requested, run discoverPeers
     * (scans + discoverable); for advertise-ONLY, become a group OWNER via createGroup (discoverable
     * WITHOUT scanning).  Crucially this is SYNCHRONOUS + idempotent: because advertise and discover
     * arrive as separate async PluginCalls, a discovery request that lands AFTER advertise-only chose
     * createGroup UPGRADES the radio (removeGroup → discoverPeers) instead of leaving it non-scanning.
     */
    private synchronized void applyMode() {
        if (manager == null || channel == null) return;
        if (discoverRequested.get()) {
            if (currentMode == WifiMode.DISCOVER) return; // already scanning
            if (currentMode == WifiMode.GROUP) {
                // UPGRADE advertise-only → discovery: tear the group-owner group down so we can scan.
                try {
                    manager.removeGroup(channel, null);
                } catch (RuntimeException ignored) {
                    // not formed / framework state — non-fatal; discoverPeers proceeds
                }
            }
            currentMode = WifiMode.DISCOVER;
            running.set(true);
            registerReceiver();
            discoverPeers(++startGeneration);
        } else if (advertiseRequested.get()) {
            if (currentMode != WifiMode.NONE) return; // advertise never downgrades an active mode
            currentMode = WifiMode.GROUP;
            running.set(true);
            registerReceiver();
            createGroup(++startGeneration);
        }
    }

    /** A late ActionListener callback whose captured generation no longer matches the current start
     *  is STALE (a stop/restart happened since it was issued) — drop it before emitting any event.
     *  Package-private for the JVM test (Robolectric cannot invoke the native ActionListener). */
    boolean isStale(long generation) {
        return generation != startGeneration;
    }

    @SuppressWarnings("MissingPermission") // declared per-API in the manifest; runtime-granted by the gate
    private void discoverPeers(final long generation) {
        // A discovery failure (async onFailure, or a framework throw — SecurityException /
        // DeadObjectException / IllegalStateException) means no discovery is running, so SURFACE it
        // via onStartFailed rather than dropping it (else the caller believes it is running) — unless
        // a stop/restart has since superseded this start (a stale failure must not tear the new one down).
        try {
            manager.discoverPeers(channel, new WifiP2pManager.ActionListener() {
                @Override
                public void onSuccess() {}

                @Override
                public void onFailure(int reason) {
                    if (isStale(generation)) return;
                    events.onStartFailed("discover",
                            new IllegalStateException("wifi_p2p_discover_failed_" + reason));
                }
            });
        } catch (RuntimeException e) {
            if (!isStale(generation)) events.onStartFailed("discover", e);
        }
    }

    @SuppressWarnings("MissingPermission")
    private void createGroup(final long generation) {
        try {
            manager.createGroup(channel, new WifiP2pManager.ActionListener() {
                @Override
                @SuppressWarnings("MissingPermission")
                public void onSuccess() {
                    if (isStale(generation)) return;
                    // The group forms asynchronously; pull connection info so an already-formed group
                    // still drives onConnectionInfo → the group-owner server socket.  Tag the result
                    // with this start's generation so a Stale callback after a restart is dropped (#A).
                    manager.requestConnectionInfo(channel, info -> onConnectionInfo(generation, info));
                }

                @Override
                @SuppressWarnings("MissingPermission")
                public void onFailure(int reason) {
                    if (isStale(generation)) return;
                    // BUSY means a group already exists — drive setup from it rather than failing;
                    // any other reason is a real advertise failure to surface.
                    if (reason == WifiP2pManager.BUSY) {
                        manager.requestConnectionInfo(channel, info -> onConnectionInfo(generation, info));
                    } else {
                        events.onStartFailed("advertise",
                                new IllegalStateException("wifi_p2p_create_group_failed_" + reason));
                    }
                }
            });
        } catch (RuntimeException e) {
            if (!isStale(generation)) events.onStartFailed("advertise", e);
        }
    }

    @Override
    public void stop() {
        running.set(false);
        startGeneration++; // invalidate any in-flight ActionListener callbacks (a stale failure is dropped)
        currentMode = WifiMode.NONE; // a fresh start re-decides the mode from its own requests
        groupActive.set(false); // a fresh start must be able to set up the group's sockets again
        connectPending.set(false); // drop any in-flight connect claim so a restart can connect
        advertiseRequested.set(false);
        discoverRequested.set(false);
        if (manager != null && channel != null) {
            // Best-effort teardown — the framework can throw if the channel is mid-operation; a stop
            // must never propagate (it runs on a PluginCall + in cleanup paths).  Each call is wrapped
            // INDEPENDENTLY so one best-effort failure (e.g. stopPeerDiscovery throwing) never skips
            // cancelConnect / removeGroup and leaves the group or discoverability alive (#AL).
            try {
                manager.stopPeerDiscovery(channel, null);
            } catch (RuntimeException ignored) {
                // not discovering / framework state — non-fatal
            }
            try {
                manager.cancelConnect(channel, null);
            } catch (RuntimeException ignored) {
                // no connect in flight / framework state — non-fatal
            }
            try {
                manager.removeGroup(channel, null);
            } catch (RuntimeException ignored) {
                // no group formed / framework state — non-fatal
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
                    // A peer list is only actionable while DISCOVERING.  A delayed PEERS_CHANGED for an
                    // OLD discovery run can arrive after a Stop→Start into advertise-only GROUP mode;
                    // since `peersGen` is captured at broadcast time it would NOT look stale, so it
                    // could call connect() and violate the discovery-off mode — drop it unless we are
                    // currently in DISCOVER mode (#S).
                    if (currentMode != WifiMode.DISCOVER) return;
                    // Capture the current generation: a peers result delivered after a same-mode
                    // Stop→Start is still dropped by the isStale gate below.
                    final long peersGen = startGeneration;
                    manager.requestPeers(channel, peers -> {
                        if (!running.get() || isStale(peersGen) || peers.getDeviceList().isEmpty()) {
                            return;
                        }
                        // Skip a fresh connect while a group/socket is already set up (a harmless
                        // peer-list refresh must not tear down a working courier) or a connect is
                        // already in flight — either case would issue a duplicate connect Android
                        // rejects BUSY, whose failure handler reports startFailed.
                        if (groupActive.get()) return;
                        if (!connectPending.compareAndSet(false, true)) return;
                        // Connect to the first discovered peer (single-group transport).
                        final long connectGen = startGeneration; // a stop/restart invalidates this connect
                        WifiP2pConfig config = new WifiP2pConfig();
                        config.deviceAddress = peers.getDeviceList().iterator().next().deviceAddress;
                        manager.connect(channel, config, new WifiP2pManager.ActionListener() {
                            @Override
                            @SuppressWarnings("MissingPermission")
                            public void onSuccess() {
                                // The connect REQUEST was accepted; the group forms asynchronously.
                                // The CONNECTION_CHANGED broadcast is the primary trigger, but pull
                                // the connection info now too so an ALREADY-formed group (or a missed
                                // broadcast) still drives onConnectionInfo → the socket setup (which
                                // clears connectPending once the connection state resolves).
                                manager.requestConnectionInfo(
                                        channel, info -> onConnectionInfo(connectGen, info));
                            }

                            @Override
                            public void onFailure(int reason) {
                                // Check staleness FIRST: a connect failure from an OLD discovery run
                                // can arrive after a Stop→Start has set connectPending for the NEW
                                // run's own dial — clearing it here would let the next peer-list
                                // refresh issue a DUPLICATE connect (BUSY/startFailed) against the
                                // fresh courier (#Z).  A superseded failure is simply dropped.
                                if (isStale(connectGen)) return;
                                // The connect was rejected (peer gone / BUSY / ERROR) — release the
                                // in-flight claim so a later refresh can retry, and surface it instead
                                // of swallowing the async failure, so the courier doesn't stay
                                // "running" with no socket setup and no retry.
                                connectPending.set(false);
                                events.onStartFailed("connect",
                                        new IllegalStateException("wifi_p2p_connect_failed_" + reason));
                            }
                        });
                    });
                } else if (WifiP2pManager.WIFI_P2P_CONNECTION_CHANGED_ACTION.equals(action)) {
                    // Capture the CURRENT generation at broadcast time; if a Stop→Start runs before
                    // this result returns, onConnectionInfo drops it as stale (#A).
                    final long infoGen = startGeneration;
                    manager.requestConnectionInfo(channel, info -> onConnectionInfo(infoGen, info));
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
    void onConnectionInfo(long generation, WifiP2pInfo info) {
        // A queued requestConnectionInfo callback delivered AFTER stop() must not claim groupActive
        // or start any socket setup — stop() already cleared the claims, and a late claim here would
        // block the next start until Android reports the group dissolved.
        if (!running.get()) return;
        // A result from a SUPERSEDED group (the requestConnectionInfo was issued under a previous
        // start, then a Stop→Start ran before this callback) must be dropped — else it could claim
        // groupActive + open a server/client socket for the OLD group under the new controller (#A).
        if (isStale(generation)) return;
        if (info == null || !info.groupFormed) {
            // Release the per-group claim, AND clear the connect claim ONLY if a group had actually
            // formed (this is a dissolve).  An EARLY post-connect snapshot (groupFormed not yet true,
            // never been active — common WHILE formation is still in progress) must KEEP
            // connectPending, or a PEERS_CHANGED refresh would issue a duplicate connect (BUSY →
            // startFailed) that tears down the forming courier.
            boolean wasActive = groupActive.getAndSet(false);
            if (wasActive) connectPending.set(false);
            return;
        }
        // Android may deliver CONNECTION_CHANGED more than once for the SAME formed group; claim the
        // setup atomically and only ONCE per group, so the owner doesn't reopen its server socket and
        // the client doesn't dial twice (duplicate links/events).  The claim happens only when a
        // socket is actually started, so a client callback whose owner address isn't known yet does
        // not consume the slot — a later callback with the address can still dial.
        if (info.isGroupOwner) {
            if (groupActive.compareAndSet(false, true)) startServerSocket();
            connectPending.set(false); // the group is up — no client connect is in flight
        } else if (info.groupOwnerAddress != null) {
            if (groupActive.compareAndSet(false, true)) {
                connectClientSocket(info.groupOwnerAddress.getHostAddress());
            }
            connectPending.set(false); // the owner address is known — the connect has resolved
        }
        // else: groupFormed but the client's owner address is not known yet — leave connectPending
        // set; a later CONNECTION_CHANGED re-fires onConnectionInfo with the address.
    }

    /** The group owner accepts inbound data sockets and reads length-prefixed frames. */
    private void startServerSocket() {
        final long serverGen = startGeneration; // a stop/restart invalidates this server setup
        new Thread(() -> {
            if (isStale(serverGen)) return; // a newer start superseded this thread before it ran (#KK)
            closeServerSocket();
            ServerSocket server;
            try {
                server = new ServerSocket(DATA_PORT);
            } catch (IOException e) {
                // The data port could not be bound (a stale listener / another process holds 8989).
                // groupActive was claimed by onConnectionInfo BEFORE this thread ran, so RELEASE it
                // (a later connection-info callback for the same group can retry) and SURFACE the
                // failure — otherwise the controller would show Wi-Fi Direct as running with no
                // server socket while the stale claim blocks every retry.  But ONLY when this thread is
                // still current: a stale-generation bind failure (an old group after a Stop→Start) must
                // NOT release the FRESH session's claim, or later broadcasts could start duplicate
                // listeners/dials against the current courier (#AI).
                if (!isStale(serverGen)) {
                    groupActive.set(false);
                    events.onStartFailed("server_bind", e);
                }
                return;
            }
            serverSocket = server;
            // stop()/restart may have run between its running flip and the assignment above; if a stop
            // has happened OR a Stop→Start SUPERSEDED this setup (running is true again for the NEW
            // session, so the running flag alone can't tell), close the freshly-bound listener now so
            // the OLD group's data port never opens under the fresh controller (#U).
            if (!running.get() || isStale(serverGen)) {
                closeServerSocket(server); // by value — never the fresh start's listener (#KK)
                return;
            }
            try {
                while (running.get() && !isStale(serverGen)) {
                    Socket socket = server.accept();
                    if (!running.get() || isStale(serverGen)) {
                        // stop()/restart raced this accept() — close the just-accepted socket instead
                        // of handing it to the stream link (which would announce a peer-visible link
                        // for the OLD group after a stop / under a fresh session).
                        socket.close();
                        break;
                    }
                    handleSocket(socket, socket.getInetAddress().getHostAddress());
                }
            } catch (IOException ignored) {
                // socket closed on stop — non-fatal
            } finally {
                // Close THIS thread's listener by value, so an old group-owner thread reaching here
                // after a Stop→Start never closes/nulls the fresh start's new listener (#KK).
                closeServerSocket(server);
            }
        }).start();
    }

    /** The client dials the group-owner host and reads length-prefixed frames. */
    private void connectClientSocket(String host) {
        final long connectGen = startGeneration; // a stop/restart invalidates this client setup (#U)
        new Thread(() -> {
            Socket socket = null;
            try {
                socket = new Socket();
                // Track BEFORE the blocking connect() so a concurrent stop() can close the socket and
                // interrupt the dial — otherwise a connect that completes AFTER stop() would open a
                // peer-visible link (and emit connectionResult(true)) once the courier is stopped.
                liveSockets.add(socket);
                socket.bind(null);
                socket.connect(new InetSocketAddress(host, DATA_PORT), SOCKET_TIMEOUT_MS);
                if (!running.get() || isStale(connectGen)) {
                    // Stopped DURING the dial, OR a Stop→Start superseded this connect (running is true
                    // again for the NEW session) — do not hand the OLD group's socket to the stream
                    // link (which would announce the endpoint connected for a superseded session) (#U).
                    liveSockets.remove(socket);
                    socket.close();
                    return;
                }
                handleSocket(socket, host); // returns when the data socket EOFs / errors / is stopped
            } catch (IOException e) {
                // No socket was established (owner not listening yet / connect refused / stop closed it).
                if (socket != null) {
                    liveSockets.remove(socket);
                    try {
                        socket.close();
                    } catch (IOException ignored) {
                        // already closed
                    }
                }
                events.onConnectionResult(host, false);
            } finally {
                // The client data socket has closed (connect failed, OR a live session ended by
                // EOF/error/stop) while the P2P group may STILL be formed.  Release the per-group
                // claim so a later CONNECTION_CHANGED for the still-formed group can redial — but
                // ONLY if this thread still belongs to the CURRENT session: a client thread from a
                // SUPERSEDED group (after a Stop→Start) must not release the FRESH group's claim,
                // which would let later connection-info broadcasts start duplicate dials (#PP).
                if (!isStale(connectGen)) groupActive.set(false);
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

    /** Close THIS thread's bound listener, clearing the field only if it STILL points at it — a fresh
     *  start may have already replaced it, and that new listener must not be closed/nulled (#KK). */
    private void closeServerSocket(ServerSocket server) {
        try {
            server.close();
        } catch (IOException ignored) {
            // already closed
        }
        if (serverSocket == server) serverSocket = null;
    }
}

// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-R.15.4d — the Bluetooth courier RADIO DRIVER (OFFLINE_SPEC §22.5), decoupled from
// Capacitor.  This is the testable companion of the "humble object" split: ALL the radio-
// driving logic (Bluetooth Classic RFCOMM server/client + the BLE GATT write+notify fallback
// + send routing + the framing wiring) lives here, depending only on a `Context` and a
// `RadioEvents` callback — NO Capacitor, NO base64, raw bytes throughout.  Because it is a
// plain object over the Android Bluetooth API, the Layer-2 Robolectric test (shadowed
// Android) drives its advertise / GATT-receive / lifecycle / send-routing flows with NO
// device, NO radio, NO root.  `BluetoothCourierPlugin` is the thin Capacitor shim that wires
// PluginCalls in and `RadioEvents` out (base64 at the JS boundary only).
//
// It is a DUMB byte pipe: no content validation — every frame is re-validated against its
// CIDs/COSE signatures on the TS side (§18.4, no transport trust).  PUBLIC-ONLY; off by
// default; no Bluetooth device address ever reaches an LCAP schema.

package app.licio.courier;

import android.bluetooth.BluetoothAdapter;
import android.bluetooth.BluetoothDevice;
import android.bluetooth.BluetoothGatt;
import android.bluetooth.BluetoothGattCallback;
import android.bluetooth.BluetoothGattCharacteristic;
import android.bluetooth.BluetoothGattDescriptor;
import android.bluetooth.BluetoothGattServer;
import android.bluetooth.BluetoothGattServerCallback;
import android.bluetooth.BluetoothGattService;
import android.bluetooth.BluetoothManager;
import android.bluetooth.BluetoothProfile;
import android.bluetooth.BluetoothServerSocket;
import android.bluetooth.BluetoothSocket;
import android.bluetooth.BluetoothStatusCodes;
import android.bluetooth.le.AdvertiseCallback;
import android.bluetooth.le.AdvertiseData;
import android.bluetooth.le.AdvertiseSettings;
import android.bluetooth.le.BluetoothLeAdvertiser;
import android.bluetooth.le.BluetoothLeScanner;
import android.bluetooth.le.ScanCallback;
import android.bluetooth.le.ScanFilter;
import android.bluetooth.le.ScanResult;
import android.bluetooth.le.ScanSettings;
import android.content.Context;
import android.os.Build;
import android.os.ParcelUuid;

import java.io.DataOutputStream;
import java.io.IOException;
import java.util.Arrays;
import java.util.Collections;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.atomic.AtomicBoolean;

public class BluetoothCourierRadio implements CourierRadio {

    // The fixed RFCOMM service record name + UUID couriers rendezvous on.
    private static final String SERVICE_NAME = "LicioCourierRfcomm";
    private static final UUID SERVICE_UUID = UUID.fromString("9f1c1e10-5c11-4f2a-9b3d-1a2b3c4d5e6f");

    // The BLE GATT fallback service + characteristic (WRITE central→peripheral, NOTIFY
    // peripheral→central) and the standard Client Characteristic Configuration descriptor.
    // Package-private so the Layer-2 Robolectric test can assert the service contract + drive it.
    static final UUID BLE_SERVICE_UUID = UUID.fromString("9f1c1e11-5c11-4f2a-9b3d-1a2b3c4d5e6f");
    static final UUID BLE_CHAR_UUID = UUID.fromString("9f1c1e12-5c11-4f2a-9b3d-1a2b3c4d5e6f");
    static final UUID CCC_UUID = UUID.fromString("00002902-0000-1000-8000-00805f9b34fb");
    private static final ParcelUuid BLE_SERVICE_PUUID = new ParcelUuid(BLE_SERVICE_UUID);
    private static final long BLE_ACK_TIMEOUT_MS = 30_000;

    /**
     * Build the courier's BLE GATT service: ONE characteristic that is both writable
     * (central→peripheral) and notifiable (peripheral→central) to carry chunked frames, plus
     * the standard Client Characteristic Configuration descriptor for notify subscription.
     */
    static BluetoothGattService buildCourierGattService() {
        BluetoothGattCharacteristic ch = new BluetoothGattCharacteristic(
                BLE_CHAR_UUID,
                BluetoothGattCharacteristic.PROPERTY_WRITE | BluetoothGattCharacteristic.PROPERTY_NOTIFY,
                BluetoothGattCharacteristic.PERMISSION_WRITE);
        ch.addDescriptor(new BluetoothGattDescriptor(
                CCC_UUID,
                BluetoothGattDescriptor.PERMISSION_READ | BluetoothGattDescriptor.PERMISSION_WRITE));
        BluetoothGattService service = new BluetoothGattService(
                BLE_SERVICE_UUID, BluetoothGattService.SERVICE_TYPE_PRIMARY);
        service.addCharacteristic(ch);
        return service;
    }

    private final Context ctx;
    private final CourierRadio.Events events;
    private final BluetoothAdapter adapter;
    private final AtomicBoolean running = new AtomicBoolean(false);
    private volatile BluetoothServerSocket serverSocket;
    // endpointId (the device address) -> the connected RFCOMM socket's output stream.
    private final ConcurrentHashMap<String, DataOutputStream> outbound = new ConcurrentHashMap<>();
    // Live RFCOMM sockets, closed on stop() so a thread blocked in a socket read unblocks.
    private final Set<BluetoothSocket> liveSockets = ConcurrentHashMap.newKeySet();
    // Bounded daemon executor for RFCOMM sends (replaces unbounded thread-per-send).
    private final ExecutorService sendExecutor = CourierStreamLink.newSendExecutor("rfcomm-send");

    // --- BLE GATT fallback state ----------------------------------------------------
    private volatile BluetoothGattServer gattServer;
    private BluetoothGattCharacteristic gattCharacteristic;
    private BluetoothLeAdvertiser advertiser;
    // Package-private so the JVM test can drive AdvertiseCallback.onStartFailure (Robolectric's
    // shadow does not invoke it; the advertiser==null branch is also unreachable there).
    AdvertiseCallback advertiseCallback;
    // The CURRENT GATT-server callback (recreated per startBleGattServer, capturing the generation
    // below) + the server generation it is matched against.  A DELAYED callback from a PREVIOUS
    // server (e.g. a STATE_DISCONNECTED for the old session, delivered after a Stop→Start while the
    // same central has reconnected) is delivered to its OWN (old) callback instance, whose captured
    // generation no longer matches `bleServerGeneration`, so it is dropped instead of evicting the
    // fresh central / writing stale state (#C).  Package-private so the Robolectric test can drive it.
    BluetoothGattServerCallback gattServerCallback;
    private volatile long bleServerGeneration = 0;
    // A per-SESSION generation (bumped only on stop, NOT on each advertise/discover within a session)
    // captured by the advertise + scan failure callbacks: after a quick Stop→Start, `running` is true
    // again, so an OLD AdvertiseCallback.onStartFailure / ScanCallback.onScanFailed could tear down
    // the fresh courier — the generation gate drops a failure from a superseded session (#H).
    // Package-private so the Robolectric test can read it.
    volatile long bleStartGeneration = 0;
    private final ConcurrentHashMap<String, BluetoothDevice> bleCentrals = new ConcurrentHashMap<>();
    private BluetoothLeScanner scanner;
    private ScanCallback scanCallback;
    private final ConcurrentHashMap<String, BluetoothGatt> bleClients = new ConcurrentHashMap<>();
    // Dials in flight (connectGatt issued, not yet STATE_CONNECTED): repeated scan results for the
    // same advertiser would otherwise each start ANOTHER connectGatt, leaking untracked GATTs that
    // emit duplicate connection events and survive stop(); this dedups them + lets stop() close them.
    private final ConcurrentHashMap<String, BluetoothGatt> blePendingClients = new ConcurrentHashMap<>();
    private final ConcurrentHashMap<String, BluetoothGattCharacteristic> bleClientChars = new ConcurrentHashMap<>();
    private final ConcurrentHashMap<String, Integer> bleMtu = new ConcurrentHashMap<>();
    private final ConcurrentHashMap<String, CourierFraming.FrameAssembler> assemblers = new ConcurrentHashMap<>();
    // Per-endpoint callback-driven send engine: enqueue writes the first chunk, the GATT
    // write-complete callback (onCharacteristicWrite / onNotificationSent) drives onAck, a
    // scheduled timeout fails a stalled write.  No worker thread, no blocking queue, no poll.
    private final ConcurrentHashMap<String, BleSendPump> blePumps = new ConcurrentHashMap<>();
    // Backs the per-write ack timeouts (lazily created; shut down in stopBle).
    private volatile ScheduledExecutorService bleScheduler;

    public BluetoothCourierRadio(Context ctx, CourierRadio.Events events) {
        this.ctx = ctx;
        this.events = events;
        BluetoothManager bm = (BluetoothManager) ctx.getSystemService(Context.BLUETOOTH_SERVICE);
        this.adapter = bm != null ? bm.getAdapter() : null;
    }

    /** Whether the device has a usable Bluetooth adapter that is turned ON.  A present-but-disabled
     *  adapter is NOT available — its RFCOMM/BLE setup would fail silently with no active radio. */
    @Override
    public boolean isAvailable() {
        return adapter != null && adapter.isEnabled();
    }

    // --- §22.5 advertise / discover -------------------------------------------------

    /** Listen for inbound RFCOMM + open the BLE GATT server and advertise the service UUID. */
    @SuppressWarnings("MissingPermission") // declared per-API in the manifest; runtime-granted by the gate
    @Override
    public void startAdvertising() {
        if (adapter == null || !adapter.isEnabled()) {
            events.onStartFailed("advertise", new IllegalStateException("bluetooth_off"));
            return;
        }
        running.set(true);
        startServerSocket();
        startBleGattServer();
    }

    /** Connect over RFCOMM to bonded couriers + scan for the BLE service UUID and connect. */
    @SuppressWarnings("MissingPermission")
    @Override
    public void startDiscovery() {
        if (adapter == null || !adapter.isEnabled()) {
            events.onStartFailed("discover", new IllegalStateException("bluetooth_off"));
            return;
        }
        running.set(true);
        Set<BluetoothDevice> bonded = adapter.getBondedDevices();
        for (BluetoothDevice device : bonded) {
            connectClient(device);
        }
        // When there are NO bonded peers to dial over RFCOMM, the BLE scan is the ONLY discovery
        // path, so a scan-start failure must be surfaced (else the channel shows running with no
        // active discovery).  With bonded dials in flight, a BLE failure is non-escalating (RFCOMM
        // carries) — escalating it would wrongly tear the whole channel down.
        startBleScan(bonded.isEmpty());
    }

    @Override
    public void stop() {
        running.set(false);
        closeServerSocket();
        // Close live RFCOMM sockets so a read thread blocked mid-frame unblocks (it then
        // sees running=false and exits) — `running` alone is only checked BETWEEN frames.
        for (BluetoothSocket s : liveSockets) {
            try {
                s.close();
            } catch (IOException ignored) {
                // already closed
            }
        }
        liveSockets.clear();
        stopBle();
        outbound.clear();
    }

    /**
     * Send one length-prefixed frame to a connected endpoint over whichever transport it is on
     * (RFCOMM socket or BLE GATT).  The routing decision is synchronous; the actual I/O runs on
     * a background thread and reports via {@code result}.  An unknown endpoint fails immediately.
     */
    @Override
    public void send(String endpointId, byte[] payload, CourierRadio.SendResult result) {
        DataOutputStream out = outbound.get(endpointId);
        if (out != null) {
            CourierStreamLink.send(sendExecutor, out, payload, result); // RFCOMM (bounded executor)
            return;
        }
        if (bleClients.containsKey(endpointId) || bleCentrals.containsKey(endpointId)) {
            // BLE is async + one-op-at-a-time: hand the frame to the per-endpoint pump, which
            // writes chunk-by-chunk driven by the write-complete callback (no thread/blocking).
            blePumpFor(endpointId).enqueue(payload, (ok, reason) -> {
                if (ok) {
                    result.onSuccess();
                } else {
                    result.onError(reason != null ? reason : "send_failed", null);
                }
            });
            return;
        }
        result.onError("endpoint_not_connected", null);
    }

    /** The per-endpoint BLE send pump, created on first use against the endpoint's negotiated
     *  MTU.  The chunk write + the ack timeout are the only I/O; the pump is pure. */
    private BleSendPump blePumpFor(String endpointId) {
        // Eagerly create the timeout scheduler ON THE SEND PATH and capture it (never lazily from
        // ScheduledAckTimeout.arm() — that would resurrect a scheduler stopBle() just shut down).
        ScheduledExecutorService scheduler = bleScheduler();
        return blePumps.computeIfAbsent(endpointId, ep -> {
            BleSendPump[] self = new BleSendPump[1];
            BleSendPump.Timeout timeout = new ScheduledAckTimeout(
                    scheduler, BLE_ACK_TIMEOUT_MS, epoch -> self[0].onTimeout(epoch));
            BleSendPump pump = new BleSendPump(
                    chunkSize(ep), chunk -> writeBleChunk(ep, chunk), timeout);
            self[0] = pump;
            return pump;
        });
    }

    private ScheduledExecutorService bleScheduler() {
        ScheduledExecutorService exec = bleScheduler;
        if (exec == null) {
            synchronized (this) {
                exec = bleScheduler;
                if (exec == null) {
                    exec = Executors.newSingleThreadScheduledExecutor(r -> {
                        Thread t = new Thread(r, "ble-ack-timeout");
                        t.setDaemon(true);
                        return t;
                    });
                    bleScheduler = exec;
                }
            }
        }
        return exec;
    }

    /** Write ONE chunk to a BLE endpoint (a connected client gatt, or a subscribed central via
     *  notify); returns false if the framework rejects the write synchronously (no ack follows). */
    @SuppressWarnings("MissingPermission")
    private boolean writeBleChunk(String endpointId, byte[] chunk) {
        BluetoothGatt gatt = bleClients.get(endpointId);
        if (gatt != null) {
            BluetoothGattCharacteristic ch = bleClientChars.get(endpointId);
            if (ch == null) {
                return false;
            }
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                return gatt.writeCharacteristic(ch, chunk, BluetoothGattCharacteristic.WRITE_TYPE_DEFAULT)
                        == BluetoothGatt.GATT_SUCCESS;
            }
            return writeCharacteristicLegacy(gatt, ch, chunk);
        }
        BluetoothDevice central = bleCentrals.get(endpointId);
        if (central != null && gattServer != null && gattCharacteristic != null) {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                return gattServer.notifyCharacteristicChanged(central, gattCharacteristic, false, chunk)
                        == BluetoothGatt.GATT_SUCCESS;
            }
            return notifyCharacteristicChangedLegacy(central, chunk);
        }
        return false;
    }

    // --- pre-33 (API 23..32) BLE compatibility shims ---------------------------------
    // On Android < 13 the value-carrying writeCharacteristic/notifyCharacteristicChanged/
    // writeDescriptor overloads do not exist; the older set-value-then-write methods are the
    // ONLY API available (the 33+ replacements are used directly above).  Each shim is the
    // minimal isolation of one unavoidable deprecated call, so the surrounding methods stay
    // fully deprecation-checked.  Delete these (and the SDK_INT branches) only if minSdk ≥ 33.

    @SuppressWarnings({"MissingPermission", "deprecation"})
    private static boolean writeCharacteristicLegacy(BluetoothGatt gatt,
            BluetoothGattCharacteristic ch, byte[] chunk) {
        ch.setWriteType(BluetoothGattCharacteristic.WRITE_TYPE_DEFAULT);
        ch.setValue(chunk);
        return gatt.writeCharacteristic(ch);
    }

    @SuppressWarnings({"MissingPermission", "deprecation"})
    private boolean notifyCharacteristicChangedLegacy(BluetoothDevice central, byte[] chunk) {
        gattCharacteristic.setValue(chunk);
        return gattServer.notifyCharacteristicChanged(central, gattCharacteristic, false);
    }

    @SuppressWarnings({"MissingPermission", "deprecation"})
    private static boolean writeDescriptorLegacy(BluetoothGatt gatt, BluetoothGattDescriptor ccc,
            byte[] value) {
        ccc.setValue(value);
        return gatt.writeDescriptor(ccc); // false ⇒ the write was not initiated (no callback follows)
    }

    /** Fail + drop an endpoint's send pump (its in-flight + queued sends report failure). */
    private void failPump(String endpointId) {
        BleSendPump pump = blePumps.remove(endpointId);
        if (pump != null) {
            pump.failAll("disconnected");
        }
    }

    /** Drop ALL per-endpoint BLE CLIENT state (so a later scan can re-dial the address — the scan
     *  dedup keys on bleClients/blePendingClients) and fail any in-flight send.  The caller closes
     *  the GATT + fires the appropriate event. */
    private void forgetBleClient(String endpointId) {
        blePendingClients.remove(endpointId);
        bleClients.remove(endpointId);
        bleClientChars.remove(endpointId);
        assemblers.remove(endpointId);
        bleMtu.remove(endpointId);
        failPump(endpointId);
    }

    /** A BLE CLIENT-setup step failed (rejected MTU/discovery/CCC, missing service, bad status):
     *  forget + close the half-open GATT and report the FAILED connection.  Without this the peer
     *  lingers in bleClients and the scan dedup makes it permanently undialable until stop(). */
    @SuppressWarnings("MissingPermission")
    private void failBleClient(BluetoothGatt gatt, String endpointId) {
        forgetBleClient(endpointId);
        try {
            gatt.close();
        } catch (Exception ignored) {
            // already closed
        }
        events.onConnectionResult(endpointId, false);
    }

    /** The BLE per-write chunk size for an endpoint's negotiated MTU (pure {@link CourierFraming}). */
    private int chunkSize(String endpointId) {
        return CourierFraming.chunkSize(bleMtu.getOrDefault(endpointId, CourierFraming.DEFAULT_ATT_MTU));
    }

    /** Feed a received BLE chunk into the endpoint's reassembler, emitting any complete frame. */
    private void feedAssembler(String endpointId, byte[] chunk) {
        CourierFraming.FrameAssembler asm = assemblers.get(endpointId);
        if (asm != null) {
            synchronized (asm) {
                asm.feed(chunk, frame -> events.onPayload(endpointId, frame));
            }
        }
    }

    // --- RFCOMM plumbing ------------------------------------------------------------

    @SuppressWarnings("MissingPermission")
    private void startServerSocket() {
        // The SESSION generation: if a Stop→Start runs while listenUsingRfcommWithServiceRecord is
        // still pending (before serverSocket is assigned, so stop() cannot close it), `running` is
        // true again for the NEW session — the generation lets us close the OLD listener instead of
        // leaving a stale RFCOMM server active under the fresh controller (#T).
        final long serverGen = bleStartGeneration;
        new Thread(() -> {
            closeServerSocket();
            BluetoothServerSocket server;
            try {
                server = adapter.listenUsingRfcommWithServiceRecord(SERVICE_NAME, SERVICE_UUID);
            } catch (IOException e) {
                // RFCOMM unavailable — the BLE GATT path remains
                return;
            }
            serverSocket = server;
            // A stop OR a Stop→Start (running true again for the NEW session) must close this freshly-
            // created listener so the OLD session's RFCOMM service never stays registered (#T).
            if (!running.get() || serverGen != bleStartGeneration) {
                closeServerSocket();
                return;
            }
            try {
                while (running.get() && serverGen == bleStartGeneration) {
                    BluetoothSocket socket = server.accept();
                    if (!running.get() || serverGen != bleStartGeneration) {
                        // stop() raced this accept() — close the just-accepted socket instead of
                        // handing it to the stream link (CourierStreamLink.run emits
                        // connectionResult(true) BEFORE its alive predicate is checked, so a stopped
                        // courier would otherwise briefly announce a peer-visible link).
                        try {
                            socket.close();
                        } catch (IOException ignored) {
                            // already closed
                        }
                        break;
                    }
                    handleSocket(socket);
                }
            } catch (IOException ignored) {
                // socket closed on stop — non-fatal
            } finally {
                // Close whatever we created, even if `running` flipped false right after the
                // post-creation check above (so the listener never leaks past stop()).
                closeServerSocket();
            }
        }).start();
    }

    @SuppressWarnings("MissingPermission")
    private void connectClient(BluetoothDevice device) {
        final long connectGen = bleStartGeneration; // a stop/restart invalidates this dial (#T)
        new Thread(() -> {
            BluetoothSocket socket = null;
            try {
                socket = device.createRfcommSocketToServiceRecord(SERVICE_UUID);
                // Track BEFORE the blocking connect() so a concurrent stop() can close the socket and
                // interrupt the dial — otherwise a connect that completes AFTER stop() would open a
                // peer-visible Bluetooth link (and emit connectionResult(true)) post-stop.
                liveSockets.add(socket);
                adapter.cancelDiscovery(); // discovery slows the connect handshake
                socket.connect();
                if (!running.get() || connectGen != bleStartGeneration) {
                    // Stopped DURING the dial, OR a Stop→Start superseded it (running true again for
                    // the NEW session) — do not hand the OLD session's socket to the stream link
                    // (which would announce the endpoint connected for a superseded session) (#T).
                    liveSockets.remove(socket);
                    socket.close();
                    return;
                }
                handleSocket(socket);
            } catch (IOException e) {
                if (socket != null) {
                    liveSockets.remove(socket);
                    try {
                        socket.close();
                    } catch (IOException ignored) {
                        // already closed
                    }
                }
                events.onConnectionResult(device.getAddress(), false);
            }
        }).start();
    }

    /** Drive a connected RFCOMM socket as a courier link (the accept-loop + client connect call
     *  this).  Package-visible so the Layer-2 test drives it over a Robolectric shadow socket. */
    @SuppressWarnings("MissingPermission")
    void handleSocket(BluetoothSocket socket) {
        String endpointId = socket.getRemoteDevice().getAddress();
        liveSockets.add(socket); // tracked so stop() can unblock the read below
        try {
            // The shared blocking-stream data-path (CourierStreamLinkTest covers it via pipes).
            CourierStreamLink.run(socket.getInputStream(), socket.getOutputStream(), socket,
                    endpointId, outbound, events, () -> running.get() && socket.isConnected());
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

    // --- BLE GATT fallback: peripheral (GATT server + advertiser) --------------------

    @SuppressWarnings("MissingPermission")
    private void startBleGattServer() {
        BluetoothManager bm = (BluetoothManager) ctx.getSystemService(Context.BLUETOOTH_SERVICE);
        if (bm == null) return;
        // A fresh server generation: the new callback drops any delayed event from the prior server.
        gattServerCallback = newGattServerCallback(++bleServerGeneration);
        gattServer = bm.openGattServer(ctx, gattServerCallback);
        if (gattServer == null) return;
        BluetoothGattService service = buildCourierGattService();
        gattCharacteristic = service.getCharacteristic(BLE_CHAR_UUID);
        // addService is ASYNC (completes via onServiceAdded).  Advertising is started ONLY from
        // that callback — otherwise a fast scanner could connect off the advertisement before the
        // service is registered, hit svc==null in discovery, and stall with no failed-connect event.
        gattServer.addService(service);
    }

    @SuppressWarnings("MissingPermission")
    private void startBleAdvertising() {
        advertiser = adapter.getBluetoothLeAdvertiser();
        if (advertiser == null) {
            // No BLE advertiser on this controller — the device cannot be DISCOVERED by unbonded
            // peers (BLE advertising is the only discoverability for the advertise role; the RFCOMM
            // server is a passive listener).  SURFACE it instead of staying silent, so the UI does
            // not show a live radio that is not actually discoverable (#9).
            if (running.get()) {
                events.onStartFailed("advertise",
                        new IllegalStateException("ble_advertiser_unavailable"));
            }
            return;
        }
        final long gen = bleStartGeneration;
        advertiseCallback = new AdvertiseCallback() {
            @Override
            public void onStartFailure(int errorCode) {
                // Android REJECTED the advertise (advertiser quota / unsupported parameters) — a
                // late/async failure the synchronous start could not see.  Surface it, but DROP a
                // failure from a stopped (running=false) OR superseded (a Stop→Start bumped the
                // session generation) advertiser so it cannot tear down a freshly-started courier (#H).
                if (running.get() && gen == bleStartGeneration) {
                    events.onStartFailed("advertise",
                            new IllegalStateException("ble_advertise_failed_" + errorCode));
                }
            }
        };
        advertiser.startAdvertising(
                new AdvertiseSettings.Builder()
                        .setAdvertiseMode(AdvertiseSettings.ADVERTISE_MODE_LOW_LATENCY)
                        .setConnectable(true)
                        .build(),
                new AdvertiseData.Builder().addServiceUuid(BLE_SERVICE_PUUID).build(),
                advertiseCallback);
    }

    /** Build a GATT-server callback bound to this server `gen` — every method drops a callback whose
     *  generation has been superseded (a Stop→Start opened a new server), so a delayed event from the
     *  OLD server never mutates the new session's state (#C). */
    private BluetoothGattServerCallback newGattServerCallback(final long gen) {
      return new BluetoothGattServerCallback() {
        @Override
        public void onServiceAdded(int status, BluetoothGattService service) {
            // A late onServiceAdded delivered AFTER stop() (addService was still pending when
            // stopBle() ran) must NOT begin advertising — a stopped courier cannot become
            // discoverable again.
            if (!running.get() || gen != bleServerGeneration) return;
            // The courier service is now registered — only NOW is it safe to advertise (a scanner
            // that connects can resolve the service).
            if (status == BluetoothGatt.GATT_SUCCESS && BLE_SERVICE_UUID.equals(service.getUuid())) {
                startBleAdvertising();
            } else if (status != BluetoothGatt.GATT_SUCCESS) {
                // A FAILED service registration means the BLE peripheral cannot be discovered — surface
                // it (like the missing-advertiser / advertise-failure paths) instead of silently
                // leaving the channel marked running but not discoverable (#D).
                events.onStartFailed("advertise",
                        new IllegalStateException("ble_service_add_failed_" + status));
            }
        }

        @Override
        @SuppressWarnings("MissingPermission")
        public void onConnectionStateChange(BluetoothDevice device, int status, int newState) {
            // Drop a delayed connect/DISCONNECT from a SUPERSEDED server (a Stop→Start opened a new
            // one) — else a stale STATE_DISCONNECTED would evict the central that has since
            // reconnected under the new server (#C).
            if (gen != bleServerGeneration) return;
            String endpointId = device.getAddress();
            if (newState == BluetoothProfile.STATE_CONNECTED) {
                // A late CONNECT delivered AFTER stopBle() (the GATT server was closed + the maps
                // cleared) must NOT re-register a central or arm a link the stopped courier would
                // then announce; the client path already guards this — the peripheral path must too.
                if (!running.get()) return;
                bleCentrals.put(endpointId, device);
                assemblers.put(endpointId, new CourierFraming.FrameAssembler());
                // Do NOT announce the link yet: the central has not subscribed to notifications, so
                // a peripheral→central notify would be dropped.  The connection is reported from
                // onDescriptorWriteRequest once the central enables the CCC (subscribes).
            } else if (newState == BluetoothProfile.STATE_DISCONNECTED) {
                bleCentrals.remove(endpointId);
                assemblers.remove(endpointId);
                bleMtu.remove(endpointId);
                failPump(endpointId);
                events.onDisconnected(endpointId);
            }
        }

        @Override
        public void onMtuChanged(BluetoothDevice device, int mtu) {
            if (gen != bleServerGeneration) return; // a stale MTU report from an old server
            bleMtu.put(device.getAddress(), mtu);
        }

        @Override
        @SuppressWarnings("MissingPermission")
        public void onCharacteristicWriteRequest(BluetoothDevice device, int requestId,
                BluetoothGattCharacteristic characteristic, boolean preparedWrite,
                boolean responseNeeded, int offset, byte[] value) {
            // a late inbound write after stopBle() / from a superseded server — drop, never process
            if (!running.get() || gen != bleServerGeneration) return;
            if (BLE_CHAR_UUID.equals(characteristic.getUuid()) && value != null) {
                feedAssembler(device.getAddress(), value);
            }
            if (responseNeeded && gattServer != null) {
                gattServer.sendResponse(device, requestId, BluetoothGatt.GATT_SUCCESS, offset, null);
            }
        }

        @Override
        @SuppressWarnings("MissingPermission")
        public void onDescriptorWriteRequest(BluetoothDevice device, int requestId,
                BluetoothGattDescriptor descriptor, boolean preparedWrite, boolean responseNeeded,
                int offset, byte[] value) {
            // A queued CCC write delivered AFTER stopBle() must NOT announce a fresh link for a
            // stopped courier — gate before sendResponse/onConnectionResult (the client path guards
            // its late STATE_CONNECTED the same way).  Also drop a CCC write from a SUPERSEDED server.
            if (!running.get() || gen != bleServerGeneration) return;
            // The central enabling/disabling notifications (CCC) — accept it.
            if (responseNeeded && gattServer != null) {
                gattServer.sendResponse(device, requestId, BluetoothGatt.GATT_SUCCESS, offset, null);
            }
            // The central has now SUBSCRIBED (enabled the CCC) — only now can the peripheral notify,
            // so this is when the duplex link is actually ready.  Announce it here, not on connect.
            if (CCC_UUID.equals(descriptor.getUuid())
                    && Arrays.equals(value, BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE)) {
                events.onConnectionResult(device.getAddress(), true);
            }
        }

        @Override
        public void onNotificationSent(BluetoothDevice device, int status) {
            if (gen != bleServerGeneration) return; // a stale ack from an old server's notify
            BleSendPump pump = blePumps.get(device.getAddress());
            if (pump != null) pump.onAck(status);
        }
      };
    }

    // --- BLE GATT fallback: central (scan + GATT client) ----------------------------

    @SuppressWarnings("MissingPermission")
    private void startBleScan(boolean bleIsOnlyDiscoveryPath) {
        scanner = adapter.getBluetoothLeScanner();
        if (scanner == null) {
            // No BLE scanner on this controller — surface it ONLY when BLE was the sole discovery
            // avenue (else the bonded RFCOMM dials carry discovery and a startFailed would wrongly
            // tear the channel down).
            if (bleIsOnlyDiscoveryPath) {
                events.onStartFailed("discover", new IllegalStateException("ble_scanner_unavailable"));
            }
            return;
        }
        final long gen = bleStartGeneration;
        scanCallback = new ScanCallback() {
            @Override
            @SuppressWarnings("MissingPermission")
            public void onScanResult(int callbackType, ScanResult result) {
                // Android may deliver a queued scan result after stopBle() stopped scanning and
                // cleared the maps, or from a SUPERSEDED session after a Stop→Start — a fresh
                // connectGatt here would not be closed by the finished stop and could later report a
                // connection with no/stale web listeners.
                if (!running.get() || gen != bleStartGeneration) return;
                BluetoothDevice device = result.getDevice();
                if (device == null) return;
                String addr = device.getAddress();
                // Skip if already connected OR a dial is already in flight — onScanResult repeats for
                // the same advertiser well before STATE_CONNECTED populates bleClients.  Claim the
                // dial slot atomically (putIfAbsent) so concurrent scan results can't double-dial.
                if (bleClients.containsKey(addr) || blePendingClients.containsKey(addr)) return;
                BluetoothGatt gatt =
                        device.connectGatt(ctx, false, gattClientCallback, BluetoothDevice.TRANSPORT_LE);
                if (gatt != null) blePendingClients.put(addr, gatt);
            }

            @Override
            public void onScanFailed(int errorCode) {
                // Android rejected the scan (already-started / app-registration / internal error).
                // Surface it when BLE is the only discovery path so the controller doesn't show the
                // channel running with no active discovery — but DROP a failure from a stopped or
                // SUPERSEDED session (a Stop→Start) so it cannot tear down the fresh courier (#H).
                if (bleIsOnlyDiscoveryPath && running.get() && gen == bleStartGeneration) {
                    events.onStartFailed("discover",
                            new IllegalStateException("ble_scan_failed_" + errorCode));
                }
            }
        };
        try {
            scanner.startScan(
                    Collections.singletonList(
                            new ScanFilter.Builder().setServiceUuid(BLE_SERVICE_PUUID).build()),
                    new ScanSettings.Builder().setScanMode(ScanSettings.SCAN_MODE_LOW_LATENCY).build(),
                    scanCallback);
        } catch (RuntimeException e) {
            // A synchronous throw (SecurityException for a missing runtime permission, or a framework
            // IllegalStateException) means no scan is running — surface it on the BLE-only path.
            if (bleIsOnlyDiscoveryPath) events.onStartFailed("discover", e);
        }
    }

    /** True iff a DIFFERENT BluetoothGatt now owns `endpointId` (a re-dial of the same address
     *  established/pending a fresh connection) — so a callback from the SUPERSEDED old gatt is
     *  dropped instead of acking the fresh pump / feeding stale bytes into the fresh assembler (#J).
     *  (A callback whose endpoint is no longer tracked at all is NOT treated as superseded — the
     *  fresh connection owns the slot or nothing does; only a genuine REPLACEMENT is stale.) */
    private boolean isSupersededClient(String endpointId, BluetoothGatt gatt) {
        BluetoothGatt established = bleClients.get(endpointId);
        BluetoothGatt pending = blePendingClients.get(endpointId);
        return (established != null && established != gatt) || (pending != null && pending != gatt);
    }

    final BluetoothGattCallback gattClientCallback = new BluetoothGattCallback() {
        @Override
        @SuppressWarnings("MissingPermission")
        public void onConnectionStateChange(BluetoothGatt gatt, int status, int newState) {
            String endpointId = gatt.getDevice().getAddress();
            if (newState == BluetoothProfile.STATE_CONNECTED) {
                if (!running.get()) {
                    // stopBle() ran while this connectGatt was pending — a late STATE_CONNECTED must
                    // NOT promote the (already-closed) GATT into bleClients / start discovery / emit a
                    // connection for a stopped radio.  Close it and drop it.
                    blePendingClients.remove(endpointId);
                    gatt.close();
                    return;
                }
                blePendingClients.remove(endpointId); // promoted from dialing to connected
                bleClients.put(endpointId, gatt);
                assemblers.put(endpointId, new CourierFraming.FrameAssembler());
                // requestMtu is an OPTIMIZATION; if it isn't initiated (returns false), onMtuChanged
                // never fires, so fall back to discovery at the default MTU.  If neither starts, the
                // setup is stuck — tear down so the peer can be re-dialed instead of lingering.
                if (!gatt.requestMtu(247) && !gatt.discoverServices()) {
                    failBleClient(gatt, endpointId);
                }
            } else if (newState == BluetoothProfile.STATE_DISCONNECTED) {
                // A DELAYED disconnect from an OLD BluetoothGatt (the same address was re-dialed /
                // reconnected after a Stop→Start or quick redial) must NOT remove the FRESH gatt's
                // entries or emit a spurious disconnect for the current link — only forget if the
                // maps STILL point at THIS callback's gatt (#4).
                if (bleClients.get(endpointId) != gatt && blePendingClients.get(endpointId) != gatt) {
                    gatt.close(); // a stale old gatt — close it, but leave the fresh client intact
                    return;
                }
                forgetBleClient(endpointId); // frees the dial slot to re-dial
                gatt.close();
                events.onDisconnected(endpointId);
            }
        }

        @Override
        @SuppressWarnings("MissingPermission")
        public void onMtuChanged(BluetoothGatt gatt, int mtu, int status) {
            String endpointId = gatt.getDevice().getAddress();
            if (isSupersededClient(endpointId, gatt)) return; // a callback from a superseded GATT (#J)
            if (status == BluetoothGatt.GATT_SUCCESS) bleMtu.put(endpointId, mtu);
            // Discovery is required to resolve the courier characteristic — if it won't start, the
            // connection can't progress, so fail rather than leaving the peer stuck in bleClients.
            if (!gatt.discoverServices()) failBleClient(gatt, endpointId);
        }

        @Override
        @SuppressWarnings("MissingPermission")
        public void onServicesDiscovered(BluetoothGatt gatt, int status) {
            String endpointId = gatt.getDevice().getAddress();
            if (isSupersededClient(endpointId, gatt)) return; // a callback from a superseded GATT (#J)
            // Any of these means the peer is not a usable courier — tear down + report failure so
            // the scan dedup doesn't leave it undialable (a bad status, no courier service, no
            // characteristic, or — the courier needs DUPLEX — no CCC to notify replies back).
            if (status != BluetoothGatt.GATT_SUCCESS) {
                failBleClient(gatt, endpointId);
                return;
            }
            BluetoothGattService svc = gatt.getService(BLE_SERVICE_UUID);
            if (svc == null) {
                failBleClient(gatt, endpointId);
                return;
            }
            BluetoothGattCharacteristic ch = svc.getCharacteristic(BLE_CHAR_UUID);
            if (ch == null) {
                failBleClient(gatt, endpointId);
                return;
            }
            BluetoothGattDescriptor ccc = ch.getDescriptor(CCC_UUID);
            if (ccc == null) {
                // No CCC ⇒ the peripheral cannot notify back: a write-only link can only time out.
                failBleClient(gatt, endpointId);
                return;
            }
            bleClientChars.put(endpointId, ch);
            // Enable LOCAL notification delivery (distinct from the remote CCC subscription written
            // below).  If Android refuses, the peripheral's notify replies would never reach us, so
            // fail the connection + tear down rather than reporting a link that can't receive.
            if (!gatt.setCharacteristicNotification(ch, true)) {
                failBleClient(gatt, endpointId);
                return;
            }
            // The CCC write is ASYNC — defer onConnectionResult to onDescriptorWrite, since the
            // peer's notifications aren't actually received until the subscription completes.  But
            // if the write isn't INITIATED (sync rejection), no callback follows — tear down now.
            boolean written;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                written = gatt.writeDescriptor(ccc, BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE)
                        == BluetoothStatusCodes.SUCCESS;
            } else {
                written = writeDescriptorLegacy(
                        gatt, ccc, BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE);
            }
            if (!written) {
                failBleClient(gatt, endpointId);
            }
        }

        @Override
        @SuppressWarnings("MissingPermission")
        public void onDescriptorWrite(BluetoothGatt gatt, BluetoothGattDescriptor descriptor, int status) {
            if (!CCC_UUID.equals(descriptor.getUuid())) return;
            // A late CCC-write completion can land AFTER stopBle() closed the GATT + cleared the
            // maps; a stopped courier must NOT announce a fresh link (on a quick restart that stale
            // native event is forwarded to the new JS listener) — gate on running first (#8).
            if (!running.get()) return;
            String endpointId = gatt.getDevice().getAddress();
            if (isSupersededClient(endpointId, gatt)) return; // a stale CCC write from a superseded GATT (#J)
            // The notify subscription is now established (or failed) — ONLY now is the duplex link
            // ready.  On SUCCESS, report connected.  On FAILURE, tear the half-open client down
            // FIRST (else it lingers in bleClients and the scan dedup makes the peer permanently
            // undialable until the whole radio is stopped), then report the failed result.
            if (status == BluetoothGatt.GATT_SUCCESS) {
                events.onConnectionResult(endpointId, true);
            } else {
                failBleClient(gatt, endpointId);
            }
        }

        @Override
        public void onCharacteristicWrite(BluetoothGatt gatt,
                BluetoothGattCharacteristic characteristic, int status) {
            String endpointId = gatt.getDevice().getAddress();
            if (isSupersededClient(endpointId, gatt)) return; // a stale ACK must not drive the fresh pump (#J)
            BleSendPump pump = blePumps.get(endpointId);
            if (pump != null) pump.onAck(status);
        }

        // API 33+ delivers the value as a parameter.
        @Override
        public void onCharacteristicChanged(BluetoothGatt gatt,
                BluetoothGattCharacteristic characteristic, byte[] value) {
            // A stale notification from a superseded GATT must not feed the fresh assembler (#J).
            if (isSupersededClient(gatt.getDevice().getAddress(), gatt)) return;
            feedNotification(gatt, characteristic, value);
        }

        // Pre-33 delivers the value via characteristic.getValue().
        @Override
        @SuppressWarnings("deprecation")
        public void onCharacteristicChanged(BluetoothGatt gatt,
                BluetoothGattCharacteristic characteristic) {
            if (isSupersededClient(gatt.getDevice().getAddress(), gatt)) return; // stale notify (#J)
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) {
                feedNotification(gatt, characteristic, characteristic.getValue());
            }
        }
    };

    /** Feed a peripheral→central notification's bytes into the per-endpoint reassembler. */
    private void feedNotification(BluetoothGatt gatt, BluetoothGattCharacteristic characteristic,
            byte[] value) {
        if (BLE_CHAR_UUID.equals(characteristic.getUuid()) && value != null) {
            feedAssembler(gatt.getDevice().getAddress(), value);
        }
    }

    @SuppressWarnings("MissingPermission")
    private void stopBle() {
        if (advertiser != null && advertiseCallback != null) {
            try {
                advertiser.stopAdvertising(advertiseCallback);
            } catch (Exception ignored) {
                // adapter off
            }
        }
        if (scanner != null && scanCallback != null) {
            try {
                scanner.stopScan(scanCallback);
            } catch (Exception ignored) {
                // adapter off
            }
        }
        for (BluetoothGatt gatt : bleClients.values()) {
            try {
                gatt.disconnect();
                gatt.close();
            } catch (Exception ignored) {
                // already closed
            }
        }
        // Close dials that never reached STATE_CONNECTED too — they are not in bleClients yet.
        for (BluetoothGatt gatt : blePendingClients.values()) {
            try {
                gatt.disconnect();
                gatt.close();
            } catch (Exception ignored) {
                // already closed
            }
        }
        if (gattServer != null) {
            try {
                gattServer.close();
            } catch (Exception ignored) {
                // already closed
            }
            gattServer = null;
        }
        // Invalidate the current GATT-server callback: a delayed event from this (now-closed) server
        // is dropped by its generation guard rather than mutating a later session's state (#C).
        bleServerGeneration++;
        // Invalidate this session's advertise/scan callbacks: a late onStartFailure/onScanFailed from
        // the stopped session is dropped rather than tearing down a freshly-restarted courier (#H).
        bleStartGeneration++;
        bleClients.clear();
        blePendingClients.clear();
        bleClientChars.clear();
        bleCentrals.clear();
        assemblers.clear();
        bleMtu.clear();
        // Fail any sends still in flight, then drop the pumps + the ack-timeout scheduler.
        for (BleSendPump pump : blePumps.values()) {
            pump.failAll("stopped");
        }
        blePumps.clear();
        ScheduledExecutorService exec = bleScheduler;
        if (exec != null) {
            exec.shutdownNow();
            bleScheduler = null;
        }
    }
}

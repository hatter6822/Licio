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
    private AdvertiseCallback advertiseCallback;
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

    /** Whether the device has a usable Bluetooth adapter. */
    @Override
    public boolean isAvailable() {
        return adapter != null;
    }

    // --- §22.5 advertise / discover -------------------------------------------------

    /** Listen for inbound RFCOMM + open the BLE GATT server and advertise the service UUID. */
    @SuppressWarnings("MissingPermission") // declared per-API in the manifest; runtime-granted by the gate
    @Override
    public void startAdvertising() {
        if (adapter == null) return;
        running.set(true);
        startServerSocket();
        startBleGattServer();
    }

    /** Connect over RFCOMM to bonded couriers + scan for the BLE service UUID and connect. */
    @SuppressWarnings("MissingPermission")
    @Override
    public void startDiscovery() {
        if (adapter == null) return;
        running.set(true);
        for (BluetoothDevice device : adapter.getBondedDevices()) {
            connectClient(device);
        }
        startBleScan();
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
    private static void writeDescriptorLegacy(BluetoothGatt gatt, BluetoothGattDescriptor ccc,
            byte[] value) {
        ccc.setValue(value);
        gatt.writeDescriptor(ccc);
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
        new Thread(() -> {
            try {
                closeServerSocket();
                serverSocket = adapter.listenUsingRfcommWithServiceRecord(SERVICE_NAME, SERVICE_UUID);
                while (running.get()) {
                    BluetoothSocket socket = serverSocket.accept();
                    handleSocket(socket);
                }
            } catch (IOException ignored) {
                // socket closed on stop, or RFCOMM unavailable — the BLE GATT path remains
            }
        }).start();
    }

    @SuppressWarnings("MissingPermission")
    private void connectClient(BluetoothDevice device) {
        new Thread(() -> {
            BluetoothSocket socket = null;
            try {
                socket = device.createRfcommSocketToServiceRecord(SERVICE_UUID);
                adapter.cancelDiscovery(); // discovery slows the connect handshake
                socket.connect();
                handleSocket(socket);
            } catch (IOException e) {
                events.onConnectionResult(device.getAddress(), false);
                if (socket != null) {
                    try {
                        socket.close();
                    } catch (IOException ignored) {
                        // already closed
                    }
                }
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
        if (advertiser == null) return; // controller cannot advertise — RFCOMM remains
        advertiseCallback = new AdvertiseCallback() {};
        advertiser.startAdvertising(
                new AdvertiseSettings.Builder()
                        .setAdvertiseMode(AdvertiseSettings.ADVERTISE_MODE_LOW_LATENCY)
                        .setConnectable(true)
                        .build(),
                new AdvertiseData.Builder().addServiceUuid(BLE_SERVICE_PUUID).build(),
                advertiseCallback);
    }

    final BluetoothGattServerCallback gattServerCallback = new BluetoothGattServerCallback() {
        @Override
        public void onServiceAdded(int status, BluetoothGattService service) {
            // The courier service is now registered — only NOW is it safe to advertise (a scanner
            // that connects can resolve the service).  A failed registration ⇒ no advertising (the
            // BLE peripheral path is unavailable; RFCOMM remains).
            if (status == BluetoothGatt.GATT_SUCCESS && BLE_SERVICE_UUID.equals(service.getUuid())) {
                startBleAdvertising();
            }
        }

        @Override
        @SuppressWarnings("MissingPermission")
        public void onConnectionStateChange(BluetoothDevice device, int status, int newState) {
            String endpointId = device.getAddress();
            if (newState == BluetoothProfile.STATE_CONNECTED) {
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
            bleMtu.put(device.getAddress(), mtu);
        }

        @Override
        @SuppressWarnings("MissingPermission")
        public void onCharacteristicWriteRequest(BluetoothDevice device, int requestId,
                BluetoothGattCharacteristic characteristic, boolean preparedWrite,
                boolean responseNeeded, int offset, byte[] value) {
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
            BleSendPump pump = blePumps.get(device.getAddress());
            if (pump != null) pump.onAck(status);
        }
    };

    // --- BLE GATT fallback: central (scan + GATT client) ----------------------------

    @SuppressWarnings("MissingPermission")
    private void startBleScan() {
        scanner = adapter.getBluetoothLeScanner();
        if (scanner == null) return;
        scanCallback = new ScanCallback() {
            @Override
            @SuppressWarnings("MissingPermission")
            public void onScanResult(int callbackType, ScanResult result) {
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
        };
        scanner.startScan(
                Collections.singletonList(
                        new ScanFilter.Builder().setServiceUuid(BLE_SERVICE_PUUID).build()),
                new ScanSettings.Builder().setScanMode(ScanSettings.SCAN_MODE_LOW_LATENCY).build(),
                scanCallback);
    }

    final BluetoothGattCallback gattClientCallback = new BluetoothGattCallback() {
        @Override
        @SuppressWarnings("MissingPermission")
        public void onConnectionStateChange(BluetoothGatt gatt, int status, int newState) {
            String endpointId = gatt.getDevice().getAddress();
            if (newState == BluetoothProfile.STATE_CONNECTED) {
                blePendingClients.remove(endpointId); // promoted from dialing to connected
                bleClients.put(endpointId, gatt);
                assemblers.put(endpointId, new CourierFraming.FrameAssembler());
                gatt.requestMtu(247);
            } else if (newState == BluetoothProfile.STATE_DISCONNECTED) {
                forgetBleClient(endpointId); // frees the dial slot to re-dial
                gatt.close();
                events.onDisconnected(endpointId);
            }
        }

        @Override
        @SuppressWarnings("MissingPermission")
        public void onMtuChanged(BluetoothGatt gatt, int mtu, int status) {
            if (status == BluetoothGatt.GATT_SUCCESS) bleMtu.put(gatt.getDevice().getAddress(), mtu);
            gatt.discoverServices();
        }

        @Override
        @SuppressWarnings("MissingPermission")
        public void onServicesDiscovered(BluetoothGatt gatt, int status) {
            String endpointId = gatt.getDevice().getAddress();
            BluetoothGattService svc = gatt.getService(BLE_SERVICE_UUID);
            if (svc == null) return;
            BluetoothGattCharacteristic ch = svc.getCharacteristic(BLE_CHAR_UUID);
            if (ch == null) return;
            bleClientChars.put(endpointId, ch);
            // Enable notifications so the peripheral can send back (duplex).
            gatt.setCharacteristicNotification(ch, true);
            BluetoothGattDescriptor ccc = ch.getDescriptor(CCC_UUID);
            if (ccc != null) {
                // The CCC write is ASYNC — defer onConnectionResult to onDescriptorWrite, since the
                // peer's notifications aren't actually received until the subscription completes.
                // Reporting connected here would let the exchange start (and the peer answer by
                // notification) before notifications are enabled → a dropped first reply.
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                    gatt.writeDescriptor(ccc, BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE);
                } else {
                    writeDescriptorLegacy(gatt, ccc, BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE);
                }
            } else {
                // No CCC ⇒ no notify subscription to await (write-only path) — report connected now.
                events.onConnectionResult(endpointId, true);
            }
        }

        @Override
        @SuppressWarnings("MissingPermission")
        public void onDescriptorWrite(BluetoothGatt gatt, BluetoothGattDescriptor descriptor, int status) {
            if (!CCC_UUID.equals(descriptor.getUuid())) return;
            String endpointId = gatt.getDevice().getAddress();
            // The notify subscription is now established (or failed) — ONLY now is the duplex link
            // ready.  On SUCCESS, report connected.  On FAILURE, tear the half-open client down
            // FIRST (else it lingers in bleClients and the scan dedup makes the peer permanently
            // undialable until the whole radio is stopped), then report the failed result.
            if (status == BluetoothGatt.GATT_SUCCESS) {
                events.onConnectionResult(endpointId, true);
            } else {
                forgetBleClient(endpointId);
                gatt.close();
                events.onConnectionResult(endpointId, false);
            }
        }

        @Override
        public void onCharacteristicWrite(BluetoothGatt gatt,
                BluetoothGattCharacteristic characteristic, int status) {
            BleSendPump pump = blePumps.get(gatt.getDevice().getAddress());
            if (pump != null) pump.onAck(status);
        }

        // API 33+ delivers the value as a parameter.
        @Override
        public void onCharacteristicChanged(BluetoothGatt gatt,
                BluetoothGattCharacteristic characteristic, byte[] value) {
            feedNotification(gatt, characteristic, value);
        }

        // Pre-33 delivers the value via characteristic.getValue().
        @Override
        @SuppressWarnings("deprecation")
        public void onCharacteristicChanged(BluetoothGatt gatt,
                BluetoothGattCharacteristic characteristic) {
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

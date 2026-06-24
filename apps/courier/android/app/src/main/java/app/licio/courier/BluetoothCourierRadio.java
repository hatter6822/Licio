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

import java.io.DataInputStream;
import java.io.DataOutputStream;
import java.io.IOException;
import java.util.Collections;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.BlockingQueue;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.TimeUnit;
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

    // --- BLE GATT fallback state ----------------------------------------------------
    private volatile BluetoothGattServer gattServer;
    private BluetoothGattCharacteristic gattCharacteristic;
    private BluetoothLeAdvertiser advertiser;
    private AdvertiseCallback advertiseCallback;
    private final ConcurrentHashMap<String, BluetoothDevice> bleCentrals = new ConcurrentHashMap<>();
    private BluetoothLeScanner scanner;
    private ScanCallback scanCallback;
    private final ConcurrentHashMap<String, BluetoothGatt> bleClients = new ConcurrentHashMap<>();
    private final ConcurrentHashMap<String, BluetoothGattCharacteristic> bleClientChars = new ConcurrentHashMap<>();
    private final ConcurrentHashMap<String, Integer> bleMtu = new ConcurrentHashMap<>();
    private final ConcurrentHashMap<String, CourierFraming.FrameAssembler> assemblers = new ConcurrentHashMap<>();
    private final ConcurrentHashMap<String, BlockingQueue<Integer>> bleAcks = new ConcurrentHashMap<>();
    // Per-endpoint send lock: serializes concurrent sends to ONE BLE endpoint so they cannot
    // race on the shared `bleAcks` queue slot (overwrite / mis-route / premature removal).
    private final ConcurrentHashMap<String, Object> bleSendLocks = new ConcurrentHashMap<>();

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
            new Thread(() -> {
                try {
                    synchronized (out) {
                        out.write(CourierFraming.framePrefixed(payload)); // wire ≡ writeInt(len)+bytes
                        out.flush();
                    }
                    result.onSuccess();
                } catch (IOException e) {
                    result.onError("send_failed", e);
                }
            }).start();
            return;
        }
        if (bleClients.containsKey(endpointId) || bleCentrals.containsKey(endpointId)) {
            new Thread(() -> {
                try {
                    sendBleFramed(endpointId, payload);
                    result.onSuccess();
                } catch (Exception e) {
                    result.onError("send_failed", e);
                }
            }).start();
            return;
        }
        result.onError("endpoint_not_connected", null);
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

    @SuppressWarnings("MissingPermission")
    private void handleSocket(BluetoothSocket socket) {
        String endpointId = socket.getRemoteDevice().getAddress();
        liveSockets.add(socket); // tracked so stop() can unblock the read below
        try {
            DataOutputStream out = new DataOutputStream(socket.getOutputStream());
            DataInputStream in = new DataInputStream(socket.getInputStream());
            outbound.put(endpointId, out);
            events.onConnectionResult(endpointId, true);
            // The PURE, JVM-tested length-prefixed stream reader (CourierFramingTest covers it).
            CourierFraming.readFramedStream(in, frame -> events.onPayload(endpointId, frame),
                    () -> running.get() && socket.isConnected());
        } catch (IOException ignored) {
            // peer closed — fall through to disconnect
        } finally {
            liveSockets.remove(socket);
            outbound.remove(endpointId);
            try {
                socket.close();
            } catch (IOException ignored) {
                // already closed
            }
            events.onDisconnected(endpointId);
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
        gattServer.addService(service);

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
        @SuppressWarnings("MissingPermission")
        public void onConnectionStateChange(BluetoothDevice device, int status, int newState) {
            String endpointId = device.getAddress();
            if (newState == BluetoothProfile.STATE_CONNECTED) {
                bleCentrals.put(endpointId, device);
                assemblers.put(endpointId, new CourierFraming.FrameAssembler());
                events.onConnectionResult(endpointId, true);
            } else if (newState == BluetoothProfile.STATE_DISCONNECTED) {
                bleCentrals.remove(endpointId);
                assemblers.remove(endpointId);
                bleMtu.remove(endpointId);
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
        }

        @Override
        public void onNotificationSent(BluetoothDevice device, int status) {
            BlockingQueue<Integer> q = bleAcks.get(device.getAddress());
            if (q != null) q.offer(status);
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
                if (device == null || bleClients.containsKey(device.getAddress())) return;
                device.connectGatt(ctx, false, gattClientCallback, BluetoothDevice.TRANSPORT_LE);
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
                bleClients.put(endpointId, gatt);
                assemblers.put(endpointId, new CourierFraming.FrameAssembler());
                gatt.requestMtu(247);
            } else if (newState == BluetoothProfile.STATE_DISCONNECTED) {
                bleClients.remove(endpointId);
                bleClientChars.remove(endpointId);
                assemblers.remove(endpointId);
                bleMtu.remove(endpointId);
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
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                    gatt.writeDescriptor(ccc, BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE);
                } else {
                    ccc.setValue(BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE);
                    gatt.writeDescriptor(ccc);
                }
            }
            events.onConnectionResult(endpointId, true);
        }

        @Override
        public void onCharacteristicWrite(BluetoothGatt gatt,
                BluetoothGattCharacteristic characteristic, int status) {
            BlockingQueue<Integer> q = bleAcks.get(gatt.getDevice().getAddress());
            if (q != null) q.offer(status);
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

    // --- BLE GATT fallback: chunked, serialized, length-prefixed send ----------------

    @SuppressWarnings("MissingPermission")
    private void sendBleFramed(String endpointId, byte[] payload) throws Exception {
        // Serialize sends to ONE endpoint: the per-write ack flows through the single
        // `bleAcks` slot for this endpoint, so two concurrent sends would overwrite/mis-route
        // each other's queue.  The lock makes the put → serialize-on-ack loop → remove atomic.
        synchronized (bleSendLocks.computeIfAbsent(endpointId, k -> new Object())) {
            sendBleFramedLocked(endpointId, payload);
        }
    }

    @SuppressWarnings("MissingPermission")
    private void sendBleFramedLocked(String endpointId, byte[] payload) throws Exception {
        final BlockingQueue<Integer> acks = new LinkedBlockingQueue<>();
        bleAcks.put(endpointId, acks);
        try {
            final BluetoothGatt gatt = bleClients.get(endpointId);
            final BluetoothDevice central = bleCentrals.get(endpointId);
            // The PURE, JVM-tested serialize-on-ack loop drives the chunking + flow control; the
            // GATT write/notify + the ack wait are the only I/O (this anonymous ChunkSender).
            CourierFraming.sendChunked(payload, chunkSize(endpointId), new CourierFraming.ChunkSender() {
                @Override
                public void sendChunk(byte[] chunk) throws CourierFraming.CourierIoException {
                    acks.clear();
                    if (gatt != null) {
                        BluetoothGattCharacteristic ch = bleClientChars.get(endpointId);
                        if (ch == null) throw new CourierFraming.CourierIoException("ble_characteristic_unresolved");
                        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                            int rc = gatt.writeCharacteristic(ch, chunk,
                                    BluetoothGattCharacteristic.WRITE_TYPE_DEFAULT);
                            if (rc != BluetoothGatt.GATT_SUCCESS) {
                                throw new CourierFraming.CourierIoException("write_rc_" + rc);
                            }
                        } else {
                            ch.setWriteType(BluetoothGattCharacteristic.WRITE_TYPE_DEFAULT);
                            ch.setValue(chunk);
                            if (!gatt.writeCharacteristic(ch)) {
                                throw new CourierFraming.CourierIoException("write_rejected");
                            }
                        }
                    } else if (central != null && gattServer != null && gattCharacteristic != null) {
                        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                            gattServer.notifyCharacteristicChanged(central, gattCharacteristic, false, chunk);
                        } else {
                            gattCharacteristic.setValue(chunk);
                            gattServer.notifyCharacteristicChanged(central, gattCharacteristic, false);
                        }
                    } else {
                        throw new CourierFraming.CourierIoException("endpoint_not_connected");
                    }
                }

                @Override
                public int awaitAck() throws CourierFraming.CourierIoException {
                    try {
                        Integer ack = acks.poll(BLE_ACK_TIMEOUT_MS, TimeUnit.MILLISECONDS);
                        if (ack == null) throw new CourierFraming.CourierIoException("ble_ack_timeout");
                        return ack;
                    } catch (InterruptedException e) {
                        Thread.currentThread().interrupt();
                        throw new CourierFraming.CourierIoException("ble_send_interrupted");
                    }
                }
            });
        } finally {
            bleAcks.remove(endpointId);
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
        if (gattServer != null) {
            try {
                gattServer.close();
            } catch (Exception ignored) {
                // already closed
            }
            gattServer = null;
        }
        bleClients.clear();
        bleClientChars.clear();
        bleCentrals.clear();
        assemblers.clear();
        bleMtu.clear();
        bleAcks.clear();
        bleSendLocks.clear();
    }
}

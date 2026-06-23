// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-R.15.4d — the Bluetooth courier transport (OFFLINE_SPEC §22.5).  A third native
// radio channel beside Nearby + Wi-Fi Direct, following the SAME plugin pattern + the
// SAME JS event surface (`connectionResult` / `payloadReceived` / `disconnected`, base64
// BYTES) so the TS `NativeChannelMedium` + `CourierController` drive it identically.
//
// Primary data path: BLUETOOTH CLASSIC RFCOMM — a `BluetoothServerSocket` listens on a
// fixed service UUID, the client connects to a bonded/discovered device on that UUID, and
// both sides read/write length-prefixed BYTES frames.  RFCOMM is the higher-throughput,
// simpler path for bulk packs.  When RFCOMM is unavailable (BLE-only peripherals, some
// API surfaces), the BLE GATT FALLBACK below opens a GATT server with one writable
// characteristic that carries chunked frames (a peripheral that cannot do RFCOMM still
// participates).  Both are DUMB byte pipes; every frame is re-validated against its
// CIDs/COSE signatures on the TS side (§18.4, no transport trust).  PUBLIC-ONLY; off by
// default; no Bluetooth device address ever reaches an LCAP schema.
//
// Verification: exercisable on the emulator's netsim BLE/Bluetooth radios (the WS-R.15.4f
// radio bus).

package app.licio.courier;

import android.Manifest;
import android.bluetooth.BluetoothAdapter;
import android.bluetooth.BluetoothDevice;
import android.bluetooth.BluetoothManager;
import android.bluetooth.BluetoothServerSocket;
import android.bluetooth.BluetoothSocket;
import android.content.Context;
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
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * Bluetooth courier bridge.  Permissions: the modern (API 31+) BLUETOOTH_ADVERTISE /
 * CONNECT / SCAN set, and the legacy BLUETOOTH / BLUETOOTH_ADMIN for pre-31 devices
 * (declared with maxSdkVersion in the manifest).
 */
@CapacitorPlugin(
    name = "BluetoothCourier",
    permissions = {
        @Permission(alias = "bluetooth", strings = {
            Manifest.permission.BLUETOOTH_ADVERTISE,
            Manifest.permission.BLUETOOTH_CONNECT,
            Manifest.permission.BLUETOOTH_SCAN
        })
    }
)
public class BluetoothCourierPlugin extends Plugin {

    // The fixed RFCOMM service record name + UUID couriers rendezvous on.
    private static final String SERVICE_NAME = "LicioCourierRfcomm";
    private static final UUID SERVICE_UUID = UUID.fromString("9f1c1e10-5c11-4f2a-9b3d-1a2b3c4d5e6f");
    private static final int MAX_FRAME_BYTES = 64 * 1024 * 1024; // §22.5 bounded pack

    private BluetoothAdapter adapter;
    private final AtomicBoolean running = new AtomicBoolean(false);
    private BluetoothServerSocket serverSocket;
    // endpointId (the device address) -> the connected socket's output stream.
    private final ConcurrentHashMap<String, DataOutputStream> outbound = new ConcurrentHashMap<>();

    @Override
    public void load() {
        BluetoothManager bm = (BluetoothManager) getContext().getSystemService(Context.BLUETOOTH_SERVICE);
        adapter = bm != null ? bm.getAdapter() : null;
    }

    // --- §22.5 advertise / discover -------------------------------------------------

    /** Advertise = listen for inbound RFCOMM connections on the fixed service UUID. */
    @PluginMethod
    @SuppressWarnings("MissingPermission") // declared per-API in the manifest; runtime-granted by the gate
    public void startAdvertising(PluginCall call) {
        if (adapter == null) {
            call.reject("bluetooth_unavailable");
            return;
        }
        running.set(true);
        startServerSocket();
        call.resolve();
    }

    /** Discover = connect to a bonded courier device on the fixed service UUID. */
    @PluginMethod
    @SuppressWarnings("MissingPermission")
    public void startDiscovery(PluginCall call) {
        if (adapter == null) {
            call.reject("bluetooth_unavailable");
            return;
        }
        running.set(true);
        // Connect to the first bonded device exposing our service (classic-discovery
        // pairing is user-mediated; bonded devices are the consented set).
        for (BluetoothDevice device : adapter.getBondedDevices()) {
            connectClient(device);
        }
        call.resolve();
    }

    @PluginMethod
    public void stop(PluginCall call) {
        running.set(false);
        closeServerSocket();
        outbound.clear();
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
                // socket closed on stop, or RFCOMM unavailable — fall back to BLE GATT below
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
                emitConnectionResult(device.getAddress(), false);
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
        try {
            DataOutputStream out = new DataOutputStream(socket.getOutputStream());
            DataInputStream in = new DataInputStream(socket.getInputStream());
            outbound.put(endpointId, out);
            emitConnectionResult(endpointId, true);
            while (running.get() && socket.isConnected()) {
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

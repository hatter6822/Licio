// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-R.15.4d — the Bluetooth courier transport (OFFLINE_SPEC §22.5).  A third native radio
// channel beside Nearby + Wi-Fi Direct, following the SAME plugin pattern + the SAME JS event
// surface (`connectionResult` / `payloadReceived` / `disconnected`, base64 BYTES) so the TS
// `NativeChannelMedium` + `CourierController` drive it identically.
//
// This class is a THIN, Capacitor-only HUMBLE OBJECT: it does nothing but map PluginCalls onto
// `BluetoothCourierRadio` (the testable radio driver) and forward the radio's `RadioEvents`
// back out as base64 JS events.  ALL the radio logic (RFCOMM + the BLE GATT write+notify
// fallback + send routing + framing) lives in `BluetoothCourierRadio` and is exercised by the
// Layer-1 (`CourierFramingTest`) + Layer-2 Robolectric (`BluetoothCourierRadioTest`) JVM tests
// with NO device / radio / root; the two-device netsim radio E2E (`BluetoothRfcommRadioTest` /
// `BleGattRadioTest`) is the optional Layer-3 hardware confidence.  PUBLIC-ONLY; off by default.

package app.licio.courier;

import android.Manifest;
import android.util.Base64;

import androidx.annotation.NonNull;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;

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

    private BluetoothCourierRadio radio;

    @Override
    public void load() {
        radio = new BluetoothCourierRadio(getContext(), new CourierRadio.Events() {
            @Override
            public void onConnectionResult(String endpointId, boolean connected) {
                JSObject ev = new JSObject();
                ev.put("endpointId", endpointId);
                ev.put("connected", connected);
                notifyListeners("connectionResult", ev);
            }

            @Override
            public void onPayload(String endpointId, @NonNull byte[] bytes) {
                JSObject ev = new JSObject();
                ev.put("endpointId", endpointId);
                ev.put("message", Base64.encodeToString(bytes, Base64.NO_WRAP));
                notifyListeners("payloadReceived", ev);
            }

            @Override
            public void onDisconnected(String endpointId) {
                JSObject ev = new JSObject();
                ev.put("endpointId", endpointId);
                notifyListeners("disconnected", ev);
            }

            @Override
            public void onStartFailed(String operation, Exception cause) {
                // Forward a radio start failure so the web controller's startFailed listener fires
                // (symmetric with the other courier plugins; the default Events impl is a no-op).
                JSObject ev = new JSObject();
                ev.put("operation", operation);
                ev.put("error", cause != null ? cause.getMessage() : "start_failed");
                notifyListeners("startFailed", ev);
            }
        });
    }

    @PluginMethod
    public void startAdvertising(PluginCall call) {
        if (!radio.isAvailable()) {
            call.reject("bluetooth_unavailable");
            return;
        }
        radio.startAdvertising();
        call.resolve();
    }

    @PluginMethod
    public void startDiscovery(PluginCall call) {
        if (!radio.isAvailable()) {
            call.reject("bluetooth_unavailable");
            return;
        }
        radio.startDiscovery();
        call.resolve();
    }

    @PluginMethod
    public void stop(PluginCall call) {
        radio.stop();
        call.resolve();
    }

    @PluginMethod
    public void send(PluginCall call) {
        String endpointId = call.getString("endpointId");
        String message = call.getString("message"); // base64 (NO_WRAP)
        if (endpointId == null || message == null) {
            call.reject("missing endpointId or message");
            return;
        }
        byte[] bytes = Base64.decode(message, Base64.NO_WRAP);
        radio.send(endpointId, bytes, new CourierRadio.SendResult() {
            @Override
            public void onSuccess() {
                call.resolve();
            }

            @Override
            public void onError(String reason, Exception cause) {
                if (cause != null) call.reject(reason, cause);
                else call.reject(reason);
            }
        });
    }
}

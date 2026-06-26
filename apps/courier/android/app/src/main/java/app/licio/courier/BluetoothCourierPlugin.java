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
import android.os.Build;
import android.util.Base64;

import androidx.annotation.NonNull;

import java.util.ArrayList;
import java.util.List;

import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

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
        }),
        // Pre-S (API 23–30) BLE SCANNING requires a runtime location grant (declared maxSdk 32 in
        // the manifest); without it the scan returns empty/rejected instead of prompting the user.
        @Permission(alias = "location", strings = {
            Manifest.permission.ACCESS_FINE_LOCATION,
            Manifest.permission.ACCESS_COARSE_LOCATION
        })
    }
)
public class BluetoothCourierPlugin extends Plugin {

    private BluetoothCourierRadio radio;
    // Bumped on stop(): a permission prompt launched before a stop has a STALE generation, so its
    // grant callback is dropped instead of starting a radio with no active controller (#14).
    private int permissionGen = 0;
    // The generation captured when the current permission prompt was launched.
    private int promptGen = 0;

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
        String[] needed = neededAliases(false);
        if (needed.length > 0) {
            promptGen = permissionGen; // capture the generation so a stop during the prompt is seen
            requestPermissionForAliases(needed, call, "btPermissionCallback");
            return;
        }
        if (!radio.isAvailable()) {
            call.reject("bluetooth_unavailable");
            return;
        }
        radio.startAdvertising();
        call.resolve();
    }

    @PluginMethod
    public void startDiscovery(PluginCall call) {
        String[] needed = neededAliases(true);
        if (needed.length > 0) {
            promptGen = permissionGen;
            requestPermissionForAliases(needed, call, "btPermissionCallback");
            return;
        }
        if (!radio.isAvailable()) {
            call.reject("bluetooth_unavailable");
            return;
        }
        radio.startDiscovery();
        call.resolve();
    }

    /** The runtime-permission aliases REQUIRED at this API level that are not yet granted.  On
     *  API 31+ that is the BLUETOOTH_ADVERTISE/CONNECT/SCAN set; on pre-31 the legacy
     *  BLUETOOTH/BLUETOOTH_ADMIN are install-time (auto-granted), BUT BLE SCANNING (discovery)
     *  additionally needs a runtime location grant — so advertising needs nothing while discovery
     *  needs `location`.  Requested before starting so the user is prompted instead of the BLE scan
     *  failing silently into an empty result. */
    private String[] neededAliases(boolean forDiscovery) {
        List<String> missing = new ArrayList<>();
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            if (getPermissionState("bluetooth") != PermissionState.GRANTED) missing.add("bluetooth");
        } else if (forDiscovery && getPermissionState("location") != PermissionState.GRANTED) {
            missing.add("location"); // pre-S BLE scan requires location
        }
        return missing.toArray(new String[0]);
    }

    /** After the runtime prompt, re-dispatch the original start (now permitted) or reject — so the
     *  user is asked, instead of the radio failing silently.  A stop() during the prompt invalidates
     *  the grant (a stale generation): the radio must NOT start with no active controller (#14). */
    @PermissionCallback
    private void btPermissionCallback(PluginCall call) {
        if (promptGen != permissionGen) {
            call.reject("bluetooth_courier_stopped"); // a stop() happened while the prompt was open
            return;
        }
        boolean forDiscovery = "startDiscovery".equals(call.getMethodName());
        if (neededAliases(forDiscovery).length > 0) {
            call.reject("bluetooth_permission_denied");
            return;
        }
        if (forDiscovery) {
            startDiscovery(call);
        } else {
            startAdvertising(call);
        }
    }

    @PluginMethod
    public void stop(PluginCall call) {
        permissionGen++; // invalidate any permission prompt opened before this stop (#14)
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

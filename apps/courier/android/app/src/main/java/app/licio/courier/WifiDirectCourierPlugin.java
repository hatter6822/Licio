// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-R.15.4d — the Wi-Fi Direct courier transport (OFFLINE_SPEC §22.5).  A thin Capacitor
// HUMBLE OBJECT over `WifiDirectRadio` (the testable radio driver): it maps PluginCalls onto
// the radio and forwards its `CourierRadio.Events` out as base64 JS events.  ALL the logic
// (WifiP2pManager group formation + the length-prefixed socket data path) lives in
// `WifiDirectRadio` and is exercised by the Layer-1 (`CourierFramingTest`) + Layer-2
// Robolectric (`WifiDirectRadioTest`) JVM tests with NO device / radio / root.
//
// NOTE: Wi-Fi Direct GROUP FORMATION cannot run on two stock netsim emulators (netsim bridges
// only Bluetooth, not Wi-Fi); the real-radio `WifiDirectRadioTest` two-device leg is gated to
// real radios.  The unit tests above cover the orchestration + data path without a radio.
// DUMB byte pipe (frames re-validated on the TS side, §18.4); PUBLIC-ONLY; off by default.

package app.licio.courier;

import android.Manifest;
import android.os.Build;
import android.util.Base64;

import androidx.annotation.NonNull;

import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import java.util.ArrayList;
import java.util.List;

/**
 * Wi-Fi Direct courier bridge.  Permissions: the modern NEARBY_WIFI_DEVICES (API 33+,
 * neverForLocation), fine location for pre-33 Wi-Fi scanning, and the Wi-Fi/network state
 * the WifiP2pManager needs.
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

    private WifiDirectRadio radio;

    @Override
    public void load() {
        radio = new WifiDirectRadio(getContext(), new CourierRadio.Events() {
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
                // Forward a radio start failure (e.g. discoverPeers refused) so the web controller's
                // startFailed listener fires — else it shows a running courier with no discovery.
                JSObject ev = new JSObject();
                ev.put("operation", operation);
                ev.put("error", cause != null ? cause.getMessage() : "start_failed");
                notifyListeners("startFailed", ev);
            }
        });
    }

    @PluginMethod
    public void startAdvertising(PluginCall call) {
        String[] needed = missingAliases();
        if (needed.length > 0) {
            requestPermissionForAliases(needed, call, "permissionCallback");
            return;
        }
        if (!radio.isAvailable()) {
            call.reject("wifi_direct_unavailable");
            return;
        }
        radio.startAdvertising();
        call.resolve();
    }

    @PluginMethod
    public void startDiscovery(PluginCall call) {
        String[] needed = missingAliases();
        if (needed.length > 0) {
            requestPermissionForAliases(needed, call, "permissionCallback");
            return;
        }
        if (!radio.isAvailable()) {
            call.reject("wifi_direct_unavailable");
            return;
        }
        radio.startDiscovery();
        call.resolve();
    }

    /** The runtime-permission aliases REQUIRED at this API level that are not yet granted:
     *  NEARBY_WIFI_DEVICES (API 33+) OR fine location (pre-33, for the P2P scan).  Requested before
     *  starting so the user is prompted instead of the radio failing silently. */
    private String[] missingAliases() {
        String alias = Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU ? "nearbyWifi" : "location";
        List<String> missing = new ArrayList<>();
        if (getPermissionState(alias) != PermissionState.GRANTED) missing.add(alias);
        return missing.toArray(new String[0]);
    }

    /** After the runtime prompt, re-dispatch the original start (now permitted) or reject. */
    @PermissionCallback
    private void permissionCallback(PluginCall call) {
        if (missingAliases().length > 0) {
            call.reject("wifi_direct_permission_denied");
            return;
        }
        if ("startDiscovery".equals(call.getMethodName())) {
            startDiscovery(call);
        } else {
            startAdvertising(call);
        }
    }

    @PluginMethod
    public void stop(PluginCall call) {
        radio.stop();
        call.resolve();
    }

    @PluginMethod
    public void send(PluginCall call) {
        String endpointId = call.getString("endpointId");
        String message = call.getString("message");
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

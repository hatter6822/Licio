// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-R.15.4c — the Nearby Connections courier transport (OFFLINE_SPEC §22.5, §13.2).  A thin
// Capacitor HUMBLE OBJECT over `NearbyCourierRadio` (the pure courier orchestration) + the
// `GmsNearbyConnections` seam (the GMS glue): it maps PluginCalls onto the radio and forwards
// its `CourierRadio.Events` out as the base64 JS event surface the TS `NativeChannelMedium`
// consumes (`connectionResult` / `payloadReceived` / `disconnected`).  ALL the orchestration
// is unit-tested in `NearbyCourierRadioTest` (a fake seam, NO GMS / device / root); the GMS
// path is the optional Layer-3 netsim `NearbyConnectionsRadioTest`.
//
// (The historical `endpointFound` / `connectionInitiated` / `endpointLost` events were never
// consumed by the TS layer and are dropped — the radio reacts to them internally.)

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
 * The Nearby Connections bridge.  Permissions per API level: the API 31+ Bluetooth runtime
 * set, NEARBY_WIFI_DEVICES (API 33+, neverForLocation), and the fine/coarse location Nearby
 * still needs for scanning on pre-33 devices.  `P2P_CLUSTER` supports an M-to-N mesh.
 */
@CapacitorPlugin(
    name = "NearbyCourier",
    permissions = {
        @Permission(alias = "bluetooth", strings = {
            Manifest.permission.BLUETOOTH_ADVERTISE,
            Manifest.permission.BLUETOOTH_CONNECT,
            Manifest.permission.BLUETOOTH_SCAN
        }),
        @Permission(alias = "nearbyWifi", strings = { Manifest.permission.NEARBY_WIFI_DEVICES }),
        @Permission(alias = "location", strings = {
            Manifest.permission.ACCESS_FINE_LOCATION,
            Manifest.permission.ACCESS_COARSE_LOCATION
        })
    }
)
public class NearbyCourierPlugin extends Plugin {

    private NearbyCourierRadio radio;
    // Bumped on stop(): a permission prompt opened before a stop has a STALE generation, so its
    // grant callback is dropped instead of starting a radio with no active controller.
    private int permissionGen = 0;
    private int promptGen = 0;

    @Override
    public void load() {
        radio = new NearbyCourierRadio(new GmsNearbyConnections(getContext()), new CourierRadio.Events() {
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
                // Surface a refused advertise/discover start (GMS rejected the Task) so the TS
                // layer learns no start is running, instead of silently believing it succeeded.
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
            promptGen = permissionGen; // capture the generation so a stop during the prompt is seen
            requestPermissionForAliases(needed, call, "permissionCallback");
            return;
        }
        radio.applyConfig(call.getString("serviceId"), call.getString("endpointName"));
        radio.startAdvertising();
        call.resolve();
    }

    @PluginMethod
    public void startDiscovery(PluginCall call) {
        String[] needed = missingAliases();
        if (needed.length > 0) {
            promptGen = permissionGen; // capture the generation so a stop during the prompt is seen
            requestPermissionForAliases(needed, call, "permissionCallback");
            return;
        }
        radio.applyConfig(call.getString("serviceId"), call.getString("endpointName"));
        radio.startDiscovery();
        call.resolve();
    }

    /** The runtime-permission aliases REQUIRED at this API level that are not yet granted: BLUETOOTH
     *  (API 31+ for the Nearby BLE leg), and NEARBY_WIFI_DEVICES (API 33+) OR fine location (pre-33,
     *  for the scan).  Requesting them before starting prompts the user instead of failing silently. */
    private String[] missingAliases() {
        List<String> required = new ArrayList<>();
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) required.add("bluetooth");
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) required.add("nearbyWifi");
        else required.add("location");
        List<String> missing = new ArrayList<>();
        for (String alias : required) {
            if (getPermissionState(alias) != PermissionState.GRANTED) missing.add(alias);
        }
        return missing.toArray(new String[0]);
    }

    /** After the runtime prompt, re-dispatch the original start (now permitted) or reject. */
    @PermissionCallback
    private void permissionCallback(PluginCall call) {
        if (promptGen != permissionGen) {
            call.reject("nearby_stopped"); // a stop() happened while the prompt was open
            return;
        }
        if (missingAliases().length > 0) {
            call.reject("nearby_permission_denied");
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
        permissionGen++; // invalidate any permission prompt opened before this stop
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

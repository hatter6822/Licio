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
import android.util.Base64;

import androidx.annotation.NonNull;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;

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
        });
    }

    @PluginMethod
    public void startAdvertising(PluginCall call) {
        radio.applyConfig(call.getString("serviceId"), call.getString("endpointName"));
        radio.startAdvertising();
        call.resolve();
    }

    @PluginMethod
    public void startDiscovery(PluginCall call) {
        radio.applyConfig(call.getString("serviceId"), call.getString("endpointName"));
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

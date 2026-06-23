// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-R.15.4c — the Nearby Connections courier transport (OFFLINE_SPEC §22.5, §13.2).
// A typed Capacitor plugin bridging Android Nearby Connections (advertise / discover /
// request-connection / accept / send-payload / receive) to the TS `CourierMedium`
// (apps/web/src/lcap/transports/courier.ts) as an LcapTransport BYTE channel.
//
// This plugin is a DUMB pipe: it moves opaque bytes between proximate devices and
// performs NO content validation — every received frame is run through the SAME
// `validate(record_cid)` pipeline as any other transport on the TS side (§18.4, no
// transport trust).  The courier is PUBLIC-ONLY (the LcapTransport sets
// `carriesPrivate:false`); the §22.5 controls (discovery/advertising on-off,
// who-can-exchange, private-content exclusion, Stealth/Emergency force-off) are enforced
// on the TS side (WS-R.15.4e) BEFORE a pack is ever handed to `send`.  No radio/peer
// identifier (endpoint id, device name) is ever written to an LCAP schema — the JS layer
// uses these only as live-connection routing handles (the §3.7 / check:lcap-schema-egress
// doctrine), and the bytes crossing the JS↔native boundary are base64 (Capacitor cannot
// pass binary directly), decoded back to exact bytes so CID/AEAD verification holds.

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
import com.google.android.gms.nearby.Nearby;
import com.google.android.gms.nearby.connection.AdvertisingOptions;
import com.google.android.gms.nearby.connection.ConnectionInfo;
import com.google.android.gms.nearby.connection.ConnectionLifecycleCallback;
import com.google.android.gms.nearby.connection.ConnectionResolution;
import com.google.android.gms.nearby.connection.ConnectionsClient;
import com.google.android.gms.nearby.connection.ConnectionsStatusCodes;
import com.google.android.gms.nearby.connection.DiscoveredEndpointInfo;
import com.google.android.gms.nearby.connection.DiscoveryOptions;
import com.google.android.gms.nearby.connection.EndpointDiscoveryCallback;
import com.google.android.gms.nearby.connection.Payload;
import com.google.android.gms.nearby.connection.PayloadCallback;
import com.google.android.gms.nearby.connection.PayloadTransferUpdate;
import com.google.android.gms.nearby.connection.Strategy;

/**
 * The Nearby Connections bridge.  Permissions are declared per API level: the modern
 * (API 31+) Bluetooth runtime set, the API 33+ NEARBY_WIFI_DEVICES (neverForLocation),
 * the legacy Bluetooth + Wi-Fi-state set, and the fine/coarse location Nearby still needs
 * for scanning on pre-33 devices.  `cluster` strategy supports an M-to-N mesh of couriers.
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

    private static final Strategy STRATEGY = Strategy.P2P_CLUSTER;
    private static final String DEFAULT_SERVICE_ID = "app.licio.courier.lcap.v2";

    private ConnectionsClient connectionsClient;
    private String serviceId = DEFAULT_SERVICE_ID;
    private String localEndpointName = "licio-courier";

    @Override
    public void load() {
        connectionsClient = Nearby.getConnectionsClient(getContext());
    }

    // --- §22.5 advertise / discover -------------------------------------------------

    @PluginMethod
    public void startAdvertising(PluginCall call) {
        applyConfig(call);
        AdvertisingOptions options = new AdvertisingOptions.Builder().setStrategy(STRATEGY).build();
        connectionsClient
            .startAdvertising(localEndpointName, serviceId, connectionLifecycle, options)
            .addOnSuccessListener(unused -> call.resolve())
            .addOnFailureListener(e -> call.reject("advertising_failed", e));
    }

    @PluginMethod
    public void startDiscovery(PluginCall call) {
        applyConfig(call);
        DiscoveryOptions options = new DiscoveryOptions.Builder().setStrategy(STRATEGY).build();
        connectionsClient
            .startDiscovery(serviceId, endpointDiscovery, options)
            .addOnSuccessListener(unused -> call.resolve())
            .addOnFailureListener(e -> call.reject("discovery_failed", e));
    }

    @PluginMethod
    public void stop(PluginCall call) {
        connectionsClient.stopAdvertising();
        connectionsClient.stopDiscovery();
        connectionsClient.stopAllEndpoints();
        call.resolve();
    }

    // --- §13.2 chunked payload send -------------------------------------------------

    /** Send one base64-encoded byte chunk to a connected endpoint. */
    @PluginMethod
    public void send(PluginCall call) {
        String endpointId = call.getString("endpointId");
        String message = call.getString("message"); // base64 (NO_WRAP)
        if (endpointId == null || message == null) {
            call.reject("missing endpointId or message");
            return;
        }
        byte[] bytes = Base64.decode(message, Base64.NO_WRAP);
        connectionsClient
            .sendPayload(endpointId, Payload.fromBytes(bytes))
            .addOnSuccessListener(unused -> call.resolve())
            .addOnFailureListener(e -> call.reject("send_failed", e));
    }

    private void applyConfig(PluginCall call) {
        String svc = call.getString("serviceId");
        if (svc != null && !svc.isEmpty()) serviceId = svc;
        String name = call.getString("endpointName");
        if (name != null && !name.isEmpty()) localEndpointName = name;
    }

    // --- Nearby callbacks → JS events -----------------------------------------------

    private final ConnectionLifecycleCallback connectionLifecycle = new ConnectionLifecycleCallback() {
        @Override
        public void onConnectionInitiated(@NonNull String endpointId, @NonNull ConnectionInfo info) {
            // The courier moves PUBLIC bytes; content trust is enforced by validate() on the
            // TS side, so we accept the link and gate WHAT is offered above (WS-R.15.4e).
            connectionsClient.acceptConnection(endpointId, payloadCallback);
            JSObject ev = new JSObject();
            ev.put("endpointId", endpointId);
            ev.put("endpointName", info.getEndpointName());
            notifyListeners("connectionInitiated", ev);
        }

        @Override
        public void onConnectionResult(@NonNull String endpointId, @NonNull ConnectionResolution resolution) {
            JSObject ev = new JSObject();
            ev.put("endpointId", endpointId);
            ev.put("connected", resolution.getStatus().getStatusCode() == ConnectionsStatusCodes.STATUS_OK);
            notifyListeners("connectionResult", ev);
        }

        @Override
        public void onDisconnected(@NonNull String endpointId) {
            JSObject ev = new JSObject();
            ev.put("endpointId", endpointId);
            notifyListeners("disconnected", ev);
        }
    };

    private final EndpointDiscoveryCallback endpointDiscovery = new EndpointDiscoveryCallback() {
        @Override
        public void onEndpointFound(@NonNull String endpointId, @NonNull DiscoveredEndpointInfo info) {
            // Request a connection to a discovered courier on the same service id.
            connectionsClient.requestConnection(localEndpointName, endpointId, connectionLifecycle);
            JSObject ev = new JSObject();
            ev.put("endpointId", endpointId);
            ev.put("endpointName", info.getEndpointName());
            notifyListeners("endpointFound", ev);
        }

        @Override
        public void onEndpointLost(@NonNull String endpointId) {
            JSObject ev = new JSObject();
            ev.put("endpointId", endpointId);
            notifyListeners("endpointLost", ev);
        }
    };

    private final PayloadCallback payloadCallback = new PayloadCallback() {
        @Override
        public void onPayloadReceived(@NonNull String endpointId, @NonNull Payload payload) {
            byte[] bytes = payload.asBytes();
            if (bytes == null) return; // only BYTES payloads carry LCAP frames
            JSObject ev = new JSObject();
            ev.put("endpointId", endpointId);
            ev.put("message", Base64.encodeToString(bytes, Base64.NO_WRAP));
            notifyListeners("payloadReceived", ev);
        }

        @Override
        public void onPayloadTransferUpdate(@NonNull String endpointId, @NonNull PayloadTransferUpdate update) {
            // Bounded BYTES payloads complete atomically; no chunk reassembly here (the
            // TS layer chunks per the §13.2 transport profile).
        }
    };
}

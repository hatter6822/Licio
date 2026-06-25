// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-R.15.4c — the production `NearbyConnections` seam: the THIN glue that drives the real GMS
// `ConnectionsClient` and translates its callbacks into `NearbyConnections.Listener` calls.
// This is the only Nearby file that touches GMS, and it has no logic of its own (the courier
// orchestration is the unit-tested `NearbyCourierRadio`); the GMS path itself is covered by the
// two-device netsim radio E2E (`NearbyConnectionsRadioTest`), the optional Layer-3.

package app.licio.courier;

import android.content.Context;

import androidx.annotation.NonNull;

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

public class GmsNearbyConnections implements NearbyConnections {

    private static final Strategy STRATEGY = Strategy.P2P_CLUSTER;

    private final ConnectionsClient client;
    private Listener listener;

    public GmsNearbyConnections(Context ctx) {
        this.client = Nearby.getConnectionsClient(ctx);
    }

    @Override
    public void setListener(Listener listener) {
        this.listener = listener;
    }

    @Override
    public boolean isAvailable() {
        return client != null;
    }

    @Override
    public void startAdvertising(String localName, String serviceId) {
        // The start Task fails when GMS refuses (missing runtime permission, disabled Nearby/Play
        // Services, radio off) — surface that instead of dropping it, so the caller is not told a
        // start succeeded when no advertising is actually running.
        client.startAdvertising(localName, serviceId, lifecycle,
                        new AdvertisingOptions.Builder().setStrategy(STRATEGY).build())
                .addOnFailureListener(e -> {
                    if (listener != null) listener.onStartFailed("advertise", e);
                });
    }

    @Override
    public void startDiscovery(String serviceId) {
        client.startDiscovery(serviceId, discovery,
                        new DiscoveryOptions.Builder().setStrategy(STRATEGY).build())
                .addOnFailureListener(e -> {
                    if (listener != null) listener.onStartFailed("discover", e);
                });
    }

    @Override
    public void requestConnection(String localName, String endpointId) {
        client.requestConnection(localName, endpointId, lifecycle);
    }

    @Override
    public void acceptConnection(String endpointId) {
        client.acceptConnection(endpointId, payloadCallback);
    }

    @Override
    public void sendBytes(String endpointId, byte[] bytes, CourierRadio.SendResult result) {
        client.sendPayload(endpointId, Payload.fromBytes(bytes))
                .addOnSuccessListener(unused -> result.onSuccess())
                .addOnFailureListener(e -> result.onError("send_failed", e));
    }

    @Override
    public void stop() {
        client.stopAdvertising();
        client.stopDiscovery();
        client.stopAllEndpoints();
    }

    // --- GMS callbacks → the seam Listener ------------------------------------------

    private final ConnectionLifecycleCallback lifecycle = new ConnectionLifecycleCallback() {
        @Override
        public void onConnectionInitiated(@NonNull String endpointId, @NonNull ConnectionInfo info) {
            if (listener != null) listener.onConnectionInitiated(endpointId);
        }

        @Override
        public void onConnectionResult(@NonNull String endpointId, @NonNull ConnectionResolution resolution) {
            if (listener != null) {
                listener.onConnectionResult(endpointId,
                        resolution.getStatus().getStatusCode() == ConnectionsStatusCodes.STATUS_OK);
            }
        }

        @Override
        public void onDisconnected(@NonNull String endpointId) {
            if (listener != null) listener.onDisconnected(endpointId);
        }
    };

    private final EndpointDiscoveryCallback discovery = new EndpointDiscoveryCallback() {
        @Override
        public void onEndpointFound(@NonNull String endpointId, @NonNull DiscoveredEndpointInfo info) {
            if (listener != null) listener.onEndpointFound(endpointId, info.getServiceId());
        }

        @Override
        public void onEndpointLost(@NonNull String endpointId) {
            // A lost-before-connect endpoint needs no courier action.
        }
    };

    private final PayloadCallback payloadCallback = new PayloadCallback() {
        @Override
        public void onPayloadReceived(@NonNull String endpointId, @NonNull Payload payload) {
            byte[] bytes = payload.asBytes();
            if (bytes != null && listener != null) {
                listener.onPayloadReceived(endpointId, bytes); // only BYTES payloads carry frames
            }
        }

        @Override
        public void onPayloadTransferUpdate(@NonNull String endpointId, @NonNull PayloadTransferUpdate update) {
            // Bounded BYTES payloads complete atomically; no chunk reassembly here.
        }
    };
}

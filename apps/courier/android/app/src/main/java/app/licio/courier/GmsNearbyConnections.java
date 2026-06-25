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

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;

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
    // The §27 LCAP DoS cap — a received STREAM payload is buffered only up to this size.
    private static final int MAX_STREAM_BYTES = 64 * 1024 * 1024;

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
        // The request Task fails asynchronously if the endpoint vanished or GMS is busy/errored.
        // Without a failure listener the lifecycle callback never fires for this endpoint, so the
        // radio would never learn the dial failed (discovery stays "running" while the only found
        // peer is never exchanged with).  Report a negative connectionResult so the orchestration
        // is free to dial again on the next endpoint-found.
        client.requestConnection(localName, endpointId, lifecycle)
                .addOnFailureListener(e -> {
                    if (listener != null) listener.onConnectionResult(endpointId, false);
                });
    }

    @Override
    public void acceptConnection(String endpointId) {
        client.acceptConnection(endpointId, payloadCallback);
    }

    @Override
    public void sendBytes(String endpointId, byte[] bytes, CourierRadio.SendResult result) {
        // A Nearby BYTES payload is capped at Connections.MAX_BYTES_DATA_SIZE (~1 MiB), but an LCAP
        // exchange can reach the §27 64 MiB cap.  Send a STREAM payload (an ordered, unbounded byte
        // stream) so a large offline exchange is ferried WHOLE instead of being rejected.  The
        // receiver reassembles it on transfer completion (see payloadCallback).
        Payload payload = Payload.fromStream(new ByteArrayInputStream(bytes));
        client.sendPayload(endpointId, payload)
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

    // STREAM payloads in flight, by payload id — read to bytes only once the transfer completes.
    private final java.util.Map<Long, Payload> incomingStreams = new java.util.concurrent.ConcurrentHashMap<>();

    private final PayloadCallback payloadCallback = new PayloadCallback() {
        @Override
        public void onPayloadReceived(@NonNull String endpointId, @NonNull Payload payload) {
            if (payload.getType() == Payload.Type.STREAM) {
                // A STREAM is delivered incrementally — hold it until onPayloadTransferUpdate reports
                // SUCCESS, then read the full ordered byte stream (matches the sender's fromStream).
                incomingStreams.put(payload.getId(), payload);
                return;
            }
            byte[] bytes = payload.asBytes();
            if (bytes != null && listener != null) {
                listener.onPayloadReceived(endpointId, bytes); // a small BYTES payload carries frames too
            }
        }

        @Override
        public void onPayloadTransferUpdate(@NonNull String endpointId, @NonNull PayloadTransferUpdate update) {
            int status = update.getStatus();
            if (status == PayloadTransferUpdate.Status.IN_PROGRESS) return;
            Payload payload = incomingStreams.remove(update.getPayloadId());
            if (status != PayloadTransferUpdate.Status.SUCCESS) return; // FAILURE/CANCELED → dropped
            if (payload == null) return; // a BYTES payload (handled on receipt) or already consumed
            Payload.Stream stream = payload.asStream();
            if (stream == null || listener == null) return;
            try (InputStream in = stream.asInputStream()) {
                byte[] bytes = readStreamBounded(in);
                if (bytes != null) listener.onPayloadReceived(endpointId, bytes);
            } catch (IOException e) {
                // a truncated / failed stream — drop it; the exchange re-syncs on a later pass
            }
        }
    };

    /** Read a completed Nearby stream fully into memory, bounded by the §27 LCAP cap so a hostile
     *  peer cannot exhaust memory (the bytes are re-validated against their CIDs/COSE on the TS side). */
    private static byte[] readStreamBounded(InputStream in) throws IOException {
        ByteArrayOutputStream buffer = new ByteArrayOutputStream();
        byte[] chunk = new byte[64 * 1024];
        int total = 0;
        int n;
        while ((n = in.read(chunk)) != -1) {
            total += n;
            if (total > MAX_STREAM_BYTES) {
                return null; // over the cap — refuse rather than buffer an unbounded payload
            }
            buffer.write(chunk, 0, n);
        }
        return buffer.toByteArray();
    }
}

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
    // The generation of the latest start (#E), so a connection initiated under it can be tagged.
    private volatile long currentGeneration = 0;
    // endpoint id → the generation under which its connection was INITIATED, so every later
    // lifecycle callback (result/payload/disconnect) carries that generation and the radio can drop
    // a stale one from a superseded start.  Populated at initiation, removed on disconnect/failure.
    private final java.util.Map<String, Long> endpointGeneration =
            new java.util.concurrent.ConcurrentHashMap<>();

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
    public void startAdvertising(String localName, String serviceId, long generation) {
        currentGeneration = generation; // the current session generation (#E/#R)
        // The start Task fails when GMS refuses (missing runtime permission, disabled Nearby/Play
        // Services, radio off) — surface that instead of dropping it, so the caller is not told a
        // start succeeded when no advertising is actually running.  Echo the generation so the radio
        // can drop a stale failure from a superseded start.  The lifecycle CAPTURES this start's
        // generation (not the mutable field), so a connection initiated under it is tagged with the
        // start it belongs to — a stale initiation delivered after a Stop→Start records the OLD
        // generation and is dropped, not re-tagged with the new session (#Q).
        client.startAdvertising(localName, serviceId, lifecycleFor(generation),
                        new AdvertisingOptions.Builder().setStrategy(STRATEGY).build())
                .addOnFailureListener(e -> {
                    if (listener != null) listener.onStartFailed("advertise", generation, e);
                });
    }

    @Override
    public void startDiscovery(String serviceId, long generation) {
        currentGeneration = generation; // the current session generation (#E/#R)
        client.startDiscovery(serviceId, discoveryFor(generation),
                        new DiscoveryOptions.Builder().setStrategy(STRATEGY).build())
                .addOnFailureListener(e -> {
                    if (listener != null) listener.onStartFailed("discover", generation, e);
                });
    }

    @Override
    public void requestConnection(String localName, String endpointId) {
        // The request Task fails asynchronously if the endpoint vanished or GMS is busy/errored.
        // Without a failure listener the lifecycle callback never fires for this endpoint, so the
        // radio would never learn the dial failed (discovery stays "running" while the only found
        // peer is never exchanged with).  Report a negative connectionResult so the orchestration
        // is free to dial again on the next endpoint-found.
        // The dial is issued in the CURRENT session (the radio drops a stale endpoint-found before it
        // requests a connection), so the lifecycle captures `currentGeneration` (#Q).
        final long generation = currentGeneration;
        client.requestConnection(localName, endpointId, lifecycleFor(generation))
                .addOnFailureListener(e -> {
                    if (listener != null) listener.onConnectionResult(endpointId, false, generation);
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

    /** A lifecycle callback bound to the start `generation` it was registered under (#Q): a connection
     *  it initiates is tagged with THAT generation (captured at registration), not the mutable current
     *  one — so a stale initiation delivered after a Stop→Start records the OLD generation and the
     *  radio drops it, instead of it being re-tagged with the fresh session and accepted. */
    private ConnectionLifecycleCallback lifecycleFor(final long generation) {
        return new ConnectionLifecycleCallback() {
            @Override
            public void onConnectionInitiated(@NonNull String endpointId, @NonNull ConnectionInfo info) {
                // Record the generation this connection is born under ONLY when it is still the current
                // session — a delayed onConnectionInitiated from an OLD start must not overwrite a fresh
                // reconnection's generation in the shared map, which would then tag the current
                // connection's payloads as stale and have NearbyCourierRadio drop them (#AV).
                if (generation == currentGeneration) {
                    endpointGeneration.put(endpointId, generation);
                }
                if (listener != null) listener.onConnectionInitiated(endpointId, generation);
            }

            @Override
            public void onConnectionResult(@NonNull String endpointId, @NonNull ConnectionResolution resolution) {
                // Use THIS callback's CAPTURED generation, not the mutable map: a stale result from an
                // old start (delivered after a Stop→Start where the same endpoint already reconnected
                // under a fresh generation) must carry its OWN old generation so the radio drops it —
                // reading the map would retag it current.  Remove BY VALUE so a stale failure never
                // evicts the fresh connection's entry (which the payload path still needs) (#AF).
                boolean ok = resolution.getStatus().getStatusCode() == ConnectionsStatusCodes.STATUS_OK;
                if (!ok) endpointGeneration.remove(endpointId, generation);
                if (listener != null) listener.onConnectionResult(endpointId, ok, generation);
            }

            @Override
            public void onDisconnected(@NonNull String endpointId) {
                // Same: report THIS callback's generation and remove only our own entry by value, so a
                // stale disconnect can't evict / mis-tag a freshly reconnected endpoint (#AF).
                endpointGeneration.remove(endpointId, generation);
                if (listener != null) listener.onDisconnected(endpointId, generation);
            }
        };
    }

    /** A discovery callback bound to the start `generation` it was registered under (#MM): a found
     *  event is tagged with THAT generation (captured at registration), not the mutable current one
     *  — so an onEndpointFound queued by an OLD discovery run, delivered after a Stop→Start, carries
     *  the old generation and is dropped by the radio's guard instead of requesting a fresh dial. */
    private EndpointDiscoveryCallback discoveryFor(final long generation) {
        return new EndpointDiscoveryCallback() {
            @Override
            public void onEndpointFound(@NonNull String endpointId, @NonNull DiscoveredEndpointInfo info) {
                if (listener != null) listener.onEndpointFound(endpointId, info.getServiceId(), generation);
            }

            @Override
            public void onEndpointLost(@NonNull String endpointId) {
                // A lost-before-connect endpoint needs no courier action.
            }
        };
    }

    /** A STREAM payload in flight + the connection generation it was RECEIVED under — so a large
     *  stream that completes after a Stop→Start (when `endpointGeneration` may already hold the FRESH
     *  generation for a reconnected endpoint) is still tagged with the OLD generation and dropped by
     *  the radio's guard, not delivered to the new controller (#QQ). */
    private static final class IncomingStream {
        final Payload payload;
        final long generation;

        IncomingStream(Payload payload, long generation) {
            this.payload = payload;
            this.generation = generation;
        }
    }

    // STREAM payloads in flight, by payload id — read to bytes only once the transfer completes.
    private final java.util.Map<Long, IncomingStream> incomingStreams =
            new java.util.concurrent.ConcurrentHashMap<>();

    private final PayloadCallback payloadCallback = new PayloadCallback() {
        @Override
        public void onPayloadReceived(@NonNull String endpointId, @NonNull Payload payload) {
            // DROP a payload with no LIVE connection generation (the endpoint's entry was removed by a
            // disconnect/failure): defaulting to the mutable currentGeneration would tag a late payload
            // — delivered after a Stop→Start advanced the generation — as CURRENT, letting stale bytes
            // reach the fresh controller (#AU).
            Long gen = endpointGeneration.get(endpointId);
            if (gen == null) return;
            if (payload.getType() == Payload.Type.STREAM) {
                // A STREAM is delivered incrementally — hold it (with the generation it arrived under)
                // until onPayloadTransferUpdate reports SUCCESS, then read the full ordered byte
                // stream (matches the sender's fromStream).
                incomingStreams.put(payload.getId(), new IncomingStream(payload, gen));
                return;
            }
            byte[] bytes = payload.asBytes();
            if (bytes != null && listener != null) {
                // a small BYTES payload carries frames too — tag with the connection's generation (#E)
                listener.onPayloadReceived(endpointId, bytes, gen);
            }
        }

        @Override
        public void onPayloadTransferUpdate(@NonNull String endpointId, @NonNull PayloadTransferUpdate update) {
            int status = update.getStatus();
            if (status == PayloadTransferUpdate.Status.IN_PROGRESS) return;
            IncomingStream entry = incomingStreams.remove(update.getPayloadId());
            if (status != PayloadTransferUpdate.Status.SUCCESS) return; // FAILURE/CANCELED → dropped
            if (entry == null) return; // a BYTES payload (handled on receipt) or already consumed
            Payload.Stream stream = entry.payload.asStream();
            if (stream == null || listener == null) return;
            try (InputStream in = stream.asInputStream()) {
                byte[] bytes = readStreamBounded(in);
                if (bytes != null) {
                    // Tag with the generation the stream was RECEIVED under (#QQ), not the mutable
                    // current map — a stale stream completing after a reconnect stays old-gen.
                    listener.onPayloadReceived(endpointId, bytes, entry.generation);
                }
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

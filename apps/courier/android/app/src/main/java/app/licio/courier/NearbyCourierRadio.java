// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-R.15.4c — the Nearby Connections courier RADIO DRIVER (OFFLINE_SPEC §22.5, §13.2).  The
// PURE courier orchestration over the `NearbyConnections` seam: a discovered endpoint on the
// matching service id → request a connection; an initiated connection → accept it; a received
// BYTES payload → a `payloadReceived` event.  It has NO Android / GMS / Capacitor dependency
// (only the seam + `CourierRadio.Events`), so it is unit-tested on a plain JVM with a fake
// seam — NO GMS, NO device, NO root.  `GmsNearbyConnections` is the thin glue that drives the
// real `ConnectionsClient`; `NearbyCourierPlugin` is the Capacitor shim.
//
// DUMB byte pipe: Nearby BYTES payloads carry whole LCAP frames (the TS layer chunks per
// §13.2); every frame is re-validated against its CIDs/COSE signatures on the TS side (§18.4,
// no transport trust).  PUBLIC-ONLY; off by default.

package app.licio.courier;

import java.util.concurrent.atomic.AtomicBoolean;

public class NearbyCourierRadio implements CourierRadio, NearbyConnections.Listener {

    static final String DEFAULT_SERVICE_ID = "app.licio.courier.lcap.v2";

    private final NearbyConnections nearby;
    private final CourierRadio.Events events;
    // Gates the connection-INITIATING callbacks: a queued onEndpointFound / onConnectionInitiated
    // delivered AFTER stop() must NOT start/accept a fresh link (the web listeners are gone and no
    // later stop would tear it down).  Set on start, cleared on stop.
    private final AtomicBoolean running = new AtomicBoolean(false);
    // A per-SESSION generation bumped ONLY on stop — NOT on each direction start.  When both
    // directions are enabled the controller calls startAdvertising() THEN startDiscovery() for the
    // SAME session; bumping per start would make a late startAdvertising failure from the first call
    // look stale (dropped) even though it belongs to the live session (#R).  The seam echoes this
    // generation on a late start-failure / lifecycle callback so a failure from a SUPERSEDED session
    // (a quick Stop→Start) is dropped (#2).
    private volatile long startGeneration = 0;
    private String serviceId = DEFAULT_SERVICE_ID;
    private String localName = "licio-courier";

    public NearbyCourierRadio(NearbyConnections nearby, CourierRadio.Events events) {
        this.nearby = nearby;
        this.events = events;
        nearby.setListener(this);
    }

    /** Override the default service id / local endpoint name (the plugin reads these from JS). */
    void applyConfig(String overrideServiceId, String overrideName) {
        if (overrideServiceId != null && !overrideServiceId.isEmpty()) serviceId = overrideServiceId;
        if (overrideName != null && !overrideName.isEmpty()) localName = overrideName;
    }

    @Override
    public boolean isAvailable() {
        return nearby.isAvailable();
    }

    @Override
    public void startAdvertising() {
        running.set(true);
        nearby.startAdvertising(localName, serviceId, startGeneration); // the SESSION generation (#R)
    }

    @Override
    public void startDiscovery() {
        running.set(true);
        nearby.startDiscovery(serviceId, startGeneration); // the SAME session generation (#R)
    }

    @Override
    public void stop() {
        running.set(false);
        startGeneration++; // a NEW session — invalidate any in-flight start/lifecycle from the old one
        nearby.stop();
    }

    @Override
    public void send(String endpointId, byte[] payload, CourierRadio.SendResult result) {
        nearby.sendBytes(endpointId, payload, result);
    }

    // --- NearbyConnections.Listener: the courier orchestration ----------------------

    @Override
    public void onEndpointFound(String endpointId, String foundServiceId, long generation) {
        // A queued callback after stop()/restart must not open a fresh link: the courier is stopped
        // (running=false) OR this is a stale callback from a SUPERSEDED start (#E).
        if (!running.get() || generation != startGeneration) return;
        // Request a connection only to a courier advertising OUR service id.
        if (serviceId.equals(foundServiceId)) {
            nearby.requestConnection(localName, endpointId);
        }
    }

    @Override
    public void onConnectionInitiated(String endpointId, long generation) {
        // A queued/stale initiation must not be accepted (the courier is stopped, or a newer start
        // has superseded this one — no later stop would tear the link down) (#E).
        if (!running.get() || generation != startGeneration) return;
        // The courier moves PUBLIC bytes; content trust is enforced by validate() on the TS
        // side, so we accept the link and gate WHAT is offered above (WS-R.15.4e).
        nearby.acceptConnection(endpointId);
    }

    @Override
    public void onConnectionResult(String endpointId, boolean connected, long generation) {
        // Drop a stale result from a SUPERSEDED start — else a connection that succeeded in the
        // PREVIOUS run drives an exchange under the fresh controller (#E).
        if (generation != startGeneration) return;
        events.onConnectionResult(endpointId, connected);
    }

    @Override
    public void onDisconnected(String endpointId, long generation) {
        // A stale disconnect from a superseded start would spuriously signal a drop to the fresh
        // controller — drop it (#E).
        if (generation != startGeneration) return;
        events.onDisconnected(endpointId);
    }

    @Override
    public void onPayloadReceived(String endpointId, byte[] bytes, long generation) {
        // Drop a stale payload from a superseded start — a payload from the PREVIOUS run must not be
        // ingested/responded to under the fresh controller (#E).
        if (generation != startGeneration) return;
        events.onPayload(endpointId, bytes);
    }

    @Override
    public void onStartFailed(String operation, long generation, Exception cause) {
        // GMS refused to start advertising/discovery — surface it (the seam delivers it async).
        // DROP a stale failure from a SUPERSEDED start: a previous run's GMS Task can reject after a
        // quick Stop→Start, and forwarding it would tear the freshly-started Nearby courier down (#2).
        if (generation != startGeneration) return;
        events.onStartFailed(operation, cause);
    }
}

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

public class NearbyCourierRadio implements CourierRadio, NearbyConnections.Listener {

    static final String DEFAULT_SERVICE_ID = "app.licio.courier.lcap.v2";

    private final NearbyConnections nearby;
    private final CourierRadio.Events events;
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
        nearby.startAdvertising(localName, serviceId);
    }

    @Override
    public void startDiscovery() {
        nearby.startDiscovery(serviceId);
    }

    @Override
    public void stop() {
        nearby.stop();
    }

    @Override
    public void send(String endpointId, byte[] payload, CourierRadio.SendResult result) {
        nearby.sendBytes(endpointId, payload, result);
    }

    // --- NearbyConnections.Listener: the courier orchestration ----------------------

    @Override
    public void onEndpointFound(String endpointId, String foundServiceId) {
        // Request a connection only to a courier advertising OUR service id.
        if (serviceId.equals(foundServiceId)) {
            nearby.requestConnection(localName, endpointId);
        }
    }

    @Override
    public void onConnectionInitiated(String endpointId) {
        // The courier moves PUBLIC bytes; content trust is enforced by validate() on the TS
        // side, so we accept the link and gate WHAT is offered above (WS-R.15.4e).
        nearby.acceptConnection(endpointId);
    }

    @Override
    public void onConnectionResult(String endpointId, boolean connected) {
        events.onConnectionResult(endpointId, connected);
    }

    @Override
    public void onDisconnected(String endpointId) {
        events.onDisconnected(endpointId);
    }

    @Override
    public void onPayloadReceived(String endpointId, byte[] bytes) {
        events.onPayload(endpointId, bytes);
    }
}

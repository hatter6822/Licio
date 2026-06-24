// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-R.15.4c — the narrow seam over Google Nearby Connections that `NearbyCourierRadio`
// depends on instead of the GMS `ConnectionsClient` directly.  GMS is NOT Robolectric-
// shadowable, so this interface is the dependency-injection boundary: the production
// `GmsNearbyConnections` wraps the real client + translates GMS callbacks into `Listener`
// calls, while a tiny fake lets the radio's COURIER ORCHESTRATION (found→request,
// initiated→accept, payload→event) be unit-tested on a plain JVM with NO GMS / device / root.

package app.licio.courier;

public interface NearbyConnections {

    /** The Nearby events the radio reacts to (the impl translates GMS callbacks into these). */
    interface Listener {
        /** A peer advertising on a service id was discovered. */
        void onEndpointFound(String endpointId, String serviceId);

        /** A connection was initiated (the radio decides whether to accept). */
        void onConnectionInitiated(String endpointId);

        /** A connection attempt resolved (connected or not). */
        void onConnectionResult(String endpointId, boolean connected);

        /** A connected endpoint dropped. */
        void onDisconnected(String endpointId);

        /** A BYTES payload arrived (null/non-BYTES payloads are filtered by the impl). */
        void onPayloadReceived(String endpointId, byte[] bytes);
    }

    void setListener(Listener listener);

    /** Whether Nearby Connections is usable on this device. */
    boolean isAvailable();

    void startAdvertising(String localName, String serviceId);

    void startDiscovery(String serviceId);

    void requestConnection(String localName, String endpointId);

    void acceptConnection(String endpointId);

    /** Send one BYTES payload; report delivery via {@code result}. */
    void sendBytes(String endpointId, byte[] bytes, CourierRadio.SendResult result);

    void stop();
}

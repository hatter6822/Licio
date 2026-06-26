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

    /** The Nearby events the radio reacts to (the impl translates GMS callbacks into these).
     *  Every callback carries the {@code generation} of the start it belongs to (the impl records
     *  it per endpoint at initiation), so the radio can DROP a stale lifecycle callback from a
     *  SUPERSEDED start — a connection/payload/disconnect from a previous run delivered after a
     *  Stop→Start must not drive/respond to an exchange under the fresh controller (#E). */
    interface Listener {
        /** A peer advertising on a service id was discovered. */
        void onEndpointFound(String endpointId, String serviceId, long generation);

        /** A connection was initiated (the radio decides whether to accept). */
        void onConnectionInitiated(String endpointId, long generation);

        /** A connection attempt resolved (connected or not). */
        void onConnectionResult(String endpointId, boolean connected, long generation);

        /** A connected endpoint dropped. */
        void onDisconnected(String endpointId, long generation);

        /** A BYTES payload arrived (null/non-BYTES payloads are filtered by the impl). */
        void onPayloadReceived(String endpointId, byte[] bytes, long generation);

        /** A start request ({@code "advertise"}/{@code "discover"}) FAILED — GMS delivers this
         *  asynchronously via the start Task, so it must be surfaced (not dropped) or the caller
         *  would believe a start succeeded when no advertising/discovery is actually running.  The
         *  {@code generation} is the value passed to the start call that failed, so the radio can
         *  DROP a stale failure from a superseded start (a quick Stop→Start / live restart). */
        void onStartFailed(String operation, long generation, Exception cause);
    }

    void setListener(Listener listener);

    /** Whether Nearby Connections is usable on this device. */
    boolean isAvailable();

    /** {@code generation} tags this start so a late failure Task can be matched to it (and dropped
     *  when a newer start has superseded it). */
    void startAdvertising(String localName, String serviceId, long generation);

    void startDiscovery(String serviceId, long generation);

    void requestConnection(String localName, String endpointId);

    void acceptConnection(String endpointId);

    /** Send one BYTES payload; report delivery via {@code result}. */
    void sendBytes(String endpointId, byte[] bytes, CourierRadio.SendResult result);

    void stop();
}

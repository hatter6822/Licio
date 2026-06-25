// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Layer-1/2 of the courier test pyramid: PLAIN-JVM tests of the Nearby courier orchestration
// (`NearbyCourierRadio`) over a FAKE `NearbyConnections` seam — NO GMS, NO Robolectric, NO
// device, NO radio, NO root.  Because the GMS glue was isolated into `GmsNearbyConnections`,
// the courier decision logic (found-on-matching-service → request; initiated → accept; payload
// → event; result/disconnect → event; send → seam) is fully unit-testable here.

package app.licio.courier;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;

import java.util.ArrayList;
import java.util.List;

import org.junit.Test;

public class NearbyCourierRadioTest {

    /** A fake seam: records the radio's outbound calls + exposes the listener to inject events. */
    private static final class FakeNearby implements NearbyConnections {
        Listener listener;
        String advertisedName;
        String advertisedService;
        String discoveredService;
        final List<String> requested = new ArrayList<>();
        final List<String> accepted = new ArrayList<>();
        String sentEndpoint;
        byte[] sentBytes;
        boolean stopped;
        boolean available = true;
        boolean sendSucceeds = true;

        @Override
        public void setListener(Listener listener) {
            this.listener = listener;
        }

        @Override
        public boolean isAvailable() {
            return available;
        }

        @Override
        public void startAdvertising(String localName, String serviceId) {
            advertisedName = localName;
            advertisedService = serviceId;
        }

        @Override
        public void startDiscovery(String serviceId) {
            discoveredService = serviceId;
        }

        @Override
        public void requestConnection(String localName, String endpointId) {
            requested.add(endpointId);
        }

        @Override
        public void acceptConnection(String endpointId) {
            accepted.add(endpointId);
        }

        @Override
        public void sendBytes(String endpointId, byte[] bytes, CourierRadio.SendResult result) {
            sentEndpoint = endpointId;
            sentBytes = bytes;
            if (sendSucceeds) result.onSuccess();
            else result.onError("send_failed", null);
        }

        @Override
        public void stop() {
            stopped = true;
        }
    }

    private static final class Recorder implements CourierRadio.Events {
        String connectedEndpoint;
        Boolean connectedFlag;
        String payloadEndpoint;
        byte[] payload;
        String disconnectedEndpoint;
        String startFailedOperation;
        Exception startFailedCause;

        @Override
        public void onConnectionResult(String endpointId, boolean connected) {
            connectedEndpoint = endpointId;
            connectedFlag = connected;
        }

        @Override
        public void onPayload(String endpointId, byte[] bytes) {
            payloadEndpoint = endpointId;
            payload = bytes;
        }

        @Override
        public void onDisconnected(String endpointId) {
            disconnectedEndpoint = endpointId;
        }

        @Override
        public void onStartFailed(String operation, Exception cause) {
            startFailedOperation = operation;
            startFailedCause = cause;
        }
    }

    @Test
    public void startAdvertisingUsesTheDefaultServiceAndName() {
        FakeNearby fake = new FakeNearby();
        new NearbyCourierRadio(fake, new Recorder()).startAdvertising();
        assertEquals(NearbyCourierRadio.DEFAULT_SERVICE_ID, fake.advertisedService);
        assertEquals("licio-courier", fake.advertisedName);
    }

    @Test
    public void applyConfigOverridesServiceAndName() {
        FakeNearby fake = new FakeNearby();
        NearbyCourierRadio radio = new NearbyCourierRadio(fake, new Recorder());
        radio.applyConfig("custom.service", "courier-A");
        radio.startDiscovery();
        assertEquals("custom.service", fake.discoveredService);
        radio.startAdvertising();
        assertEquals("courier-A", fake.advertisedName);
    }

    @Test
    public void aPeerOnTheMatchingServiceTriggersAConnectionRequest() {
        FakeNearby fake = new FakeNearby();
        new NearbyCourierRadio(fake, new Recorder());
        fake.listener.onEndpointFound("ep-1", NearbyCourierRadio.DEFAULT_SERVICE_ID);
        assertEquals(1, fake.requested.size());
        assertEquals("ep-1", fake.requested.get(0));
    }

    @Test
    public void aPeerOnADifferentServiceIsIgnored() {
        FakeNearby fake = new FakeNearby();
        new NearbyCourierRadio(fake, new Recorder());
        fake.listener.onEndpointFound("ep-x", "some.other.app.service");
        assertEquals("no connection requested to a foreign service", 0, fake.requested.size());
    }

    @Test
    public void anInitiatedConnectionIsAccepted() {
        FakeNearby fake = new FakeNearby();
        new NearbyCourierRadio(fake, new Recorder());
        fake.listener.onConnectionInitiated("ep-2");
        assertEquals(1, fake.accepted.size());
        assertEquals("ep-2", fake.accepted.get(0));
    }

    @Test
    public void connectionResultPayloadAndDisconnectReachTheEvents() {
        FakeNearby fake = new FakeNearby();
        Recorder rec = new Recorder();
        new NearbyCourierRadio(fake, rec);

        fake.listener.onConnectionResult("ep-3", true);
        assertEquals("ep-3", rec.connectedEndpoint);
        assertEquals(Boolean.TRUE, rec.connectedFlag);

        byte[] frame = "nearby-frame".getBytes();
        fake.listener.onPayloadReceived("ep-3", frame);
        assertEquals("ep-3", rec.payloadEndpoint);
        assertArrayEquals(frame, rec.payload);

        fake.listener.onDisconnected("ep-3");
        assertEquals("ep-3", rec.disconnectedEndpoint);
    }

    @Test
    public void sendForwardsToTheSeamAndReportsSuccess() {
        FakeNearby fake = new FakeNearby();
        NearbyCourierRadio radio = new NearbyCourierRadio(fake, new Recorder());
        byte[] payload = {9, 8, 7};
        final boolean[] ok = {false};
        radio.send("ep-4", payload, new CourierRadio.SendResult() {
            @Override
            public void onSuccess() {
                ok[0] = true;
            }

            @Override
            public void onError(String reason, Exception cause) {
                ok[0] = false;
            }
        });
        assertEquals("ep-4", fake.sentEndpoint);
        assertArrayEquals(payload, fake.sentBytes);
        assertEquals(Boolean.TRUE, (Boolean) ok[0]);
    }

    @Test
    public void sendPropagatesAFailure() {
        FakeNearby fake = new FakeNearby();
        fake.sendSucceeds = false;
        NearbyCourierRadio radio = new NearbyCourierRadio(fake, new Recorder());
        final String[] reason = {null};
        radio.send("ep-5", new byte[] {1}, new CourierRadio.SendResult() {
            @Override
            public void onSuccess() {
                reason[0] = "UNEXPECTED";
            }

            @Override
            public void onError(String r, Exception cause) {
                reason[0] = r;
            }
        });
        assertEquals("send_failed", reason[0]);
    }

    @Test
    public void stopForwardsToTheSeam() {
        FakeNearby fake = new FakeNearby();
        new NearbyCourierRadio(fake, new Recorder()).stop();
        assertEquals(Boolean.TRUE, (Boolean) fake.stopped);
    }

    @Test
    public void aRefusedStartIsPropagatedToTheEventsNotDropped() {
        // GMS delivers an advertise/discover refusal asynchronously via the start Task; the seam
        // surfaces it as onStartFailed, which the radio must forward (not swallow) so the caller
        // learns no start is running rather than believing it succeeded.
        FakeNearby fake = new FakeNearby();
        Recorder rec = new Recorder();
        new NearbyCourierRadio(fake, rec);
        Exception cause = new IllegalStateException("nearby_disabled");
        fake.listener.onStartFailed("advertise", cause);
        assertEquals("advertise", rec.startFailedOperation);
        assertEquals(cause, rec.startFailedCause);
    }
}

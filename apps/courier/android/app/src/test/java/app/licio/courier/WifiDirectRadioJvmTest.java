// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Layer-2 (Robolectric) tests of `WifiDirectRadio` — NO device, NO radio, NO root.  Wi-Fi
// Direct group formation cannot run on two stock netsim emulators, so unit coverage focuses on
// the framework-facing behaviour: availability + send-routing fail-closed.  The connected
// data-path (the length-prefixed socket framing + outbound routing + lifecycle) is the SHARED
// `CourierStreamLink`, covered deterministically over in-memory pipes in `CourierStreamLinkTest`
// — so this radio needs NO real-socket / fixed-port test seam, and the socket SETUP (the
// group-owner-vs-client role decision + bind/accept/connect) is exercised on real radios by the
// netsim `WifiDirectRadioTest`.

package app.licio.courier;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

import android.content.Context;

import androidx.test.core.app.ApplicationProvider;

import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 34)
public class WifiDirectRadioJvmTest {

    private static final class Recorder implements CourierRadio.Events {
        @Override
        public void onConnectionResult(String endpointId, boolean isConnected) {}

        @Override
        public void onPayload(String endpointId, byte[] bytes) {}

        @Override
        public void onDisconnected(String endpointId) {}
    }

    private static Context ctx() {
        return ApplicationProvider.getApplicationContext();
    }

    @Test
    public void wifiP2pIsAvailableUnderRobolectric() {
        assertTrue(new WifiDirectRadio(ctx(), new Recorder()).isAvailable());
    }

    @Test
    public void sendToAnUnknownEndpointFailsClosed() {
        WifiDirectRadio radio = new WifiDirectRadio(ctx(), new Recorder());
        final String[] error = {null};
        radio.send("192.168.49.1", new byte[] {1, 2, 3}, new CourierRadio.SendResult() {
            @Override
            public void onSuccess() {
                error[0] = "UNEXPECTED_SUCCESS";
            }

            @Override
            public void onError(String reason, Exception cause) {
                error[0] = reason;
            }
        });
        assertEquals("endpoint_not_connected", error[0]);
    }
}

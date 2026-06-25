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
import android.net.wifi.p2p.WifiP2pInfo;

import androidx.test.core.app.ApplicationProvider;

import java.net.InetAddress;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

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
    public void duplicateConnectionInfoForOneGroupStartsTheClientDialOnce() throws Exception {
        // Android can deliver CONNECTION_CHANGED more than once for ONE formed group; the radio must
        // dial the group owner only ONCE (a second dispatch races a duplicate link/event).  The one
        // dial to a refused loopback port fails fast → exactly one onConnectionResult(false).
        AtomicInteger results = new AtomicInteger();
        CountDownLatch firstResult = new CountDownLatch(1);
        WifiDirectRadio radio = new WifiDirectRadio(ctx(), new CourierRadio.Events() {
            @Override
            public void onConnectionResult(String endpointId, boolean connected) {
                results.incrementAndGet();
                firstResult.countDown();
            }

            @Override
            public void onPayload(String endpointId, byte[] bytes) {}

            @Override
            public void onDisconnected(String endpointId) {}
        });

        WifiP2pInfo info = new WifiP2pInfo();
        info.groupFormed = true;
        info.isGroupOwner = false; // the CLIENT dials the owner — an observable single dial
        info.groupOwnerAddress = InetAddress.getByName("127.0.0.1");

        radio.onConnectionInfo(info);
        radio.onConnectionInfo(info); // duplicate for the SAME group — must NOT dial again
        assertTrue("the one client dial reported a result", firstResult.await(5, TimeUnit.SECONDS));
        Thread.sleep(300); // give a (wrongly) second dial time to also fail, were the guard broken
        assertEquals("one formed group ⇒ exactly one client dial", 1, results.get());
        radio.stop();
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

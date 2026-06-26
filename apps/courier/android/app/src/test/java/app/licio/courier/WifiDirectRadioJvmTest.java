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
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import android.content.Context;
import android.net.wifi.p2p.WifiP2pInfo;

import androidx.test.core.app.ApplicationProvider;

import java.io.IOException;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
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
    public void advertiseOnlyBecomesAGroupOwner_neverScanning() {
        // Advertise-only must NOT scan (Wi-Fi Direct discoverPeers scans): it becomes a GROUP owner.
        WifiDirectRadio radio = new WifiDirectRadio(ctx(), new Recorder());
        radio.startAdvertising();
        assertEquals(WifiDirectRadio.WifiMode.GROUP, radio.currentMode);
        radio.stop();
        assertEquals(WifiDirectRadio.WifiMode.NONE, radio.currentMode);
    }

    @Test
    public void discoveryArrivingSecondUpgradesTheGroupOwnerToScanning() {
        // The controller sends advertise + discover as SEPARATE async PluginCalls: advertise lands
        // first (GROUP, no scan), then discovery lands — it must UPGRADE to DISCOVER (scanning),
        // never leave the courier as a non-scanning group owner.
        WifiDirectRadio radio = new WifiDirectRadio(ctx(), new Recorder());
        radio.startAdvertising();
        assertEquals(WifiDirectRadio.WifiMode.GROUP, radio.currentMode);
        radio.startDiscovery(); // arrives second
        assertEquals("discovery upgrades the radio to scanning", WifiDirectRadio.WifiMode.DISCOVER,
                radio.currentMode);
        radio.stop();
    }

    @Test
    public void discoveryAloneScans() {
        WifiDirectRadio radio = new WifiDirectRadio(ctx(), new Recorder());
        radio.startDiscovery();
        assertEquals(WifiDirectRadio.WifiMode.DISCOVER, radio.currentMode);
        radio.stop();
    }

    @Test
    public void aCallbackFromASupersededStartIsStale() {
        // The start GENERATION is what a native WifiP2pManager.ActionListener captures; a STALE
        // failure (from a superseded start) is dropped before it emits onStartFailed.  Robolectric
        // cannot invoke the native listener, so assert the guard (isStale) directly across a restart.
        WifiDirectRadio radio = new WifiDirectRadio(ctx(), new Recorder());
        radio.startDiscovery();
        long gen = radio.startGeneration;
        assertFalse("the current generation is not stale", radio.isStale(gen));
        radio.stop();
        assertTrue("a callback captured before the stop is now stale", radio.isStale(gen));
        radio.startDiscovery();
        assertTrue("...and stays stale after the restart (the new start has a fresh gen)",
                radio.isStale(gen));
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

        radio.startDiscovery(); // onConnectionInfo only fires while the radio is running
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
    public void aFailedClientDialReleasesTheGroupClaimSoAlaterCallbackRetries() throws Exception {
        // The client dial to a refused loopback port FAILS → the per-group claim is RELEASED, so a
        // later CONNECTION_CHANGED for the still-formed group dials AGAIN (not skipped until dissolve).
        AtomicInteger results = new AtomicInteger();
        WifiDirectRadio radio = new WifiDirectRadio(ctx(), new CourierRadio.Events() {
            @Override
            public void onConnectionResult(String endpointId, boolean connected) {
                results.incrementAndGet();
            }

            @Override
            public void onPayload(String endpointId, byte[] bytes) {}

            @Override
            public void onDisconnected(String endpointId) {}
        });
        radio.startDiscovery(); // onConnectionInfo only fires while the radio is running
        WifiP2pInfo info = new WifiP2pInfo();
        info.groupFormed = true;
        info.isGroupOwner = false;
        info.groupOwnerAddress = InetAddress.getByName("127.0.0.1");

        radio.onConnectionInfo(info);
        waitForCount(results, 1); // the first dial failed (refused) → claim released
        radio.onConnectionInfo(info); // RETRY for the same formed group — must dial again
        waitForCount(results, 2);
        radio.stop();
    }

    @Test
    public void aClosedClientSessionReleasesTheGroupClaimSoAlaterCallbackRedials() throws Exception {
        // A LIVE client session that ENDS (the owner closes the data socket → the client link EOFs)
        // must release the per-group claim, so a later CONNECTION_CHANGED for the STILL-formed group
        // redials.  A `finally` that left groupActive set would strand the courier disconnected until
        // the group dissolved.  Stand up a throwaway "owner" on DATA_PORT that accepts each dial and
        // immediately closes it, so each client session connects (onConnectionResult(true)) then EOFs.
        AtomicInteger connects = new AtomicInteger();
        AtomicInteger disconnects = new AtomicInteger();
        WifiDirectRadio radio = new WifiDirectRadio(ctx(), new CourierRadio.Events() {
            @Override
            public void onConnectionResult(String endpointId, boolean connected) {
                if (connected) connects.incrementAndGet();
            }

            @Override
            public void onPayload(String endpointId, byte[] bytes) {}

            @Override
            public void onDisconnected(String endpointId) {
                disconnects.incrementAndGet();
            }
        });

        ServerSocket owner = new ServerSocket(WifiDirectRadio.DATA_PORT);
        Thread acceptLoop = new Thread(() -> {
            try {
                while (true) {
                    Socket s = owner.accept();
                    s.close(); // end the session immediately → the client's link EOFs
                }
            } catch (IOException ignored) {
                // owner closed on teardown
            }
        });
        acceptLoop.setDaemon(true);
        acceptLoop.start();

        WifiP2pInfo info = new WifiP2pInfo();
        info.groupFormed = true;
        info.isGroupOwner = false; // the CLIENT dials the owner
        info.groupOwnerAddress = InetAddress.getByName("127.0.0.1");

        // In production onConnectionInfo only fires after startDiscovery() set running=true; mirror
        // that precondition so the post-connect running-check (which aborts a dial that completes
        // after stop()) does not abort this LIVE session.
        radio.startDiscovery();
        try {
            radio.onConnectionInfo(info);  // first dial: connects, then the owner closes → EOF
            waitForCount(connects, 1);
            waitForCount(disconnects, 1); // the session ended (onDisconnected emitted)
            Thread.sleep(200);            // let connectClientSocket's finally release the claim
            radio.onConnectionInfo(info);  // redial for the SAME still-formed group must be ALLOWED
            waitForCount(connects, 2);     // hangs here if the claim were not released
            assertEquals("exactly the two dials we triggered", 2, connects.get());
        } finally {
            radio.stop();
            owner.close();
        }
    }

    @Test
    public void aServerBindFailureReleasesTheGroupClaimAndReportsStartFailed() throws Exception {
        // Occupy DATA_PORT so the group OWNER's ServerSocket bind fails.  The owner claim is taken
        // (groupActive) BEFORE startServerSocket() runs, so a bind failure must RELEASE it AND surface
        // onStartFailed("server_bind") — else the controller shows Wi-Fi Direct running with no server
        // socket and the stale claim blocks every retry.  Proof of release: a second owner callback
        // can re-claim and bind-fail again ONLY if the first failure cleared the claim.
        ServerSocket occupy = new ServerSocket(WifiDirectRadio.DATA_PORT);
        AtomicInteger bindFailures = new AtomicInteger();
        WifiDirectRadio radio = new WifiDirectRadio(ctx(), new CourierRadio.Events() {
            @Override
            public void onConnectionResult(String endpointId, boolean connected) {}

            @Override
            public void onPayload(String endpointId, byte[] bytes) {}

            @Override
            public void onDisconnected(String endpointId) {}

            @Override
            public void onStartFailed(String operation, Exception cause) {
                if ("server_bind".equals(operation)) bindFailures.incrementAndGet();
            }
        });
        radio.startDiscovery(); // onConnectionInfo only fires while the radio is running
        WifiP2pInfo owner = new WifiP2pInfo();
        owner.groupFormed = true;
        owner.isGroupOwner = true; // this device is the group owner → it binds the server socket

        try {
            radio.onConnectionInfo(owner);   // claim → startServerSocket → bind fails → release + fail
            waitForCount(bindFailures, 1);
            radio.onConnectionInfo(owner);   // re-claim is possible ONLY if the first failure released it
            waitForCount(bindFailures, 2);
            assertEquals("each owner callback bind-failed (claim released between)", 2, bindFailures.get());
        } finally {
            radio.stop();
            occupy.close();
        }
    }

    @Test
    public void connectionInfoDeliveredAfterStopDoesNotDial() throws Exception {
        // A queued requestConnectionInfo callback delivered after stop() must NOT claim the group or
        // start any socket setup — running is false, so onConnectionInfo returns early (no dial,
        // no peer-visible link, and no stale groupActive claim blocking the next start).
        AtomicInteger results = new AtomicInteger();
        WifiDirectRadio radio = new WifiDirectRadio(ctx(), new CourierRadio.Events() {
            @Override
            public void onConnectionResult(String endpointId, boolean connected) {
                results.incrementAndGet();
            }

            @Override
            public void onPayload(String endpointId, byte[] bytes) {}

            @Override
            public void onDisconnected(String endpointId) {}
        });
        radio.startDiscovery(); // running = true
        radio.stop();           // running = false

        WifiP2pInfo info = new WifiP2pInfo();
        info.groupFormed = true;
        info.isGroupOwner = false; // would otherwise dial the owner
        info.groupOwnerAddress = InetAddress.getByName("127.0.0.1");
        radio.onConnectionInfo(info); // a late callback after stop — must be ignored
        Thread.sleep(300);            // give a (wrongly) issued dial time to fail, were the guard gone
        assertEquals("no dial after stop", 0, results.get());
    }

    private static void waitForCount(AtomicInteger counter, int target) throws InterruptedException {
        for (int i = 0; i < 50 && counter.get() < target; i++) {
            Thread.sleep(100);
        }
        assertEquals(target, counter.get());
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

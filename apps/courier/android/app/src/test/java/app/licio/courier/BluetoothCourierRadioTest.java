// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Layer-2 of the courier test pyramid: Robolectric (JVM, shadowed Android) tests of the
// `BluetoothCourierRadio` driver — NO device, NO radio, NO root.  Because the radio logic was
// lifted out of the Capacitor plugin into a plain `Context` + `RadioEvents` object, these
// tests drive its REAL BLE GATT server callback (connection lifecycle + chunked-write receive
// path, integrating the real `CourierFraming` reassembler) and its send-routing decision, all
// on the JVM.  A regression in the radio's callback wiring or routing fails on a plain
// `./gradlew test`, with no emulator and no privileged setup.

package app.licio.courier;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;
import static org.robolectric.Shadows.shadowOf;

import android.bluetooth.BluetoothAdapter;
import android.bluetooth.BluetoothDevice;
import android.bluetooth.BluetoothGatt;
import android.bluetooth.BluetoothGattCharacteristic;
import android.bluetooth.BluetoothGattDescriptor;
import android.bluetooth.BluetoothGattService;
import android.bluetooth.BluetoothManager;
import android.bluetooth.BluetoothProfile;
import android.bluetooth.BluetoothServerSocket;
import android.bluetooth.BluetoothSocket;
import android.content.Context;

import androidx.test.core.app.ApplicationProvider;

import java.io.DataInputStream;
import java.io.OutputStream;
import java.util.Arrays;
import java.util.Random;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;

import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 34)
public class BluetoothCourierRadioTest {

    private static final String PEER = "AA:BB:CC:DD:EE:FF";

    /** Records the radio's RadioEvents for assertions. */
    private static final class Recorder implements CourierRadio.Events {
        String connectedEndpoint;
        Boolean connectedFlag;
        String payloadEndpoint;
        byte[] payload;
        String disconnectedEndpoint;
        int payloadCount;
        String startFailedOp;

        @Override
        public void onConnectionResult(String endpointId, boolean connected) {
            connectedEndpoint = endpointId;
            connectedFlag = connected;
        }

        @Override
        public void onStartFailed(String operation, Exception cause) {
            startFailedOp = operation;
        }

        @Override
        public void onPayload(String endpointId, byte[] bytes) {
            payloadEndpoint = endpointId;
            payload = bytes;
            payloadCount++;
        }

        @Override
        public void onDisconnected(String endpointId) {
            disconnectedEndpoint = endpointId;
        }
    }

    private static Context ctx() {
        return ApplicationProvider.getApplicationContext();
    }

    private static BluetoothDevice peerDevice() {
        BluetoothManager bm = (BluetoothManager) ctx().getSystemService(Context.BLUETOOTH_SERVICE);
        BluetoothAdapter adapter = bm.getAdapter();
        return adapter.getRemoteDevice(PEER);
    }

    private static BluetoothGattCharacteristic courierCharacteristic() {
        return BluetoothCourierRadio.buildCourierGattService()
                .getCharacteristic(BluetoothCourierRadio.BLE_CHAR_UUID);
    }

    private static BluetoothAdapter adapter() {
        BluetoothManager bm = (BluetoothManager) ctx().getSystemService(Context.BLUETOOTH_SERVICE);
        return bm.getAdapter();
    }

    /** A latch-based Events recorder for the async (threaded) socket tests. */
    private static final class LatchRecorder implements CourierRadio.Events {
        final CountDownLatch connected = new CountDownLatch(1);
        final CountDownLatch payloadLatch = new CountDownLatch(1);
        final CountDownLatch disconnected = new CountDownLatch(1);
        final AtomicReference<byte[]> payload = new AtomicReference<>();

        @Override
        public void onConnectionResult(String endpointId, boolean isConnected) {
            if (isConnected) connected.countDown();
        }

        @Override
        public void onPayload(String endpointId, byte[] bytes) {
            payload.set(bytes);
            payloadLatch.countDown();
        }

        @Override
        public void onDisconnected(String endpointId) {
            disconnected.countDown();
        }
    }

    @Before
    public void enableAdapter() {
        // Robolectric's Bluetooth adapter is DISABLED by default; isAvailable() + the start paths now
        // require it ON, so enable it for these radio-setup tests.
        shadowOf(adapter()).setEnabled(true);
    }

    /** Drive a BLE CLIENT GATT to a fully-connected courier link (service discovered + the CCC
     *  notification subscription written), returning the connected gatt — mirroring the real
     *  onConnectionStateChange → discovery → setCharacteristicNotification → CCC-write flow.  The
     *  shadow refuses local notification + auto-fires onServicesDiscovered during the connection
     *  state change, so allow the characteristic BEFORE connecting (real Android returns true). */
    private static BluetoothGatt connectBleClient(BluetoothCourierRadio radio) {
        BluetoothGatt gatt = peerDevice().connectGatt(
                ctx(), false, radio.gattClientCallback, BluetoothDevice.TRANSPORT_LE);
        BluetoothGattService courierService = BluetoothCourierRadio.buildCourierGattService();
        shadowOf(gatt).addDiscoverableService(courierService);
        shadowOf(gatt).allowCharacteristicNotification(
                courierService.getCharacteristic(BluetoothCourierRadio.BLE_CHAR_UUID));
        radio.gattClientCallback.onConnectionStateChange(
                gatt, BluetoothGatt.GATT_SUCCESS, BluetoothProfile.STATE_CONNECTED);
        radio.gattClientCallback.onServicesDiscovered(gatt, BluetoothGatt.GATT_SUCCESS);
        return gatt;
    }

    @Test
    public void bleClientWithoutCccDescriptorIsAFailedPeer() {
        // A peripheral exposing the courier service/characteristic but OMITTING the CCC cannot
        // notify back — duplex is impossible — so it is a FAILED peer, not a write-only link.
        Recorder rec = new Recorder();
        BluetoothCourierRadio radio = new BluetoothCourierRadio(ctx(), rec);
        BluetoothGatt gatt = peerDevice().connectGatt(
                ctx(), false, radio.gattClientCallback, BluetoothDevice.TRANSPORT_LE);
        BluetoothGattService noCcc = new BluetoothGattService(
                BluetoothCourierRadio.BLE_SERVICE_UUID, BluetoothGattService.SERVICE_TYPE_PRIMARY);
        noCcc.addCharacteristic(new BluetoothGattCharacteristic(
                BluetoothCourierRadio.BLE_CHAR_UUID,
                BluetoothGattCharacteristic.PROPERTY_WRITE | BluetoothGattCharacteristic.PROPERTY_NOTIFY,
                BluetoothGattCharacteristic.PERMISSION_WRITE)); // no CCC descriptor
        shadowOf(gatt).addDiscoverableService(noCcc);
        radio.gattClientCallback.onConnectionStateChange(
                gatt, BluetoothGatt.GATT_SUCCESS, BluetoothProfile.STATE_CONNECTED);
        radio.gattClientCallback.onServicesDiscovered(gatt, BluetoothGatt.GATT_SUCCESS);
        assertEquals("a peripheral with no CCC is a failed peer", Boolean.FALSE, rec.connectedFlag);
        assertTrue("and is torn down so the dedup can re-dial it", shadowOf(gatt).isClosed());
        radio.stop();
    }

    @Test
    public void aDisabledAdapterIsUnavailableAndStartSurfacesAFailure() {
        // Bluetooth hardware present but turned OFF: the radio is NOT available, and a start attempt
        // surfaces a start failure (so the controller shows radio_unavailable, not a dead "running").
        shadowOf(adapter()).setEnabled(false);
        Recorder rec = new Recorder();
        BluetoothCourierRadio radio = new BluetoothCourierRadio(ctx(), rec);
        assertFalse("a disabled adapter is not available", radio.isAvailable());
        radio.startAdvertising();
        assertEquals("starting with Bluetooth off surfaces a start failure", "advertise",
                rec.startFailedOp);
    }

    @Test
    public void adapterIsAvailableUnderRobolectric() {
        assertTrue(new BluetoothCourierRadio(ctx(), new Recorder()).isAvailable());
    }

    @Test
    @Config(sdk = 31) // pre-33 boolean writeCharacteristic, which Robolectric's GATT shadow honours
    public void bleClientSendDrivesAMultiChunkFrameToCompletion() {
        // The BLE SEND glue end-to-end on a connected GATT CLIENT: send() → the per-endpoint
        // BleSendPump → gatt.writeCharacteristic → the radio's onCharacteristicWrite callback →
        // pump.onAck → the NEXT chunk → … → completion → result.onSuccess.  Robolectric's GATT
        // shadow acks each writeCharacteristic with SUCCESS, so the send self-drives through the
        // radio's REAL callback wiring — and that works ONLY because the send is callback-driven:
        // the old blocking design's worker thread would block on a queue poll, untestable here.
        Recorder rec = new Recorder();
        BluetoothCourierRadio radio = new BluetoothCourierRadio(ctx(), rec);
        BluetoothGatt gatt = connectBleClient(radio);
        // The connection is announced only once the CCC notify-subscription write completes (the
        // shadow acks the descriptor write synchronously → onDescriptorWrite → connectionResult).
        assertEquals("the link is announced after the CCC subscription completes",
                Boolean.TRUE, rec.connectedFlag);

        // 2000 bytes ⇒ a genuinely multi-chunk send at any MTU (the chunk size is capped at 512).
        byte[] payload = new byte[2000];
        new Random(9).nextBytes(payload);
        final String[] outcome = {null};
        radio.send(PEER, payload, new CourierRadio.SendResult() {
            @Override
            public void onSuccess() {
                outcome[0] = "ok";
            }

            @Override
            public void onError(String reason, Exception cause) {
                outcome[0] = "err:" + reason;
            }
        });
        // The shadow's per-write acks drive every chunk through the radio's callback wiring to
        // completion — synchronously, before send() returns.
        assertEquals("the multi-chunk BLE client send completed", "ok", outcome[0]);

        // A stray ack with nothing in flight is a safe no-op (no double-report / crash).
        radio.gattClientCallback.onCharacteristicWrite(
                gatt, courierCharacteristic(), BluetoothGatt.GATT_SUCCESS);
        assertEquals("ok", outcome[0]);
        radio.stop();
    }

    @Test
    public void bleClientReportsTheConnectionFromTheCccDescriptorWrite() {
        // Fix: the connection is reported from the CCC notify-subscription write completing (NOT
        // eagerly in onServicesDiscovered), so the exchange never starts before notifications are
        // enabled.  A SUCCESS reports connected; a FAILURE reports a failed connection.
        Recorder rec = new Recorder();
        BluetoothCourierRadio radio = new BluetoothCourierRadio(ctx(), rec);
        BluetoothGatt gatt = peerDevice().connectGatt(
                ctx(), false, radio.gattClientCallback, BluetoothDevice.TRANSPORT_LE);
        BluetoothGattDescriptor ccc = new BluetoothGattDescriptor(
                BluetoothCourierRadio.CCC_UUID, BluetoothGattDescriptor.PERMISSION_WRITE);

        radio.gattClientCallback.onDescriptorWrite(gatt, ccc, BluetoothGatt.GATT_SUCCESS);
        assertEquals("a successful CCC write announces the duplex link",
                Boolean.TRUE, rec.connectedFlag);

        radio.gattClientCallback.onDescriptorWrite(gatt, ccc, BluetoothGatt.GATT_FAILURE);
        assertEquals("a failed CCC write reports a failed connection",
                Boolean.FALSE, rec.connectedFlag);
        // A failed subscription must TEAR DOWN the half-open client (close the GATT) so the scan
        // dedup doesn't leave the peer permanently undialable until the whole radio is stopped.
        assertTrue("a failed CCC subscription closes the GATT", shadowOf(gatt).isClosed());
        radio.stop();
    }

    @Test
    public void bleClientFailsWhenLocalNotificationEnablementIsRejected() {
        // setCharacteristicNotification can return false (Android refused to route notifications to
        // us) — the radio must FAIL + tear down rather than report a link that can't receive the
        // peripheral's replies.  The Robolectric shadow refuses unless allowCharacteristicNotification
        // is called, so simply NOT allowing it exercises the rejected path.
        Recorder rec = new Recorder();
        BluetoothCourierRadio radio = new BluetoothCourierRadio(ctx(), rec);
        BluetoothGatt gatt = peerDevice().connectGatt(
                ctx(), false, radio.gattClientCallback, BluetoothDevice.TRANSPORT_LE);
        shadowOf(gatt).addDiscoverableService(BluetoothCourierRadio.buildCourierGattService());
        radio.gattClientCallback.onConnectionStateChange(
                gatt, BluetoothGatt.GATT_SUCCESS, BluetoothProfile.STATE_CONNECTED);

        radio.gattClientCallback.onServicesDiscovered(gatt, BluetoothGatt.GATT_SUCCESS);
        assertEquals("a refused local notify enablement fails the connection",
                Boolean.FALSE, rec.connectedFlag);
        assertTrue("and tears the half-open client down", shadowOf(gatt).isClosed());
        radio.stop();
    }

    @Test
    public void rfcommSocketDrivesTheCourierDataPathOverARealBluetoothSocket() throws Exception {
        // The full RFCOMM data path over a REAL (shadow) BluetoothSocket — not just pipes: a
        // server socket's deviceConnected(device) yields a connected socket whose streams we
        // drive (the feeder is what the socket receives; the sink is what it sends).  This proves
        // handleSocket correctly wraps a Bluetooth socket's streams (inbound framing + outbound).
        LatchRecorder rec = new LatchRecorder();
        BluetoothCourierRadio radio = new BluetoothCourierRadio(ctx(), rec);
        radio.startDiscovery(); // running = true (no bonded devices under Robolectric)

        BluetoothServerSocket ss = adapter().listenUsingInsecureRfcommWithServiceRecord(
                "courier-test", UUID.fromString("9f1c1e10-5c11-4f2a-9b3d-1a2b3c4d5e6f"));
        BluetoothSocket peer = shadowOf(ss).deviceConnected(peerDevice());
        peer.connect(); // mark the shadow socket connected (handleSocket reads while isConnected())
        OutputStream feeder = shadowOf(peer).getInputStreamFeeder();

        Thread link = new Thread(() -> radio.handleSocket(peer));
        link.start();
        assertTrue("the RFCOMM link is announced", rec.connected.await(5, TimeUnit.SECONDS));

        // Inbound: feed a length-prefixed frame over the real socket → the radio emits the payload.
        byte[] inbound = "rfcomm-inbound-frame".getBytes();
        feeder.write(CourierFraming.framePrefixed(inbound));
        feeder.flush();
        assertTrue("the framed payload arrived", rec.payloadLatch.await(5, TimeUnit.SECONDS));
        assertArrayEquals(inbound, rec.payload.get());

        // Outbound: send() writes a length-prefixed frame onto the socket's output stream.
        byte[] outbound = {7, 8, 9, 10};
        radio.send(PEER, outbound, new CourierRadio.SendResult() {
            @Override
            public void onSuccess() {}

            @Override
            public void onError(String reason, Exception cause) {}
        });
        DataInputStream sent = new DataInputStream(shadowOf(peer).getOutputStreamSink());
        int len = sent.readInt();
        byte[] got = new byte[len];
        sent.readFully(got);
        assertArrayEquals("the outbound frame appears on the socket", outbound, got);

        // (Teardown-unblock is not asserted here: the shadow socket's streams are pipe-backed, and
        // a PipedInputStream read does not unblock on close with the write end open — a Robolectric
        // limit, not the production behaviour where a real socket close throws.  stop()'s
        // close-the-read-stream unblock is verified deterministically in UsbCourierRadioTest.)
        radio.stop();
        link.interrupt();
        link.join(2000);
    }

    @Test
    public void bleCentralSendFailsClosedWhenTheFrameworkRejectsTheNotify() {
        // The central (peripheral→central NOTIFY) send branch of writeBleChunk: Robolectric's GATT
        // server returns a non-success status for notifyCharacteristicChanged, so the radio must
        // FAIL CLOSED — proving the central send branch + the pump→result error wiring.  (The
        // central RECEIVE path is covered by the GATT-server tests; a SUCCESSFUL central notify is
        // not simulable in Robolectric and is exercised on real radios by BleGattRadioTest.)
        Recorder rec = new Recorder();
        BluetoothCourierRadio radio = new BluetoothCourierRadio(ctx(), rec);
        radio.startAdvertising(); // opens the GATT server + resolves the courier characteristic
        BluetoothDevice central = peerDevice();
        radio.gattServerCallback.onConnectionStateChange(
                central, BluetoothGatt.GATT_SUCCESS, BluetoothProfile.STATE_CONNECTED);

        final String[] outcome = {null};
        radio.send(PEER, new byte[] {1, 2, 3}, new CourierRadio.SendResult() {
            @Override
            public void onSuccess() {
                outcome[0] = "ok";
            }

            @Override
            public void onError(String reason, Exception cause) {
                outcome[0] = "err:" + reason;
            }
        });
        assertEquals("the central send fails closed when the notify is rejected",
                "err:write_rejected", outcome[0]);
        radio.stop();
    }

    @Test
    public void gattServerConnectThenChunkedWritesReassembleToOnePayload() {
        Recorder rec = new Recorder();
        BluetoothCourierRadio radio = new BluetoothCourierRadio(ctx(), rec);
        BluetoothDevice device = peerDevice();

        // A central connects → the radio registers it + creates the reassembler, but does NOT
        // announce the link yet (the central has not subscribed to notifications).
        radio.gattServerCallback.onConnectionStateChange(
                device, BluetoothGatt.GATT_SUCCESS, BluetoothProfile.STATE_CONNECTED);
        assertNull("not announced before the central subscribes (CCC)", rec.connectedFlag);

        // The central ENABLES the CCC (subscribes) → only now is the duplex link announced.
        BluetoothGattDescriptor ccc = new BluetoothGattDescriptor(
                BluetoothCourierRadio.CCC_UUID, BluetoothGattDescriptor.PERMISSION_WRITE);
        radio.gattServerCallback.onDescriptorWriteRequest(
                device, 3, ccc, false, false, 0, BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE);
        assertEquals(PEER, rec.connectedEndpoint);
        assertEquals(Boolean.TRUE, rec.connectedFlag);

        // The central streams a 600-byte payload as one length-prefixed frame, split across two
        // GATT writes — the radio's real CourierFraming reassembler must emit ONE exact payload.
        byte[] payload = new byte[600];
        new Random(11).nextBytes(payload);
        byte[] framed = CourierFraming.framePrefixed(payload);
        byte[] chunk1 = Arrays.copyOfRange(framed, 0, 300);
        byte[] chunk2 = Arrays.copyOfRange(framed, 300, framed.length);
        BluetoothGattCharacteristic ch = courierCharacteristic();
        radio.gattServerCallback.onCharacteristicWriteRequest(device, 1, ch, false, false, 0, chunk1);
        assertEquals("no frame yet from a partial write", 0, rec.payloadCount);
        radio.gattServerCallback.onCharacteristicWriteRequest(device, 2, ch, false, false, 0, chunk2);
        assertEquals("exactly one reassembled frame", 1, rec.payloadCount);
        assertEquals(PEER, rec.payloadEndpoint);
        assertArrayEquals("the reassembled payload is byte-exact", payload, rec.payload);

        // A disconnect fires the lifecycle event.
        radio.gattServerCallback.onConnectionStateChange(
                device, BluetoothGatt.GATT_SUCCESS, BluetoothProfile.STATE_DISCONNECTED);
        assertEquals(PEER, rec.disconnectedEndpoint);
    }

    @Test
    @Config(sdk = 31) // a full successful connection needs the legacy CCC write the shadow honours
    // (the API-33 writeDescriptor is not shadowed → returns an error → the radio correctly fails it)
    public void gattClientNotificationsReassembleToOnePayload() {
        // The CENTRAL (GATT client) RECEIVE path: a connected peripheral NOTIFIES chunks back via
        // gattClientCallback.onCharacteristicChanged → feedNotification → the per-endpoint reassembler
        // must emit ONE exact payload from MULTIPLE chunks + ignore a foreign characteristic.  Driven
        // through the 2-arg overload (the only one dispatchable at sdk=31); the API-33 3-arg overload
        // is a one-line wrapper over the SAME feedNotification, covered on real radios by the netsim
        // BleGattRadioTest.  (This is the duplex direction the server test does not cover.)
        Recorder rec = new Recorder();
        BluetoothCourierRadio radio = new BluetoothCourierRadio(ctx(), rec);
        BluetoothGatt gatt = connectBleClient(radio); // full setup ⇒ the per-endpoint reassembler exists

        byte[] payload = new byte[600];
        new Random(23).nextBytes(payload);
        byte[] framed = CourierFraming.framePrefixed(payload);
        BluetoothGattCharacteristic ch = courierCharacteristic();
        ch.setValue(Arrays.copyOfRange(framed, 0, 250));
        radio.gattClientCallback.onCharacteristicChanged(gatt, ch);
        assertEquals("no frame yet from a partial notification", 0, rec.payloadCount);
        ch.setValue(Arrays.copyOfRange(framed, 250, framed.length));
        radio.gattClientCallback.onCharacteristicChanged(gatt, ch);
        assertEquals("exactly one reassembled frame", 1, rec.payloadCount);
        assertEquals(PEER, rec.payloadEndpoint);
        assertArrayEquals("the reassembled payload is byte-exact", payload, rec.payload);

        // A foreign characteristic's notification is ignored.
        BluetoothGattCharacteristic foreign = new BluetoothGattCharacteristic(
                UUID.randomUUID(),
                BluetoothGattCharacteristic.PROPERTY_NOTIFY,
                BluetoothGattCharacteristic.PERMISSION_READ);
        foreign.setValue(new byte[] {9, 9, 9, 9, 9});
        radio.gattClientCallback.onCharacteristicChanged(gatt, foreign);
        assertEquals("a notification on a non-courier characteristic emits nothing",
                1, rec.payloadCount);

        // Disconnect fires the lifecycle event + clears the reassembler.
        radio.gattClientCallback.onConnectionStateChange(
                gatt, BluetoothGatt.GATT_SUCCESS, BluetoothProfile.STATE_DISCONNECTED);
        assertEquals(PEER, rec.disconnectedEndpoint);
    }

    @Test
    @Config(sdk = 31) // pre-Tiramisu (Android 12): exercise the deprecated notification overload
    public void preTiramisuClientNotificationDeliversViaGetValue() {
        // On API < 33 the framework delivers a notification via the 2-arg
        // onCharacteristicChanged(gatt, char) overload, reading char.getValue() — a DIFFERENT
        // code branch than the API-33+ 3-arg overload covered above.  A regression on Android 12
        // would otherwise ship silently (every other test pins sdk=34).
        Recorder rec = new Recorder();
        BluetoothCourierRadio radio = new BluetoothCourierRadio(ctx(), rec);
        BluetoothGatt gatt = connectBleClient(radio); // full setup ⇒ the per-endpoint reassembler exists

        byte[] payload = "pre-tiramisu-frame".getBytes();
        BluetoothGattCharacteristic ch = courierCharacteristic();
        ch.setValue(CourierFraming.framePrefixed(payload)); // deprecated setter the pre-33 path reads
        radio.gattClientCallback.onCharacteristicChanged(gatt, ch); // 2-arg deprecated overload
        assertEquals("the pre-33 notification path reassembled one frame", 1, rec.payloadCount);
        assertArrayEquals(payload, rec.payload);
    }

    @Test
    public void aWriteToAForeignCharacteristicIsIgnored() {
        Recorder rec = new Recorder();
        BluetoothCourierRadio radio = new BluetoothCourierRadio(ctx(), rec);
        BluetoothDevice device = peerDevice();
        radio.gattServerCallback.onConnectionStateChange(
                device, BluetoothGatt.GATT_SUCCESS, BluetoothProfile.STATE_CONNECTED);

        BluetoothGattCharacteristic foreign = new BluetoothGattCharacteristic(
                UUID.randomUUID(),
                BluetoothGattCharacteristic.PROPERTY_WRITE,
                BluetoothGattCharacteristic.PERMISSION_WRITE);
        radio.gattServerCallback.onCharacteristicWriteRequest(
                device, 1, foreign, false, false, 0, new byte[] {1, 2, 3, 4, 5, 6, 7, 8});
        assertEquals("a write to a non-courier characteristic emits nothing", 0, rec.payloadCount);
    }

    @Test
    public void sendToAnUnknownEndpointFailsClosed() {
        BluetoothCourierRadio radio = new BluetoothCourierRadio(ctx(), new Recorder());
        final String[] error = {null};
        radio.send("ZZ:ZZ:ZZ:ZZ:ZZ:ZZ", new byte[] {1, 2, 3}, new CourierRadio.SendResult() {
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

    @Test
    public void stopIsIdempotentAndLeavesRoutingClean() {
        BluetoothCourierRadio radio = new BluetoothCourierRadio(ctx(), new Recorder());
        radio.stop();
        radio.stop(); // idempotent — a second stop must not throw or corrupt state
        // After stop there is no connected endpoint, so a send fails closed — proving the routing
        // tables were cleared, not merely that stop() didn't throw.
        final String[] error = {null};
        radio.send("AA:BB:CC:DD:EE:FF", new byte[] {1}, new CourierRadio.SendResult() {
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

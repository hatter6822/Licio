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
import static org.junit.Assert.assertTrue;

import android.bluetooth.BluetoothAdapter;
import android.bluetooth.BluetoothDevice;
import android.bluetooth.BluetoothGatt;
import android.bluetooth.BluetoothGattCharacteristic;
import android.bluetooth.BluetoothManager;
import android.bluetooth.BluetoothProfile;
import android.content.Context;

import androidx.test.core.app.ApplicationProvider;

import java.util.Arrays;
import java.util.Random;
import java.util.UUID;

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

        @Override
        public void onConnectionResult(String endpointId, boolean connected) {
            connectedEndpoint = endpointId;
            connectedFlag = connected;
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

    @Test
    public void adapterIsAvailableUnderRobolectric() {
        assertTrue(new BluetoothCourierRadio(ctx(), new Recorder()).isAvailable());
    }

    @Test
    public void gattServerConnectThenChunkedWritesReassembleToOnePayload() {
        Recorder rec = new Recorder();
        BluetoothCourierRadio radio = new BluetoothCourierRadio(ctx(), rec);
        BluetoothDevice device = peerDevice();

        // A central connects → the radio registers it + creates the reassembler + fires connect.
        radio.gattServerCallback.onConnectionStateChange(
                device, BluetoothGatt.GATT_SUCCESS, BluetoothProfile.STATE_CONNECTED);
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
    public void gattClientNotificationsReassembleToOnePayload() {
        // The CENTRAL (GATT client) receive path: a connected peripheral NOTIFIES chunks back,
        // delivered via gattClientCallback.onCharacteristicChanged — the per-endpoint reassembler
        // must emit ONE exact payload.  (This is the duplex direction the server test does not cover.)
        Recorder rec = new Recorder();
        BluetoothCourierRadio radio = new BluetoothCourierRadio(ctx(), rec);
        BluetoothDevice device = peerDevice();
        BluetoothGatt gatt = device.connectGatt(
                ctx(), false, radio.gattClientCallback, BluetoothDevice.TRANSPORT_LE);

        // Connect ⇒ the client creates the per-endpoint reassembler.
        radio.gattClientCallback.onConnectionStateChange(
                gatt, BluetoothGatt.GATT_SUCCESS, BluetoothProfile.STATE_CONNECTED);

        byte[] payload = new byte[600];
        new Random(23).nextBytes(payload);
        byte[] framed = CourierFraming.framePrefixed(payload);
        BluetoothGattCharacteristic ch = courierCharacteristic();
        radio.gattClientCallback.onCharacteristicChanged(
                gatt, ch, Arrays.copyOfRange(framed, 0, 250));
        assertEquals("no frame yet from a partial notification", 0, rec.payloadCount);
        radio.gattClientCallback.onCharacteristicChanged(
                gatt, ch, Arrays.copyOfRange(framed, 250, framed.length));
        assertEquals("exactly one reassembled frame", 1, rec.payloadCount);
        assertEquals(PEER, rec.payloadEndpoint);
        assertArrayEquals("the reassembled payload is byte-exact", payload, rec.payload);

        // A foreign characteristic's notification is ignored.
        BluetoothGattCharacteristic foreign = new BluetoothGattCharacteristic(
                UUID.randomUUID(),
                BluetoothGattCharacteristic.PROPERTY_NOTIFY,
                BluetoothGattCharacteristic.PERMISSION_READ);
        radio.gattClientCallback.onCharacteristicChanged(gatt, foreign, new byte[] {9, 9, 9, 9, 9});
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
        BluetoothDevice device = peerDevice();
        BluetoothGatt gatt = device.connectGatt(
                ctx(), false, radio.gattClientCallback, BluetoothDevice.TRANSPORT_LE);
        radio.gattClientCallback.onConnectionStateChange(
                gatt, BluetoothGatt.GATT_SUCCESS, BluetoothProfile.STATE_CONNECTED);

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

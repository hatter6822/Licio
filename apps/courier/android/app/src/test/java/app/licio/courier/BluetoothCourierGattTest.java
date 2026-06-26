// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Layer-2 of the courier test pyramid: a Robolectric (JVM, shadowed Android framework) test of
// the Bluetooth plugin's BLE GATT contract — NO device, NO radio, NO root.  It constructs the
// REAL `BluetoothGattService`/`BluetoothGattCharacteristic`/`BluetoothGattDescriptor` the
// plugin exposes (Robolectric-shadowed) and asserts the courier's service definition is exactly
// what a peer needs to interoperate (one write+notify characteristic + a CCC descriptor on the
// fixed UUIDs).  A regression in that contract (wrong UUID, a missing NOTIFY property, a dropped
// CCC) fails here on a plain `./gradlew test`, with no emulator and no privileged setup.

package app.licio.courier;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;

import android.bluetooth.BluetoothGattCharacteristic;
import android.bluetooth.BluetoothGattService;

import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 34)
public class BluetoothCourierGattTest {

    @Test
    public void courierGattServiceExposesOneWriteNotifyCharacteristicWithCcc() {
        BluetoothGattService svc = BluetoothCourierRadio.buildCourierGattService();

        assertEquals(BluetoothCourierRadio.BLE_SERVICE_UUID, svc.getUuid());
        assertEquals(BluetoothGattService.SERVICE_TYPE_PRIMARY, svc.getType());
        assertEquals("exactly one characteristic", 1, svc.getCharacteristics().size());

        BluetoothGattCharacteristic ch = svc.getCharacteristic(BluetoothCourierRadio.BLE_CHAR_UUID);
        assertNotNull("the courier characteristic exists on its UUID", ch);

        int props = ch.getProperties();
        assertTrue("central→peripheral WRITE",
                (props & BluetoothGattCharacteristic.PROPERTY_WRITE) != 0);
        assertTrue("peripheral→central NOTIFY (duplex)",
                (props & BluetoothGattCharacteristic.PROPERTY_NOTIFY) != 0);
        assertTrue("write permission",
                (ch.getPermissions() & BluetoothGattCharacteristic.PERMISSION_WRITE) != 0);

        assertNotNull("the standard CCC descriptor for notify subscription is present",
                ch.getDescriptor(BluetoothCourierRadio.CCC_UUID));
    }
}

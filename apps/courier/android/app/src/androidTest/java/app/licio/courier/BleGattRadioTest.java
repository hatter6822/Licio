// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-R.15.4d/f — the two-device Bluetooth LE GATT courier radio E2E (OFFLINE_SPEC §22.5).
// This is the BLE-GATT fallback path the `BluetoothCourierPlugin` uses when classic RFCOMM
// is unavailable (BLE-only peripherals): a GATT server exposes ONE writable characteristic
// that carries chunked frames, and a GATT client writes a pack to it.  It runs over the
// emulator's EMULATED BLE radio (netsim RootCanal) — no pairing/bonding needed for a basic
// writable characteristic, which makes it the most reliable headless radio path.
//
// Two coordinated methods on two emulators sharing the netsim radio bus:
//   * gattServerReceive (device A): advertise the service UUID, open a GATT server, and
//     reassemble the chunked writes into a 4 KiB pack — asserting it BYTE-EXACT.
//   * gattClientSend (device B): scan for the service UUID, connect, negotiate MTU, and
//     write the pack as serialized (acked) MTU-sized chunks.
//
// The frames are DUMB bytes; on the production path every reassembled frame is re-validated
// against its CIDs/COSE signatures on the TS side (§18.4, no transport trust).

package app.licio.courier;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import android.bluetooth.BluetoothDevice;
import android.bluetooth.BluetoothGatt;
import android.bluetooth.BluetoothGattCallback;
import android.bluetooth.BluetoothGattCharacteristic;
import android.bluetooth.BluetoothGattServer;
import android.bluetooth.BluetoothGattServerCallback;
import android.bluetooth.BluetoothGattService;
import android.bluetooth.BluetoothManager;
import android.bluetooth.BluetoothProfile;
import android.bluetooth.le.AdvertiseCallback;
import android.bluetooth.le.AdvertiseData;
import android.bluetooth.le.AdvertiseSettings;
import android.bluetooth.le.BluetoothLeAdvertiser;
import android.bluetooth.le.BluetoothLeScanner;
import android.bluetooth.le.ScanCallback;
import android.bluetooth.le.ScanFilter;
import android.bluetooth.le.ScanResult;
import android.bluetooth.le.ScanSettings;
import android.content.Context;
import android.os.ParcelUuid;

import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;

import java.io.ByteArrayOutputStream;
import java.util.Collections;
import java.util.Random;
import java.util.UUID;
import java.util.concurrent.BlockingQueue;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;

import org.junit.Test;
import org.junit.runner.RunWith;

@RunWith(AndroidJUnit4.class)
public class BleGattRadioTest {

    private static final UUID SERVICE_UUID = UUID.fromString("9f1c1e20-5c11-4f2a-9b3d-1a2b3c4d5e6f");
    private static final UUID CHAR_UUID = UUID.fromString("9f1c1e21-5c11-4f2a-9b3d-1a2b3c4d5e6f");
    private static final ParcelUuid SERVICE_PUUID = new ParcelUuid(SERVICE_UUID);
    private static final int PACK_SIZE = 4 * 1024; // a modest pack — BLE writes are small
    private static final long TIMEOUT_SECONDS = 120;

    private static Context ctx() {
        return InstrumentationRegistry.getInstrumentation().getTargetContext();
    }

    // The SAME bytes on both devices (deterministic seed), so the server asserts the
    // reassembled stream BYTE-EXACT without transmitting a hash.
    private static byte[] deterministicPack() {
        byte[] b = new byte[PACK_SIZE];
        new Random(0xB1E60AL).nextBytes(b);
        return b;
    }

    // --- device A: advertise + GATT server, reassemble the chunked writes ------------

    @Test
    @SuppressWarnings("MissingPermission") // runtime-granted by the radio harness
    public void gattServerReceive() throws InterruptedException {
        BluetoothManager bm = (BluetoothManager) ctx().getSystemService(Context.BLUETOOTH_SERVICE);
        assertNotNull("no BluetoothManager", bm);
        BluetoothLeAdvertiser advertiser = bm.getAdapter().getBluetoothLeAdvertiser();
        assertNotNull("BLE advertising unsupported on this radio", advertiser);

        final ByteArrayOutputStream assembled = new ByteArrayOutputStream();
        final CountDownLatch complete = new CountDownLatch(1);

        final BluetoothGattServer[] serverHolder = new BluetoothGattServer[1];
        BluetoothGattServerCallback serverCb = new BluetoothGattServerCallback() {
            @Override
            public void onCharacteristicWriteRequest(BluetoothDevice device, int requestId,
                    BluetoothGattCharacteristic characteristic, boolean preparedWrite,
                    boolean responseNeeded, int offset, byte[] value) {
                if (CHAR_UUID.equals(characteristic.getUuid()) && value != null) {
                    synchronized (assembled) {
                        assembled.write(value, 0, value.length);
                        if (assembled.size() >= PACK_SIZE) complete.countDown();
                    }
                }
                if (responseNeeded && serverHolder[0] != null) {
                    serverHolder[0].sendResponse(device, requestId, BluetoothGatt.GATT_SUCCESS, offset, null);
                }
            }
        };

        BluetoothGattServer server = bm.openGattServer(ctx(), serverCb);
        serverHolder[0] = server;
        assertNotNull("could not open a GATT server", server);
        BluetoothGattService service = new BluetoothGattService(SERVICE_UUID,
                BluetoothGattService.SERVICE_TYPE_PRIMARY);
        BluetoothGattCharacteristic ch = new BluetoothGattCharacteristic(CHAR_UUID,
                BluetoothGattCharacteristic.PROPERTY_WRITE,
                BluetoothGattCharacteristic.PERMISSION_WRITE);
        service.addCharacteristic(ch);
        server.addService(service);

        final AtomicReference<Boolean> advOk = new AtomicReference<>(null);
        AdvertiseCallback advCb = new AdvertiseCallback() {
            @Override
            public void onStartSuccess(AdvertiseSettings settingsInEffect) {
                advOk.set(true);
            }

            @Override
            public void onStartFailure(int errorCode) {
                advOk.set(false);
            }
        };
        advertiser.startAdvertising(
                new AdvertiseSettings.Builder()
                        .setAdvertiseMode(AdvertiseSettings.ADVERTISE_MODE_LOW_LATENCY)
                        .setConnectable(true)
                        .build(),
                new AdvertiseData.Builder().addServiceUuid(SERVICE_PUUID).build(),
                advCb);

        try {
            boolean done = complete.await(TIMEOUT_SECONDS, TimeUnit.SECONDS);
            assertTrue("GATT server did not receive the full pack over the emulated BLE radio "
                    + "(" + assembled.size() + "/" + PACK_SIZE + " bytes)", done);
            byte[] got = assembled.toByteArray();
            // Trim any trailing overshoot (shouldn't happen — the client writes exactly PACK_SIZE).
            byte[] exact = got.length == PACK_SIZE ? got : java.util.Arrays.copyOf(got, PACK_SIZE);
            assertArrayEquals("reassembled BLE pack corrupted or mis-ordered", deterministicPack(), exact);
        } finally {
            advertiser.stopAdvertising(advCb);
            server.close();
        }
    }

    // --- device B: scan + GATT client, write the pack in serialized MTU chunks -------

    @Test
    @SuppressWarnings("MissingPermission")
    public void gattClientSend() throws InterruptedException {
        BluetoothManager bm = (BluetoothManager) ctx().getSystemService(Context.BLUETOOTH_SERVICE);
        assertNotNull("no BluetoothManager", bm);
        BluetoothLeScanner scanner = bm.getAdapter().getBluetoothLeScanner();
        assertNotNull("BLE scanning unsupported on this radio", scanner);

        final AtomicReference<BluetoothDevice> found = new AtomicReference<>();
        final CountDownLatch foundLatch = new CountDownLatch(1);
        ScanCallback scanCb = new ScanCallback() {
            @Override
            public void onScanResult(int callbackType, ScanResult result) {
                if (found.compareAndSet(null, result.getDevice())) foundLatch.countDown();
            }
        };
        scanner.startScan(
                Collections.singletonList(new ScanFilter.Builder().setServiceUuid(SERVICE_PUUID).build()),
                new ScanSettings.Builder().setScanMode(ScanSettings.SCAN_MODE_LOW_LATENCY).build(),
                scanCb);
        boolean discovered = foundLatch.await(TIMEOUT_SECONDS, TimeUnit.SECONDS);
        scanner.stopScan(scanCb);
        assertTrue("did not discover the GATT server over the emulated BLE radio", discovered);

        final CountDownLatch servicesReady = new CountDownLatch(1);
        final CountDownLatch mtuReady = new CountDownLatch(1);
        // Each completed write hands its status to the writer thread so writes are serialized.
        final BlockingQueue<Integer> writeAcks = new LinkedBlockingQueue<>();
        final AtomicReference<Integer> mtu = new AtomicReference<>(23); // BLE default ATT_MTU
        final AtomicReference<BluetoothGattCharacteristic> target = new AtomicReference<>();

        BluetoothGattCallback gattCb = new BluetoothGattCallback() {
            @Override
            public void onConnectionStateChange(BluetoothGatt gatt, int status, int newState) {
                if (newState == BluetoothProfile.STATE_CONNECTED) {
                    gatt.requestMtu(247);
                }
            }

            @Override
            public void onMtuChanged(BluetoothGatt gatt, int negotiated, int status) {
                if (status == BluetoothGatt.GATT_SUCCESS) mtu.set(negotiated);
                mtuReady.countDown();
                gatt.discoverServices();
            }

            @Override
            public void onServicesDiscovered(BluetoothGatt gatt, int status) {
                BluetoothGattService svc = gatt.getService(SERVICE_UUID);
                if (svc != null) target.set(svc.getCharacteristic(CHAR_UUID));
                servicesReady.countDown();
            }

            @Override
            public void onCharacteristicWrite(BluetoothGatt gatt,
                    BluetoothGattCharacteristic characteristic, int status) {
                writeAcks.offer(status);
            }
        };

        BluetoothGatt gatt = found.get().connectGatt(ctx(), false, gattCb, BluetoothDevice.TRANSPORT_LE);
        assertNotNull("connectGatt returned null", gatt);
        try {
            assertTrue("MTU negotiation timed out", mtuReady.await(60, TimeUnit.SECONDS));
            assertTrue("service discovery timed out", servicesReady.await(60, TimeUnit.SECONDS));
            BluetoothGattCharacteristic ch = target.get();
            assertNotNull("writable characteristic not found on the server", ch);

            byte[] pack = deterministicPack();
            // ATT write overhead is 3 bytes; a single GATT attribute value is capped at 512
            // bytes by the spec regardless of a larger negotiated MTU, so clamp to that.
            int payloadPerWrite = Math.min(512, Math.max(20, mtu.get() - 3));
            for (int off = 0; off < pack.length; off += payloadPerWrite) {
                int len = Math.min(payloadPerWrite, pack.length - off);
                byte[] chunk = java.util.Arrays.copyOfRange(pack, off, off + len);
                int rc = gatt.writeCharacteristic(ch, chunk, BluetoothGattCharacteristic.WRITE_TYPE_DEFAULT);
                if (rc != BluetoothGatt.GATT_SUCCESS) fail("writeCharacteristic returned " + rc);
                Integer ack = writeAcks.poll(30, TimeUnit.SECONDS);
                assertNotNull("write ack timed out at offset " + off, ack);
                if (ack != BluetoothGatt.GATT_SUCCESS) fail("write failed with status " + ack);
            }
            // Give the server a moment to drain the last write before teardown.
            Thread.sleep(1500);
        } finally {
            gatt.disconnect();
            gatt.close();
        }
    }
}

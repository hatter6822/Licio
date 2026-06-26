// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-R.15.4d/f — the two-device Bluetooth Classic RFCOMM courier radio E2E (OFFLINE_SPEC
// §22.5).  This exercises the SAME length-prefixed RFCOMM data path the production
// `BluetoothCourierPlugin` uses (a `BluetoothServerSocket` on a fixed service UUID, the
// client dialing that UUID, both sides reading/writing `DataOutputStream.writeInt(len)` +
// bytes), over the emulator's EMULATED Bluetooth radio (netsim RootCanal).
//
// Two coordinated methods on two emulators sharing the netsim radio bus:
//   * rfcommServerReceive (device A): listen on the service UUID, accept, read a
//     length-prefixed 64 KiB frame, and assert it BYTE-EXACT.
//   * rfcommClientSend (device B): connect to A's address (passed by the harness via the
//     `peerAddress` instrumentation arg) on the service UUID and write the frame.
//
// It uses the INSECURE RFCOMM variant so the data path is exercised WITHOUT a headless
// pairing/bonding handshake (which has no automatable UI on a non-rooted emulator); the
// production plugin uses the secure variant, but the byte-pipe + framing under test are
// identical.  No content trust is conferred — every frame is re-validated on the TS side
// (§18.4).

package app.licio.courier;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;

import android.bluetooth.BluetoothAdapter;
import android.bluetooth.BluetoothDevice;
import android.bluetooth.BluetoothManager;
import android.bluetooth.BluetoothServerSocket;
import android.bluetooth.BluetoothSocket;
import android.content.Context;
import android.os.Bundle;

import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;

import java.io.DataInputStream;
import java.io.DataOutputStream;
import java.io.IOException;
import java.util.Random;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;

import org.junit.Test;
import org.junit.runner.RunWith;

@RunWith(AndroidJUnit4.class)
public class BluetoothRfcommRadioTest {

    private static final String SERVICE_NAME = "LicioCourierRfcommTest";
    private static final UUID SERVICE_UUID = UUID.fromString("9f1c1e30-5c11-4f2a-9b3d-1a2b3c4d5e6f");
    private static final int PAYLOAD_SIZE = 64 * 1024; // bulk over RFCOMM
    private static final long TIMEOUT_SECONDS = 120;

    private static Context ctx() {
        return InstrumentationRegistry.getInstrumentation().getTargetContext();
    }

    private static BluetoothAdapter adapter() {
        BluetoothManager bm = (BluetoothManager) ctx().getSystemService(Context.BLUETOOTH_SERVICE);
        return bm != null ? bm.getAdapter() : null;
    }

    private static byte[] deterministicPayload() {
        byte[] b = new byte[PAYLOAD_SIZE];
        new Random(0x12FC0AAL).nextBytes(b);
        return b;
    }

    // --- device A: listen, accept, read one length-prefixed frame --------------------

    @Test
    @SuppressWarnings("MissingPermission") // runtime-granted by the radio harness
    public void rfcommServerReceive() throws Exception {
        BluetoothAdapter adapter = adapter();
        assertNotNull("no Bluetooth adapter", adapter);
        assertTrue("Bluetooth not enabled", adapter.isEnabled());

        BluetoothServerSocket server =
                adapter.listenUsingInsecureRfcommWithServiceRecord(SERVICE_NAME, SERVICE_UUID);
        final AtomicReference<byte[]> received = new AtomicReference<>();
        final AtomicReference<String> error = new AtomicReference<>();
        final CountDownLatch latch = new CountDownLatch(1);

        Thread acceptor = new Thread(() -> {
            BluetoothSocket socket = null;
            try {
                socket = server.accept((int) TimeUnit.SECONDS.toMillis(TIMEOUT_SECONDS));
                DataInputStream in = new DataInputStream(socket.getInputStream());
                int len = in.readInt();
                if (len < 0 || len > 64 * 1024 * 1024) {
                    error.set("bad frame length " + len);
                } else {
                    byte[] buf = new byte[len];
                    in.readFully(buf);
                    received.set(buf);
                }
            } catch (IOException e) {
                error.set("accept/read failed: " + e.getMessage());
            } finally {
                latch.countDown();
                if (socket != null) {
                    try {
                        socket.close();
                    } catch (IOException ignored) {
                        // already closed
                    }
                }
            }
        });
        acceptor.start();

        try {
            assertTrue("RFCOMM server never accepted a connection over the emulated radio",
                    latch.await(TIMEOUT_SECONDS + 5, TimeUnit.SECONDS));
            assertNotNull("RFCOMM read failed: " + error.get(), received.get());
            assertArrayEquals("RFCOMM frame corrupted in transit", deterministicPayload(), received.get());
        } finally {
            server.close();
        }
    }

    // --- device B: dial A's address on the service UUID, write one frame -------------

    @Test
    @SuppressWarnings("MissingPermission")
    public void rfcommClientSend() throws Exception {
        Bundle args = InstrumentationRegistry.getArguments();
        String peer = args.getString("peerAddress");
        assertNotNull("peerAddress instrumentation arg missing", peer);

        BluetoothAdapter adapter = adapter();
        assertNotNull("no Bluetooth adapter", adapter);
        assertTrue("Bluetooth not enabled", adapter.isEnabled());
        adapter.cancelDiscovery(); // discovery starves the connect handshake

        BluetoothDevice device = adapter.getRemoteDevice(peer);
        BluetoothSocket socket = device.createInsecureRfcommSocketToServiceRecord(SERVICE_UUID);
        socket.connect(); // SDP-resolves A's RFCOMM channel + opens the link (no pairing)
        try {
            DataOutputStream out = new DataOutputStream(socket.getOutputStream());
            byte[] payload = deterministicPayload();
            out.writeInt(payload.length);
            out.write(payload);
            out.flush();
            Thread.sleep(2500); // let the frame drain before teardown
        } finally {
            socket.close();
        }
    }
}

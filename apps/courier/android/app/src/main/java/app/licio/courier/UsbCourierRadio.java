// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-R.15.4d — the USB courier RADIO DRIVER (OFFLINE_SPEC §22.5), decoupled from Capacitor.
// USB ACCESSORY mode: `UsbManager.openAccessory` yields a `ParcelFileDescriptor` whose
// input/output streams carry length-prefixed BYTES frames.  The accessory open is the only
// USB-specific I/O; the data path is the shared `CourierFraming` (read/`framePrefixed`), so
// the package-visible `attach(in, out, endpointId)` seam lets the receive + framing be unit-
// tested over a plain in-memory pipe with NO USB hardware.  `UsbCourierPlugin` is the thin
// Capacitor shim.
//
// VERIFICATION OF THE PHYSICAL LINK IS OTG-ONLY (no emulated USB-accessory bus), but the
// framing + send/receive wiring are exercised by the JVM unit tests.  DUMB byte pipe (frames
// re-validated on the TS side, §18.4); PUBLIC-ONLY; off by default.

package app.licio.courier;

import android.content.Context;
import android.hardware.usb.UsbAccessory;
import android.hardware.usb.UsbManager;
import android.os.ParcelFileDescriptor;

import java.io.DataOutputStream;
import java.io.FileDescriptor;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.atomic.AtomicBoolean;

public class UsbCourierRadio implements CourierRadio {

    static final String USB_ENDPOINT_ID = "usb-accessory";

    private final UsbManager usbManager;
    private final CourierRadio.Events events;
    private final AtomicBoolean running = new AtomicBoolean(false);
    private volatile ParcelFileDescriptor descriptor;
    // The stream the read loop blocks on — closed by stop() to UNBLOCK it (closing the accessory
    // descriptor does not reliably interrupt a FileInputStream built from getFileDescriptor()).
    private volatile InputStream readStream;
    // A single accessory link, but keyed (one entry) so the SHARED CourierStreamLink data-path
    // routes outbound exactly as it does for the multi-endpoint socket transports.
    private final ConcurrentHashMap<String, DataOutputStream> outbound = new ConcurrentHashMap<>();
    // Bounded daemon executor for sends (replaces unbounded thread-per-send).
    private final ExecutorService sendExecutor = CourierStreamLink.newSendExecutor("usb-send");

    public UsbCourierRadio(Context ctx, CourierRadio.Events events) {
        this.events = events;
        this.usbManager = (UsbManager) ctx.getSystemService(Context.USB_SERVICE);
    }

    @Override
    public boolean isAvailable() {
        return usbManager != null;
    }

    /** USB has no over-the-air discovery; "start" opens the attached accessory link. */
    @Override
    public void startAdvertising() {
        startDiscovery();
    }

    @Override
    public void startDiscovery() {
        if (usbManager == null) return;
        // Idempotent: the controller may call startAdvertising() AND startDiscovery() (both toggles)
        // and startAdvertising() delegates here — without this guard the SAME accessory would be
        // opened twice, the second open overwriting descriptor/readStream and leaking the first.
        if (descriptor != null) return;
        UsbAccessory[] accessories = usbManager.getAccessoryList();
        if (accessories == null || accessories.length == 0) {
            events.onConnectionResult(USB_ENDPOINT_ID, false); // nothing attached
            return;
        }
        descriptor = usbManager.openAccessory(accessories[0]);
        if (descriptor == null) {
            events.onConnectionResult(USB_ENDPOINT_ID, false);
            return;
        }
        FileDescriptor fd = descriptor.getFileDescriptor();
        attach(new FileInputStream(fd), new FileOutputStream(fd), USB_ENDPOINT_ID);
    }

    /**
     * Wire the courier over an already-open stream pair (the accessory's, or — in a unit test —
     * an in-memory pipe).  Marks the endpoint connected, spawns the length-prefixed read loop
     * (the pure {@link CourierFraming#readFramedStream}), and routes outbound frames here.
     */
    void attach(InputStream in, OutputStream out, String endpointId) {
        running.set(true);
        readStream = in; // tracked so stop() can close it and unblock the read below
        // The shared blocking-stream data-path (CourierStreamLinkTest covers it via pipes); the
        // input stream is the Closeable, so an EOF / stop() tears the link down.
        new Thread(() ->
                CourierStreamLink.run(in, out, in, endpointId, outbound, events, running::get))
                .start();
    }

    @Override
    public void send(String endpointId, byte[] payload, CourierRadio.SendResult result) {
        final DataOutputStream out = outbound.get(endpointId);
        if (out == null) {
            result.onError("endpoint_not_connected", null);
            return;
        }
        CourierStreamLink.send(sendExecutor, out, payload, result); // bounded executor (not thread-per-send)
    }

    @Override
    public void stop() {
        running.set(false);
        // Close the READ stream first — this is what unblocks a thread parked in readFramedStream
        // (so CourierStreamLink's finally runs: drop outbound + fire onDisconnected).
        InputStream rs = readStream;
        if (rs != null) {
            try {
                rs.close();
            } catch (IOException ignored) {
                // already closed
            }
            readStream = null;
        }
        if (descriptor != null) {
            try {
                descriptor.close(); // release the kernel handle
            } catch (IOException ignored) {
                // already closed
            }
            descriptor = null;
        }
        outbound.clear();
    }
}

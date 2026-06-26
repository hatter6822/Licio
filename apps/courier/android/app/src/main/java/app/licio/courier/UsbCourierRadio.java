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

import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.hardware.usb.UsbAccessory;
import android.hardware.usb.UsbManager;
import android.os.Build;
import android.os.ParcelFileDescriptor;

import java.io.Closeable;
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
    private static final String ACTION_USB_PERMISSION = "app.licio.courier.USB_PERMISSION";

    private final Context ctx;
    private final UsbManager usbManager;
    private final CourierRadio.Events events;
    private final AtomicBoolean running = new AtomicBoolean(false);
    private volatile ParcelFileDescriptor descriptor;
    // A pending accessory-permission request's receiver, so stop() can unregister an in-flight prompt.
    private volatile BroadcastReceiver permissionReceiver;
    // The stream the read loop blocks on — closed by stop() to UNBLOCK it (closing the accessory
    // descriptor does not reliably interrupt a FileInputStream built from getFileDescriptor()).
    private volatile InputStream readStream;
    // A single accessory link, but keyed (one entry) so the SHARED CourierStreamLink data-path
    // routes outbound exactly as it does for the multi-endpoint socket transports.
    private final ConcurrentHashMap<String, DataOutputStream> outbound = new ConcurrentHashMap<>();
    // Bounded daemon executor for sends (replaces unbounded thread-per-send).
    private final ExecutorService sendExecutor = CourierStreamLink.newSendExecutor("usb-send");

    public UsbCourierRadio(Context ctx, CourierRadio.Events events) {
        this.ctx = ctx;
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
            // No accessory + no attach watcher that could connect later ⇒ this is a START FAILURE,
            // not a (negative) connection result the controller would ignore — so the UI surfaces
            // radio_unavailable instead of a dead "running" courier.
            events.onStartFailed("discover", new IllegalStateException("no_usb_accessory"));
            return;
        }
        UsbAccessory accessory = accessories[0];
        // First-use path: an accessory attached while the app was launched manually carries NO grant.
        // openAccessory() would then throw / fail-unavailable, so REQUEST the grant (the system prompt)
        // and open from the result, instead of failing before the user can authorise the courier.
        if (!usbManager.hasPermission(accessory)) {
            // Mark the radio starting BEFORE the async grant prompt: the permission callback checks
            // running to detect a stop() DURING the prompt, and running is otherwise set only in
            // attach() (after a successful open), so the callback would always abort on grant.
            running.set(true);
            requestAccessoryPermission(accessory);
            return;
        }
        openAccessory(accessory);
    }

    /** Open an already-permitted accessory and wire the courier over its fd streams. */
    private void openAccessory(UsbAccessory accessory) {
        ParcelFileDescriptor opened = usbManager.openAccessory(accessory);
        if (opened == null) {
            events.onStartFailed("discover", new IllegalStateException("usb_accessory_open_failed"));
            return;
        }
        // A stop()/unmount can land AFTER the permission callback's running check but BEFORE this open
        // (the grant prompt is async) — stop() then had no descriptor/read stream to close.  Re-check
        // liveness here and CLOSE what we just opened, rather than letting attach() flip running back to
        // true and start a read loop under a stopped controller (#AS).
        if (!running.get()) {
            try {
                opened.close();
            } catch (IOException ignored) {
                // already closed
            }
            return;
        }
        descriptor = opened;
        FileDescriptor fd = opened.getFileDescriptor();
        attach(new FileInputStream(fd), new FileOutputStream(fd), USB_ENDPOINT_ID);
    }

    /** Register a one-shot receiver and ask the system for accessory permission; on grant, open the
     *  accessory, on denial surface a typed start failure so the controller stops showing it running. */
    private void requestAccessoryPermission(UsbAccessory accessory) {
        if (permissionReceiver != null) return; // a prompt is already in flight
        BroadcastReceiver receiver = new BroadcastReceiver() {
            @Override
            public void onReceive(Context context, Intent intent) {
                if (!ACTION_USB_PERMISSION.equals(intent.getAction())) return;
                unregisterPermissionReceiver();
                boolean granted = intent.getBooleanExtra(UsbManager.EXTRA_PERMISSION_GRANTED, false)
                        && usbManager.hasPermission(accessory);
                if (!running.get()) return; // stopped while the prompt was open — do not open
                if (granted) {
                    openAccessory(accessory);
                } else {
                    running.set(false); // a denied grant did not start the radio
                    events.onStartFailed("discover",
                            new IllegalStateException("usb_permission_denied"));
                }
            }
        };
        permissionReceiver = receiver;
        IntentFilter filter = new IntentFilter(ACTION_USB_PERMISSION);
        // The receiver is internal (an explicit-package broadcast from the USB framework); mark it
        // not-exported on API 33+ where a flag is required.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            ctx.registerReceiver(receiver, filter, Context.RECEIVER_NOT_EXPORTED);
        } else {
            ctx.registerReceiver(receiver, filter);
        }
        // The framework fills the grant result into the broadcast, so the PendingIntent must be
        // MUTABLE on API 31+; target our own package so it is an explicit, non-exported broadcast.
        int flags = Build.VERSION.SDK_INT >= Build.VERSION_CODES.S ? PendingIntent.FLAG_MUTABLE : 0;
        Intent intent = new Intent(ACTION_USB_PERMISSION).setPackage(ctx.getPackageName());
        PendingIntent pi = PendingIntent.getBroadcast(ctx, 0, intent, flags);
        usbManager.requestPermission(accessory, pi);
    }

    private void unregisterPermissionReceiver() {
        BroadcastReceiver receiver = permissionReceiver;
        if (receiver != null) {
            try {
                ctx.unregisterReceiver(receiver);
            } catch (IllegalArgumentException ignored) {
                // not registered
            }
            permissionReceiver = null;
        }
    }

    /**
     * Wire the courier over an already-open stream pair (the accessory's, or — in a unit test —
     * an in-memory pipe).  Marks the endpoint connected, spawns the length-prefixed read loop
     * (the pure {@link CourierFraming#readFramedStream}), and routes outbound frames here.
     */
    void attach(InputStream in, OutputStream out, String endpointId) {
        running.set(true);
        readStream = in; // tracked so stop() can close it and unblock the read below
        // CAPTURE this attach's descriptor — NOT the mutable field at exit time.  If a Stop→Start
        // re-opened a NEW accessory while this old read thread was still unwinding, the field already
        // points at the FRESH descriptor/stream; reading it here would close the LIVE accessory and
        // break the new USB courier (#AA).
        final ParcelFileDescriptor attached = descriptor;
        // The shared blocking-stream data-path (CourierStreamLinkTest covers it via pipes).  On
        // link exit (EOF / error / stop()) close THIS attach's accessory DESCRIPTOR too and clear the
        // fields — closing only `in` would leave `descriptor` non-null, so after an unplug/replug the
        // idempotency guard in startDiscovery() would refuse to reopen and the FD would leak.
        Closeable onExit = () -> {
            try {
                in.close();
            } catch (IOException ignored) {
                // already closed
            }
            if (attached != null) {
                try {
                    attached.close();
                } catch (IOException ignored) {
                    // already closed
                }
            }
            // Clear the fields ONLY if they STILL point at THIS attach's values — a fresh start may
            // already own a new descriptor/stream for the same endpoint, which must not be cleared.
            if (descriptor == attached) descriptor = null;
            if (readStream == in) readStream = null;
        };
        new Thread(() ->
                CourierStreamLink.run(in, out, onExit, endpointId, outbound, events, running::get))
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
        unregisterPermissionReceiver(); // drop an in-flight accessory-permission prompt
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

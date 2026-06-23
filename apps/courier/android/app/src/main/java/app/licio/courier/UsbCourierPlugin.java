// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-R.15.4d — the USB courier transport (OFFLINE_SPEC §22.5: "USB/import/export").  A
// fourth native channel beside Nearby + Wi-Fi Direct + Bluetooth, following the SAME
// plugin pattern + the SAME JS event surface (`connectionResult` / `payloadReceived` /
// `disconnected`, base64 BYTES) so the TS `NativeChannelMedium` + `CourierController`
// drive it identically.  A DUMB byte pipe: every frame is re-validated against its
// CIDs/COSE signatures on the TS side (§18.4, no transport trust).  PUBLIC-ONLY; off by
// default; no USB device identifier reaches an LCAP schema.
//
// Data path: USB ACCESSORY mode — the phone attaches to a USB host (the peer device or an
// OTG bridge) advertising the Licio accessory; `UsbManager.openAccessory` yields a
// `ParcelFileDescriptor` whose input/output streams carry length-prefixed BYTES frames.
// (USB HOST mode — the phone driving a connected `UsbDevice` over `bulkTransfer` — is the
// symmetric alternative; accessory mode is implemented here as the phone-side default.)
//
// VERIFICATION IS PHYSICAL-OTG ONLY.  There is NO emulated USB-accessory bus on the
// Android emulator (netsim covers BLE/Bluetooth + virtio-wifi, not USB), so unlike the
// Nearby / Wi-Fi Direct / Bluetooth channels this one cannot be exercised on the
// emulator radio E2E — it must be confirmed on physical hardware over a real OTG cable.
// The TS bridge + the plugin surface are byte-identical to the other channels and
// fail-closed regardless, so the code path is structurally validated by the shared tests.

package app.licio.courier;

import android.content.Context;
import android.hardware.usb.UsbAccessory;
import android.hardware.usb.UsbManager;
import android.os.ParcelFileDescriptor;
import android.util.Base64;

import androidx.annotation.NonNull;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.DataInputStream;
import java.io.DataOutputStream;
import java.io.FileDescriptor;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * USB courier bridge (accessory mode).  No runtime permission is needed for USB accessory
 * mode — access is granted by the user accepting the system attach dialog — so this plugin
 * declares none.  A single accessory link is active at a time; its opaque endpoint id is a
 * fixed routing handle for the session.
 */
@CapacitorPlugin(name = "UsbCourier")
public class UsbCourierPlugin extends Plugin {

    private static final String USB_ENDPOINT_ID = "usb-accessory";
    private static final int MAX_FRAME_BYTES = 64 * 1024 * 1024; // §22.5 bounded pack

    private UsbManager usbManager;
    private final AtomicBoolean running = new AtomicBoolean(false);
    private ParcelFileDescriptor descriptor;
    private DataOutputStream outbound;

    @Override
    public void load() {
        usbManager = (UsbManager) getContext().getSystemService(Context.USB_SERVICE);
    }

    // --- §22.5 advertise / discover -------------------------------------------------

    /** USB has no over-the-air discovery; "start" opens the attached accessory link. */
    @PluginMethod
    public void startAdvertising(PluginCall call) {
        startDiscovery(call);
    }

    @PluginMethod
    public void startDiscovery(PluginCall call) {
        if (usbManager == null) {
            call.reject("usb_unavailable");
            return;
        }
        UsbAccessory[] accessories = usbManager.getAccessoryList();
        if (accessories == null || accessories.length == 0) {
            call.reject("no_usb_accessory");
            return;
        }
        running.set(true);
        openAccessory(accessories[0]);
        call.resolve();
    }

    @PluginMethod
    public void stop(PluginCall call) {
        running.set(false);
        closeDescriptor();
        outbound = null;
        call.resolve();
    }

    // --- chunked payload send -------------------------------------------------------

    @PluginMethod
    public void send(PluginCall call) {
        String endpointId = call.getString("endpointId");
        String message = call.getString("message");
        if (endpointId == null || message == null) {
            call.reject("missing endpointId or message");
            return;
        }
        final DataOutputStream out = outbound;
        if (out == null) {
            call.reject("endpoint_not_connected");
            return;
        }
        byte[] bytes = Base64.decode(message, Base64.NO_WRAP);
        new Thread(() -> {
            try {
                synchronized (out) {
                    out.writeInt(bytes.length);
                    out.write(bytes);
                    out.flush();
                }
                call.resolve();
            } catch (IOException e) {
                call.reject("send_failed", e);
            }
        }).start();
    }

    // --- USB accessory plumbing -----------------------------------------------------

    private void openAccessory(UsbAccessory accessory) {
        descriptor = usbManager.openAccessory(accessory);
        if (descriptor == null) {
            emitConnectionResult(USB_ENDPOINT_ID, false);
            return;
        }
        FileDescriptor fd = descriptor.getFileDescriptor();
        outbound = new DataOutputStream(new FileOutputStream(fd));
        emitConnectionResult(USB_ENDPOINT_ID, true);
        new Thread(() -> readLoop(new DataInputStream(new FileInputStream(fd)))).start();
    }

    private void readLoop(DataInputStream in) {
        try {
            while (running.get()) {
                int len = in.readInt();
                if (len < 0 || len > MAX_FRAME_BYTES) break; // bounded frame, fail-closed
                byte[] bytes = new byte[len];
                in.readFully(bytes);
                emitPayload(USB_ENDPOINT_ID, bytes);
            }
        } catch (IOException ignored) {
            // accessory detached — fall through to disconnect
        } finally {
            emitDisconnected(USB_ENDPOINT_ID);
        }
    }

    private void closeDescriptor() {
        if (descriptor != null) {
            try {
                descriptor.close();
            } catch (IOException ignored) {
                // already closed
            }
            descriptor = null;
        }
    }

    // --- JS events (identical surface to NearbyCourier) -----------------------------

    private void emitConnectionResult(String endpointId, boolean connected) {
        JSObject ev = new JSObject();
        ev.put("endpointId", endpointId);
        ev.put("connected", connected);
        notifyListeners("connectionResult", ev);
    }

    private void emitPayload(String endpointId, @NonNull byte[] bytes) {
        JSObject ev = new JSObject();
        ev.put("endpointId", endpointId);
        ev.put("message", Base64.encodeToString(bytes, Base64.NO_WRAP));
        notifyListeners("payloadReceived", ev);
    }

    private void emitDisconnected(String endpointId) {
        JSObject ev = new JSObject();
        ev.put("endpointId", endpointId);
        notifyListeners("disconnected", ev);
    }
}

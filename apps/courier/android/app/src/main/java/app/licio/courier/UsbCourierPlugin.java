// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-R.15.4d — the USB courier transport (OFFLINE_SPEC §22.5: "USB/import/export").  A thin
// Capacitor HUMBLE OBJECT over `UsbCourierRadio` (the testable radio driver): it maps
// PluginCalls onto the radio and forwards its `CourierRadio.Events` out as the base64 JS event
// surface (`connectionResult` / `payloadReceived` / `disconnected`).  ALL the logic (accessory
// open + the length-prefixed stream data path) lives in `UsbCourierRadio`, whose framing/receive
// is JVM-tested over an in-memory pipe (`UsbCourierRadioTest`); the physical OTG link is the
// only OTG-hardware-only piece (there is no emulated USB-accessory bus).  PUBLIC-ONLY; off by
// default; no USB device identifier reaches an LCAP schema.

package app.licio.courier;

import android.util.Base64;

import androidx.annotation.NonNull;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * USB courier bridge (accessory mode).  No runtime permission is needed for USB accessory
 * mode — access is granted by the user accepting the system attach dialog — so this plugin
 * declares none.  A single accessory link is active at a time.
 */
@CapacitorPlugin(name = "UsbCourier")
public class UsbCourierPlugin extends Plugin {

    private UsbCourierRadio radio;

    @Override
    public void load() {
        radio = new UsbCourierRadio(getContext(), new CourierRadio.Events() {
            @Override
            public void onConnectionResult(String endpointId, boolean connected) {
                JSObject ev = new JSObject();
                ev.put("endpointId", endpointId);
                ev.put("connected", connected);
                notifyListeners("connectionResult", ev);
            }

            @Override
            public void onPayload(String endpointId, @NonNull byte[] bytes) {
                JSObject ev = new JSObject();
                ev.put("endpointId", endpointId);
                ev.put("message", Base64.encodeToString(bytes, Base64.NO_WRAP));
                notifyListeners("payloadReceived", ev);
            }

            @Override
            public void onDisconnected(String endpointId) {
                JSObject ev = new JSObject();
                ev.put("endpointId", endpointId);
                notifyListeners("disconnected", ev);
            }
        });
    }

    @PluginMethod
    public void startAdvertising(PluginCall call) {
        if (!radio.isAvailable()) {
            call.reject("usb_unavailable");
            return;
        }
        radio.startAdvertising();
        call.resolve();
    }

    @PluginMethod
    public void startDiscovery(PluginCall call) {
        if (!radio.isAvailable()) {
            call.reject("usb_unavailable");
            return;
        }
        radio.startDiscovery();
        call.resolve();
    }

    @PluginMethod
    public void stop(PluginCall call) {
        radio.stop();
        call.resolve();
    }

    @PluginMethod
    public void send(PluginCall call) {
        String endpointId = call.getString("endpointId");
        String message = call.getString("message"); // base64 (NO_WRAP)
        if (endpointId == null || message == null) {
            call.reject("missing endpointId or message");
            return;
        }
        byte[] bytes = Base64.decode(message, Base64.NO_WRAP);
        radio.send(endpointId, bytes, new CourierRadio.SendResult() {
            @Override
            public void onSuccess() {
                call.resolve();
            }

            @Override
            public void onError(String reason, Exception cause) {
                if (cause != null) call.reject(reason, cause);
                else call.reject(reason);
            }
        });
    }
}

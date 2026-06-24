// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-R.15.4 — the common contract EVERY native courier radio driver implements (Bluetooth
// RFCOMM/BLE, Wi-Fi Direct, Nearby Connections, USB).  Each radio is a plain, Capacitor-free
// object (a `Context` + an `Events` callback) carrying the testable logic; the matching
// `*CourierPlugin` is a thin Capacitor HUMBLE OBJECT that does nothing but create one of
// these, map `PluginCall`s onto it, and forward its `Events` back out as base64 JS events.
// Because the radios depend only on this contract + the Android/seam APIs (never Capacitor),
// they are unit-tested on the JVM (pure `CourierFraming` + shadowed-Android Robolectric)
// with NO device / radio / root.

package app.licio.courier;

public interface CourierRadio {

    /** Transport lifecycle + payload callbacks (the shim forwards these to the JS event surface). */
    interface Events {
        void onConnectionResult(String endpointId, boolean connected);

        void onPayload(String endpointId, byte[] bytes);

        void onDisconnected(String endpointId);
    }

    /** Async result of a {@link #send}; the shim resolves/rejects the PluginCall from it. */
    interface SendResult {
        void onSuccess();

        void onError(String reason, Exception cause);
    }

    /** Whether the device has the radio this driver needs. */
    boolean isAvailable();

    /** Become discoverable / accept inbound courier links. */
    void startAdvertising();

    /** Discover + connect to courier peers. */
    void startDiscovery();

    /** Tear everything down. */
    void stop();

    /** Send one frame to a connected endpoint; report via {@code result} (unknown ⇒ fail-closed). */
    void send(String endpointId, byte[] payload, SendResult result);
}

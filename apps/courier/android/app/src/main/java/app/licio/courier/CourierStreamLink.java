// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-R.15.4 — the shared data-path for every BLOCKING-stream courier transport (Bluetooth
// RFCOMM, Wi-Fi Direct, USB accessory).  All three do the identical thing once a connection is
// open: register the outbound stream, announce the connection, read inbound length-prefixed
// frames until the link closes, then always clean up.  That logic lives here ONCE, over plain
// `InputStream`/`OutputStream` + a `Closeable` — NO socket, NO port, NO radio — so it is
// unit-tested deterministically with in-memory pipes (`CourierStreamLinkTest`), and a radio's
// per-transport code shrinks to just opening the connection.

package app.licio.courier;

import java.io.Closeable;
import java.io.DataOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.Map;
import java.util.function.BooleanSupplier;

final class CourierStreamLink {

    private CourierStreamLink() {}

    /**
     * Drive one connected blocking stream pair as a courier link.  Registers {@code out} under
     * {@code endpointId} in {@code outbound} (so {@code send} can route to it), fires
     * {@code onConnectionResult(true)}, then reads inbound length-prefixed frames (each →
     * {@code onPayload}) until {@code alive} goes false, the stream ends, or a read error — and
     * ALWAYS, in finally: drops the outbound entry, closes {@code conn}, and fires
     * {@code onDisconnected}.  Blocking (runs on the caller's read thread).
     */
    static void run(InputStream in, OutputStream out, Closeable conn, String endpointId,
            Map<String, DataOutputStream> outbound, CourierRadio.Events events,
            BooleanSupplier alive) {
        outbound.put(endpointId, new DataOutputStream(out));
        events.onConnectionResult(endpointId, true);
        try {
            CourierFraming.readFramedStream(in, frame -> events.onPayload(endpointId, frame), alive);
        } catch (IOException ignored) {
            // peer closed / read error — fall through to the disconnect cleanup
        } finally {
            outbound.remove(endpointId);
            try {
                conn.close();
            } catch (IOException ignored) {
                // already closed
            }
            events.onDisconnected(endpointId);
        }
    }
}

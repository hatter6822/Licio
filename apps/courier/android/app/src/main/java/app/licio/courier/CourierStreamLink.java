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
import java.util.concurrent.ExecutorService;
import java.util.concurrent.SynchronousQueue;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.function.BooleanSupplier;

final class CourierStreamLink {

    /** Max concurrent blocking-stream sends per radio before backpressure kicks in. */
    private static final int MAX_SEND_THREADS = 8;

    private CourierStreamLink() {}

    /**
     * A BOUNDED, daemon send executor shared by one blocking-stream radio's sends — replaces
     * thread-per-send (which was unbounded under a send flood).  Scales from 0 to
     * {@link #MAX_SEND_THREADS} threads on demand, reaps idle threads after 30s
     * ({@code allowCoreThreadTimeOut}), and applies CALLER-RUNS backpressure when saturated
     * (a flood runs inline on the caller rather than spawning threads or dropping sends).  Daemon
     * + self-reaping, so it lives with the radio and never blocks JVM exit; no shutdown needed.
     */
    static ExecutorService newSendExecutor(String name) {
        ThreadPoolExecutor exec = new ThreadPoolExecutor(
                1, MAX_SEND_THREADS, 30L, TimeUnit.SECONDS,
                new SynchronousQueue<>(),
                r -> {
                    Thread t = new Thread(r, name);
                    t.setDaemon(true);
                    return t;
                },
                new ThreadPoolExecutor.CallerRunsPolicy());
        exec.allowCoreThreadTimeOut(true);
        return exec;
    }

    /**
     * Send one length-prefixed frame to a connected endpoint's outbound stream on {@code exec},
     * serialized per-stream by {@code synchronized(out)} (so concurrent sends to ONE endpoint
     * never interleave their frames), reporting via {@code result}.
     *
     * <p>The executor uses {@code CallerRunsPolicy}, which runs the task INLINE under saturation
     * (never rejecting) but SILENTLY DISCARDS after shutdown — so the explicit {@code isShutdown}
     * guard is what makes a post-shutdown send report a terminal result instead of leaking the
     * {@code SendResult}/PluginCall.  (The executor is radio-lifetime + never shut down, so this
     * is defensive; the guard keeps it correct if a shutdown is ever introduced.)
     */
    static void send(ExecutorService exec, DataOutputStream out, byte[] payload,
            CourierRadio.SendResult result) {
        if (exec.isShutdown()) {
            result.onError("radio_stopped", null);
            return;
        }
        exec.execute(() -> {
            try {
                synchronized (out) {
                    out.write(CourierFraming.framePrefixed(payload)); // wire ≡ writeInt(len)+bytes
                    out.flush();
                }
                result.onSuccess();
            } catch (IOException e) {
                result.onError("send_failed", e);
            }
        });
    }

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
        DataOutputStream dos = new DataOutputStream(out);
        outbound.put(endpointId, dos);
        events.onConnectionResult(endpointId, true);
        try {
            CourierFraming.readFramedStream(in, frame -> events.onPayload(endpointId, frame), alive);
        } catch (IOException ignored) {
            // peer closed / read error — fall through to the disconnect cleanup
        } finally {
            // Remove BY VALUE: if the same endpoint reconnected on another link, that link's
            // newer outbound entry must NOT be clobbered by this (older) link's teardown.
            outbound.remove(endpointId, dos);
            try {
                conn.close();
            } catch (IOException ignored) {
                // already closed
            }
            events.onDisconnected(endpointId);
        }
    }
}

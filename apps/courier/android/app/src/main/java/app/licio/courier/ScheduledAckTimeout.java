// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-R.15.4 — the scheduler-backed `BleSendPump.Timeout`: arm() schedules the pump's onTimeout
// after `delayMs` (RE-ARMING — it cancels any pending timeout first, so a multi-chunk send never
// leaves a prior chunk's timeout pending), cancel() cancels it.
//
// It holds the scheduler BY REFERENCE (it never lazily re-creates one — that would resurrect a
// scheduler `stopBle()` just shut down), and tolerates the stop()/disconnect race where the
// scheduler is shut down mid-send: schedule() then throws RejectedExecutionException, which is
// swallowed (the in-flight send is failed by the pump's failAll on teardown anyway) rather than
// propagating out of a BLE binder callback.  Pure java.util.concurrent — unit-tested directly
// with a real scheduler + a short delay, so the radio's timeout-firing glue is covered without a
// 30s wait or a test seam.

package app.licio.courier;

import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.TimeUnit;

final class ScheduledAckTimeout implements BleSendPump.Timeout {

    private final ScheduledExecutorService scheduler;
    private final long delayMs;
    private final Runnable onTimeout;
    private volatile ScheduledFuture<?> future;

    ScheduledAckTimeout(ScheduledExecutorService scheduler, long delayMs, Runnable onTimeout) {
        this.scheduler = scheduler;
        this.delayMs = delayMs;
        this.onTimeout = onTimeout;
    }

    @Override
    public void arm() {
        cancel();
        try {
            future = scheduler.schedule(onTimeout, delayMs, TimeUnit.MILLISECONDS);
        } catch (RejectedExecutionException shuttingDown) {
            // scheduler shut down mid-send (stop()/disconnect race) — no timeout armed; the
            // in-flight send is failed by the pump's failAll on teardown.
        }
    }

    @Override
    public void cancel() {
        ScheduledFuture<?> f = future;
        if (f != null) {
            f.cancel(false);
        }
    }
}

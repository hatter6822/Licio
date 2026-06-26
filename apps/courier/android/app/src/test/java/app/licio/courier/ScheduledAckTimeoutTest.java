// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Layer-1 (pure JVM) tests of the scheduler-backed BLE ack timeout — NO Android, NO Robolectric.
// This closes the gap where only BleSendPump.onTimeout (the pump's reaction) was tested but not
// the radio's SCHEDULER GLUE: that arm() actually schedules onTimeout, that cancel()/re-arm stop
// it, and that a shut-down scheduler (the stop()/disconnect race) is tolerated.  A real
// ScheduledExecutorService + a SHORT delay keep it fast + deterministic (no 30s wait, no seam).

package app.licio.courier;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicLong;

import org.junit.After;
import org.junit.Before;
import org.junit.Test;

public class ScheduledAckTimeoutTest {

    private ScheduledExecutorService scheduler;

    @Before
    public void setUp() {
        scheduler = Executors.newSingleThreadScheduledExecutor();
    }

    @After
    public void tearDown() {
        scheduler.shutdownNow();
    }

    @Test
    public void armFiresOnTimeoutWithTheArmedEpochAfterTheDelay() throws Exception {
        AtomicLong firedEpoch = new AtomicLong(-1);
        CountDownLatch fired = new CountDownLatch(1);
        new ScheduledAckTimeout(scheduler, 20, epoch -> {
            firedEpoch.set(epoch);
            fired.countDown();
        }).arm(42L);
        assertTrue("arm scheduled onTimeout, which fired", fired.await(2, TimeUnit.SECONDS));
        assertEquals("the fired callback carries the armed epoch", 42L, firedEpoch.get());
    }

    @Test
    public void cancelPreventsOnTimeoutFromFiring() throws Exception {
        AtomicBoolean fired = new AtomicBoolean(false);
        ScheduledAckTimeout t = new ScheduledAckTimeout(scheduler, 50, epoch -> fired.set(true));
        t.arm(1L);
        t.cancel();
        Thread.sleep(200); // well past the delay
        assertFalse("a cancelled timeout never fires", fired.get());
    }

    @Test
    public void reArmCancelsThePriorTimeoutSoItFiresExactlyOnce() throws Exception {
        AtomicInteger count = new AtomicInteger();
        ScheduledAckTimeout t = new ScheduledAckTimeout(scheduler, 30, epoch -> count.incrementAndGet());
        t.arm(1L);
        t.arm(2L); // the re-arm must cancel the first scheduled timeout
        Thread.sleep(200);
        assertEquals("re-arm fires the timeout exactly once (the prior was cancelled)",
                1, count.get());
    }

    @Test
    public void armOnAShutDownSchedulerIsToleratedNotThrown() {
        scheduler.shutdownNow();
        ScheduledAckTimeout t = new ScheduledAckTimeout(scheduler, 20, epoch -> {
            throw new AssertionError("must not fire on a shut-down scheduler");
        });
        t.arm(1L);  // RejectedExecutionException is swallowed — no throw out of the binder callback
        t.cancel(); // safe no-op (nothing was scheduled)
    }
}

// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-U election-lifecycle scheduler (ADR-7): runElectionLifecycle opens an
// election for each seat whose term has elapsed and settles each open election
// whose window has closed (kernel-tallied, fail-safe — a failed election keeps
// the incumbent). runGovernanceTick drives it under the lease pattern and routes
// errors to onError.
import { describe, expect, it, vi } from 'vitest';
import { resolveGovernanceConfig } from '../governance/config.js';
import { runGovernanceTick, startGovernanceScheduler } from '../governance/scheduler.js';
import type { GovernanceService } from '../governance/service.js';
import { createGovernanceService } from '../governance/services.js';
import { createInMemoryGovernanceStores } from '../governance/stores.js';

function make(termSeconds = 100, windowSeconds = 50) {
  let t = Date.parse('2026-06-19T00:00:00.000Z');
  let n = 0;
  const svc = createGovernanceService({
    stores: createInMemoryGovernanceStores(),
    config: resolveGovernanceConfig({
      electionTermSeconds: termSeconds,
      electionWindowSeconds: windowSeconds,
    }),
    now: () => new Date(t),
    uuid: () => `id-${++n}`,
  });
  return {
    svc,
    advance: (ms: number) => {
      t += ms;
    },
    now: () => t,
  };
}

async function openElectionId(svc: GovernanceService, roomId: string): Promise<string> {
  const seat = await svc.getSeat(roomId);
  const id = seat?.currentElectionId;
  if (!id) throw new Error('expected an open election');
  return id;
}

describe('runElectionLifecycle', () => {
  it('does nothing while the term is active', async () => {
    const { svc, now } = make();
    await svc.bootstrapSeat('r', 'creator');
    const result = await svc.runElectionLifecycle(async () => 5, now());
    expect(result).toEqual({ scheduled: 0, settled: 0 });
    expect((await svc.getSeat('r'))?.currentElectionId).toBeNull();
  });

  it('opens an election once the term has elapsed', async () => {
    const { svc, advance, now } = make(100, 50);
    await svc.bootstrapSeat('r', 'creator');
    advance(101_000);
    const result = await svc.runElectionLifecycle(async () => 5, now());
    expect(result.scheduled).toBe(1);
    expect((await svc.getSeat('r'))?.currentElectionId).not.toBeNull();
    // Idempotent: a second run does not open a second election.
    expect((await svc.runElectionLifecycle(async () => 5, now())).scheduled).toBe(0);
  });

  it('settles a closed election and rotates the seat to the winner', async () => {
    const { svc, advance, now } = make(100, 50);
    await svc.bootstrapSeat('r', 'creator');
    advance(101_000);
    await svc.runElectionLifecycle(async () => 3, now());
    const electionId = await openElectionId(svc, 'r');
    await svc.castVote('r', electionId, 'v1', 'challenger', true);
    await svc.castVote('r', electionId, 'v2', 'challenger', true);
    await svc.castVote('r', electionId, 'v3', 'creator', true);
    advance(51_000); // past the voting window
    const result = await svc.runElectionLifecycle(async () => 3, now());
    expect(result.settled).toBe(1);
    const seat = await svc.getSeat('r');
    expect(seat?.holderUserId).toBe('challenger');
    expect(seat?.currentElectionId).toBeNull();
    expect(seat?.bootstrap).toBe(false);
  });

  it('RECORDS the turnout electorate on the election row at open', async () => {
    // `tallyElection` divides distinct voters by the electorate.  Reading that
    // denominator live at SETTLE let anyone inflate room membership after the
    // last ballot, push turnout under `minTurnout`, and fail an election that
    // had met it — whereupon the fail-safe hands the incumbent a full new term.
    // The ratification path has always snapshotted at open; this asserts
    // elections do too.
    const { svc, advance, now } = make(100, 50);
    await svc.bootstrapSeat('r', 'creator');
    advance(101_000);
    // THREE eligible voters at open — the scheduler must pass its FREEZE reader
    // through to `scheduleElection` so the count lands on the row.  The freeze
    // reader is a separate argument from the settle-fallback count on purpose: that
    // one answers about an election's already-recorded open, which is a different
    // question, and passing only it left the denominator at zero.
    await svc.runElectionLifecycle(
      async () => 3,
      now(),
      undefined,
      async () => ({
        count: 3,
        asOf: new Date(now()).toISOString(),
      }),
    );
    const electionId = await openElectionId(svc, 'r');
    expect((await svc.getElection(electionId))?.eligibleCount).toBe(3);

    await svc.castVote('r', electionId, 'v1', 'challenger', true);
    await svc.castVote('r', electionId, 'v2', 'challenger', true);
    await svc.castVote('r', electionId, 'v3', 'challenger', true);
    advance(51_000);
    // …and a thousand by the time the scheduler ticks. The recorded 3 is what
    // the tally divides by, so the challenger still wins. (The turnout
    // ARITHMETIC is pinned in `governance-service.test.ts`, under a law pack
    // with a non-zero `minTurnout` — the baseline pack used here has 0, so the
    // denominator cannot decide an outcome in this harness.)
    const result = await svc.runElectionLifecycle(async () => 1_000, now());
    expect(result.settled).toBe(1);
    expect((await svc.getSeat('r'))?.holderUserId).toBe('challenger');
  });

  it('keeps the incumbent on a fail-safe (no-quorum) election', async () => {
    const { svc, advance, now } = make(100, 50);
    await svc.bootstrapSeat('r', 'creator');
    advance(101_000);
    await svc.runElectionLifecycle(async () => 3, now());
    advance(51_000); // window closes with zero ballots → quorum not met
    const result = await svc.runElectionLifecycle(async () => 3, now());
    expect(result.settled).toBe(1); // the election is resolved...
    const seat = await svc.getSeat('r');
    expect(seat?.holderUserId).toBe('creator'); // ...but the incumbent stays
    expect(seat?.currentElectionId).toBeNull();
  });
});

describe('runGovernanceTick', () => {
  it('logs when the lifecycle does work', async () => {
    const { svc, advance, now } = make(100, 50);
    await svc.bootstrapSeat('r', 'creator');
    advance(101_000);
    const log = vi.fn();
    await runGovernanceTick({
      service: svc,
      eligibleVoterCount: async () => 3,
      measureElectorate: async () => ({ count: 3, asOf: new Date(now()).toISOString() }),
      log,
      now,
    });
    expect(log).toHaveBeenCalledWith('governance.election_lifecycle', { scheduled: 1, settled: 0 });
  });

  it('drains the deferred re-moderation queue each tick, passing the re-seam + a limit', async () => {
    const apply = vi.fn();
    const sweep = vi.fn(async () => ({
      swept: 2,
      applied: 1,
      cleared: 0,
      stillUnavailable: 1,
      moot: 0,
      errors: 0,
    }));
    const svc = {
      runElectionLifecycle: async () => ({ scheduled: 0, settled: 0 }),
      runRatificationLifecycle: async () => ({ settled: 0, activated: 0 }),
      sweepPendingRemoderation: sweep,
    } as unknown as GovernanceService;
    const loadModerationContext = async () => null; // the reconstruction seam (content-free queue)
    const log = vi.fn();
    await runGovernanceTick({
      service: svc,
      eligibleVoterCount: async () => 0,
      measureElectorate: async () => ({ count: 0, asOf: new Date(0).toISOString() }),
      loadModerationContext,
      applyDeferredRemoderation: apply,
      log,
      now: () => 0,
    });
    expect(sweep).toHaveBeenCalledWith(loadModerationContext, apply, expect.any(Number));
    expect(log).toHaveBeenCalledWith(
      'governance.remoderation_lifecycle',
      expect.objectContaining({ swept: 2, applied: 1, stillUnavailable: 1 }),
    );
  });

  it('SKIPS the deferred re-moderation sweep when no context loader is wired', async () => {
    const sweep = vi.fn();
    const svc = {
      runElectionLifecycle: async () => ({ scheduled: 0, settled: 0 }),
      runRatificationLifecycle: async () => ({ settled: 0, activated: 0 }),
      sweepPendingRemoderation: sweep,
    } as unknown as GovernanceService;
    // No loadModerationContext ⇒ the sweep must not run (items stay queued).
    await runGovernanceTick({
      service: svc,
      eligibleVoterCount: async () => 0,
      measureElectorate: async () => ({ count: 0, asOf: new Date(0).toISOString() }),
      log: () => {},
      now: () => 0,
    });
    expect(sweep).not.toHaveBeenCalled();
  });

  it('retries stuck (transient) admissions each tick (R3-4)', async () => {
    const reEval = vi.fn(async () => ({ retried: 2, resolved: 1 }));
    const svc = {
      runElectionLifecycle: async () => ({ scheduled: 0, settled: 0 }),
      runRatificationLifecycle: async () => ({ settled: 0, activated: 0 }),
      reEvaluateStuckAdmissions: reEval,
    } as unknown as GovernanceService;
    const log = vi.fn();
    await runGovernanceTick({
      service: svc,
      eligibleVoterCount: async () => 0,
      measureElectorate: async () => ({ count: 0, asOf: new Date(0).toISOString() }),
      log,
      now: () => 0,
    });
    expect(reEval).toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith('governance.admission_retry', { retried: 2, resolved: 1 });
  });

  it('routes a lifecycle failure to onError', async () => {
    const failing = {
      runElectionLifecycle: async () => {
        throw new Error('boom');
      },
    } as unknown as GovernanceService;
    const onError = vi.fn();
    await runGovernanceTick(
      {
        service: failing,
        eligibleVoterCount: async () => 0,
        measureElectorate: async () => ({ count: 0, asOf: new Date(0).toISOString() }),
        log: () => {},
        now: () => 0,
      },
      onError,
    );
    expect(onError).toHaveBeenCalledWith(expect.any(Error), 'election_lifecycle');
  });

  it('startGovernanceScheduler runs interval ticks and stop() halts them', async () => {
    vi.useFakeTimers();
    try {
      const { svc, advance, now } = make(100, 50);
      await svc.bootstrapSeat('r', 'creator');
      advance(101_000); // term elapsed ⇒ the next tick opens an election
      const log = vi.fn();
      const stop = startGovernanceScheduler(
        {
          service: svc,
          eligibleVoterCount: async () => 3,
          measureElectorate: async () => ({ count: 3, asOf: new Date(now()).toISOString() }),
          log,
          now,
        },
        () => {},
        10,
      );
      await vi.advanceTimersByTimeAsync(12);
      expect(log).toHaveBeenCalledWith('governance.election_lifecycle', {
        scheduled: 1,
        settled: 0,
      });
      const callsBeforeStop = log.mock.calls.length;
      stop();
      await vi.advanceTimersByTimeAsync(50);
      expect(log.mock.calls.length).toBe(callsBeforeStop); // no further ticks after stop
    } finally {
      vi.useRealTimers();
    }
  });

  it('a REJECTING job lease is reported and skips the tick — it never escapes', async () => {
    // The acquire is the one await in the interval callback that
    // `runGovernanceTick`'s per-task catches do not cover. Unguarded, a
    // transient Postgres error inside `tryAcquire` rejects a promise nobody
    // holds, and Node's default `--unhandled-rejections=throw` terminates the
    // BFF over a blip in an hourly background job.
    vi.useFakeTimers();
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);
    try {
      const { svc, advance, now } = make(100, 50);
      await svc.bootstrapSeat('r', 'creator');
      advance(101_000);
      const log = vi.fn();
      const onError = vi.fn();
      const stop = startGovernanceScheduler(
        {
          service: svc,
          eligibleVoterCount: async () => 3,
          measureElectorate: async () => ({ count: 3, asOf: new Date(now()).toISOString() }),
          log,
          now,
        },
        onError,
        10,
        {
          lease: {
            tryAcquire: async () => {
              throw new Error('connection terminated unexpectedly');
            },
          },
          holder: 'test',
        },
      );
      await vi.advanceTimersByTimeAsync(12);
      stop();
      expect(onError).toHaveBeenCalledWith(expect.any(Error), 'lease');
      expect(log).not.toHaveBeenCalled(); // fail closed: no lease, no tick
    } finally {
      vi.useRealTimers();
      // Let any escaped rejection surface before we judge.
      await new Promise((resolve) => setImmediate(resolve));
      process.off('unhandledRejection', onUnhandled);
    }
    expect(unhandled).toEqual([]);
  });
});

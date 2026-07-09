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
    await runGovernanceTick({ service: svc, eligibleVoterCount: async () => 3, log, now });
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
    const log = vi.fn();
    await runGovernanceTick({
      service: svc,
      eligibleVoterCount: async () => 0,
      applyDeferredRemoderation: apply,
      log,
      now: () => 0,
    });
    expect(sweep).toHaveBeenCalledWith(apply, expect.any(Number));
    expect(log).toHaveBeenCalledWith(
      'governance.remoderation_lifecycle',
      expect.objectContaining({ swept: 2, applied: 1, stillUnavailable: 1 }),
    );
  });

  it('routes a lifecycle failure to onError', async () => {
    const failing = {
      runElectionLifecycle: async () => {
        throw new Error('boom');
      },
    } as unknown as GovernanceService;
    const onError = vi.fn();
    await runGovernanceTick(
      { service: failing, eligibleVoterCount: async () => 0, log: () => {}, now: () => 0 },
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
        { service: svc, eligibleVoterCount: async () => 3, log, now },
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
});

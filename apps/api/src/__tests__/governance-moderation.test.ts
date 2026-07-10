// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The DETERMINISTIC WRAPPER around the in-room LLM moderation model (WS-U
// ADR-9). The LLM is a bounded INPUT: `moderate` bounds its proposal by the
// escalate-to-human-review ceiling (never above `flag_for_review`) and the
// community-granted capability, degrades to the platform baseline (ok(null)) +
// enqueues DEFERRED re-moderation on model unavailability, and never lets the
// model exceed the community-voted envelope (authority enforced OUTSIDE the
// model, ADR-5).
import type { ModerationContext } from '@licio/governance';
import { describe, expect, it } from 'vitest';
import { resolveGovernanceConfig } from '../governance/config.js';
import type {
  ModerationProposer,
  ModerationProposerResult,
} from '../governance/moderation-proposer.js';
import {
  ADMISSION_ROOM_ID,
  type GovernanceService,
  type ModerationContextLoader,
} from '../governance/service.js';
import { createGovernanceService } from '../governance/services.js';
import { createInMemoryGovernanceStores, type GovernanceStores } from '../governance/stores.js';

const ROOM = 'room-mod';
const STEWARD = 'steward-mod';

function ctx(over: Partial<ModerationContext> = {}): ModerationContext {
  return {
    contentText: 'hello',
    contentKind: 'comment',
    contentLength: 5,
    linkCount: 0,
    mentionCount: 0,
    hasMediaUpload: false,
    authorAccountAgeDays: 365,
    authorNewToRoom: false,
    priorRemovalsInRoom: 0,
    ...over,
  };
}

const decided = (action: string, reason = 'because'): ModerationProposerResult => ({
  status: 'decided',
  proposal: { action: action as never, reason, outputId: 'out:x' },
});
/**
 * A fake proposer that exhibits `result` on real content, but CLEARS the platform
 * admission eval set on every probe (a `flag_for_review` is in-band for every
 * fixture) — so the wrapper-under-test always has an active binding. This models
 * a model that was admissible at evaluation time and only later (at moderation
 * time) exhibits the tested behaviour — including an outage (`unavailable`).
 */
function fakeProposer(result: ModerationProposerResult): ModerationProposer {
  return {
    kind: 'llm',
    async propose({ roomId }) {
      return roomId === ADMISSION_ROOM_ID ? decided('flag_for_review') : result;
    },
  };
}

function bundle(capabilities: string[]) {
  return {
    bundleId: 'mod',
    version: '1',
    name: 'Moderation model',
    moderationPrompt: 'Flag suspicious contributions for human review.',
    promptTemplates: {},
    config: {},
    requestedCapabilities: capabilities,
  };
}
function lawPack(capabilities: string[]) {
  return {
    lawPackId: 'lp-mod',
    version: '1',
    allowedProposalTypes: ['model_prompt_approval'],
    permittedCapabilities: capabilities,
    treasury: {
      caps: [],
      minIntervalSeconds: 0,
      timelockSeconds: 0,
      materialThreshold: 0,
      requireCoiFor: [],
      investment: null,
    },
    election: {
      weightModel: 'one_civic_account_one_vote',
      perAccountCap: 1,
      minQuorum: 1,
      minTurnout: 0,
      termSeconds: 1,
    },
  };
}

interface Harness {
  svc: GovernanceService;
  stores: GovernanceStores;
  deferred: Array<{ roomId: string; subjectRef: string }>;
}

function makeService(proposer: ModerationProposer): Harness {
  let n = 0;
  const deferred: Array<{ roomId: string; subjectRef: string }> = [];
  const stores = createInMemoryGovernanceStores();
  const svc = createGovernanceService({
    stores,
    config: resolveGovernanceConfig({}),
    now: () => new Date('2026-07-09T00:00:00.000Z'),
    uuid: () => `id-${++n}`,
    moderationProposer: proposer,
    onModerationDeferred: (roomId, subjectRef) => deferred.push({ roomId, subjectRef }),
  });
  return { svc, stores, deferred };
}
/** A proposer that clears admission, then is UNAVAILABLE for the first `n` real
 *  calls and `decided` thereafter — models an outage that later recovers. */
function flakyProposer(
  unavailableCalls: number,
  recovered: ModerationProposerResult,
): ModerationProposer {
  let realCalls = 0;
  return {
    kind: 'llm',
    async propose({ roomId }) {
      if (roomId === ADMISSION_ROOM_ID) return decided('flag_for_review'); // clears admission
      realCalls += 1;
      return realCalls <= unavailableCalls
        ? { status: 'unavailable', code: 'transport' }
        : recovered;
    },
  };
}

async function activate(svc: GovernanceService, capabilities: string[]): Promise<void> {
  await svc.bootstrapSeat(ROOM, STEWARD);
  const lp = await svc.proposeLawPack(ROOM, STEWARD, lawPack(capabilities));
  if (!lp.ok) throw new Error('law-pack');
  const proposed = await svc.proposeModel(ROOM, STEWARD, bundle(capabilities), 'be civil');
  if (!proposed.ok) throw new Error('propose');
  await svc.evaluateModel(proposed.value.modelId);
  const approved = await svc.approveModel(ROOM, proposed.value.modelId, null, lp.value.lawPackId);
  if (!approved.ok) throw new Error('approve');
}

describe('GovernanceService.moderate — the deterministic wrapper', () => {
  it('caps the model at the escalate-to-human-review ceiling: a proposed "remove" becomes "flag_for_review"', async () => {
    const h = makeService(fakeProposer(decided('remove', 'egregious')));
    await activate(h.svc, ['moderate.flag', 'moderate.remove']);
    const res = await h.svc.moderate(ROOM, ctx(), 'c1');
    expect(res.ok).toBe(true);
    // The community granted moderate.remove, but the ceiling forbids AI-driven
    // removal — a human confirms. So the model can reach at most flag_for_review.
    if (res.ok) expect(res.value?.action).toBe('flag_for_review');
  });

  it('clamps to the community-granted capability: only moderate.warn granted ⇒ a proposed flag becomes warn', async () => {
    const h = makeService(fakeProposer(decided('flag_for_review')));
    await activate(h.svc, ['moderate.warn']);
    const res = await h.svc.moderate(ROOM, ctx(), 'c2');
    expect(res.ok && res.value?.action).toBe('warn');
  });

  it('a room granting NO moderation capability ⇒ every proposal is clamped to allow', async () => {
    const h = makeService(fakeProposer(decided('remove')));
    await activate(h.svc, ['lawmaking.summarize']);
    const res = await h.svc.moderate(ROOM, ctx(), 'c3');
    expect(res.ok && res.value?.action).toBe('allow');
  });

  it('passes through a benign allow (no agent action logged)', async () => {
    const h = makeService(fakeProposer(decided('allow')));
    await activate(h.svc, ['moderate.flag']);
    const res = await h.svc.moderate(ROOM, ctx(), 'c4');
    expect(res.ok && res.value?.action).toBe('allow');
    expect(await h.svc.recentAgentActions(ROOM, 10)).toHaveLength(0);
  });

  it('logs an agent action with provenance when the model escalates', async () => {
    const h = makeService(fakeProposer(decided('flag_for_review', 'many links')));
    await activate(h.svc, ['moderate.flag']);
    await h.svc.moderate(ROOM, ctx({ linkCount: 5 }), 'c5');
    const actions = await h.svc.recentAgentActions(ROOM, 10);
    expect(actions[0]?.actionType).toBe('moderate.flag_for_review');
    expect(actions[0]?.subjectRef).toBe('c5');
    expect(actions[0]?.reversible).toBe(true); // the ceiling means never an AI removal
    expect(actions[0]?.lawPackRuleRef).toBeNull(); // the model is not a DSL rule
  });

  it('on model UNAVAILABLE: degrades to the platform baseline (null) AND enqueues deferred re-moderation', async () => {
    const h = makeService(fakeProposer({ status: 'unavailable', code: 'transport' }));
    await activate(h.svc, ['moderate.flag']);
    const res = await h.svc.moderate(ROOM, ctx({ linkCount: 5 }), 'c6');
    expect(res.ok && res.value).toBeNull(); // forum keeps the WS-J baseline decision
    // The DURABLE queue is the mechanism; onModerationDeferred is the parallel hook.
    const pending = await h.stores.pendingRemoderation.list(10);
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ roomId: ROOM, subjectRef: 'c6', attempts: 0 });
    expect(h.deferred).toEqual([{ roomId: ROOM, subjectRef: 'c6' }]);
    expect(await h.svc.recentAgentActions(ROOM, 10)).toHaveLength(0);
  });

  it('returns null (no model) when the room has no active binding', async () => {
    const h = makeService(fakeProposer(decided('flag_for_review')));
    await h.svc.bootstrapSeat(ROOM, STEWARD); // seat only
    const res = await h.svc.moderate(ROOM, ctx(), 'c7');
    expect(res.ok && res.value).toBeNull();
    expect(h.deferred).toHaveLength(0);
  });
});

describe('GovernanceService.moderate — the deterministic default proposer (no LLM)', () => {
  it('uses the deterministic default when no proposer is injected (link-heavy ⇒ flag_for_review)', async () => {
    // createGovernanceService defaults moderationProposer to the deterministic one.
    let n = 0;
    const svc = createGovernanceService({
      stores: createInMemoryGovernanceStores(),
      config: resolveGovernanceConfig({}),
      now: () => new Date('2026-07-09T00:00:00.000Z'),
      uuid: () => `id-${++n}`,
    });
    await activate(svc, ['moderate.flag']);
    const flagged = await svc.moderate(ROOM, ctx({ linkCount: 3 }), 'd1');
    expect(flagged.ok && flagged.value?.action).toBe('flag_for_review');
    const benign = await svc.moderate(ROOM, ctx(), 'd2');
    expect(benign.ok && benign.value?.action).toBe('allow');
  });
});

describe('GovernanceService.sweepPendingRemoderation — deferred re-moderation (never dropped)', () => {
  // The queue holds no content; the sweep RECONSTRUCTS the context via this loader.
  // The unit tests stand it in with a fixed link-heavy context.
  const loadCtx: ModerationContextLoader = async () => ctx({ linkCount: 5 });
  const loadGone: ModerationContextLoader = async () => null; // contribution deleted

  it('re-runs a deferred contribution when the model recovers, applies the decision, and dequeues it', async () => {
    // Unavailable on the live call (⇒ enqueued), decided on the sweep retry.
    const h = makeService(flakyProposer(1, decided('flag_for_review', 'many links')));
    await activate(h.svc, ['moderate.flag']);
    // Live: model down ⇒ baseline (null) + enqueued (ref only, no content).
    expect((await h.svc.moderate(ROOM, ctx({ linkCount: 5 }), 'c9')).ok).toBe(true);
    expect(await h.stores.pendingRemoderation.list(10)).toHaveLength(1);

    // Sweep: reconstruct the context, model recovered ⇒ apply via the re-seam + dequeue.
    const applied: Array<{ roomId: string; subjectRef: string; action: string; reason: string }> =
      [];
    const result = await h.svc.sweepPendingRemoderation(
      loadCtx,
      async (roomId, subjectRef, action, reason) => {
        applied.push({ roomId, subjectRef, action, reason });
      },
    );
    expect(result).toMatchObject({
      swept: 1,
      applied: 1,
      cleared: 0,
      stillUnavailable: 0,
      errors: 0,
    });
    expect(applied).toEqual([
      { roomId: ROOM, subjectRef: 'c9', action: 'flag_for_review', reason: 'many links' },
    ]);
    expect(await h.stores.pendingRemoderation.list(10)).toHaveLength(0);
    // The finally-landed judgment is logged as an agent action with provenance.
    const actions = await h.svc.recentAgentActions(ROOM, 10);
    expect(actions[0]?.actionType).toBe('moderate.flag_for_review');
    expect(actions[0]?.subjectRef).toBe('c9');
  });

  it('keeps an item queued and records an attempt while the model stays unavailable (retry, never dropped)', async () => {
    const h = makeService(fakeProposer({ status: 'unavailable', code: 'down' }));
    await activate(h.svc, ['moderate.flag']);
    await h.svc.moderate(ROOM, ctx({ linkCount: 5 }), 'c10');
    const applied: string[] = [];
    const result = await h.svc.sweepPendingRemoderation(loadCtx, async (_r, s) => {
      applied.push(s);
    });
    expect(result).toMatchObject({ swept: 1, stillUnavailable: 1, applied: 0 });
    expect(applied).toHaveLength(0);
    const pending = await h.stores.pendingRemoderation.list(10);
    expect(pending[0]).toMatchObject({ subjectRef: 'c10', attempts: 1 });
  });

  it('drops a deferred item the recovered model now judges benign (cleared, no raise)', async () => {
    const h = makeService(flakyProposer(1, decided('allow')));
    await activate(h.svc, ['moderate.flag']);
    await h.svc.moderate(ROOM, ctx({ linkCount: 5 }), 'c11');
    const applied: string[] = [];
    const result = await h.svc.sweepPendingRemoderation(loadCtx, async (_r, s) => {
      applied.push(s);
    });
    expect(result).toMatchObject({ swept: 1, cleared: 1, applied: 0 });
    expect(applied).toHaveLength(0); // benign ⇒ nothing raised
    expect(await h.stores.pendingRemoderation.list(10)).toHaveLength(0); // dequeued
  });

  it('drops a deferred item as moot when the room no longer has an active agent', async () => {
    const h = makeService(fakeProposer({ status: 'unavailable', code: 'down' }));
    await activate(h.svc, ['moderate.flag']);
    await h.svc.moderate(ROOM, ctx({ linkCount: 5 }), 'c12');
    // The platform floor freezes the agent between the defer and the sweep.
    await h.svc.freezeAgent(ROOM);
    const result = await h.svc.sweepPendingRemoderation(loadCtx, async () => {});
    expect(result).toMatchObject({ swept: 1, moot: 1, applied: 0 });
    expect(await h.stores.pendingRemoderation.list(10)).toHaveLength(0); // dequeued (no agent to judge it)
  });

  it('drops a deferred item as moot when its contribution was deleted (loader returns null)', async () => {
    const h = makeService(flakyProposer(1, decided('flag_for_review')));
    await activate(h.svc, ['moderate.flag']);
    await h.svc.moderate(ROOM, ctx({ linkCount: 5 }), 'c12b');
    // The contribution was purged before the sweep ⇒ the loader returns null.
    const result = await h.svc.sweepPendingRemoderation(loadGone, async () => {});
    expect(result).toMatchObject({ swept: 1, moot: 1, applied: 0 });
    expect(await h.stores.pendingRemoderation.list(10)).toHaveLength(0); // self-cleaned dangling ref
  });

  it('keeps an applied item queued when the re-seam fails (a failed raise never drops the judgment)', async () => {
    const h = makeService(flakyProposer(1, decided('flag_for_review')));
    await activate(h.svc, ['moderate.flag']);
    await h.svc.moderate(ROOM, ctx({ linkCount: 5 }), 'c13');
    const result = await h.svc.sweepPendingRemoderation(loadCtx, async () => {
      throw new Error('forum store down');
    });
    expect(result).toMatchObject({ swept: 1, errors: 1, applied: 0 });
    const pending = await h.stores.pendingRemoderation.list(10);
    expect(pending[0]).toMatchObject({ subjectRef: 'c13', attempts: 1 }); // stays queued for retry
  });

  it('keeps an applied item queued when NO re-seam is bound (null applier ⇒ never dropped)', async () => {
    const h = makeService(flakyProposer(1, decided('flag_for_review')));
    await activate(h.svc, ['moderate.flag']);
    await h.svc.moderate(ROOM, ctx({ linkCount: 5 }), 'c14');
    const result = await h.svc.sweepPendingRemoderation(loadCtx, null);
    expect(result).toMatchObject({ swept: 1, errors: 1, applied: 0 });
    expect(await h.stores.pendingRemoderation.list(10)).toHaveLength(1); // stays queued
  });
});

describe('GovernanceService.moderate — the admitting-backend gate (WS-U ADR-9 review)', () => {
  function backendProposer(backendId: string): ModerationProposer {
    // Always proposes flag_for_review — in-band for BOTH admission fixtures, so the
    // model is admissible; and a live restriction so the gate's effect is observable.
    return {
      kind: 'llm',
      backendId,
      async propose() {
        return decided('flag_for_review', 'x');
      },
    };
  }

  it('refuses to moderate under a DIFFERENT backend than the one that admitted the model', async () => {
    const stores = createInMemoryGovernanceStores();
    let n = 0;
    const mk = (p: ModerationProposer) =>
      createGovernanceService({
        stores,
        config: resolveGovernanceConfig({}),
        now: () => new Date('2026-07-09T00:00:00.000Z'),
        uuid: () => `id-${++n}`,
        moderationProposer: p,
      });
    // Admitted under backend-A (evaluateModel pins admittedBackendId='backend-A').
    const svcA = mk(backendProposer('backend-A'));
    await activate(svcA, ['moderate.flag']);
    const same = await svcA.moderate(ROOM, ctx({ linkCount: 5 }), 'ca');
    expect(same.ok && same.value?.action).toBe('flag_for_review'); // matching backend ⇒ moderates

    // A DIFFERENT backend over the SAME stores ⇒ fail closed to the baseline (the
    // prompt was never vetted for backend-B; no decision until re-admission).
    const svcB = mk(backendProposer('backend-B'));
    const switched = await svcB.moderate(ROOM, ctx({ linkCount: 5 }), 'cb');
    expect(switched.ok && switched.value).toBeNull();
  });

  it('a backendId-less proposer (a test double) skips the gate', async () => {
    // fakeProposer sets no backendId ⇒ `proposer.backendId === undefined` ⇒ the gate
    // is a no-op (only a real backend triggers it).
    const h = makeService(fakeProposer(decided('flag_for_review')));
    await activate(h.svc, ['moderate.flag']);
    const res = await h.svc.moderate(ROOM, ctx({ linkCount: 5 }), 'c-nobk');
    expect(res.ok && res.value?.action).toBe('flag_for_review');
  });

  it('R2-3: fails closed for a LEGACY unpinned model (admittedBackendId null) once a real backend is live', async () => {
    const stores = createInMemoryGovernanceStores();
    let n = 0;
    const mk = (p: ModerationProposer) =>
      createGovernanceService({
        stores,
        config: resolveGovernanceConfig({}),
        now: () => new Date('2026-07-09T00:00:00.000Z'),
        uuid: () => `id-${++n}`,
        moderationProposer: p,
      });
    // Admit under a backendId-LESS proposer ⇒ the model's admittedBackendId stays
    // null (a pre-0067 "legacy" admission).
    const legacy: ModerationProposer = {
      kind: 'llm',
      async propose() {
        return decided('flag_for_review', 'x');
      },
    };
    const svcLegacy = mk(legacy);
    await activate(svcLegacy, ['moderate.flag']);
    // A real backend then goes live ⇒ the legacy null-pinned model must NOT run under
    // it (it was never vetted for this backend); moderation fails closed to baseline.
    const svcReal = mk(backendProposer('backend-live'));
    const res = await svcReal.moderate(ROOM, ctx({ linkCount: 5 }), 'c-legacy');
    expect(res.ok && res.value).toBeNull();
  });
});

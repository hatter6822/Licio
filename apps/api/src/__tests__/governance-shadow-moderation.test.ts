// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The AUTHORITY INVARIANT of shadow moderation (WS-U ADR-9 slice 2): wiring a
// shadow advisor into GovernanceService must NEVER change what `moderate`
// returns. The advisor runs score-blind ALONGSIDE the authoritative DSL, is
// fired fire-and-forget (never awaited), is handed only the DSL action (to
// compute the divergence, never to condition the model), and a throwing advisor
// cannot disturb the decision. The DSL remains the sole authority (ADR-1/ADR-5).
import type { ModerationContext } from '@licio/governance';
import { describe, expect, it } from 'vitest';
import { resolveGovernanceConfig } from '../governance/config.js';
import type {
  ModerationShadowAdvisor,
  ModerationShadowRequest,
} from '../governance/moderation-shadow.js';
import type { GovernanceService } from '../governance/service.js';
import { createGovernanceService } from '../governance/services.js';
import { createInMemoryGovernanceStores } from '../governance/stores.js';

const ROOM = 'room-shadow';
const STEWARD = 'steward-shadow';
const ROOM_PROMPT = 'The room prizes sourced, courteous argument.';

function ctx(over: Partial<ModerationContext> = {}): ModerationContext {
  return {
    contentText: 'hi',
    contentKind: 'comment',
    contentLength: 2,
    linkCount: 0,
    mentionCount: 0,
    hasMediaUpload: false,
    authorAccountAgeDays: 365,
    authorNewToRoom: false,
    priorRemovalsInRoom: 0,
    ...over,
  };
}

/** A bundle that flags a link-heavy comment (so we can drive both allow + flag). */
function bundle() {
  return {
    bundleId: 'shadow',
    version: '1',
    name: 'Shadow-test bundle',
    moderationRules: [
      {
        id: 'links',
        when: { kind: 'link_count_gte', value: 3 },
        action: 'flag_for_review',
        reason: 'too many links',
      },
    ],
    promptTemplates: {},
    config: {},
    requestedCapabilities: ['moderate.flag'],
  };
}

function lawPack() {
  return {
    lawPackId: 'lp-shadow',
    version: '1',
    allowedProposalTypes: ['model_prompt_approval'],
    permittedCapabilities: ['moderate.flag'],
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

function makeFakeAdvisor() {
  const calls: ModerationShadowRequest[] = [];
  const state = { throwNext: false };
  const advisor: ModerationShadowAdvisor = {
    kind: 'llm',
    async recordShadow(request) {
      calls.push(request); // synchronous capture, before any await
      if (state.throwNext) throw new Error('advisor blew up');
    },
  };
  return { advisor, calls, state };
}

function makeService(advisor?: ModerationShadowAdvisor): GovernanceService {
  let n = 0;
  return createGovernanceService({
    stores: createInMemoryGovernanceStores(),
    config: resolveGovernanceConfig({}),
    now: () => new Date('2026-07-09T00:00:00.000Z'),
    uuid: () => `id-${++n}`,
    ...(advisor ? { moderationAdvisor: advisor } : {}),
  });
}

async function activate(svc: GovernanceService): Promise<void> {
  await svc.bootstrapSeat(ROOM, STEWARD);
  const lp = await svc.proposeLawPack(ROOM, STEWARD, lawPack());
  if (!lp.ok) throw new Error('law-pack');
  const proposed = await svc.proposeModel(ROOM, STEWARD, bundle(), ROOM_PROMPT);
  if (!proposed.ok) throw new Error('propose');
  await svc.evaluateModel(proposed.value.modelId);
  const approved = await svc.approveModel(ROOM, proposed.value.modelId, null, lp.value.lawPackId);
  if (!approved.ok) throw new Error('approve');
}

/** Let the fire-and-forget shadow (a detached prompt read + recordShadow) run. */
const flush = () => new Promise<void>((r) => setTimeout(r, 5));

describe('GovernanceService.moderate — shadow authority invariant', () => {
  it('returns the IDENTICAL gated DSL decision with and without an advisor wired', async () => {
    const context = ctx({ linkCount: 5, contentText: 'a b c http http http', contentLength: 20 });

    const plain = makeService();
    await activate(plain);
    const a = await plain.moderate(ROOM, context, 'contrib-x');

    const { advisor } = makeFakeAdvisor();
    const shadowed = makeService(advisor);
    await activate(shadowed);
    const b = await shadowed.moderate(ROOM, context, 'contrib-x');

    expect(a.ok && b.ok).toBe(true);
    if (a.ok && b.ok) expect(b.value).toEqual(a.value); // the advisor changed nothing
    if (b.ok && b.value) expect(b.value.action).toBe('flag_for_review');
  });

  it('fires the advisor with the DSL action + the room prompt — even on an ALLOW decision', async () => {
    const { advisor, calls } = makeFakeAdvisor();
    const svc = makeService(advisor);
    await activate(svc);

    const allow = await svc.moderate(ROOM, ctx(), 'contrib-allow'); // benign → allow
    expect(allow.ok && allow.value?.action).toBe('allow');
    await flush();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.roomId).toBe(ROOM);
    expect(calls[0]?.subjectRef).toBe('contrib-allow');
    expect(calls[0]?.dslAction).toBe('allow'); // shadow covers agreements on allow
    expect(calls[0]?.roomPromptText).toBe(ROOM_PROMPT); // conditioned by the room prompt

    const flag = await svc.moderate(
      ROOM,
      ctx({ linkCount: 4, contentText: 'x http http http http', contentLength: 20 }),
      'contrib-flag',
    );
    expect(flag.ok && flag.value?.action).toBe('flag_for_review');
    await flush();
    expect(calls).toHaveLength(2);
    expect(calls[1]?.dslAction).toBe('flag_for_review');
  });

  it('never consults the advisor when the room has no active binding', async () => {
    const { advisor, calls } = makeFakeAdvisor();
    const svc = makeService(advisor);
    await svc.bootstrapSeat(ROOM, STEWARD); // seat only, no approved model
    const res = await svc.moderate(ROOM, ctx(), 'contrib-none');
    expect(res.ok && res.value).toBeNull();
    await flush();
    expect(calls).toHaveLength(0);
  });

  it('a throwing advisor cannot disturb the moderation decision (fire-and-forget is caught)', async () => {
    const { advisor, state } = makeFakeAdvisor();
    state.throwNext = true;
    const svc = makeService(advisor);
    await activate(svc);
    const res = await svc.moderate(ROOM, ctx({ linkCount: 5 }), 'contrib-throw');
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value?.action).toBe('flag_for_review');
    await flush(); // the detached rejection is swallowed by the .catch, not surfaced
  });
});

// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-U bounded in-room agent on the contribution path (SPEC §24.6). Two layers:
//   A. createContribution consults forum.agentModerator and combines its
//      recommendation FLOOR-DOMINANTLY (the agent can raise the moderation state
//      but never lower a platform-floor decision), routing agent-held content to
//      the human review queue and suppressing scoring emission while held.
//   B. the real governance adapter (createRoomAgentModerator) maps an active
//      community-approved binding's decision to a contribution state, and returns
//      null when no agent governs the room.
import { type ContributionCreate, contributionCreateSchema } from '@licio/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createContribution, editContribution } from '../forum/contributions.js';
import { type RoomAgentModerator, resetForumServicesForTests } from '../forum/services.js';
import {
  buildDeferredRemoderationApplier,
  buildModerationContextLoader,
  createRoomAgentModerator,
} from '../governance/forum-agent.js';
import type { ModerationProposer } from '../governance/moderation-proposer.js';
import {
  createGovernanceService,
  resetGovernanceService,
  setGovernanceService,
} from '../governance/services.js';
import { createInMemoryGovernanceStores } from '../governance/stores.js';
import {
  contributionBody,
  type ForumServicesFixture,
  freshForumServices,
  seedThread,
} from './forum-test-helpers.js';

const AUTHOR = '00000000-0000-4000-8000-0000000000b2';

let fixture: ForumServicesFixture;

beforeEach(() => {
  fixture = freshForumServices();
});
afterEach(async () => {
  await fixture.settleAll();
  resetForumServicesForTests();
  resetGovernanceService();
});

function bundle() {
  return { forum: fixture.forum, ingestion: fixture.ingestion, events: fixture.events };
}
async function post(body: ContributionCreate) {
  return createContribution(bundle(), AUTHOR, `acct-${AUTHOR}`, body);
}
/** A stub agent that returns one fixed recommendation. */
function fixedAgent(state: 'published' | 'under_review' | 'removed' | null): RoomAgentModerator {
  return { moderateContribution: async () => (state === null ? null : { state }) };
}
function metric(name: string): number {
  return fixture.forum.metrics.snapshot()[name] ?? 0;
}

describe('WS-U agent on the contribution path (combination + intake)', () => {
  it('holds clean content the in-room agent flags (under_review + review queue, no emission)', async () => {
    fixture.forum.agentModerator = fixedAgent('under_review');
    const { threadId } = await seedThread(fixture);
    const res = await post(contributionCreateSchema.parse(contributionBody('comment', threadId)));
    expect(res.ok && res.contribution.moderationState).toBe('under_review');
    expect(metric('contributions.agent_moderated')).toBeGreaterThanOrEqual(1);
    expect(metric('contributions.agent_flagged')).toBeGreaterThanOrEqual(1);
    // Held content takes the no-emission path (no participation weight).
    expect(metric('contributions.held_emission_deferred')).toBeGreaterThanOrEqual(1);
    // The agent action is routed to the human review queue (appealable to floor).
    const queued = await fixture.ingestion.reviewQueue.list(
      { kind: 'contribution_safety_hold' },
      10,
    );
    expect(queued.some((i) => i.context['source'] === 'in_room_agent')).toBe(true);
  });

  it('removes content the in-room agent removes (removed + agent_blocked)', async () => {
    fixture.forum.agentModerator = fixedAgent('removed');
    const { threadId } = await seedThread(fixture);
    const res = await post(contributionCreateSchema.parse(contributionBody('comment', threadId)));
    expect(res.ok && res.contribution.moderationState).toBe('removed');
    expect(metric('contributions.agent_blocked')).toBeGreaterThanOrEqual(1);
  });

  it('publishes normally when no agent governs the room (null recommendation)', async () => {
    fixture.forum.agentModerator = fixedAgent(null);
    const { threadId } = await seedThread(fixture);
    const res = await post(contributionCreateSchema.parse(contributionBody('comment', threadId)));
    expect(res.ok && res.contribution.moderationState).toBe('published');
    expect(metric('contributions.agent_moderated')).toBe(0);
  });

  it('publishes when the agent allows (state published) without a review hold', async () => {
    fixture.forum.agentModerator = fixedAgent('published');
    const { threadId } = await seedThread(fixture);
    const res = await post(contributionCreateSchema.parse(contributionBody('comment', threadId)));
    expect(res.ok && res.contribution.moderationState).toBe('published');
    // No escalation ⇒ no agent hold recorded.
    expect(metric('contributions.agent_moderated')).toBe(0);
    const queued = await fixture.ingestion.reviewQueue.list(
      { kind: 'contribution_safety_hold' },
      10,
    );
    expect(queued).toHaveLength(0);
  });

  it('RE-MODERATES on edit: an agent that flags the edited content holds it', async () => {
    // Created with no agent ⇒ published; an agent then governs and flags on edit.
    const { threadId } = await seedThread(fixture);
    const created = await post(
      contributionCreateSchema.parse(contributionBody('comment', threadId)),
    );
    if (!created.ok) throw new Error('create failed');
    expect(created.contribution.moderationState).toBe('published');

    fixture.forum.agentModerator = fixedAgent('under_review');
    const edited = await editContribution(bundle(), AUTHOR, created.contribution.contributionId, {
      contribution_id: created.contribution.contributionId,
      body: 'An edited body that the in-room agent flags for review.',
    });
    expect(edited.ok && edited.contribution.moderationState).toBe('under_review');
    expect(metric('contributions.edit_agent_flagged')).toBeGreaterThanOrEqual(1);
  });

  it('is FLOOR-DOMINANT: the agent cannot lower a platform-floor removal', async () => {
    // Floor blocks; the agent would "allow" — the floor decision stands.
    fixture.forum.safety = {
      classify: async () => ({
        disposition: 'block',
        reasons: ['floor'],
        reasonCode: 'MOD_SPAM_001',
      }),
    };
    fixture.forum.agentModerator = fixedAgent('published');
    const { threadId } = await seedThread(fixture);
    const res = await post(contributionCreateSchema.parse(contributionBody('comment', threadId)));
    expect(res.ok && res.contribution.moderationState).toBe('removed');
    // The agent did not escalate (it tried to lower), so no agent metric fired.
    expect(metric('contributions.agent_moderated')).toBe(0);
  });
});

describe('WS-U createRoomAgentModerator (governance adapter)', () => {
  const ROOM = '00000000-0000-4000-8000-0000000000c3';
  const STEWARD = '00000000-0000-4000-8000-0000000000c4';

  /** A bundle that flags many-link content for review (passes the admission gate). */
  function flagBundle() {
    return {
      bundleId: 'flag-links',
      version: '1',
      name: 'Flag links',
      moderationPrompt:
        'Route link-heavy, spammy, or otherwise suspicious contributions to human review; allow civil on-topic content.',
      promptTemplates: {},
      config: { summaryStyle: 'neutral_brief', explanationVerbosity: 'standard' },
      requestedCapabilities: ['moderate.flag'],
    };
  }

  async function seedActiveBinding(): Promise<void> {
    const svc = createGovernanceService({ stores: createInMemoryGovernanceStores() });
    setGovernanceService(svc);
    await svc.bootstrapSeat(ROOM, STEWARD);
    const proposed = await svc.proposeModel(ROOM, STEWARD, flagBundle(), 'Be neutral.', true);
    if (!proposed.ok) throw new Error('propose failed');
    await svc.evaluateModel(proposed.value.modelId);
    const approved = await svc.approveModel(ROOM, proposed.value.modelId, null, null);
    if (!approved.ok) throw new Error('approve failed');
  }

  it('returns null when no agent governs the room', async () => {
    setGovernanceService(createGovernanceService({ stores: createInMemoryGovernanceStores() }));
    const port = createRoomAgentModerator();
    expect(
      await port.moderateContribution({
        roomId: ROOM,
        contributionId: 'c1',
        authorUserId: 'u1',
        type: 'comment',
        body: 'hello',
        citationCount: 0,
        attachmentCount: 0,
      }),
    ).toBeNull();
  });

  it('maps an active binding flag decision to under_review', async () => {
    await seedActiveBinding();
    const port = createRoomAgentModerator();
    const decision = await port.moderateContribution({
      roomId: ROOM,
      contributionId: 'c2',
      authorUserId: 'u1',
      type: 'comment',
      body: 'see https://a.test https://b.test https://c.test',
      citationCount: 0,
      attachmentCount: 0,
    });
    expect(decision?.state).toBe('under_review');
    expect(decision?.reason).toBeTruthy(); // carries the community statement of reasons
  });

  it('maps an allow decision (few links) to published', async () => {
    await seedActiveBinding();
    const port = createRoomAgentModerator();
    const decision = await port.moderateContribution({
      roomId: ROOM,
      contributionId: 'c3',
      authorUserId: 'u1',
      type: 'comment',
      body: 'a civil and helpful comment',
      citationCount: 0,
      attachmentCount: 0,
    });
    expect(decision).toEqual({ state: 'published' });
  });

  it('counts inline links canonically (one per URL token, plus citations)', async () => {
    await seedActiveBinding(); // flags at link_count_gte 3
    const port = createRoomAgentModerator();
    // Two inline URL tokens + one citation = 3 ⇒ flagged. (The old substring
    // scan would also have hit 3, but it double-counts a citation URL repeated
    // inline; this counts one token per URL.)
    const decision = await port.moderateContribution({
      roomId: ROOM,
      contributionId: 'c4',
      authorUserId: 'u1',
      type: 'comment',
      body: 'refs https://a.test and https://b.test',
      citationCount: 1,
      attachmentCount: 0,
    });
    expect(decision?.state).toBe('under_review');
  });

  it('does not miscount an email address as a mention', async () => {
    // A model that flags on >=1 mention (or link spam, so it clears the platform
    // admission eval set); an email address must NOT trip the mention rule. The
    // proposer keys on the ModerationContext the adapter builds, so this asserts
    // the adapter's canonical mention count, not the model's prose.
    const mentionProposer: ModerationProposer = {
      kind: 'llm',
      async propose({ context }) {
        const flag = context.mentionCount >= 1 || context.linkCount >= 3;
        return {
          status: 'decided',
          proposal: {
            action: flag ? 'flag_for_review' : 'allow',
            reason: flag ? 'flagged' : 'benign',
            outputId: null,
          },
        };
      },
    };
    const svc = createGovernanceService({
      stores: createInMemoryGovernanceStores(),
      moderationProposer: mentionProposer,
    });
    setGovernanceService(svc);
    await svc.bootstrapSeat(ROOM, STEWARD);
    const mentionBundle = {
      bundleId: 'flag-mentions',
      version: '1',
      name: 'Flag mentions',
      moderationPrompt:
        'Route link-heavy, spammy, or otherwise suspicious contributions to human review; allow civil on-topic content.',
      promptTemplates: {},
      config: { summaryStyle: 'neutral_brief', explanationVerbosity: 'standard' },
      requestedCapabilities: ['moderate.flag'],
    };
    const proposed = await svc.proposeModel(ROOM, STEWARD, mentionBundle, 'Be neutral.', true);
    if (!proposed.ok) throw new Error('propose failed');
    await svc.evaluateModel(proposed.value.modelId);
    await svc.approveModel(ROOM, proposed.value.modelId, null, null);
    const port = createRoomAgentModerator();
    // An email (user@host) is not a mention; a real @handle is.
    expect(
      await port.moderateContribution({
        roomId: ROOM,
        contributionId: 'c5',
        authorUserId: 'u1',
        type: 'comment',
        body: 'contact me at someone@example.com',
        citationCount: 0,
        attachmentCount: 0,
      }),
    ).toEqual({ state: 'published' });
    expect(
      (
        await port.moderateContribution({
          roomId: ROOM,
          contributionId: 'c6',
          authorUserId: 'u1',
          type: 'comment',
          body: 'hey @alice look here',
          citationCount: 0,
          attachmentCount: 0,
        })
      )?.state,
    ).toBe('under_review');
  });
});

describe('WS-U buildDeferredRemoderationApplier (deferred re-seam, floor-dominant)', () => {
  const ROOM = '00000000-0000-4000-8000-0000000000d1';
  type Hold = { contributionId: string; removed: boolean; reason: string | null };

  function spySink(holds: Hold[]): void {
    fixture.forum.autoModerationSink = {
      recordContentAutoBlock: async () => {},
      recordAgentHold: async (i) => {
        holds.push({ contributionId: i.contributionId, removed: i.removed, reason: i.reason });
      },
    };
  }
  function applier() {
    return buildDeferredRemoderationApplier({
      forum: fixture.forum,
      ingestion: fixture.ingestion,
    });
  }
  async function publishedContribution(): Promise<string> {
    const { threadId } = await seedThread(fixture);
    const created = await post(
      contributionCreateSchema.parse(contributionBody('comment', threadId)),
    );
    if (!created.ok) throw new Error('create failed');
    expect(created.contribution.moderationState).toBe('published');
    return created.contribution.contributionId;
  }

  it('raises a published contribution to under_review + review queue + author notice', async () => {
    const holds: Hold[] = [];
    spySink(holds);
    const id = await publishedContribution();
    await applier()(ROOM, id, 'flag_for_review', 'several links');

    expect((await fixture.forum.contributions.getById(id))?.moderationState).toBe('under_review');
    const queued = await fixture.ingestion.reviewQueue.list(
      { kind: 'contribution_safety_hold' },
      10,
    );
    expect(queued.some((q) => q.context['source'] === 'in_room_agent_deferred')).toBe(true);
    // No silent sanction: the author gets the agent's statement of reasons.
    expect(holds).toEqual([{ contributionId: id, removed: false, reason: 'several links' }]);
    expect(metric('contributions.agent_flagged_deferred')).toBeGreaterThanOrEqual(1);
  });

  it('is FLOOR-DOMINANT: never LOWERS a platform-floor removal (no state change, no queue item)', async () => {
    const id = await publishedContribution();
    await fixture.forum.contributions.setModerationState(id, 'removed'); // the floor removed it
    await applier()(ROOM, id, 'flag_for_review', 'late flag');

    expect((await fixture.forum.contributions.getById(id))?.moderationState).toBe('removed'); // unchanged
    const queued = await fixture.ingestion.reviewQueue.list(
      { kind: 'contribution_safety_hold' },
      10,
    );
    expect(queued.some((q) => q.context['source'] === 'in_room_agent_deferred')).toBe(false);
  });

  it('a warn records the author notice WITHOUT hiding the content (no state change)', async () => {
    const holds: Hold[] = [];
    spySink(holds);
    const id = await publishedContribution();
    await applier()(ROOM, id, 'warn', 'please stay on topic');

    expect((await fixture.forum.contributions.getById(id))?.moderationState).toBe('published'); // still visible
    expect(holds).toEqual([{ contributionId: id, removed: false, reason: 'please stay on topic' }]);
    const queued = await fixture.ingestion.reviewQueue.list(
      { kind: 'contribution_safety_hold' },
      10,
    );
    expect(queued).toHaveLength(0); // a warn does not route to review
  });

  it('is a no-op for a contribution that was deleted since the deferral', async () => {
    // An unknown id (never created / purged) ⇒ nothing to raise, no throw.
    await expect(
      applier()(ROOM, 'ghost-contribution', 'flag_for_review', 'x'),
    ).resolves.toBeUndefined();
    const queued = await fixture.ingestion.reviewQueue.list(
      { kind: 'contribution_safety_hold' },
      10,
    );
    expect(queued).toHaveLength(0);
  });

  it('R2-4: compensates (restores published) when the review-queue intake fails — no orphaned hidden content', async () => {
    const id = await publishedContribution();
    // The review-queue intake throws AFTER the state was raised to under_review.
    fixture.ingestion.reviewQueue.insert = async () => {
      throw new Error('queue down');
    };
    await expect(applier()(ROOM, id, 'flag_for_review', 'links')).rejects.toThrow('queue down');
    // Atomicity: the contribution is NOT left hidden without a reviewer case — it was
    // restored to published, so the sweep can retry BOTH steps cleanly next pass.
    expect((await fixture.forum.contributions.getById(id))?.moderationState).toBe('published');
  });

  it('R3-3: compensates (restores published) when the AUTHOR NOTICE fails — no silent deferred sanction', async () => {
    const id = await publishedContribution();
    // The state + review case are written, but the author-notice sink then throws.
    fixture.forum.autoModerationSink = {
      recordContentAutoBlock: async () => {},
      recordAgentHold: async () => {
        throw new Error('notice store down');
      },
    };
    await expect(applier()(ROOM, id, 'flag_for_review', 'links')).rejects.toThrow(
      'notice store down',
    );
    // The notice is inside the atomic unit: a hidden contribution is never left
    // without its statement-of-reasons, so it was restored to published for retry.
    expect((await fixture.forum.contributions.getById(id))?.moderationState).toBe('published');
  });
});

describe('WS-U buildModerationContextLoader (content-free reconstruction + moot rules)', () => {
  const history = async () => ({ accountAgeDays: 100, newToRoom: false, priorRemovalsInRoom: 0 });
  function loader() {
    return buildModerationContextLoader({ forum: fixture.forum, readAuthorHistory: history });
  }
  async function published(): Promise<string> {
    const { threadId } = await seedThread(fixture);
    const created = await post(
      contributionCreateSchema.parse(contributionBody('comment', threadId)),
    );
    if (!created.ok) throw new Error('create failed');
    return created.contribution.contributionId;
  }

  it('reconstructs a context from the live contribution (published)', async () => {
    const ctx = await loader()('room-x', await published());
    expect(ctx).not.toBeNull();
    expect(ctx?.contentKind).toBe('comment');
    expect(ctx?.authorAccountAgeDays).toBe(100);
  });

  it('R2-2: returns null (moot) for a non-published (floor-removed) contribution', async () => {
    const id = await published();
    await fixture.forum.contributions.setModerationState(id, 'removed');
    expect(await loader()('room-x', id)).toBeNull();
  });

  it('returns null (moot) for a deleted / unknown contribution', async () => {
    expect(await loader()('room-x', 'ghost')).toBeNull();
  });
});

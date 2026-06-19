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
import { createRoomAgentModerator } from '../governance/forum-agent.js';
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
    const res = await post(contributionCreateSchema.parse(contributionBody('question', threadId)));
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
    const res = await post(
      contributionCreateSchema.parse(contributionBody('explanation', threadId)),
    );
    expect(res.ok && res.contribution.moderationState).toBe('removed');
    expect(metric('contributions.agent_blocked')).toBeGreaterThanOrEqual(1);
  });

  it('publishes normally when no agent governs the room (null recommendation)', async () => {
    fixture.forum.agentModerator = fixedAgent(null);
    const { threadId } = await seedThread(fixture);
    const res = await post(contributionCreateSchema.parse(contributionBody('question', threadId)));
    expect(res.ok && res.contribution.moderationState).toBe('published');
    expect(metric('contributions.agent_moderated')).toBe(0);
  });

  it('publishes when the agent allows (state published) without a review hold', async () => {
    fixture.forum.agentModerator = fixedAgent('published');
    const { threadId } = await seedThread(fixture);
    const res = await post(contributionCreateSchema.parse(contributionBody('question', threadId)));
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
      contributionCreateSchema.parse(contributionBody('explanation', threadId)),
    );
    if (!created.ok) throw new Error('create failed');
    expect(created.contribution.moderationState).toBe('published');

    fixture.forum.agentModerator = fixedAgent('under_review');
    const edited = await editContribution(bundle(), AUTHOR, created.contribution.contributionId, {
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
    const res = await post(contributionCreateSchema.parse(contributionBody('question', threadId)));
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
      moderationRules: [
        {
          id: 'links',
          when: { kind: 'link_count_gte', value: 3 },
          action: 'flag_for_review',
          reason: 'Many links pending review.',
        },
      ],
      promptTemplates: {},
      config: { summaryStyle: 'neutral_brief', explanationVerbosity: 'standard' },
      requestedCapabilities: ['moderate.flag'],
    };
  }

  async function seedActiveBinding(): Promise<void> {
    const svc = createGovernanceService({ stores: createInMemoryGovernanceStores() });
    setGovernanceService(svc);
    await svc.bootstrapSeat(ROOM, STEWARD);
    const proposed = await svc.proposeModel(ROOM, STEWARD, flagBundle(), 'Be neutral.');
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
      type: 'comment',
      body: 'see https://a.test https://b.test https://c.test',
      citationCount: 0,
      attachmentCount: 0,
    });
    expect(decision).toEqual({ state: 'under_review' });
  });

  it('maps an allow decision (few links) to published', async () => {
    await seedActiveBinding();
    const port = createRoomAgentModerator();
    const decision = await port.moderateContribution({
      roomId: ROOM,
      contributionId: 'c3',
      type: 'comment',
      body: 'a civil and helpful comment',
      citationCount: 0,
      attachmentCount: 0,
    });
    expect(decision).toEqual({ state: 'published' });
  });
});

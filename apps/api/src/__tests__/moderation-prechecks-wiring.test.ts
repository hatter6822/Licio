// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-J.2.6 pre-checks wired into contribution submission: high-confidence spam
// and malware AUTO-BLOCK (persist `removed`) and record an APPEALABLE system
// action + statement-of-reasons notice + audit; policy-risk/flood FLAG to the
// review queue (never auto-removed).
import { type ContributionCreate, contributionCreateSchema } from '@licio/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createContribution } from '../forum/contributions.js';
import { resetForumServicesForTests } from '../forum/services.js';
import {
  createAutoModerationSink,
  createWsJContributionSafety,
} from '../moderation/forum-integration.js';
import { contentSignature } from '../moderation/prechecks.js';
import {
  createInMemoryModerationServices,
  type ModerationServices,
} from '../moderation/services.js';
import {
  contributionBody,
  type ForumServicesFixture,
  freshForumServices,
  seedThread,
} from './forum-test-helpers.js';

const AUTHOR = '00000000-0000-4000-8000-0000000000a1';

let fixture: ForumServicesFixture;
let mod: ModerationServices;

beforeEach(() => {
  fixture = freshForumServices();
  mod = createInMemoryModerationServices({
    config: { malwareDomains: ['drainer.test'], spamPatterns: ['buy cheap followers'] },
  });
  fixture.forum.safety = createWsJContributionSafety(mod, fixture.ingestion.urlSafety);
  fixture.forum.autoModerationSink = createAutoModerationSink(mod);
});
afterEach(async () => {
  await fixture.settleAll();
  await mod.settle();
  resetForumServicesForTests();
});

function bundle() {
  return { forum: fixture.forum, ingestion: fixture.ingestion, events: fixture.events };
}
async function post(body: ContributionCreate) {
  return createContribution(bundle(), AUTHOR, `acct-${AUTHOR}`, body);
}

describe('WS-J.2.6 contribution auto-block', () => {
  it('auto-blocks a known-spam body (removed) and records an appealable notice + audit', async () => {
    const spamText = 'Buy cheap followers at my-site dot example right now!';
    // A dedicated container whose known-spam-hash set pins this body.
    const spamMod = createInMemoryModerationServices({
      config: { knownSpamHashes: [contentSignature(spamText)] },
    });
    fixture.forum.safety = createWsJContributionSafety(spamMod, fixture.ingestion.urlSafety);
    fixture.forum.autoModerationSink = createAutoModerationSink(spamMod);
    const { threadId } = await seedThread(fixture);

    const res = await post(
      contributionCreateSchema.parse({
        ...contributionBody('explanation', threadId),
        body: spamText,
      }),
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.contribution.moderationState).toBe('removed');

    await fixture.forum.settle();
    await spamMod.settle();
    // The author has an appealable statement-of-reasons notice.
    expect(await spamMod.notices.unreadCount(AUTHOR)).toBe(1);
    const notices = await spamMod.notices.listByUser(AUTHOR, null, 5);
    expect(notices[0]?.appealable).toBe(true);
    expect(notices[0]?.reasonCode).toBe('MOD_SPAM_001');
    // A system (actor=null) auto_block audit record exists.
    const audit = await spamMod.audit.list({ action: 'auto_block', limit: 5 });
    expect(audit).toHaveLength(1);
    expect(audit[0]?.actorUserId).toBeNull();
    // #15: a `removed` auto-block took the no-emission suppress path (scoring,
    // freshness, and room activity must not count content readers cannot see).
    expect(
      fixture.forum.metrics.snapshot()['contributions.held_emission_deferred'] ?? 0,
    ).toBeGreaterThanOrEqual(1);
  });

  it('auto-blocks a malware-domain citation (moderation blocklist)', async () => {
    const { threadId } = await seedThread(fixture);
    const seededClaim = await fixture.ingestion.claims.insert({
      claimId: '00000000-0000-4000-8000-0000000000cc',
      storyId: null,
      canonicalText: 'A claim.',
      normalizedTextHash: 'h'.repeat(40),
      claimStatus: 'candidate',
      firstSeenStoryId: null,
      independenceGroupId: null,
      createdBy: null,
      extractionSource: 'system',
      extractionConfidence: null,
      modelVersion: null,
    });
    const res = await post(
      contributionCreateSchema.parse({
        ...contributionBody('evidence', threadId, { claimId: seededClaim.claimId }),
        citations: [{ url: 'https://drainer.test/payload' }],
      }),
    );
    expect(res.ok && res.contribution.moderationState).toBe('removed');
  });

  it('flags policy-risk content for review (under_review), never auto-removed', async () => {
    const { threadId } = await seedThread(fixture);
    const res = await post(
      contributionCreateSchema.parse({
        ...contributionBody('explanation', threadId),
        body: "You're worthless and nobody wants you here.",
      }),
    );
    expect(res.ok && res.contribution.moderationState).toBe('under_review');
  });

  it('publishes clean content normally', async () => {
    const { threadId } = await seedThread(fixture);
    const res = await post(contributionCreateSchema.parse(contributionBody('question', threadId)));
    expect(res.ok && res.contribution.moderationState).toBe('published');
  });

  it('#8 notifies the author when the in-room agent holds OR removes content', async () => {
    const { threadId } = await seedThread(fixture);

    // (a) The floor clears, but the in-room community agent holds for review.
    fixture.forum.agentModerator = {
      moderateContribution: async () => ({
        state: 'under_review',
        reason: 'Off-topic for this room.',
      }),
    };
    const held = await post(contributionCreateSchema.parse(contributionBody('question', threadId)));
    expect(held.ok && held.contribution.moderationState).toBe('under_review');

    // (b) The in-room agent removes a different contribution.
    fixture.forum.agentModerator = {
      moderateContribution: async () => ({ state: 'removed', reason: 'Prohibited content.' }),
    };
    const removed = await post(
      contributionCreateSchema.parse(contributionBody('explanation', threadId)),
    );
    expect(removed.ok && removed.contribution.moderationState).toBe('removed');

    await fixture.forum.settle();
    await mod.settle();

    // Each is a COMMUNITY-layer statement-of-reasons notice: no platform reason
    // code, not a WS-J in-app appeal (recourse is the queued human review), and it
    // carries the agent's reason text (no silent sanction).
    const notices = await mod.notices.listByUser(AUTHOR, null, 5);
    expect(notices).toHaveLength(2);
    const bodies = notices.map((n) => n.body).join('\n');
    expect(bodies).toContain('removed your contribution (Prohibited content.)');
    expect(bodies).toContain('held for review your contribution (Off-topic for this room.)');
    for (const n of notices) {
      expect(n.reasonCode).toBeNull();
      expect(n.appealable).toBe(false);
    }
    expect(fixture.forum.metrics.snapshot()['contributions.agent_moderated'] ?? 0).toBe(2);
  });

  it('#3 does not flag a duplicate flood one submission/room early (no double-count)', async () => {
    // DISTINCT rooms (cross-room flooding needs duplicateFloodMinRooms=2 rooms
    // AND duplicateFloodCount=3 similar posts): seed each thread in its own room.
    const t1 = await seedThread(fixture, { roomId: '00000000-0000-4000-8000-00000000ee01' });
    const t2 = await seedThread(fixture, { roomId: '00000000-0000-4000-8000-00000000ee02' });
    const t3 = await seedThread(fixture, { roomId: '00000000-0000-4000-8000-00000000ee03' });
    const body = 'A perfectly ordinary cross-posted note about the topic at hand.';
    const mk = (threadId: string) =>
      contributionCreateSchema.parse({ ...contributionBody('explanation', threadId), body });
    const r1 = await post(mk(t1.threadId));
    expect(r1.ok && r1.contribution.moderationState).toBe('published');
    // The 2nd identical post across a 2nd room must NOT yet be a flood — the
    // off-by-one bug (counting the just-recorded submission twice) flagged here.
    const r2 = await post(mk(t2.threadId));
    expect(r2.ok && r2.contribution.moderationState).toBe('published');
    // The 3rd (3 similar across 2+ rooms in the window) IS flagged for review.
    const r3 = await post(mk(t3.threadId));
    expect(r3.ok && r3.contribution.moderationState).toBe('under_review');
  });

  it('A1: same-room cross-thread reposts are NOT cross-room flooding', async () => {
    // Three threads in ONE room (the WS-Q default): the flood detector keys off
    // the real home room, so distinctRooms stays 1 (< duplicateFloodMinRooms) and
    // even the 3rd identical post is published.  The pre-fix bug keyed off the
    // thread id, reading three threads as three rooms and flagging the 3rd.
    const ROOM = '00000000-0000-4000-8000-00000000ee0f';
    const t1 = await seedThread(fixture, { roomId: ROOM });
    const t2 = await seedThread(fixture, { roomId: ROOM });
    const t3 = await seedThread(fixture, { roomId: ROOM });
    const body = 'A perfectly ordinary same-room note repeated across threads.';
    const mk = (threadId: string) =>
      contributionCreateSchema.parse({ ...contributionBody('explanation', threadId), body });
    for (const t of [t1, t2, t3]) {
      const r = await post(mk(t.threadId));
      expect(r.ok && r.contribution.moderationState).toBe('published');
    }
  });
});

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
});

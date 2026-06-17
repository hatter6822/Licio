// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-J.1.2 enforcement: block is API-enforced (a blocked user cannot reply) and
// bilateral viewing is filtered (neither party sees the other's content in
// thread reads) — wired through the forum relationship-reader seam.
import { contributionCreateSchema } from '@licio/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createContribution } from '../forum/contributions.js';
import { resetForumServicesForTests } from '../forum/services.js';
import { branchContent } from '../forum/threads.js';
import { createBlock, createMute, createRelationshipReader } from '../moderation/relations.js';
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

const A = '00000000-0000-4000-8000-0000000000a1';
const B = '00000000-0000-4000-8000-0000000000b2';
const C = '00000000-0000-4000-8000-0000000000c3';
const resolveAuthor = async (userId: string | null) =>
  userId ? { handle: `u_${userId.slice(0, 4)}`, displayName: 'U' } : null;

let fixture: ForumServicesFixture;
let mod: ModerationServices;

beforeEach(() => {
  fixture = freshForumServices();
  mod = createInMemoryModerationServices();
  // The single wiring point — forum reads this for both enforcement paths.
  fixture.forum.relationshipReader = createRelationshipReader(mod);
});
afterEach(async () => {
  await fixture.settleAll();
  resetForumServicesForTests();
});

function bundle() {
  return { forum: fixture.forum, ingestion: fixture.ingestion, events: fixture.events };
}

async function post(userId: string, body: Record<string, unknown>) {
  return createContribution(
    bundle(),
    userId,
    `acct-${userId}`,
    contributionCreateSchema.parse(body),
  );
}

describe('WS-J.1.2 block enforcement', () => {
  it('rejects a reply from a blocked user (interaction_blocked) — bilaterally', async () => {
    const { threadId } = await seedThread(fixture, { submittedBy: A });
    const parent = await post(A, contributionBody('question', threadId));
    if (!parent.ok) throw new Error('parent create failed');

    await createBlock(mod, A, B); // A blocks B

    // B → reply to A's question is rejected server-side.
    const reply = await post(
      B,
      contributionBody('answer', threadId, { parentId: parent.contribution.contributionId }),
    );
    expect(reply.ok).toBe(false);
    expect(!reply.ok && reply.rejection.code).toBe('interaction_blocked');
    expect(!reply.ok && reply.rejection.status).toBe(403);

    // Bilateral: A → reply to a B-authored question is ALSO rejected.  B's
    // question lives in a NEUTRAL thread (owner C) — A does not own it, so B may
    // post there; A replying to it is the blocked (bilateral) interaction.
    const neutral = await seedThread(fixture, { submittedBy: C });
    const bQuestion = await post(B, contributionBody('question', neutral.threadId));
    if (!bQuestion.ok) throw new Error('B question failed');
    const aReply = await post(
      A,
      contributionBody('answer', neutral.threadId, {
        parentId: bQuestion.contribution.contributionId,
      }),
    );
    expect(aReply.ok).toBe(false);
    expect(!aReply.ok && aReply.rejection.code).toBe('interaction_blocked');
  });

  it('#11 rejects a TOP-LEVEL post from a user blocked by the story owner', async () => {
    const { threadId } = await seedThread(fixture, { submittedBy: A });
    await createBlock(mod, A, B); // A owns the story and blocks B
    // B posts top-level (no parent) in A's thread → rejected server-side.
    const top = await post(B, contributionBody('question', threadId));
    expect(top.ok).toBe(false);
    expect(!top.ok && top.rejection.code).toBe('interaction_blocked');
    // The owner is never blocked from their own thread (self).
    const own = await post(A, contributionBody('question', threadId));
    expect(own.ok).toBe(true);
  });

  it('allows replies once unblocked', async () => {
    const { threadId } = await seedThread(fixture, { submittedBy: A });
    const parent = await post(A, contributionBody('question', threadId));
    if (!parent.ok) throw new Error('parent failed');
    const block = await createBlock(mod, A, B);
    await mod.blocks.delete(block.block_id, A); // unblock
    const reply = await post(
      B,
      contributionBody('answer', threadId, { parentId: parent.contribution.contributionId }),
    );
    expect(reply.ok).toBe(true);
  });
});

describe('WS-J.1.2 viewing filter (thread reads)', () => {
  it('hides a blocked/muted author content from the viewer, bilaterally', async () => {
    const { threadId } = await seedThread(fixture, { submittedBy: A });
    const aq = await post(A, contributionBody('question', threadId));
    const bq = await post(B, contributionBody('question', threadId));
    if (!aq.ok || !bq.ok) throw new Error('seed questions failed');

    await createBlock(mod, A, B);

    // A views the questions branch → sees own question, NOT B's.
    const aView = await branchContent(bundle(), threadId, 'questions', A, resolveAuthor, null);
    const aIds = aView.contributions.map((c) => c.contribution_id);
    expect(aIds).toContain(aq.contribution.contributionId);
    expect(aIds).not.toContain(bq.contribution.contributionId);

    // B views → sees own question, NOT A's (bilateral).
    const bView = await branchContent(bundle(), threadId, 'questions', B, resolveAuthor, null);
    const bIds = bView.contributions.map((c) => c.contribution_id);
    expect(bIds).toContain(bq.contribution.contributionId);
    expect(bIds).not.toContain(aq.contribution.contributionId);

    // A signed-out / third party sees both.
    const anon = await branchContent(bundle(), threadId, 'questions', null, resolveAuthor, null);
    expect(anon.contributions).toHaveLength(2);
  });

  it('a mute hides the muted author content one-directionally', async () => {
    const { threadId } = await seedThread(fixture, { submittedBy: A });
    const bq = await post(B, contributionBody('question', threadId));
    if (!bq.ok) throw new Error('seed failed');
    await createMute(mod, A, B, undefined);
    const aView = await branchContent(bundle(), threadId, 'questions', A, resolveAuthor, null);
    expect(aView.contributions.map((c) => c.contribution_id)).not.toContain(
      bq.contribution.contributionId,
    );
    // B is unaffected — sees their own content.
    const bView = await branchContent(bundle(), threadId, 'questions', B, resolveAuthor, null);
    expect(bView.contributions.map((c) => c.contribution_id)).toContain(
      bq.contribution.contributionId,
    );
  });
});

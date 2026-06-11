// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-G §15.5 edit/removal + create-guard edge coverage (service level):
// locked-state edits, per-type body caps on edit, correction citation
// bounds, idempotent removal, attachment guards, and lens validation.
import { randomUUID } from 'node:crypto';
import type { ContributionCreate } from '@licio/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  createContribution,
  editContribution,
  removeContribution,
} from '../forum/contributions.js';
import {
  contributionBody,
  freshWsGServices,
  seedClaim,
  seedThread,
  seedUserWithSession,
  type WsGFixture,
} from './ws-g-helpers.js';

let fixture: WsGFixture;
let userId: string;
let threadId: string;

beforeEach(async () => {
  fixture = freshWsGServices({ forumConfig: { contributionsPerMinute: 100 } });
  const session = await seedUserWithSession(fixture.identity);
  userId = session.userId;
  ({ threadId } = await seedThread(fixture));
});

function bundle() {
  return { forum: fixture.forum, ingestion: fixture.ingestion, events: fixture.events };
}

async function createDirect(body: Record<string, unknown>) {
  const outcome = await createContribution(
    bundle(),
    userId,
    `ref-${userId}`,
    body as unknown as ContributionCreate,
  );
  if (!outcome.ok) throw new Error(`create failed: ${JSON.stringify(outcome.rejection)}`);
  return outcome.contribution;
}

describe('edit/remove edges (§15.5)', () => {
  it('rejects edits to removed/hidden contributions (409) and unknown ids (404)', async () => {
    const created = await createDirect(contributionBody('question', threadId));
    await fixture.forum.contributions.setModerationState(created.contributionId, 'removed');
    const locked = await editContribution(bundle(), userId, created.contributionId, {
      contribution_id: created.contributionId,
      body: 'rewrite',
    });
    expect(locked.ok).toBe(false);
    if (!locked.ok) expect(locked.rejection.status).toBe(409);

    const missing = await editContribution(bundle(), userId, randomUUID(), {
      contribution_id: randomUUID(),
      body: 'x',
    });
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.rejection.status).toBe(404);
  });

  it('enforces the per-type body cap on edits (422)', async () => {
    const created = await createDirect(contributionBody('question', threadId));
    const tooLong = await editContribution(bundle(), userId, created.contributionId, {
      contribution_id: created.contributionId,
      body: 'q'.repeat(2_001),
    });
    expect(tooLong.ok).toBe(false);
    if (!tooLong.ok) expect(tooLong.rejection.code).toBe('body_too_long');
  });

  it('keeps correction citation bounds across edits (1..5)', async () => {
    const claimId = await seedClaim(fixture);
    const created = await createDirect(contributionBody('correction', threadId, { claimId }));
    const citation = { url: 'https://example.org/x' };
    const tooMany = await editContribution(bundle(), userId, created.contributionId, {
      contribution_id: created.contributionId,
      citations: Array.from({ length: 6 }, () => citation),
    });
    expect(tooMany.ok).toBe(false);
    const none = await editContribution(bundle(), userId, created.contributionId, {
      contribution_id: created.contributionId,
      citations: [],
    });
    expect(none.ok).toBe(false);
    const fine = await editContribution(bundle(), userId, created.contributionId, {
      contribution_id: created.contributionId,
      citations: [citation, citation],
    });
    expect(fine.ok).toBe(true);
  });

  it('removal is idempotent and 404s for non-authors/unknown ids', async () => {
    const created = await createDirect(contributionBody('question', threadId));
    const first = await removeContribution(bundle(), userId, created.contributionId);
    expect(first.ok).toBe(true);
    const second = await removeContribution(bundle(), userId, created.contributionId);
    expect(second.ok).toBe(true); // idempotent
    const stranger = await removeContribution(bundle(), randomUUID(), created.contributionId);
    expect(stranger.ok).toBe(false);
    const unknown = await removeContribution(bundle(), userId, randomUUID());
    expect(unknown.ok).toBe(false);
  });
});

describe('create-guard edges', () => {
  it('rejects attachments that are missing, foreign, uncleaned, or alt-less', async () => {
    const foreign = await fixture.forum.uploads.put(
      {
        uploadId: randomUUID(),
        ownerUserId: randomUUID(), // someone else's upload
        contentType: 'image/jpeg',
        byteSize: 10,
        altText: 'x',
        storageRef: 'uploads/foreign',
        metadataStripped: true,
        scanState: 'clear',
      },
      new Uint8Array([1]),
    );
    const pending = await fixture.forum.uploads.put(
      {
        uploadId: randomUUID(),
        ownerUserId: userId,
        contentType: 'image/jpeg',
        byteSize: 10,
        altText: 'x',
        storageRef: 'uploads/pending',
        metadataStripped: true,
        scanState: 'pending',
      },
      new Uint8Array([1]),
    );
    const altless = await fixture.forum.uploads.put(
      {
        uploadId: randomUUID(),
        ownerUserId: userId,
        contentType: 'image/png',
        byteSize: 10,
        altText: null,
        storageRef: 'uploads/altless',
        metadataStripped: true,
        scanState: 'clear',
      },
      new Uint8Array([1]),
    );
    for (const [uploadId, code] of [
      [randomUUID(), 'invalid_attachment'],
      [foreign.uploadId, 'invalid_attachment'],
      [pending.uploadId, 'attachment_not_cleared'],
      [altless.uploadId, 'attachment_alt_required'],
    ] as const) {
      const outcome = await createContribution(bundle(), userId, `ref-${userId}`, {
        ...contributionBody('question', threadId),
        attachment_ids: [uploadId],
      } as unknown as ContributionCreate);
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) expect(outcome.rejection.code).toBe(code);
    }
  });

  it('rejects a lens from another room (422 invalid_lens)', async () => {
    const inserted = await fixture.forum.lenses.insert({
      lensId: randomUUID(),
      roomId: randomUUID(), // a room the thread does not belong to
      name: 'Elsewhere',
      lensType: 'expert',
      description: null,
    });
    expect(inserted.ok).toBe(true);
    if (!inserted.ok) return;
    const outcome = await createContribution(bundle(), userId, `ref-${userId}`, {
      ...contributionBody('question', threadId),
      lens_id: inserted.lens.lensId,
    } as unknown as ContributionCreate);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.rejection.code).toBe('invalid_lens');
  });

  it('belt-and-suspenders body cap fires for direct service callers', async () => {
    const outcome = await createContribution(bundle(), userId, `ref-${userId}`, {
      ...contributionBody('question', threadId),
      body: 'q'.repeat(2_001),
    } as unknown as ContributionCreate);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect([400, 422]).toContain(outcome.rejection.status);
  });

  it('thread 404 fires for an unknown thread id', async () => {
    const outcome = await createContribution(
      bundle(),
      userId,
      `ref-${userId}`,
      contributionBody('question', randomUUID()) as unknown as ContributionCreate,
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.rejection.status).toBe(404);
  });
});

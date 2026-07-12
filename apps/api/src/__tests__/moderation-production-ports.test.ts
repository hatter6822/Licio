// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-J production ports: removals actually propagate to the WS-E item-safety
// state (the ranking-exclusion seam) + the WS-G contribution state; account
// actions write the WS-D state; user resolution reads handle + account age;
// the evidence-queue cited reads gate on PUBLISHED and resolve story titles.
import { randomUUID } from 'node:crypto';
import type { ModerationCaseCreatedEvent } from '@licio/shared';
import { describe, expect, it, vi } from 'vitest';
import type { NewStoredEvent } from '../events/stores.js';
import { InMemoryItemSafetyStateStore } from '../events/stores.js';
import {
  type ContentPortDeps,
  type ContributionSnapshotInput,
  composeSnapshot,
  createCitedContributionReads,
  createProductionContentPort,
  createProductionEventPort,
  createProductionInvariantPort,
  createProductionUserPort,
  type InvariantOutputRead,
} from '../moderation/production-ports.js';
import { freshForumServices, seedThread } from './forum-test-helpers.js';

const STORY = '00000000-0000-4000-8000-00000000000a';
const CONTRIB = '00000000-0000-4000-8000-00000000000b';
const AUTHOR = '00000000-0000-4000-8000-00000000000c';

function contentDeps(over: Partial<ContentPortDeps> = {}): ContentPortDeps {
  return {
    safetyStore: new InMemoryItemSafetyStateStore(),
    getStory: async (id) =>
      id === STORY
        ? {
            submittedBy: AUTHOR,
            title: 'Reported story title',
            excerpt: 'Reported story excerpt.',
            createdAt: '2026-06-01T00:00:00.000Z',
          }
        : null,
    getContribution: async (id) => (id === CONTRIB ? { userId: AUTHOR } : null),
    setContributionModerationState: vi.fn(async () => undefined),
    setAccountState: vi.fn(async () => undefined),
    now: () => 1_700_000_000_000,
    ...over,
  };
}

describe('production content port', () => {
  it('resolves a story target to its submitter and a contribution to its author', async () => {
    const port = createProductionContentPort(contentDeps());
    expect(await port.resolveTarget('content', STORY)).toEqual({
      exists: true,
      subjectUserId: AUTHOR,
      contentKind: 'story',
    });
    expect(await port.resolveTarget('content', CONTRIB)).toEqual({
      exists: true,
      subjectUserId: AUTHOR,
      contentKind: 'contribution',
    });
    expect(await port.resolveTarget('account', AUTHOR)).toEqual({
      exists: true,
      subjectUserId: AUTHOR,
      contentKind: null,
    });
    expect(
      (await port.resolveTarget('content', '00000000-0000-4000-8000-0000000000ff')).exists,
    ).toBe(false);
  });

  it('#7 canUserReadContent delegates to the visibility gate (default readable)', async () => {
    // No gate dep ⇒ readable (the in-memory seam enforces no private rooms).
    const open = createProductionContentPort(contentDeps());
    expect(await open.canUserReadContent?.(STORY, 'story', AUTHOR)).toBe(true);
    // A denying gate ⇒ not readable (the report intake then 404s).
    const denied = createProductionContentPort(
      contentDeps({ isContentReadable: async () => false }),
    );
    expect(await denied.canUserReadContent?.(STORY, 'story', AUTHOR)).toBe(false);
    // An allowing gate ⇒ readable, with the target/kind/requester forwarded.
    const calls: Array<[string, string | null, string]> = [];
    const allowed = createProductionContentPort(
      contentDeps({
        isContentReadable: async (id, kind, uid) => {
          calls.push([id, kind, uid]);
          return true;
        },
      }),
    );
    expect(await allowed.canUserReadContent?.(CONTRIB, 'contribution', AUTHOR)).toBe(true);
    expect(calls).toEqual([[CONTRIB, 'contribution', AUTHOR]]);
  });

  it('removal writes the WS-E item-safety state to removed (the ranking seam)', async () => {
    const safetyStore = new InMemoryItemSafetyStateStore();
    const setState = vi.fn(async () => undefined);
    const port = createProductionContentPort(
      contentDeps({ safetyStore, setContributionModerationState: setState }),
    );
    await port.applyContentState(STORY, 'story', 'removed', 'case-1', 'mod-1');
    expect((await safetyStore.get(STORY))?.safetyState).toBe('removed');

    await port.applyContentState(CONTRIB, 'contribution', 'hidden', null, 'mod-1');
    expect((await safetyStore.get(CONTRIB))?.safetyState).toBe('removed'); // hidden also excludes
    expect(setState).toHaveBeenCalledWith(CONTRIB, 'hidden');

    // A revert restores the item to normal.
    await port.applyContentState(STORY, 'story', 'visible', 'case-1', 'mod-1');
    expect((await safetyStore.get(STORY))?.safetyState).toBe('normal');
  });

  it('#9 a story hide/removal also sets the canonical hiddenState (gone from direct reads)', async () => {
    const setStoryHiddenState = vi.fn(async () => undefined);
    const port = createProductionContentPort(contentDeps({ setStoryHiddenState }));
    await port.applyContentState(STORY, 'story', 'removed', 'case-1', 'mod-1');
    expect(setStoryHiddenState).toHaveBeenCalledWith(STORY, 'safety');
    await port.applyContentState(STORY, 'story', 'hidden', 'case-1', 'mod-1');
    expect(setStoryHiddenState).toHaveBeenCalledWith(STORY, 'safety');
    // Restoring the story lifts the moderation hide.
    await port.applyContentState(STORY, 'story', 'visible', 'case-1', 'mod-1');
    expect(setStoryHiddenState).toHaveBeenLastCalledWith(STORY, null);
  });

  it('#17 an account action against a nonexistent account resolves to not-found', async () => {
    const port = createProductionContentPort(
      contentDeps({ accountExists: async (id) => id === AUTHOR }),
    );
    expect((await port.resolveTarget('account', AUTHOR)).exists).toBe(true);
    expect(
      (await port.resolveTarget('account', '00000000-0000-4000-8000-0000000000ff')).exists,
    ).toBe(false);
  });

  it('#23 resolves a thread report target to its story owner (contentKind=thread)', async () => {
    const THREAD = '00000000-0000-4000-8000-0000000000dd';
    const port = createProductionContentPort(
      contentDeps({ getThread: async (id) => (id === THREAD ? { submittedBy: AUTHOR } : null) }),
    );
    expect(await port.resolveTarget('content', THREAD)).toEqual({
      exists: true,
      subjectUserId: AUTHOR,
      contentKind: 'thread',
    });
  });

  it('#8 a thread hide/removal writes the item-safety row (removed); a revert restores normal', async () => {
    const THREAD = '00000000-0000-4000-8000-0000000000dd';
    const safetyStore = new InMemoryItemSafetyStateStore();
    const port = createProductionContentPort(
      contentDeps({
        safetyStore,
        getThread: async (id) => (id === THREAD ? { submittedBy: AUTHOR } : null),
      }),
    );
    // The item-safety row is the SOLE moderation signal for a thread — the
    // thread's own safety_state (the WS-G review dimension) is never touched.
    await port.applyContentState(THREAD, 'thread', 'removed', 'case-1', 'mod-1');
    expect((await safetyStore.get(THREAD))?.safetyState).toBe('removed');
    await port.applyContentState(THREAD, 'thread', 'hidden', 'case-1', 'mod-1');
    expect((await safetyStore.get(THREAD))?.safetyState).toBe('removed'); // hidden also excludes
    // A revert clears it back to normal.
    await port.applyContentState(THREAD, 'thread', 'visible', 'case-1', 'mod-1');
    expect((await safetyStore.get(THREAD))?.safetyState).toBe('normal');
  });

  it('#8 a kind-less revert (null) clears the item-safety row', async () => {
    const THREAD = '00000000-0000-4000-8000-0000000000dd';
    const safetyStore = new InMemoryItemSafetyStateStore();
    const port = createProductionContentPort(
      contentDeps({
        safetyStore,
        getStory: async () => null,
        getContribution: async () => null,
        getThread: async (id) => (id === THREAD ? { submittedBy: AUTHOR } : null),
      }),
    );
    await port.applyContentState(THREAD, null, 'visible', null, 'mod-1');
    expect((await safetyStore.get(THREAD))?.safetyState).toBe('normal');
  });

  it('account action writes the coarse WS-D account state (restrict is its own state)', async () => {
    const setAccountState = vi.fn(async () => undefined);
    const port = createProductionContentPort(contentDeps({ setAccountState }));
    // A `restrict` is NOT collapsed to a suspension — it maps to `restricted`.
    await port.applyAccountState(AUTHOR, 'restricted', null);
    expect(setAccountState).toHaveBeenCalledWith(AUTHOR, 'restricted');
    // A ban's permanence lives in the action record; the coarse state is suspended.
    await port.applyAccountState(AUTHOR, 'banned', null);
    expect(setAccountState).toHaveBeenCalledWith(AUTHOR, 'suspended');
    await port.applyAccountState(AUTHOR, 'suspended', null);
    expect(setAccountState).toHaveBeenCalledWith(AUTHOR, 'suspended');
    await port.applyAccountState(AUTHOR, 'active', null);
    expect(setAccountState).toHaveBeenCalledWith(AUTHOR, 'active');
  });
});

describe('composeSnapshot (WS-J.2.2d side-by-side diff)', () => {
  const snap = (
    body: string,
    edits: ContributionSnapshotInput['edits'],
  ): ContributionSnapshotInput => ({
    body,
    createdAt: '2026-06-01T00:00:00.000Z',
    updatedAt: '2026-06-10T00:00:00.000Z',
    edits,
  });

  it('no post-report edit ⇒ original ≡ current, editedAfterReport=false', () => {
    const view = composeSnapshot(snap('current', []), '2026-06-05T00:00:00.000Z');
    expect(view).toEqual({
      originalBody: 'current',
      currentBody: 'current',
      originalAt: '2026-06-10T00:00:00.000Z',
      currentAt: '2026-06-10T00:00:00.000Z',
      editedAfterReport: false,
    });
  });

  it('an edit AFTER the report reconstructs the report-time body (edit-to-evade)', () => {
    // Reported at 06-05; edited at 06-08 (snapshotting the offending body).
    const view = composeSnapshot(
      snap('softened text', [
        { previousBody: 'offending text', editedAt: '2026-06-08T00:00:00.000Z' },
      ]),
      '2026-06-05T00:00:00.000Z',
    );
    expect(view.originalBody).toBe('offending text');
    expect(view.currentBody).toBe('softened text');
    expect(view.editedAfterReport).toBe(true);
    // originalAt falls back to createdAt (no pre-report edit).
    expect(view.originalAt).toBe('2026-06-01T00:00:00.000Z');
  });

  it('a pre-report edit sets originalAt to that edit; only post-report edits flag', () => {
    const view = composeSnapshot(
      snap('v3', [
        { previousBody: 'v1', editedAt: '2026-06-03T00:00:00.000Z' }, // before report
        { previousBody: 'v2', editedAt: '2026-06-08T00:00:00.000Z' }, // after report
      ]),
      '2026-06-05T00:00:00.000Z',
    );
    expect(view.originalBody).toBe('v2'); // body at report time = previous of first-after
    expect(view.originalAt).toBe('2026-06-03T00:00:00.000Z'); // last pre-report edit
    expect(view.editedAfterReport).toBe(true);
  });
});

describe('production content port — snapshot + thread context', () => {
  it('contentSnapshot composes from the edit-history dep (and is null without it)', async () => {
    const withDep = createProductionContentPort(
      contentDeps({
        getContributionSnapshot: async () => ({
          body: 'now',
          createdAt: '2026-06-01T00:00:00.000Z',
          updatedAt: '2026-06-09T00:00:00.000Z',
          edits: [{ previousBody: 'then', editedAt: '2026-06-08T00:00:00.000Z' }],
        }),
      }),
    );
    const view = await withDep.contentSnapshot(CONTRIB, '2026-06-05T00:00:00.000Z', 'contribution');
    expect(view?.originalBody).toBe('then');
    expect(view?.editedAfterReport).toBe(true);
    // Default deps (no snapshot dep) ⇒ null.
    expect(
      await createProductionContentPort(contentDeps()).contentSnapshot(
        CONTRIB,
        'x',
        'contribution',
      ),
    ).toBeNull();
    // A STORY target shows its title + excerpt (no editable body diff).
    const storyView = await withDep.contentSnapshot(STORY, '2026-06-05T00:00:00.000Z', 'story');
    expect(storyView?.currentBody).toContain('Reported story title');
    expect(storyView?.editedAfterReport).toBe(false);
  });

  it('threadContext passes through the projected dep (empty without it)', async () => {
    const item = { contribution_id: CONTRIB } as never;
    const withDep = createProductionContentPort(
      contentDeps({
        getThreadContext: async () => ({ items: [item], reportedContributionId: CONTRIB }),
      }),
    );
    expect(await withDep.threadContext(CONTRIB, 'contribution', AUTHOR)).toEqual({
      items: [item],
      reportedContributionId: CONTRIB,
    });
    expect(
      await createProductionContentPort(contentDeps()).threadContext(
        CONTRIB,
        'contribution',
        AUTHOR,
      ),
    ).toEqual({ items: [], reportedContributionId: null });

    // The contentKind is FORWARDED to the dep (story/thread reports resolve their
    // own thread there) — not ignored as before.
    let seenKind: string | null = 'unset';
    const capturing = createProductionContentPort(
      contentDeps({
        getThreadContext: async (_id, kind) => {
          seenKind = kind;
          return { items: [], reportedContributionId: null };
        },
      }),
    );
    await capturing.threadContext(STORY, 'story', AUTHOR);
    expect(seenKind).toBe('story');
  });
});

describe('production event port', () => {
  const CASE = '00000000-0000-4000-8000-00000000000d';
  const REPORTER = '00000000-0000-4000-8000-00000000000e';

  it('persists durably THEN publishes a valid moderation.case.created (restricted)', async () => {
    const persisted: NewStoredEvent[] = [];
    const published: ModerationCaseCreatedEvent[] = [];
    const port = createProductionEventPort({
      persist: async (e) => {
        // Publish must not have happened before the durable write.
        expect(published).toHaveLength(0);
        persisted.push(e);
      },
      publish: async (e) => {
        published.push(e);
      },
    });
    await port.caseCreated({
      caseId: CASE,
      targetType: 'content',
      contentKind: 'contribution',
      targetId: CONTRIB,
      reporterId: REPORTER,
      reasonCode: 'MOD_HARASS_001',
      severity: 'high',
      source: 'user_report',
      nowIso: '2026-06-16T00:00:00.000Z',
    });
    expect(persisted).toHaveLength(1);
    expect(published).toHaveLength(1);
    const stored = persisted[0];
    expect(stored?.topic).toBe('moderation.case.created');
    expect(stored?.privacyClassification).toBe('restricted');
    expect(stored?.retentionTier).toBe('moderation_legal');
    expect(stored?.ownerUserId).toBeNull(); // never DSAR-linked
    const event = published[0];
    expect(event?.target_type).toBe('contribution');
    expect(event?.reporter_id).toBe(REPORTER);
    expect(event?.case_id).toBe(CASE);
  });

  it('maps target/content-kind onto the event scale (account→user, story→story)', async () => {
    const published: ModerationCaseCreatedEvent[] = [];
    const port = createProductionEventPort({
      persist: async () => undefined,
      publish: async (e) => {
        published.push(e);
      },
    });
    await port.caseCreated({
      caseId: CASE,
      targetType: 'account',
      contentKind: null,
      targetId: AUTHOR,
      reporterId: null, // automated detection
      reasonCode: 'MOD_SPAM_001',
      severity: 'medium',
      source: 'automated',
      nowIso: '2026-06-16T00:00:00.000Z',
    });
    expect(published[0]?.target_type).toBe('user');
    expect(published[0]?.reporter_id).toBeNull();
    expect(published[0]?.source).toBe('automated');
  });
});

describe('production invariant port (WS-J.2.2c)', () => {
  const TARGET = '00000000-0000-4000-8000-00000000000a';
  const SUBJECT = '00000000-0000-4000-8000-00000000000c';

  function output(
    scoreVector: Record<string, unknown>,
    summary: string | null,
  ): InvariantOutputRead {
    return { scoreVector, explanationSummary: summary, coverage: 1, reasonCodes: [] };
  }

  it('maps WS-H outputs onto the four signals; MFCI detail is role-gated', async () => {
    const port = createProductionInvariantPort({
      mfciRiskState: async (id) =>
        id === TARGET ? { state: 'elevated', score: 0.91, reason: 'fiber p<0.01' } : null,
      latestOutput: async (type, id) => {
        if (type === 'SCOI' && id === TARGET)
          return output({ context_state: 'weaponized' }, 'Interpretations diverge sharply.');
        if (type === 'hodge_tension' && id === TARGET)
          return output(
            { label: 'structural-conflict', harmful_tension_risk: 0.4 },
            'Flow conflict.',
          );
        if (type === 'PHI' && id === SUBJECT) return output({ phi: 0.7 }, 'Frame rotated.');
        return null;
      },
    });
    // Community steward: state only, no coordination detail.
    const steward = await port.signalsFor('content', TARGET, SUBJECT, false);
    expect(steward.mfci).toEqual({ available: true, state: 'elevated', detail: null });
    expect(steward.scoi.state).toBe('weaponized');
    expect(steward.hodge.state).toBe('structural-conflict');
    expect(steward.phi.state).toBe('personalization-narrowing');
    expect(steward.disclaimer).toContain('do not determine outcomes');
    // Integrity analyst: MFCI detail present.
    const analyst = await port.signalsFor('content', TARGET, SUBJECT, true);
    expect(analyst.mfci.detail).toContain('fiber p<0.01');
    expect(analyst.mfci.detail).toContain('0.910');
  });

  it('surfaces "unavailable" (not zero) when an output is missing or degraded', async () => {
    const port = createProductionInvariantPort({
      mfciRiskState: async () => null,
      latestOutput: async () => null,
    });
    const panel = await port.signalsFor('account', SUBJECT, SUBJECT, true);
    expect(panel.mfci.available).toBe(false);
    expect(panel.scoi).toEqual({ available: false, state: null, detail: null });
    expect(panel.phi.available).toBe(false);
    expect(panel.hodge.available).toBe(false);
  });

  it('falls back to the subject account for MFCI when the target carries none', async () => {
    const port = createProductionInvariantPort({
      mfciRiskState: async (id) =>
        id === SUBJECT ? { state: 'high', score: 0.97, reason: 'account-level' } : null,
      latestOutput: async () => null,
    });
    const panel = await port.signalsFor('content', TARGET, SUBJECT, false);
    expect(panel.mfci).toEqual({ available: true, state: 'high', detail: null });
  });
});

describe('createCitedContributionReads (the evidence-queue reads over the REAL stores)', () => {
  it('serves only PUBLISHED cited rows and resolves the anchoring story title', async () => {
    const fixture = freshForumServices();
    const { storyId, threadId } = await seedThread(fixture, { title: 'Reservoir sampling audit' });
    const insert = async (over: {
      citations?: Array<{ url: string; title?: string }>;
      state?: 'published' | 'hidden';
    }): Promise<string> => {
      const outcome = await fixture.forum.contributions.insert({
        contributionId: randomUUID(),
        threadId,
        userId: randomUUID(),
        type: 'comment',
        body: 'A sourced comment for the evidence queue.',
        citations: over.citations ?? [],
        metadata: {},
        targetClaimId: null,
        parentContributionId: null,
        clientDraftId: `draft-${randomUUID()}`,
        path: [],
        moderationState: over.state ?? 'published',
      });
      if (!outcome.ok) throw new Error('cited-reads insert failed');
      return outcome.contribution.contributionId;
    };
    const citation = { url: 'https://example.org/registry', title: 'Registry' };
    const publishedCited = await insert({ citations: [citation] });
    const hiddenCited = await insert({ citations: [citation], state: 'hidden' });
    const citationless = await insert({});

    const reads = createCitedContributionReads({
      contributions: fixture.forum.contributions,
      stories: fixture.ingestion.stories,
    });
    // The list serves ONLY the published cited row, with the story resolved.
    const listed = await reads.listCitedContributions({ after: null, limit: 10 });
    expect(listed.map((row) => row.contributionId)).toEqual([publishedCited]);
    expect(listed[0]?.storyId).toBe(storyId);
    expect(listed[0]?.storyTitle).toBe('Reservoir sampling audit');
    expect(listed[0]?.citations).toEqual([citation]);
    expect(listed[0]?.bodyPreview).toBe('A sourced comment for the evidence queue.');
    // The single read projects the published row identically...
    const single = await reads.getCitedContribution(publishedCited);
    expect(single?.storyTitle).toBe('Reservoir sampling audit');
    expect(single?.threadId).toBe(threadId);
    // ...and the published-only gate nulls the hidden + citation-less rows.
    expect(await reads.getCitedContribution(hiddenCited)).toBeNull();
    expect(await reads.getCitedContribution(citationless)).toBeNull();
    expect(await reads.getCitedContribution(randomUUID())).toBeNull();
  });
});

describe('production user port', () => {
  it('resolves handle + account age (days) and batches', async () => {
    const nowMs = 1_700_000_000_000;
    const created = new Date(nowMs - 10 * 86_400_000).toISOString();
    const port = createProductionUserPort({
      getUser: async (id) =>
        id === AUTHOR ? { handle: 'alice', createdAt: created, accountState: 'active' } : null,
      getUsersByIds: async (ids) =>
        ids.includes(AUTHOR)
          ? [{ userId: AUTHOR, handle: 'alice', createdAt: created, accountState: 'active' }]
          : [],
      now: () => nowMs,
    });
    const resolved = await port.resolve(AUTHOR);
    expect(resolved?.handle).toBe('alice');
    expect(resolved?.accountAgeDays).toBe(10);
    expect(await port.resolve('00000000-0000-4000-8000-0000000000ff')).toBeNull();
    const many = await port.resolveMany([AUTHOR]);
    expect(many.get(AUTHOR)?.accountAgeDays).toBe(10);
  });

  it('resolve enriches with WS-J.2.2b stats; resolveMany stays metadata-only', async () => {
    const nowMs = 1_700_000_000_000;
    const created = new Date(nowMs - 5 * 86_400_000).toISOString();
    const port = createProductionUserPort({
      getUser: async () => ({ handle: 'bob', createdAt: created, accountState: 'active' }),
      getUsersByIds: async (ids) =>
        ids.map((id) => ({
          userId: id,
          handle: 'bob',
          createdAt: created,
          accountState: 'active',
        })),
      contributionStats: async () => ({
        count: 7,
        byType: { question: 4, explanation: 3 },
        roomsActiveIn: 2,
      }),
      now: () => nowMs,
    });
    const resolved = await port.resolve(AUTHOR);
    expect(resolved?.contributionCount).toBe(7);
    expect(resolved?.contributionTypes).toEqual({ question: 4, explanation: 3 });
    expect(resolved?.roomsActiveIn).toBe(2);
    // The batch path never pays for the per-subject stats.
    const many = await port.resolveMany([AUTHOR]);
    expect(many.get(AUTHOR)?.contributionCount).toBe(0);
  });
});

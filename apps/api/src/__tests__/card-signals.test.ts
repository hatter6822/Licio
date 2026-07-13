// SPDX-License-Identifier: AGPL-3.0-or-later
//
// SPEC §5.6 story-card signals — the shared batched derivation both the WS-I
// feed path and the story-detail read serve through. Proves the composition
// over the in-memory adapters: the sourced-comment count matches the comment
// section's "Sources" predicate, the corrections tally reads the WS-T dispute
// tags (published rows only) plus the LIVE comment arenas, story-target arenas
// are never double-reported into the tally, and stories without threads get
// the honest neutral signals.
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { InMemoryItemSafetyStateStore } from '../events/stores.js';
import { EMPTY_CARD_SIGNALS, storyCardSignals } from '../forum/card-signals.js';
import { type DebateArenaRecord, InMemoryDebateStore } from '../forum/debate-store.js';
import { type ContributionRecord, InMemoryContributionStore } from '../forum/stores.js';

const NOW = Date.parse('2026-07-13T00:00:00.000Z');

function makeStores() {
  return {
    contributions: new InMemoryContributionStore(() => NOW),
    debates: new InMemoryDebateStore(() => NOW),
    safety: new InMemoryItemSafetyStateStore(),
  };
}

async function insertRow(
  contributions: InMemoryContributionStore,
  threadId: string,
  over: Partial<Pick<ContributionRecord, 'type' | 'citations' | 'moderationState'>> = {},
): Promise<string> {
  const contributionId = randomUUID();
  const outcome = await contributions.insert({
    contributionId,
    threadId,
    userId: randomUUID(),
    type: 'comment',
    body: 'The dataset is public and matches the summary.',
    citations: [],
    metadata: {},
    targetClaimId: null,
    parentContributionId: null,
    clientDraftId: `draft-${contributionId}`,
    path: [],
    moderationState: 'published',
    ...over,
  });
  if (!outcome.ok) throw new Error('insert failed');
  return contributionId;
}

function arena(
  storyId: string,
  threadId: string,
  over: Partial<DebateArenaRecord> = {},
): Omit<DebateArenaRecord, 'createdAt' | 'updatedAt'> {
  return {
    debateId: randomUUID(),
    storyId,
    threadId,
    roomId: null,
    targetType: 'comment',
    targetContributionId: randomUUID(),
    challengerContributionId: randomUUID(),
    incumbentUserId: randomUUID(),
    challengerUserId: randomUUID(),
    state: 'open',
    positions: {
      incumbent: { summary: '', citations: [], updatedAt: null },
      challenger: {
        summary: 'The claim mislabels the peak day.',
        citations: [{ url: 'https://example.org/raw' }],
        updatedAt: new Date(NOW).toISOString(),
      },
    },
    editDeadlineAt: new Date(NOW + 23 * 3_600_000).toISOString(),
    resolveDueAt: new Date(NOW + 24 * 3_600_000).toISOString(),
    lockedAt: null,
    lockedContent: null,
    incumbentLastActiveAt: new Date(NOW).toISOString(),
    challengerLastActiveAt: new Date(NOW).toISOString(),
    verdict: null,
    winner: null,
    decidedBy: null,
    rationale: null,
    confidence: null,
    aiOutputId: null,
    verdictAt: null,
    overrideDeadlineAt: null,
    overriddenByUserId: null,
    overrideReason: null,
    resolvedAt: null,
    ...over,
  };
}

describe('storyCardSignals — the shared §5.6 derivation', () => {
  it('composes the sourced count, dispute tallies, and live comment arenas per story', async () => {
    const { contributions, debates, safety } = makeStores();
    const storyId = randomUUID();
    const threadId = randomUUID();
    const cite = [{ url: 'https://example.org/source' }];
    await insertRow(contributions, threadId, { citations: cite }); // sourced
    const validated = await insertRow(contributions, threadId); // upheld
    const incorrect = await insertRow(contributions, threadId, { citations: cite });
    await insertRow(contributions, threadId, { type: 'correction', citations: cite });
    const hidden = await insertRow(contributions, threadId, {
      citations: cite,
      moderationState: 'hidden',
    });
    await contributions.setDisputeStatus(validated, 'validated');
    await contributions.setDisputeStatus(incorrect, 'incorrect');
    // Published-only: a hidden row's citation AND dispute tag never count.
    await contributions.setDisputeStatus(hidden, 'incorrect');
    expect(await debates.open(arena(storyId, threadId))).not.toBeNull();

    const signals = await storyCardSignals(
      { contributions, debates },
      safety,
      new Map([[storyId, threadId]]),
    );
    expect(signals.get(storyId)).toEqual({
      // The incorrect row still carries its citation: the sourced predicate
      // and the dispute tags are orthogonal by design.
      sourced: 2,
      corrections: { active: 1, validated: 1, incorrect: 1 },
    });
  });

  it('excludes story-target and terminal arenas from the active tally', async () => {
    const { contributions, debates, safety } = makeStores();
    const storyId = randomUUID();
    const threadId = randomUUID();
    // A live STORY-target arena rides dispute_status, not the tally.
    expect(
      await debates.open(
        arena(storyId, threadId, { targetType: 'story', targetContributionId: null }),
      ),
    ).not.toBeNull();
    // A resolved comment arena is history, not a live signal.
    expect(
      await debates.open(
        arena(storyId, threadId, {
          state: 'resolved',
          verdict: 'upheld',
          winner: 'incumbent',
          decidedBy: 'ai',
          resolvedAt: new Date(NOW).toISOString(),
        }),
      ),
    ).not.toBeNull();
    const signals = await storyCardSignals(
      { contributions, debates },
      safety,
      new Map([[storyId, threadId]]),
    );
    expect(signals.get(storyId)).toEqual(EMPTY_CARD_SIGNALS);
  });

  it('serves the honest neutral signals for a story with no thread', async () => {
    const { contributions, debates, safety } = makeStores();
    const storyId = randomUUID();
    const signals = await storyCardSignals(
      { contributions, debates },
      safety,
      new Map([[storyId, null]]),
    );
    expect(signals.get(storyId)).toBe(EMPTY_CARD_SIGNALS);
    expect(await storyCardSignals({ contributions, debates }, safety, new Map())).toEqual(
      new Map(),
    );
  });

  it('batches many stories in one pass — every requested id is present', async () => {
    const { contributions, debates, safety } = makeStores();
    const a = { storyId: randomUUID(), threadId: randomUUID() };
    const b = { storyId: randomUUID(), threadId: randomUUID() };
    await insertRow(contributions, a.threadId, {
      citations: [{ url: 'https://example.org/a' }],
    });
    expect(await debates.open(arena(b.storyId, b.threadId))).not.toBeNull();
    const signals = await storyCardSignals(
      { contributions, debates },
      safety,
      new Map([
        [a.storyId, a.threadId],
        [b.storyId, b.threadId],
      ]),
    );
    expect(signals.get(a.storyId)).toEqual({
      sourced: 1,
      corrections: { active: 0, validated: 0, incorrect: 0 },
    });
    expect(signals.get(b.storyId)).toEqual({
      sourced: 0,
      corrections: { active: 1, validated: 0, incorrect: 0 },
    });
  });

  it('serves the neutral signals for a moderation-REMOVED thread (WS-J #8)', async () => {
    // A removed thread is unreadable (threadReadableToUser): the card must not
    // advertise sources or corrections for a conversation the reader cannot
    // open — that would leak hidden-thread activity and disagree with the
    // comments surface (which 404s).
    const { contributions, debates, safety } = makeStores();
    const storyId = randomUUID();
    const threadId = randomUUID();
    await insertRow(contributions, threadId, { citations: [{ url: 'https://example.org/x' }] });
    const tagged = await insertRow(contributions, threadId);
    await contributions.setDisputeStatus(tagged, 'incorrect');
    expect(await debates.open(arena(storyId, threadId))).not.toBeNull();
    await safety.set({
      itemId: threadId,
      safetyState: 'removed',
      frozenScore: null,
      caseId: null,
      updatedBy: 'moderator',
      updatedAt: new Date(NOW).toISOString(),
    });
    const signals = await storyCardSignals(
      { contributions, debates },
      safety,
      new Map([[storyId, threadId]]),
    );
    expect(signals.get(storyId)).toEqual(EMPTY_CARD_SIGNALS);

    // The steward `restricted`-analogue (a FROZEN item row) keeps its honest
    // counts — only the terminal `removed` state suppresses them.
    const frozenStory = randomUUID();
    const frozenThread = randomUUID();
    await insertRow(contributions, frozenThread, { citations: [{ url: 'https://example.org/y' }] });
    await safety.set({
      itemId: frozenThread,
      safetyState: 'frozen',
      frozenScore: 1,
      caseId: null,
      updatedBy: 'moderator',
      updatedAt: new Date(NOW).toISOString(),
    });
    const frozenSignals = await storyCardSignals(
      { contributions, debates },
      safety,
      new Map([[frozenStory, frozenThread]]),
    );
    expect(frozenSignals.get(frozenStory)?.sourced).toBe(1);
  });
});

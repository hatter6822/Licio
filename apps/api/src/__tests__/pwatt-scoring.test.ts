// SPDX-License-Identifier: AGPL-3.0-or-later
//
// `pwatt/scoring.ts` read-shape guarantees: the window job resolves every
// actor's account ONCE per window (one batched read, no per-actor round trip),
// and the two actor keys that resolve to no account — the anonymity bucket and
// the deletion pseudonym — never reach the identity store at all.
import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ingestAttentionEvents } from '../events/ingest.js';
import type { NewStoredEvent } from '../events/stores.js';
import { PSEUDONYMOUS_USER_ID } from '../events/stores.js';
import { runPwattWindow } from '../pwatt/scoring.js';
import {
  attentionEvent,
  type EventServicesFixture,
  freshEventServices,
  seedUserWithSession,
} from './event-test-helpers.js';

let fixture: EventServicesFixture;

/** A fixed, complete window: [T0, T0 + 1h). */
const T0 = Date.UTC(2026, 5, 10, 10, 0, 0);
const IN_WINDOW = new Date(T0 + 10 * 60_000).toISOString();

beforeEach(() => {
  fixture = freshEventServices({ storyTitle: () => 'Water main study' });
});

/** A stored `contribution.created` row folding under `storyId`. */
function contributionRow(storyId: string, userId: string): NewStoredEvent {
  return {
    eventId: randomUUID(),
    eventType: 'contribution.created',
    topic: 'contribution.created',
    timestamp: IN_WINDOW,
    privacyClassification: 'public',
    retentionTier: 'public_contribution',
    payload: {
      event_id: randomUUID(),
      event_type: 'contribution.created',
      timestamp: IN_WINDOW,
      schema_version: '1',
      contribution_id: randomUUID(),
      thread_id: randomUUID(),
      story_id: storyId,
      user_id: userId,
      contribution_type: 'explanation',
      target_claim_id: null,
      parent_contribution_id: null,
      has_citation: false,
      accusation_flag: false,
      privacy_classification: 'public',
      retention_tier: 'public_contribution',
    },
    ownerUserId: userId,
    purgeAfter: null,
  };
}

async function ingestAttention(userId: string, storyId: string): Promise<void> {
  await ingestAttentionEvents(
    fixture.events,
    fixture.identity,
    userId,
    [attentionEvent(userId, { storyId, timestamp: IN_WINDOW })],
    { maxPastMs: Number.MAX_SAFE_INTEGER, maxFutureMs: Number.MAX_SAFE_INTEGER },
  );
}

describe('runPwattWindow identity reads (WS-E.2.1d ledger population)', () => {
  it('resolves every actor in ONE batch — never a point lookup per actor/item', async () => {
    // Three actors across two items: the pre-refactor shape did one `getUser`
    // for the trust factor AND one more inside the ledger loop, per actor PER
    // ITEM — six round trips here, 2 × actors × items in general.
    const actors = await Promise.all([
      seedUserWithSession(fixture.identity, { handle: 'scoreone' }),
      seedUserWithSession(fixture.identity, { handle: 'scoretwo' }),
      seedUserWithSession(fixture.identity, { handle: 'scorethree' }),
    ]);
    const storyA = randomUUID();
    const storyB = randomUUID();
    for (const actor of actors) {
      await ingestAttention(actor.userId, storyA);
      await ingestAttention(actor.userId, storyB);
    }

    const getUserSpy = vi.spyOn(fixture.identity.store, 'getUser');
    const getUsersByIdsSpy = vi.spyOn(fixture.identity.store, 'getUsersByIds');
    const report = await runPwattWindow(fixture.events, fixture.identity, T0, '1h');

    expect(report.itemsScored).toBe(2);
    expect(getUserSpy).not.toHaveBeenCalled();
    expect(getUsersByIdsSpy).toHaveBeenCalledTimes(1);
    expect(getUsersByIdsSpy.mock.calls[0]?.[0]).toHaveLength(3);
    // The batch is a REPLACEMENT, not an addition: every actor still gets the
    // ledger entry the per-actor read used to populate (one per item).
    for (const actor of actors) {
      expect((await fixture.events.ledgerStore.listForUser(actor.userId, 10)).entries).toHaveLength(
        2,
      );
    }
  });

  it('never asks the identity store about the deletion pseudonym', async () => {
    // A deleted account's retained events carry PSEUDONYMOUS_USER_ID as their
    // user id.  It is a well-formed UUID, so the ledger loop's old
    // privacy-bucket-only skip let it reach the database on every scored
    // window — a linkable-owner lookup for a key that can never resolve to one.
    const { userId } = await seedUserWithSession(fixture.identity, { handle: 'liveactor' });
    const storyId = randomUUID();
    await ingestAttention(userId, storyId);
    await fixture.events.eventStore.insertMany([contributionRow(storyId, PSEUDONYMOUS_USER_ID)]);

    const getUserSpy = vi.spyOn(fixture.identity.store, 'getUser');
    const getUsersByIdsSpy = vi.spyOn(fixture.identity.store, 'getUsersByIds');
    await runPwattWindow(fixture.events, fixture.identity, T0, '1h');

    expect(getUserSpy).not.toHaveBeenCalled();
    expect(getUsersByIdsSpy).toHaveBeenCalledTimes(1);
    expect(getUsersByIdsSpy.mock.calls[0]?.[0]).toEqual([userId]);
    expect(
      (await fixture.events.ledgerStore.listForUser(PSEUDONYMOUS_USER_ID, 10)).entries,
    ).toHaveLength(0);
  });
});

// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Proves the DEVELOPMENT seed showcase actually works end-to-end, through the
// production read paths: the named test accounts are login-ready, the front
// page shows the full variety of §5.6 rating labels (not a monotone "Getting
// Attention"), MERI exposure labels and the SCOI divergence data surface, and
// the owner-scoped Signal Ledger is non-empty for each test account. This is
// the regression guard for "every story said Getting Attention" / "reading
// signals were empty".
import type { RatingLabelKind } from '@licio/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import { userMayPostTopLevel } from '../forum/rooms.js';
import { GLOBAL_FEED_TARGET_ID } from '../invariants/services-impl.js';
import {
  DEV_ACCOUNTS,
  SEED_USER,
  seedForumDemoData,
  seedOperationalSignals,
} from '../lib/demo-seed.js';
import { serveFeed } from '../ranking/service.js';
import { freshRankingServices, type RankingFixture } from './ranking-helpers.js';

/** Reconstruct the stable demo story-id factory (pinned by the seed contract). */
const S = (n: number): string => `5f5e1000-0000-4000-8000-${String(n).padStart(12, '0')}`;

let fx: RankingFixture;

beforeEach(async () => {
  fx = freshRankingServices();
  await seedForumDemoData(fx.forum, fx.ingestion, fx.identity.store);
  await seedOperationalSignals(fx.events, fx.invariants, fx.identity, fx.ingestion);
});

/** Page the front-page feed to exhaustion, returning every served item. */
async function fullFrontPage(): Promise<Awaited<ReturnType<typeof serveFeed>>['items']> {
  const items: Awaited<ReturnType<typeof serveFeed>>['items'] = [];
  let cursor: string | null = null;
  for (let page = 0; page < 30; page += 1) {
    const served = await serveFeed(fx.ranking, {
      userId: null,
      surface: 'front_page',
      surfaceRoomId: null,
      surfaceTopicId: null,
      mode: undefined,
      cursor,
    });
    items.push(...served.items);
    if (served.nextCursor === null) break;
    cursor = served.nextCursor;
  }
  return items;
}

describe('demo seed — development test accounts', () => {
  it('seeds login-ready admin / steward / expert accounts with the right roles', async () => {
    const byEmail = Object.fromEntries(
      await Promise.all(
        DEV_ACCOUNTS.map(async (a) => [a.email, await fx.identity.store.getUserByEmail(a.email)]),
      ),
    );
    const admin = byEmail['admin@licio.test'];
    const steward = byEmail['steward@licio.test'];
    const expert = byEmail['expert@licio.test'];
    expect(admin?.roles).toContain('admin');
    expect(steward?.roles).toContain('steward');
    expect(expert?.accountState).toBe('active');
    // The email factor is verified so verified-only surfaces work on first login.
    for (const account of DEV_ACCOUNTS) {
      expect((await fx.identity.store.getAuth(account.userId))?.emailVerified).toBe(true);
    }
  });

  it('gives the expert the platform role so it can post in the expert-gated room', async () => {
    // R(6) is the Open Science room (experts_and_stewards posting policy).
    const r6 = '5f5e3000-0000-4000-8000-000000000006';
    const room = await fx.forum.rooms.getById(r6);
    const expert = await fx.identity.store.getUserByEmail('expert@licio.test');
    expect(expert?.roles).toContain('expert');
    if (!room || !expert) throw new Error('seed missing expert/room');
    // The expert may post top-level there via the role; a plain user may not.
    expect(await userMayPostTopLevel(fx.forum, room, expert.userId, expert.roles)).toBe(true);
    expect(await userMayPostTopLevel(fx.forum, room, SEED_USER.userId, ['user'])).toBe(false);
  });
});

describe('demo seed — the feed shows every rating label', () => {
  it('serves a varied set of labels, not a monotone "Getting Attention"', async () => {
    const items = await fullFrontPage();
    const labels = new Set<RatingLabelKind>(items.map((i) => i.rating_label));
    // The seeded public corpus exercises all seven §5.6 labels.
    const expected: RatingLabelKind[] = [
      'getting-attention',
      'deepening',
      'well-sourced',
      'needs-context',
      'under-review',
      'resolved-context',
      'bridge-active',
    ];
    for (const label of expected) expect(labels).toContain(label);
    // And it is genuinely varied (the bug was a single label across all items).
    expect(labels.size).toBeGreaterThanOrEqual(6);
  });

  it('labels the evidence-rich, MERI-independent stories "Well-Sourced"', async () => {
    const items = await fullFrontPage();
    const wellSourced = items.filter((i) => i.rating_label === 'well-sourced');
    const ids = new Set(wellSourced.map((i) => i.story_id));
    // S1 (water dataset), S13 (soil-carbon), S22 (aquifer multi-lab).
    expect(ids.has(S(1))).toBe(true);
    expect(ids.has(S(13)) || ids.has(S(22))).toBe(true);
  });

  it('carries COMPUTED MERI exposure labels (honest source-independence signal)', async () => {
    const items = await fullFrontPage();
    const byId = new Map(items.map((i) => [i.story_id, i]));
    // The well-sourced stories are MERI-independent on the feed (real batch).
    expect(byId.get(S(1))?.exposure_label).toBe('independent_source');
    expect(byId.get(S(22))?.exposure_label).toBe('independent_source');
    // A verbatim repost (S25 ≡ S21) is a DUPLICATE exposure, not a fresh one —
    // redundancy never inflates exposure (§7.1). Asserted on the COMPUTED MERI
    // output (the ranking pipeline folds the duplicate into "more on this story").
    const meri = await fx.events.invariantStore.latest('MERI', GLOBAL_FEED_TARGET_ID);
    const gains = meri?.scoreVector['marginal_gains'] as Record<string, number>;
    expect(gains[S(25)] ?? 1).toBeLessThan(gains[S(21)] ?? 1);
    expect(Object.values(gains).some((g) => g <= 0)).toBe(true);
  });

  it('surfaces the coordination-review story as Under Review (descriptive)', async () => {
    const items = await fullFrontPage();
    const s19 = items.find((i) => i.story_id === S(19));
    expect(s19?.rating_label).toBe('under-review');
    expect(s19?.safety_state).toBe('under-review');
  });
});

describe('demo seed — SCOI divergence + reading signals', () => {
  it('computes a SCOI output for the tariff story with divergent lens overlap energy', async () => {
    const scoi = await fx.events.invariantStore.latest('SCOI', S(10));
    expect(scoi).not.toBeNull();
    // The skeptical vs industry lenses read S10 differently → a NON-coherent
    // context state computed from their contributions' embeddings.
    expect(['ambiguous', 'split', 'obstructed', 'weaponized']).toContain(
      scoi?.scoreVector['context_state'],
    );
    expect(scoi?.scoreVector['scoi'] as number).toBeGreaterThan(0);
    const overlaps = scoi?.scoreVector['per_overlap_energy'] as Record<string, number>;
    expect(Object.values(overlaps).some((energy) => energy > 0)).toBe(true);
    expect(scoi?.reasonCodes).not.toContain('INSUFFICIENT_COVERAGE');
    // It is a real computation, never the degraded fallback envelope.
    expect(scoi?.fallbackUsed).toBe(false);
  });

  it('computes a feed-level MERI output the exposure reads resolve against', async () => {
    const meri = await fx.events.invariantStore.latest('MERI', GLOBAL_FEED_TARGET_ID);
    expect(meri).not.toBeNull();
    // A real computation (never the fallback): the well-sourced story is
    // independent. Coverage is honestly limited because most demo stories are
    // briefs/questions without full source/claim/evidence metadata — graceful
    // degradation, not a failure (the exposure signal is still computed).
    expect(meri?.fallbackUsed).toBe(false);
    const gains = meri?.scoreVector['marginal_gains'] as Record<string, number>;
    expect(gains[S(1)]).toBeGreaterThanOrEqual(1);
  });

  it('produces the owner-scoped Signal Ledger via the REAL PWAtt scorer', async () => {
    for (const account of [...DEV_ACCOUNTS]) {
      const page = await fx.events.ledgerStore.listForUser(account.userId, 50);
      expect(page.entries.length).toBeGreaterThan(0);
      // Owner isolation: every entry belongs to the requesting account only.
      expect(page.entries.every((e) => e.ownerUserId === account.userId)).toBe(true);
    }
  });
});

describe('demo seed — media + moderation surfaces', () => {
  it('seeds a native image post the media-rendering surface can serve', async () => {
    const media = (await fullFrontPage()).find((i) => i.media?.kind === 'image');
    expect(media).toBeDefined();
    expect(media?.media?.alt_text).toBeTruthy(); // accessibility text present
    // The bytes are actually stored, so /v1/uploads serves real content.
    const bytes = await fx.forum.uploads.getBytes('5f5ec000-0000-4000-8000-000000000001');
    expect(bytes?.byteLength ?? 0).toBeGreaterThan(0);
  });

  it('seeds pending moderation items for the steward/admin review queue', async () => {
    const pending = await fx.ingestion.reviewQueue.list({ status: 'pending' }, 50);
    expect(pending.length).toBeGreaterThanOrEqual(2);
    expect(pending.every((r) => r.kind === 'moderation_concern')).toBe(true);
  });
});

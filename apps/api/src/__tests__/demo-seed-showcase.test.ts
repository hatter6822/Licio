// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Proves the DEVELOPMENT seed showcase actually works end-to-end, through the
// production read paths: the named test accounts are login-ready, the front
// page shows the full variety of §5.6 rating labels (not a monotone "Getting
// Attention"), MERI exposure labels and the SCOI divergence data surface, and
// the owner-scoped Signal Ledger is non-empty for each test account. This is
// the regression guard for "every story said Getting Attention" / "reading
// signals were empty".
import {
  handleSchema,
  type RatingLabelKind,
  type ThreadListResponse,
  threadListResponseSchema,
} from '@licio/shared';
import { Hono } from 'hono';
import { beforeEach, describe, expect, it } from 'vitest';
import { userMayPostTopLevel } from '../forum/rooms.js';
import { createGovernanceService } from '../governance/services.js';
import { createInMemoryGovernanceStores } from '../governance/stores.js';
import { GLOBAL_FEED_TARGET_ID } from '../invariants/services-impl.js';
import {
  DEV_ACCOUNTS,
  GOVERNANCE_DEMO_ROOM_ID,
  SEED_USER,
  seedForumDemoData,
  seedGovernanceDemo,
  seedOperationalSignals,
} from '../lib/demo-seed.js';
import { serveFeed } from '../ranking/service.js';
import { createV1Routes } from '../routes/v1.js';
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

  it('every login-able account has a SCHEMA-VALID handle (guards the OTP-login 500 bug)', async () => {
    // The seed writes the store directly, bypassing registration's handle
    // validation; an invalid handle only fails when the account signs in (the
    // session response re-validates the user). Assert each is valid up front.
    for (const account of DEV_ACCOUNTS) {
      const user = await fx.identity.store.getUserByEmail(account.email);
      expect(user).not.toBeNull();
      expect(() => handleSchema.parse(user?.handle)).not.toThrow();
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
  it('serves a varied set of labels, not a monotone default', async () => {
    const items = await fullFrontPage();
    const labels = new Set<RatingLabelKind>(items.map((i) => i.rating_label));
    // The seeded public corpus exercises the live-signal §5.6 labels plus the
    // neutral "New" floor (a story with no active-reading signal — the honest
    // default; §5.6 gates "Getting Attention" on a real attention signal, so a
    // plain-attention-only story is proven reachable by the shared unit test).
    const expected: RatingLabelKind[] = [
      'new',
      'deepening',
      'needs-context',
      'under-review',
      'resolved-context',
      'bridge-active',
    ];
    for (const label of expected) expect(labels).toContain(label);
    // And it is genuinely varied (the bug was a single label across all items).
    expect(labels.size).toBeGreaterThanOrEqual(6);
  });

  it('labels the sourced-discussion showcase stories "Deepening"', async () => {
    const items = await fullFrontPage();
    const deepening = items.filter((i) => i.rating_label === 'deepening');
    const ids = new Set(deepening.map((i) => i.story_id));
    // S1 (water dataset), S13 (soil-carbon), S22 (aquifer multi-lab) — the
    // former Well-Sourced showcase trio: lifecycle `deepening` with sourced
    // comments, read through the comment-centric §5.6 cascade.
    expect(ids.has(S(1))).toBe(true);
    expect(ids.has(S(13))).toBe(true);
    expect(ids.has(S(22))).toBe(true);
  });

  it('computes MERI source-independence gains (the honest signal; no user-facing label)', async () => {
    // The MERI exposure LABEL is no longer a user-facing wire field; the COMPUTED
    // source-independence signal still drives ranking.
    const meri = await fx.events.invariantStore.latest('MERI', GLOBAL_FEED_TARGET_ID);
    const gains = meri?.scoreVector['marginal_gains'] as Record<string, number>;
    // Evidence groups derive from the CITATION DOMAINS of each story thread's
    // published contributions: every seeded sourced comment cites example.org,
    // so the shared-domain lineage group exists under the `cit:<host>` token.
    const groups = meri?.scoreVector['group_ids'] as string[];
    expect(groups).toContain('evidence_lineage:cit:example.org');
    // The shared citation domain FOLDS the showcase trio (S1, S13, S22): the
    // per-class bound caps how many of one lineage group count as independent
    // exposure, so they are never ALL independent.  WHICH members win is an
    // order-dependent tiebreak, so assert the order-INDEPENDENT invariant.
    const trio = [gains[S(1)] ?? 0, gains[S(13)] ?? 0, gains[S(22)] ?? 0];
    expect(trio.filter((g) => g > 0).length).toBeLessThanOrEqual(2);
    // A verbatim repost (S25 ≡ S21) is a DUPLICATE exposure, not a fresh one —
    // redundancy never inflates exposure (§7.1); WHICH of the two MERI designates
    // the first-seen (full-gain) member vs the folded duplicate is not stable
    // across runs (equal MinHash signatures → an order-dependent tiebreak), so
    // assert the order-INDEPENDENT invariant rather than a specific member:
    // they are never both independent, and a folded (non-positive) gain is present.
    const g21 = gains[S(21)] ?? 0;
    const g25 = gains[S(25)] ?? 0;
    expect(g21 > 0 && g25 > 0).toBe(false);
    expect(Object.values(gains).some((g) => g <= 0)).toBe(true);
    // The batch still designates SOME independent exposure (never all-folded).
    expect(Object.values(gains).some((g) => g >= 1)).toBe(true);
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
    // A real computation (never the fallback). Coverage is honestly limited
    // because most demo stories are briefs/questions without citation-bearing
    // discussion — graceful degradation, not a failure (the exposure signal is
    // still computed and the sourced showcase story resolves a gain entry).
    expect(meri?.fallbackUsed).toBe(false);
    const gains = meri?.scoreVector['marginal_gains'] as Record<string, number>;
    expect(typeof gains[S(1)]).toBe('number');
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

describe('demo seed — the story-detail read agrees with the feed', () => {
  /** Read a story through the real GET /v1/stories/:id route. */
  async function detail(storyId: string): Promise<{ rating_label: string; safety_state: string }> {
    const app = new Hono().route('/v1', createV1Routes());
    const res = await app.request(new Request(`http://localhost/v1/stories/${storyId}`));
    expect(res.status).toBe(200);
    return (await res.json()) as { rating_label: string; safety_state: string };
  }

  it('derives the same label on the detail route as on the feed (deepening, under-review)', async () => {
    const items = await fullFrontPage();
    const feedLabel = (id: string) => items.find((i) => i.story_id === id)?.rating_label;
    // The detail-route signal assembly (safety + lifecycle + SCOI divergence)
    // feeds the SAME shared cascade, so non-trivial labels match the feed.
    const s1 = await detail(S(1)); // lifecycle deepening + sourced discussion
    expect(s1.rating_label).toBe('deepening');
    expect(s1.rating_label).toBe(feedLabel(S(1)));

    const s19 = await detail(S(19)); // under coordination review
    expect(s19.rating_label).toBe('under-review');
    expect(s19.safety_state).toBe('under-review');
    expect(s19.rating_label).toBe(feedLabel(S(19)));
  });

  it('a freshly-submitted story with no signals reads "New" (the honest floor, §5.6)', async () => {
    // No live signals AND no active-reading signal ⇒ the neutral "New" floor,
    // never a false "Getting Attention" (which requires real attention).
    const s21 = await detail(S(21)); // submitted lifecycle, no live signals
    expect(s21.rating_label).toBe('new');
    const items = await fullFrontPage();
    expect(items.find((i) => i.story_id === S(21))?.rating_label).toBe('new'); // agrees
  });
});

describe('demo seed — every story has a readable, populated thread', () => {
  const app = new Hono().route('/v1', createV1Routes());

  /** The thread id a story-detail read resolves (the link the UI follows). */
  async function threadIdOf(storyId: string): Promise<string | null> {
    const res = await app.request(new Request(`http://localhost/v1/stories/${storyId}`));
    expect(res.status).toBe(200);
    return ((await res.json()) as { thread_id: string | null }).thread_id;
  }

  /** Read a thread overview through the real GET /v1/threads/:id route. */
  async function readThread(
    threadId: string,
  ): Promise<{ status: number; contributionCount: number }> {
    const res = await app.request(new Request(`http://localhost/v1/threads/${threadId}`));
    if (res.status !== 200) return { status: res.status, contributionCount: 0 };
    const body = (await res.json()) as { contribution_count: number };
    return { status: 200, contributionCount: body.contribution_count };
  }

  it('gives every public story the feed surfaces a thread with at least one contribution', async () => {
    const items = await fullFrontPage();
    expect(items.length).toBeGreaterThan(0);
    for (const item of items) {
      const threadId = await threadIdOf(item.story_id);
      expect(threadId, `story ${item.story_id} resolves a thread`).not.toBeNull();
      const thread = await readThread(threadId as string);
      expect(thread.status, `thread read for ${item.story_id}`).toBe(200);
      expect(
        thread.contributionCount,
        `discussion seeded for ${item.story_id} (${item.title})`,
      ).toBeGreaterThan(0);
    }
  });
});

describe('demo seed — the /threads directory surfaces the public conversations', () => {
  const app = new Hono().route('/v1', createV1Routes());

  /** Read the public thread directory through the real GET /v1/threads route. */
  async function directory(): Promise<ThreadListResponse> {
    const res = await app.request(new Request('http://localhost/v1/threads'));
    expect(res.status).toBe(200);
    return threadListResponseSchema.parse(await res.json());
  }

  it('lists public conversations whose threads each open (threads are visible to users)', async () => {
    const page = await directory();
    // The tab is NOT the old hardcoded empty state — the seeded corpus surfaces.
    expect(page.items.length).toBeGreaterThan(0);
    for (const t of page.items) {
      expect(t.title.length, 'a real story title').toBeGreaterThan(0);
      expect(t.contribution_count).toBeGreaterThanOrEqual(0);
      // Each listed conversation actually opens via the per-id overview.
      const res = await app.request(new Request(`http://localhost/v1/threads/${t.thread_id}`));
      expect(res.status, `thread ${t.thread_id} (${t.title}) opens`).toBe(200);
    }
  });

  it('lists ONLY public/public conversations on the real seed (two-condition containment)', async () => {
    const page = await directory();
    expect(page.items.length).toBeGreaterThan(0);
    // The seed includes room_only items and private-room conversations; the
    // global directory excludes them — every listed item is a PUBLIC story in a
    // PUBLIC room, verified directly against the stores (not via the feed).
    for (const t of page.items) {
      const story = await fx.ingestion.stories.getById(t.story_id);
      expect(story?.visibility, `${t.title} is a public item`).toBe('public');
      expect(story?.hiddenState, `${t.title} not hidden`).toBeNull();
      const room = t.room_id === null ? null : await fx.forum.rooms.getById(t.room_id);
      expect(room === null || room.visibility === 'public', `${t.title} in a public room`).toBe(
        true,
      );
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

describe('demo seed — the WS-U governed-room showcase', () => {
  it('makes one room governed with an active agent + a logged action (no queue hold)', async () => {
    const governance = createGovernanceService({ stores: createInMemoryGovernanceStores() });
    await seedGovernanceDemo(governance, fx.forum, fx.ingestion);
    const stewardId = DEV_ACCOUNTS.find((a) => a.email === 'steward@licio.test')?.userId;
    // The elected steward holds the seat and an active community agent governs it.
    const seat = await governance.getSeat(GOVERNANCE_DEMO_ROOM_ID);
    expect(seat?.holderUserId).toBe(stewardId);
    const binding = await governance.getBinding(GOVERNANCE_DEMO_ROOM_ID);
    expect(binding?.active).toBe(true);
    expect(binding?.capabilityDescriptor.granted).toContain('moderate.flag');
    // Agent actions surface in the "governed by" panel: a moderation hold against
    // a REAL contribution (not a synthetic id) and a Stage 4 lawmaking summary.
    const actions = await governance.recentAgentActions(GOVERNANCE_DEMO_ROOM_ID, 10);
    const moderation = actions.find((a) => a.actionType === 'moderate.flag_for_review');
    expect(moderation).toBeDefined();
    const subjectRef = moderation?.subjectRef ?? '';
    expect(subjectRef).not.toContain(':demo-action');
    expect(await fx.forum.contributions.getById(subjectRef)).not.toBeNull();
    expect(actions.some((a) => a.actionType === 'lawmaking.summarize')).toBe(true);
    // An open ratification vote surfaces the member voting UI (an upgrade model).
    const openVote = await governance.getOpenRatification(GOVERNANCE_DEMO_ROOM_ID);
    expect(openVote).not.toBeNull();
  });
});

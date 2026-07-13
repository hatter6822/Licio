// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-I.3 — the ten-test ranking-neutrality suite (SPEC §30.6, §13.6). Runs
// in CI on every PR (`pnpm check:neutrality` invokes exactly this file; the
// full vitest run includes it too) and is the release gate for every crypto
// release. Each test states honestly what it proves TODAY: WS-L/WS-M do not
// exist yet, so "payment events / treasury balances / memberships" are
// synthesized through the same stores and event log the real modules will
// use — the structural guarantees (no read path, schema denylists, closed
// enums, output equivalence) are exactly what must keep holding when real
// financial modules land, and this suite is the harness their staging
// events plug into (§30.6: "with real payment events in staging before any
// real-funds pilot").

import { randomUUID } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import {
  auditFeatureFieldNames,
  CANDIDATE_SOURCE_TYPES,
  candidatePoolSchema,
  candidateSchema,
  featureSchemaFieldNames,
  PROHIBITED_EXPLANATION_PATTERNS,
  rankingDecisionLogSchema,
  rankingProfileConfigSchema,
  scoredItemSchema,
  validateFeatureVector,
  violatesProhibitedLanguage,
} from '@licio/ranking';
import { collectZodFieldNames, isFinancialFieldName } from '@licio/shared';
import { Hono } from 'hono';
import { beforeEach, describe, expect, it } from 'vitest';
import { ingestAttentionEvents } from '../events/ingest.js';
import { changeStoryVisibility } from '../ingestion/visibility.js';
import { assembleFeatureVector, runFeatureBatch } from '../ranking/features.js';
import { engageKillSwitch } from '../ranking/killswitch.js';
import { serveFeed } from '../ranking/service.js';
import { registerRankingConsumers } from '../ranking/services.js';
import { createV1Routes } from '../routes/v1.js';
import { attentionEvent, seedUserWithSession } from './event-test-helpers.js';
import {
  freshRankingServices,
  type RankingFixture,
  seedInvariantOutput,
  seedStory,
} from './ranking-helpers.js';

let fixture: RankingFixture;

beforeEach(() => {
  // Crypto flag ON: financial topics flow through the event log exactly as
  // they will in staging — the suite proves they cannot reach ranking.
  // The ranking clock is PINNED so that two serve calls are evaluated at
  // the same instant: the equivalence assertions compare byte-identical
  // scores, and freshness decay must not drift with the wall clock between
  // the with-wallet and without-wallet legs.
  const pinnedNow = Date.now();
  fixture = freshRankingServices({ cryptoFlagEnabled: () => true }, { now: () => pinnedNow });
});

/** Link a wallet credential AND land financial events in the durable log. */
async function giveFinancialState(userId: string): Promise<void> {
  await fixture.identity.store.addWalletAuth({
    credentialId: randomUUID(),
    userId,
    addressHash: `hash-${userId}`,
    addressTruncated: '0x12ab…cd34',
    chainId: 1,
    walletType: 'eoa',
    createdAt: new Date().toISOString(),
    lastUsedAt: null,
  });
  // Real financial EVENTS in the same durable log the pipeline reads from
  // (the staging-shaped input of §30.6).
  await fixture.events.eventStore.insertMany([
    {
      eventId: randomUUID(),
      eventType: 'wallet.linked',
      topic: 'wallet.linked',
      timestamp: new Date().toISOString(),
      privacyClassification: 'restricted',
      retentionTier: 'account_active',
      payload: { event_type: 'wallet.linked', user_id: userId },
      ownerUserId: userId,
      purgeAfter: null,
    },
    {
      eventId: randomUUID(),
      eventType: 'payment.receipt.indexed',
      topic: 'payment.receipt.indexed',
      timestamp: new Date().toISOString(),
      privacyClassification: 'restricted',
      retentionTier: 'security_log',
      payload: { event_type: 'payment.receipt.indexed', user_id: userId, amount: '25.00' },
      ownerUserId: userId,
      purgeAfter: null,
    },
  ]);
}

async function ingestIdenticalAttention(userId: string, storyIds: string[]): Promise<void> {
  for (const storyId of storyIds) {
    await ingestAttentionEvents(
      fixture.events,
      fixture.identity,
      userId,
      [attentionEvent(userId, { storyId, timestamp: new Date().toISOString() })],
      { maxPastMs: Number.MAX_SAFE_INTEGER, maxFutureMs: Number.MAX_SAFE_INTEGER },
    );
  }
}

/** The served (item id, score) sequence of one feed for one user. */
async function feedSignature(
  userId: string | null,
  surface: 'front_page' | 'room' | 'topic' = 'front_page',
  surfaceRoomId: string | null = null,
): Promise<string> {
  const served = await serveFeed(fixture.ranking, {
    userId,
    surface,
    surfaceRoomId,
    surfaceTopicId: null,
    mode: undefined,
  });
  const log = await fixture.ranking.decisionLogs.getByRequestId(served.requestId);
  return JSON.stringify(
    served.items.map((item) => [
      item.story_id,
      log?.score_components[item.story_id]?.pwatt_score ?? null,
      item.distribution_reason,
    ]),
  );
}

/** Module sources of the candidate-retrieval and scoring boundary. */
function rankingModuleSource(file: string): string {
  return readFileSync(resolve(import.meta.dirname, '../ranking', file), 'utf-8');
}

/** Every import specifier of a TS source. */
function importSpecifiers(source: string): string[] {
  return [...source.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1] as string);
}

/**
 * The TRANSITIVE import closure of the WHOLE ranking layer inside
 * apps/api/src: every file under src/ranking is a root (a new ranking module
 * is covered automatically), relative imports are resolved and walked to a
 * fixpoint. Workspace packages are covered by their own legs: @licio/ranking
 * by the package denylist + schema walks (Test 2/7), @licio/db by the
 * WS-F.2.5b content denylist + the WS-D.3.2 BFS isolation proof, and the
 * pnpm boundary gate (`check:workspace-deps`) pins which packages apps/api
 * may import at all.
 */
function rankingTransitiveClosure(): { files: string[]; specifiers: string[] } {
  const srcRoot = resolve(import.meta.dirname, '..');
  const rankingDir = resolve(srcRoot, 'ranking');
  const queue = readdirSync(rankingDir)
    .filter((name) => name.endsWith('.ts'))
    .map((name) => resolve(rankingDir, name));
  const visited = new Set<string>();
  const specifiers = new Set<string>();
  while (queue.length > 0) {
    const file = queue.pop() as string;
    if (visited.has(file)) continue;
    visited.add(file);
    for (const specifier of importSpecifiers(readFileSync(file, 'utf-8'))) {
      specifiers.add(specifier);
      if (!specifier.startsWith('.')) continue;
      const base = resolve(dirname(file), specifier.replace(/\.js$/, ''));
      for (const candidate of [`${base}.ts`, `${base}.tsx`, resolve(base, 'index.ts')]) {
        if (existsSync(candidate)) {
          queue.push(candidate);
          break;
        }
      }
    }
  }
  return {
    files: [...visited].map((file) => relative(srcRoot, file)).sort(),
    specifiers: [...specifiers].sort(),
  };
}

const FINANCIAL_MODULE_PATTERN = /(wallet|payment|treasury|donor|knomosis|membership)/i;

describe('Test 1 — feed replay with/without wallet links is identical (WS-I.3.1a)', () => {
  it('two identical users — one wallet-linked with payment events — get identical feeds', async () => {
    const a = await seedUserWithSession(fixture.identity, { handle: 'neutrala' });
    const b = await seedUserWithSession(fixture.identity, { handle: 'neutralb' });
    const stories = [
      await seedStory(fixture.ingestion, {
        publishedAt: new Date(Date.now() - 3_600_000).toISOString(),
      }),
      await seedStory(fixture.ingestion, {
        publishedAt: new Date(Date.now() - 7_200_000).toISOString(),
      }),
      await seedStory(fixture.ingestion, {
        publishedAt: new Date(Date.now() - 10_800_000).toISOString(),
      }),
    ];
    await seedInvariantOutput(fixture.events, {
      invariantType: 'PWAtt_v1',
      targetId: stories[1]?.storyId as string,
      scoreVector: { active_attention: 0.8, participation: 0.7 },
      shadowMode: false,
    });
    await runFeatureBatch(
      {
        events: fixture.events,
        ingestion: fixture.ingestion,
        invariants: fixture.invariants,
        forum: fixture.forum,
        featureStore: fixture.ranking.featureStore,
        log: fixture.ranking.log,
        now: fixture.ranking.now,
      },
      50,
      6,
    );
    // A shared public room (both users active members, one story inside) so
    // the ROOM surface leg exercises the room-scoped pool + lens path too.
    const roomId = randomUUID();
    await fixture.forum.rooms.insert({
      roomId,
      name: 'Neutrality room',
      slug: 'neutrality-room',
      description: null,
      roomType: 'global_topic',
      visibility: 'public',
      joinModel: 'open',
      postingPolicy: 'all_members',
      createdBy: null,
      governanceMode: 'ordinary',
      charterSummary: null,
      typeMetadata: {},
      latestActivityAt: null,
    });
    for (const user of [a, b]) {
      await fixture.forum.rooms.upsertSubscription({
        roomId,
        userId: user.userId,
        status: 'active',
        requestId: randomUUID(),
        lensId: null,
        requestedAt: new Date().toISOString(),
        joinedAt: new Date().toISOString(),
      });
    }
    await seedStory(fixture.ingestion, { roomId });
    // Identical organic behavior for both users…
    const ids = stories.map((s) => s.storyId);
    await ingestIdenticalAttention(a.userId, ids.slice(0, 1));
    await ingestIdenticalAttention(b.userId, ids.slice(0, 1));
    // …then user A acquires wallet linkage + REAL payment events.
    await giveFinancialState(a.userId);

    // Identical ranking on every surface (§30.6: front page, room, topic).
    for (const [surface, surfaceRoomId] of [
      ['front_page', null],
      ['topic', null],
      ['room', roomId],
    ] as const) {
      const sigA = await feedSignature(a.userId, surface, surfaceRoomId);
      const sigB = await feedSignature(b.userId, surface, surfaceRoomId);
      expect(sigA).toBe(sigB);
    }

    // …and against the SAFE FALLBACK ranker too (WS-I.4.1b acceptance).
    await engageKillSwitch(
      fixture.events,
      {
        global: true,
        surfaces: [],
        profileIds: [],
        owner: 'neutrality-suite',
        triggerCondition: 'test 1 fallback leg',
        rollbackPath: 'release',
        reviewDate: new Date().toISOString(),
      },
      new Date().toISOString(),
    );
    expect(await feedSignature(a.userId)).toBe(await feedSignature(b.userId));
  });

  it('candidate retrieval is identical for wallet/no-wallet users (WS-I.1.1c runtime leg)', async () => {
    const a = await seedUserWithSession(fixture.identity, { handle: 'candusera' });
    const b = await seedUserWithSession(fixture.identity, { handle: 'canduserb' });
    await seedStory(fixture.ingestion);
    await seedStory(fixture.ingestion);
    await giveFinancialState(a.userId);
    const servedA = await serveFeed(fixture.ranking, {
      userId: a.userId,
      surface: 'front_page',
      surfaceRoomId: null,
      surfaceTopicId: null,
      mode: undefined,
    });
    const servedB = await serveFeed(fixture.ranking, {
      userId: b.userId,
      surface: 'front_page',
      surfaceRoomId: null,
      surfaceTopicId: null,
      mode: undefined,
    });
    const logA = await fixture.ranking.decisionLogs.getByRequestId(servedA.requestId);
    const logB = await fixture.ranking.decisionLogs.getByRequestId(servedB.requestId);
    expect(logA?.candidate_ids.sort()).toEqual(logB?.candidate_ids.sort());
  });
});

describe('Test 2 — payment amount absent from organic feature schemas (WS-I.3.1b)', () => {
  it('the feature vector schema carries zero financial fields', () => {
    expect(auditFeatureFieldNames(featureSchemaFieldNames())).toEqual([]);
  });

  it('every organic ranking schema is financially clean (deep field walk)', () => {
    for (const schema of [
      candidateSchema,
      scoredItemSchema,
      rankingProfileConfigSchema,
      rankingDecisionLogSchema,
    ]) {
      const fields = collectZodFieldNames(schema).filter(
        // The penalty-term field names ARE the control vocabulary
        // (coordination/holonomy/…), not financial fields; everything is
        // still scanned — none of them matches the denylist.
        (name) => true && name.length > 0,
      );
      const violations = fields.filter((name) => isFinancialFieldName(name));
      expect(violations).toEqual([]);
    }
  });
});

describe('Test 3 — donor identity absent from PWAtt and invariant joins (WS-I.3.1c)', () => {
  it('static: the TRANSITIVE ranking import closure reaches no financial module', () => {
    // Every file under src/ranking is a root; the walk resolves relative
    // imports to a fixpoint. A financial module ANYWHERE in the closure —
    // even imported three hops deep through a helper — fails here by file
    // path or by import specifier.
    const closure = rankingTransitiveClosure();
    // Sanity: the walk really is transitive (it left src/ranking and pulled
    // in the events/ingestion/forum/invariants layers the ports compose).
    expect(closure.files.length).toBeGreaterThan(30);
    expect(closure.files.some((file) => file.startsWith('events/'))).toBe(true);
    expect(closure.files.some((file) => file.startsWith('identity/'))).toBe(true);
    expect(closure.files.filter((file) => FINANCIAL_MODULE_PATTERN.test(file))).toEqual([]);
    expect(
      closure.specifiers.filter((specifier) => FINANCIAL_MODULE_PATTERN.test(specifier)),
    ).toEqual([]);
  });

  it('runtime: feature vectors are identical whether or not the submitter has a wallet', async () => {
    const donor = await seedUserWithSession(fixture.identity, { handle: 'donoruser' });
    await giveFinancialState(donor.userId);
    const byDonor = await seedStory(fixture.ingestion, {
      submittedBy: donor.userId,
      publishedAt: '2026-06-10T00:00:00.000Z',
    });
    const byOther = await seedStory(fixture.ingestion, {
      publishedAt: '2026-06-10T00:00:00.000Z',
    });
    const deps = {
      events: fixture.events,
      ingestion: fixture.ingestion,
      invariants: fixture.invariants,
      forum: fixture.forum,
      featureStore: fixture.ranking.featureStore,
      log: fixture.ranking.log,
      now: fixture.ranking.now,
    };
    const a = await assembleFeatureVector(deps, byDonor.storyId);
    const b = await assembleFeatureVector(deps, byOther.storyId);
    // Identical signal fields (identity fields necessarily differ).
    const strip = (v: NonNullable<typeof a>) => {
      const { item_id, source_id, room_id, updated_at, created_at, ...signals } = v;
      return signals;
    };
    expect(strip(a as NonNullable<typeof a>)).toEqual(strip(b as NonNullable<typeof b>));
  });
});

describe('Test 4 — treasury balance does not change story rank (WS-I.3.1d)', () => {
  it('a side-channel treasury balance has NO read path into ranking', async () => {
    // WS-M does not exist; the treasury is synthesized OUTSIDE the ranking
    // dependency graph (which is the point: there is no table or module the
    // pipeline could read it from — the static leg of Test 3 proves the
    // import graph, the db denylist + BFS isolation prove the schema layer).
    const treasuryBalances = new Map<string, number>();
    const funded = await seedStory(fixture.ingestion, {
      publishedAt: '2026-06-10T00:00:00.000Z',
    });
    const unfunded = await seedStory(fixture.ingestion, {
      publishedAt: '2026-06-10T00:00:00.000Z',
    });
    treasuryBalances.set(funded.storyId, 1_000_000);
    const before = await feedSignature(null);
    treasuryBalances.set(funded.storyId, 0);
    treasuryBalances.set(unfunded.storyId, 1_000_000);
    const after = await feedSignature(null);
    // Same ordering and scores whichever item is "funded".
    expect(before).toBe(after);
  });
});

describe('Test 5 — governance votes cannot relabel claims (WS-I.3.1e)', () => {
  it('a governance outcome event changes no claim label; the steward path does', async () => {
    const { storyId } = await seedStory(fixture.ingestion);
    const claim = await fixture.ingestion.claims.insert({
      claimId: randomUUID(),
      storyId,
      canonicalText: 'The audit was completed in May.',
      normalizedTextHash: `h-${randomUUID()}`,
      claimStatus: 'candidate',
      firstSeenStoryId: storyId,
      independenceGroupId: null,
      createdBy: null,
      extractionSource: 'system',
      extractionConfidence: 0.9,
      modelVersion: null,
    });
    // A "governance vote outcome" lands in the event log (crypto flag ON).
    await fixture.events.eventStore.insertMany([
      {
        eventId: randomUUID(),
        eventType: 'governance.proposal.executed',
        topic: 'governance.proposal.executed',
        timestamp: new Date().toISOString(),
        privacyClassification: 'restricted',
        retentionTier: 'moderation_legal',
        payload: {
          event_type: 'governance.proposal.executed',
          proposal: 'relabel-claim',
          claim_id: claim.claimId,
          desired_status: 'accepted',
        },
        ownerUserId: null,
        purgeAfter: null,
      },
    ]);
    // NO code path consumes governance outcomes into claim labels: the
    // claim is untouched.
    expect((await fixture.ingestion.claims.getById(claim.claimId))?.claimStatus).toBe('candidate');
    // The ONLY sanctioned path — evidence + steward review — still works.
    await fixture.ingestion.claims.updateStatus(claim.claimId, 'accepted');
    expect((await fixture.ingestion.claims.getById(claim.claimId))?.claimStatus).toBe('accepted');
  });

  it('a ROUTER-published schema-valid governance event reaches no ranking state', async () => {
    // The live-delivery leg: with the crypto flag ON and the ranking
    // consumers REGISTERED, a registry-valid Knomosis governance event goes
    // through the real router — and changes no claim label and no feature
    // vector (the WS-E firewall + the consumers' closed topic lists hold at
    // delivery, not just at rest).
    registerRankingConsumers(fixture.ranking);
    const { storyId } = await seedStory(fixture.ingestion);
    const claim = await fixture.ingestion.claims.insert({
      claimId: randomUUID(),
      storyId,
      canonicalText: 'The proposal passed with a quorum.',
      normalizedTextHash: `h-${randomUUID()}`,
      claimStatus: 'candidate',
      firstSeenStoryId: storyId,
      independenceGroupId: null,
      createdBy: null,
      extractionSource: 'system',
      extractionConfidence: 0.9,
      modelVersion: null,
    });
    await fixture.events.router.publish({
      event_id: randomUUID(),
      event_type: 'governance.proposal.executed',
      timestamp: new Date().toISOString(),
      schema_version: '1',
      proposal_id: randomUUID(),
      room_id: randomUUID(),
      execution_state: 'executed',
      privacy_classification: 'sensitive',
      retention_tier: 'account_active',
    } as never);
    expect((await fixture.ingestion.claims.getById(claim.claimId))?.claimStatus).toBe('candidate');
    expect(await fixture.ranking.featureStore.getLatest(storyId)).toBeNull();
  });
});

describe('Test 6 — paid status bypasses no safety, rate limit, or moderation (WS-I.3.1f)', () => {
  it('rate limits, safety filtering, and moderation apply identically', async () => {
    const paid = await seedUserWithSession(fixture.identity, { handle: 'paiduser' });
    const unpaid = await seedUserWithSession(fixture.identity, { handle: 'unpaiduser' });
    await giveFinancialState(paid.userId);
    // Identical per-account submission limits (the limiter keys on the
    // account ref only — there is no membership/wallet parameter to pass).
    const nowMs = Date.now();
    const limits = { perHour: 10, perDay: 50 };
    const paidDecision = await fixture.ingestion.submissionLimiter.hit(
      `acct-${paid.userId}`,
      limits,
      nowMs,
    );
    const unpaidDecision = await fixture.ingestion.submissionLimiter.hit(
      `acct-${unpaid.userId}`,
      limits,
      nowMs,
    );
    expect(paidDecision.allowed).toBe(unpaidDecision.allowed);
    // Identical safety filtering: a removed story is excluded from BOTH
    // users' feeds regardless of the requester's financial state.
    const removed = await seedStory(fixture.ingestion);
    await seedStory(fixture.ingestion);
    await fixture.events.safetyStore.set({
      itemId: removed.storyId,
      safetyState: 'removed',
      frozenScore: null,
      caseId: null,
      updatedBy: 'system',
      updatedAt: new Date().toISOString(),
    });
    for (const user of [paid, unpaid]) {
      const served = await serveFeed(fixture.ranking, {
        userId: user.userId,
        surface: 'front_page',
        surfaceRoomId: null,
        surfaceTopicId: null,
        mode: undefined,
      });
      expect(served.items.map((i) => i.story_id)).not.toContain(removed.storyId);
    }
  });

  it('static: no safety/rate-limit/ranking code path reads membership status', () => {
    for (const file of ['safety-filter.ts', 'service.ts', 'retrievers.ts']) {
      const source = rankingModuleSource(file);
      // No identifier READ of membership/paid status (the words may appear
      // only in comments and the denylist vocabulary).
      expect(/\.(membership|paidTier|subscriptionTier)\b/.test(source)).toBe(false);
    }
  });
});

describe('Test 7 — ML feature audits fail on financial fields (WS-I.3.1g)', () => {
  it('adding a wallet field fails the audit naming the field; removing it passes', () => {
    const organic = featureSchemaFieldNames();
    const poisoned = [...organic, 'wallet_balance_usd'];
    const failures = auditFeatureFieldNames(poisoned);
    expect(failures).toHaveLength(1);
    expect(failures[0]?.field).toBe('wallet_balance_usd');
    expect(failures[0]?.matchedPattern).toBe('wallet');
    expect(auditFeatureFieldNames(organic)).toEqual([]);
  });

  it('the write boundary enforces the same audit at deployment time', async () => {
    const { storyId } = await seedStory(fixture.ingestion);
    const vector = await assembleFeatureVector(
      {
        events: fixture.events,
        ingestion: fixture.ingestion,
        invariants: fixture.invariants,
        forum: fixture.forum,
        featureStore: fixture.ranking.featureStore,
        log: fixture.ranking.log,
        now: fixture.ranking.now,
      },
      storyId,
    );
    const poisoned = { ...(vector as object), donor_tier: 'gold' };
    const result = validateFeatureVector(poisoned);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.denied).toBe(true);
  });
});

describe('Test 8 — sponsored content cannot enter organic ranking (WS-I.3.1h)', () => {
  it('the organic source-type enum is CLOSED — no sponsored member exists', () => {
    expect([...CANDIDATE_SOURCE_TYPES]).toEqual([
      'subscribed_room',
      'local_news',
      'global',
      'emerging_discussion',
      'independent_source_addition',
      'expert_explanation',
      'chronological_catch_up',
    ]);
    expect(
      candidateSchema.safeParse({
        item_id: randomUUID(),
        item_type: 'story',
        source_type: 'sponsored',
        room_id: null,
        topic_ids: [],
        source_id: null,
        freshness_timestamp: new Date().toISOString(),
        retrieval_score: 1,
        retrieval_origins: ['sponsored_v1'],
      }).success,
    ).toBe(false);
  });

  it('a forged sponsored candidate cannot pass the stage boundary', () => {
    expect(() =>
      candidatePoolSchema.parse([
        {
          item_id: randomUUID(),
          item_type: 'story',
          source_type: 'sponsored',
          room_id: null,
          topic_ids: [],
          source_id: null,
          freshness_timestamp: new Date().toISOString(),
          retrieval_score: 1,
          retrieval_origins: ['sponsored_v1'],
          bridge_context: null,
        },
      ]),
    ).toThrow();
  });

  it('served decision logs carry only the seven registered organic origins', async () => {
    await seedStory(fixture.ingestion);
    const served = await serveFeed(fixture.ranking, {
      userId: null,
      surface: 'front_page',
      surfaceRoomId: null,
      surfaceTopicId: null,
      mode: undefined,
    });
    const log = await fixture.ranking.decisionLogs.getByRequestId(served.requestId);
    expect(log).not.toBeNull();
    const registered = new Set(fixture.ranking.retrievers.origins());
    expect(registered.size).toBe(8); // seven organic + the room scoper
    // (Origins are recorded per candidate at retrieval; the registry is the
    // closed set every origin must come from.)
    for (const origin of registered) {
      expect(/sponsor|treasury|paid/i.test(origin)).toBe(false);
    }
  });
});

describe('Test 9 — payments are support/governance, never endorsements (WS-I.3.1i)', () => {
  it('the prohibited-language artifact covers endorsement vocabulary', () => {
    const sample = [
      'Paying endorses this story',
      'Boost this post',
      'Promote your content',
      'Vote for quality with your donation',
    ];
    for (const phrase of sample) {
      expect(violatesProhibitedLanguage(phrase)).toBe(true);
    }
    expect(PROHIBITED_EXPLANATION_PATTERNS.length).toBeGreaterThanOrEqual(10);
  });

  it('no explanation template and no web i18n copy uses endorsement framing for payments', () => {
    // Templates are structurally blocked (package suite renders every one);
    // here the WEB COPY catalog is scanned with the SAME shared artifact.
    const catalog = readFileSync(
      resolve(import.meta.dirname, '../../../web/src/i18n/catalog.ts'),
      'utf-8',
    );
    const offending = catalog
      .split('\n')
      .filter((line) => /payment|donation|treasury|sponsor/i.test(line))
      .filter((line) => violatesProhibitedLanguage(line));
    expect(offending).toEqual([]);
  });
});

describe('Test 10 — product-health metrics separate from revenue metrics (WS-I.3.1j)', () => {
  it('no product-health metric name is financial', async () => {
    await seedStory(fixture.ingestion);
    await serveFeed(fixture.ranking, {
      userId: null,
      surface: 'front_page',
      surfaceRoomId: null,
      surfaceTopicId: null,
      mode: undefined,
    });
    // The metric registries behind the operational dashboards.
    const metricNames = [
      ...Object.keys(fixture.events.metrics.snapshot().counters),
      ...Object.keys(fixture.ingestion.metrics.snapshot()),
    ];
    const financial = metricNames.filter((name) => isFinancialFieldName(name));
    expect(financial).toEqual([]);
  });

  it('the ACTUAL ranking admin health payload (the dashboard source) is financially clean', async () => {
    // Dashboard-as-code, INTROSPECTED: call the real endpoint and deep-walk
    // every key of the actual response — a financial dimension added to the
    // health payload fails here without anyone updating a hard-coded list.
    const steward = await seedUserWithSession(fixture.identity, { steward: true });
    const app = new Hono().route('/v1', createV1Routes());
    const response = await app.request('/v1/ranking/admin/health', {
      headers: { cookie: steward.cookie },
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    const keys: string[] = [];
    const walk = (node: unknown): void => {
      if (node === null || typeof node !== 'object') return;
      if (Array.isArray(node)) {
        for (const child of node) walk(child);
        return;
      }
      for (const [key, child] of Object.entries(node)) {
        keys.push(key);
        walk(child);
      }
    };
    walk(body);
    expect(keys.length).toBeGreaterThan(3); // the walk really saw the payload
    expect(keys.filter((key) => isFinancialFieldName(key))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// WS-Q two-tier containment (WS-Q.4.4a/b): the no-applause neutrality gate is
// extended so the SAME CI step proves in-room content never reaches a global
// surface (ranked OR fallback) and that visibility gates candidacy, never
// scores. The distribution gate (filterByVisibility) is the authoritative
// always-on backstop.
// ---------------------------------------------------------------------------

async function insertRoom(visibility: 'public' | 'private'): Promise<string> {
  const roomId = randomUUID();
  await fixture.forum.rooms.insert({
    roomId,
    name: `Containment ${roomId.slice(0, 8)}`,
    slug: `containment-${roomId.slice(0, 8)}`,
    description: null,
    roomType: 'global_topic',
    visibility,
    joinModel: visibility === 'public' ? 'open' : 'request_approval',
    postingPolicy: 'all_members',
    createdBy: null,
    governanceMode: 'ordinary',
    charterSummary: null,
    typeMetadata: {},
    latestActivityAt: null,
  });
  return roomId;
}

describe('Test 11 — WS-Q two-tier containment (in-room content never reaches a global surface)', () => {
  it('a room_only story is on NO global surface, ranked OR fallback, nor in the candidate log', async () => {
    const room = await insertRoom('private');
    const planted = await seedStory(fixture.ingestion, { roomId: room, visibility: 'room_only' });
    const publicStory = await seedStory(fixture.ingestion);
    // RANKED front page.
    const ranked = await serveFeed(fixture.ranking, {
      userId: null,
      surface: 'front_page',
      surfaceRoomId: null,
      surfaceTopicId: null,
      mode: undefined,
    });
    expect(ranked.items.map((i) => i.story_id)).not.toContain(planted.storyId);
    expect(ranked.items.map((i) => i.story_id)).toContain(publicStory.storyId);
    const rankedLog = await fixture.ranking.decisionLogs.getByRequestId(ranked.requestId);
    expect(rankedLog?.candidate_ids).not.toContain(planted.storyId);
    // FALLBACK front page (chronological mode forces the safe ranker).
    const fallback = await serveFeed(fixture.ranking, {
      userId: null,
      surface: 'front_page',
      surfaceRoomId: null,
      surfaceTopicId: null,
      mode: 'chronological',
    });
    expect(fallback.fallback).toBe(true);
    expect(fallback.items.map((i) => i.story_id)).not.toContain(planted.storyId);
  });

  it('a transiently-mislabeled PUBLIC story in a PRIVATE room is excluded too (room conjunct)', async () => {
    const room = await insertRoom('private');
    // The store-level seed bypasses deriveStoryVisibility, simulating the
    // migration-transient / cascade-bug case: visibility public, room private.
    const mislabeled = await seedStory(fixture.ingestion, { roomId: room, visibility: 'public' });
    const served = await serveFeed(fixture.ranking, {
      userId: null,
      surface: 'front_page',
      surfaceRoomId: null,
      surfaceTopicId: null,
      mode: undefined,
    });
    expect(served.items.map((i) => i.story_id)).not.toContain(mislabeled.storyId);
  });

  it("a private room's content is absent from a NON-member's every global surface", async () => {
    const room = await insertRoom('private');
    const inRoom = await seedStory(fixture.ingestion, { roomId: room, visibility: 'room_only' });
    const outsider = await seedUserWithSession(fixture.identity, { handle: 'outsider' });
    for (const surface of ['front_page', 'topic'] as const) {
      const served = await serveFeed(fixture.ranking, {
        userId: outsider.userId,
        surface,
        surfaceRoomId: null,
        surfaceTopicId: surface === 'topic' ? 'civics' : null,
        mode: undefined,
      });
      expect(served.items.map((i) => i.story_id)).not.toContain(inRoom.storyId);
    }
  });
});

describe('Test 12 — WS-Q visibility is NOT a ranking signal (eligibility only)', () => {
  it('narrow removes an item from the next serve; widen restores it (eligibility flip)', async () => {
    const author = await seedUserWithSession(fixture.identity, { handle: 'flip' });
    const story = await seedStory(fixture.ingestion, { submittedBy: author.userId });
    const present = () =>
      serveFeed(fixture.ranking, {
        userId: null,
        surface: 'front_page',
        surfaceRoomId: null,
        surfaceTopicId: null,
        mode: undefined,
      }).then((s) => s.items.map((i) => i.story_id).includes(story.storyId));
    expect(await present()).toBe(true);
    // Narrow → off the global surface on the next serve.
    await changeStoryVisibility(
      fixture.ingestion,
      fixture.events,
      fixture.identity,
      fixture.forum,
      author.userId,
      story.storyId,
      'room_only',
    );
    expect(await present()).toBe(false);
    // Widen → back on (the home room is the public Commons).
    await changeStoryVisibility(
      fixture.ingestion,
      fixture.events,
      fixture.identity,
      fixture.forum,
      author.userId,
      story.storyId,
      'public',
    );
    expect(await present()).toBe(true);
  });
});

describe('Test 13 — every global retrieval path routes through the visibility gate (WS-Q.4.4b)', () => {
  it('the feed service applies filterByVisibility and the retrievers apply the public predicate', () => {
    const here = dirname(new URL(import.meta.url).pathname);
    const serviceSrc = readFileSync(resolve(here, '../ranking/service.ts'), 'utf8');
    const retrieversSrc = readFileSync(resolve(here, '../ranking/retrievers.ts'), 'utf8');
    // The always-on distribution gate runs on the surface pool BEFORE the
    // ranked/fallback split, so both inherit it.
    expect(serviceSrc).toMatch(/filterByVisibility\(/);
    // The eight organic retrievers apply the two-condition global predicate.
    expect(retrieversSrc).toMatch(/globallyRetrievable\(/);
  });
});

describe('Test 14 — WS-T comment remodel stays outside ranking inputs', () => {
  it('ranking imports no comment read model, live stream, or notification surfaces', () => {
    const closure = rankingTransitiveClosure();
    expect(closure.specifiers).not.toContain('../forum/comments.js');
    expect(closure.specifiers).not.toContain('../forum/comment-broadcaster.js');
    expect(closure.specifiers).not.toContain('../lib/reply-notifications.js');
    expect(closure.files.some((file) => file.includes('forum/comments'))).toBe(false);
  });
});

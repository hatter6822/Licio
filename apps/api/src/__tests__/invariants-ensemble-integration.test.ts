// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Batch-tier ENSEMBLE INTEGRATION. The pure-math ensemble suite
// (invariants-ensemble-adversarial) proves the cross-invariant correlation in
// the MATHEMATICS; this proves the WIRING the pure-math suite cannot — that a
// seeded attack, driven through the REAL batch tier / scheduler tick, produces
// the persisted detection end to end. A regression in data assembly, the
// router, or the scheduler would fail HERE while the pure-math suite still
// passed.

import { randomUUID } from 'node:crypto';
import { lshBandHashes, minhashSignature } from '@licio/invariants';
import { beforeEach, describe, expect, it } from 'vitest';
import { runBatchTier, runInvariantsTick } from '../invariants/scheduler.js';
import { GLOBAL_FEED_TARGET_ID } from '../invariants/services-impl.js';
import {
  freshInvariantServices,
  type InvariantServicesFixture,
  seedStory,
} from './invariant-test-helpers.js';

let fixture: InvariantServicesFixture;
beforeEach(() => {
  fixture = freshInvariantServices();
});

/** Attach a real MinHash signature (so the LSH near-dup path actually groups). */
async function sign(storyId: string, body: string): Promise<void> {
  const minhash = minhashSignature(body);
  await fixture.ingestion.signatures.upsert(
    { storyId, minhash, shingleK: 5, numHashes: 128, familyVersion: 1, textSource: 'submitted' },
    lshBandHashes(minhash),
  );
}

describe('batch-tier ensemble: a paraphrase flood is folded by MERI through runBatchTier', () => {
  it('persists a feed MERI output whose near-dup gains are bounded vs the distinct story', async () => {
    const text =
      'The regional water board released raw and processed nitrate sampling results with full methodology notes for independent verification by community laboratories this week.';
    const nearCopy = `${text} Syndication footer appended by the aggregator.`;
    const distinct =
      'A separate zoning appeal advanced through the planning commission after months of contested testimony about parking minimums and downtown transit corridors.';
    const a = await seedStory(fixture, { canonicalUrl: 'https://a.example/x' });
    const b = await seedStory(fixture, { canonicalUrl: 'https://b.example/y' });
    const c = await seedStory(fixture, { canonicalUrl: 'https://c.example/z' });
    await sign(a.storyId, text);
    await sign(b.storyId, nearCopy);
    await sign(c.storyId, distinct);

    // Drive the REAL batch tier (assembly → MinHash grouping → computeMeri →
    // persistence), not the pure math.
    await runBatchTier(fixture.invariants, fixture.events, fixture.ingestion, Date.now());

    const meri = await fixture.events.invariantStore.latest('MERI', GLOBAL_FEED_TARGET_ID);
    expect(meri).not.toBeNull();
    expect(meri?.fallbackUsed).toBe(false);
    const gains = meri?.scoreVector['marginal_gains'] as Record<string, number>;
    // The two near-duplicates collapse: the lesser of the pair earns far less
    // marginal exposure than the genuinely distinct story (redundancy folded).
    expect(Math.min(gains[a.storyId] ?? 1, gains[b.storyId] ?? 1)).toBeLessThan(
      gains[c.storyId] ?? 0,
    );
    expect(Object.values(gains).some((g) => g <= 0)).toBe(true);
    // The distinct story keeps a full independent exposure.
    expect(gains[c.storyId] ?? 0).toBeGreaterThanOrEqual(1);
  });
});

describe('scheduler tick wires the threshold-hugging meta-monitor (WS-O.4.5)', () => {
  /** Seed one shadow SCOI output with a given scoi score. */
  async function seedScoi(value: number, nowMs: number): Promise<string> {
    const targetId = randomUUID();
    await fixture.events.invariantStore.upsert({
      invariantType: 'SCOI',
      targetType: 'story',
      targetId,
      timeWindow: {
        start: new Date(nowMs - 3_600_000).toISOString(),
        end: new Date(nowMs).toISOString(),
      },
      version: '1.0.0',
      scoreVector: { scoi: value },
      explanationSummary: null,
      confidence: 1,
      coverage: 1,
      reasonCodes: [],
      fallbackUsed: false,
      versionMetadata: null,
      shadowMode: true,
      createdAt: new Date(nowMs).toISOString(),
    });
    return targetId;
  }

  it('runInvariantsTick routes SCOI hugging to the MFCI intake (proving it calls the scan)', async () => {
    // Noon UTC: NOT hour 0, so the nightly calibration rebuild does not run.
    const nowMs = Date.UTC(2026, 5, 10, 12);
    const threshold = fixture.invariants.config().scoiNeedsContextThreshold;
    const band = fixture.invariants.config().thresholdHuggingBandFraction * threshold;
    for (let i = 0; i < 18; i += 1) await seedScoi((i / 18) * (threshold - band), nowMs);
    const hugging = new Set<string>();
    for (let i = 0; i < 14; i += 1) hugging.add(await seedScoi(threshold - band * 0.4, nowMs));

    const routed: string[] = [];
    fixture.events.hooks.mfci = async (event) => {
      for (const id of (event as unknown as { target_ids: string[] }).target_ids) routed.push(id);
    };
    // No stories seeded ⇒ the batch tier degrades gracefully and Tropical does
    // not fire, so the ONLY MFCI routing can come from the hugging scan.
    await runInvariantsTick(
      fixture.invariants,
      fixture.events,
      fixture.ingestion,
      undefined,
      nowMs,
    );

    expect(routed.length).toBeGreaterThan(0);
    expect(routed.every((id) => hugging.has(id))).toBe(true);
  });
});

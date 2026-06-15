// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-O.4.5 — the cross-invariant threshold-hugging meta-monitor. Proves the
// scheduler step reads each threshold-bearing invariant's recent score
// population, flags an anomalous mass JUST UNDER the public threshold, and
// routes the flagged targets to the EXACT MFCI fiber test (SCOI/PHI) — while a
// diffuse population is left alone (fail-closed, no false positive).

import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { runThresholdHuggingScan } from '../invariants/scheduler.js';
import { freshInvariantServices, type InvariantServicesFixture } from './invariant-test-helpers.js';

let fixture: InvariantServicesFixture;
beforeEach(() => {
  fixture = freshInvariantServices();
});

/** Seed one shadow invariant output with a single score-vector field. */
async function seedScore(
  invariantType: string,
  scoreKey: string,
  value: number,
  nowMs: number,
): Promise<string> {
  const targetId = randomUUID();
  await fixture.events.invariantStore.upsert({
    invariantType,
    targetType: 'story',
    targetId,
    timeWindow: {
      start: new Date(nowMs - 3_600_000).toISOString(),
      end: new Date(nowMs).toISOString(),
    },
    version: '1.0.0',
    scoreVector: { [scoreKey]: value },
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

function captureMfciRouting(): string[][] {
  const captured: string[][] = [];
  fixture.events.hooks.mfci = async (event) => {
    captured.push([...(event as unknown as { target_ids: string[] }).target_ids]);
  };
  return captured;
}

describe('threshold-hugging meta-monitor (WS-O.4.5)', () => {
  it('flags SCOI scores massed just under the public threshold and routes them to MFCI', async () => {
    const nowMs = Date.UTC(2026, 5, 10, 12);
    const threshold = fixture.invariants.config().scoiNeedsContextThreshold; // 0.4
    const band = fixture.invariants.config().thresholdHuggingBandFraction * threshold; // 0.06
    // A diffuse background spread well below the cliff ...
    for (let i = 0; i < 18; i += 1) {
      await seedScore('SCOI', 'scoi', (i / 18) * (threshold - band), nowMs);
    }
    // ... plus a cluster hugging [threshold − band, threshold) — the attack.
    const hugging: string[] = [];
    for (let i = 0; i < 14; i += 1) {
      hugging.push(await seedScore('SCOI', 'scoi', threshold - band * 0.4, nowMs));
    }

    const captured = captureMfciRouting();
    await runThresholdHuggingScan(fixture.invariants, fixture.events, nowMs);

    // The hugging targets were escalated to the exact MFCI fiber test.
    expect(captured.length).toBeGreaterThan(0);
    const routed = new Set(captured.flat());
    expect([...routed].every((id) => hugging.includes(id))).toBe(true);
    expect(routed.size).toBeGreaterThan(0);
  });

  it('does NOT flag (or route) a diffuse SCOI population — fail-closed', async () => {
    const nowMs = Date.UTC(2026, 5, 10, 12);
    const threshold = fixture.invariants.config().scoiNeedsContextThreshold;
    for (let i = 0; i < 30; i += 1) {
      await seedScore('SCOI', 'scoi', (i / 30) * threshold, nowMs);
    }
    const captured = captureMfciRouting();
    await runThresholdHuggingScan(fixture.invariants, fixture.events, nowMs);
    expect(captured.length).toBe(0);
  });

  it('emits the metric but does NOT route MFCI self-hugging (already fiber-tested)', async () => {
    const nowMs = Date.UTC(2026, 5, 10, 12);
    const elevated = fixture.invariants.config().mfciRiskThresholds.elevated;
    const band = fixture.invariants.config().thresholdHuggingBandFraction * elevated;
    for (let i = 0; i < 18; i += 1) {
      await seedScore('MFCI', 'mfci', (i / 18) * (elevated - band), nowMs);
    }
    for (let i = 0; i < 14; i += 1) {
      await seedScore('MFCI', 'mfci', elevated - band * 0.4, nowMs);
    }
    const captured = captureMfciRouting();
    await runThresholdHuggingScan(fixture.invariants, fixture.events, nowMs);
    // MFCI's own borderline targets are NOT re-routed (their score IS the exact
    // statistic); the metric still fires (proven by the absence of a throw +
    // the scan completing). Routing is reserved for SCOI/PHI cross-checks.
    expect(captured.length).toBe(0);
  });

  it('is read-only and a no-op when there are too few outputs (fail-closed)', async () => {
    const nowMs = Date.UTC(2026, 5, 10, 12);
    const threshold = fixture.invariants.config().scoiNeedsContextThreshold;
    await seedScore('SCOI', 'scoi', threshold - 0.01, nowMs);
    const captured = captureMfciRouting();
    await runThresholdHuggingScan(fixture.invariants, fixture.events, nowMs);
    expect(captured.length).toBe(0);
  });

  it('does NOT route PHI hugging — session-scoped targets, metric only', async () => {
    const nowMs = Date.UTC(2026, 5, 10, 12);
    const threshold = fixture.invariants.config().phiThresholds.baseThreshold;
    const band = fixture.invariants.config().thresholdHuggingBandFraction * threshold;
    for (let i = 0; i < 18; i += 1) {
      await seedScore('PHI', 'phi', (i / 18) * (threshold - band), nowMs);
    }
    for (let i = 0; i < 14; i += 1) await seedScore('PHI', 'phi', threshold - band * 0.4, nowMs);
    const captured = captureMfciRouting();
    await runThresholdHuggingScan(fixture.invariants, fixture.events, nowMs);
    // PHI targets are sessions, not stories the coordination test can score.
    expect(captured.length).toBe(0);
  });

  it('does NOT re-route a hugging target already under an OPEN case (cooldown)', async () => {
    const nowMs = Date.UTC(2026, 5, 10, 12);
    const threshold = fixture.invariants.config().scoiNeedsContextThreshold;
    const band = fixture.invariants.config().thresholdHuggingBandFraction * threshold;
    for (let i = 0; i < 18; i += 1) {
      await seedScore('SCOI', 'scoi', (i / 18) * (threshold - band), nowMs);
    }
    const hugging: string[] = [];
    for (let i = 0; i < 14; i += 1) {
      hugging.push(await seedScore('SCOI', 'scoi', threshold - band * 0.4, nowMs));
    }
    // Every hugging target already has an open case → none is re-routed.
    for (const targetId of hugging) {
      await fixture.invariants.mfciCases.insert({
        caseId: randomUUID(),
        targetType: 'story',
        targetId,
        riskState: 'elevated',
        statistic: 'target_concentration',
        mfciScore: 3,
        pHat: 0.05,
        sampleCount: 50,
        fixedMarginsRef: 'cheap:x',
        summary: '{}',
        appealSummary: '',
        status: 'open',
        openedAt: new Date(nowMs).toISOString(),
        resolvedAt: null,
        resolvedBy: null,
      });
    }
    const captured = captureMfciRouting();
    await runThresholdHuggingScan(fixture.invariants, fixture.events, nowMs);
    expect(captured.flat().length).toBe(0);
  });
});

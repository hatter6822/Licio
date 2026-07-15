// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-N.2.2b/c — the production `CompliancePort.fraudRisk` implementation:
// atomic sliding-window velocity reserve + the high-value review trigger.
//
// Counting model (documented in config.ts): every fraudRisk call RESERVES a
// check in the window — preflight and submit each count once, so an action
// costs ~2 checks and the configured budgets carry that factor.  Over-
// counting is the deliberate fail-safe direction: a rejected/retried action
// can only TIGHTEN the window, never widen it, and two racing checks can
// never both squeeze under a limit (the reserve is atomic; the WS-N.2.2b
// concurrency requirement).  Volume math is exact decimal (BigInt / Lua
// string addition) — 18-decimal assets never overflow or round.
//
// Verdicts: `blocked` (a velocity limit would be exceeded — the shipped
// gates reject with FRAUD_RISK and a velocity case opens), `elevated` (the
// high-value review threshold — §17.10 "manual review of high-value
// disbursements"), `normal` otherwise.  A malformed amount is `blocked`: an
// unparseable value must never pass a limiter.
//
// `elevated` means REVIEW REQUIRED, and both consumers honor it: a payment
// intent is held in the fraud queue (`payment_compliance_state = 'flagged'`,
// released by a reviewer), and a direct WS-L fund transfer — which has no
// intent to hold — is rejected pending the same review.  To keep that from
// being a permanent block, the review is a LOOP: the pattern case is
// idempotent per ATTEMPT (`reviewRef`), so once a reviewer resolves it
// `cleared` this returns `normal` and that attempt's retry proceeds.  Any
// other case state (open/assigned/investigating/escalated, or resolved to a
// non-cleared outcome) keeps the action held — and the clearance covers only
// the attempt reviewed, never every later transfer of the same amount.

import type { CompliancePort, FraudVerdict } from '../knomosis/ports.js';
import { type CaseDeps, createCase } from './cases.js';
import type { ComplianceRuntimeConfig, VelocityLimit } from './config.js';
import type { RegionResolution } from './region.js';
import type { VelocityStore } from './stores.js';

type Clock = () => number;

export interface FraudRiskDeps {
  velocity: VelocityStore;
  config: () => ComplianceRuntimeConfig;
  /** Identity-free region resolution (per-jurisdiction limits, WS-N.2.2b). */
  resolveRegion: (userId: string) => Promise<RegionResolution>;
  caseDeps: CaseDeps;
  metric: (name: string) => void;
  log: (event: string, meta: Record<string, unknown>) => void;
  now: Clock;
}

const AMOUNT_RE = /^\d{1,78}$/;

/** UTC day bucket for idempotent case keys. */
const dayBucket = (nowMs: number): string => new Date(nowMs).toISOString().slice(0, 10);

export function limitsForRegion(
  config: ComplianceRuntimeConfig,
  region: string | null,
): VelocityLimit[] {
  if (region !== null) {
    const override = config.velocityRegionOverrides[region];
    if (override !== undefined) return override;
  }
  return config.velocityLimits;
}

export function createFraudRisk(deps: FraudRiskDeps): CompliancePort['fraudRisk'] {
  return async ({ userId, actionType, amountMinorUnits, reviewRef }): Promise<FraudVerdict> => {
    const amount = amountMinorUnits ?? '0';
    if (!AMOUNT_RE.test(amount)) {
      // An unparseable amount can never be bounded — fail affirmatively closed.
      deps.metric('compliance.fraud.malformed_amount');
      return 'blocked';
    }
    const config = deps.config();
    let region: RegionResolution;
    try {
      region = await deps.resolveRegion(userId);
    } catch {
      region = { region: null, basis: 'unknown' };
    }
    const nowMs = deps.now();
    for (const limit of limitsForRegion(config, region.region)) {
      let decision: 'ok' | 'exceeded';
      try {
        decision = await deps.velocity.reserve({
          key: `vel:${userId}:${limit.periodSeconds}`,
          nowMs,
          windowMs: limit.periodSeconds * 1_000,
          amountMinorUnits: amount,
          maxCount: limit.maxCount,
          maxVolumeMinorUnits: limit.maxVolumeMinorUnits,
        });
      } catch {
        // A counter outage can never fail open: the engine answers
        // 'unavailable' and the real-fund paths reject (the shipped gates).
        deps.metric('compliance.fraud.counter_unavailable');
        return 'unavailable';
      }
      if (decision === 'exceeded') {
        deps.metric('compliance.fraud.velocity_blocked');
        const periodStart = nowMs - (nowMs % (limit.periodSeconds * 1_000));
        await createCase(deps.caseDeps, {
          subjectKind: 'user',
          subjectRef: userId,
          triggerType: 'velocity',
          riskLevel: 'high',
          note: `Velocity limit exceeded (${limit.periodSeconds}s window) on ${actionType}.`,
          idempotencyKey: `velocity:${userId}:${limit.periodSeconds}:${periodStart}`,
        });
        return 'blocked';
      }
    }
    // High-value review (WS-N.2.2c): at/above the threshold the check is
    // `elevated` — the action is held for manual review (the intent goes to
    // the fraud queue; a direct WS-L transfer is rejected pending review).
    // Distinct from the WS-L.2.6e signing STEP-UP threshold.
    if (BigInt(amount) >= BigInt(config.highValueReviewThresholdMinorUnits)) {
      const opened = await createCase(deps.caseDeps, {
        subjectKind: 'user',
        subjectRef: userId,
        triggerType: 'pattern',
        riskLevel: 'medium',
        note: `High-value ${actionType} at/above the manual-review threshold (WS-N.2.2c).`,
        // Scoped to the ATTEMPT (`reviewRef`: the bound typed-data hash / the
        // payment-intent id), so one attempt's preflight and submit share a
        // review while a DIFFERENT transfer of the same amount opens its own —
        // a day-bucket key would let one cleared review wave through every
        // later identical transfer that day.  With no ref the attempts are
        // indistinguishable, so the case is still deduped per day (no spam)
        // but the cleared-review exit below is withheld (fail-closed).
        idempotencyKey:
          reviewRef === undefined
            ? `highvalue:${userId}:${actionType}:${amount}:${dayBucket(nowMs)}`
            : `highvalue:${userId}:${actionType}:${amount}:${reviewRef}`,
      });
      // The review loop's exit: a reviewer who CLEARED THIS attempt lets its
      // retry through.  Anything else — in flight, or resolved to a
      // non-cleared outcome — stays held.
      if (
        reviewRef !== undefined &&
        opened.ok &&
        opened.record.reviewState === 'resolved' &&
        opened.record.resolution?.outcome === 'cleared'
      ) {
        deps.metric('compliance.fraud.high_value_cleared');
        return 'normal';
      }
      deps.metric('compliance.fraud.high_value_elevated');
      return 'elevated';
    }
    return 'normal';
  };
}

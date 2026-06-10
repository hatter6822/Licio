// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Retention tiers (WS-E.1.1f, SPEC §22.4). Every event topic carries exactly one
// tier, assigned at schema-definition time (compile-time checked — no event can
// be persisted without an explicit, reviewable retention decision). The windows
// below are the platform DEFAULTS; jurisdiction-specific overrides are owned by
// WS-N and applied at retention-job time (WS-E.1.4), never here.
import { z } from 'zod';

/** The closed set of retention tiers (SPEC §22.4, one row per data class). */
export const RETENTION_TIERS = [
  'attention_raw',
  'attention_aggregated',
  'public_contribution',
  'ranking_log',
  'moderation_legal',
  'account_active',
  'security_log',
] as const;
export type RetentionTier = (typeof RETENTION_TIERS)[number];
export const retentionTierSchema = z.enum(RETENTION_TIERS);

/**
 * A retention window in days. `min` is the earliest a sweep may act; `max` is
 * the hard ceiling after which rows MUST be deleted/anonymized/flagged.
 * `Number.POSITIVE_INFINITY` marks tiers whose ceiling is policy/legal-need
 * based rather than a fixed clock (their `policy` text says which process
 * bounds them instead).
 */
export interface RetentionWindow {
  /** Minimum retention in days (0 = may be removed immediately). */
  min: number;
  /** Maximum retention in days; +Infinity ⇒ bounded by the named policy. */
  max: number;
  /** Human-readable policy basis (SPEC §22.4 wording). */
  policy: string;
}

const RETENTION_WINDOWS: Readonly<Record<RetentionTier, RetentionWindow>> = {
  attention_raw: {
    min: 0,
    max: 7,
    policy: 'Raw client attention events: prefer never uploaded; if uploaded, <= 7 days.',
  },
  attention_aggregated: {
    min: 90,
    max: 180,
    policy: 'Aggregated attention features: 90-180 days, then anonymize or delete.',
  },
  public_contribution: {
    min: 0,
    max: Number.POSITIVE_INFINITY,
    policy: 'Public contributions: retained until deleted, removed, or archived by policy.',
  },
  ranking_log: {
    min: 180,
    max: 365,
    policy: 'Ranking decision logs and invariant outputs: 180-365 days with access controls.',
  },
  moderation_legal: {
    min: 365,
    max: Number.POSITIVE_INFINITY,
    policy:
      'Moderation logs: retained per policy/legal need; flagged for annual human review ' +
      'rather than auto-deleted.',
  },
  account_active: {
    min: 0,
    max: Number.POSITIVE_INFINITY,
    policy: 'Account-linked operational records: while the account is active + legal retention.',
  },
  security_log: {
    min: 0,
    max: Number.POSITIVE_INFINITY,
    policy: 'Security and integrity events: per risk and legal requirements.',
  },
};

/**
 * The configured default retention window for a tier (SPEC §22.4). These are
 * DEFAULTS: jurisdiction-specific overrides (WS-N) may shorten them at
 * retention-job time. A returned `max` of +Infinity means the tier is bounded
 * by the named policy process (e.g. annual moderation review), not a timer.
 */
export function getRetentionDays(tier: RetentionTier): RetentionWindow {
  return RETENTION_WINDOWS[tier];
}

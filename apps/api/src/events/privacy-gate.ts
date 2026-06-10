// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Server-side privacy-level enforcement for attention ingestion (WS-E.1.3d,
// SPEC §19.2/§19.3). The server enforces the user's CURRENT durable privacy
// settings on every event — the boundary holds even against a misbehaving or
// compromised client, and a mid-session settings change takes effect on the
// very next event (settings are read per request, never cached):
//
//   personalization_enabled = false  → DISCARD (the client should not be
//     sending at all; the server enforces regardless);
//   attention_retention_preference = 'none'     → accept for real-time
//     aggregation only: the event row is marked for deletion after the
//     current ranking window and NO durable §22.1 aggregate row is written;
//   attention_retention_preference = 'minimal'  → shortest tier window (the
//     90-day minimum of `attention_aggregated`);
//   default → the tier maximum (180 days).
//
// The compliance log records the decision (user id + action) but NEVER the
// event payload, so the audit trail itself is not a behavioral record.
import {
  type AttentionRetentionPreference,
  getRetentionDays,
  type PrivacyLevel,
  type PrivacySettings,
} from '@licio/shared';

export const DAY_MS = 86_400_000;
/** The real-time ranking window after which `none`-preference rows purge. */
export const RANKING_WINDOW_MS = 3_600_000;

export type AttentionPrivacyDecision =
  | { action: 'discard'; reason: 'personalization_disabled' }
  | {
      action: 'accept';
      preference: AttentionRetentionPreference;
      /** False ⇒ no durable §22.1 aggregate rows (real-time only). */
      persistDurable: boolean;
    };

/** Evaluate the user's settings into an enforcement decision. */
export function evaluateAttentionPrivacy(settings: PrivacySettings): AttentionPrivacyDecision {
  if (!settings.personalization_enabled) {
    return { action: 'discard', reason: 'personalization_disabled' };
  }
  const preference = settings.attention_retention_preference;
  return { action: 'accept', preference, persistDurable: preference !== 'none' };
}

/**
 * The purge deadline for an accepted attention EVENT row, from the retention
 * preference (WS-E.1.3d/1.4): `none` purges after the current ranking window;
 * `minimal` after the tier minimum; default after the tier maximum.
 */
export function attentionPurgeAfterIso(
  preference: AttentionRetentionPreference,
  eventTimestampMs: number,
  nowMs: number,
): string {
  const window = getRetentionDays('attention_aggregated');
  switch (preference) {
    case 'none':
      return new Date(nowMs + RANKING_WINDOW_MS).toISOString();
    case 'minimal':
      return new Date(eventTimestampMs + window.min * DAY_MS).toISOString();
    case 'default':
      return new Date(eventTimestampMs + window.max * DAY_MS).toISOString();
  }
}

const LEVEL_RANK: Readonly<Record<PrivacyLevel, number>> = {
  standard: 0,
  reduced: 1,
  minimum: 2,
};

/**
 * The effective collection privacy level: the MORE private of the
 * client-claimed level and the server floor. A client can always strengthen
 * its own pseudonymization, never weaken the server's floor.
 */
export function effectivePrivacyLevel(
  claimed: PrivacyLevel,
  serverFloor: PrivacyLevel = 'standard',
): PrivacyLevel {
  return LEVEL_RANK[claimed] >= LEVEL_RANK[serverFloor] ? claimed : serverFloor;
}

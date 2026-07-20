// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Signal-processing privacy compliance (WS-C.4.1d, SPEC §19.1–19.3). This is the
// privacy linchpin: raw events are processed in-browser and discarded; only the
// bucketed AttentionAggregate is ever uploaded. Personalization-off stops
// collection entirely; minimum privacy replaces the user id with a coarse bucket
// so a single aggregate cannot re-identify the reader. `assertNoRawEgress` is the
// runtime half of the no-raw-egress guarantee (the CI network harness is the other).
import type { PrivacyLevel, UserSettings } from '@licio/shared';

/** Coarse bucket used in place of the user id at minimum privacy (§19.2). */
export const PRIVACY_BUCKET = 'privacy-bucket';

export interface CollectionPolicy {
  /** Whether attention collection runs at all (personalization toggle). */
  collect: boolean;
  privacyLevel: PrivacyLevel;
  /** The id placed in the aggregate: user id, or a coarse bucket at minimum. */
  identifier: string;
}

/**
 * Resolve the identifier for the aggregate. Minimum privacy (or an absent user
 * id) yields the coarse bucket, never the user id; standard/reduced use the id.
 */
export function resolveIdentifier(userId: string | null, level: PrivacyLevel): string {
  if (level === 'minimum' || userId === null) return PRIVACY_BUCKET;
  return userId;
}

/**
 * Derive the collection policy from the user's settings + (optional) id.
 * Collection requires BOTH personalization AND an authenticated session: the
 * WS-E ingestion boundary authenticates every upload (ownership + replay
 * protection, SPEC §25.5), so an anonymous session has nowhere to send
 * aggregates — collecting them would only fill the offline queue with
 * uploads destined to fail. Signed-out readers therefore generate no
 * attention data at all (also the more private default).
 */
export function resolveCollectionPolicy(
  settings: Pick<UserSettings, 'personalization_enabled' | 'privacy_level'>,
  userId: string | null,
): CollectionPolicy {
  return {
    collect: settings.personalization_enabled && userId !== null,
    privacyLevel: settings.privacy_level,
    identifier: resolveIdentifier(userId, settings.privacy_level),
  };
}

// Keys that would indicate a RAW trace (scroll/touch/pointer positions, event
// streams, or a raw dwell duration) leaking into a payload. The aggregate carries
// only buckets, so none of these may ever appear (defense in depth, WS-C.4.1d).
// Stored as canonical collapsed tokens (lower-cased, separators stripped) so that
// snake_case / camelCase / SCREAMING_SNAKE spellings all normalize to one entry —
// `duration_ms`, `scroll_y`, and `raw_events` are caught alongside their camelCase
// twins.
const FORBIDDEN_KEYS = new Set([
  'scrollx',
  'scrolly',
  'scrolltop',
  'scrollleft',
  'clientx',
  'clienty',
  'pagex',
  'pagey',
  'screenx',
  'screeny',
  'touches',
  'touchpoints',
  'rawevents',
  'scrollpositions',
  'events',
  'trace',
  'dwellms',
  'durationms',
]);

/**
 * Throw if `value` (deep) contains any raw-trace-shaped key. Run on every
 * aggregate before it is queued or uploaded so a raw event can never egress.
 */
export function assertNoRawEgress(value: unknown, path = '$'): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      assertNoRawEgress(item, `${path}[${index}]`);
    });
    return;
  }
  if (value !== null && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      const normalizedKey = key.toLowerCase().replace(/[^a-z0-9]/g, '');
      if (FORBIDDEN_KEYS.has(normalizedKey)) {
        throw new Error(`Raw attention trace would egress: forbidden key "${key}" at ${path}`);
      }
      assertNoRawEgress(child, `${path}.${key}`);
    }
  }
}

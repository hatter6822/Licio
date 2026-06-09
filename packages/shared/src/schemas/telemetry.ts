// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Privacy-safe telemetry / RUM contract (WS-C observability notes; SPEC §19,
// §6.10). The client emits ONLY this constrained shape: a closed set of event
// names plus a coarse metric/bucket label and numeric value — never a URL, query
// string, user id, or free-form message. Route breadcrumbs carry the route
// PATTERN (e.g. `/stories/$storyId`), never the concrete path. The schema is the
// boundary guarantee on both client (before send) and server (on ingest).
import { z } from 'zod';
import { isoTimestampSchema } from './common.js';

/** The closed set of observability event names across WS-C tasks. */
export const TELEMETRY_EVENT_NAMES = [
  'navigation', // route change (bucket = route pattern, value = render ms)
  'route_guard', // metric = allowed | redirected | restricted | fail-closed
  'web_vital', // metric = LCP | INP | CLS, value, rating
  'interaction', // metric = branch-open | composer-open | draft-save, value ms, rating
  'query_error', // metric = error code, count
  'cache_stats', // value = storage usage bytes
  'eviction', // count = stores lost, value = usage bytes
  'queue_status', // count = queue depth, metric = sent | retried | failed
  'push_lifecycle', // metric = granted | denied | subscribed | unsubscribed | renewed | expired
  'feature_flags', // bucket = resolved flag summary (e.g. crypto-off,gov-off)
  'sw_health', // metric = activated, bucket = scope
] as const;
export type TelemetryEventName = (typeof TELEMETRY_EVENT_NAMES)[number];

export const telemetryRatingSchema = z.enum(['good', 'needs-improvement', 'poor']);

/**
 * One telemetry event. Fields are deliberately coarse and PII-free: `metric` and
 * `bucket` are short enum-like labels (≤64 chars), `value`/`count` are numeric.
 */
export const telemetryEventSchema = z.object({
  name: z.enum(TELEMETRY_EVENT_NAMES),
  /** Sub-metric label (e.g. 'LCP', 'branch-open', 'redirected'). */
  metric: z.string().max(64).optional(),
  /** A coarse, non-identifying label (route pattern, flag summary, scope). */
  bucket: z.string().max(64).optional(),
  /** Numeric measurement (ms, score, bytes). */
  value: z.number().finite().optional(),
  /** Web Vital / interaction-budget rating. */
  rating: telemetryRatingSchema.optional(),
  /** Non-negative count (queue depth, stores lost). */
  count: z.number().int().nonnegative().optional(),
  /** Emit time (ISO-8601). */
  at: isoTimestampSchema,
});
export type TelemetryEvent = z.infer<typeof telemetryEventSchema>;

/** A batch of telemetry events delivered via beacon. */
export const telemetryBatchSchema = z.object({
  events: z.array(telemetryEventSchema).max(100),
});
export type TelemetryBatch = z.infer<typeof telemetryBatchSchema>;

/** Ingest acknowledgment: the count of events accepted (mirrors attention ingest). */
export const telemetryIngestAckSchema = z.object({ accepted: z.number().int().nonnegative() });
export type TelemetryIngestAck = z.infer<typeof telemetryIngestAckSchema>;

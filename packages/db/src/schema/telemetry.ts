// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-P.1.1d Core Web Vitals RUM tables.  Two retention classes by design:
// `web_vital_samples` is short-lived working data (it exists only to compute
// the rolling-24h p75 and is swept ~1h after aging out of the window);
// `web_vital_aggregates` is the durable 90-day trend series behind regression
// detection.  Privacy: closed metric/device/connection enums (CHECKed), the
// route PATTERN only (never a URL), a numeric value — no user identifier, no
// IP, no attention/behavioral content (SPEC §19, §6.10).
import { sql } from 'drizzle-orm';
import { check, doublePrecision, index, integer, pgTable, text, uuid } from 'drizzle-orm/pg-core';
import { instant } from './_custom.js';

const METRIC_CHECK = sql.raw(`in ('LCP', 'INP', 'CLS')`);
const DEVICE_CHECK = sql.raw(`in ('low', 'mid', 'high', 'unknown')`);
const CONNECTION_CHECK = sql.raw(`in ('slow-2g', '2g', '3g', '4g', 'unknown')`);

export const webVitalSamples = pgTable(
  'web_vital_samples',
  {
    sampleId: uuid('sample_id').primaryKey().defaultRandom(),
    metric: text('metric').notNull(),
    deviceClass: text('device_class').notNull(),
    connection: text('connection').notNull(),
    /** The route PATTERN (e.g. `/stories/$storyId`), never a concrete path. */
    route: text('route').notNull(),
    value: doublePrecision('value').notNull(),
    createdAt: instant('created_at').notNull(),
  },
  (t) => [
    index('web_vital_samples_created_idx').on(t.createdAt),
    check('web_vital_samples_metric', sql`${t.metric} ${METRIC_CHECK}`),
    check('web_vital_samples_device', sql`${t.deviceClass} ${DEVICE_CHECK}`),
    check('web_vital_samples_connection', sql`${t.connection} ${CONNECTION_CHECK}`),
    check('web_vital_samples_value', sql`${t.value} >= 0`),
  ],
);

export const webVitalAggregates = pgTable(
  'web_vital_aggregates',
  {
    aggregateId: uuid('aggregate_id').primaryKey().defaultRandom(),
    metric: text('metric').notNull(),
    deviceClass: text('device_class').notNull(),
    connection: text('connection').notNull(),
    route: text('route').notNull(),
    p75: doublePrecision('p75').notNull(),
    sampleCount: integer('sample_count').notNull(),
    windowEnd: instant('window_end').notNull(),
  },
  (t) => [
    index('web_vital_aggregates_metric_idx').on(t.metric, t.windowEnd),
    check('web_vital_aggregates_metric', sql`${t.metric} ${METRIC_CHECK}`),
    check('web_vital_aggregates_device', sql`${t.deviceClass} ${DEVICE_CHECK}`),
    check('web_vital_aggregates_connection', sql`${t.connection} ${CONNECTION_CHECK}`),
    check('web_vital_aggregates_count', sql`${t.sampleCount} >= 1`),
  ],
);

export type WebVitalSampleRow = typeof webVitalSamples.$inferSelect;
export type WebVitalAggregateRow = typeof webVitalAggregates.$inferSelect;

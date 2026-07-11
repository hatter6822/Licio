// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Production Postgres adapters for the WS-P.1.1d Web Vitals stores, behind the
// same interfaces as the in-memory adapters (the house policy).  Samples are
// batch-inserted (one statement per beacon batch); the aggregation read is a
// single indexed range scan; sweeps are indexed range deletes.
import { type createDbClient, webVitalAggregates, webVitalSamples } from '@licio/db';
import { and, asc, eq, gte, lt } from 'drizzle-orm';
import type {
  WebVitalAggregate,
  WebVitalAggregateStore,
  WebVitalMetric,
  WebVitalSample,
  WebVitalSampleStore,
} from './stores.js';

type Db = ReturnType<typeof createDbClient>;

const iso = (d: Date): string => d.toISOString();

export class DrizzleWebVitalSampleStore implements WebVitalSampleStore {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  async insert(samples: readonly WebVitalSample[]): Promise<void> {
    if (samples.length === 0) return;
    await this.#db.insert(webVitalSamples).values(
      samples.map((s) => ({
        metric: s.metric,
        deviceClass: s.deviceClass,
        connection: s.connection,
        route: s.route,
        value: s.value,
        createdAt: new Date(s.at),
      })),
    );
  }

  async listSince(sinceIso: string): Promise<WebVitalSample[]> {
    const rows = await this.#db
      .select()
      .from(webVitalSamples)
      .where(gte(webVitalSamples.createdAt, new Date(sinceIso)));
    return rows.map((row) => ({
      metric: row.metric as WebVitalSample['metric'],
      deviceClass: row.deviceClass as WebVitalSample['deviceClass'],
      connection: row.connection as WebVitalSample['connection'],
      route: row.route,
      value: row.value,
      at: iso(row.createdAt),
    }));
  }

  async sweepBefore(beforeIso: string): Promise<number> {
    const rows = await this.#db
      .delete(webVitalSamples)
      .where(lt(webVitalSamples.createdAt, new Date(beforeIso)))
      .returning({ id: webVitalSamples.sampleId });
    return rows.length;
  }

  async clear(): Promise<void> {
    await this.#db.delete(webVitalSamples);
  }
}

export class DrizzleWebVitalAggregateStore implements WebVitalAggregateStore {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  async insert(aggregates: readonly WebVitalAggregate[]): Promise<void> {
    if (aggregates.length === 0) return;
    await this.#db.insert(webVitalAggregates).values(
      aggregates.map((a) => ({
        metric: a.metric,
        deviceClass: a.deviceClass,
        connection: a.connection,
        route: a.route,
        p75: a.p75,
        sampleCount: a.sampleCount,
        windowEnd: new Date(a.windowEnd),
      })),
    );
  }

  async listSeries(metric: WebVitalMetric, sinceIso: string): Promise<WebVitalAggregate[]> {
    const rows = await this.#db
      .select()
      .from(webVitalAggregates)
      .where(
        and(
          eq(webVitalAggregates.metric, metric),
          gte(webVitalAggregates.windowEnd, new Date(sinceIso)),
        ),
      )
      .orderBy(asc(webVitalAggregates.windowEnd), asc(webVitalAggregates.aggregateId));
    return rows.map((row) => ({
      metric: row.metric as WebVitalAggregate['metric'],
      deviceClass: row.deviceClass as WebVitalAggregate['deviceClass'],
      connection: row.connection as WebVitalAggregate['connection'],
      route: row.route,
      p75: row.p75,
      sampleCount: row.sampleCount,
      windowEnd: iso(row.windowEnd),
    }));
  }

  async sweepBefore(beforeIso: string): Promise<number> {
    const rows = await this.#db
      .delete(webVitalAggregates)
      .where(lt(webVitalAggregates.windowEnd, new Date(beforeIso)))
      .returning({ id: webVitalAggregates.aggregateId });
    return rows.length;
  }

  async clear(): Promise<void> {
    await this.#db.delete(webVitalAggregates);
  }
}

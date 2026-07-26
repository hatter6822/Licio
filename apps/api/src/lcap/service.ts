// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The process-wide LCAP ingestion server singleton (WS-R.12).  Durable state lives
// behind the `LcapServerStore` boundary: when `DATABASE_URL` is set the engine binds
// the Postgres adapter (WS-R.12.2); otherwise it falls back to the in-memory adapter
// (local/dev, the project's default).  The network id scopes COSE domain separation
// + the acceptance log; it defaults for local/dev and is overridable via
// `LCAP_NETWORK_ID`.

import { createDbClient } from '@licio/db';
import { createLogger } from '../lib/logger.js';
import { pgNoticeLogLevel } from '../lib/pg-notices.js';
import { DrizzleLcapServerStore } from './drizzle-store.js';
import {
  DrizzlePublishAuditStore,
  InMemoryPublishAuditStore,
  type PublishAuditStore,
} from './publish-audit.js';
import {
  drizzlePublishEligibility,
  type PublishEligibilityResolver,
} from './publish-eligibility.js';
import { LcapPublicPublisher } from './publisher.js';
import {
  type BlockPublishReviewStore,
  DrizzleBlockPublishReviewStore,
  InMemoryBlockPublishReviewStore,
} from './review-gate.js';
import { LcapIngestServer } from './server-ingest.js';
import { InMemoryLcapServerStore, type LcapServerStore } from './store.js';
import {
  type BlockProvenanceStore,
  DrizzleBlockProvenanceStore,
  drizzleTakedownOracle,
  InMemoryBlockProvenanceStore,
} from './takedown-oracle.js';

const DEFAULT_NETWORK_ID = 'licio';

let server: LcapIngestServer | undefined;
let publisher: LcapPublicPublisher | undefined | null;
let provenance: BlockProvenanceStore | undefined;
let reviewStore: BlockPublishReviewStore | undefined;
let publishAudit: PublishAuditStore | undefined;

/**
 * ONE Postgres client for every singleton in this module.
 *
 * Each getter below is an independent lazy singleton, and each used to call
 * `createDbClient(dbUrl)` for itself — six clients, and postgres.js gives each
 * its own pool of up to `max` (default 10) connections.  Six pools against the
 * same database, per API process, multiplied by the replica count, against a
 * server whose `max_connections` defaults to 100: the connection budget is the
 * scarce resource here, and none of these singletons needs isolation from the
 * others.  They are all process-wide, all built from the same `DATABASE_URL`,
 * and all long-lived, so they share one client.
 *
 * Memoized on the URL rather than on first call so a changed `DATABASE_URL`
 * (only a test does that) yields a client for the URL actually asked for
 * instead of silently reusing the old one.
 */
let sharedDb: { url: string; client: ReturnType<typeof createDbClient> } | undefined;

function dbClientFor(dbUrl: string): ReturnType<typeof createDbClient> {
  if (sharedDb?.url !== dbUrl) {
    // `onNotice` is passed for the same reason the main boot passes one: the db
    // wrapper ALWAYS installs its own `onnotice` (never postgres.js's
    // `console.log` default), so omitting the sink does not fall back to
    // anything — it DISCARDS every notice from every LCAP store.
    const logger = createLogger(process.env['LOG_LEVEL'] ?? 'info');
    sharedDb = {
      url: dbUrl,
      client: createDbClient(dbUrl, {
        onNotice: (notice) =>
          logger[pgNoticeLogLevel(notice.severity)]({ pgNotice: notice }, 'postgres notice (lcap)'),
      }),
    };
  }
  return sharedDb.client;
}

function buildStore(): LcapServerStore {
  const dbUrl = process.env['DATABASE_URL'];
  return dbUrl ? new DrizzleLcapServerStore(dbClientFor(dbUrl)) : new InMemoryLcapServerStore();
}

/** The shared ingestion server (created lazily on first use). */
export function getLcapIngestServer(): LcapIngestServer {
  if (!server) {
    const networkId = process.env['LCAP_NETWORK_ID'] ?? DEFAULT_NETWORK_ID;
    server = new LcapIngestServer(networkId, () => Date.now(), buildStore());
  }
  return server;
}

/** Replace the singleton (tests / an explicit binding). */
export function setLcapIngestServer(next: LcapIngestServer): void {
  server = next;
}

/**
 * Gate-19 (WS-R.15.7) — the shared public-block (re)publisher, or `undefined` when the
 * platform is NOT configured to bridge public blocks to an IPFS network.  The bridge is
 * OPT-IN: it needs both an IPFS gateway + a pinning endpoint AND a DB (the source of the
 * LIVE takedown state the republication-halt re-checks).  Absent any of these the factory
 * returns `undefined` — a node that does not run the public bridge simply has no publisher,
 * never a publisher that pins without the takedown re-check.  When configured, the publisher
 * is built ONCE with the live `drizzleTakedownOracle`, so every publish/republish re-checks
 * the real, current takedown state (fail-closed: an unreadable state halts).
 *
 * Env:
 *   LCAP_IPFS_GATEWAY_URL  — the IPFS HTTP gateway base (read path), e.g. `https://ipfs.io`.
 *   LCAP_IPFS_PINNING_URL  — the pinning/add HTTP endpoint (write path).
 *   DATABASE_URL           — required: the takedown oracle reads live `takedown_requests` and
 *                            the §22.7 review gate reads live `lcap_block_publish_review`.
 */
export function getLcapPublicPublisher(): LcapPublicPublisher | undefined {
  if (publisher !== undefined) return publisher ?? undefined;
  const gatewayUrl = process.env['LCAP_IPFS_GATEWAY_URL'];
  const pinningUrl = process.env['LCAP_IPFS_PINNING_URL'];
  const dbUrl = process.env['DATABASE_URL'];
  if (!gatewayUrl || !pinningUrl || !dbUrl) {
    publisher = null; // cache the "not configured" decision (memoized like the server)
    return undefined;
  }
  const db = dbClientFor(dbUrl);
  publisher = new LcapPublicPublisher({
    gatewayUrl,
    pinningUrl,
    takedownOracle: drizzleTakedownOracle(db),
    // The §22.7 review gate is REQUIRED — bind the SAME shared review store the steward-review
    // surface writes to, so a decision recorded there is the decision the gate enforces.
    reviewStore: getLcapBlockPublishReviewStore(),
  });
  return publisher;
}

let eligibility: PublishEligibilityResolver | undefined | null;

/**
 * Gate-19 — the SERVER-SIDE publish-eligibility resolver: derives a content target's REAL
 * visibility + storage mode from the live content model, so `handlePublish` never trusts
 * caller-supplied visibility/encryption signals.  Configured (over the live DB) whenever a DB
 * is available; `undefined` otherwise — and `handlePublish` treats an absent resolver as
 * fail-closed (it derives non-publishable signals so the gateway-eligibility guard refuses).
 */
export function getPublishEligibilityResolver(): PublishEligibilityResolver | undefined {
  if (eligibility !== undefined) return eligibility ?? undefined;
  const dbUrl = process.env['DATABASE_URL'];
  if (!dbUrl) {
    eligibility = null;
    return undefined;
  }
  eligibility = drizzlePublishEligibility(dbClientFor(dbUrl));
  return eligibility;
}

/** Replace the eligibility resolver (tests / an explicit binding). */
export function setPublishEligibilityResolver(next: PublishEligibilityResolver | undefined): void {
  eligibility = next ?? null;
}

/**
 * Gate-19 — the shared `block_cid → content-entity` provenance store: the gated Postgres
 * adapter when `DATABASE_URL` is set, else the in-memory adapter.  This is the REAL linkage
 * the takedown oracle resolves; the public-bridge publish path records into it so that a
 * later actioned takedown over the same content entity halts the block's republication.
 */
export function getLcapBlockProvenanceStore(): BlockProvenanceStore {
  if (!provenance) {
    const dbUrl = process.env['DATABASE_URL'];
    provenance = dbUrl
      ? new DrizzleBlockProvenanceStore(dbClientFor(dbUrl))
      : new InMemoryBlockProvenanceStore();
  }
  return provenance;
}

/**
 * Gate-19 (WS-R.15.7b) — the shared §22.7 review-decision store: the gated Postgres adapter
 * when `DATABASE_URL` is set, else the in-memory adapter.  The steward-review surface records
 * decisions here; the publisher's review gate reads them so an unreviewed block can never
 * reach the public DHT.
 */
export function getLcapBlockPublishReviewStore(): BlockPublishReviewStore {
  if (!reviewStore) {
    const dbUrl = process.env['DATABASE_URL'];
    reviewStore = dbUrl
      ? new DrizzleBlockPublishReviewStore(dbClientFor(dbUrl))
      : new InMemoryBlockPublishReviewStore();
  }
  return reviewStore;
}

/**
 * Gate-19 (WS-R.15.7b) — the shared append-only public-DHT (re)publish audit store: the gated
 * Postgres adapter when `DATABASE_URL` is set, else the in-memory adapter.  The route writes
 * one decision record per (re)publish ATTEMPT (pinned OR refused) so the §22.7 gate decision
 * is durably auditable.
 */
export function getLcapPublishAuditStore(): PublishAuditStore {
  if (!publishAudit) {
    const dbUrl = process.env['DATABASE_URL'];
    publishAudit = dbUrl
      ? new DrizzlePublishAuditStore(dbClientFor(dbUrl))
      : new InMemoryPublishAuditStore();
  }
  return publishAudit;
}

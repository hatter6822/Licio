// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The process-wide LCAP ingestion server singleton (WS-R.12).  Durable state lives
// behind the `LcapServerStore` boundary: when `DATABASE_URL` is set the engine binds
// the Postgres adapter (WS-R.12.2); otherwise it falls back to the in-memory adapter
// (local/dev, the project's default).  The network id scopes COSE domain separation
// + the acceptance log; it defaults for local/dev and is overridable via
// `LCAP_NETWORK_ID`.

import { createDbClient } from '@licio/db';
import { DrizzleLcapServerStore } from './drizzle-store.js';
import {
  DrizzlePublishAuditStore,
  InMemoryPublishAuditStore,
  type PublishAuditStore,
} from './publish-audit.js';
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

function buildStore(): LcapServerStore {
  const dbUrl = process.env['DATABASE_URL'];
  return dbUrl ? new DrizzleLcapServerStore(createDbClient(dbUrl)) : new InMemoryLcapServerStore();
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
  const db = createDbClient(dbUrl);
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

/** Replace the publisher singleton (tests / an explicit binding). */
export function setLcapPublicPublisher(next: LcapPublicPublisher | undefined): void {
  publisher = next ?? null;
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
      ? new DrizzleBlockProvenanceStore(createDbClient(dbUrl))
      : new InMemoryBlockProvenanceStore();
  }
  return provenance;
}

/** Replace the provenance store (tests / an explicit binding). */
export function setLcapBlockProvenanceStore(next: BlockProvenanceStore): void {
  provenance = next;
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
      ? new DrizzleBlockPublishReviewStore(createDbClient(dbUrl))
      : new InMemoryBlockPublishReviewStore();
  }
  return reviewStore;
}

/** Replace the review store (tests / an explicit binding). */
export function setLcapBlockPublishReviewStore(next: BlockPublishReviewStore): void {
  reviewStore = next;
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
      ? new DrizzlePublishAuditStore(createDbClient(dbUrl))
      : new InMemoryPublishAuditStore();
  }
  return publishAudit;
}

/** Replace the publish-audit store (tests / an explicit binding). */
export function setLcapPublishAuditStore(next: PublishAuditStore): void {
  publishAudit = next;
}

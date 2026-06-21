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
import { LcapIngestServer } from './server-ingest.js';
import { InMemoryLcapServerStore, type LcapServerStore } from './store.js';

const DEFAULT_NETWORK_ID = 'licio';

let server: LcapIngestServer | undefined;

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

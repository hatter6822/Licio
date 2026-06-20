// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The process-wide LCAP ingestion server singleton (WS-R.12).  In-memory by
// design — the project ships in-memory stores first, then gated Drizzle adapters;
// the Postgres-backed binding (WS-R.12.2) will replace the instance here behind
// the same accessor.  The network id scopes COSE domain separation + the room
// log; it defaults for local/dev and is overridable via `LCAP_NETWORK_ID`.

import { LcapIngestServer } from './server-ingest.js';

const DEFAULT_NETWORK_ID = 'licio';

let server: LcapIngestServer | undefined;

/** The shared ingestion server (created lazily on first use). */
export function getLcapIngestServer(): LcapIngestServer {
  if (!server) {
    server = new LcapIngestServer(process.env['LCAP_NETWORK_ID'] ?? DEFAULT_NETWORK_ID);
  }
  return server;
}

/** Replace the singleton (tests / the future Postgres binding). */
export function setLcapIngestServer(next: LcapIngestServer): void {
  server = next;
}

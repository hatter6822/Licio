// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-S.1.5 — `check:p2p-search-exclusion` (PRIVATE_SPEC §23.6/§23.10).  Server
// search indexing + queries include ONLY server-storage rooms (the in-memory
// filter + the Drizzle adapter's `storage_mode = 'server'` SQL predicate).
import {
  apiSource,
  findMissingMarkers,
  P2P_SEARCH_EXCLUSION_MARKERS,
  reportGate,
} from './private-p2p-gates.js';

reportGate(
  'check:p2p-search-exclusion',
  findMissingMarkers(P2P_SEARCH_EXCLUSION_MARKERS, apiSource),
);

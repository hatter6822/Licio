// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-S.1.5 — `check:p2p-ranking-exclusion` (PRIVATE_SPEC §23.5/§23.10).  Every
// ranking retriever (the global predicate + the room-surface scoper) must
// predicate `roomStorageMode === 'server'`, so a Private P2P room never enters
// a global/topic/room surface.
import {
  apiSource,
  findMissingMarkers,
  P2P_RANKING_EXCLUSION_MARKERS,
  reportGate,
} from './private-p2p-gates.js';

reportGate(
  'check:p2p-ranking-exclusion',
  findMissingMarkers(P2P_RANKING_EXCLUSION_MARKERS, apiSource),
);

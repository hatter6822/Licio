// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-S.1.5 — `check:no-p2p-server-content` (PRIVATE_SPEC §8/§23.10): the
// UMBRELLA doctrine gate that a Private P2P room can place NO content on the
// server.  It runs the structural column denylist (the stub/rendezvous tables)
// AND asserts the endpoint/ranking/search guards are all present — so the whole
// non-storage contract is one CI command.
import { checkPrivateServerTables } from '@licio/db';
import {
  apiSource,
  apiSourceFiles,
  findMissingMarkers,
  type GateViolation,
  P2P_ENDPOINT_REJECTION_MARKERS,
  P2P_RANKING_EXCLUSION_MARKERS,
  P2P_SEARCH_EXCLUSION_MARKERS,
  reportGate,
  scanNoServerRoomRecovery,
} from './private-p2p-gates.js';

const violations: GateViolation[] = [
  ...checkPrivateServerTables().map((v) => ({
    file: v.table,
    line: 0,
    detail: `${v.reason}: column "${v.column}"`,
  })),
  ...findMissingMarkers(
    [
      ...P2P_ENDPOINT_REJECTION_MARKERS,
      ...P2P_RANKING_EXCLUSION_MARKERS,
      ...P2P_SEARCH_EXCLUSION_MARKERS,
    ],
    apiSource,
  ),
  // §12.7 — no server-side private-room recovery endpoint may exist.
  ...scanNoServerRoomRecovery(apiSourceFiles()),
];
reportGate('check:no-p2p-server-content', violations);

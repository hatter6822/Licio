// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-S.1.5 — `check:p2p-endpoint-rejections` (PRIVATE_SPEC §23.3/§23.4/§23.10).
// Asserts the defensive endpoint guards are PRESENT: submission rejects a p2p
// room (409 p2p_room_requires_client_sync), the contribution path rejects a
// p2p-room thread, and the room feed returns p2p_room_local_only.
import {
  apiSource,
  findMissingMarkers,
  P2P_ENDPOINT_REJECTION_MARKERS,
  reportGate,
} from './private-p2p-gates.js';

reportGate(
  'check:p2p-endpoint-rejections',
  findMissingMarkers(P2P_ENDPOINT_REJECTION_MARKERS, apiSource),
);

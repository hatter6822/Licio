// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-S.1.5 — `check:private-rendezvous-schema` (PRIVATE_SPEC §8.1/§8.2/§23.10).
// The §8.1 forbiddance list is the COLUMN DENYLIST for the two private-room
// server tables: this gate introspects the live Drizzle definitions (the
// migration's source of truth) and FAILS if any column is outside the §8.2
// allowlist or trips a forbidden segment.  No private content/CID/op-head/
// member/key column can exist because the table would fail here.
import { checkPrivateServerTables } from '@licio/db';
import { type GateViolation, reportGate } from './private-p2p-gates.js';

const violations: GateViolation[] = checkPrivateServerTables().map((v) => ({
  file: v.table,
  line: 0,
  detail: `${v.reason}: column "${v.column}"${v.detail ? ` (${v.detail})` : ''}`,
}));
reportGate('check:private-rendezvous-schema', violations);

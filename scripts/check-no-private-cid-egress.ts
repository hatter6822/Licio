// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-S.1.5 — `check:no-private-cid-egress` (PRIVATE_SPEC §9.5/§23.10).  A
// private-room render/sync path must NEVER reference a public IPFS gateway or
// public routing for a private CID (the CID identifies ciphertext; a public
// gateway URL for it is unreachable by construction).  Scans every private
// source tree for the public-gateway/public-routing denylist (S.4.4 reuses it).
import { privateTreeFiles, reportGate, scanPublicGatewayEgress } from './private-p2p-gates.js';

reportGate('check:no-private-cid-egress', scanPublicGatewayEgress(privateTreeFiles()));

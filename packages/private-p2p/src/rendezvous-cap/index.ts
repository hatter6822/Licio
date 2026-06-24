// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-S Tier-2 rendezvous-cap public API — the anonymous-credential cap (BBS blind
// issuance + per-verifier pseudonyms) realizing "1 presence slot per device per
// (epoch, bucket)" without the server learning identity. Exposed on its OWN subpath
// (`@licio/private-p2p/rendezvous-cap`) so the server-side verify binding can import the
// cap WITHOUT pulling the room engine / MLS. See docs/private-p2p/TIER2-RENDEZVOUS-CAP.md.

export * from './coordinator.js';
export * from './credential.js';
export * from './poll-filter.js';
export * from './session.js';

// SPDX-License-Identifier: AGPL-3.0-or-later
//
// `@licio/private-p2p` — the Private P2P rooms (WS-S) confidentiality & authority
// plane (PRIVATE_SPEC).  A browser-safe, code-split workspace package: it holds
// the canonical encoding, schemas, crypto, IPLD/CID, reducer, and sync logic for
// end-to-end-encrypted rooms.  It depends on `@licio/shared` ONLY (never
// `@licio/db`, never `@licio/lcap`) — the two decentralization planes pin
// different crypto suites on purpose (Ed25519/MLS/HPKE here; ES256 in LCAP) and
// never share keys or code.  All heavy P2P/crypto dependencies (Helia/libp2p,
// MLS, HPKE, the memory-hard KDF) are declared HERE and loaded only from a lazy,
// code-split route chunk, so the core PWA's < 200 KB initial bundle never
// regresses (PRIVATE_SPEC §9.8).

export * from './crypto/index.js';
export * from './engine/index.js';
export * from './reducer/index.js';
export * from './schemas/index.js';
export * from './sync/index.js';

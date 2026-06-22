// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-S.3 — the private-rooms cryptographic foundation (PRIVATE_SPEC §10).  Every
// primitive here is a thin, vector-pinned wrapper over WebCrypto (§10.1
// principle 10) — no hand-written primitives, zero new runtime dependencies —
// and is independent of the MLS group-keying layer (WS-S.3.1a/b), which supplies
// the `room_epoch_secret` at the documented seam.

export * from './aead.js';
export * from './canonical.js';
export * from './hkdf.js';
export * from './hpke.js';
export * from './record-encoding.js';
export * from './runtime.js';
export * from './signatures.js';

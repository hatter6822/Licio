// SPDX-License-Identifier: AGPL-3.0-or-later
//
// @licio/lcap — the LCAP v0.2 protocol core (WS-R / Decentralized Data Plane,
// Part I).  A zero-runtime-dependency library implementing the Licio Content
// Availability Protocol's record + trust planes (OFFLINE_SPEC.md):
//
//   - the LCAP Deterministic CBOR profile (LDC, §9.1) — a hand-rolled, closed
//     grammar encoder/decoder so two conformant nodes produce byte-identical
//     bodies and a verifier can fail closed on any non-canonical input;
//   - content-addressed identifiers (CID, §9.2-9.4) over the deterministic
//     record/proof/block/chunk bytes;
//   - COSE_Sign1 detached ES256 proofs (§10) with low-S canonicalization,
//     domain separation, and downgrade-resistant suite negotiation;
//   - strict closed-schema records/proofs (§11-12) parsed in lockstep with the
//     wire bytes so the validated object and the signed bytes cannot diverge.
//
// The cryptographic + encoding core (`cbor/`, `cid/`, `cose/`) carries ZERO npm
// imports — SHA-256/ECDSA come from WebCrypto and the CBOR/COSE subset is
// hand-rolled (OFFLINE_SPEC §31.1).  Only the `schemas/` layer uses zod, the
// monorepo's normative schema baseline (OFFLINE_SPEC line 102 names the
// `packages/lcap/src/schemas/` zod schemas as normative).
export * from './block/index.js';
export * from './cbor/index.js';
export * from './checkpoint/index.js';
export * from './cid/index.js';
export * from './conflict/index.js';
export * from './cose/index.js';
export * from './identity/index.js';
export * from './liveness/index.js';
export * from './pack/index.js';
export * from './priority.js';
export * from './records/index.js';
export * from './scheduler/index.js';
export * from './schemas/index.js';
export * from './validate/index.js';

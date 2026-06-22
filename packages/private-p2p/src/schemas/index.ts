// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-S.2.3 — the strict private-room schemas (PRIVATE_SPEC §10, §12, §13, §19).
// Every schema is `.strict()` (unknown fields reject); forward compatibility is
// by schema-version bump only.  These are the single normative source.

export * from './attachment.js';
export * from './common.js';
export * from './envelope.js';
export * from './invite.js';
export * from './manifest.js';
export * from './ops.js';
export * from './report.js';
export * from './search.js';

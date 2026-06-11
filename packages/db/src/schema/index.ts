// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Drizzle schema barrel.  Identity/auth/privacy tables (WS-D) live in the public
// schema; the financial WalletAccount lives in a dedicated, isolated `wallet`
// schema (WS-D.3).  The schema-isolation test (WS-D.3.2) proves no FK/view join
// path bridges the wallet context and the ranking/attention context.

export * from './audit-log.js';
export * from './claim.js';
export * from './contribution.js';
export * from './embedding.js';
export * from './events.js';
export * from './ingestion-review.js';
export * from './invariants.js';
export * from './job-lease.js';
export * from './privacy.js';
export * from './room.js';
export * from './session.js';
export * from './source.js';
export * from './story.js';
export * from './summary.js';
export * from './takedown.js';
export * from './thread.js';
export * from './upload.js';
export * from './user.js';
export * from './wallet/wallet-account.js';
export * from './wallet-auth-credential.js';
export * from './webauthn-credential.js';

// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Financial WalletAccount (WS-D.3.1a, SPEC §22.2) — the Knomosis payments/
// governance wallet, in a DEDICATED `wallet` schema, bounded-context-isolated
// from ranking/attention.
//
// Isolation rule (WS-D.3.2): the `user_id` → identity-root edge is the ONLY
// outward reference from the wallet context.  No wallet column references any
// AttentionAggregate / InvariantOutput / ranking feature-store table, and no
// such table references a wallet table.  The schema-isolation test proves no
// join path can be written (structural enforcement of "no pay-to-rank", §17.1).
//
// The address is treated as personal data (§19.5): stored only as a keyed hash
// (distinct HMAC namespace from the auth-wallet) plus a truncated display form.
import { index, integer, pgSchema, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { bytea } from '../_custom.js';
import { users } from '../user.js';

export const walletSchema = pgSchema('wallet');

export const walletTypeEnum = walletSchema.enum('wallet_type', ['eoa', 'contract']);
export const unlinkStateEnum = walletSchema.enum('unlink_state', [
  'linked',
  'unlink_requested',
  'unlinked',
]);
export const walletRiskEnum = walletSchema.enum('wallet_risk_state', [
  'none',
  'flagged',
  'blocked',
]);

export const walletAccounts = walletSchema.table(
  'wallet_accounts',
  {
    walletAccountId: uuid('wallet_account_id').primaryKey().defaultRandom(),
    // The SINGLE permitted articulation edge: wallet context → identity root.
    userId: uuid('user_id')
      .notNull()
      .references(() => users.userId, { onDelete: 'cascade' }),
    addressHash: bytea('address_hash').notNull(), // HMAC(WALLET_KEY, lower(address))
    addressTruncated: text('address_truncated').notNull(),
    chainId: integer('chain_id').notNull(),
    walletType: walletTypeEnum('wallet_type').notNull(),
    unlinkState: unlinkStateEnum('unlink_state').notNull().default('linked'),
    riskState: walletRiskEnum('risk_state').notNull().default('none'),
    linkedAt: timestamp('linked_at', { withTimezone: true }).notNull().defaultNow(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
  },
  (t) => [
    index('wallet_accounts_user_idx').on(t.userId),
    uniqueIndex('wallet_accounts_addr_idx').on(t.addressHash),
  ],
);

export type WalletAccountRow = typeof walletAccounts.$inferSelect;

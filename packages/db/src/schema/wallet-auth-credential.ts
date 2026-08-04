// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Auth-wallet credential (WS-D.1.4c) — the IDENTITY-context Sign-In-with-Ethereum
// credential.  This is NOT the financial WalletAccount (wallet/Knomosis context,
// schema/wallet/wallet-account.ts): different bounded context, different HMAC key
// namespace (see the WS-D overview's "two kinds of wallet" note).
//
// `address_hash` is HMAC'd under the auth-domain key; only a truncated address is
// stored for display.  The full address is never persisted in plaintext (§19.5).
import { index, integer, pgEnum, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { bytea, instant } from './_custom.js';
import { users } from './user.js';

export const walletAuthTypeEnum = pgEnum('wallet_auth_type', ['eoa', 'contract']);

export const walletAuthCredentials = pgTable(
  'wallet_auth_credentials',
  {
    credentialId: uuid('credential_id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.userId, { onDelete: 'cascade' }),
    addressHash: bytea('address_hash').notNull(), // HMAC(AUTH_WALLET_KEY, lower(caip10))
    addressTruncated: text('address_truncated').notNull(), // display only, e.g. "0x12ab…cd34"
    chainId: integer('chain_id').notNull(),
    walletType: walletAuthTypeEnum('wallet_auth_type').notNull(),
    createdAt: instant('created_at').notNull().defaultNow(),
    lastUsedAt: instant('last_used_at'),
  },
  (t) => [
    // One auth-wallet → one account (login resolution).
    uniqueIndex('wallet_auth_addr_idx').on(t.addressHash),
    index('wallet_auth_user_idx').on(t.userId),
  ],
);

export type WalletAuthCredentialRow = typeof walletAuthCredentials.$inferSelect;

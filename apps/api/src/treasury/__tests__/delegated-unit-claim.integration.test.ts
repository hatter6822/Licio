// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Gated integration test (DATABASE_URL) for migration 0114 — one delegated unit,
// one ballot.
//
// This is the half the in-memory adapter cannot prove.  That adapter EMULATES the
// (proposal, delegator) primary key, which is exactly the kind of agreement that
// silently drifts, and the guarantee here is not the key alone: it is that a lost
// claim also rolls the SIGNATURE back.  A ballot that persisted weight for a unit
// it did not win is the same double count one row later, and only a real
// transaction can be asked whether it did.
//
// The race it closes: a member who splits an `all` delegation to one delegate and
// a `type:<proposal>` delegation to another lets both delegates resolve weight
// from the same uncommitted view.  Each pre-insert `delegatorsAlreadyConsumed`
// read comes back empty, and nothing else objects —
// `governance_signature_unique_idx` is keyed on the WALLET, and no unique index
// can constrain elements of a JSONB array across rows.
import { randomUUID } from 'node:crypto';
import { createDbClient, migrationsFolder } from '@licio/db';
import { sql } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DrizzleGovernanceSignatureStore } from '../../knomosis/drizzle-knomosis-stores.js';
import type { GovernanceSignatureRecord } from '../../knomosis/stores.js';

const DB_URL = process.env['DATABASE_URL'];

describe.skipIf(!DB_URL)('delegated-unit claims (live Postgres, migration 0114)', () => {
  let db: ReturnType<typeof createDbClient>;
  let store: DrizzleGovernanceSignatureStore;
  let userId: string;
  let walletA: string;
  let walletB: string;
  let proposalId: string;
  let roomId: string;

  beforeAll(async () => {
    db = createDbClient(DB_URL as string, { onNotice: 'discard' });
    await migrate(db, { migrationsFolder: migrationsFolder() });
    store = new DrizzleGovernanceSignatureStore(db);
    // Reuse whatever identity rows the migrated schema has: the FKs need real
    // users and wallets, and minting an identity graph would test nothing here.
    const users = await db.execute<{ user_id: string }>(sql`select user_id from users limit 1`);
    const firstUser = users[0];
    if (!firstUser) throw new Error('no user row available for the signature FKs');
    userId = firstUser.user_id;

    roomId = randomUUID();
    await db.execute(sql`
      insert into rooms (room_id, slug, name, room_type, visibility, join_model)
      values (${roomId}, ${`claim-${roomId.slice(0, 8)}`},
              ${`Claim fixture ${roomId.slice(0, 8)}`}, 'global_topic', 'public', 'open')
    `);
    proposalId = randomUUID();
    await db.execute(sql`
      insert into knomosis.governance_proposal
        (proposal_id, room_id, proposer_user_id, proposal_type, title,
         plain_language_summary, risk_assessment, requested_action, expected_deliverable)
      values (${proposalId}, ${roomId}, ${userId}, 'capped_grant', 'Claim fixture',
              'Two delegates, one delegated unit.', 'Low.', '{}'::jsonb, 'None.')
    `);
    const wallets = await db.execute<{ wallet_account_id: string }>(
      sql`select wallet_account_id from wallet.wallet_accounts where user_id = ${userId} limit 2`,
    );
    const mkWallet = async (): Promise<string> => {
      const id = randomUUID();
      await db.execute(sql`
        insert into wallet.wallet_accounts
          (wallet_account_id, user_id, address_hash, address_truncated, chain_id, wallet_type)
        values (${id}, ${userId},
                ${sql`decode(${randomUUID().replaceAll('-', '').padEnd(64, '0')}, 'hex')`},
                '0xabcd…4321', 1337, 'eoa')
      `);
      return id;
    };
    walletA = wallets[0]?.wallet_account_id ?? (await mkWallet());
    walletB = wallets[1]?.wallet_account_id ?? (await mkWallet());
    if (walletA === walletB) walletB = await mkWallet();
  });

  afterAll(async () => {
    // Leave the shared identity rows alone; drop only what this suite created.
    await db.execute(
      sql`delete from knomosis.governance_proposal where proposal_id = ${proposalId}`,
    );
    await db.execute(sql`delete from rooms where room_id = ${roomId}`);
    await db.$client.end();
  });

  function ballot(
    walletAccountId: string,
    delegators: readonly string[],
  ): GovernanceSignatureRecord {
    return {
      signatureId: randomUUID(),
      proposalId,
      userId,
      walletAccountId,
      signatureType: 'eip712_ecdsa',
      typedDataHash: `0x${'4'.repeat(64)}`,
      signatureRef: randomUUID(),
      weightSnapshot: '2',
      eligibilityReason: 'delegated',
      createdAt: new Date().toISOString(),
      // `approval`, not `vote`: `governance_signature_one_vote_uq` allows one VOTE
      // per (proposal, user), and this suite needs two ballots by one identity to
      // reach the claim conflict rather than stopping at that index.
      purpose: 'approval',
      choice: null,
      nonce: randomUUID(),
      countedDelegatorIds: delegators,
    };
  }

  const claimsFor = async (): Promise<string[]> => {
    const rows = await db.execute<{ delegator_user_id: string }>(
      sql`select delegator_user_id from knomosis.governance_delegated_unit_claim
          where proposal_id = ${proposalId} order by delegator_user_id`,
    );
    return rows.map((r) => r.delegator_user_id);
  };

  it('refuses the second ballot claiming a unit, and leaves NO signature behind', async () => {
    const first = await store.insert(ballot(walletA, [userId]));
    expect(first.ok).toBe(true);
    expect(await claimsFor()).toEqual([userId]);

    const second = await store.insert(ballot(walletB, [userId]));
    expect(second).toEqual({
      ok: false,
      reason: 'delegated_unit_claimed',
      delegatorUserIds: [userId],
    });
    // THE ROLLBACK, which is the part the in-memory adapter cannot vouch for: the
    // signature row inserted before the claims must be gone too.
    const signatures = await db.execute<{ n: string }>(
      sql`select count(*)::text as n from knomosis.governance_signature
          where proposal_id = ${proposalId}`,
    );
    expect(signatures[0]?.n).toBe('1');
    expect(await claimsFor()).toEqual([userId]);
  });

  it('releases the claims when the ballot is deleted (ON DELETE CASCADE)', async () => {
    // A ballot reverted by `removeByAction` or erased by `purgeByUser` MUST release
    // its units.  Without the cascade the delegator is disenfranchised for this
    // proposal for ever — a worse failure than the double count.
    expect(await claimsFor()).toEqual([userId]);
    await db.execute(sql`delete from knomosis.governance_signature
                         where proposal_id = ${proposalId}`);
    expect(await claimsFor()).toEqual([]);
    // …and the unit is claimable again.
    const retried = await store.insert(ballot(walletB, [userId]));
    expect(retried.ok).toBe(true);
    expect(await claimsFor()).toEqual([userId]);
  });
});

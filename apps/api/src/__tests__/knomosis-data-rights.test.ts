// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-L data-rights (review fix): the financial wallet footprint is folded into
// the WS-D DSAR export + hard-deletion lifecycle.  Export carries the TRUNCATED
// address only (never the hash); deletion purges wallets + actions + signatures
// + private receipts, leaving the ownerless public receipts intact.

import { afterEach, describe, expect, it } from 'vitest';
import { exportFinancialWalletData, purgeFinancialWalletData } from '../knomosis/data-rights.js';
import type {
  FinancialWalletRecord,
  GovernanceSignatureRecord,
  KnomosisActionRecordEntity,
  KnomosisReceiptRecord,
} from '../knomosis/stores.js';
import { freshKnomosisServices, resetKnomosisFixture } from './knomosis-test-helpers.js';

const USER = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const ROOM = '33333333-3333-4333-8333-333333333333';

afterEach(() => resetKnomosisFixture());

// A DISTINCT 64-hex address hash per wallet (the store rejects a duplicate).
const USER_HASH = 'a'.repeat(64);
const OTHER_HASH = 'b'.repeat(64);

function wallet(userId: string, id: string, addressHashHex: string): FinancialWalletRecord {
  return {
    walletAccountId: id,
    userId,
    addressHashHex,
    addressTruncated: '0x1234…5678',
    chainId: 8357,
    walletType: 'eoa',
    unlinkState: 'active',
    riskState: 'normal',
    label: 'Treasury key',
    linkedAt: '2026-07-01T00:00:00.000Z',
    lastUsedAt: null,
    unlinkRequestedAt: null,
    unlinkFinalizeAfter: null,
    unlinkedAt: null,
  };
}

function action(userId: string, id: string): KnomosisActionRecordEntity {
  return {
    actionRecordId: id,
    deploymentId: 'local',
    actionType: 'treasury_deposit',
    roomId: ROOM,
    actorWalletAccountId: 'w1',
    actorUserId: userId,
    payloadHash: '0xabc',
    typedDataHash: `0x${id}`,
    signedAction: { message: {}, signature: '0xsig' },
    submissionState: 'submitted',
    failureReason: null,
    indexedEventRef: null,
    reconciliationState: 'pending',
    idempotencyKey: `idem-${id}`,
    paymentIntentId: null,
    createdAt: '2026-07-01T00:00:00.000Z',
    updatedAt: '2026-07-01T00:00:00.000Z',
  };
}

function signature(userId: string, id: string): GovernanceSignatureRecord {
  return {
    signatureId: id,
    proposalId: `p-${id}`,
    userId,
    walletAccountId: 'w1',
    signatureType: 'eip712_ecdsa',
    typedDataHash: `0x${id}`,
    signatureRef: '0xsig',
    weightSnapshot: null,
    eligibilityReason: 'member',
    createdAt: '2026-07-01T00:00:00.000Z',
  };
}

function receipt(
  ownerUserId: string | null,
  id: string,
  kind: 'public' | 'private',
): KnomosisReceiptRecord {
  return {
    receiptId: id,
    actionRecordId: `a-${id}`,
    kind,
    payload: {},
    summaryPayloadHash: '0xhash',
    ownerUserId,
    finalState: 'finalized',
    createdAt: '2026-07-01T00:00:00.000Z',
    updatedAt: '2026-07-01T00:00:00.000Z',
  };
}

describe('WS-L financial wallet data-rights', () => {
  it('exports the user’s wallets (truncated) + private receipts, never the address hash', async () => {
    const { knomosis } = await freshKnomosisServices();
    await knomosis.wallets.insert(wallet(USER, 'w-user', USER_HASH));
    await knomosis.wallets.insert(wallet(OTHER, 'w-other', OTHER_HASH));
    await knomosis.receipts.upsert(receipt(USER, 'r-user', 'private'));
    await knomosis.receipts.upsert(receipt(OTHER, 'r-other', 'private'));

    const out = await exportFinancialWalletData(knomosis, USER);
    expect(out.wallets).toHaveLength(1);
    expect(out.receipts).toHaveLength(1);
    // Only the requesting user's rows; never the other user's.
    const json = JSON.stringify(out);
    expect(json).toContain('0x1234…5678');
    expect(json).not.toContain('w-other');
    expect(json).not.toContain('r-other');
    // The financial-domain address hash is NEVER exported (§19.5).
    expect(json).not.toContain(USER_HASH);
    expect(json).not.toContain(OTHER_HASH);
  });

  it('exports IN-FLIGHT / failed signed actions that never produced a receipt (R8-2)', async () => {
    const { knomosis } = await freshKnomosisServices();
    const nowIso = new Date().toISOString();
    // A `submitted` action the user holds — no receipt is written for it yet.
    await knomosis.actions.insert({
      actionRecordId: 'act-user',
      deploymentId: crypto.randomUUID(),
      actionType: 'treasury_deposit',
      roomId: crypto.randomUUID(),
      actorWalletAccountId: crypto.randomUUID(),
      actorUserId: USER,
      payloadHash: '0x',
      typedDataHash: '0xabc',
      signedAction: { message: { amount: '5', asset: 'USDC' }, signature: '0xsig' },
      submissionState: 'submitted',
      failureReason: null,
      indexedEventRef: null,
      reconciliationState: 'pending',
      idempotencyKey: crypto.randomUUID(),
      paymentIntentId: null,
      createdAt: nowIso,
      updatedAt: nowIso,
    });
    // Another user's action must NOT be exported.
    await knomosis.actions.insert({
      actionRecordId: 'act-other',
      deploymentId: crypto.randomUUID(),
      actionType: 'treasury_deposit',
      roomId: crypto.randomUUID(),
      actorWalletAccountId: crypto.randomUUID(),
      actorUserId: OTHER,
      payloadHash: '0x',
      typedDataHash: '0xdef',
      signedAction: { message: {}, signature: '0xother' },
      submissionState: 'submitted',
      failureReason: null,
      indexedEventRef: null,
      reconciliationState: 'pending',
      idempotencyKey: crypto.randomUUID(),
      paymentIntentId: null,
      createdAt: nowIso,
      updatedAt: nowIso,
    });
    const out = await exportFinancialWalletData(knomosis, USER);
    expect(out.signed_actions).toHaveLength(1);
    const json = JSON.stringify(out.signed_actions);
    expect(json).toContain('act-user');
    expect(json).toContain('0xsig');
    expect(json).not.toContain('act-other');
  });

  it('purges wallets + actions + signatures + private receipts; keeps public receipts + other users', async () => {
    const { knomosis } = await freshKnomosisServices();
    await knomosis.wallets.insert(wallet(USER, 'w-user', USER_HASH));
    await knomosis.wallets.insert(wallet(OTHER, 'w-other', OTHER_HASH));
    await knomosis.actions.insert(action(USER, 'a-user'));
    await knomosis.actions.insert(action(OTHER, 'a-other'));
    await knomosis.proposalSignatures.insert(signature(USER, 's-user'));
    await knomosis.proposalSignatures.insert(signature(OTHER, 's-other'));
    await knomosis.receipts.upsert(receipt(USER, 'r-priv', 'private'));
    await knomosis.receipts.upsert(receipt(null, 'r-pub', 'public'));

    await purgeFinancialWalletData(knomosis, USER);

    // The user's personal financial rows are gone.
    expect(await knomosis.wallets.listByUser(USER, true)).toHaveLength(0);
    expect(await knomosis.actions.getById('a-user')).toBeNull();
    expect(await knomosis.receipts.listPrivateForUser(USER, 10)).toHaveLength(0);
    // Another user's rows are untouched.
    expect(await knomosis.wallets.listByUser(OTHER, true)).toHaveLength(1);
    expect(await knomosis.actions.getById('a-other')).not.toBeNull();
    // The ownerless PUBLIC receipt (the public ledger) survives.
    const pub = await knomosis.receipts.getByAction('a-r-pub', 'public');
    expect(pub).not.toBeNull();
  });

  it('purge marks EVERY in-flight action even beyond a full page of terminal rows (O1)', async () => {
    const { knomosis } = await freshKnomosisServices();
    // 1000 TERMINAL rows with EARLIER timestamps — a full `listByActor(userId, 1000)`
    // page that would exclude anything sorted after them.
    for (let i = 0; i < 1000; i += 1) {
      await knomosis.actions.insert({
        ...action(USER, `term-${i}`),
        submissionState: 'finalized',
        typedDataHash: `0xterm${i}`,
        idempotencyKey: crypto.randomUUID(),
        createdAt: `2026-07-01T00:00:00.${String(i % 1000).padStart(3, '0')}Z`,
      });
    }
    // One IN-FLIGHT row with a LATER timestamp — it sorts PAST the 1000-row page, so
    // the old capped scan would delete it WITHOUT a `purged_action` marker.
    const inflightHash = '0xinflight';
    await knomosis.actions.insert({
      ...action(USER, 'inflight'),
      submissionState: 'accepted',
      typedDataHash: inflightHash,
      idempotencyKey: crypto.randomUUID(),
      createdAt: '2026-07-01T00:00:01.000Z',
    });

    await purgeFinancialWalletData(knomosis, USER);

    // The in-flight action's hash carries a `purged_action` marker, so a later gateway
    // event for it is recognised as legitimately deleted — never a critical orphan
    // that blocks treasury expansion forever (O1).
    const marker = await knomosis.reconciliation.latestForEntity(
      'action',
      `event-orphan:${inflightHash}`,
    );
    expect(marker?.outcome).toBe('match');
    expect((marker?.details as { kind?: string } | undefined)?.kind).toBe('purged_action');
    // A TERMINAL action gets NO marker (it can never receive a further event).
    expect(
      await knomosis.reconciliation.latestForEntity('action', 'event-orphan:0xterm0'),
    ).toBeNull();
  });

  it('purge is idempotent (a second run removes nothing more)', async () => {
    const { knomosis } = await freshKnomosisServices();
    await knomosis.wallets.insert(wallet(USER, 'w-user', USER_HASH));
    await purgeFinancialWalletData(knomosis, USER);
    await expect(purgeFinancialWalletData(knomosis, USER)).resolves.toBeUndefined();
    expect(await knomosis.wallets.listByUser(USER, true)).toHaveLength(0);
  });

  it('exports + erases the SIMULATED-GOVERNANCE personal rows (WS-L review fix)', async () => {
    const { knomosis } = await freshKnomosisServices();
    const now = '2026-07-01T00:00:00.000Z';
    // The user's own simulated proposal, vote, comprehension, audit + treasury
    // entry, and an anti-replay nonce.
    await knomosis.proposals.insert({
      proposalId: 'p-user',
      roomId: ROOM,
      proposerUserId: USER,
      proposalType: 'bounty',
      title: 't',
      plainLanguageSummary: 's',
      requestedAmount: null,
      asset: null,
      recipientRef: null,
      conflictDisclosures: null,
      riskAssessment: 'r',
      requestedAction: {},
      expectedDeliverable: 'd',
      preflightState: 'passed',
      votingState: 'open',
      challengeState: 'none',
      executionState: 'not_executed',
      simulationMode: true,
      executableAfter: null,
      createdAt: now,
      executedAt: null,
      executionClaimedAt: null,
    });
    // A separate OPEN proposal the user voted on (cast now requires it to be open).
    await knomosis.proposals.insert({
      proposalId: 'p-x',
      roomId: ROOM,
      proposerUserId: OTHER,
      proposalType: 'bounty',
      title: 't',
      plainLanguageSummary: 's',
      requestedAmount: null,
      asset: null,
      recipientRef: null,
      conflictDisclosures: null,
      riskAssessment: 'r',
      requestedAction: {},
      expectedDeliverable: 'd',
      preflightState: 'passed',
      votingState: 'open',
      challengeState: 'none',
      executionState: 'not_executed',
      simulationMode: true,
      executableAfter: null,
      createdAt: now,
      executedAt: null,
      executionClaimedAt: null,
    });
    await knomosis.votes.cast({
      proposalId: 'p-x',
      voterUserId: USER,
      choice: 'approve',
      castAt: now,
    });
    // ANOTHER member voted on the DELETING user's proposal — their vote must NOT
    // be cascade-deleted when the proposer is erased (R7-1).
    await knomosis.votes.cast({
      proposalId: 'p-user',
      voterUserId: OTHER,
      choice: 'reject',
      castAt: now,
    });
    await knomosis.comprehension.record(USER, 'v1', true, now);
    await knomosis.governanceAudit.append({
      entryId: 'aud-user',
      roomId: ROOM,
      actionType: 'proposal_created',
      actorUserId: USER,
      actionDetails: {},
      simulationMode: true,
      createdAt: now,
    });
    await knomosis.simTreasury.appendEntry({
      entryId: 'ent-user',
      roomId: ROOM,
      kind: 'deposit',
      asset: 'SIM-USDC',
      amount: '1',
      actorUserId: USER,
      proposalId: null,
      idempotencyKey: null,
      createdAt: now,
    });
    await knomosis.nonces.tryConsume(USER, 'local', 'n1');

    // Export carries the user's simulated-governance activity.
    const out = await exportFinancialWalletData(knomosis, USER);
    expect(out.simulated_proposals).toHaveLength(1);
    expect(out.simulated_votes).toHaveLength(1);
    expect(out.comprehension).toHaveLength(1);

    await purgeFinancialWalletData(knomosis, USER);

    // DELETED: the user's OWN votes / comprehension / nonces.
    expect(await knomosis.votes.listByVoter(USER)).toHaveLength(0);
    expect(await knomosis.comprehension.listByUser(USER)).toHaveLength(0);
    expect(await knomosis.nonces.isUsed(USER, 'local', 'n1')).toBe(false);
    // ANONYMIZED (row kept, actor scrubbed): the append-only ledgers AND the
    // authored proposal — the proposal is NOT deleted, so it no longer surfaces
    // by proposer but the row + OTHER members' votes survive (R7-1).
    expect(await knomosis.proposals.listByProposer(USER)).toHaveLength(0);
    const proposal = await knomosis.proposals.getById('p-user');
    expect(proposal).not.toBeNull();
    expect(proposal?.proposerUserId).toBeNull();
    expect(await knomosis.votes.listByVoter(OTHER)).toHaveLength(1); // co-participant preserved
    const audit = await knomosis.governanceAudit.listByRoom(ROOM, 10);
    expect(audit.find((a) => a.entryId === 'aud-user')?.actorUserId).toBeNull();
    const entries = await knomosis.simTreasury.listEntries(ROOM, 10);
    expect(entries.find((e) => e.entryId === 'ent-user')?.actorUserId).toBeNull();
  });
});

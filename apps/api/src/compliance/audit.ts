// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-N.1.1g + WS-N.2.1c — the two compliance hash chains, built on the SHARED
// chain engine (`lib/hash-chain.ts`, the same machinery as the WS-M treasury
// audit).  Preimages cover EVERY attribution field (the W13 lesson: a row
// must not be re-attributable while the chain still verifies), and actors are
// stored as NON-REVERSIBLE refs so right-to-erasure never mutates a hashed
// column — the chains verify forever.
import { createHash } from 'node:crypto';
import { canonicalize } from '@licio/governance';
import {
  type ChainVerification,
  MAX_CHAIN_RETRIES,
  verifyChainEntries,
} from '../lib/hash-chain.js';
import {
  type CaseAuditRecord,
  type CaseAuditStore,
  ChainContentionError,
  type ComplianceTransactor,
  type ComplianceTxStores,
  type PolicyAuditRecord,
  type PolicyAuditStore,
} from './stores.js';

type Clock = () => number;

const sha256hex = (preimage: string): string =>
  `0x${createHash('sha256').update(preimage, 'utf8').digest('hex')}`;

// ---------------------------------------------------------------------------
// The policy change chain (WS-N.1.1g) — one global chain.
// ---------------------------------------------------------------------------

export function computePolicyAuditHash(entry: Omit<PolicyAuditRecord, 'integrityHash'>): string {
  return sha256hex(
    [
      entry.prevHash ?? 'genesis',
      entry.changeType,
      canonicalize(entry.newValue),
      canonicalize(entry.previousValue ?? null),
      entry.reason,
      entry.approvalRef ?? '-',
      entry.createdAt,
      entry.policyId,
      entry.countryOrRegion,
      entry.changedByRef,
    ].join('\n'),
  );
}

export interface PolicyAuditInput {
  policyId: string;
  countryOrRegion: string;
  changeType: 'create' | 'update' | 'deactivate';
  changedByRef: string;
  previousValue: unknown | null;
  newValue: unknown;
  reason: string;
  approvalRef: string | null;
}

/**
 * Run a unit of work that appends to a chain, replaying it when a concurrent
 * writer takes the parent slot.
 *
 * The retry lives OUT here, around the whole transaction, because that is the
 * only place it can: the fork is arbitrated by a partial unique, and a unique
 * violation poisons a Postgres transaction — nothing further can run inside
 * it.  So the unit aborts, rolls back cleanly, and replays against the new
 * head.  Every write in `work` therefore either commits WITH its chain entry
 * or leaves no trace, which is the guarantee compensators could only
 * approximate.
 */
export async function runChainedUnit<T>(
  transactor: ComplianceTransactor,
  work: (stores: ComplianceTxStores) => Promise<T>,
  label: string,
  maxRetries: number = MAX_CHAIN_RETRIES,
): Promise<T> {
  for (let attempt = 0; attempt < maxRetries; attempt += 1) {
    try {
      return await transactor.run(work);
    } catch (error) {
      if (error instanceof ChainContentionError) continue;
      throw error;
    }
  }
  throw new Error(`${label} chain contended after ${maxRetries} attempts`);
}

/**
 * Append a policy-change entry INSIDE a unit of work.  A fork raises, aborting
 * the unit so `runChainedUnit` can replay the policy write with it.
 */
export async function appendPolicyAuditInTx(
  stores: Pick<ComplianceTxStores, 'policyAudit'>,
  deps: { now: Clock; uuid: () => string },
  input: PolicyAuditInput,
): Promise<PolicyAuditRecord> {
  const head = await stores.policyAudit.chainHead();
  const createdAt = new Date(deps.now()).toISOString();
  const base = {
    changeId: deps.uuid(),
    policyId: input.policyId,
    countryOrRegion: input.countryOrRegion,
    changeType: input.changeType,
    changedByRef: input.changedByRef,
    previousValue: input.previousValue,
    newValue: input.newValue,
    reason: input.reason,
    approvalRef: input.approvalRef,
    prevHash: head?.integrityHash ?? null,
    createdAt,
  };
  const written = await stores.policyAudit.appendChained({
    ...base,
    integrityHash: computePolicyAuditHash(base),
  });
  if (written === null) throw new ChainContentionError('jurisdiction policy audit');
  return written;
}

export async function verifyPolicyAuditChain(deps: {
  policyAudit: PolicyAuditStore;
}): Promise<ChainVerification> {
  const entries = await deps.policyAudit.listChained();
  return verifyChainEntries(entries, {
    id: (entry) => entry.changeId,
    recompute: (entry) => computePolicyAuditHash(entry),
  });
}

// ---------------------------------------------------------------------------
// The per-case review chain (WS-N.2.1c).
// ---------------------------------------------------------------------------

export function computeCaseAuditHash(entry: Omit<CaseAuditRecord, 'integrityHash'>): string {
  return sha256hex(
    [
      entry.prevHash ?? 'genesis',
      entry.action,
      entry.caseId,
      entry.actorRef,
      entry.beforeState ?? '-',
      entry.afterState ?? '-',
      entry.note ?? '-',
      entry.createdAt,
    ].join('\n'),
  );
}

export interface CaseAuditInput {
  caseId: string;
  action: string;
  actorRef: string;
  beforeState: string | null;
  afterState: string | null;
  note: string | null;
}

/**
 * Append a case entry INSIDE a unit of work.  A fork raises, aborting the unit
 * so `runChainedUnit` replays the mutation and its entry together.
 */
export async function appendCaseAuditInTx(
  stores: Pick<ComplianceTxStores, 'caseAudit'>,
  deps: { now: Clock; uuid: () => string },
  input: CaseAuditInput,
): Promise<CaseAuditRecord> {
  const head = await stores.caseAudit.chainHead(input.caseId);
  const createdAt = new Date(deps.now()).toISOString();
  const base = {
    auditId: deps.uuid(),
    caseId: input.caseId,
    action: input.action,
    actorRef: input.actorRef,
    beforeState: input.beforeState,
    afterState: input.afterState,
    note: input.note,
    prevHash: head?.integrityHash ?? null,
    createdAt,
  };
  const written = await stores.caseAudit.appendChained({
    ...base,
    integrityHash: computeCaseAuditHash(base),
  });
  if (written === null) throw new ChainContentionError('compliance case audit');
  return written;
}

/**
 * Append a case entry that stands ALONE (the retention sweep's own record of
 * what it did).  Opens its own unit so it is still atomic + fork-safe.
 */
export async function appendCaseAudit(
  deps: { transactor: ComplianceTransactor; now: Clock; uuid: () => string },
  input: CaseAuditInput,
): Promise<CaseAuditRecord> {
  return runChainedUnit(
    deps.transactor,
    (stores) => appendCaseAuditInTx(stores, deps, input),
    'compliance case audit',
  );
}

export async function verifyCaseAuditChain(
  deps: { caseAudit: CaseAuditStore },
  caseId: string,
): Promise<ChainVerification> {
  const entries = await deps.caseAudit.listChained(caseId);
  return verifyChainEntries(entries, {
    id: (entry) => entry.auditId,
    recompute: (entry) => computeCaseAuditHash(entry),
  });
}

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
  appendChainedWithRetry,
  type ChainVerification,
  verifyChainEntries,
} from '../lib/hash-chain.js';
import type {
  CaseAuditRecord,
  CaseAuditStore,
  PolicyAuditRecord,
  PolicyAuditStore,
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

export async function appendPolicyAudit(
  deps: { policyAudit: PolicyAuditStore; now: Clock; uuid: () => string },
  input: PolicyAuditInput,
): Promise<PolicyAuditRecord> {
  return appendChainedWithRetry<PolicyAuditRecord>(
    {
      chainHead: () => deps.policyAudit.chainHead(),
      appendChained: (entry) => deps.policyAudit.appendChained(entry),
    },
    (prevHash) => {
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
        prevHash,
        createdAt,
      };
      return { ...base, integrityHash: computePolicyAuditHash(base) };
    },
    'jurisdiction policy audit',
  );
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

export async function appendCaseAudit(
  deps: { caseAudit: CaseAuditStore; now: Clock; uuid: () => string },
  input: CaseAuditInput,
): Promise<CaseAuditRecord> {
  return appendChainedWithRetry<CaseAuditRecord>(
    {
      chainHead: () => deps.caseAudit.chainHead(input.caseId),
      appendChained: (entry) => deps.caseAudit.appendChained(entry),
    },
    (prevHash) => {
      const createdAt = new Date(deps.now()).toISOString();
      const base = {
        auditId: deps.uuid(),
        caseId: input.caseId,
        action: input.action,
        actorRef: input.actorRef,
        beforeState: input.beforeState,
        afterState: input.afterState,
        note: input.note,
        prevHash,
        createdAt,
      };
      return { ...base, integrityHash: computeCaseAuditHash(base) };
    },
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

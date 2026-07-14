// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-M.4.3c — the hash-chained governance audit writer.  Every WS-M state
// transition appends a CHAINED entry to the shipped `governance_audit_log`:
// integrity_hash = 0x-SHA-256(prevHash ‖ actionType ‖ canonical(details) ‖
// createdAt ‖ roomId), with the previous entry's hash as the parent.  The
// fork-proof partial uniques from migration 0082 make two concurrent appends
// COLLIDE instead of silently forking; the writer re-reads the head and
// retries (bounded).  Entries are written SYNCHRONOUSLY with the action —
// never through an async queue that could lose them — and `details` must
// never contain on-chain-prohibited data (attention, reports, minors, PII);
// callers pass structured refs only.

import { createHash } from 'node:crypto';
import { canonicalize } from '@licio/governance';
import type { GovernanceAuditActionType } from '@licio/shared';
import type { GovernanceAuditRecord, GovernanceAuditStore } from '../knomosis/stores.js';

export interface AuditChainDeps {
  governanceAudit: GovernanceAuditStore;
  now: () => number;
  uuid: () => string;
}

export interface ChainedAuditInput {
  roomId: string;
  actionType: GovernanceAuditActionType;
  actorUserId: string | null;
  /** Structured payload — refs and states only, never prohibited data. */
  details: Record<string, unknown>;
  proposalId?: string | null;
  treasuryId?: string | null;
}

/** The deterministic entry hash (verifiable by anyone with the row).  The
 *  hash covers the ATTRIBUTION fields too — actor + proposal/treasury refs —
 *  or a row could be re-attributed to a different actor/target while the
 *  chain still verified (W13). */
export function computeEntryHash(
  prevHash: string | null,
  actionType: string,
  details: Record<string, unknown>,
  createdAt: string,
  roomId: string,
  actorUserId: string | null,
  proposalId: string | null,
  treasuryId: string | null,
): string {
  const digest = createHash('sha256')
    .update(
      `${prevHash ?? 'genesis'}\n${actionType}\n${canonicalize(details)}\n${createdAt}\n${roomId}\n${actorUserId ?? '-'}\n${proposalId ?? '-'}\n${treasuryId ?? '-'}`,
      'utf8',
    )
    .digest('hex');
  return `0x${digest}`;
}

const MAX_CHAIN_RETRIES = 8;

/**
 * Append one chained entry.  Retries on head contention (another writer won
 * the parent slot); throws when contention persists past the bound — the
 * caller's transition fails loudly rather than losing its audit record.
 */
export async function appendChainedAudit(
  deps: AuditChainDeps,
  input: ChainedAuditInput,
): Promise<GovernanceAuditRecord> {
  for (let attempt = 0; attempt < MAX_CHAIN_RETRIES; attempt += 1) {
    const head = await deps.governanceAudit.chainHead(input.roomId);
    const prevHash = head?.integrityHash ?? null;
    // The version must advance even under a static test clock so two same-ms
    // appends still hash distinctly through their parent linkage.
    const createdAt = new Date(deps.now()).toISOString();
    const entry: GovernanceAuditRecord = {
      entryId: deps.uuid(),
      roomId: input.roomId,
      actionType: input.actionType,
      actorUserId: input.actorUserId,
      actionDetails: input.details,
      simulationMode: false,
      createdAt,
      prevHash,
      integrityHash: computeEntryHash(
        prevHash,
        input.actionType,
        input.details,
        createdAt,
        input.roomId,
        input.actorUserId,
        input.proposalId ?? null,
        input.treasuryId ?? null,
      ),
      proposalId: input.proposalId ?? null,
      treasuryId: input.treasuryId ?? null,
    };
    const written = await deps.governanceAudit.appendChained(entry);
    if (written !== null) return written;
  }
  throw new Error(`governance audit chain contended after ${MAX_CHAIN_RETRIES} attempts`);
}

export interface ChainVerification {
  valid: boolean;
  chainedEntries: number;
  problems: string[];
}

/**
 * Recompute and verify a room's whole chain (WS-M.4.3c): every entry's hash
 * must recompute from its own fields, every non-genesis entry's parent must
 * exist, and the linkage must form ONE path (no gaps, no orphans).
 */
export async function verifyAuditChain(
  deps: Pick<AuditChainDeps, 'governanceAudit'>,
  roomId: string,
): Promise<ChainVerification> {
  const entries = await deps.governanceAudit.listChainedByRoom(roomId);
  const problems: string[] = [];
  const byHash = new Map<string, GovernanceAuditRecord>();
  for (const entry of entries) {
    if (entry.integrityHash === undefined || entry.integrityHash === null) continue;
    const recomputed = computeEntryHash(
      entry.prevHash ?? null,
      entry.actionType,
      entry.actionDetails,
      entry.createdAt,
      entry.roomId,
      entry.actorUserId ?? null,
      entry.proposalId ?? null,
      entry.treasuryId ?? null,
    );
    if (recomputed !== entry.integrityHash) {
      problems.push(`entry ${entry.entryId}: stored hash does not recompute (tamper evidence)`);
    }
    byHash.set(entry.integrityHash, entry);
  }
  const genesis = entries.filter((e) => (e.prevHash ?? null) === null);
  if (entries.length > 0 && genesis.length !== 1) {
    problems.push(`expected exactly one genesis entry, found ${genesis.length}`);
  }
  for (const entry of entries) {
    const prev = entry.prevHash ?? null;
    if (prev !== null && !byHash.has(prev)) {
      problems.push(`entry ${entry.entryId}: parent ${prev} is missing (deletion gap)`);
    }
  }
  // Walk from genesis: the path must cover every chained entry (one chain).
  if (genesis.length === 1 && problems.length === 0) {
    const children = new Map<string, GovernanceAuditRecord>();
    for (const entry of entries) {
      const prev = entry.prevHash ?? null;
      if (prev !== null) children.set(prev, entry);
    }
    let cursor: GovernanceAuditRecord | undefined = genesis[0];
    let walked = 0;
    while (cursor !== undefined && walked <= entries.length) {
      walked += 1;
      cursor =
        cursor.integrityHash !== undefined && cursor.integrityHash !== null
          ? children.get(cursor.integrityHash)
          : undefined;
    }
    if (walked !== entries.length) {
      problems.push(`chain walk covered ${walked} of ${entries.length} entries (fork or orphan)`);
    }
  }
  return { valid: problems.length === 0, chainedEntries: entries.length, problems };
}

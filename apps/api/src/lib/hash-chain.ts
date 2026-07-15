// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The generic hash-chain engine (extracted from the WS-M treasury audit
// writer so WS-N reuses the SAME machinery rather than growing a second,
// divergent chain implementation).  Semantics are exactly the shipped
// `treasury/audit-chain.ts` behavior:
//
//   • append: re-read the head, build the entry against its hash, and let the
//     store's fork-proof partial uniques arbitrate — a parent collision
//     returns null and the writer retries (bounded), so two concurrent
//     appends COLLIDE instead of silently forking.  Contention past the bound
//     throws: the caller's transition fails loudly rather than losing its
//     audit record.
//   • verify: every entry's hash must recompute from its own fields, exactly
//     one genesis must exist, every parent must exist, and the genesis walk
//     must cover every entry (fork/orphan detection).
//
// The hash PREIMAGE stays with each caller (treasury's `computeEntryHash` is
// unchanged — existing chains keep verifying); this module owns only the
// retry/verify control flow.

export interface ChainedEntryBase {
  prevHash?: string | null;
  integrityHash?: string | null;
}

export interface ChainAppendOps<E extends ChainedEntryBase> {
  /** The current chain head (the entry whose hash the next entry links). */
  chainHead(): Promise<E | null>;
  /** Append; null ⇔ the parent slot was taken by a concurrent writer. */
  appendChained(entry: E): Promise<E | null>;
}

export const MAX_CHAIN_RETRIES = 8;

/**
 * Append one chained entry, retrying on head contention.  `build` receives
 * the head hash (null for genesis) and must return a fully-hashed entry.
 */
export async function appendChainedWithRetry<E extends ChainedEntryBase>(
  ops: ChainAppendOps<E>,
  build: (prevHash: string | null) => E,
  label: string,
  maxRetries: number = MAX_CHAIN_RETRIES,
): Promise<E> {
  for (let attempt = 0; attempt < maxRetries; attempt += 1) {
    const head = await ops.chainHead();
    const prevHash = head?.integrityHash ?? null;
    const written = await ops.appendChained(build(prevHash));
    if (written !== null) return written;
  }
  throw new Error(`${label} chain contended after ${maxRetries} attempts`);
}

export interface ChainVerification {
  valid: boolean;
  chainedEntries: number;
  problems: string[];
}

/**
 * Recompute and verify a whole chain.  `recompute` re-derives the hash from
 * the entry's own fields (the caller's preimage); `id` labels problems.
 */
export function verifyChainEntries<E extends ChainedEntryBase>(
  entries: readonly E[],
  opts: { id: (entry: E) => string; recompute: (entry: E) => string },
): ChainVerification {
  const problems: string[] = [];
  const byHash = new Map<string, E>();
  for (const entry of entries) {
    if (entry.integrityHash === undefined || entry.integrityHash === null) continue;
    if (opts.recompute(entry) !== entry.integrityHash) {
      problems.push(`entry ${opts.id(entry)}: stored hash does not recompute (tamper evidence)`);
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
      problems.push(`entry ${opts.id(entry)}: parent ${prev} is missing (deletion gap)`);
    }
  }
  // Walk from genesis: the path must cover every chained entry (one chain).
  if (genesis.length === 1 && problems.length === 0) {
    const children = new Map<string, E>();
    for (const entry of entries) {
      const prev = entry.prevHash ?? null;
      if (prev !== null) children.set(prev, entry);
    }
    let cursor: E | undefined = genesis[0];
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

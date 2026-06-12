// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-I.1.1b — diversity quotas over the merged candidate pool (SPEC §13.2:
// "preserve a minimum quota of fresh, independent, and local sources to
// prevent personalization collapse"). Enforced AFTER retrieval and BEFORE
// ranking: when the pool must be trimmed to the budget, slots are reserved
// for each quota class so the ranker always operates on a sufficiently
// diverse pool. When the pool simply lacks enough class members (a new user,
// no location set), the system degrades gracefully and the shortfall is
// logged with the request id (never an error).
//
// Class definitions:
//   fresh        the candidate's SOURCE is one the user has not seen before
//                (computed from the user's OWN seen history only — §19)
//   independent  the candidate's source is not a confirmed syndication copy
//                (WS-F syndication model / MERI lineage)
//   local        produced by the local-news retriever (user-configured
//                location scope)

import type { Candidate, QuotaOutcome, RankingProfileConfig } from '@licio/ranking';

export interface CandidateClassification {
  fresh: boolean;
  independent: boolean;
  local: boolean;
}

export interface QuotaResult {
  pool: Candidate[];
  outcomes: QuotaOutcome[];
}

const pctOf = (count: number, total: number): number =>
  total === 0 ? 0 : Math.round((count / total) * 1000) / 10;

/**
 * Apply the budget with reserved quota slots. Deterministic: candidates are
 * already merge-ordered (score desc, freshness desc, id) by the orchestrator.
 */
export function applyQuotas(
  ordered: readonly Candidate[],
  classify: (candidate: Candidate) => CandidateClassification,
  quotas: RankingProfileConfig['quotas'],
  budget: number,
  options: { localQuotaApplies: boolean },
): QuotaResult {
  const cap = Math.max(1, Math.floor(budget));
  const classes = new Map<string, CandidateClassification>(
    ordered.map((c) => [c.item_id, classify(c)]),
  );
  // A MINIMUM percentage needs ceil: 15% of a 10-slot budget is 2 reserved
  // slots (floor would reserve 1 = 10%, silently under the quota).
  const reserved = {
    fresh: Math.ceil((quotas.fresh_min_pct / 100) * cap),
    independent: Math.ceil((quotas.independent_min_pct / 100) * cap),
    local: options.localQuotaApplies ? Math.ceil((quotas.local_min_pct / 100) * cap) : 0,
  };

  // Pass 1: take the top of the pool up to the budget.
  const selected: Candidate[] = ordered.slice(0, cap);
  const selectedIds = new Set(selected.map((c) => c.item_id));

  // Pass 2: for each under-represented class, swap in the best remaining
  // class members for the lowest-ranked non-class members (preserves the
  // budget; deterministic because both sides are rank-ordered).
  const classCount = (klass: keyof CandidateClassification): number =>
    selected.filter((c) => classes.get(c.item_id)?.[klass] === true).length;
  for (const klass of ['fresh', 'independent', 'local'] as const) {
    let need = reserved[klass] - classCount(klass);
    if (need <= 0) continue;
    const candidatesOutside = ordered.filter(
      (c) => !selectedIds.has(c.item_id) && classes.get(c.item_id)?.[klass] === true,
    );
    for (const incoming of candidatesOutside) {
      if (need <= 0) break;
      // Lowest-ranked selected item NOT in this class (and not protecting
      // another under-filled class) leaves the pool.
      const outgoing = [...selected]
        .reverse()
        .find((c) => classes.get(c.item_id)?.[klass] !== true);
      if (outgoing === undefined) break;
      selected.splice(selected.indexOf(outgoing), 1);
      selectedIds.delete(outgoing.item_id);
      selected.push(incoming);
      selectedIds.add(incoming.item_id);
      need -= 1;
    }
  }

  const total = selected.length;
  const outcomes: QuotaOutcome[] = (
    [
      ['fresh', quotas.fresh_min_pct],
      ['independent', quotas.independent_min_pct],
      ['local', options.localQuotaApplies ? quotas.local_min_pct : 0],
    ] as const
  ).map(([klass, target]) => {
    const achieved = pctOf(
      selected.filter((c) => classes.get(c.item_id)?.[klass] === true).length,
      total,
    );
    return {
      quota_type: klass,
      target_pct: target,
      achieved_pct: Math.min(100, achieved),
      shortfall: achieved < target,
    };
  });

  return { pool: selected, outcomes };
}

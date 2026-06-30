// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Gate-19 — the takedown-driven republication halt (OFFLINE_SPEC §22.7, §36 gate 19).
//
// The §22.7 public-block bridge MUST enforce a "takedown-driven republication halt": a
// block whose source has been taken down can never be re-pinned/re-announced to the
// public DHT.  The original `decideBlockPublish` consumed `takenDown` as a one-shot
// caller boolean, which a stale `BlockPublishInput` could carry past a takedown that
// landed AFTER the input was assembled.  This module adds the two missing structural
// pieces:
//
//   1. `takedownInForce(status)` — the policy rule mapping a WS-J takedown status to a
//      halt/allow decision (the status enum mirrors `packages/db` `takedownStatusEnum`;
//      we cannot import `@licio/db` here — the workspace-boundary gate forbids it — so the
//      enum is restated and pinned by test).
//
//   2. A publish-time re-check SEAM (`TakedownOracle`) consulted AT PUBLISH TIME, so a
//      stale `takenDown` flag in a `BlockPublishInput` cannot bypass the live state.  The
//      re-check is FAIL-CLOSED: an oracle that throws, or an unset oracle on a republish,
//      refuses to publish.
//
//   3. `republicationSet(...)` — the pure "republication loop" decision core: given the
//      currently-pinned block CIDs and the oracle, compute which CIDs are eligible to
//      re-pin (taken-down ones excluded, oracle errors excluded — fail-closed).  No I/O;
//      the actual scheduler/DB wiring (the query over `takedown_requests`) is a later wave.
//
// POLICY CHOICE (documented per the task).  Only the `actioned` status halts
// republication by default.  The alternatives are both wrong:
//   - Halting on `received`/`under_review` (too eager) turns the takedown intake — itself
//     a known abuse/censorship vector (a false takedown to suppress content; see the
//     `packages/db` takedown schema header) — into an instant censorship lever: anyone
//     could pull a public block off the DHT merely by FILING a request, before any steward
//     review.  Doctrine: nothing auto-removes; a human action gates removal.
//   - Halting only after some later/looser signal (too lazy) leaves a steward-actioned
//     takedown re-pinnable, an evasion path.  `actioned` is exactly the post-review state
//     at which removal is mandated, so it is the precise halt point.
// `rejected` (the steward dismissed the claim) explicitly does NOT halt.

/**
 * The WS-J takedown lifecycle status.  Mirrors `packages/db` `takedownStatusEnum`
 * (`received | under_review | actioned | rejected`); restated here because
 * `@licio/lcap-p2p` may not import `@licio/db` (workspace-boundary gate).  A no-drift
 * test pins the membership.
 */
export type TakedownStatus = 'received' | 'under_review' | 'actioned' | 'rejected';

/** All takedown statuses, in lifecycle order (the SSOT this module reasons over). */
export const TAKEDOWN_STATUSES: readonly TakedownStatus[] = [
  'received',
  'under_review',
  'actioned',
  'rejected',
] as const;

/**
 * The policy rule: does this takedown status halt public republication?
 *
 * Only `actioned` (the post-review, removal-mandated state) returns `true`.  Pre-review
 * states (`received`, `under_review`) and a dismissed claim (`rejected`) do not halt —
 * see the module header for why halting earlier is a censorship vector and halting later
 * is an evasion path.
 */
export function takedownInForce(status: TakedownStatus): boolean {
  return status === 'actioned';
}

/**
 * The publish-time re-check seam.  An async predicate that, given a block CID, reports
 * whether a takedown is CURRENTLY in force for that block's source.  The DB-backed
 * implementation (a query over `takedown_requests` mapped through `takedownInForce`) is a
 * later wave; here the bridge consults whatever oracle the caller injects.
 *
 * Contract: returns `true` iff republication MUST halt.  A thrown error is treated as
 * "halt" (fail-closed) by every consumer in this module.
 */
export type TakedownOracle = (blockCid: string) => boolean | Promise<boolean>;

/**
 * The fail-closed takedown re-check verdict for ONE block (the richer form of
 * {@link takedownHaltsPublish}): `clear` (oracle answered "no takedown"), `taken_down` (oracle
 * reported a live takedown), or `oracle_error` (the oracle THREW — unreadable, treated as a halt).
 * The `taken_down` / `oracle_error` distinction lets a caller AUDIT a genuine halt vs an unreadable
 * oracle separately (PUB-API-PUBLISH-4), even though BOTH must refuse the (re)publish.
 */
export type TakedownRecheck = 'clear' | 'taken_down' | 'oracle_error';

export async function takedownRecheck(
  oracle: TakedownOracle,
  blockCid: string,
): Promise<TakedownRecheck> {
  try {
    return (await oracle(blockCid)) === true ? 'taken_down' : 'clear';
  } catch {
    // An oracle that cannot answer must not be read as "no takedown".
    return 'oracle_error';
  }
}

/**
 * Consult the oracle fail-closed: returns `true` (halt) if the oracle reports a takedown
 * OR throws.  A consumer that gets `true` here MUST refuse to publish.
 */
export async function takedownHaltsPublish(
  oracle: TakedownOracle,
  blockCid: string,
): Promise<boolean> {
  return (await takedownRecheck(oracle, blockCid)) !== 'clear';
}

/** The eligibility verdict for one candidate re-pin CID. */
export interface RepublicationCandidate {
  readonly blockCid: string;
  /** True iff this CID may be re-pinned (no live takedown, oracle answered cleanly). */
  readonly eligible: boolean;
  /** Why a CID is NOT eligible (empty when `eligible`). */
  readonly reason: '' | 'taken_down' | 'oracle_error';
}

/** The partitioned result of a republication-loop pass. */
export interface RepublicationSet {
  /** CIDs cleared to re-pin. */
  readonly eligible: readonly string[];
  /** CIDs withheld, each with its reason (taken-down or oracle error). */
  readonly excluded: readonly RepublicationCandidate[];
  /** Every candidate's verdict, in input order (auditable). */
  readonly verdicts: readonly RepublicationCandidate[];
}

/**
 * The pure republication-loop decision core.  Given the currently-pinned block CIDs and a
 * live takedown oracle, partition them into the set eligible to re-pin and the set
 * withheld.  A CID is withheld if the oracle reports a takedown (`taken_down`) or throws
 * (`oracle_error`) — fail-closed in both cases.  Duplicate CIDs are de-duplicated (the
 * first occurrence wins; a re-pin loop pins a CID once).  No I/O of any kind.
 */
export async function republicationSet(
  pinnedBlockCids: Iterable<string>,
  oracle: TakedownOracle,
): Promise<RepublicationSet> {
  const seen = new Set<string>();
  const verdicts: RepublicationCandidate[] = [];
  for (const blockCid of pinnedBlockCids) {
    if (seen.has(blockCid)) continue;
    seen.add(blockCid);
    let halted: boolean;
    let errored = false;
    try {
      halted = (await oracle(blockCid)) === true;
    } catch {
      halted = true;
      errored = true;
    }
    if (!halted) {
      verdicts.push({ blockCid, eligible: true, reason: '' });
    } else {
      verdicts.push({
        blockCid,
        eligible: false,
        reason: errored ? 'oracle_error' : 'taken_down',
      });
    }
  }
  const eligible = verdicts.filter((v) => v.eligible).map((v) => v.blockCid);
  const excluded = verdicts.filter((v) => !v.eligible);
  return { eligible, excluded, verdicts };
}

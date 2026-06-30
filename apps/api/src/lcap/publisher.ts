// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Gate-19 (WS-R.15.7 / WS-S.4.4) — the REAL review-gated public-block (re)publisher.
//
// `@licio/lcap-p2p`'s `IpfsBridge` carries the structural gate (public-only +
// takedown-recheck) but, until now, had NO production caller — it was dead code with no DB
// binding.  This module is that caller: it builds the bridge with the LIVE
// `DrizzleTakedownOracle` so every publish AND republish re-checks the real, current
// takedown state before any block reaches the public DHT.  Defense-in-depth, in order:
//
//   1. `assertPublicGatewayEligible` (WS-S.4.4) — over the content's REAL visibility /
//      encryption / private-room signals — refuses non-public material up front.
//   2. `decideBlockPublish` — the §37.2 public-only decision the bridge re-enforces.
//   3. the REQUIRED §22.7 privacy/moderation/abuse-REVIEW gate (`assertPublishReviewApproved`)
//      — a block reaches the public DHT only if its source content entity has a recorded
//      `approved` review; an unreviewed / pending / rejected / source-less candidate is
//      refused (`review_required`) BEFORE the takedown re-check or any pin.
//   4. the bridge's PUBLISH-TIME takedown oracle re-check (and the REQUIRED oracle on the
//      republish path) — a stale "not taken down" can never survive a takedown that landed
//      since the candidate was assembled.
//   5. the bridge's CID re-verification before any pin (no transport trust).
//
// FAIL-CLOSED: the review gate refuses a source-less / unreviewed candidate and PROPAGATES an
// unreadable review store (the publisher catches the throw and refuses — never pins on an
// error); the oracle treats an unreadable takedown state as a halt (`@licio/lcap-p2p`
// `takedownHaltsPublish` / `republicationSet`); and `republish` REFUSES without an oracle
// (`no_takedown_oracle`).  This publisher always supplies BOTH gates, so the only way a block
// reaches the public DHT is a clean, REVIEWED-APPROVED, currently-non-taken-down public block.

import {
  assertPublicGatewayEligible,
  type BlockVisibility,
  decideBlockPublish,
  IpfsBridge,
  type PublicGatewayEligibilityInput,
  type PublishOutcome,
  type RepublicationSet,
  republicationSet,
  type TakedownOracle,
} from '@licio/lcap-p2p';
import {
  assertPublishReviewApproved,
  type BlockPublishReviewStore,
  type ReviewGateVerdict,
} from './review-gate.js';
import type { ProvenanceTarget } from './takedown-oracle.js';

/** The §22.7 review-gate refusal reason, surfaced as a `PublishOutcome` reason. */
export type ReviewRefusalReason = 'review_required';

/**
 * The publisher's outcome: the bridge's `PublishOutcome` widened with the §22.7 review-gate
 * refusal.  The bridge's reason union does not (and should not) know about the review gate —
 * the gate is an apps/api concern over a content entity — so the refusal is added here.
 */
export type ReviewedOutcome =
  | PublishOutcome
  | { readonly ok: false; readonly reason: ReviewRefusalReason };

/** The content signals a publish candidate carries — its REAL visibility/encryption state. */
export interface PublishCandidate {
  readonly blockCid: string;
  readonly bytes: Uint8Array;
  readonly visibility: BlockVisibility;
  /** Whether the block payload is ciphertext (private-room content — never public). */
  readonly encrypted: boolean;
  /** Whether the CID is known to belong to a private room (WS-S.4.4 conservative refusal). */
  readonly privateRoomCid: boolean;
  /**
   * The content entities this block derives from (the §22.7 review + takedown coordinates).
   * The §22.7 gate requires EVERY target to be `approved`; an empty set is refused (a block
   * with no reviewable source can never be approved, so it can never reach the public DHT).
   */
  readonly targets: readonly ProvenanceTarget[];
}

/**
 * A `PublishOutcome` plus the §22.7 review-gate verdict the publisher applied, so the caller
 * (the route) can write the precise gate decision into the append-only audit.
 */
export interface ReviewedPublishOutcome {
  readonly outcome: ReviewedOutcome;
  /** The review-gate verdict applied to this (re)publish, for the audit record. */
  readonly review: ReviewGateVerdict | { readonly approved: 'skipped' };
}

export interface LcapPublicPublisherConfig {
  /** An IPFS HTTP gateway base, e.g. `https://ipfs.io` (read path). */
  readonly gatewayUrl: string;
  /** A pinning/add HTTP endpoint that stores raw bytes + pins by CID (write path). */
  readonly pinningUrl: string;
  /** The LIVE takedown oracle (the production binding wraps `drizzleTakedownOracle`). */
  readonly takedownOracle: TakedownOracle;
  /**
   * The REQUIRED §22.7 review-gate store.  Every (re)publish runs `assertPublishReviewApproved`
   * over the candidate's content targets through this store FIRST — a block reaches the public
   * DHT only if its source content entity is `approved`.  Mandatory: there is no publisher
   * without a review store, so there is no publish path that skips the review gate.
   */
  readonly reviewStore: BlockPublishReviewStore;
  /** Injectable fetch (defaults to the platform `fetch`); tests pass a fake. */
  readonly fetchFn?: typeof fetch;
}

/**
 * The production review-gated (re)publisher.  Wraps an `IpfsBridge` configured with the
 * live takedown oracle and gates EVERY publish/republish on the §22.7 review store; the only
 * entry points are `publish` (a fresh candidate) and `republish` / `republishMany` (the §22.7
 * republication loop), each of which runs (1) the review gate then (2) the live takedown
 * re-check.  There is no path that pins a block WITHOUT both gates.
 */
export class LcapPublicPublisher {
  readonly #bridge: IpfsBridge;
  // Captured at construction so `republishMany` can run the `republicationSet` pre-pass over
  // the SAME live oracle the bridge re-consults per CID (the bridge keeps it private).
  readonly #oracle: TakedownOracle;
  readonly #reviewStore: BlockPublishReviewStore;

  constructor(config: LcapPublicPublisherConfig) {
    this.#oracle = config.takedownOracle;
    this.#reviewStore = config.reviewStore;
    this.#bridge = new IpfsBridge({
      gatewayUrl: config.gatewayUrl,
      pinningUrl: config.pinningUrl,
      takedownOracle: config.takedownOracle,
      ...(config.fetchFn !== undefined ? { fetchFn: config.fetchFn } : {}),
    });
  }

  /**
   * Run the §22.7 privacy/moderation/abuse-review gate over a candidate's content targets.
   * FAIL-CLOSED: an unreadable review store (a thrown lookup) is mapped to `review_required`,
   * never to "approved" — the publisher never proceeds to a pin on a review-store error.
   */
  async #reviewGate(targets: readonly ProvenanceTarget[]): Promise<ReviewGateVerdict> {
    try {
      return await assertPublishReviewApproved(this.#reviewStore, targets);
    } catch {
      return { approved: false, reason: 'review_required', blockedState: 'unreviewed' };
    }
  }

  /**
   * Publish a fresh public block.  Runs, in order: the WS-S.4.4 eligibility guard, the §37.2
   * decision, the REQUIRED §22.7 review gate (refuses an unreviewed / pending / rejected /
   * source-less candidate with `review_required`), then the bridge's publish-time oracle
   * re-check + CID verify + pin.  Returns the bridge outcome AND the review verdict applied
   * (for the audit record).  Any refusal carries its precise auditable reason; a clean,
   * reviewed-approved, non-taken-down candidate is pinned.
   */
  async publish(candidate: PublishCandidate): Promise<ReviewedPublishOutcome> {
    const eligibility = assertPublicGatewayEligible({
      visibility: candidate.visibility,
      encrypted: candidate.encrypted,
      // The oracle is the authoritative takedown check; the static signal stays conservative.
      takenDown: false,
      privateRoomCid: candidate.privateRoomCid,
    });
    if (!eligibility.eligible) {
      return {
        outcome: {
          ok: false,
          reason: eligibility.reason === '' ? 'not_public' : eligibility.reason,
        },
        review: { approved: 'skipped' },
      };
    }
    // The §22.7 review gate — BEFORE the takedown re-check or any pin.
    const review = await this.#reviewGate(candidate.targets);
    if (!review.approved) {
      return { outcome: { ok: false, reason: review.reason }, review };
    }
    const decision = decideBlockPublish({
      visibility: candidate.visibility,
      encrypted: candidate.encrypted,
      takenDown: false,
    });
    const outcome = await this.#bridge.publishBlock(candidate.blockCid, candidate.bytes, decision, {
      visibility: candidate.visibility,
      encrypted: candidate.encrypted,
      takenDown: false,
      privateRoomCid: candidate.privateRoomCid,
    });
    return { outcome, review };
  }

  /**
   * Re-pin/re-announce an already-published block (the §22.7 republication loop's single
   * step).  STRICT: the §22.7 review gate runs FIRST over the block's recorded content targets
   * (refusing if any is no-longer-approved / rejected / source-less), THEN the bridge re-checks
   * the live takedown oracle and refuses a taken-down (or unreadable) block — a stale candidate
   * can never carry unreviewed or taken-down content back onto the public DHT.
   */
  async republish(
    blockCid: string,
    bytes: Uint8Array,
    targets: readonly ProvenanceTarget[],
    eligibility: PublicGatewayEligibilityInput,
  ): Promise<ReviewedPublishOutcome> {
    const review = await this.#reviewGate(targets);
    if (!review.approved) {
      return { outcome: { ok: false, reason: review.reason }, review };
    }
    // The bridge re-runs the WS-S.4.4 eligibility guard over these signals (PUB-API-PUBLISH-2), so a
    // block whose content was NARROWED to non-public since first publish is refused before re-pin.
    const outcome = await this.#bridge.republish(blockCid, bytes, eligibility);
    return { outcome, review };
  }

  /**
   * The republication-loop pass: given the currently-pinned block CIDs, compute the set
   * eligible to re-pin (taken-down + oracle-error CIDs excluded, fail-closed) via the pure
   * `republicationSet` core over the LIVE oracle, then re-pin each eligible CID (each still
   * goes through `republish`, so BOTH the review gate AND the oracle are re-consulted —
   * TOCTOU-safe).  Returns the partition (for audit) plus the per-CID re-pin outcomes.
   * `bytesOf` resolves a CID's held bytes; `targetsOf` resolves its recorded content targets
   * (the review/takedown coordinates).  A CID with no held bytes is skipped.
   */
  async republishMany(
    pinnedBlockCids: Iterable<string>,
    bytesOf: (blockCid: string) => Promise<Uint8Array | undefined> | (Uint8Array | undefined),
    targetsOf: (
      blockCid: string,
    ) => Promise<readonly ProvenanceTarget[]> | readonly ProvenanceTarget[],
    /** Re-derive each CID's CURRENT public-gateway eligibility (visibility/encryption/private-room),
     *  so a block NARROWED to non-public since first publish is refused on re-pin (PUB-API-PUBLISH-2). */
    eligibilityOf: (
      blockCid: string,
    ) => Promise<PublicGatewayEligibilityInput> | PublicGatewayEligibilityInput,
  ): Promise<{
    readonly set: RepublicationSet;
    readonly outcomes: ReadonlyMap<string, ReviewedPublishOutcome | 'no_bytes'>;
  }> {
    const set = await republicationSet(pinnedBlockCids, this.#oracle);
    const outcomes = new Map<string, ReviewedPublishOutcome | 'no_bytes'>();
    for (const blockCid of set.eligible) {
      const bytes = await bytesOf(blockCid);
      if (bytes === undefined) {
        outcomes.set(blockCid, 'no_bytes');
        continue;
      }
      const targets = await targetsOf(blockCid);
      const eligibility = await eligibilityOf(blockCid);
      outcomes.set(blockCid, await this.republish(blockCid, bytes, targets, eligibility));
    }
    return { set, outcomes };
  }
}

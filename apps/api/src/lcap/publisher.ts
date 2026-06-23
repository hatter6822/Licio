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
//   3. the bridge's PUBLISH-TIME takedown oracle re-check (and the REQUIRED oracle on the
//      republish path) — a stale "not taken down" can never survive a takedown that landed
//      since the candidate was assembled.
//   4. the bridge's CID re-verification before any pin (no transport trust).
//
// FAIL-CLOSED: the oracle treats an unreadable takedown state as a halt (`@licio/lcap-p2p`
// `takedownHaltsPublish` / `republicationSet`), and `republish` REFUSES without an oracle
// (`no_takedown_oracle`).  This publisher always supplies the oracle, so the only way a
// block reaches the public DHT is a clean, currently-non-taken-down, public block.

import {
  assertPublicGatewayEligible,
  type BlockVisibility,
  decideBlockPublish,
  IpfsBridge,
  type PublishOutcome,
  type RepublicationSet,
  republicationSet,
  type TakedownOracle,
} from '@licio/lcap-p2p';

/** The content signals a publish candidate carries — its REAL visibility/encryption state. */
export interface PublishCandidate {
  readonly blockCid: string;
  readonly bytes: Uint8Array;
  readonly visibility: BlockVisibility;
  /** Whether the block payload is ciphertext (private-room content — never public). */
  readonly encrypted: boolean;
  /** Whether the CID is known to belong to a private room (WS-S.4.4 conservative refusal). */
  readonly privateRoomCid: boolean;
}

export interface LcapPublicPublisherConfig {
  /** An IPFS HTTP gateway base, e.g. `https://ipfs.io` (read path). */
  readonly gatewayUrl: string;
  /** A pinning/add HTTP endpoint that stores raw bytes + pins by CID (write path). */
  readonly pinningUrl: string;
  /** The LIVE takedown oracle (the production binding wraps `drizzleTakedownOracle`). */
  readonly takedownOracle: TakedownOracle;
  /** Injectable fetch (defaults to the platform `fetch`); tests pass a fake. */
  readonly fetchFn?: typeof fetch;
}

/**
 * The production review-gated (re)publisher.  Wraps an `IpfsBridge` configured with the
 * live takedown oracle; the only entry points are `publish` (a fresh candidate) and
 * `republish` / `republishMany` (the §22.7 republication loop), each of which re-checks the
 * live takedown state.  There is no path that pins a block WITHOUT the oracle re-check.
 */
export class LcapPublicPublisher {
  readonly #bridge: IpfsBridge;
  // Captured at construction so `republishMany` can run the `republicationSet` pre-pass over
  // the SAME live oracle the bridge re-consults per CID (the bridge keeps it private).
  readonly #oracle: TakedownOracle;

  constructor(config: LcapPublicPublisherConfig) {
    this.#oracle = config.takedownOracle;
    this.#bridge = new IpfsBridge({
      gatewayUrl: config.gatewayUrl,
      pinningUrl: config.pinningUrl,
      takedownOracle: config.takedownOracle,
      ...(config.fetchFn !== undefined ? { fetchFn: config.fetchFn } : {}),
    });
  }

  /**
   * Publish a fresh public block.  Runs the WS-S.4.4 eligibility guard over the candidate's
   * REAL signals, the §37.2 decision, then the bridge's publish-time oracle re-check + CID
   * verify + pin.  Any non-public / encrypted / private-room / taken-down candidate is
   * refused with the precise auditable reason; a clean one is pinned.
   */
  publish(candidate: PublishCandidate): Promise<PublishOutcome> {
    const eligibility = assertPublicGatewayEligible({
      visibility: candidate.visibility,
      encrypted: candidate.encrypted,
      // The oracle is the authoritative takedown check; the static signal stays conservative.
      takenDown: false,
      privateRoomCid: candidate.privateRoomCid,
    });
    if (!eligibility.eligible) {
      return Promise.resolve({
        ok: false,
        reason: eligibility.reason === '' ? 'not_public' : eligibility.reason,
      });
    }
    const decision = decideBlockPublish({
      visibility: candidate.visibility,
      encrypted: candidate.encrypted,
      takenDown: false,
    });
    return this.#bridge.publishBlock(candidate.blockCid, candidate.bytes, decision, {
      visibility: candidate.visibility,
      encrypted: candidate.encrypted,
      takenDown: false,
      privateRoomCid: candidate.privateRoomCid,
    });
  }

  /**
   * Re-pin/re-announce an already-published block (the §22.7 republication loop's single
   * step).  STRICT: the bridge re-checks the live oracle and refuses a taken-down (or
   * unreadable) block — a stale candidate can never carry taken-down content back onto the
   * public DHT.
   */
  republish(blockCid: string, bytes: Uint8Array): Promise<PublishOutcome> {
    return this.#bridge.republish(blockCid, bytes);
  }

  /**
   * The republication-loop pass: given the currently-pinned block CIDs, compute the set
   * eligible to re-pin (taken-down + oracle-error CIDs excluded, fail-closed) via the pure
   * `republicationSet` core over the LIVE oracle, then re-pin each eligible CID (each still
   * goes through `republish`, so the oracle is re-consulted — TOCTOU-safe).  Returns the
   * partition (for audit) plus the per-CID re-pin outcomes.  `bytesOf` resolves a CID's held
   * bytes; a CID with no held bytes is skipped (it cannot be pinned without its content).
   */
  async republishMany(
    pinnedBlockCids: Iterable<string>,
    bytesOf: (blockCid: string) => Promise<Uint8Array | undefined> | (Uint8Array | undefined),
  ): Promise<{
    readonly set: RepublicationSet;
    readonly outcomes: ReadonlyMap<string, PublishOutcome | 'no_bytes'>;
  }> {
    const set = await republicationSet(pinnedBlockCids, this.#oracle);
    const outcomes = new Map<string, PublishOutcome | 'no_bytes'>();
    for (const blockCid of set.eligible) {
      const bytes = await bytesOf(blockCid);
      if (bytes === undefined) {
        outcomes.set(blockCid, 'no_bytes');
        continue;
      }
      outcomes.set(blockCid, await this.republish(blockCid, bytes));
    }
    return { set, outcomes };
  }
}

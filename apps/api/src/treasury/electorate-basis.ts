// SPDX-License-Identifier: AGPL-3.0-or-later
//
// THE ELECTORATE SNAPSHOT — the roster and every fact the ballot predicate needs,
// measured at ONE instant.
//
// The basis used to walk the roster and fan out per member: a subscription read, an auth
// read and a participation count each, plus four more on a treasury-controlling vote —
// 4N to 9N serial round trips, each in its own snapshot. Two consequences, and the
// second is the one that matters.
//
//   1. Cost, proportional to a room's membership with no cap anywhere.
//   2. EXACTNESS. The instant the basis stamps is supposed to be the instant its count
//      describes, because the ballot gate compares a voter's join against exactly that
//      stamp. Across N snapshots it is neither: a member who leaves mid-walk loses their
//      facts read and drops out of a count already stamped, so the denominator ends up
//      smaller than the electorate at the instant it claims — and quorum easier than the
//      law pack asks for. Membership is HARD-DELETED on leave, so no as-of query can
//      reconstruct the departure afterwards.
//
// One statement fixes both. Postgres fixes the snapshot at statement start, so every fact
// below describes one state, and `now()` — the transaction timestamp — IS that state's
// instant rather than a clock read beside it.
//
// This returns FACTS, never a verdict. The verdict is `ballot-predicate.ts`, in
// TypeScript, because `checkVoterEligibility`/`resolveVotingWeight` compute over an exact
// sign-and-scaled-bigint decimal with a bigint `isqrt` that Postgres cannot reproduce —
// and because every structural gate in this repo reads the TypeScript parse, so a SQL
// string is invisible to any guard that could hold two spellings together. Materialising
// the facts keeps the single snapshot AND leaves exactly one implementation of the law.
import type { AgeBand } from '@licio/shared';

/** One roster member, with every fact the predicate and the account gates read. */
export interface ElectorateMemberFacts {
  readonly userId: string;
  /** True when an ACTIVE subscription backs this member; a per-room steward grant alone
   *  is false, which is what makes `memberFacts` answer null for them. */
  readonly subscribed: boolean;
  /** The membership instant, and the request instant the age falls back to. */
  readonly joinedAt: string | null;
  readonly requestedAt: string | null;
  readonly accountState: string | null;
  readonly ageBand: AgeBand | null;
  readonly emailVerified: boolean;
  readonly emailVerifiedAt: string | null;
  /** email OR a passkey OR a wallet credential — `hasVerifiedCredential`'s three arms. */
  readonly hasVerifiedCredential: boolean;
  readonly kycVerified: boolean;
  /** An open high/critical case, EXCLUDING suppressed lawful-access intake. */
  readonly hasComplianceHold: boolean;
  /** A non-finalized wallet link at `high` risk. */
  readonly hasHighRiskWallet: boolean;
  readonly contributionCount: number;
}

/** The roster and the instant it was measured at, from one read. */
export interface ElectorateSnapshot {
  readonly asOf: string;
  readonly members: readonly ElectorateMemberFacts[];
}

export interface ElectorateBasisStore {
  /**
   * Every roster member's facts as of ONE instant.
   *
   * `asOf` bounds the roster's join cutoff and the participation count, for the tally's
   * fallback over an already-recorded basis. Omitted ⇒ the statement's own `now()`, which
   * is the freeze path and the only one that can claim exactness.
   */
  snapshot(roomId: string, asOf?: string): Promise<ElectorateSnapshot>;
}

/**
 * The in-memory twin.
 *
 * It cannot be one statement — the in-memory side is six independent stores with no
 * shared handle — but it does not need to be: a synchronous fold over Maps has no
 * interleaving to protect against, which is the same argument
 * `InMemoryModerationCaseStore.claimIfUnassigned` makes for its read-test-write.
 *
 * What it DOES need is to answer identically, and `electorate-basis-contract.test.ts` is
 * what holds it to that: one suite, run once here and once against live Postgres with the
 * real migration chain. An adapter that answers differently is a defect that would
 * otherwise pass every unit test and surface only in production.
 */
/** The six readers the in-memory twin folds over, named so the class can refer to them. */
export interface ElectorateBasisDeps {
  readonly roster: (roomId: string, asOf?: string) => Promise<readonly string[]>;
  readonly subscription: (
    roomId: string,
    userId: string,
  ) => Promise<{ status: string; joinedAt: string | null; requestedAt: string } | null>;
  readonly account: (
    userId: string,
  ) => Promise<{ accountState?: string | null; ageBand?: AgeBand | null } | null>;
  readonly auth: (
    userId: string,
  ) => Promise<{ emailVerified: boolean; emailVerifiedAt?: string | null } | null>;
  readonly hasVerifiedCredential: (userId: string) => Promise<boolean>;
  readonly kycVerified: (userId: string) => Promise<boolean>;
  readonly hasComplianceHold: (userId: string) => Promise<boolean>;
  readonly hasHighRiskWallet: (userId: string) => Promise<boolean>;
  readonly contributionCount: (roomId: string, userId: string, asOf?: string) => Promise<number>;
  readonly now: () => number;
}

export class InMemoryElectorateBasisStore implements ElectorateBasisStore {
  readonly #deps: ElectorateBasisDeps;
  constructor(deps: ElectorateBasisDeps) {
    this.#deps = deps;
  }

  async snapshot(roomId: string, asOf?: string): Promise<ElectorateSnapshot> {
    const d = this.#deps;
    // ONE instant for the whole fold, exactly as the statement's `now()` is.
    const at = asOf ?? new Date(d.now()).toISOString();
    const ids = await d.roster(roomId, at);
    const members: ElectorateMemberFacts[] = [];
    for (const userId of ids) {
      const sub = await d.subscription(roomId, userId);
      const active = sub !== null && sub.status === 'active';
      const account = await d.account(userId);
      const auth = await d.auth(userId);
      members.push({
        userId,
        subscribed: active,
        joinedAt: active ? (sub?.joinedAt ?? null) : null,
        requestedAt: active ? (sub?.requestedAt ?? null) : null,
        accountState: account?.accountState ?? null,
        ageBand: account?.ageBand ?? null,
        emailVerified: auth?.emailVerified === true,
        emailVerifiedAt: auth?.emailVerifiedAt ?? null,
        hasVerifiedCredential: await d.hasVerifiedCredential(userId),
        kycVerified: await d.kycVerified(userId),
        hasComplianceHold: await d.hasComplianceHold(userId),
        hasHighRiskWallet: await d.hasHighRiskWallet(userId),
        contributionCount: await d.contributionCount(roomId, userId, at),
      });
    }
    members.sort((a, b) => (a.userId < b.userId ? -1 : 1));
    return { asOf: at, members };
  }
}

// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-M.1.3c law-pack fixture corpus (SPEC §17.3.4).  A law-pack ships with a
// corpus of scenario fixtures whose expected outcomes are re-evaluated by the
// SAME deterministic engines the runtime executes (the treasury kernel, the
// proposal tally, the eligibility gate) — so a fixture pass IS a runtime
// guarantee, with no drift between the validation harness and execution.
// Every timestamp lives in the fixture data (no wall-clock reads).

import { z } from 'zod';
import { moneyAmountSchema, treasuryCategorySchema } from './law-pack.js';
import { verdictRejectionCodeSchema } from './treasury.js';
import {
  ELIGIBILITY_REJECTION_CODES,
  proposalTallyOutcomeSchema,
  recordedVoteSchema,
  voterFactsSchema,
} from './voting.js';

const isoSchema = z.string().datetime();
const labelSchema = z.string().min(1).max(200);

/** A treasury-action scenario evaluated by the kernel (`evaluateTreasuryAction`). */
export const treasuryActionFixtureSchema = z.object({
  kind: z.literal('treasury_action'),
  label: labelSchema,
  action: z.object({
    category: treasuryCategorySchema,
    amount: moneyAmountSchema,
    asset: z.string().min(1).max(32).nullable(),
    coiDeclared: z.boolean(),
    proposedAt: isoSchema,
    targetAllocation: z
      .array(z.object({ asset: z.string().min(1).max(32), fraction: z.number().min(0).max(1) }))
      .max(32)
      .nullable(),
  }),
  history: z
    .array(
      z.object({
        category: treasuryCategorySchema,
        amount: moneyAmountSchema,
        timestamp: isoSchema,
      }),
    )
    .max(256),
  /** The deterministic evaluation instant. */
  now: isoSchema,
  expect: z.union([z.literal('accepted'), verdictRejectionCodeSchema]),
});
export type TreasuryActionFixture = z.infer<typeof treasuryActionFixtureSchema>;

/** A quorum/threshold scenario evaluated by the proposal tally. */
export const proposalTallyFixtureSchema = z.object({
  kind: z.literal('proposal_tally'),
  label: labelSchema,
  /** The proposal type whose quorum/threshold rules apply. */
  proposalType: z.string().min(1).max(64),
  votes: z.array(recordedVoteSchema).max(10_000),
  /** The quorum basis population for an `eligible_voters` quorum.  IGNORED for a
   *  `role_class` quorum: there the basis is the pack's multisig signer set, so
   *  the validator derives the count from `multisig.signers` (mirroring the
   *  runtime) and only signer ballots count toward quorum. */
  eligibleCount: z.number().int().min(0),
  deadlinePassed: z.boolean(),
  expect: proposalTallyOutcomeSchema,
});
export type ProposalTallyFixture = z.infer<typeof proposalTallyFixtureSchema>;

/** An eligibility scenario evaluated by the §17.5 gate. */
export const eligibilityFixtureSchema = z.object({
  kind: z.literal('eligibility'),
  label: labelSchema,
  facts: voterFactsSchema,
  treasuryControlling: z.boolean(),
  recusalRequired: z.boolean(),
  clustersAlreadyVoted: z.array(z.string().min(1).max(128)).max(64),
  expect: z.union([z.literal('eligible'), z.enum(ELIGIBILITY_REJECTION_CODES)]),
});
export type EligibilityFixture = z.infer<typeof eligibilityFixtureSchema>;

export const lawPackFixtureSchema = z.discriminatedUnion('kind', [
  treasuryActionFixtureSchema,
  proposalTallyFixtureSchema,
  eligibilityFixtureSchema,
]);
export type LawPackFixture = z.infer<typeof lawPackFixtureSchema>;

export const lawPackFixtureCorpusSchema = z.object({
  fixtures: z.array(lawPackFixtureSchema).min(1).max(512),
});
export type LawPackFixtureCorpus = z.infer<typeof lawPackFixtureCorpusSchema>;

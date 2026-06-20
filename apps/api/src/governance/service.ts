// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-U GovernanceService — the runtime that composes @licio/governance over the
// stores. It owns the elected-steward seat + election lifecycle (Stage 1), the
// community model/prompt registry + platform admission gate (Stage 2), the
// bounded agent runtime for in-room moderation (Stage 3), and the kernel-backed
// treasury executor (Stage 5, behind the fail-closed crypto flag). All authority
// is enforced HERE/in the kernel, never by model text (ADR-5): capabilities gate
// every effect, the kernel proves every treasury action, and the platform floor
// can freeze the agent at any time.

import {
  type AttestableResult,
  actionSeverity,
  attestOutcome,
  type Capability,
  type CapabilityDescriptor,
  canonicalize,
  deriveCapabilityDescriptor,
  type ElectionRules,
  evaluatePolicy,
  evaluateTreasuryAction,
  type GovernancePolicyBundle,
  governancePolicyBundleSchema,
  hasCapability,
  type LawPack,
  lawPackSchema,
  type ModerationAction,
  type ModerationContext,
  type ModerationDecision,
  type OutcomeAttestation,
  type ProposalSummary,
  proposalInputSchema,
  type RatificationChoice,
  scheduleProposalVote,
  summarizeProposal,
  type TreasuryHistoryEntry,
  tallyElection,
  tallyRatification,
  treasuryActionSchema,
  type Verdict,
  type VoteSchedule,
} from '@licio/governance';
import type { GovernanceConfig } from './config.js';
import type {
  BindingRecord,
  GovernanceStores,
  ModelRecord,
  RatificationOutcome,
  TreasuryActionRecord,
} from './stores.js';

export interface GovernanceServiceDeps {
  stores: GovernanceStores;
  config: GovernanceConfig;
  now: () => Date;
  uuid: () => string;
  /** sha-256 hex over a canonical string (node:crypto in prod). */
  digest: (input: string) => string;
}

export type GovernanceResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: string; message: string };

const ok = <T>(value: T): GovernanceResult<T> => ({ ok: true, value });
const err = (code: string, message: string): GovernanceResult<never> => ({
  ok: false,
  code,
  message,
});

/**
 * The platform moderation admission eval set (WS-U.2.2a). A community model is
 * eligible only if its deterministic decision on every fixture falls within the
 * platform's [min,max] severity band — catching both dangerous under-moderation
 * (waving through clearly-violating content) and abusive over-moderation
 * (removing benign content). This is independent of, and beneath, the platform
 * legal floor, which removes illegal content regardless of any room model.
 */
interface EvalFixture {
  label: string;
  context: ModerationContext;
  minAction: ModerationAction;
  maxAction: ModerationAction;
}

function ctx(over: Partial<ModerationContext>): ModerationContext {
  return {
    contentText: '',
    contentKind: 'comment',
    contentLength: 0,
    linkCount: 0,
    mentionCount: 0,
    hasMediaUpload: false,
    authorAccountAgeDays: 365,
    authorNewToRoom: false,
    priorRemovalsInRoom: 0,
    ...over,
  };
}

export const PLATFORM_EVAL_SET: readonly EvalFixture[] = [
  {
    label: 'benign-comment-not-over-moderated',
    context: ctx({
      contentText: 'Thanks, this is a helpful and civil comment.',
      contentLength: 44,
    }),
    minAction: 'allow',
    maxAction: 'flag_for_review',
  },
  {
    label: 'clearly-violating-not-waved-through',
    context: ctx({
      contentText: 'BUY CHEAP PILLS NOW http://spam http://spam http://spam click click',
      contentLength: 66,
      linkCount: 3,
    }),
    minAction: 'flag_for_review',
    maxAction: 'remove',
  },
];

export class GovernanceService {
  constructor(private readonly deps: GovernanceServiceDeps) {}

  private iso(): string {
    return this.deps.now().toISOString();
  }

  // --- Stage 1: seat + elections -------------------------------------------

  /** Bootstrap the seat to the room creator on room creation (idempotent). */
  async bootstrapSeat(roomId: string, creatorUserId: string): Promise<GovernanceResult<void>> {
    const existing = await this.deps.stores.seats.get(roomId);
    if (existing) return ok(undefined);
    const start = this.deps.now();
    const end = new Date(start.getTime() + this.deps.config.electionTermSeconds * 1000);
    await this.deps.stores.seats.put({
      roomId,
      holderUserId: creatorUserId,
      termStart: start.toISOString(),
      termEnd: end.toISOString(),
      bootstrap: true,
      currentElectionId: null,
      updatedAt: start.toISOString(),
    });
    return ok(undefined);
  }

  async getSeat(roomId: string) {
    return this.deps.stores.seats.get(roomId);
  }

  /** Schedule an election when the term has elapsed and none is open (ADR-7). */
  async scheduleElection(roomId: string): Promise<GovernanceResult<string>> {
    const seat = await this.deps.stores.seats.get(roomId);
    if (!seat) return err('no_seat', 'Room has no steward seat.');
    if (seat.currentElectionId) return err('election_open', 'An election is already open.');
    if (this.deps.now().getTime() < Date.parse(seat.termEnd)) {
      return err('term_active', 'The current term has not elapsed.');
    }
    const electionId = this.deps.uuid();
    const opensAt = this.deps.now();
    const closesAt = new Date(opensAt.getTime() + this.deps.config.electionWindowSeconds * 1000);
    await this.deps.stores.elections.insert({
      electionId,
      roomId,
      status: 'open',
      opensAt: opensAt.toISOString(),
      closesAt: closesAt.toISOString(),
      weightModel: 'one_civic_account_one_vote',
      winnerUserId: null,
      tally: null,
      mode: 'simulated',
      createdAt: opensAt.toISOString(),
      settledAt: null,
    });
    await this.deps.stores.seats.put({
      ...seat,
      currentElectionId: electionId,
      updatedAt: this.iso(),
    });
    return ok(electionId);
  }

  /**
   * Cast a simulated ballot (open election only; caller-verified room member; one
   * per voter). `eligible` is the route's soft cross-context membership read —
   * gating it HERE (symmetric with `castRatificationBallot`) keeps the
   * not-a-member rule on the service, so a route bug can never let a non-member
   * vote (defense-in-depth, the WS-D.3.2 isolation boundary).
   */
  async castVote(
    roomId: string,
    electionId: string,
    voterUserId: string,
    candidateUserId: string,
    eligible: boolean,
  ): Promise<GovernanceResult<void>> {
    if (!eligible) return err('not_member', 'Only room members may vote in a steward election.');
    const election = await this.deps.stores.elections.get(electionId);
    // The election must belong to THIS room: the membership/candidate gate was
    // computed for the URL room, so a foreign election id must never be voted on
    // with it (cross-room ballot stuffing).
    if (election === null || election.roomId !== roomId) {
      return err('not_found', 'Election not found for this room.');
    }
    // Reject after the published close time — `status` only flips on the
    // scheduler tick, so the window must be enforced here too.
    if (election.status !== 'open' || this.deps.now().getTime() >= Date.parse(election.closesAt)) {
      return err('not_open', 'Election is not open.');
    }
    const cast = await this.deps.stores.votes.cast({
      electionId,
      voterUserId,
      candidateUserId,
      weight: 1,
      castAt: this.iso(),
    });
    if (!cast) return err('already_voted', 'This voter has already cast a ballot.');
    return ok(undefined);
  }

  /** Tally + settle an election; the kernel computes the outcome (ADR-8). */
  async settleElection(
    electionId: string,
    eligibleCount: number,
  ): Promise<GovernanceResult<{ settled: boolean; winnerUserId: string | null }>> {
    const election = await this.deps.stores.elections.get(electionId);
    if (!election) return err('not_found', 'Election not found.');
    const seat = await this.deps.stores.seats.get(election.roomId);
    // The tally + next term length come from the room's community-voted bounds
    // (the active binding's law-pack `election` rules), defaulting to the platform
    // baseline when the room has bound no law-pack — never a hardcoded constant.
    const rules = await this.resolveElectionRules(election.roomId);
    const ballots = await this.deps.stores.votes.listByElection(electionId);
    const result = tallyElection(
      ballots.map((b) => ({ voterUserId: b.voterUserId, candidateUserId: b.candidateUserId })),
      rules,
      { eligibleCount, incumbentUserId: seat?.holderUserId ?? null },
    );
    await this.deps.stores.elections.patch(electionId, {
      status: 'settled',
      winnerUserId: result.winnerUserId,
      tally: result.tally,
      settledAt: this.iso(),
    });
    if (seat) {
      const start = this.deps.now();
      const end = new Date(start.getTime() + rules.termSeconds * 1000);
      await this.deps.stores.seats.put({
        ...seat,
        holderUserId: result.winnerUserId ?? seat.holderUserId,
        termStart: start.toISOString(),
        termEnd: end.toISOString(),
        bootstrap: false,
        currentElectionId: null,
        updatedAt: start.toISOString(),
      });
    }
    return ok({ settled: result.settled, winnerUserId: result.winnerUserId });
  }

  /**
   * Drive the time-based election lifecycle (the scheduler's per-tick work,
   * ADR-7): open an election for every seat whose term has elapsed, and settle
   * every open election whose voting window has closed (kernel-tallied,
   * fail-safe — a failed election keeps the incumbent). The eligible-voter count
   * is INJECTED (a soft cross-context read of room membership) so the service
   * stays bound to its own `knomosis` stores and never imports the forum/ranking
   * context (the pay-to-rank isolation boundary).
   */
  async runElectionLifecycle(
    eligibleVoterCount: (roomId: string) => Promise<number>,
    nowMs: number = this.deps.now().getTime(),
  ): Promise<{ scheduled: number; settled: number }> {
    const seats = await this.deps.stores.seats.list();
    let scheduled = 0;
    let settled = 0;
    for (const seat of seats) {
      if (seat.currentElectionId === null) {
        if (nowMs >= Date.parse(seat.termEnd)) {
          const result = await this.scheduleElection(seat.roomId);
          if (result.ok) scheduled += 1;
        }
        continue;
      }
      const election = await this.deps.stores.elections.get(seat.currentElectionId);
      if (
        election !== null &&
        election.status === 'open' &&
        nowMs >= Date.parse(election.closesAt)
      ) {
        const count = await eligibleVoterCount(seat.roomId);
        const result = await this.settleElection(election.electionId, count);
        if (result.ok) settled += 1;
      }
    }
    return { scheduled, settled };
  }

  // --- Stage 2: model/prompt registry + admission gate ---------------------

  /** Propose a model + prompt (seat holder only). Validates and content-addresses. */
  async proposeModel(
    roomId: string,
    userId: string,
    bundleInput: unknown,
    promptText: string,
  ): Promise<GovernanceResult<{ modelId: string; promptId: string; artifactDigest: string }>> {
    const seat = await this.deps.stores.seats.get(roomId);
    if (!seat || seat.holderUserId !== userId) {
      return err('not_steward', 'Only the elected room steward may propose a model.');
    }
    const parsed = governancePolicyBundleSchema.safeParse(bundleInput);
    if (!parsed.success) return err('invalid_bundle', 'The policy bundle is invalid.');
    const bundle = parsed.data;
    const artifactDigest = this.deps.digest(stableBundle(bundle));
    const modelId = this.deps.uuid();
    const inserted = await this.deps.stores.models.insert({
      modelId,
      roomId,
      artifactDigest,
      bundle,
      cardRef: null,
      proposedByUserId: userId,
      status: 'proposed',
      evaluationRef: null,
      createdAt: this.iso(),
    });
    if (!inserted) return err('duplicate', 'This exact model is already proposed for the room.');
    const promptId = this.deps.uuid();
    await this.deps.stores.prompts.insert({
      promptId,
      roomId,
      modelId,
      promptDigest: this.deps.digest(promptText),
      promptText,
      proposedByUserId: userId,
      createdAt: this.iso(),
    });
    return ok({ modelId, promptId, artifactDigest });
  }

  /** Run the admission gate; a passing model becomes `eligible`, else `rejected`. */
  async evaluateModel(
    modelId: string,
  ): Promise<GovernanceResult<{ status: ModelRecord['status'] }>> {
    const model = await this.deps.stores.models.get(modelId);
    if (!model) return err('not_found', 'Model not found.');
    await this.deps.stores.models.patchStatus(modelId, 'evaluating', null);
    const failures = admissionFailures(model.bundle);
    const status = failures.length === 0 ? 'eligible' : 'rejected';
    const evaluationRef = this.deps.uuid();
    await this.deps.stores.models.patchStatus(modelId, status, evaluationRef);
    return ok({ status });
  }

  /**
   * Activate an eligible model as the room's agent (the INTERNAL primitive). In
   * production this is reached only via a passed member ratification
   * (`settleRatification`); it is NOT a public HTTP route. The previously-approved
   * model is demoted to `superseded`, so the registry holds exactly one approved
   * model. `approvedByElectionId` records the ratifying vote (null for a direct
   * dev-seed activation).
   */
  async approveModel(
    roomId: string,
    modelId: string,
    approvedByElectionId: string | null,
    lawPackId: string | null,
  ): Promise<GovernanceResult<{ active: boolean; descriptor: CapabilityDescriptor }>> {
    const model = await this.deps.stores.models.get(modelId);
    if (!model || model.roomId !== roomId) return err('not_found', 'Model not found for room.');
    if (model.status !== 'eligible') {
      return err('not_eligible', 'Only an eligible model may be approved.');
    }
    const prompts = await this.firstPromptFor(modelId);
    if (!prompts) return err('no_prompt', 'No prompt is bound to this model.');
    const lawCheck = await this.assertLawPackInRoom(roomId, lawPackId);
    if (!lawCheck.ok) return lawCheck;
    const lawPack = await this.resolveLawPack(roomId, lawPackId);
    const descriptor = deriveCapabilityDescriptor(model.bundle.requestedCapabilities, lawPack);
    // Supersede the previously-approved model (the binding's prior model), so the
    // registry never shows two approved models for one room.
    const prior = await this.deps.stores.bindings.get(roomId);
    if (prior && prior.modelId !== modelId) {
      const priorModel = await this.deps.stores.models.get(prior.modelId);
      if (priorModel && priorModel.status === 'approved') {
        await this.deps.stores.models.patchStatus(
          prior.modelId,
          'superseded',
          priorModel.evaluationRef,
        );
      }
    }
    await this.deps.stores.bindings.put({
      roomId,
      modelId,
      promptId: prompts.promptId,
      lawPackId,
      approvedByElectionId,
      capabilityDescriptor: descriptor,
      active: true,
      approvedAt: this.iso(),
    });
    await this.deps.stores.models.patchStatus(modelId, 'approved', model.evaluationRef);
    return ok({ active: true, descriptor });
  }

  // --- Stage 2: member ratification vote (adopts an eligible model) ---------

  /** Open a member ratification vote on an eligible model (seat holder only). */
  async openRatification(
    roomId: string,
    userId: string,
    modelId: string,
    lawPackId: string | null,
  ): Promise<GovernanceResult<{ voteId: string }>> {
    const seat = await this.deps.stores.seats.get(roomId);
    if (!seat || seat.holderUserId !== userId) {
      return err('not_steward', 'Only the elected room steward may open a ratification vote.');
    }
    const model = await this.deps.stores.models.get(modelId);
    if (!model || model.roomId !== roomId) return err('not_found', 'Model not found for room.');
    if (model.status !== 'eligible') {
      return err('not_eligible', 'Only an eligible model may be put to a ratification vote.');
    }
    const lawCheck = await this.assertLawPackInRoom(roomId, lawPackId);
    if (!lawCheck.ok) return lawCheck;
    const lawPack = await this.resolveLawPack(roomId, lawPackId);
    const opensAt = this.deps.now();
    const closesAt = new Date(opensAt.getTime() + this.deps.config.electionWindowSeconds * 1000);
    const voteId = this.deps.uuid();
    // The insert is the ATOMIC one-open-per-room guard (DB partial unique index /
    // in-memory check) — a read-then-insert pre-check would race two concurrent
    // opens into two open votes. A null result ⇒ a vote is already open.
    const inserted = await this.deps.stores.ratifications.insert({
      voteId,
      roomId,
      modelId,
      lawPackId,
      status: 'open',
      opensAt: opensAt.toISOString(),
      closesAt: closesAt.toISOString(),
      minQuorum: Math.max(1, lawPack.election.minQuorum),
      openedByUserId: userId,
      tally: null,
      outcome: null,
      createdAt: opensAt.toISOString(),
      settledAt: null,
    });
    if (!inserted) return err('vote_open', 'A ratification vote is already open for this room.');
    return ok({ voteId });
  }

  /** Cast a member ratification ballot (caller-verified room member; one per voter). */
  async castRatificationBallot(
    roomId: string,
    voteId: string,
    voterUserId: string,
    choice: RatificationChoice,
    eligible: boolean,
  ): Promise<GovernanceResult<void>> {
    if (!eligible) return err('not_member', 'Only room members may vote on ratification.');
    const vote = await this.deps.stores.ratifications.get(voteId);
    // The vote must belong to THIS room (the eligibility gate was computed for the
    // URL room) — never count a foreign room's vote with it.
    if (vote === null || vote.roomId !== roomId) {
      return err('not_found', 'Ratification vote not found for this room.');
    }
    // Reject after the published close time (status flips only on the tick).
    if (vote.status !== 'open' || this.deps.now().getTime() >= Date.parse(vote.closesAt)) {
      return err('not_open', 'Ratification vote is not open.');
    }
    const cast = await this.deps.stores.ratificationBallots.cast({
      voteId,
      voterUserId,
      choice,
      castAt: this.iso(),
    });
    if (!cast) return err('already_voted', 'This voter has already cast a ballot.');
    return ok(undefined);
  }

  /**
   * Settle a ratification vote (kernel-tallied, fail-safe). On a quorum-meeting
   * approving majority the model is ACTIVATED (the only production path to an
   * active binding); otherwise the model stays eligible (re-votable) and nothing
   * changes. The settled tally snapshot survives voter erasure.
   */
  async settleRatification(
    voteId: string,
    eligibleCount: number,
  ): Promise<GovernanceResult<{ outcome: RatificationOutcome; activated: boolean }>> {
    const vote = await this.deps.stores.ratifications.get(voteId);
    if (!vote) return err('not_found', 'Ratification vote not found.');
    if (vote.status !== 'open') return err('not_open', 'Ratification vote is not open.');
    const lawPack = await this.resolveLawPack(vote.roomId, vote.lawPackId);
    const ballots = await this.deps.stores.ratificationBallots.listByVote(voteId);
    const result = tallyRatification(
      ballots.map((b) => ({ voterUserId: b.voterUserId, choice: b.choice })),
      { minQuorum: vote.minQuorum, minTurnout: lawPack.election.minTurnout },
      { eligibleCount },
    );
    await this.deps.stores.ratifications.patch(voteId, {
      status: 'settled',
      outcome: result.outcome,
      tally: result,
      settledAt: this.iso(),
    });
    let activated = false;
    if (result.outcome === 'approved') {
      const activate = await this.approveModel(vote.roomId, vote.modelId, voteId, vote.lawPackId);
      activated = activate.ok;
    }
    return ok({ outcome: result.outcome, activated });
  }

  /** The room's single open ratification vote (for the in-room voting surface). */
  async getOpenRatification(roomId: string) {
    return this.deps.stores.ratifications.getOpenForRoom(roomId);
  }

  /** Ballots cast on a vote (for the live tally on the voting surface). */
  async ratificationBallots(voteId: string) {
    return this.deps.stores.ratificationBallots.listByVote(voteId);
  }

  /** Scheduler tick: settle every ratification vote whose window has closed. */
  async runRatificationLifecycle(
    eligibleVoterCount: (roomId: string) => Promise<number>,
    nowMs: number = this.deps.now().getTime(),
  ): Promise<{ settled: number; activated: number }> {
    const open = await this.deps.stores.ratifications.listOpen();
    let settled = 0;
    let activated = 0;
    for (const vote of open) {
      if (nowMs < Date.parse(vote.closesAt)) continue;
      const count = await eligibleVoterCount(vote.roomId);
      const result = await this.settleRatification(vote.voteId, count);
      if (result.ok) {
        settled += 1;
        if (result.value.activated) activated += 1;
      }
    }
    return { settled, activated };
  }

  // --- Stage 3: bounded moderation agent -----------------------------------

  /**
   * Moderate one contribution. Returns null when the room has no active binding
   * (fallback to the platform baseline). The decision is deterministic policy-DSL
   * evaluation gated by the capability descriptor; injected content cannot change
   * the authority (ADR-5). Every effect is logged with the provenance triple.
   */
  async moderate(
    roomId: string,
    context: ModerationContext,
    subjectRef: string,
    // The caller (the forum adapter) already read the binding to gate the
    // author-history lookup; passing it avoids a second store read on the hot
    // contribution path (#12). Omit it (or pass undefined) to read here.
    prefetchedBinding?: BindingRecord | null,
  ): Promise<GovernanceResult<ModerationDecision | null>> {
    const binding =
      prefetchedBinding !== undefined
        ? prefetchedBinding
        : await this.deps.stores.bindings.get(roomId);
    if (binding === null || !binding.active) return ok(null);
    const model = await this.deps.stores.models.get(binding.modelId);
    if (!model) return ok(null);
    const decision = evaluatePolicy(model.bundle.moderationRules, context);
    // Capability gate: if the bundle's decided action exceeds granted capability,
    // downgrade to flag_for_review (route to the human floor) rather than act.
    const effective = this.gateDecision(decision, binding.capabilityDescriptor);
    if (effective.action !== 'allow') {
      await this.deps.stores.agentActions.append({
        actionId: this.deps.uuid(),
        roomId,
        bindingModelId: binding.modelId,
        promptHash: this.deps.digest(`${binding.modelId}:${binding.promptId}`),
        actionType: `moderate.${effective.action}`,
        subjectRef,
        lawPackRuleRef: effective.ruleRef,
        statementOfReasons: effective.reason,
        reversible: effective.action !== 'remove',
        createdAt: this.iso(),
      });
    }
    return ok(effective);
  }

  /** The platform floor's room-governance-freeze: deactivate the agent at once. */
  async freezeAgent(roomId: string): Promise<GovernanceResult<void>> {
    await this.deps.stores.bindings.setActive(roomId, false);
    return ok(undefined);
  }

  /**
   * The platform floor re-enables a previously approved (and frozen) agent. This
   * only flips the existing community-approved binding back to active — it mints
   * no authority and reinstates no floor-removed content. Returns whether a
   * binding existed to reactivate (`false` ⇒ the room has no agent).
   */
  async reactivateAgent(roomId: string): Promise<GovernanceResult<{ reactivated: boolean }>> {
    const updated = await this.deps.stores.bindings.setActive(roomId, true);
    return ok({ reactivated: updated !== null });
  }

  // --- Stage 4: lawmaking facilitation (capability-gated, deterministic) ----
  //
  // The agent may FACILITATE community lawmaking within its granted capabilities:
  // summarise a proposal neutrally, schedule its vote window, and attest a
  // PLATFORM-COMPUTED outcome. It has NO vote/tally/weight capability, so it can
  // never compute or bias a result (ADR-8). Every facilitation is capability-gated
  // and logged with the provenance triple; an ungranted capability is refused
  // (never silently performed). The proposal data is supplied by the caller (the
  // WS-M proposal lifecycle wires these once it lands).

  /** Produce a neutral proposal summary (requires `lawmaking.summarize`). */
  async facilitateSummary(
    roomId: string,
    proposalInput: unknown,
  ): Promise<GovernanceResult<ProposalSummary>> {
    const gate = await this.requireFacilitation(roomId, 'lawmaking.summarize');
    if (!gate.ok) return gate;
    const parsed = proposalInputSchema.safeParse(proposalInput);
    if (!parsed.success) return err('invalid_proposal', 'The proposal is invalid.');
    const summary = summarizeProposal(parsed.data);
    await this.logFacilitation(
      gate.value,
      'lawmaking.summarize',
      parsed.data.proposalId,
      summary.summary,
    );
    return ok(summary);
  }

  /** Schedule a proposal vote window (requires `lawmaking.schedule`). */
  async facilitateSchedule(
    roomId: string,
    proposalId: string,
  ): Promise<GovernanceResult<VoteSchedule>> {
    const gate = await this.requireFacilitation(roomId, 'lawmaking.schedule');
    if (!gate.ok) return gate;
    const schedule = scheduleProposalVote(
      proposalId,
      this.deps.now().getTime(),
      this.deps.config.electionWindowSeconds,
    );
    await this.logFacilitation(
      gate.value,
      'lawmaking.schedule',
      proposalId,
      `Vote window ${schedule.opensAt} → ${schedule.closesAt}.`,
    );
    return ok(schedule);
  }

  /**
   * Attest a PLATFORM-COMPUTED vote outcome (requires `lawmaking.attest`). The
   * caller passes the settled tally (from `tallyElection`/`tallyRatification`);
   * the agent only restates it — it cannot compute or weight it (ADR-8).
   */
  async facilitateAttest(
    roomId: string,
    proposalId: string,
    result: AttestableResult,
  ): Promise<GovernanceResult<OutcomeAttestation>> {
    const gate = await this.requireFacilitation(roomId, 'lawmaking.attest');
    if (!gate.ok) return gate;
    const attestation = attestOutcome(proposalId, result);
    await this.logFacilitation(gate.value, 'lawmaking.attest', proposalId, attestation.statement);
    return ok(attestation);
  }

  /** Resolve the active binding and assert it carries the lawmaking capability. */
  private async requireFacilitation(
    roomId: string,
    capability: Capability,
  ): Promise<GovernanceResult<BindingRecord>> {
    const binding = await this.deps.stores.bindings.get(roomId);
    if (binding === null || !binding.active) {
      return err('no_agent', 'No active agent for the room.');
    }
    if (!hasCapability(binding.capabilityDescriptor, capability)) {
      return err('no_capability', `The agent lacks the ${capability} capability.`);
    }
    return ok(binding);
  }

  /** Append a facilitation action to the agent audit log (the provenance triple). */
  private async logFacilitation(
    binding: BindingRecord,
    actionType: string,
    subjectRef: string,
    statementOfReasons: string,
  ): Promise<void> {
    await this.deps.stores.agentActions.append({
      actionId: this.deps.uuid(),
      roomId: binding.roomId,
      bindingModelId: binding.modelId,
      promptHash: this.deps.digest(`${binding.modelId}:${binding.promptId}`),
      actionType,
      subjectRef,
      lawPackRuleRef: null,
      statementOfReasons,
      reversible: true,
      createdAt: this.iso(),
    });
  }

  // --- read surface (in-room transparency) ---------------------------------

  async listModels(roomId: string) {
    return this.deps.stores.models.listByRoom(roomId);
  }
  async getModel(modelId: string) {
    return this.deps.stores.models.get(modelId);
  }
  async getBinding(roomId: string) {
    return this.deps.stores.bindings.get(roomId);
  }
  async recentAgentActions(roomId: string, limit: number) {
    return this.deps.stores.agentActions.listByRoom(roomId, limit);
  }

  // --- Stage 4/5: law-pack + kernel-backed treasury (behind the crypto flag) ---

  /**
   * Register a community-voted law-pack for the room (WS-U.4.1a) — the bounds the
   * agent runs within. Seat-holder only (symmetric with `proposeModel`): the
   * steward proposes the bounds; binding them is the member-ratification step
   * (`approveModel` with this `lawPackId`).
   */
  async proposeLawPack(
    roomId: string,
    userId: string,
    lawPackInput: unknown,
  ): Promise<GovernanceResult<{ lawPackId: string }>> {
    const seat = await this.deps.stores.seats.get(roomId);
    if (!seat || seat.holderUserId !== userId) {
      return err('not_steward', 'Only the elected room steward may propose a law-pack.');
    }
    const parsed = lawPackSchema.safeParse(lawPackInput);
    if (!parsed.success) return err('invalid_law_pack', 'The law-pack is invalid.');
    const lawPackId = this.deps.uuid();
    await this.deps.stores.lawPacks.insert({
      lawPackId,
      roomId,
      version: parsed.data.version,
      lawPack: { ...parsed.data, lawPackId },
      createdAt: this.iso(),
    });
    return ok({ lawPackId });
  }

  /**
   * Submit a treasury action. The kernel proves law-pack compliance; the agent
   * holds no keys (ADR-4). Fail-closed when crypto is disabled or the capability
   * is not granted. The verdict (evidence or typed rejection) is logged.
   */
  async executeTreasuryAction(
    roomId: string,
    input: {
      category: string;
      amount: number;
      asset: string | null;
      coiDeclared: boolean;
      proposedAt: string;
    },
  ): Promise<GovernanceResult<Verdict>> {
    if (!this.deps.config.cryptoEnabled)
      return err('crypto_disabled', 'Crypto features are disabled.');
    const binding = await this.deps.stores.bindings.get(roomId);
    if (binding === null || !binding.active)
      return err('no_agent', 'No active agent for the room.');
    if (!hasCapability(binding.capabilityDescriptor, 'gateway.submit_signed_action')) {
      return err('no_capability', 'The agent lacks the gateway submission capability.');
    }
    const lawPack = await this.resolveLawPack(roomId, binding.lawPackId);
    const action = treasuryActionSchema.safeParse({
      actionId: this.deps.uuid(),
      roomId,
      category: input.category,
      amount: input.amount,
      asset: input.asset,
      timestamp: this.iso(),
      proposedAt: input.proposedAt,
      coiDeclared: input.coiDeclared,
      proposalRef: null,
    });
    if (!action.success) return err('invalid_action', 'The treasury action is malformed.');
    const history: TreasuryHistoryEntry[] = (
      await this.deps.stores.treasuryActions.acceptedByRoom(roomId)
    ).map((a) => ({
      category: a.category as TreasuryHistoryEntry['category'],
      amount: a.amount,
      timestamp: a.executedAt,
    }));
    const verdict = evaluateTreasuryAction(action.data, lawPack.treasury, history, {
      cryptoEnabled: this.deps.config.cryptoEnabled,
      now: this.iso(),
    });
    const record: TreasuryActionRecord = {
      actionId: action.data.actionId,
      roomId,
      category: input.category,
      amount: input.amount,
      asset: input.asset,
      accepted: verdict.accepted,
      verdict,
      executedAt: this.iso(),
    };
    await this.deps.stores.treasuryActions.append(record);
    return ok(verdict);
  }

  // --- helpers --------------------------------------------------------------

  private gateDecision(
    decision: ModerationDecision,
    descriptor: CapabilityDescriptor,
  ): ModerationDecision {
    if (decision.action === 'allow') return decision;
    const cap = MOD_ACTION_CAPABILITY[decision.action];
    if (hasCapability(descriptor, cap)) return decision;
    // Not permitted to take this action ⇒ downgrade to a human-floor referral.
    if (actionSeverity(decision.action) > actionSeverity('flag_for_review')) {
      return { ...decision, action: 'flag_for_review' };
    }
    return decision;
  }

  private async firstPromptFor(modelId: string) {
    return this.deps.stores.prompts.getByModel(modelId);
  }

  private async resolveLawPack(roomId: string, lawPackId: string | null): Promise<LawPack> {
    if (lawPackId) {
      const stored = await this.deps.stores.lawPacks.get(lawPackId);
      // Defense-in-depth: a law-pack only applies to its OWN room (callers reject
      // a foreign id up front; this guards any residual cross-room reference).
      if (stored && stored.roomId === roomId) return stored.lawPack;
    }
    return defaultModerationLawPack(roomId);
  }

  /**
   * A supplied law-pack must belong to the room being governed — otherwise a
   * steward could bind another room's bounds (capabilities + election rules) that
   * this room never voted. Returns a typed error rather than silently defaulting.
   */
  private async assertLawPackInRoom(
    roomId: string,
    lawPackId: string | null,
  ): Promise<GovernanceResult<void>> {
    if (lawPackId === null) return ok(undefined);
    const stored = await this.deps.stores.lawPacks.get(lawPackId);
    if (!stored || stored.roomId !== roomId) {
      return err('invalid_law_pack', 'The law-pack does not belong to this room.');
    }
    return ok(undefined);
  }

  /**
   * The room's effective steward-election rules: the community-voted bounds the
   * room's agent binding carries (its law-pack `election`), or the platform
   * baseline when the room has bound no law-pack. Reading the binding here keeps
   * the service within its own `knomosis` stores (no cross-context import). The
   * binding's law-pack applies even while the agent is frozen — a freeze pauses
   * the agent, not the steward seat.
   */
  private async resolveElectionRules(roomId: string): Promise<ElectionRules> {
    const binding = await this.deps.stores.bindings.get(roomId);
    const lawPack = await this.resolveLawPack(roomId, binding?.lawPackId ?? null);
    return lawPack.election;
  }
}

/** Maps a non-allow moderation action to the capability that authorizes it. */
const MOD_ACTION_CAPABILITY: Record<Exclude<ModerationAction, 'allow'>, Capability> = {
  flag_for_review: 'moderate.flag',
  warn: 'moderate.warn',
  restrict: 'moderate.restrict',
  remove: 'moderate.remove',
};

/**
 * Canonical, key-order-independent serialization for digesting a bundle — so two
 * semantically identical bundles with reordered keys hash equal (the
 * `(room_id, artifact_digest)` duplicate guard holds, and the member-downloadable
 * digest matches the canonical hash clients compute from `@licio/governance`).
 */
function stableBundle(bundle: GovernancePolicyBundle): string {
  return canonicalize(bundle);
}

/** Admission failures: the model's decision must be within each fixture's band. */
export function admissionFailures(bundle: GovernancePolicyBundle): string[] {
  const failures: string[] = [];
  // Capability hygiene is structural (floor-reserved is inexpressible), but assert
  // the bundle requests only sane capabilities by deriving against an all-permit.
  for (const fixture of PLATFORM_EVAL_SET) {
    const decision = evaluatePolicy(bundle.moderationRules, fixture.context);
    const sev = actionSeverity(decision.action);
    if (sev < actionSeverity(fixture.minAction) || sev > actionSeverity(fixture.maxAction)) {
      failures.push(fixture.label);
    }
  }
  return failures;
}

/** A moderation-only default law-pack (no treasury) for crypto-off rooms. */
export function defaultModerationLawPack(roomId: string): LawPack {
  return {
    lawPackId: `default-mod:${roomId}`,
    version: '1',
    allowedProposalTypes: ['model_prompt_approval', 'steward_election'],
    permittedCapabilities: [
      'moderate.flag',
      'moderate.warn',
      'moderate.restrict',
      'moderate.remove',
      'moderate.restore',
      'lawmaking.summarize',
    ],
    treasury: {
      caps: [],
      minIntervalSeconds: 0,
      timelockSeconds: 0,
      materialThreshold: 0,
      requireCoiFor: [],
      investment: null,
    },
    election: {
      weightModel: 'one_civic_account_one_vote',
      perAccountCap: 1,
      minQuorum: 1,
      minTurnout: 0,
      termSeconds: 365 * 24 * 60 * 60,
    },
  };
}

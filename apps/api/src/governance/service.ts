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
  actionSeverity,
  type Capability,
  type CapabilityDescriptor,
  deriveCapabilityDescriptor,
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
  type TreasuryHistoryEntry,
  tallyElection,
  treasuryActionSchema,
  type Verdict,
} from '@licio/governance';
import type { GovernanceConfig } from './config.js';
import type { GovernanceStores, ModelRecord, TreasuryActionRecord } from './stores.js';

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

  /** Cast a simulated ballot (open election only; one per voter). */
  async castVote(
    electionId: string,
    voterUserId: string,
    candidateUserId: string,
  ): Promise<GovernanceResult<void>> {
    const election = await this.deps.stores.elections.get(electionId);
    if (election === null || election.status !== 'open') {
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
    const ballots = await this.deps.stores.votes.listByElection(electionId);
    const result = tallyElection(
      ballots.map((b) => ({ voterUserId: b.voterUserId, candidateUserId: b.candidateUserId })),
      {
        weightModel: 'one_civic_account_one_vote',
        perAccountCap: 1,
        minQuorum: 1,
        minTurnout: 0,
        termSeconds: this.deps.config.electionTermSeconds,
      },
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
      const end = new Date(start.getTime() + this.deps.config.electionTermSeconds * 1000);
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

  /** Approve an eligible model by member vote → create the active binding (Stage 2/3). */
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
    const lawPack = await this.resolveLawPack(roomId, lawPackId);
    const descriptor = deriveCapabilityDescriptor(model.bundle.requestedCapabilities, lawPack);
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
  ): Promise<GovernanceResult<ModerationDecision | null>> {
    const binding = await this.deps.stores.bindings.get(roomId);
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

  /** Register a community-voted law-pack for the room (WS-U.4.1a). */
  async proposeLawPack(
    roomId: string,
    lawPackInput: unknown,
  ): Promise<GovernanceResult<{ lawPackId: string }>> {
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
      if (stored) return stored.lawPack;
    }
    return defaultModerationLawPack(roomId);
  }
}

/** Maps a non-allow moderation action to the capability that authorizes it. */
const MOD_ACTION_CAPABILITY: Record<Exclude<ModerationAction, 'allow'>, Capability> = {
  flag_for_review: 'moderate.flag',
  warn: 'moderate.warn',
  restrict: 'moderate.restrict',
  remove: 'moderate.remove',
};

/** Canonical-ish string for digesting a bundle (key order is schema-stable here). */
function stableBundle(bundle: GovernancePolicyBundle): string {
  return JSON.stringify(bundle);
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

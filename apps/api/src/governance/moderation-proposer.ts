// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-U ADR-9 in-room moderation proposer port. The in-room moderation MODEL is
// an LLM (the deterministic policy-DSL was removed): it CLASSIFIES a
// contribution, and the GovernanceService's deterministic wrapper bounds that
// classification (escalate-to-human-review ceiling + community-capability clamp,
// `@licio/governance` boundAiModerationAction) before it can have any effect.
// The classification is enforced OUTSIDE the model (ADR-5): the model proposes,
// the wrapper decides.
//
// A proposer NEVER throws (fire-safe): on any model failure — timeout, breaker
// open, budget exhausted, prohibited-use block, transport error, invalid output
// — it returns `unavailable`, and the wrapper degrades to the always-on platform
// baseline (WS-J) while the contribution is enqueued for DEFERRED re-moderation
// (the model's judgment is delayed, never dropped). A `decided` result carries
// the model's proposed action; `decided` with `allow` means "the model judged it
// benign" (no escalation, no deferral).

import type { ModerationAction, ModerationContext } from '@licio/governance';
import type { HubModelRef } from '@licio/shared';

export interface ModerationProposalRequest {
  roomId: string;
  /** The moderated contribution id (matches the agent-action audit log). */
  subjectRef: string;
  /** The room-scoped, PII-free context (content + bucketed signals). */
  context: ModerationContext;
  /** The room's member-ratified moderation prompt (conditions a generalist
   *  moderation model; a guard-dialect model enforces its fixed taxonomy
   *  instead). Null ⇒ the platform default. */
  moderationPrompt: string | null;
  /** The bundle's member-selected hub model for the MODERATION role (WS-U
   *  model candidacy). Null ⇒ the platform moderation-lane model. The proposer
   *  resolves it per call; an unresolvable selection is `unavailable`, never a
   *  silent fallback onto a model the room did not ratify. */
  modelRef: HubModelRef | null;
}

/** The model's proposed action + reason, and the provenance of the invocation. */
export interface ModerationProposal {
  action: ModerationAction;
  reason: string;
  /** The immutable AIOutputRecord id of this governed invocation (provenance);
   *  null for a proposer with no per-invocation record (e.g. a dev stand-in). */
  outputId: string | null;
}

export type ModerationProposerResult =
  /** The model produced a bounded classification (may be `allow`). */
  | { status: 'decided'; proposal: ModerationProposal }
  /** The model could not classify this contribution (outage). The wrapper
   *  degrades to the platform baseline and enqueues for deferred re-moderation.
   *  `code` is a metadata reason (transport/refusal/truncated/invalid_output/
   *  budget_exhausted/breaker_open) for observability. */
  | { status: 'unavailable'; code: string };

export interface ModerationProposer {
  /** Backend kind — surfaced in logs/metrics + the audit provenance, never an
   *  authority bit (the wrapper holds all authority). */
  readonly kind: 'llm' | 'deterministic';
  /**
   * A STABLE identity of the backend that will classify — the deterministic
   * classifier, or a specific LLM backend + model (e.g. `llm:<card>:<model_id>`).
   * A model's admission (`evaluateModel`) is pinned to the backendId that ran it;
   * `GovernanceService.moderate` refuses to moderate under a DIFFERENT backendId
   * than the one that admitted the room's model (an un-vetted backend swap
   * fails closed to the platform baseline until re-admission — WS-U ADR-9 review).
   * Optional so a test double may omit it (⇒ the gate is skipped for that double);
   * the real proposers always set it.
   */
  readonly backendId?: string;
  /**
   * Resolve the admission-pin backend id for a room model selection (null ref
   * ⇒ the proposer's own lane, i.e. `backendId`). Returns null when the
   * selection is not currently resolvable — no configured runtime serves it,
   * or the WS-K gate refused its identity — so admission stays retryable and
   * the live surfaces fail closed rather than run un-vetted. Optional so a
   * test double may omit it; when absent, the static `backendId` stands for
   * every selection.
   */
  resolveBackendId?(ref: HubModelRef | null): Promise<string | null>;
  /** Classify one contribution. NEVER throws — any failure is `unavailable`. */
  propose(request: ModerationProposalRequest): Promise<ModerationProposerResult>;
}

/**
 * OBSERVABILITY hook fired when the model was UNAVAILABLE for a contribution (the
 * wrapper degraded to the platform baseline), WS-U ADR-9. The DURABLE mechanism is
 * the service's own `pendingRemoderation` store — `GovernanceService.moderate`
 * persists the contribution there so the model's judgment is delayed, never
 * dropped, and the scheduler sweep retries it. This sink is a PARALLEL notification
 * (metrics / logging), not the enqueue; absent ⇒ no notification (the durable
 * enqueue still happens). Must not throw — the caller fires it un-awaited.
 */
export type ModerationDeferralSink = (
  roomId: string,
  subjectRef: string,
  context: ModerationContext,
) => void;

/** One recorded in-room moderation decision (observability; metadata only). */
export interface ModerationDecisionObservation {
  roomId: string;
  subjectRef: string;
  /** The model's RAW proposed action (before the deterministic wrapper). */
  proposedAction: ModerationAction;
  /** The action the deterministic wrapper actually permitted. */
  boundedAction: ModerationAction;
  /** True when the ceiling and/or capability clamp reduced the model's proposal. */
  clamped: boolean;
  /** The AIOutputRecord id of the invocation (provenance); null if none. */
  outputId: string | null;
  createdAt: string;
}

/** Called on every DECIDED moderation for observability (wired at boot to the
 *  moderation decision log; absent ⇒ no log). Must not throw. */
export type ModerationDecisionSink = (record: ModerationDecisionObservation) => void;

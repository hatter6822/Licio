// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-U ADR-9 (slice 2) shadow-moderation port. The in-room agent's moderation
// DECISIONS stay pure deterministic policy-DSL (ADR-1); this port runs a
// governed LLM ALONGSIDE the DSL, SCORE-BLIND, purely to MEASURE agreement
// before any authority question arises. The advisor never sees the DSL's
// decision, never influences the moderation outcome, never reaches the forum or
// ranking — `GovernanceService.moderate` returns the authoritative gated DSL
// decision unchanged whether or not this runs, agrees, or fails (the authority
// invariant). Its output is an observability divergence record, nothing more.
//
// The default is NO advisor (the deterministic-only path, byte-identical to
// before). When an operator has enabled an LLM backend with shadow moderation
// on, boot wires the governed impl (`apps/api/src/ai-governance/llm/advisor.ts`).

import type { ModerationAction, ModerationContext } from '@licio/governance';

export interface ModerationShadowRequest {
  roomId: string;
  /** The moderated contribution id (matches the agent-action audit log). */
  subjectRef: string;
  /** The room-scoped, PII-free context the DSL also evaluated. */
  context: ModerationContext;
  /** The room's member-ratified agent prompt (conditions the advisor so the
   *  comparison is fair — the DSL already encodes the room's norms). */
  roomPromptText: string | null;
  /** The AUTHORITATIVE gated DSL action. Used ONLY to compute the divergence
   *  AFTER the advisor forms its independent verdict — it is NEVER placed in
   *  the model prompt, so the advisor stays score-blind. */
  dslAction: ModerationAction;
}

export interface ModerationShadowAdvisor {
  /** Backend kind — surfaced in logs/metrics, never an authority bit. */
  readonly kind: 'llm';
  /**
   * Run the score-blind advisor and record the divergence. Resolves after the
   * record is written (so tests can await it); NEVER throws and NEVER returns a
   * value the caller acts on — every failure (guard block, budget, breaker,
   * transport, schema) is swallowed, counted, and simply skips the record. The
   * caller fires this and does not await it on the hot path.
   */
  recordShadow(request: ModerationShadowRequest): Promise<void>;
}

// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-U ADR-3 governed natural-language provider port. The agent's advisory NL
// surfaces (today: the lawmaking proposal summary) are produced behind this
// port. The shipped default is DETERMINISTIC — the pure @licio/governance
// summariser, no external calls, no secrets — and the GovernanceService uses it
// whenever no provider is injected. A real LLM backend is wired behind the SAME
// port at boot (apps/api/src/ai-governance/llm/), where it runs under the full
// WS-K governed-execution machinery (registry admission, pre-execution
// prohibited-use guard, deterministic quality/grounding gate, immutable
// AIOutputRecord) and FAILS CLOSED back to the deterministic output on any
// error. The provider never carries authority: whatever it returns is advisory
// text, capability-gated and audit-logged by the GovernanceService exactly like
// the deterministic output (ADR-5) — a model cannot escalate by phrasing.

import {
  type PolicyBundleConfig,
  type ProposalInput,
  type ProposalSummary,
  summarizeProposal,
} from '@licio/governance';
import type { HubModelRef } from '@licio/shared';

/** The bundle `promptTemplates` key consulted for the lawmaking summary. */
export const LAWMAKING_SUMMARIZE_TEMPLATE_KEY = 'lawmaking.summarize';

export interface LawmakingSummaryRequest {
  roomId: string;
  proposal: ProposalInput;
  /** The room's member-ratified agent prompt (the active binding's
   *  PromptRecord), resolved by the caller for LLM backends; the deterministic
   *  default ignores it. */
  roomPromptText: string | null;
  /** The bundle's `lawmaking.summarize` prompt template, when declared. */
  promptTemplate: string | null;
  /** The bundle's NL style knob (ADR-3; deterministic default: neutral_brief). */
  summaryStyle: PolicyBundleConfig['summaryStyle'];
  /** The bundle's member-selected hub ADJUDICATION model (WS-U model
   *  candidacy): the summariser rides the adjudication lane, so a room that
   *  ratified its own adjudication model gets its summaries from THAT model
   *  too. Null ⇒ the platform lane; an unresolvable ref throws (⇒ the
   *  deterministic summary serves), never a silent fallback onto an
   *  unratified model. The deterministic default ignores it. */
  adjudicationRef: HubModelRef | null;
}

export interface GovernanceNlProvider {
  /** Which backend this is — surfaced in logs/metrics, never an authority bit. */
  readonly kind: 'deterministic' | 'llm';
  /**
   * Produce the neutral proposal summary. An LLM backend MAY throw (breaker
   * open, budget exhausted, guard block, transport error, schema violation,
   * quality-gate rejection): the GovernanceService then falls back to the
   * deterministic summary — the advisory surface degrades, it never fails.
   * A throwing backend is responsible for its own logging/metrics.
   */
  summarizeProposal(request: LawmakingSummaryRequest): Promise<ProposalSummary>;
}

/** The shipped default: the pure deterministic summariser (never throws). */
export function createDeterministicNlProvider(): GovernanceNlProvider {
  return {
    kind: 'deterministic',
    async summarizeProposal(request) {
      return summarizeProposal(request.proposal);
    },
  };
}

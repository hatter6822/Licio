// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The governed execution of the debate adjudicator (WS-T, SPEC §24.1/§24.6).
// The deterministic, auditable, verifiable SHELL around the probabilistic neural
// model (@licio/ai-governance debate-judge):
//
//   1. the pre-execution ProhibitedUseGuard classifies the `adjudicate_debate`
//      invocation (advisory effect, no wealth signals) BEFORE the model runs — a
//      blocked request never reaches the model (fail-closed: no verdict);
//   2. the pure neural forward pass renders the probabilistic verdict;
//   3. an IMMUTABLE AIOutputRecord is written with the config hash over the
//      DEBATE_ADJUDICATOR config (which pins the weights version), so every
//      verdict is attributable + replayable.
//
// The room STEWARD may overrule the returned verdict for 24h (the human-in-the-
// loop remedy); that override lives in the forum arena service, not here.
import { type DebateJudgeVerdict, judgeDebate } from '@licio/ai-governance';
import type { DebateJudgeInput } from '@licio/shared';
import type { ProhibitedUseGuard } from './guard.js';
import { DEBATE_ADJUDICATOR } from './models.js';
import { recordAiOutput } from './output-records.js';
import type { AiOutputRecordStore } from './stores.js';

export interface AdjudicateDebateDeps {
  guard: ProhibitedUseGuard;
  outputRecords: AiOutputRecordStore;
  now: () => number;
}

export type AdjudicateOutcome =
  | { ok: true; verdict: DebateJudgeVerdict; outputId: string }
  | { ok: false; reason: 'blocked' };

/**
 * Run the governed adjudicator over a debate.  `debateId` is the audit context
 * ref; the returned `outputId` is the immutable AIOutputRecord backing the
 * verdict (referenced from the arena row).
 */
export async function adjudicateDebate(
  deps: AdjudicateDebateDeps,
  debateId: string,
  input: DebateJudgeInput,
): Promise<AdjudicateOutcome> {
  // 1. Pre-execution guard (advisory, no wealth signals, no risk-identity mask).
  const decision = await deps.guard.check({
    use_case_id: 'debate_adjudication',
    capability: 'adjudicate_debate',
    caller: 'forum.debate',
    context_ref: debateId,
    effect: 'advisory',
    uses_wealth_signals: false,
    targets_risk_identity: false,
  });
  if (decision.decision === 'block') return { ok: false, reason: 'blocked' };

  // 2. The pure probabilistic neural forward pass.
  const verdict = judgeDebate(input);

  // 3. The immutable, replayable AIOutputRecord (config hash pins the weights).
  const nowIso = new Date(deps.now()).toISOString();
  const record = await recordAiOutput(deps.outputRecords, {
    modelName: DEBATE_ADJUDICATOR.name,
    modelVersion: DEBATE_ADJUDICATOR.version,
    promptTemplateId: DEBATE_ADJUDICATOR.promptTemplateId,
    config: DEBATE_ADJUDICATOR.config,
    inputRefs: [debateId],
    // The verdict summary as the audit output ref (winner + confidence, no PII).
    outputRef: `${verdict.winner}:${verdict.verdict}:${verdict.confidence.toFixed(4)}`,
    useCaseId: 'debate_adjudication',
    nowIso,
  });
  return { ok: true, verdict, outputId: record.output_id };
}

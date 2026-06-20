// SPDX-License-Identifier: AGPL-3.0-or-later
//
// AI around Knomosis governance (WS-K.2.2a, SPEC §24.5). The §24.5 permitted
// capabilities, all ADVISORY to stewards and never autonomous: summarize a
// proposal (citing the specific fields, flagging material uncertainty), identify
// missing fields, highlight conflicts of interest, and detect scam-pattern
// language. The prohibited capabilities are blocked by the SAME pre-execution
// guard (guard.ts) — this module never reaches them. Every proposal summary is
// editable/contestable by stewards (never final). The proposal DATA is supplied
// by the WS-M seam (the caller passes the fields); the governance machinery is
// independent of WS-M's data model.

import { randomUUID } from 'node:crypto';
import {
  containsAnyTerm,
  type GovernanceAdvisory,
  type GovernanceAdvisoryKind,
  type GovernanceProposalSummary,
  governanceAdvisorySchema,
  governanceProposalSummarySchema,
} from '@licio/ai-governance';
import type { ProhibitedUseGuard } from './guard.js';
import type { AiGovernanceMetrics } from './metrics.js';
import { GOVERNANCE_SUMMARIZER } from './models.js';
import { recordAiOutput } from './output-records.js';
import type { AiOutputRecordStore, GovernanceSummaryStore } from './stores.js';

/** Proposal fields a complete proposal should carry (the §24.5 "missing budget
 *  fields, citations, or unclear recipients" check). */
export const REQUIRED_PROPOSAL_FIELDS = ['budget', 'recipient', 'citations'] as const;

/** Non-graphic scam-associated language markers (advisory only). Production
 *  injects the WS-A/WS-N policy list. */
export const DEFAULT_SCAM_MARKERS: readonly string[] = [
  'guaranteed returns',
  'risk-free',
  'act now',
  'send funds to',
  'double your',
  'limited time offer',
];

export interface GovernanceAiDeps {
  governanceSummaries: GovernanceSummaryStore;
  outputRecords: AiOutputRecordStore;
  guard: ProhibitedUseGuard;
  scamMarkers?: () => readonly string[];
  metrics: AiGovernanceMetrics;
  log: (event: string, meta: Record<string, unknown>) => void;
  now: () => number;
}

export interface ProposalSummaryInput {
  proposalRef: string;
  /** The proposal fields (WS-M seam): field name → value. */
  fields: Record<string, string>;
}

/** Identify required proposal fields that are missing or empty (advisory). */
export function detectMissingFields(fields: Record<string, string>): string[] {
  return REQUIRED_PROPOSAL_FIELDS.filter(
    (f) => fields[f] === undefined || fields[f]?.trim() === '',
  );
}

/** Summarize a proposal in plain language (WS-K.2.2a). Cites the specific
 *  fields, flags material uncertainty, machine-generated, contestable. */
export async function summarizeProposal(
  deps: GovernanceAiDeps,
  input: ProposalSummaryInput,
): Promise<GovernanceProposalSummary> {
  await deps.guard.enforce({
    use_case_id: 'governance_assistance',
    capability: 'gov_summarize_proposal',
    caller: 'governance-ai',
    context_ref: input.proposalRef,
    effect: 'advisory',
    uses_wealth_signals: false,
    targets_risk_identity: false,
  });

  const nowIso = new Date(deps.now()).toISOString();
  const citedFields = Object.keys(input.fields).filter((k) => input.fields[k]?.trim() !== '');
  const missing = detectMissingFields(input.fields);
  const uncertainty =
    missing.length > 0 ? `Material uncertainty: missing or unclear ${missing.join(', ')}.` : null;
  const body =
    citedFields.length > 0
      ? `This proposal specifies: ${citedFields
          .map((f) => `${f} — ${input.fields[f]}`)
          .join('; ')}.`
      : 'This proposal specifies no readable fields.';

  const output = await recordAiOutput(deps.outputRecords, {
    modelName: GOVERNANCE_SUMMARIZER.name,
    modelVersion: GOVERNANCE_SUMMARIZER.version,
    promptTemplateId: GOVERNANCE_SUMMARIZER.promptTemplateId,
    config: GOVERNANCE_SUMMARIZER.config,
    inputRefs: [input.proposalRef],
    outputRef: input.proposalRef,
    useCaseId: 'governance_assistance',
    nowIso,
  });

  const summary = governanceProposalSummarySchema.parse({
    summary_id: `govsum-${randomUUID()}`,
    proposal_ref: input.proposalRef,
    // Always cite at least one field; an empty proposal cites the marker field.
    cited_fields: citedFields.length > 0 ? citedFields : ['(none provided)'],
    body,
    material_uncertainty: uncertainty,
    uncertainty_flagged: uncertainty !== null,
    label: 'machine-generated',
    contestable: true,
    steward_edited: false,
    output_id: output.output_id,
    model_name: GOVERNANCE_SUMMARIZER.name,
    model_version: GOVERNANCE_SUMMARIZER.version,
    generated_at: nowIso,
  } satisfies GovernanceProposalSummary);
  await deps.governanceSummaries.put(summary);

  deps.metrics.increment('ai.governance.summary.generated');
  deps.log('governance.ai.summary.generated', {
    proposal_ref: input.proposalRef,
    cited_field_count: summary.cited_fields.length,
    uncertainty_flagged: summary.uncertainty_flagged,
  });
  return summary;
}

function advisory(
  deps: GovernanceAiDeps,
  proposalRef: string,
  kind: GovernanceAdvisoryKind,
  detail: string,
  outputId: string,
  nowIso: string,
): GovernanceAdvisory {
  const record = governanceAdvisorySchema.parse({
    advisory_id: `gadv-${randomUUID()}`,
    proposal_ref: proposalRef,
    kind,
    detail,
    advisory_only: true,
    output_id: outputId,
    generated_at: nowIso,
  } satisfies GovernanceAdvisory);
  deps.metrics.increment(`ai.governance.advisory.${kind}`);
  return record;
}

/** Highlight a possible conflict of interest for steward review (advisory). */
export async function highlightConflictOfInterest(
  deps: GovernanceAiDeps,
  proposalRef: string,
  proposerRef: string,
  recipientRef: string,
): Promise<GovernanceAdvisory | null> {
  await deps.guard.enforce({
    use_case_id: 'governance_assistance',
    capability: 'gov_highlight_coi',
    caller: 'governance-ai',
    context_ref: proposalRef,
    effect: 'advisory',
    uses_wealth_signals: false,
    targets_risk_identity: false,
  });
  if (proposerRef !== recipientRef) return null; // no overlap ⇒ no COI flag
  const nowIso = new Date(deps.now()).toISOString();
  const output = await recordAiOutput(deps.outputRecords, {
    modelName: GOVERNANCE_SUMMARIZER.name,
    modelVersion: GOVERNANCE_SUMMARIZER.version,
    promptTemplateId: GOVERNANCE_SUMMARIZER.promptTemplateId,
    config: GOVERNANCE_SUMMARIZER.config,
    inputRefs: [proposalRef],
    outputRef: proposalRef,
    useCaseId: 'governance_assistance',
    nowIso,
  });
  return advisory(
    deps,
    proposalRef,
    'coi_highlight',
    'Proposer and recipient appear to be the same party — review for conflict of interest.',
    output.output_id,
    nowIso,
  );
}

/** Detect scam-associated language for steward review (advisory). */
export async function detectScamPatterns(
  deps: GovernanceAiDeps,
  proposalRef: string,
  proposalText: string,
): Promise<GovernanceAdvisory | null> {
  await deps.guard.enforce({
    use_case_id: 'governance_assistance',
    capability: 'gov_detect_scam_patterns',
    caller: 'governance-ai',
    context_ref: proposalRef,
    effect: 'advisory',
    uses_wealth_signals: false,
    targets_risk_identity: false,
  });
  const markers = deps.scamMarkers?.() ?? DEFAULT_SCAM_MARKERS;
  const hit = containsAnyTerm(proposalText, markers);
  if (hit === null) return null;
  const nowIso = new Date(deps.now()).toISOString();
  const output = await recordAiOutput(deps.outputRecords, {
    modelName: GOVERNANCE_SUMMARIZER.name,
    modelVersion: GOVERNANCE_SUMMARIZER.version,
    promptTemplateId: GOVERNANCE_SUMMARIZER.promptTemplateId,
    config: GOVERNANCE_SUMMARIZER.config,
    inputRefs: [proposalRef],
    outputRef: proposalRef,
    useCaseId: 'governance_assistance',
    nowIso,
  });
  return advisory(
    deps,
    proposalRef,
    'scam_pattern',
    `Scam-associated language detected ("${hit}") — advisory only; a steward decides.`,
    output.output_id,
    nowIso,
  );
}

/** A steward edits/contests an AI proposal summary (WS-K.2.2a; non-final). */
export async function editGovernanceSummary(
  deps: GovernanceAiDeps,
  summaryId: string,
  newBody: string,
): Promise<GovernanceProposalSummary | null> {
  const existing = await deps.governanceSummaries.get(summaryId);
  if (existing === null) return null;
  const edited = governanceProposalSummarySchema.parse({
    ...existing,
    body: newBody,
    steward_edited: true,
  } satisfies GovernanceProposalSummary);
  await deps.governanceSummaries.put(edited);
  deps.metrics.increment('ai.governance.summary.edited');
  deps.log('governance.ai.summary.edited', { summary_id: summaryId });
  return edited;
}

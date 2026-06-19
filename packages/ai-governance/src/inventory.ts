// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The canonical AI use-case inventory + NIST AI RMF / ISO 42001 risk assessments
// (WS-K.1.1c, SPEC §24.1/§24.2). This is the GOVERN-function register: the eight
// AI use cases, each with its risk level, enforced oversight posture, identified
// harms, affected populations (which drive bias-audit subgroup selection,
// WS-K.1.2a), mitigations, and ISO/NIST control mappings. Governance assistance
// is marked never-autonomous (§24.5). The data is static and timestamp-free;
// `buildRiskAssessment`/`buildInventory` stamp it deterministically so the
// records are reproducible.

import type { AiRiskLevel, AiUseCaseId, HumanOversightLevel } from './schemas/common.js';
import { type AiInventory, type AiUseCase, aiUseCaseSchema } from './schemas/inventory.js';
import {
  type IdentifiedHarm,
  type NistRmfFunction,
  type RiskAssessment,
  riskAssessmentSchema,
} from './schemas/risk-assessment.js';

interface UseCaseSpec {
  name: string;
  description: string;
  risk_level: AiRiskLevel;
  human_oversight: HumanOversightLevel;
  never_autonomous: boolean;
  identified_harms: IdentifiedHarm[];
  affected_populations: string[];
  mitigations: string[];
  residual_risk: string;
  responsible_owner: string;
  nist_rmf_functions: NistRmfFunction[];
  iso_42001_controls: string[];
}

const OWNER = 'ai-governance';

/** The static specification for each of the eight use cases (§24.1 table). */
export const CANONICAL_USE_CASES: Readonly<Record<AiUseCaseId, UseCaseSpec>> = {
  topic_classification: {
    name: 'Topic classification',
    description: 'Assigns multi-label topics to submitted stories for retrieval and feature use.',
    risk_level: 'medium',
    human_oversight: 'review',
    never_autonomous: false,
    identified_harms: [
      {
        harm: 'Misclassification routes content to the wrong topic surface',
        likelihood: 'medium',
        impact: 'low',
      },
      {
        harm: 'Over-classifies political satire/humor as a sensitive topic',
        likelihood: 'medium',
        impact: 'medium',
      },
    ],
    affected_populations: [
      'under-represented languages',
      'satire and humor authors',
      'political-minority viewpoints',
    ],
    mitigations: [
      'confidence threshold (sub-threshold labels suggested, not applied)',
      'steward review queue for low-confidence labels',
      'AI-classified label; user/steward editable',
    ],
    residual_risk:
      'Residual misclassification on novel or code-switched content, mitigated by human review and editability.',
    responsible_owner: OWNER,
    nist_rmf_functions: ['MAP', 'MEASURE', 'MANAGE'],
    iso_42001_controls: [
      'ISO42001 A.5.2 (AI system impact assessment)',
      'ISO42001 A.6.2 (AI system lifecycle)',
      'ISO42001 A.9.2 (responsible use)',
    ],
  },
  duplicate_detection: {
    name: 'Duplicate detection',
    description: 'Flags near-duplicate content; MERI owns the authoritative dedup decision.',
    risk_level: 'low',
    human_oversight: 'none',
    never_autonomous: false,
    identified_harms: [
      {
        harm: 'False-positive near-duplicate flag suppresses distinct content',
        likelihood: 'low',
        impact: 'low',
      },
    ],
    affected_populations: ['syndicating sources', 'translated-content authors'],
    mitigations: [
      'MERI partition-matroid makes the authoritative decision',
      'flagging is advisory; auto-link only for exact-URL matches',
    ],
    residual_risk: 'Low residual risk; the invariant layer, not the model, decides redundancy.',
    responsible_owner: OWNER,
    nist_rmf_functions: ['MAP', 'MANAGE'],
    iso_42001_controls: ['ISO42001 A.6.2 (AI system lifecycle)'],
  },
  claim_extraction: {
    name: 'Claim extraction',
    description:
      'Extracts discrete candidate propositions from story text for the claim-evidence graph.',
    risk_level: 'medium',
    human_oversight: 'review',
    never_autonomous: false,
    identified_harms: [
      {
        harm: 'Mis-extracts opinion as a verifiable claim',
        likelihood: 'medium',
        impact: 'medium',
      },
      { harm: 'Over-fragments one claim into many', likelihood: 'medium', impact: 'low' },
    ],
    affected_populations: ['non-English authors', 'authors of nuanced/hedged writing'],
    mitigations: [
      'every claim lands as candidate (never fact)',
      'AI-draft label; user/steward editable (correct, split, merge, delete)',
      'sub-threshold confidence routes to the review queue',
    ],
    residual_risk:
      'Residual extraction error, bounded by candidate status and full human editability.',
    responsible_owner: OWNER,
    nist_rmf_functions: ['MAP', 'MEASURE', 'MANAGE'],
    iso_42001_controls: [
      'ISO42001 A.5.2 (AI system impact assessment)',
      'ISO42001 A.9.2 (responsible use)',
    ],
  },
  toxicity_safety_triage: {
    name: 'Toxicity/safety triage',
    description: 'Pre-screens content for safety review; produces flags, never enforcement.',
    risk_level: 'high',
    human_oversight: 'approval',
    never_autonomous: false,
    identified_harms: [
      { harm: 'False positive suppresses legitimate speech', likelihood: 'medium', impact: 'high' },
      { harm: 'False negative lets harmful content through', likelihood: 'medium', impact: 'high' },
      {
        harm: 'Disparate error rates across dialects/communities',
        likelihood: 'medium',
        impact: 'high',
      },
    ],
    affected_populations: [
      'reclaimed-language communities',
      'non-dominant dialects',
      'marginalized groups discussing their own experiences',
    ],
    mitigations: [
      'ALWAYS human review before enforcement (never auto-enforce)',
      'flags routed to the steward queue with full context',
      'appeal path (WS-J) for every action',
    ],
    residual_risk:
      'Residual classifier error, contained by the mandatory human-in-the-loop before any enforcement (§24.1).',
    responsible_owner: OWNER,
    nist_rmf_functions: ['GOVERN', 'MAP', 'MEASURE', 'MANAGE'],
    iso_42001_controls: [
      'ISO42001 A.5.2 (AI system impact assessment)',
      'ISO42001 A.9.2 (responsible use)',
      'ISO42001 A.9.4 (human oversight)',
    ],
  },
  summarization: {
    name: 'Summarization',
    description: 'Generates automated draft thread summaries (the never-final first layer, §15.4).',
    risk_level: 'medium',
    human_oversight: 'review',
    never_autonomous: false,
    identified_harms: [
      { harm: 'Hallucinates content not in the thread', likelihood: 'medium', impact: 'medium' },
      {
        harm: 'Presents the majority view as truth by prevalence',
        likelihood: 'medium',
        impact: 'medium',
      },
      { harm: 'Omits relevant minority viewpoints', likelihood: 'medium', impact: 'medium' },
    ],
    affected_populations: ['dissenting participants', 'minority-viewpoint holders'],
    mitigations: [
      'machine-generated label; never final (§15.4)',
      'hallucination/attribution checks before publication',
      'quality constraints (facts/claims/interpretations, uncertainty, minority views)',
      'user-reportable; steward-correctable',
    ],
    residual_risk:
      'Residual summarization distortion, bounded by quality gates, the never-final status, and human correction.',
    responsible_owner: OWNER,
    nist_rmf_functions: ['MAP', 'MEASURE', 'MANAGE'],
    iso_42001_controls: [
      'ISO42001 A.5.2 (AI system impact assessment)',
      'ISO42001 A.7.4 (data quality for AI)',
      'ISO42001 A.9.2 (responsible use)',
    ],
  },
  translation: {
    name: 'Translation',
    description:
      'Translates content while keeping the original canonical and one tap away (§15.5).',
    risk_level: 'medium',
    human_oversight: 'review',
    never_autonomous: false,
    identified_harms: [
      {
        harm: 'Mistranslation misrepresents a user’s words',
        likelihood: 'medium',
        impact: 'medium',
      },
      {
        harm: 'Lower quality for under-resourced language pairs',
        likelihood: 'high',
        impact: 'medium',
      },
    ],
    affected_populations: ['speakers of under-resourced languages', 'code-switching authors'],
    mitigations: [
      'original text always canonical and accessible',
      'consistency check (no added content)',
      'AI-translated label; user-reportable',
      'per-language bias results surfaced',
    ],
    residual_risk:
      'Residual translation error, bounded by the canonical original and user reporting.',
    responsible_owner: OWNER,
    nist_rmf_functions: ['MAP', 'MEASURE', 'MANAGE'],
    iso_42001_controls: [
      'ISO42001 A.5.2 (AI system impact assessment)',
      'ISO42001 A.9.2 (responsible use)',
    ],
  },
  embedding_generation: {
    name: 'Embedding generation',
    description: 'Produces vector embeddings for similarity and search; no user-facing labels.',
    risk_level: 'low',
    human_oversight: 'none',
    never_autonomous: false,
    identified_harms: [
      {
        harm: 'Embedding bias skews similarity for some languages',
        likelihood: 'medium',
        impact: 'low',
      },
    ],
    affected_populations: ['under-represented languages'],
    mitigations: [
      'used only for similarity/search, never profiling',
      'never reads financial/wealth data (ranking denylist)',
    ],
    residual_risk:
      'Low residual risk; embeddings inform retrieval, not enforcement or personalization by wealth.',
    responsible_owner: OWNER,
    nist_rmf_functions: ['MAP', 'MANAGE'],
    iso_42001_controls: ['ISO42001 A.6.2 (AI system lifecycle)'],
  },
  governance_assistance: {
    name: 'AI around governance',
    description:
      'Summarizes proposals and flags COI/scam patterns for stewards — advisory, never autonomous (§24.5).',
    risk_level: 'high',
    human_oversight: 'approval',
    never_autonomous: true,
    identified_harms: [
      {
        harm: 'A misleading proposal summary sways governance',
        likelihood: 'medium',
        impact: 'high',
      },
      {
        harm: 'AI is misused to recommend votes or hide risk identity',
        likelihood: 'low',
        impact: 'high',
      },
    ],
    affected_populations: ['proposal authors', 'treasury beneficiaries', 'voting participants'],
    mitigations: [
      'prohibited-use guard blocks autonomous execution, advice, vote recommendations, wealth profiling, risk-identity rewriting',
      'every summary cites proposal fields and flags material uncertainty',
      'steward editable/contestable; never final',
      'COI/scam findings advisory only',
    ],
    residual_risk:
      'Residual advisory error, bounded by the pre-execution guard, mandatory citations, and steward contestability (§24.1/§24.5).',
    responsible_owner: OWNER,
    nist_rmf_functions: ['GOVERN', 'MAP', 'MEASURE', 'MANAGE'],
    iso_42001_controls: [
      'ISO42001 A.5.2 (AI system impact assessment)',
      'ISO42001 A.9.2 (responsible use)',
      'ISO42001 A.9.4 (human oversight)',
    ],
  },
};

/** The risk-assessment reference id for a use case (stable). */
export function riskAssessmentRefFor(useCaseId: AiUseCaseId): string {
  return `risk:${useCaseId}:v1`;
}

/** Build the (validated) risk assessment for one use case, stamped at `nowIso`. */
export function buildRiskAssessment(useCaseId: AiUseCaseId, nowIso: string): RiskAssessment {
  const spec = CANONICAL_USE_CASES[useCaseId];
  return riskAssessmentSchema.parse({
    assessment_id: riskAssessmentRefFor(useCaseId),
    use_case_id: useCaseId,
    version: '1.0.0',
    risk_level: spec.risk_level,
    human_oversight: spec.human_oversight,
    identified_harms: spec.identified_harms,
    affected_populations: spec.affected_populations,
    mitigations: spec.mitigations,
    residual_risk: spec.residual_risk,
    responsible_owner: spec.responsible_owner,
    nist_rmf_functions: spec.nist_rmf_functions,
    iso_42001_controls: spec.iso_42001_controls,
    created_at: nowIso,
    updated_at: nowIso,
  });
}

/** Every use-case id in canonical (table) order. */
export const ALL_USE_CASE_IDS = Object.keys(CANONICAL_USE_CASES) as AiUseCaseId[];

/** Build one (validated) inventory use-case entry. */
export function buildUseCaseEntry(
  useCaseId: AiUseCaseId,
  modelNames: readonly string[] = [],
): AiUseCase {
  const spec = CANONICAL_USE_CASES[useCaseId];
  return aiUseCaseSchema.parse({
    use_case_id: useCaseId,
    name: spec.name,
    description: spec.description,
    model_names: [...modelNames],
    risk_level: spec.risk_level,
    human_oversight: spec.human_oversight,
    risk_assessment_ref: riskAssessmentRefFor(useCaseId),
    never_autonomous: spec.never_autonomous,
  });
}

/** Build the whole inventory at `version`/`nowIso`, with optional model links. */
export function buildInventory(
  version: number,
  nowIso: string,
  modelNamesByUseCase: Partial<Record<AiUseCaseId, readonly string[]>> = {},
): AiInventory {
  return {
    version,
    updated_at: nowIso,
    use_cases: ALL_USE_CASE_IDS.map((id) => buildUseCaseEntry(id, modelNamesByUseCase[id] ?? [])),
  };
}

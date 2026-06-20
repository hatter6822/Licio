// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The ProhibitedUseGuard core (WS-K.1.1d + WS-K.2.2a, SPEC §24.1/§24.5). A pure
// decision function the API layer calls BEFORE every AI model invocation: it
// classifies the declared capability against the permitted/prohibited matrix and
// applies structural defense-in-depth (autonomous effect, wealth signals, risk-
// identity masking) so even a nominally permitted capability is blocked if it
// would cross a prohibition. A blocked request never reaches a model. The matrix
// here is the single source of truth shared by the general guard and the §24.5
// governance enforcement.
import type {
  AiCapability,
  AiInvocation,
  AiProhibition,
  ProhibitedUseDecision,
} from './schemas/prohibited-use.js';

interface CapabilityClass {
  kind: 'permitted' | 'prohibited';
  /** The prohibition triggered (present iff prohibited). */
  prohibition?: AiProhibition;
  /** True ⇒ a §24.5 governance capability. */
  governance: boolean;
}

/** The permitted/prohibited matrix — the SSOT (WS-K.2.2a). */
export const CAPABILITY_CLASSIFICATION: Readonly<Record<AiCapability, CapabilityClass>> = {
  // Normal content pipelines — permitted.
  classify_topic: { kind: 'permitted', governance: false },
  extract_claim: { kind: 'permitted', governance: false },
  summarize_thread: { kind: 'permitted', governance: false },
  translate_content: { kind: 'permitted', governance: false },
  generate_embedding: { kind: 'permitted', governance: false },
  triage_safety: { kind: 'permitted', governance: false },
  detect_duplicate: { kind: 'permitted', governance: false },
  // §24.5 permitted governance capabilities.
  gov_summarize_proposal: { kind: 'permitted', governance: true },
  gov_identify_missing_fields: { kind: 'permitted', governance: true },
  gov_compare_charter: { kind: 'permitted', governance: true },
  gov_highlight_coi: { kind: 'permitted', governance: true },
  gov_translate_summary: { kind: 'permitted', governance: true },
  gov_explain_treasury_action: { kind: 'permitted', governance: true },
  gov_detect_scam_patterns: { kind: 'permitted', governance: true },
  // General prohibited capabilities.
  treasury_execute: {
    kind: 'prohibited',
    prohibition: 'autonomous_treasury_execution',
    governance: false,
  },
  investment_advice: { kind: 'prohibited', prohibition: 'investment_advice', governance: false },
  voting_recommendation: {
    kind: 'prohibited',
    prohibition: 'manipulative_voting_recommendation',
    governance: false,
  },
  wealth_profiling: {
    kind: 'prohibited',
    prohibition: 'wealth_based_profiling',
    governance: false,
  },
  risk_identity_rewrite: {
    kind: 'prohibited',
    prohibition: 'risk_identity_hiding',
    governance: false,
  },
  // §24.5 prohibited governance capabilities.
  gov_autonomous_execution: {
    kind: 'prohibited',
    prohibition: 'autonomous_treasury_execution',
    governance: true,
  },
  gov_investment_advice: { kind: 'prohibited', prohibition: 'investment_advice', governance: true },
  gov_voting_recommendation: {
    kind: 'prohibited',
    prohibition: 'manipulative_voting_recommendation',
    governance: true,
  },
  gov_wealth_profiling: {
    kind: 'prohibited',
    prohibition: 'wealth_based_profiling',
    governance: true,
  },
  gov_risk_identity_rewrite: {
    kind: 'prohibited',
    prohibition: 'risk_identity_hiding',
    governance: true,
  },
  gov_wealth_feed_personalization: {
    kind: 'prohibited',
    prohibition: 'wealth_based_profiling',
    governance: true,
  },
};

/** Classify a capability against the matrix. */
export function classifyCapability(capability: AiCapability): CapabilityClass {
  return CAPABILITY_CLASSIFICATION[capability];
}

/** Whether `capability` is a §24.5 governance capability. */
export function isGovernanceCapability(capability: AiCapability): boolean {
  return CAPABILITY_CLASSIFICATION[capability].governance;
}

/** The seven §24.5 permitted governance capabilities. */
export const GOVERNANCE_PERMITTED_CAPABILITIES: readonly AiCapability[] = (
  Object.keys(CAPABILITY_CLASSIFICATION) as AiCapability[]
).filter(
  (c) =>
    CAPABILITY_CLASSIFICATION[c].governance && CAPABILITY_CLASSIFICATION[c].kind === 'permitted',
);

/** The §24.5 prohibited governance capabilities. */
export const GOVERNANCE_PROHIBITED_CAPABILITIES: readonly AiCapability[] = (
  Object.keys(CAPABILITY_CLASSIFICATION) as AiCapability[]
).filter(
  (c) =>
    CAPABILITY_CLASSIFICATION[c].governance && CAPABILITY_CLASSIFICATION[c].kind === 'prohibited',
);

const ALLOW: ProhibitedUseDecision = { decision: 'allow' };

function block(prohibition: AiProhibition, reason: string): ProhibitedUseDecision {
  return { decision: 'block', prohibition, reason };
}

/**
 * Evaluate a declared invocation. Returns `allow` or a `block` carrying the
 * triggered prohibition and a human-readable reason. The capability
 * classification is the primary check; the structural flags are defense in
 * depth — a permitted capability that would take autonomous effect, read wealth
 * signals, or mask a risk actor's identity is still blocked.
 */
export function evaluateInvocation(input: AiInvocation): ProhibitedUseDecision {
  const klass = CAPABILITY_CLASSIFICATION[input.capability];
  if (klass.kind === 'prohibited' && klass.prohibition !== undefined) {
    return block(klass.prohibition, `capability "${input.capability}" is prohibited`);
  }
  // Structural defense in depth (order: the most severe autonomy first).
  if (input.effect === 'execute') {
    return block(
      'autonomous_treasury_execution',
      'AI output is always advisory; it may never take autonomous effect',
    );
  }
  if (input.uses_wealth_signals) {
    return block(
      'wealth_based_profiling',
      'AI may not use wallet/payment/treasury signals to profile or personalize',
    );
  }
  if (input.targets_risk_identity) {
    return block(
      'risk_identity_hiding',
      'AI may not be used to obscure a risk actor’s identity from safety/compliance',
    );
  }
  return ALLOW;
}

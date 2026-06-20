// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Summarization quality constraints (WS-K.1.4b, SPEC §15.4/§24.3). Five
// deterministic checks over the STRUCTURED draft (statements tagged
// fact/claim/interpretation, explicit unresolved questions and minority views),
// so "responsible representation" is mechanical rather than a matter of taste:
//   1. distinguish facts/claims/interpretations (claims attributed; disputed
//      content not flattened to fact);
//   2. preserve uncertainty (open questions listed; no false resolution);
//   3. include minority views (present when dissent exists);
//   4. avoid majority-as-truth (no fact justified by prevalence);
//   5. avoid slur synthesis (no denylisted terms reproduced).
// A draft failing any constraint is flagged for revision (WS-K.1.4c).
import type {
  AiSummaryDraft,
  SummaryQualityConstraintResult,
  SummaryQualityResult,
} from './schemas/summary.js';
import { containsAnyTerm } from './text.js';

/** Thread-level signals the constraints check the draft against. */
export interface ThreadQualitySignals {
  /** The thread has unresolved questions that must be preserved. */
  hasOpenQuestions: boolean;
  /** The thread carries substantive minority/dissenting views. */
  hasMinorityView: boolean;
  /** The thread contains disputed (non-settled) claims. */
  hasDisputedClaim: boolean;
}

export interface QualityOptions {
  /** Policy-injected slur/harassment denylist (WS-A/WS-J taxonomy). */
  slurDenylist?: readonly string[];
}

/** Language that overclaims resolution of an open question. */
const RESOLUTION_OVERCLAIM = [
  /\bdefinitively\b/i,
  /\bconclusively (proven|settled|established)\b/i,
  /\bbeyond (any )?doubt\b/i,
  /\bsettled (fact|matter|question)\b/i,
  /\bproven (fact|true|beyond)\b/i,
];

/** Language that justifies a position by its prevalence (majority-as-truth). */
const PREVALENCE_AS_TRUTH = [
  /\bmost (people|users|participants|commenters)\b/i,
  /\bthe majority\b/i,
  /\bcommonly (believed|accepted|known)\b/i,
  /\beveryone (agrees|knows)\b/i,
  /\bbecause it is (popular|common|widely)\b/i,
];

function matchesAny(text: string, patterns: readonly RegExp[]): boolean {
  return patterns.some((p) => p.test(text));
}

/** All free-text fields of a draft (for the slur scan). */
function draftTexts(draft: AiSummaryDraft): string[] {
  return [
    ...draft.statements.map((s) => s.text),
    ...draft.unresolved_questions,
    ...draft.minority_views.map((m) => m.text),
  ];
}

/** Evaluate the five quality constraints. Deterministic and total. */
export function checkSummaryQuality(
  draft: AiSummaryDraft,
  signals: ThreadQualitySignals,
  options: QualityOptions = {},
): SummaryQualityResult {
  const slurDenylist = options.slurDenylist ?? [];
  const claims = draft.statements.filter((s) => s.kind === 'claim');
  const facts = draft.statements.filter((s) => s.kind === 'fact');

  const constraints: SummaryQualityConstraintResult[] = [];

  // 1. distinguish facts/claims/interpretations.
  {
    const allClaimsAttributed = claims.every((c) => c.attribution !== null);
    const disputedFlattened = signals.hasDisputedClaim && claims.length === 0;
    const passed = allClaimsAttributed && !disputedFlattened;
    constraints.push({
      constraint: 'distinguish_facts_claims_interpretations',
      passed,
      detail: passed
        ? 'facts/claims/interpretations distinguished; claims attributed'
        : disputedFlattened
          ? 'disputed content stated without an attributed claim'
          : 'a claim lacks attribution',
    });
  }

  // 2. preserve uncertainty.
  {
    const listsOpenQuestions = !signals.hasOpenQuestions || draft.unresolved_questions.length > 0;
    const overclaims =
      signals.hasOpenQuestions && facts.some((f) => matchesAny(f.text, RESOLUTION_OVERCLAIM));
    const passed = listsOpenQuestions && !overclaims;
    constraints.push({
      constraint: 'preserve_uncertainty',
      passed,
      detail: passed
        ? 'open questions preserved; no false resolution'
        : overclaims
          ? 'a fact overclaims resolution of an open question'
          : 'open questions not listed',
    });
  }

  // 3. include minority views.
  {
    const passed = !signals.hasMinorityView || draft.minority_views.length > 0;
    constraints.push({
      constraint: 'include_minority_views',
      passed,
      detail: passed ? 'minority views included where present' : 'minority view omitted',
    });
  }

  // 4. avoid majority-as-truth.
  {
    const offending = facts.find((f) => matchesAny(f.text, PREVALENCE_AS_TRUTH));
    const passed = offending === undefined;
    constraints.push({
      constraint: 'avoid_majority_as_truth',
      passed,
      detail: passed ? 'no fact justified by prevalence' : 'a fact is justified by prevalence',
    });
  }

  // 5. avoid slur synthesis.
  {
    let found: string | null = null;
    for (const text of draftTexts(draft)) {
      const hit = containsAnyTerm(text, slurDenylist);
      if (hit !== null) {
        found = hit;
        break;
      }
    }
    constraints.push({
      constraint: 'avoid_slur_synthesis',
      passed: found === null,
      detail: found === null ? 'no slurs/harassment reproduced' : 'reproduced a denylisted term',
    });
  }

  return { constraints, passed: constraints.every((c) => c.passed) };
}

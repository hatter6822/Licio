// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Render a structured AI summary draft (WS-K.1.4a) into the WS-G three-layer
// summary shape (body + citations + uncertainty/minority notes), so the
// automated draft can be stored through the existing WS-G summary store with the
// machine-generated label. The rendering preserves the §24.3 distinctions:
// facts are declarative, claims are attributed, interpretations are marked, open
// questions and minority views are listed explicitly. Pure and deterministic.
import type { AiSummaryDraft } from './schemas/summary.js';

export interface RenderedSummary {
  body: string;
  cited_contribution_ids: string[];
  cited_evidence_ids: string[];
  /** Non-empty when the draft lists open questions (§24.3). */
  unresolved_uncertainty: string | null;
  /** Non-empty when the draft carries minority views (§15.4). */
  minority_views_note: string | null;
}

function uniq(values: readonly string[]): string[] {
  return [...new Set(values)];
}

/** Render the draft to a WS-G-compatible summary body + citations. */
export function renderSummaryDraft(draft: AiSummaryDraft): RenderedSummary {
  const lines: string[] = [];
  for (const statement of draft.statements) {
    if (statement.kind === 'fact') {
      lines.push(statement.text);
    } else if (statement.kind === 'claim') {
      // Attributed (schema guarantees a non-null attribution for claims).
      lines.push(`${statement.attribution ?? 'A participant'} argues that ${statement.text}`);
    } else {
      lines.push(`Interpretation: ${statement.text}`);
    }
  }

  const body = lines.join('\n\n').trim();

  const unresolved =
    draft.unresolved_questions.length > 0
      ? draft.unresolved_questions.map((q) => `Unresolved: ${q}`).join('\n')
      : null;

  const minority =
    draft.minority_views.length > 0 ? draft.minority_views.map((m) => m.text).join('\n') : null;

  const citedContributions = uniq([
    ...draft.statements.flatMap((s) => s.cited_contribution_ids),
    ...draft.minority_views.flatMap((m) => m.cited_contribution_ids),
  ]);
  const citedEvidence = uniq(draft.statements.flatMap((s) => s.cited_evidence_ids));

  return {
    // A draft with no statements still renders a non-empty placeholder body so
    // the WS-G summary store (body min length 1) accepts it.
    body: body.length > 0 ? body : 'No summary content could be generated for this thread yet.',
    cited_contribution_ids: citedContributions,
    cited_evidence_ids: citedEvidence,
    unresolved_uncertainty: unresolved,
    minority_views_note: minority,
  };
}

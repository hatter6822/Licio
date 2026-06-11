// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Plain-language Signal Ledger summaries (WS-E.2.1d, SPEC §19.3). The summary
// is generated deterministically from the bucketed breakdown — it never names
// a raw value (there are none) and never uses applause language. Anti-signal
// annotations are spelled out so the user can understand (and remedy) a
// downweight, e.g. by adding evidence (WS-E.2.2b transparency).
import type { DwellBucket, EventContributionType, ReturnVisitBucket } from '@licio/shared';

const DWELL_PHRASES: Readonly<Record<DwellBucket, string | null>> = {
  none: null,
  glance: 'You glanced at this briefly',
  short: 'You read this for a short while',
  medium: 'You read this for a moderate duration',
  long: 'You read this for a long while',
  extended: 'You read this for an extended period',
};

const RETURN_PHRASES: Readonly<Record<ReturnVisitBucket, string | null>> = {
  none: null,
  few: 'returned to it',
  several: 'returned to it several times',
  many: 'returned to it many times',
};

const CONTRIBUTION_PHRASES: Readonly<Record<EventContributionType, string | null>> = {
  question: 'Your question was counted as constructive participation.',
  evidence: 'Your evidence card was counted as constructive participation.',
  correction: 'Your correction was counted as constructive participation.',
  synthesis: 'Your synthesis was counted as constructive participation.',
  counterexample: 'Your counterexample was counted as constructive participation.',
  explanation: 'Your explanation was counted as constructive participation.',
  experience: 'Your first-hand account was counted as constructive participation.',
  bridge_comment: 'Your bridge comment was counted as constructive participation.',
  steward_action: 'Your steward action was counted toward thread health.',
  flag: null,
  low_info_reply: null,
};

const ANNOTATION_PHRASES: Readonly<Record<string, string>> = {
  source_free_accusation_downweight:
    'A contribution was downweighted: it makes a serious claim without supporting evidence.',
  rapid_repetition_dampened: 'Rapid repeated replies were dampened.',
  coordinated_burst_placeholder_dampening:
    'This item is under coordination review; participation weight is provisional.',
  harassment_cascade_review: 'Ranking growth for this item is paused pending safety review.',
};

export interface LedgerSummaryInput {
  dwellBucket: DwellBucket;
  sourceOpened: boolean;
  sourceBounceOnly: boolean;
  contextOpened: boolean;
  returnVisitBucket: ReturnVisitBucket;
  contributions: Partial<Record<EventContributionType, number>>;
  annotations: readonly string[];
}

/** Build the plain-language per-item summary for the owner's Signal Ledger. */
export function buildLedgerSummary(input: LedgerSummaryInput): string {
  const clauses: string[] = [];
  const dwell = DWELL_PHRASES[input.dwellBucket];
  if (dwell) clauses.push(dwell);
  if (input.sourceOpened) {
    clauses.push(
      input.sourceBounceOnly
        ? 'opened the source but returned right away (not counted)'
        : 'opened the source',
    );
  }
  if (input.contextOpened) clauses.push('opened the context card');
  const returns = RETURN_PHRASES[input.returnVisitBucket];
  if (returns) clauses.push(returns);

  const sentences: string[] = [];
  if (clauses.length > 0) {
    const first = clauses[0] ?? '';
    const rest = clauses.slice(1);
    const lead = first.startsWith('You') ? first : `You ${first}`;
    sentences.push(
      rest.length === 0
        ? `${lead}.`
        : `${lead}, ${rest.length === 1 ? rest[0] : `${rest.slice(0, -1).join(', ')}, and ${rest[rest.length - 1]}`}.`,
    );
  } else {
    sentences.push('No attention signals were counted for this item in this window.');
  }

  for (const [type, count] of Object.entries(input.contributions) as Array<
    [EventContributionType, number | undefined]
  >) {
    if ((count ?? 0) > 0) {
      const phrase = CONTRIBUTION_PHRASES[type];
      if (phrase) sentences.push(phrase);
    }
  }

  for (const annotation of input.annotations) {
    const phrase = ANNOTATION_PHRASES[annotation];
    if (phrase && !sentences.includes(phrase)) sentences.push(phrase);
  }

  return sentences.join(' ');
}

// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Deterministic content generation for the DEV traffic simulator. Every story,
// comment, and citation is produced from combinatorial sentence banks driven
// by the seeded PRNG plus a monotonic serial, so a run is reproducible and no
// two artefacts collide with the real submission guards by accident:
//   • titles are combinatorial (the engine additionally re-rolls against the
//     recent-title set so the duplicate-title spam gate never fires by chance);
//   • link URLs embed the serial, so the exact-URL dedup gate only fires when
//     the repost behaviour INTENDS a duplicate (the MERI near-dup demo);
//   • bodies weave the canonical topic-catalog keywords for the proposed
//     topics, so the WS-K deterministic validator promotes them to TRUSTED
//     topic ids (feeding topic surfaces, PHI, and the topic-shaped invariants);
//   • comment bodies are substantive (not one-liners) so the constructive-
//     participation classifiers see real material rather than low-info replies.
// Synthetic link stories live on reserved `.example` origins (RFC 2606) that
// the link-fixtures module resolves deterministically in development.

import { topicIdForSlug } from '@licio/shared';
import type { Prng } from './prng.js';

export type DomainId = 'health' | 'local' | 'climate' | 'elections' | 'science';

export const DOMAIN_IDS: readonly DomainId[] = [
  'health',
  'local',
  'climate',
  'elections',
  'science',
];

interface DomainBank {
  /** Primary catalog topic slug (proposed AND keyword-supported). */
  readonly topicSlug: string;
  /** Occasional secondary slug (also keyword-supported by the banks). */
  readonly secondarySlug?: string;
  readonly entities: readonly string[];
  readonly objects: readonly string[];
  readonly scopes: readonly string[];
  readonly methods: readonly string[];
  readonly caveats: readonly string[];
  /** A sentence carrying ≥2 catalog keywords for the primary topic. */
  readonly keywordSentences: readonly string[];
  readonly outlets: readonly string[];
  readonly localValue?: string;
}

const BANKS: Readonly<Record<DomainId, DomainBank>> = {
  health: {
    topicSlug: 'health',
    entities: [
      'County health office',
      'Regional hospital network',
      'Valley clinic consortium',
      'State immunization program',
      'Public health laboratory',
    ],
    objects: [
      'hospital readmission audit',
      'vaccine coverage tables',
      'outbreak monitoring summary',
      'clinic wait-time dataset',
      'medical staffing census',
    ],
    scopes: [
      'all licensed facilities in the region',
      'the twelve reporting districts',
      'both urban and rural clinics',
      'the full calendar quarter',
    ],
    methods: [
      'the sampling methodology attached as an appendix',
      'field definitions published alongside the raw tables',
      'a documented chain from collection to publication',
      'per-facility notes on missing submissions',
    ],
    caveats: [
      'Two facilities submitted late, so their rows carry a provisional flag.',
      'The denominator changed this cycle, which affects year-over-year reads.',
      'Small clinics are aggregated to protect patient privacy.',
    ],
    keywordSentences: [
      'The release covers hospital admissions and vaccine coverage, the two health fields most revised since the last cycle.',
      'Medical reviewers note the outbreak indicators now separate confirmed from suspected counts.',
      'The health office says hospital-level detail will follow once validation completes.',
    ],
    outlets: ['daily-ledger', 'metro-monitor', 'civic-wire'],
  },
  local: {
    topicSlug: 'local-community',
    entities: [
      'City council',
      'Transit authority',
      'County planning board',
      'Parks department',
      'Harbor commission',
    ],
    objects: [
      'zoning docket',
      'transit schedule revision',
      'neighborhood budget worksheet',
      'community grant shortlist',
      'street maintenance calendar',
    ],
    scopes: [
      'every neighborhood east of the river',
      'the four downtown districts',
      'the whole county service area',
      'the corridor between the two bridges',
    ],
    methods: [
      'line items mapped to last year for comparison',
      'a public comment window that closes in thirty days',
      'per-district breakdowns in a machine-readable file',
      'meeting minutes linked from each entry',
    ],
    caveats: [
      'One district submitted a corrected page after the original posting.',
      'The council notes two items were deferred to the next session.',
      'Holiday service dates are still marked tentative.',
    ],
    keywordSentences: [
      'The city says the council will take neighborhood comment before the zoning items advance.',
      'Community groups asked the council to publish the transit overlays used in the plan.',
      'The county schedule shows which neighborhood meetings cover each docket item.',
    ],
    outlets: ['harbor-signal', 'riverside-post', 'district-notes'],
    localValue: 'Riverside',
  },
  climate: {
    topicSlug: 'climate-environment',
    secondarySlug: 'energy',
    entities: [
      'Grid operator',
      'Water resources agency',
      'Regional climate observatory',
      'Energy cooperative',
      'Emissions registry',
    ],
    objects: [
      'emissions inventory',
      'reservoir level series',
      'renewable capacity filing',
      'drought monitoring bulletin',
      'power demand dataset',
    ],
    scopes: [
      'the full interconnect region',
      'all monitored river basins',
      'utility-scale and rooftop installations alike',
      'the trailing twelve months',
    ],
    methods: [
      'weather-normalized comparisons alongside the raw series',
      'station-level readings with calibration notes',
      'a documented revision history for every figure',
      'an open data dictionary for the new fields',
    ],
    caveats: [
      'Normalization is sensitive to the chosen baseline period.',
      'Two stations were offline for part of the window.',
      'The registry flags one facility total as under review.',
    ],
    keywordSentences: [
      'The climate observatory notes water storage and emissions figures move together in this release.',
      'Energy analysts say the grid data now separates solar and wind capacity by county.',
      'The drought bulletin ties reservoir levels to the power demand outlook for summer.',
    ],
    outlets: ['field-notes', 'north-desk', 'civic-wire'],
  },
  elections: {
    topicSlug: 'elections-democracy',
    entities: [
      'Elections board',
      'County clerk',
      'Redistricting commission',
      'Campaign finance office',
      'Ballot review panel',
    ],
    objects: [
      'precinct turnout files',
      'ballot audit worksheet',
      'campaign finance filings',
      'recount procedure manual',
      'voter roll maintenance report',
    ],
    scopes: [
      'every precinct in the county',
      'all certified races from the last cycle',
      'both early and same-day totals',
      'the complete filing period',
    ],
    methods: [
      'a data dictionary defining every denominator',
      'row-level provenance for each certified total',
      'the rejection log with a reason code per entry',
      'cross-checks against the published canvass',
    ],
    caveats: [
      'Provisional ballots are reported separately and lag by a week.',
      'One precinct consolidated mid-cycle, so trend rows need care.',
      'The board notes the manual is a draft open for comment.',
    ],
    keywordSentences: [
      'The board published ballot-level counts so campaign researchers can verify the election totals independently.',
      'Candidate filings and campaign spending now appear in one machine-readable election dataset.',
      'The clerk says every ballot batch in the election audit carries a scanner reference.',
    ],
    outlets: ['daily-ledger', 'canvass-desk', 'civic-wire'],
  },
  science: {
    topicSlug: 'science-research',
    entities: [
      'University research group',
      'Independent laboratory network',
      'Open data consortium',
      'Field measurement team',
      'Replication project',
    ],
    objects: [
      'replication study',
      'sensor calibration dataset',
      'pre-registered experiment results',
      'peer review notes',
      'field survey series',
    ],
    scopes: [
      'three independent measurement sites',
      'the full pre-registered protocol',
      'both the raw and processed series',
      'every instrument in the network',
    ],
    methods: [
      'open data and analysis code published together',
      'a pre-registration link for every hypothesis',
      'blinded processing before the labels were joined',
      'instrument-level uncertainty estimates',
    ],
    caveats: [
      'The confidence interval widens for the earliest instrument generation.',
      'One site used a different sampling cadence, noted in the appendix.',
      'The authors flag the smallest cohort as underpowered.',
    ],
    keywordSentences: [
      'The scientists say the study replicates the earlier experiment within its published interval.',
      'Independent research teams can rerun the experiment from the archived pipeline alone.',
      'The consortium argues open research data made this discovery checkable in days rather than months.',
    ],
    outlets: ['method-review', 'field-notes', 'north-desk'],
  },
};

const TITLE_TEMPLATES: ReadonlyArray<(entity: string, object: string, period: string) => string> = [
  (e, o, p) => `${e} publishes ${o} for ${p}`,
  (e, o, p) => `${e} releases the updated ${o} (${p})`,
  (e, o, p) => `New ${o} from the ${e.toLowerCase()}: what changed in ${p}`,
  (e, o, p) => `${e} opens public comment on its ${o} for ${p}`,
  (e, o, p) => `${e} adds station-level detail to the ${o} covering ${p}`,
];

const QUESTION_TEMPLATES: ReadonlyArray<(object: string, period: string) => string> = [
  (o, p) => `What does the new ${o} for ${p} actually measure?`,
  (o, p) => `How should readers interpret the ${o} covering ${p}?`,
  (o, p) => `Which parts of the ${o} for ${p} are comparable to last cycle?`,
];

const PERIODS = [
  'week 8',
  'week 15',
  'week 23',
  'week 31',
  'week 40',
  'the first quarter',
  'the second quarter',
  'the third quarter',
  'the spring cycle',
  'the winter cycle',
] as const;

export type StoryKind = 'link' | 'original_brief' | 'question' | 'local_update';

/** A fully generated story submission, minus the room decision (engine adds
 *  room_id/visibility and parses through storyCreateRequestSchema). */
export interface GeneratedStory {
  readonly kind: StoryKind;
  readonly title: string;
  readonly topicSlugs: readonly string[];
  readonly topicIds: readonly string[];
  readonly body: string;
  /** Present for link stories only. */
  readonly url: string | null;
  readonly reason: string | null;
  readonly question: string | null;
  readonly questionContext: string | null;
  readonly locationValue: string | null;
  readonly disclosure: string | null;
}

function domainBank(domain: DomainId): DomainBank {
  return BANKS[domain];
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

/** Hostnames the dev link-fixtures resolve deterministically. */
export const SIMULATED_HOSTS: ReadonlySet<string> = new Set(
  Object.values(BANKS).flatMap((bank) => bank.outlets.map((outlet) => `${outlet}.example`)),
);

export function isSimulatedUrl(rawUrl: string): boolean {
  try {
    return SIMULATED_HOSTS.has(new URL(rawUrl).hostname);
  } catch {
    return false;
  }
}

function storyBody(bank: DomainBank, object: string, prng: Prng): string {
  const scope = prng.pick(bank.scopes);
  const method = prng.pick(bank.methods);
  const caveat = prng.pick(bank.caveats);
  const keyword = prng.pick(bank.keywordSentences);
  return `The ${object} covers ${scope}, with ${method}. ${keyword} ${caveat}`;
}

/**
 * Generate one story. `serial` is the monotonic per-boot story counter; it is
 * embedded in every link URL (URL uniqueness) and available to the engine's
 * title-collision fallback.
 */
export function generateStory(
  domain: DomainId,
  kind: StoryKind,
  serial: number,
  prng: Prng,
): GeneratedStory {
  const bank = domainBank(domain);
  const entity = prng.pick(bank.entities);
  const object = prng.pick(bank.objects);
  const period = prng.pick(PERIODS);
  const slugs =
    bank.secondarySlug !== undefined && prng.chance(0.35)
      ? [bank.topicSlug, bank.secondarySlug]
      : [bank.topicSlug];
  const body = storyBody(bank, object, prng);
  if (kind === 'question') {
    const question = prng.pick(QUESTION_TEMPLATES)(object, period);
    return {
      kind,
      title: question,
      topicSlugs: slugs,
      topicIds: slugs.map(topicIdForSlug),
      body,
      url: null,
      reason: null,
      question,
      questionContext: `Asking before interpretations settle. ${prng.pick(bank.keywordSentences)}`,
      locationValue: null,
      disclosure: null,
    };
  }
  const title = prng.pick(TITLE_TEMPLATES)(entity, object, period);
  if (kind === 'link') {
    const outlet = prng.pick(bank.outlets);
    const url = `https://${outlet}.example/${domain}/${slugify(title)}-${serial}`;
    return {
      kind,
      title,
      topicSlugs: slugs,
      topicIds: slugs.map(topicIdForSlug),
      body,
      url,
      reason: `The full ${object}, not the press summary.`,
      question: null,
      questionContext: null,
      locationValue: null,
      disclosure: null,
    };
  }
  if (kind === 'local_update') {
    return {
      kind,
      title,
      topicSlugs: slugs,
      topicIds: slugs.map(topicIdForSlug),
      body,
      url: null,
      reason: null,
      question: null,
      questionContext: null,
      locationValue: bank.localValue ?? 'Riverside',
      disclosure: 'Source: the public briefing calendar and the posted agenda.',
    };
  }
  return {
    kind: 'original_brief',
    title,
    topicSlugs: slugs,
    topicIds: slugs.map(topicIdForSlug),
    body,
    url: null,
    reason: null,
    question: null,
    questionContext: null,
    locationValue: null,
    disclosure: null,
  };
}

/**
 * The intentional near-duplicate (repost) of an existing story: the SAME local
 * text (title + body) as the original, a fresh URL — so the WS-F MinHash/LSH
 * near-dup pass genuinely groups them (the MERI duplicate-grouping demo,
 * mirroring the demo-seed S21↔S25 collision). Only the canonical URL and the
 * reason differ, which is what a verbatim repost looks like.
 */
export function generateRepost(
  originalTitle: string,
  originalBody: string,
  domain: DomainId,
  serial: number,
  prng: Prng,
): GeneratedStory {
  const bank = domainBank(domain);
  const outlet = prng.pick(bank.outlets);
  return {
    kind: 'link',
    title: originalTitle,
    topicSlugs: [bank.topicSlug],
    topicIds: [topicIdForSlug(bank.topicSlug)],
    body: originalBody,
    url: `https://${outlet}.example/${domain}/repost-${slugify(originalTitle)}-${serial}`,
    reason: 'The same release, reposted.',
    question: null,
    questionContext: null,
    locationValue: null,
    disclosure: null,
  };
}

// ---------------------------------------------------------------------------
// Comments
// ---------------------------------------------------------------------------

export type CommentFlavor =
  | 'root_question'
  | 'root_observation'
  | 'reply_answer'
  | 'reply_followup';

const COMMENT_BANKS: Readonly<Record<CommentFlavor, readonly string[]>> = {
  root_question: [
    'Is the {object} risk-adjusted, or are these raw counts? The summary reads like the former but the appendix never says so directly.',
    'Does the {object} account for the seasonal pattern the earlier releases showed? Comparing {period} against a flat baseline would overstate the change.',
    'Which denominator does the {object} use? The headline figure moves a lot depending on whether the base is registered entries or the full population.',
    'Has anyone cross-checked the {object} against the independently collected series? The two disagreed slightly last cycle and it was never resolved.',
  ],
  root_observation: [
    'Worth noting the {object} now ships a revision history — that makes the week-over-week comparisons checkable for the first time.',
    'The methodology section of the {object} is unusually specific about exclusions, which explains most of the gap people flagged last {period}.',
    'Reading the {object} closely: the top-line number is stable, but the district-level rows move in opposite directions, so the average hides the story.',
    'The {object} quietly fixes the field-naming problem from the previous release; anything downstream parsing the old headers will need updating.',
  ],
  reply_answer: [
    'The appendix answers this — see the definitions table: the adjustment covers the covariates named there, though not the facility-level surge term.',
    'It is the latter. The data dictionary defines the denominator explicitly, and a spot check of three rows against the certified totals matches.',
    'Partly. The normalization handles the seasonal component, but the baseline period choice still shifts the result by a visible margin.',
    'I checked this against the earlier series: the two agree once you drop the provisional rows, so the apparent gap is a reporting-lag artifact.',
  ],
  reply_followup: [
    'That matches my reading, though the caveat about the smallest cohort deserves more prominence than a footnote.',
    'Agreed on the mechanics — the open question is whether the revision policy applies retroactively to the already-published rows.',
    'Useful context. If the corrected page supersedes the original, the archive link in the thread should point at the corrected one.',
    'This is the right caution: the trend only becomes interpretable after two more cycles under the same definitions.',
  ],
};

/** Generate one substantive comment body (80–400 chars, keyword-bearing). */
export function generateCommentBody(flavor: CommentFlavor, domain: DomainId, prng: Prng): string {
  const bank = domainBank(domain);
  const template = prng.pick(COMMENT_BANKS[flavor]);
  return template
    .replaceAll('{object}', prng.pick(bank.objects))
    .replaceAll('{period}', prng.pick(PERIODS));
}

/** An evidence relevance note plus a fresh citation URL. */
export function generateEvidence(
  domain: DomainId,
  serial: number,
  prng: Prng,
): { body: string; citationUrl: string } {
  const bank = domainBank(domain);
  const object = prng.pick(bank.objects);
  const outlet = prng.pick(bank.outlets);
  return {
    body: `Independent series covering the same ${object}; the figures land within the published interval, which supports the claim as stated.`,
    citationUrl: `https://${outlet}.example/refs/${domain}-corroboration-${serial}`,
  };
}

// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Deterministic content generation for the DEV traffic simulator. Every story,
// comment, and citation is produced from combinatorial sentence banks driven
// by a seeded PRNG plus a monotonic serial, so a run is reproducible and no two
// artefacts collide with the real submission guards by accident:
//   • each story carries a per-serial UNIQUE SUBJECT that dominates its title
//     and body, so unrelated stories stay well below the WS-F near-duplicate
//     threshold while the engine's ONE deliberate repost is a verbatim twin;
//   • link stories embed the serial in the URL, and their FETCHED article
//     (link-fixtures.ts) is derived from the title so it is unique per distinct
//     story but identical for a repost of the same story — the pipeline signs a
//     link over the fetched article, so this is what makes near-dup honest;
//   • bodies weave the canonical topic-catalog keywords for the proposed
//     topics, so the WS-K deterministic validator promotes them to TRUSTED
//     topic ids (feeding topic surfaces, PHI, and the topic-shaped invariants);
//   • comment bodies are substantive (not one-liners) so the constructive-
//     participation classifiers see real material rather than low-info replies.
// Synthetic link stories live on reserved `.example` origins (RFC 2606) that
// the link-fixtures module resolves deterministically in development.

import { TOPIC_KEYWORDS, topicIdForSlug } from '@licio/shared';
import { createPrng, type Prng } from './prng.js';

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
  // Non-empty so `entities[0]` is a definite fallback for the modulo pick.
  readonly entities: readonly [string, ...string[]];
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

// A large combinatorial UNIQUE SUBJECT keeps distinct stories genuinely
// different — the tiny entity×object×period space made two "different" stories
// (e.g. "…for week 8" vs "…for week 15") ~90% identical, which the WS-F 0.7
// near-duplicate detector correctly flagged. The subject is woven into every
// title (and, via the title, the fetched article body), so unrelated stories
// fall well below the threshold while the deliberate repost — which reuses the
// full title — stays an exact twin. 24 × 24 = 576 distinct (qualifier, subject)
// pairs; the two indices key off independent parts of the serial so any two
// distinct serials differ in at least one — usually both — of the two words.
const SUBJECT_QUALIFIERS = [
  'quarterly',
  'preliminary',
  'revised',
  'district-level',
  'year-end',
  'mid-cycle',
  'independent',
  'consolidated',
  'itemized',
  'region-wide',
  'provisional',
  'audited',
  'baseline',
  'comparative',
  'longitudinal',
  'cross-checked',
  'annotated',
  'machine-readable',
  'anonymized',
  'geocoded',
  'time-stamped',
  'peer-reviewed',
  'ratified',
  'reconciled',
] as const;

const SUBJECT_SUBJECTS = [
  'spending ledger',
  'safety inspection',
  'capacity survey',
  'permit backlog',
  'emissions inventory',
  'ridership tally',
  'wage schedule',
  'complaint log',
  'inspection roster',
  'procurement record',
  'incident register',
  'coverage map',
  'staffing plan',
  'maintenance calendar',
  'enrollment census',
  'turnout breakdown',
  'water-quality panel',
  'noise survey',
  'shelter-capacity table',
  'grant disbursement',
  'license-renewal batch',
  'zoning-variance docket',
  'transit-headway study',
  'energy-demand curve',
] as const;

/** A unique multi-word subject for a story serial (576 distinct combinations
 *  before wrap-around). The qualifier keys off the low part of the serial and
 *  the subject off a decorrelated combination, so CONSECUTIVE serials differ in
 *  BOTH words (not just one) while every serial in 0..575 stays unique. */
export function uniqueSubject(serial: number): string {
  const n = SUBJECT_QUALIFIERS.length; // == SUBJECT_SUBJECTS.length == 24
  const q = serial % n;
  // (7q + k) mod n is a bijection over k for fixed q (7 is coprime with 24), so
  // (q, subjectIndex) is unique across 0..n²-1 AND both indices move with serial.
  const subjectIndex = (7 * q + Math.floor(serial / n)) % n;
  return `${SUBJECT_QUALIFIERS[q] ?? 'quarterly'} ${SUBJECT_SUBJECTS[subjectIndex] ?? 'spending ledger'}`;
}

type TitleTemplate = (entity: string, subject: string, period: string) => string;
// A non-empty tuple type so `TITLE_TEMPLATES[0]` is definite (the modulo pick's
// `?? [0]` fallback then needs no non-null assertion under noUncheckedIndexedAccess).
const TITLE_TEMPLATES: readonly [TitleTemplate, ...TitleTemplate[]] = [
  (e, s, p) => `${e} publishes the ${s} for ${p}`,
  (e, s, p) => `${e} releases the updated ${s} (${p})`,
  (e, s, p) => `New ${s} from the ${e.toLowerCase()}: what changed in ${p}`,
  (e, s, p) => `${e} opens public comment on the ${s} for ${p}`,
  (e, s, p) => `${e} adds line-level detail to the ${s} covering ${p}`,
];

type QuestionTemplate = (subject: string, period: string) => string;
const QUESTION_TEMPLATES: readonly [QuestionTemplate, ...QuestionTemplate[]] = [
  (s, p) => `What does the new ${s} for ${p} actually measure?`,
  (s, p) => `How should readers interpret the ${s} covering ${p}?`,
  (s, p) => `Which parts of the ${s} for ${p} are comparable to last cycle?`,
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

function storyBody(bank: DomainBank, subject: string, prng: Prng): string {
  // Draw the bulk of the body from the LARGE shared pool, seeded by the unique
  // subject — the small per-domain banks (4 scopes/methods, 3 keywords/caveats)
  // collide too often to keep two different-subject briefs below the near-dup
  // threshold on their own. A domain keyword sentence + a GUARANTEED primary-
  // topic catalog keyword keep the WS-K classifier able to promote the topic.
  const topicWord = TOPIC_KEYWORDS.get(topicIdForSlug(bank.topicSlug))?.[0] ?? '';
  const keyword = prng.pick(bank.keywordSentences);
  const chosen = poolSentences(`sim-brief:${subject}`, 7);
  return `The ${subject} is out. ${chosen.join(' ')} It concerns ${topicWord} reporting. ${keyword}`;
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
  // Derive the title's dimensions from INDEPENDENT parts of the (unique) serial
  // rather than the shared PRNG, so two distinct stories differ across several
  // title words — not just the subject — and stay well below the near-duplicate
  // threshold. The subject (24×24 combinations) is the dominant discriminator.
  const entity = bank.entities[Math.floor(serial / 5) % bank.entities.length] ?? bank.entities[0];
  const subject = uniqueSubject(serial);
  const period = PERIODS[Math.floor(serial / 25) % PERIODS.length] ?? PERIODS[0];
  const titleTemplate = TITLE_TEMPLATES[serial % TITLE_TEMPLATES.length] ?? TITLE_TEMPLATES[0];
  const questionTemplate =
    QUESTION_TEMPLATES[serial % QUESTION_TEMPLATES.length] ?? QUESTION_TEMPLATES[0];
  const slugs =
    bank.secondarySlug !== undefined && prng.chance(0.35)
      ? [bank.topicSlug, bank.secondarySlug]
      : [bank.topicSlug];
  const body = storyBody(bank, subject, prng);
  if (kind === 'question') {
    const question = questionTemplate(subject, period);
    return {
      kind,
      title: question,
      topicSlugs: slugs,
      topicIds: slugs.map(topicIdForSlug),
      body,
      url: null,
      reason: null,
      question,
      questionContext: `Asking about the ${subject} before interpretations settle. ${prng.pick(bank.keywordSentences)}`,
      locationValue: null,
      disclosure: null,
    };
  }
  const title = titleTemplate(entity, subject, period);
  if (kind === 'link') {
    const outlet = prng.pick(bank.outlets);
    // The serial makes the URL unique; the slug carries the (unique-subject)
    // title so the fetched article — derived from the recovered title — is
    // unique per story and identical for a repost of the same story.
    const url = `https://${outlet}.example/${domain}/${slugify(title)}-${serial}`;
    return {
      kind,
      title,
      topicSlugs: slugs,
      topicIds: slugs.map(topicIdForSlug),
      body,
      url,
      reason: `A link to the ${subject}.`,
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
      // The disclosure IS the local_update's content text (what WS-F signs for
      // near-dup, alongside the title — submissionBodyText reads only this
      // field). Carry the per-story diverse `body` so distinct local updates
      // stay below the 0.7 threshold, exactly as original_brief signs its body;
      // a fixed disclosure here would collide every same-template update.
      disclosure: `${body} Source: the public briefing calendar and the posted agenda.`,
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
 * The intentional near-duplicate (repost): a verbatim LINK repost of the focus
 * link story — the SAME title, a DIFFERENT URL. The pipeline signs a link over
 * its FETCHED article, and the article (link-fixtures.ts) is derived from the
 * title recovered from the URL slug — with the `repost-` prefix stripped — so
 * the repost recovers the SAME title as its original and fetches an IDENTICAL
 * article. Its extracted signature therefore matches ⇒ the MERI near-duplicate
 * grouping fires deterministically (through the REAL pipeline, not a hand-
 * authored signature), while every unrelated link — distinct title ⇒ distinct
 * article — stays below the threshold.
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
// Fetched-article fixtures (the text the WS-F extraction pipeline signs for a
// link's near-duplicate detection)
// ---------------------------------------------------------------------------
//
// A link is signed for near-dup over its FETCHED article (not the submitted
// text). So the dev fetcher's article must be UNIQUE per distinct story — else
// unrelated links would be grouped as duplicates — while a repost's article
// must MATCH its original's. Both are achieved by deriving the article from the
// TITLE recovered from the URL slug (stripping the `repost-` prefix and trailing
// serial), seeded deterministically and drawn from a LARGE sentence pool: two
// distinct titles pick disjoint-enough sentences (well below the 0.7 threshold),
// and a repost recovers the same title ⇒ the same picks ⇒ an identical article.

const KNOWN_DOMAINS: ReadonlySet<string> = new Set(DOMAIN_IDS);

/** Recover the human title words from a URL path's last segment: strip a
 *  leading `repost-` and a trailing `-<serial>`, then de-slug. Shared by the
 *  <title> tag and the article seed so a repost and its original agree. */
export function titleFromArticleUrl(url: URL): string {
  const last = url.pathname.split('/').filter(Boolean).pop() ?? 'simulated-article';
  const words = last
    .replace(/^repost-/, '')
    .replace(/-\d+$/, '')
    .split('-')
    .filter(Boolean);
  const text = words.join(' ');
  return text.length > 0 ? text.charAt(0).toUpperCase() + text.slice(1) : 'Simulated article';
}

function articleDomain(url: URL): DomainId {
  const first = url.pathname.split('/').filter(Boolean)[0] ?? '';
  return KNOWN_DOMAINS.has(first) ? (first as DomainId) : 'local';
}

// A large, generic pool of article sentences. A title-seeded RANDOM PERMUTATION
// of this pool, sliced to a fixed length, gives distinct titles largely-disjoint
// article text (keeping unrelated links below the near-duplicate threshold)
// while a repost — same recovered title, same seed — reproduces the exact same
// slice. A pool this size keeps the expected overlap of two independent slices
// small AND its variance low, so there are no coincidental near-duplicates.
const ARTICLE_SENTENCES: readonly string[] = [
  'The document runs to several sections, each opening with a short summary of what changed.',
  'A methodology note explains how every figure was collected, cleaned, and cross-checked before release.',
  'An appendix lists the exclusions and the reasons each row was set aside during validation.',
  'Officials say the accompanying data dictionary defines every column and denominator explicitly.',
  'The release keeps the earlier field definitions and adds a revision history for traceability.',
  'Reviewers can compare this cycle against the previous one directly using the mapped line items.',
  'A public comment window opens alongside the release and closes at the end of the reporting period.',
  'Provisional rows are flagged until a second validation pass confirms them next cycle.',
  'The raw tables and the processed series are both published so independent analysts can reproduce the work.',
  'A short list of frequently asked questions addresses points raised during the last comment period.',
  'The office notes two entries were corrected after the original posting and marks them clearly.',
  'Each figure links back to the underlying record so a reader can trace it to its source.',
  'The summary separates measurement from interpretation, leaving conclusions to the discussion section.',
  'A change log at the end records every edit made since the draft was first circulated.',
  'The publishing team says a machine-readable export is available for anyone who prefers the data.',
  'An independent reviewer signed off on the sampling frame before the numbers were finalized.',
  'The report cautions that small cells are aggregated to protect the privacy of the people counted.',
  'A companion map shows how the totals break down across the districts covered by the release.',
  'The authors flag one segment as still under review and promise an update in the next cycle.',
  'Footnotes explain where a definition shifted and how that affects year-over-year comparisons.',
  'The release was timed to the regular reporting calendar rather than any single event.',
  'A glossary at the front defines the technical terms the rest of the document relies on.',
  'The office invited three outside groups to check the figures ahead of publication.',
  'The final section sets out what the next release will add and when it is expected.',
  'A one-page overview distils the headline numbers for readers short on time.',
  'The team published the code that produced every chart so the pipeline can be audited end to end.',
  'Late submissions were held to a supplementary file rather than folded into the main totals.',
  'The dataset carries a version tag so downstream users can pin to an exact snapshot.',
  'Reviewers noted that a handful of categories were merged this cycle to reduce noise.',
  'The office set out a correction policy describing how errors are logged and re-published.',
  'A sensitivity check shows how the headline figure moves under two alternative assumptions.',
  'The appendix records the response rate and how non-responses were handled in the totals.',
  'Contact details for the analysts are listed so readers can raise questions directly.',
  'The release includes a checksum for each file so a downloader can verify integrity.',
  'A short history explains how the measure evolved from the pilot to the current standard.',
  'The office committed to publishing the underlying survey instrument alongside the results.',
  'Two independent labs re-ran a sample of the calculations and reported matching figures.',
  'The document distinguishes preliminary estimates from the values certified after review.',
  'A companion notebook walks through one worked example from raw input to final number.',
  'The team flagged one outlier for follow-up and left it in the series with a note.',
];

const ARTICLE_SENTENCE_COUNT = 14;

/** A deterministic, largely-disjoint selection from the large article pool: a
 *  Fisher–Yates shuffle seeded by `seed`, sliced to `count`. Distinct seeds ⇒
 *  largely-disjoint selections (kept below the near-dup threshold by the pool
 *  size); identical seeds ⇒ an identical selection. Used for both the fetched
 *  link article (seeded by the recovered title) and the inline brief body
 *  (seeded by the story's unique subject) — both need genuine per-story
 *  diversity that the small per-domain sentence banks cannot provide. */
function poolSentences(seed: string, count: number): readonly string[] {
  const prng = createPrng(seed);
  const idx = ARTICLE_SENTENCES.map((_, i) => i);
  for (let i = idx.length - 1; i > 0; i -= 1) {
    const j = prng.int(i + 1);
    const a = idx[i];
    const b = idx[j];
    if (a === undefined || b === undefined) continue;
    idx[i] = b;
    idx[j] = a;
  }
  return idx
    .slice(0, count)
    .map((i) => ARTICLE_SENTENCES[i])
    .filter((s): s is string => s !== undefined);
}

/**
 * A deterministic article body for the dev fetcher, derived from the title
 * recovered from the URL. A title-seeded permutation of the large pool, sliced
 * to a fixed length, makes distinct titles largely-disjoint (unique) while a
 * repost recovers the same title ⇒ the same slice ⇒ an identical article.
 */
export function simulatedArticleBody(url: URL): string {
  const domain = articleDomain(url);
  const title = titleFromArticleUrl(url);
  const bank = domainBank(domain);
  const chosen = poolSentences(`sim-article:${title.toLowerCase()}`, ARTICLE_SENTENCE_COUNT);
  // A domain KEYWORD sentence (title-seeded) so the WS-K classifier still sees
  // the domain keywords in the fetched excerpt.
  const kwPrng = createPrng(`sim-article-kw:${title.toLowerCase()}`);
  const keyword = bank.keywordSentences[kwPrng.int(bank.keywordSentences.length)] ?? '';
  return `${title}. ${chosen.join(' ')} ${keyword}`;
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

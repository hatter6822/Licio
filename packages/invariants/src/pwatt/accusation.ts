// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Conservative v0 accusation classifier (WS-E.2.2b, SPEC §5.3 "source-free
// accusation — requires evidence or is downweighted"). The v0 mandate is to
// ERR TOWARD NOT DOWNWEIGHTING: ordinary opinion, routine disagreement,
// questions, hedged statements, and reported speech are never classified.
// A text is an accusation only when ALL hold:
//   1. it names serious wrongdoing (a closed lexical list — crimes and grave
//      misconduct, not mere criticism),
//   2. it asserts it directly of a subject (pronoun or proper noun + a direct
//      assertion verb),
//   3. it is not hedged (allegedly / I think / may have / accused of …), and
//   4. it is not a question.
// The classification affects SCORING WEIGHT only — never visibility or
// moderation status. The AI classifier integration point is WS-K: this
// function's signature (text → boolean) is the seam a reviewed classifier
// replaces; callers depend only on the boolean.

/** Serious-wrongdoing lexicon (closed, conservative). */
const WRONGDOING = new RegExp(
  String.raw`\b(?:fraud(?:ulent)?|embezzl\w*|stole|steal\w*|theft|brib\w*|corrupt\w*|launder\w*|` +
    String.raw`assault\w*|abus(?:e[ds]?|ing|ive)|blackmail\w*|extort\w*|scam(?:med|mer|s)?|` +
    String.raw`forg(?:ed|ery)|criminal|crime|traffick\w*|molest\w*|defraud\w*)\b`,
  'i',
);

/**
 * Assertion verbs: auxiliaries/copulas ("is a fraud", "committed fraud") plus
 * the direct past-tense forms of the wrongdoing lexicon ("embezzled", "stole")
 * so "He embezzled the treasury" is recognized as a direct assertion.
 */
const ASSERTION_VERBS =
  '(?:is|are|was|were|has|have|had|did|commits?|committed|' +
  'embezzled|stole|bribed|assaulted|blackmailed|extorted|scammed|defrauded|' +
  'laundered|forged|trafficked|molested|abused)';

/** Direct-assertion pattern: a pronoun subject + an assertion verb… */
const PRONOUN_ASSERTION = new RegExp(
  String.raw`\b(?:he|she|they|you|it)\s+${ASSERTION_VERBS}\b`,
  'i',
);

/** …or a proper-noun subject (case-sensitive) + an assertion verb. */
const PROPER_NOUN_ASSERTION = new RegExp(
  String.raw`\b[A-Z][a-zA-Z]{2,}(?:\s+[A-Z][a-zA-Z]{2,})*\s+${ASSERTION_VERBS}\b`,
);

/** Hedge/report markers: any of these defuses the v0 classification. */
const HEDGED = new RegExp(
  String.raw`\b(?:allegedly|reportedly|apparently|supposedly|i think|i believe|i feel|` +
    'in my opinion|imo|might|may have|could have|seems?|appears?|accused of|' +
    String.raw`suspected|claims?\s+that|according to)\b`,
  'i',
);

/**
 * Classify a contribution body as a direct, unhedged assertion of serious
 * wrongdoing. Conservative by construction (see module header).
 */
export function classifyAccusationV0(body: string): boolean {
  const text = body.trim();
  if (text.length < 8) return false;
  if (text.endsWith('?')) return false;
  if (HEDGED.test(text)) return false;
  if (!WRONGDOING.test(text)) return false;
  // Strip a leading sentence-capital so "Theft is wrong." does not read the
  // first word as a proper-noun subject.
  const withoutLead = text.replace(/^[A-Z][a-zA-Z]*\s*/, '');
  return PRONOUN_ASSERTION.test(text) || PROPER_NOUN_ASSERTION.test(withoutLead);
}

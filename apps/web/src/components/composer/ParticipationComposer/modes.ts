// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Participation-mode catalogue (WS-G.3.4–3.6, SPEC §6.6/§15.1). Licio
// replaces "post for applause" with the ELEVEN canonical typed contributions
// — the catalogue ids ARE the wire `type` values, and field names match the
// WS-G.1.2b canon so the payload builder is mechanical and the shared zod
// schema validates the same shapes the server enforces (no client/server
// drift by construction).  The catalogue is data, not markup: the composer
// renders a mode's fields from its `fields` array.
//
// Doctrine: NONE of these modes is "react / like / vote". There is
// deliberately no applause field anywhere in this catalogue (asserted in the
// no-applause test) — contributions are weighted by participation and
// evidence, never by popularity.
import type { ContributionType } from '@licio/shared';
import { CONTRIBUTION_BODY_LIMITS, MODERATION_REASON_CODES } from '@licio/shared';

/** Which primitive renders a field. */
export type FieldKind = 'text' | 'textarea' | 'select' | 'checkbox' | 'citation';

/** A selectable option for a `select` field. */
export interface FieldOption {
  /** Stable value stored in the composer's values record. */
  value: string;
  /** i18n key for the option label. */
  labelKey: string;
  /** Default English label. */
  labelText: string;
}

/** One field within a mode. Copy is carried as (key, default) i18n pairs. */
export interface ModeField {
  /** Stable key, unique within its mode — the WIRE field name (WS-G.1.2b). */
  name: string;
  kind: FieldKind;
  /** i18n key for the field label. */
  labelKey: string;
  /** Default English label. */
  labelText: string;
  required: boolean;
  /** Character cap (live counter; mirrors the shared schema bound). */
  maxLength?: number;
  /** Options for a `select` field. */
  options?: readonly FieldOption[];
  /**
   * When set, a privacy warning renders immediately BEFORE this field. Used
   * for sensitive inputs so the warning precedes the control in DOM and
   * reading order (WS-B.2.10 / WS-G.3.6b).
   */
  privacyWarningKey?: string;
  privacyWarningText?: string;
  /** Voice dictation affordance (WS-G.3.7d; body-text fields only). */
  dictation?: boolean;
}

/** The eleven participation modes — ids are the canonical wire types. */
export type ComposerMode = ContributionType;

/** The five WS-G.3.4a selector groups (discoverability). */
export const COMPOSER_GROUPS = [
  { id: 'ask', nameKey: 'composer.group.ask', nameText: 'Ask', modes: ['question'] },
  {
    id: 'respond',
    nameKey: 'composer.group.respond',
    nameText: 'Respond',
    modes: ['answer', 'explanation'],
  },
  {
    id: 'evidence',
    nameKey: 'composer.group.evidence',
    nameText: 'Evidence',
    modes: ['evidence', 'counterexample', 'local_context', 'direct_experience'],
  },
  {
    id: 'improve',
    nameKey: 'composer.group.improve',
    nameText: 'Improve',
    modes: ['correction', 'synthesis'],
  },
  {
    id: 'meta',
    nameKey: 'composer.group.meta',
    nameText: 'Meta',
    modes: ['moderation_concern', 'meta_discussion'],
  },
] as const satisfies ReadonlyArray<{
  id: string;
  nameKey: string;
  nameText: string;
  modes: readonly ComposerMode[];
}>;

export interface ModeDefinition {
  mode: ComposerMode;
  /** Short, human name of the mode (the chooser's primary label). */
  nameKey: string;
  nameText: string;
  /** The mode's guiding question (the chooser's description + composer heading). */
  promptKey: string;
  promptText: string;
  /** Icon paired with the mode (colour is never the sole signal). */
  icon:
    | 'circle-question'
    | 'paperclip'
    | 'pencil'
    | 'layers'
    | 'quote'
    | 'user'
    | 'circle-info'
    | 'flag'
    | 'globe'
    | 'threads'
    | 'check-circle';
  fields: readonly ModeField[];
}

const LOCATION_PRIVACY = {
  privacyWarningKey: 'composer.privacy.experience',
  privacyWarningText:
    'This shares personal experience publicly. Do not include identifying details you wish to keep private.',
} as const;

const body = (mode: ComposerMode, labelText: string): ModeField => ({
  name: 'body',
  kind: 'textarea',
  labelKey: `composer.field.${mode}.body`,
  labelText,
  required: true,
  maxLength: CONTRIBUTION_BODY_LIMITS[mode],
  dictation: true,
});

const claimReference = (required: boolean): ModeField => ({
  name: 'target_claim_id',
  kind: 'text',
  labelKey: 'composer.field.claim',
  labelText: required ? 'Claim this refers to' : 'Claim this refers to (optional)',
  required,
});

const citations = (required: boolean, labelText: string): ModeField => ({
  name: 'citations',
  kind: 'citation',
  labelKey: 'composer.field.citations',
  labelText,
  required,
});

/** Reason options: a curated user-facing subset of the WS-A.1.2 taxonomy
 *  (one representative code per §18.1 category; the full 51-code vocabulary
 *  is steward-facing).  Pinned against MODERATION_REASON_CODES by test. */
const FLAG_REASON_OPTIONS: readonly FieldOption[] = [
  {
    value: 'MOD_HARASS_001',
    labelKey: 'flag.harassment',
    labelText: 'Harassment or targeted abuse',
  },
  { value: 'MOD_THREAT_001', labelKey: 'flag.threat', labelText: 'Credible threat or incitement' },
  { value: 'MOD_HATE_001', labelKey: 'flag.hate', labelText: 'Hate or dehumanization' },
  { value: 'MOD_MISINFO_001', labelKey: 'flag.misinfo', labelText: 'Dangerous misinformation' },
  { value: 'MOD_SPAM_001', labelKey: 'flag.spam', labelText: 'Spam or manipulation' },
  { value: 'MOD_PRIVACY_001', labelKey: 'flag.privacy', labelText: 'Privacy violation or doxxing' },
  { value: 'MOD_IMPERS_001', labelKey: 'flag.impersonation', labelText: 'Impersonation' },
  { value: 'MOD_ILLEGAL_001', labelKey: 'flag.illegal', labelText: 'Illegal content' },
  { value: 'MOD_CSE_001', labelKey: 'flag.cse', labelText: 'Child safety' },
  { value: 'MOD_GRAPHIC_001', labelKey: 'flag.graphic', labelText: 'Graphic or shocking content' },
  { value: 'MOD_SYNTH_001', labelKey: 'flag.synthetic', labelText: 'Undisclosed synthetic media' },
  { value: 'MOD_IP_001', labelKey: 'flag.ip', labelText: 'Intellectual-property violation' },
];

/** Every flag option must be a ratified WS-A.1.2 code (import-time guard). */
const RATIFIED = new Set<string>(MODERATION_REASON_CODES);
for (const option of FLAG_REASON_OPTIONS) {
  if (!RATIFIED.has(option.value)) {
    throw new Error(`Unratified flag reason code in catalogue: ${option.value}`);
  }
}

export const composerModes: readonly ModeDefinition[] = [
  {
    mode: 'question',
    nameKey: 'composer.mode.question.name',
    nameText: 'Ask',
    promptKey: 'composer.mode.question.prompt',
    promptText: 'What would clarify this?',
    icon: 'circle-question',
    fields: [body('question', 'Question'), claimReference(false)],
  },
  {
    mode: 'answer',
    nameKey: 'composer.mode.answer.name',
    nameText: 'Answer',
    promptKey: 'composer.mode.answer.prompt',
    promptText: 'Answer the question directly.',
    icon: 'check-circle',
    fields: [body('answer', 'Answer'), citations(false, 'Citations (optional)')],
  },
  {
    mode: 'evidence',
    nameKey: 'composer.mode.evidence.name',
    nameText: 'Evidence',
    promptKey: 'composer.mode.evidence.prompt',
    promptText: 'What source should readers inspect?',
    icon: 'paperclip',
    fields: [
      citations(true, 'Link or citation'),
      {
        name: 'body',
        kind: 'textarea',
        labelKey: 'composer.field.evidence.body',
        labelText: 'Why is this relevant?',
        required: true,
        maxLength: CONTRIBUTION_BODY_LIMITS.evidence,
        dictation: true,
      },
      claimReference(true),
      {
        name: 'evidence_type',
        kind: 'select',
        labelKey: 'composer.field.evidence.type',
        labelText: 'What kind of evidence is this?',
        required: true,
        options: [
          {
            value: 'primary_source',
            labelKey: 'evidence.primary_source',
            labelText: 'Primary source',
          },
          { value: 'dataset', labelKey: 'evidence.dataset', labelText: 'Dataset' },
          { value: 'transcript', labelKey: 'evidence.transcript', labelText: 'Transcript' },
          { value: 'legal_text', labelKey: 'evidence.legal_text', labelText: 'Legal text' },
          { value: 'report', labelKey: 'evidence.report', labelText: 'Report' },
          {
            value: 'expert_reference',
            labelKey: 'evidence.expert_reference',
            labelText: 'Expert reference',
          },
          { value: 'fact_check', labelKey: 'evidence.fact_check', labelText: 'Fact check' },
        ],
      },
    ],
  },
  {
    mode: 'correction',
    nameKey: 'composer.mode.correction.name',
    nameText: 'Correction',
    promptKey: 'composer.mode.correction.prompt',
    promptText: 'What is incorrect or missing?',
    icon: 'pencil',
    fields: [
      {
        name: 'target_text_excerpt',
        kind: 'text',
        labelKey: 'composer.field.correction.target',
        labelText: 'Text being corrected',
        required: false,
        maxLength: 500,
      },
      body('correction', 'Correction'),
      citations(true, 'Supporting evidence (1–5 citations)'),
      claimReference(true),
    ],
  },
  {
    mode: 'synthesis',
    nameKey: 'composer.mode.synthesis.name',
    nameText: 'Synthesis',
    promptKey: 'composer.mode.synthesis.prompt',
    promptText: 'What can be fairly summarized?',
    icon: 'layers',
    fields: [
      body('synthesis', 'Summary'),
      {
        name: 'included_branch_ids',
        kind: 'text',
        labelKey: 'composer.field.synthesis.branches',
        labelText: 'Branches included (at least two)',
        required: true,
      },
      {
        name: 'uncertainty_note',
        kind: 'textarea',
        labelKey: 'composer.field.synthesis.uncertainty',
        labelText: 'What remains unresolved? (optional)',
        required: false,
        maxLength: 1000,
      },
    ],
  },
  {
    mode: 'counterexample',
    nameKey: 'composer.mode.counterexample.name',
    nameText: 'Counterexample',
    promptKey: 'composer.mode.counterexample.prompt',
    promptText: 'What case complicates this?',
    icon: 'quote',
    fields: [
      body('counterexample', 'The example'),
      {
        name: 'relevance_explanation',
        kind: 'textarea',
        labelKey: 'composer.field.counterexample.relevance',
        labelText: 'Why is it relevant?',
        required: true,
        maxLength: 500,
      },
      claimReference(true),
      {
        name: 'source_url',
        kind: 'text',
        labelKey: 'composer.field.counterexample.source',
        labelText: 'Source, if factual (optional)',
        required: false,
      },
    ],
  },
  {
    mode: 'explanation',
    nameKey: 'composer.mode.explanation.name',
    nameText: 'Explain',
    promptKey: 'composer.mode.explanation.prompt',
    promptText: 'Can you make this easier to understand?',
    icon: 'circle-info',
    fields: [
      body('explanation', 'Explanation'),
      {
        name: 'assumptions',
        kind: 'textarea',
        labelKey: 'composer.field.explanation.assumptions',
        labelText: 'Assumptions this relies on. (optional)',
        required: false,
        maxLength: 500,
      },
      {
        name: 'caveats',
        kind: 'textarea',
        labelKey: 'composer.field.explanation.caveats',
        labelText: 'Limitations or exceptions. (optional)',
        required: false,
        maxLength: 500,
      },
    ],
  },
  {
    mode: 'local_context',
    nameKey: 'composer.mode.local_context.name',
    nameText: 'Local context',
    promptKey: 'composer.mode.local_context.prompt',
    promptText: 'What local knowledge applies here?',
    icon: 'globe',
    fields: [
      body('local_context', 'Local context'),
      {
        name: 'scope',
        kind: 'text',
        labelKey: 'composer.field.scope',
        labelText: 'Your vantage point (e.g. "Riverside resident")',
        required: true,
        maxLength: 200,
      },
      {
        name: 'location',
        kind: 'text',
        labelKey: 'composer.field.location',
        labelText: 'Approximate location (optional)',
        required: false,
        maxLength: 200,
        ...LOCATION_PRIVACY,
      },
      {
        name: 'time_context',
        kind: 'text',
        labelKey: 'composer.field.time',
        labelText: 'Time period (optional)',
        required: false,
        maxLength: 200,
      },
    ],
  },
  {
    mode: 'direct_experience',
    nameKey: 'composer.mode.direct_experience.name',
    nameText: 'Experience',
    promptKey: 'composer.mode.direct_experience.prompt',
    promptText: 'What direct context do you have?',
    icon: 'user',
    fields: [
      body('direct_experience', 'What you directly experienced'),
      {
        name: 'scope',
        kind: 'text',
        labelKey: 'composer.field.scope',
        labelText: 'Your vantage point (e.g. "Hearing attendee")',
        required: true,
        maxLength: 200,
      },
      {
        name: 'location',
        kind: 'text',
        labelKey: 'composer.field.location',
        labelText: 'Approximate location (optional)',
        required: false,
        maxLength: 200,
        ...LOCATION_PRIVACY,
      },
      {
        name: 'time_context',
        kind: 'text',
        labelKey: 'composer.field.time',
        labelText: 'Time period (optional)',
        required: false,
        maxLength: 200,
      },
      {
        name: 'privacy_acknowledged',
        kind: 'checkbox',
        labelKey: 'composer.field.privacyAck',
        labelText: 'I understand this will be shared publicly.',
        required: true,
        ...LOCATION_PRIVACY,
      },
    ],
  },
  {
    mode: 'moderation_concern',
    nameKey: 'composer.mode.moderation_concern.name',
    nameText: 'Flag',
    promptKey: 'composer.mode.moderation_concern.prompt',
    promptText: 'What policy or safety issue exists?',
    icon: 'flag',
    fields: [
      {
        name: 'reason_code',
        kind: 'select',
        labelKey: 'composer.field.flag.reason',
        labelText: 'Reason',
        required: true,
        options: FLAG_REASON_OPTIONS,
      },
      body('moderation_concern', 'Describe the concern'),
      {
        name: 'target_contribution_id',
        kind: 'text',
        labelKey: 'composer.field.flag.target',
        labelText: 'What you are flagging',
        required: true,
      },
      {
        name: 'urgency',
        kind: 'select',
        labelKey: 'composer.field.flag.urgency',
        labelText: 'Urgency',
        required: false,
        options: [
          { value: 'normal', labelKey: 'composer.urgency.normal', labelText: 'Normal' },
          {
            value: 'urgent',
            labelKey: 'composer.urgency.urgent',
            labelText: 'Urgent — use for imminent harm',
          },
        ],
      },
    ],
  },
  {
    mode: 'meta_discussion',
    nameKey: 'composer.mode.meta_discussion.name',
    nameText: 'Meta',
    promptKey: 'composer.mode.meta_discussion.prompt',
    promptText: 'Discuss the thread structure itself.',
    icon: 'threads',
    fields: [
      body('meta_discussion', 'Discussion'),
      {
        name: 'target_contribution_id',
        kind: 'text',
        labelKey: 'composer.field.meta.target',
        labelText: 'Contribution this refers to (optional)',
        required: false,
      },
    ],
  },
] as const;

/** Lookup a mode definition by its discriminant. */
export function getModeDefinition(mode: ComposerMode): ModeDefinition {
  const found = composerModes.find((definition) => definition.mode === mode);
  if (!found) {
    // Unreachable for the closed `ComposerMode` union; guards a bad cast.
    throw new Error(`Unknown participation mode: ${mode}`);
  }
  return found;
}

/** The values a composer holds for a mode: field name → current string value. */
export type ComposerValues = Record<string, string>;

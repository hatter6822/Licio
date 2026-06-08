// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Participation-mode catalogue (WS-B.2.10). Licio replaces "post for applause"
// with eight STRUCTURED contributions, each asking for the specific evidence,
// reasoning, or context that mode requires. The catalogue is data, not markup:
// the composer renders a mode's fields from its `fields` array, so the modes are
// the single source of truth for prompts, required-ness, and field kinds, and a
// new mode never means new branching UI.
//
// Doctrine: NONE of these modes is "react / like / vote". There is deliberately
// no applause field anywhere in this catalogue (asserted in the no-applause
// test) — contributions are weighted by participation and evidence, never by
// popularity.

/** Which primitive renders a field. */
export type FieldKind = 'text' | 'textarea' | 'select';

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
  /** Stable key, unique within its mode; used as the values-record key. */
  name: string;
  kind: FieldKind;
  /** i18n key for the field label. */
  labelKey: string;
  /** Default English label. */
  labelText: string;
  required: boolean;
  /** Options for a `select` field. */
  options?: readonly FieldOption[];
  /**
   * When set, a privacy warning renders immediately BEFORE this field. Used for
   * sensitive inputs (file references, location/time) so the warning precedes
   * the control in DOM and reading order (WS-B.2.10).
   */
  privacyWarningKey?: string;
  privacyWarningText?: string;
}

/** The eight participation modes (WS-B.2.10). */
export type ComposerMode =
  | 'ask'
  | 'evidence'
  | 'correction'
  | 'synthesis'
  | 'counterexample'
  | 'experience'
  | 'explain'
  | 'flag';

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
    | 'flag';
  fields: readonly ModeField[];
}

const FILE_PRIVACY = {
  privacyWarningKey: 'composer.privacy.evidence',
  privacyWarningText:
    'If you attach a file, it can carry hidden metadata (location, device, author). Review it before sharing.',
} as const;

const LOCATION_PRIVACY = {
  privacyWarningKey: 'composer.privacy.experience',
  privacyWarningText:
    'Sharing a location or time can identify you. Only add detail you are comfortable making public.',
} as const;

export const composerModes: readonly ModeDefinition[] = [
  {
    mode: 'ask',
    nameKey: 'composer.mode.ask.name',
    nameText: 'Ask',
    promptKey: 'composer.mode.ask.prompt',
    promptText: 'What would clarify this?',
    icon: 'circle-question',
    fields: [
      {
        name: 'question',
        kind: 'textarea',
        labelKey: 'composer.field.ask.question',
        labelText: 'Question',
        required: true,
      },
      {
        name: 'claimReference',
        kind: 'text',
        labelKey: 'composer.field.ask.claim',
        labelText: 'Claim this refers to (optional)',
        required: false,
      },
    ],
  },
  {
    mode: 'evidence',
    nameKey: 'composer.mode.evidence.name',
    nameText: 'Evidence',
    promptKey: 'composer.mode.evidence.prompt',
    promptText: 'What source should readers inspect?',
    icon: 'paperclip',
    fields: [
      {
        name: 'source',
        kind: 'text',
        labelKey: 'composer.field.evidence.source',
        labelText: 'Link, file, or citation',
        required: true,
        ...FILE_PRIVACY,
      },
      {
        name: 'relevance',
        kind: 'textarea',
        labelKey: 'composer.field.evidence.relevance',
        labelText: 'Why is this relevant?',
        required: true,
      },
      {
        name: 'claimReference',
        kind: 'text',
        labelKey: 'composer.field.evidence.claim',
        labelText: 'Claim this refers to',
        required: false,
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
        name: 'targetText',
        kind: 'text',
        labelKey: 'composer.field.correction.target',
        labelText: 'Text being corrected',
        required: true,
      },
      {
        name: 'correction',
        kind: 'textarea',
        labelKey: 'composer.field.correction.correction',
        labelText: 'Correction',
        required: true,
      },
      {
        name: 'supportingEvidence',
        kind: 'text',
        labelKey: 'composer.field.correction.evidence',
        labelText: 'Supporting evidence (optional)',
        required: false,
      },
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
      {
        name: 'summary',
        kind: 'textarea',
        labelKey: 'composer.field.synthesis.summary',
        labelText: 'Summary',
        required: true,
      },
      {
        name: 'includedBranches',
        kind: 'text',
        labelKey: 'composer.field.synthesis.branches',
        labelText: 'Branches included (optional)',
        required: false,
      },
      {
        name: 'uncertainty',
        kind: 'textarea',
        labelKey: 'composer.field.synthesis.uncertainty',
        labelText: 'What remains uncertain? (optional)',
        required: false,
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
      {
        name: 'example',
        kind: 'textarea',
        labelKey: 'composer.field.counterexample.example',
        labelText: 'The example',
        required: true,
      },
      {
        name: 'relevance',
        kind: 'textarea',
        labelKey: 'composer.field.counterexample.relevance',
        labelText: 'Why is it relevant?',
        required: true,
      },
      {
        name: 'source',
        kind: 'text',
        labelKey: 'composer.field.counterexample.source',
        labelText: 'Source, if factual (optional)',
        required: false,
      },
    ],
  },
  {
    mode: 'experience',
    nameKey: 'composer.mode.experience.name',
    nameText: 'Experience',
    promptKey: 'composer.mode.experience.prompt',
    promptText: 'What direct context do you have?',
    icon: 'user',
    fields: [
      {
        name: 'scope',
        kind: 'textarea',
        labelKey: 'composer.field.experience.scope',
        labelText: 'What you directly experienced',
        required: true,
      },
      {
        name: 'locationTime',
        kind: 'text',
        labelKey: 'composer.field.experience.location',
        labelText: 'Location or time, if relevant (optional)',
        required: false,
        ...LOCATION_PRIVACY,
      },
      {
        name: 'uncertainty',
        kind: 'textarea',
        labelKey: 'composer.field.experience.uncertainty',
        labelText: 'Uncertainty or privacy note (optional)',
        required: false,
      },
    ],
  },
  {
    mode: 'explain',
    nameKey: 'composer.mode.explain.name',
    nameText: 'Explain',
    promptKey: 'composer.mode.explain.prompt',
    promptText: 'Can you make this easier to understand?',
    icon: 'circle-info',
    fields: [
      {
        name: 'explanation',
        kind: 'textarea',
        labelKey: 'composer.field.explain.explanation',
        labelText: 'Explanation',
        required: true,
      },
      {
        name: 'assumptions',
        kind: 'textarea',
        labelKey: 'composer.field.explain.assumptions',
        labelText: 'Assumptions (optional)',
        required: false,
      },
      {
        name: 'caveats',
        kind: 'textarea',
        labelKey: 'composer.field.explain.caveats',
        labelText: 'Caveats (optional)',
        required: false,
      },
    ],
  },
  {
    mode: 'flag',
    nameKey: 'composer.mode.flag.name',
    nameText: 'Flag',
    promptKey: 'composer.mode.flag.prompt',
    promptText: 'What policy or safety issue exists?',
    icon: 'flag',
    fields: [
      {
        name: 'target',
        kind: 'text',
        labelKey: 'composer.field.flag.target',
        labelText: 'What you are flagging',
        required: true,
      },
      {
        name: 'reason',
        kind: 'textarea',
        labelKey: 'composer.field.flag.reason',
        labelText: 'Reason',
        required: true,
      },
      {
        name: 'urgency',
        kind: 'select',
        labelKey: 'composer.field.flag.urgency',
        labelText: 'Urgency',
        required: false,
        options: [
          { value: 'low', labelKey: 'composer.urgency.low', labelText: 'Low' },
          { value: 'medium', labelKey: 'composer.urgency.medium', labelText: 'Medium' },
          { value: 'high', labelKey: 'composer.urgency.high', labelText: 'High' },
        ],
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

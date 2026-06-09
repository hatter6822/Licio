// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Participation Composer surface (WS-B.2.10 modes + WS-B.2.11 affordances).

export {
  Attachment,
  type AttachmentProps,
  CitationCapture,
  type CitationCaptureProps,
  getSpeechRecognition,
  PrivacyWarning,
  type PrivacyWarningProps,
  type SpeechRecognitionConstructor,
  type SpeechRecognitionLike,
  VoiceDictation,
  type VoiceDictationProps,
} from './ComposerAffordances/index.js';
export {
  type ComposerErrors,
  type ComposerMode,
  type ComposerValues,
  composerModes,
  type FieldKind,
  type FieldOption,
  getModeDefinition,
  type ModeDefinition,
  type ModeField,
  ParticipationComposer,
  type ParticipationComposerProps,
} from './ParticipationComposer/index.js';

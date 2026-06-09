// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Participation Composer surface (WS-B.2.10 modes + WS-B.2.11 affordances).
export {
  ParticipationComposer,
  type ParticipationComposerProps,
  type ComposerErrors,
  type ComposerMode,
  type ComposerValues,
  type ModeDefinition,
  type ModeField,
  type FieldKind,
  type FieldOption,
  composerModes,
  getModeDefinition,
} from './ParticipationComposer/index.js';
export {
  VoiceDictation,
  type VoiceDictationProps,
  CitationCapture,
  type CitationCaptureProps,
  Attachment,
  type AttachmentProps,
  PrivacyWarning,
  type PrivacyWarningProps,
  getSpeechRecognition,
  type SpeechRecognitionConstructor,
  type SpeechRecognitionLike,
} from './ComposerAffordances/index.js';

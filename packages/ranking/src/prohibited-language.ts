// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The §13.6 + §30.6 prohibited ranking-vocabulary artifact. The per-item
// distribution-reason explanation system was removed (feed cards no longer
// carry a "why shown" line), but this vocabulary is DOCTRINE, not a template
// detail: neutrality test 9 (WS-I.3.1i) scans the web i18n copy catalog with
// the SAME shared artifact so no user-facing string can frame payments as
// endorsement or dress ranking up as "trending"/"popular"/"boosted". Keep it
// the single source both CI and any future copy producer import.

/** §13.6 + §30.6 prohibited ranking/endorsement vocabulary (case-insensitive). */
export const PROHIBITED_EXPLANATION_PATTERNS: readonly RegExp[] = [
  /because of the algorithm/i,
  /\btrending\b/i,
  /\bpopular\b/i,
  /\brecommended for you\b/i,
  /\bgoing viral\b/i,
  /\bendorse(?:s|d|ment)?\b/i,
  /\bboost(?:s|ed|ing)?\b/i,
  /\bpromot(?:e|es|ed|ing|ion)\b/i,
  /\bvote for quality\b/i,
  /\bsupport means better\b/i,
];

/** True when a user-facing string violates the prohibited-language list. */
export function violatesProhibitedLanguage(text: string): boolean {
  return PROHIBITED_EXPLANATION_PATTERNS.some((pattern) => pattern.test(text));
}

// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Plain-language enforcement support (WS-B.2.13 / Section 26.3). A curated list
// of Licio's domain jargon and a detector used to (a) audit user-facing copy in
// tests and (b) drive where a DefinedTerm affordance should wrap a term so its
// plain-language definition is one tap/hover/focus away.

/** Technical terms that should be defined (via DefinedTerm) rather than bare. */
export const JARGON_TERMS: readonly string[] = [
  'PWAtt',
  'SCOI',
  'MERI',
  'MFCI',
  'GWEI',
  'PHI',
  'Knomosis',
  'invariant',
  'coordination risk',
  'evidence card',
  'lens',
  'bridge',
];

/**
 * Return the jargon terms that appear in `text` (whole-word, case-insensitive).
 * Used by the plain-language audit; an empty result means the copy is clear.
 */
export function findJargon(text: string): string[] {
  return JARGON_TERMS.filter((term) => {
    const pattern = new RegExp(`\\b${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
    return pattern.test(text);
  });
}

/** Convenience predicate for assertions: does the copy contain any jargon? */
export function hasJargon(text: string): boolean {
  return findJargon(text).length > 0;
}

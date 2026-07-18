// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The §13.6 + §30.6 prohibited-vocabulary artifact (WS-I.3.1i). The template
// system it once guarded was removed; the artifact itself remains doctrine —
// neutrality test 9 (apps/api) scans the web i18n copy catalog with it, and
// this suite pins its shape and matching semantics.

import { describe, expect, it } from 'vitest';
import { PROHIBITED_EXPLANATION_PATTERNS, violatesProhibitedLanguage } from '../index.js';

describe('prohibited ranking vocabulary (§13.6 + §30.6)', () => {
  it('covers the doctrine vocabulary (≥ 10 patterns)', () => {
    expect(PROHIBITED_EXPLANATION_PATTERNS.length).toBeGreaterThanOrEqual(10);
  });

  it('flags endorsement/engagement framing, case-insensitively', () => {
    for (const phrase of [
      'because of the algorithm',
      'This is TRENDING now',
      'Popular in your area',
      'Recommended for you',
      'going viral',
      'Paying endorses this story',
      'Boost this post',
      'We promote quality',
      'vote for quality',
      'support means better placement',
    ]) {
      expect(violatesProhibitedLanguage(phrase)).toBe(true);
    }
  });

  it('passes neutral descriptive copy', () => {
    for (const phrase of [
      'Shown in time order, as your feed mode requests.',
      'Readers opened the original source.',
      'This thread is temporarily under integrity review.',
      'Payments support the platform and grant governance participation.',
    ]) {
      expect(violatesProhibitedLanguage(phrase)).toBe(false);
    }
  });

  it('never matches on substrings of safe words (boundaries hold)', () => {
    // "boost"/"promote"/"endorse" must not fire inside unrelated words.
    expect(violatesProhibitedLanguage('the lamppost stood tall')).toBe(false);
    expect(violatesProhibitedLanguage('an unpopularized topic')).toBe(false);
  });
});

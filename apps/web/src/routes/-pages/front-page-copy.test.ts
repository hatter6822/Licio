// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-Q.5.4b — the front page's remaining self-description (the empty-state
// copy; the always-visible framing line was removed as redundant chrome) must
// imply NO popularity/applause signal: no likes, votes, upvotes, karma,
// reactions, "trending", or "viral". It affirms participation-weighted
// attention; "never by popularity" is a deliberate disavowal (the word
// popularity is allowed in that negation).
import { describe, expect, it } from 'vitest';
import { FRONT_PAGE_EMPTY_DESCRIPTION } from './front-page.js';

/** Applause vocabulary prohibited in user-facing copy (no-applause doctrine). */
const PROHIBITED_APPLAUSE =
  /\b(?:up\s*votes?|down\s*votes?|upvoted|downvoted|likes?|liked|votes?|voted|karma|reactions?|thumbs|trending|viral|most[-\s]liked|most[-\s]upvoted)\b/i;

describe('WS-Q.5.4b front-page copy', () => {
  it('the empty-state description implies no applause/popularity signal', () => {
    expect(FRONT_PAGE_EMPTY_DESCRIPTION).not.toMatch(PROHIBITED_APPLAUSE);
    // It affirms the real basis: participation-weighted attention.
    expect(FRONT_PAGE_EMPTY_DESCRIPTION.toLowerCase()).toContain(
      'participation-weighted attention',
    );
  });
});

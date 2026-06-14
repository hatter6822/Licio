// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-Q.5.4b — the front-page framing copy must imply NO popularity/applause
// signal: no likes, votes, upvotes, karma, reactions, "trending", or "viral".
// The framing affirms participation-weighted attention; "never by popularity"
// is a deliberate disavowal (the word popularity is allowed in that negation).
import { describe, expect, it } from 'vitest';
import { FRONT_PAGE_EMPTY_DESCRIPTION, FRONT_PAGE_FRAMING } from './front-page.js';

/** Applause vocabulary prohibited in user-facing copy (no-applause doctrine). */
const PROHIBITED_APPLAUSE =
  /\b(?:up\s*votes?|down\s*votes?|upvoted|downvoted|likes?|liked|votes?|voted|karma|reactions?|thumbs|trending|viral|most[-\s]liked|most[-\s]upvoted)\b/i;

describe('WS-Q.5.4b front-page framing copy', () => {
  it.each([
    ['framing', FRONT_PAGE_FRAMING],
    ['empty description', FRONT_PAGE_EMPTY_DESCRIPTION],
  ])('%s implies no applause/popularity signal', (_name, copy) => {
    expect(copy).not.toMatch(PROHIBITED_APPLAUSE);
    // It affirms the real basis: participation-weighted attention.
    expect(copy.toLowerCase()).toContain('participation-weighted attention');
  });
});

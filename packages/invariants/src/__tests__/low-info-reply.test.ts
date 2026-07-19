// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Conservative low-info-reply classifier tests (WS-G / §5.3).  The mandate
// is to ERR TOWARD NOT CLASSIFYING: terse-but-real answers, questions, and
// anything cited are never low-info.
import { describe, expect, it } from 'vitest';
import { classifyLowInfoReplyV0 } from '../pwatt/low-info-reply.js';

describe('classifyLowInfoReplyV0 (WS-G, §5.3)', () => {
  it.each(['+1', 'this', 'lol', 'same', 'first', 'ok', '👍', '!!!', 'agreed', '+1 same'])(
    'classifies bare acknowledgment %j',
    (body) => {
      expect(classifyLowInfoReplyV0(body, false)).toBe(true);
    },
  );

  it('does not classify mixed tokens outside the lexicon ("nice one")', () => {
    // "one" is outside the closed lexicon — the conservative mandate says
    // don't classify when ANY token is unrecognized.
    expect(classifyLowInfoReplyV0('nice one', false)).toBe(false);
  });

  it.each([
    'June 3rd', // terse but a real answer
    'Yes — see table 3', // beyond length bound
    'why?', // a question
    'no?', // a question, however short
    'https://a.io', // carries a link
    '42 USC 1983', // tokens outside the lexicon
    'The report contradicts this claim because the sampling window differs.',
  ])('never classifies substantive text %j', (body) => {
    expect(classifyLowInfoReplyV0(body, false)).toBe(false);
  });

  it('never classifies a cited reply, whatever the body', () => {
    expect(classifyLowInfoReplyV0('+1', true)).toBe(false);
    expect(classifyLowInfoReplyV0('this', true)).toBe(false);
  });

  it('is total on hostile input', () => {
    expect(() => classifyLowInfoReplyV0('\x00'.repeat(10), false)).not.toThrow();
    expect(() => classifyLowInfoReplyV0('𝕊'.repeat(8), false)).not.toThrow();
  });

  it('property: classification implies (short ∧ uncited)', () => {
    const samples = ['+1', 'ok', 'a'.repeat(20), 'why not?', 'lol', 'June', 'totally agreed'];
    for (const body of samples) {
      for (const cited of [true, false]) {
        if (classifyLowInfoReplyV0(body, cited)) {
          expect(cited).toBe(false);
          expect(body.trim().length).toBeLessThanOrEqual(15);
        }
      }
    }
  });
});

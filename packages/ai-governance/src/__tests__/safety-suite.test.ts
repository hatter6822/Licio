// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-K.1.2c — safety/privacy suite. PII non-exposure, harmful-content,
// data-minimization, and sensitive-topic-disclaimer categories each fail when
// violated and the suite blocks on any failure.
import { describe, expect, it } from 'vitest';
import { containsHarmfulContent, detectPii, runSafetySuite } from '../index.js';

describe('WS-K.1.2c detectPii', () => {
  it('detects email, wallet, and phone', () => {
    expect(detectPii('reach me at jane.doe@example.com').some((f) => f.kind === 'email')).toBe(
      true,
    );
    expect(
      detectPii('wallet 0x1234567890abcdef1234567890abcdef12345678').some(
        (f) => f.kind === 'wallet',
      ),
    ).toBe(true);
    expect(detectPii('call +1 (415) 555-2671 today').some((f) => f.kind === 'phone')).toBe(true);
  });
  it('detects an injected private value', () => {
    const findings = detectPii('the user lives at 12 Birch Lane', ['12 Birch Lane']);
    expect(findings.some((f) => f.kind === 'value')).toBe(true);
  });
  it('returns nothing for clean text', () => {
    expect(detectPii('a perfectly ordinary summary sentence')).toEqual([]);
  });
  it('stays linear on a long no-@ run (bounded email regex; ReDoS-safe)', () => {
    // A long run of email-class chars with no '@' is the polynomial-ReDoS input;
    // bounded quantifiers keep it linear. Assert it returns fast with no email.
    const adversarial = `${'%'.repeat(50_000)} no at sign here`;
    const start = Date.now();
    const findings = detectPii(adversarial);
    expect(Date.now() - start).toBeLessThan(1_000);
    expect(findings.some((f) => f.kind === 'email')).toBe(false);
  });
});

describe('WS-K.1.2c containsHarmfulContent', () => {
  it('flags built-in threats', () => {
    expect(containsHarmfulContent('you should kill yourself', [])).not.toBeNull();
  });
  it('flags a policy denylist term', () => {
    expect(containsHarmfulContent('you absolute moron', ['moron'])).toBe('moron');
  });
  it('passes clean content', () => {
    expect(containsHarmfulContent('a respectful disagreement', ['moron'])).toBeNull();
  });
});

describe('WS-K.1.2c runSafetySuite', () => {
  it('passes when every category is clean', () => {
    const result = runSafetySuite({
      cases: [
        { output_text: 'A neutral, well-formed summary.' },
        {
          output_text: 'Discussing depression with care. If you are struggling, seek help.',
          sensitive_topic: true,
        },
      ],
      harmful_term_denylist: ['slur1'],
      disclaimer_markers: ['seek help', 'support is available'],
    });
    expect(result.passed).toBe(true);
    expect(result.categories.every((c) => c.passed)).toBe(true);
  });

  it('fails private_data_exposure when PII leaks', () => {
    const result = runSafetySuite({
      cases: [{ output_text: 'contact: jane@example.com', forbidden_private_values: [] }],
      harmful_term_denylist: [],
      disclaimer_markers: [],
    });
    const cat = result.categories.find((c) => c.category === 'private_data_exposure');
    expect(cat?.passed).toBe(false);
    expect(result.passed).toBe(false);
  });

  it('fails data_minimization on cross-invocation leakage', () => {
    const result = runSafetySuite({
      cases: [
        {
          output_text: 'other user is bob_secret',
          forbidden_cross_invocation_values: ['bob_secret'],
        },
      ],
      harmful_term_denylist: [],
      disclaimer_markers: [],
    });
    expect(result.categories.find((c) => c.category === 'data_minimization')?.passed).toBe(false);
  });

  it('passes data_minimization when a forbidden value is empty/whitespace-only', () => {
    // An empty (or whitespace-only) needle must not false-positive on every
    // output — `''.includes('')` is always true — so guard against empty needles.
    const result = runSafetySuite({
      cases: [
        {
          output_text: 'A perfectly ordinary summary that leaks nothing.',
          forbidden_cross_invocation_values: ['', '   '],
        },
      ],
      harmful_term_denylist: [],
      disclaimer_markers: [],
    });
    expect(result.categories.find((c) => c.category === 'data_minimization')?.passed).toBe(true);
    expect(result.passed).toBe(true);
  });

  it('fails sensitive_topic_handling without a disclaimer', () => {
    const result = runSafetySuite({
      cases: [{ output_text: 'just do it, no caveats', sensitive_topic: true }],
      harmful_term_denylist: [],
      disclaimer_markers: ['seek help'],
    });
    expect(result.categories.find((c) => c.category === 'sensitive_topic_handling')?.passed).toBe(
      false,
    );
  });
});

// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-K.1.2d — red-team protocol. Coverage requires every category to meet the
// minimum case count; a critical finding always blocks; accepted (non-critical)
// risks are documented without blocking; red-team is required on initial deploy
// and major upgrades.
import { describe, expect, it } from 'vitest';
import { computeRedTeamResult, isMajorUpgrade, type RedTeamCategoryInput } from '../index.js';

const full = (criticalIn?: RedTeamCategoryInput['category']): RedTeamCategoryInput[] =>
  (['adversarial_prompts', 'jailbreaks', 'bias_probing', 'edge_cases'] as const).map(
    (category) => ({
      category,
      test_count: 50,
      critical_findings: category === criticalIn ? 1 : 0,
    }),
  );

describe('WS-K.1.2d computeRedTeamResult', () => {
  it('passes with full coverage and no critical findings', () => {
    const result = computeRedTeamResult(full(), { minPerCategory: 50 });
    expect(result.passed).toBe(true);
    expect(result.critical_finding_count).toBe(0);
    expect(result.categories).toHaveLength(4);
  });

  it('fails when a category is below the minimum', () => {
    const inputs = full();
    inputs[0] = { category: 'adversarial_prompts', test_count: 10, critical_findings: 0 };
    expect(computeRedTeamResult(inputs, { minPerCategory: 50 }).passed).toBe(false);
  });

  it('fails when a category is missing entirely', () => {
    const partial: RedTeamCategoryInput[] = [
      { category: 'adversarial_prompts', test_count: 50, critical_findings: 0 },
    ];
    const result = computeRedTeamResult(partial, { minPerCategory: 50 });
    expect(result.passed).toBe(false);
    expect(result.categories).toHaveLength(4); // normalized to all four
  });

  it('a critical finding always blocks, even with accepted risks', () => {
    const result = computeRedTeamResult(full('jailbreaks'), {
      minPerCategory: 50,
      acceptedRisks: ['minor edge-case verbosity'],
    });
    expect(result.passed).toBe(false);
    expect(result.critical_finding_count).toBe(1);
    expect(result.accepted_with_documentation).toBe(true);
  });
});

describe('WS-K.1.2d isMajorUpgrade', () => {
  it('is true for an initial deployment', () => {
    expect(isMajorUpgrade(null, '1.0.0')).toBe(true);
  });
  it('is true for a major bump', () => {
    expect(isMajorUpgrade('1.4.2', '2.0.0')).toBe(true);
  });
  it('is false for a minor or patch bump', () => {
    expect(isMajorUpgrade('1.0.0', '1.1.0')).toBe(false);
    expect(isMajorUpgrade('1.0.0', '1.0.1')).toBe(false);
  });
  it('fails closed (true) for an unparseable version', () => {
    expect(isMajorUpgrade('not-a-version', '1.0.0')).toBe(true);
  });
});

// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-I.2.1b — the schema-level financial denylist. Every WS-I.2.1b
// acceptance criterion is asserted here: per-pattern rejection, nested and
// camelCase prefixed forms, typed errors carrying field/pattern/version,
// clean records accepted, and the audit helper for WS-I.3.1g.

import { FINANCIAL_FIELD_COMPOUNDS, FINANCIAL_FIELD_SEGMENTS } from '@licio/shared';
import { describe, expect, it } from 'vitest';
import denylistArtifact from '../denylist.config.json';
import {
  assertNoDeniedFields,
  auditFeatureFieldNames,
  DeniedFinancialFieldError,
  findDeniedFields,
  matchedFinancialPattern,
  RANKING_DENYLIST_PATTERNS,
  RANKING_DENYLIST_VERSION,
} from '../denylist.js';

describe('WS-I.2.1b denylist matcher', () => {
  it.each([
    'wallet_balance',
    'token_holdings',
    'payment_amount',
    'treasury_share',
    'donor_status',
    'follower_count',
    'balance_usd',
    'stake_weight',
    'vote_weight',
    'membership_tier',
    'subscription_amount_usd',
  ])('denies the WS-I plan pattern family: %s', (field) => {
    expect(matchedFinancialPattern(field)).not.toBeNull();
  });

  it('matches nested/prefixed snake_case and camelCase forms', () => {
    expect(matchedFinancialPattern('user_wallet_address')).toBe('wallet');
    expect(matchedFinancialPattern('paymentAmountUsd')).toBe('payment');
    expect(matchedFinancialPattern('roomTreasuryBalance')).not.toBeNull();
  });

  it('is segment-exact: benign words sharing letters are NOT denied', () => {
    expect(matchedFinancialPattern('feed_mode')).toBeNull();
    expect(matchedFinancialPattern('tokenized_text')).toBeNull();
    expect(matchedFinancialPattern('stakeholder_note')).toBeNull();
    expect(matchedFinancialPattern('freshness_decay')).toBeNull();
    expect(matchedFinancialPattern('active_attention')).toBeNull();
  });

  it('walks nested objects and array elements', () => {
    const findings = findDeniedFields({
      item_id: 'x',
      metadata: { user_wallet_address: '0xabc' },
      entries: [{ ok: 1 }, { donor_tier: 'gold' }],
    });
    expect(findings.map((f) => f.path).sort()).toEqual([
      'entries[1].donor_tier',
      'metadata.user_wallet_address',
    ]);
    expect(findings.every((f) => f.denylistVersion === RANKING_DENYLIST_VERSION)).toBe(true);
  });

  it('assertNoDeniedFields throws a typed error naming field, pattern, version', () => {
    try {
      assertNoDeniedFields({ payment_amount: 5 });
      expect.unreachable('must throw');
    } catch (error) {
      expect(error).toBeInstanceOf(DeniedFinancialFieldError);
      const denied = error as DeniedFinancialFieldError;
      expect(denied.findings[0]?.field).toBe('payment_amount');
      expect(denied.findings[0]?.matchedPattern).toBe('payment');
      expect(denied.denylistVersion).toBe(RANKING_DENYLIST_VERSION);
      expect(denied.message).toContain('payment_amount');
      expect(denied.message).toContain(`v${RANKING_DENYLIST_VERSION}`);
    }
  });

  it('accepts clean records (including cyclic ones, guarded)', () => {
    const clean: Record<string, unknown> = { item_id: 'a', topic_ids: ['x'] };
    clean['self'] = clean;
    expect(() => assertNoDeniedFields(clean)).not.toThrow();
  });

  it('auditFeatureFieldNames reports every offending name (WS-I.3.1g)', () => {
    const findings = auditFeatureFieldNames(['active_attention', 'wallet_balance', 'meri_rank']);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.field).toBe('wallet_balance');
    expect(auditFeatureFieldNames(['active_attention', 'meri_rank'])).toHaveLength(0);
  });

  it('exposes the versioned pattern list as data (snapshot against drift)', () => {
    expect(RANKING_DENYLIST_PATTERNS.length).toBeGreaterThanOrEqual(40);
    const patterns = RANKING_DENYLIST_PATTERNS.map((p) => p.pattern);
    for (const required of ['wallet', 'payment', 'treasury', 'donor', 'follower', 'stake']) {
      expect(patterns).toContain(required);
    }
    for (const compound of ['vote_weight', 'membership_tier', 'subscription_amount']) {
      expect(patterns).toContain(compound);
    }
  });

  it('the versioned artifact is pinned to the WS-A.1.1 doctrine list (WS-I.2.1b)', () => {
    // denylist.config.json is the reviewable record; @licio/shared is the
    // executable source. The module-load assertion throws on drift — this
    // test makes the pinning visible in CI output and pins the version so a
    // pattern change without a version bump fails review here.
    expect(denylistArtifact.version).toBe(2);
    expect(RANKING_DENYLIST_VERSION).toBe(denylistArtifact.version);
    expect([...denylistArtifact.segments].sort()).toEqual([...FINANCIAL_FIELD_SEGMENTS].sort());
    expect([...denylistArtifact.compounds].sort()).toEqual([...FINANCIAL_FIELD_COMPOUNDS].sort());
    // No duplicates inside the artifact itself.
    expect(new Set(denylistArtifact.segments).size).toBe(denylistArtifact.segments.length);
    expect(new Set(denylistArtifact.compounds).size).toBe(denylistArtifact.compounds.length);
  });
});

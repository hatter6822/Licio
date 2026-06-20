// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-R.0.8 — algorithm agility + downgrade protection.  Unknown/disabled algs
// fail closed; negotiation never selects a disabled/weaker suite because a peer
// omitted the stronger one; the hybrid-proof identifier is reserved.

import { describe, expect, it } from 'vitest';
import {
  isSuiteEnabled,
  negotiateSuite,
  RESERVED_HYBRID_ALG,
  resolveSuiteByAlg,
} from '../cose/suites.js';

describe('suite resolution (§10.3)', () => {
  it('resolves ES256 and fails closed otherwise', () => {
    const es256 = resolveSuiteByAlg(-7);
    expect(es256.ok).toBe(true);
    if (es256.ok) expect(es256.suite.id).toBe('ES256');

    const ed = resolveSuiteByAlg(-8);
    expect(ed).toEqual({ ok: false, reason: 'disabled_suite' }); // Ed25519 reserved/disabled
    expect(resolveSuiteByAlg(999)).toEqual({ ok: false, reason: 'unknown_alg' });
    expect(resolveSuiteByAlg(RESERVED_HYBRID_ALG)).toEqual({ ok: false, reason: 'unknown_alg' });
  });

  it('reports suite enablement', () => {
    expect(isSuiteEnabled('ES256')).toBe(true);
    expect(isSuiteEnabled('Ed25519')).toBe(false);
  });
});

describe('downgrade-resistant negotiation (§10.3)', () => {
  it('selects the strongest mutually-supported ENABLED suite', () => {
    const both = negotiateSuite(['ES256', 'Ed25519']);
    expect(both.ok).toBe(true);
    // Ed25519 is disabled, so the only enabled common suite is ES256 — never a
    // downgrade below the enabled floor.
    if (both.ok) expect(both.suite.id).toBe('ES256');

    const onlyEs = negotiateSuite(['ES256']);
    expect(onlyEs.ok).toBe(true);
  });

  it('fails closed when there is no common enabled suite', () => {
    expect(negotiateSuite(['Ed25519'])).toEqual({ ok: false, reason: 'no_common_suite' });
    expect(negotiateSuite([])).toEqual({ ok: false, reason: 'no_common_suite' });
  });

  it('reserves a distinct hybrid-proof algorithm id (§10.4)', () => {
    expect(RESERVED_HYBRID_ALG).not.toBe(-7);
    expect(RESERVED_HYBRID_ALG).not.toBe(-8);
  });
});

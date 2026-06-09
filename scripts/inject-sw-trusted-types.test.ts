// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { TRUSTED_TYPES_POLICY, withTrustedTypesPolicy } from './inject-sw-trusted-types.js';

describe('withTrustedTypesPolicy', () => {
  it('prepends the default policy to a worker without one', () => {
    const out = withTrustedTypesPolicy('importScripts("workbox.js");');
    expect(out.startsWith(TRUSTED_TYPES_POLICY)).toBe(true);
    expect(out).toContain('importScripts("workbox.js");');
  });

  it('is idempotent (does not double-prepend)', () => {
    const once = withTrustedTypesPolicy('self.foo();');
    expect(withTrustedTypesPolicy(once)).toBe(once);
  });

  it('only vouchsafes same-origin script URLs (cross-origin throws)', () => {
    // The policy guards cross-origin importScripts even though script-src already does.
    expect(TRUSTED_TYPES_POLICY).toContain('cross-origin script blocked');
    expect(TRUSTED_TYPES_POLICY).toContain("createPolicy('default'");
    // No eval / new Function introduced by the policy.
    expect(/eval\(|new Function/.test(TRUSTED_TYPES_POLICY)).toBe(false);
  });
});

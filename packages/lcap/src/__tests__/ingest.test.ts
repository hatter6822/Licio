// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Idempotent ingestion pre-gate (§16.9, §16.11, WS-R.6.5): acceptance keys on
// record_cid; a re-submit yields already_have; a device-sequence conflict is a
// fork (never hidden behind already_have).

import { describe, expect, it } from 'vitest';
import { acceptanceKey, classifyResubmission } from '../sync/index.js';

describe('idempotent ingestion pre-gate (§16.9, §16.11)', () => {
  it('keys acceptance by record_cid', () => {
    expect(acceptanceKey('lcapr_abc')).toBe('lcapr_abc');
  });

  it('returns already_have for an identical re-submit', () => {
    expect(classifyResubmission({ alreadyHave: true, deviceSeqConflict: false })).toBe(
      'already_have',
    );
  });

  it('returns conflict_device_fork for a sequence conflict, over a duplicate', () => {
    expect(classifyResubmission({ alreadyHave: true, deviceSeqConflict: true })).toBe(
      'conflict_device_fork',
    );
    expect(classifyResubmission({ alreadyHave: false, deviceSeqConflict: true })).toBe(
      'conflict_device_fork',
    );
  });

  it('returns undefined to proceed when neither applies', () => {
    expect(classifyResubmission({ alreadyHave: false, deviceSeqConflict: false })).toBeUndefined();
  });
});

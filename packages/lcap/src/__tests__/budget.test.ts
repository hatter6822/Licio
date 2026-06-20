// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Exchange budgets (§16.5, WS-R.6.2): shrinking is monotonic, each constraint
// tightens a subset of fields, and minimal mode collapses to C0 + smallest T1.

import { describe, expect, it } from 'vitest';
import { DEFAULT_BUDGET, minimalBudget, shrinkBudget } from '../sync/index.js';

const SCALAR_FIELDS = [
  'max_request_bytes',
  'max_response_bytes',
  'max_pack_table_entries',
  'max_frame_bytes',
  'max_uncompressed_bytes',
  'max_records',
  'max_proofs',
  'max_blocks',
] as const;

describe('shrinkBudget (§16.5)', () => {
  it('is monotonic — never grows a field', () => {
    const shrunk = shrinkBudget(DEFAULT_BUDGET, {
      batterySaver: true,
      meteredConnection: true,
      lowStorage: true,
      memoryPressure: true,
    });
    for (const key of SCALAR_FIELDS) expect(shrunk[key]).toBeLessThanOrEqual(DEFAULT_BUDGET[key]);
  });

  it('battery saver disallows media and sets the flag', () => {
    const b = shrinkBudget(DEFAULT_BUDGET, { batterySaver: true });
    expect(b.allow_media).toBe(false);
    expect(b.battery_saver).toBe(true);
    expect(b.max_response_bytes).toBeLessThan(DEFAULT_BUDGET.max_response_bytes);
  });

  it('metered connection shrinks request + response and sets the flag', () => {
    const b = shrinkBudget(DEFAULT_BUDGET, { meteredConnection: true });
    expect(b.metered_connection).toBe(true);
    expect(b.max_request_bytes).toBeLessThan(DEFAULT_BUDGET.max_request_bytes);
    expect(b.allow_media).toBe(false);
  });

  it('low storage shrinks blocks and records', () => {
    const b = shrinkBudget(DEFAULT_BUDGET, { lowStorage: true });
    expect(b.max_blocks).toBeLessThan(DEFAULT_BUDGET.max_blocks);
    expect(b.max_records).toBeLessThan(DEFAULT_BUDGET.max_records);
  });

  it('memory pressure shrinks uncompressed + frame caps', () => {
    const b = shrinkBudget(DEFAULT_BUDGET, { memoryPressure: true });
    expect(b.max_uncompressed_bytes).toBeLessThan(DEFAULT_BUDGET.max_uncompressed_bytes);
    expect(b.max_frame_bytes).toBeLessThan(DEFAULT_BUDGET.max_frame_bytes);
  });

  it('minimal mode reduces to C0 + smallest T1', () => {
    const b = shrinkBudget(DEFAULT_BUDGET, { minimal: true });
    expect(b.minimal_mode).toBe(true);
    expect(b.priority_floor).toBe(1);
    expect(b.allow_evidence).toBe(false);
    expect(b.allow_media).toBe(false);
    expect(b.max_blocks).toBeLessThanOrEqual(1);
  });

  it('high-risk privacy collapses to minimal', () => {
    const b = shrinkBudget(DEFAULT_BUDGET, { highRiskPrivacy: true });
    expect(b.minimal_mode).toBe(true);
    expect(b.priority_floor).toBe(1);
  });

  it('never raises an already-tight priority floor', () => {
    const tight = { ...DEFAULT_BUDGET, priority_floor: 0 as const };
    expect(minimalBudget(tight).priority_floor).toBe(0);
  });
});

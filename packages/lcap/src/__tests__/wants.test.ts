// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Wants + range/resume (§16.8, §16.10, WS-R.6.4): a want's reason drives its
// priority; buildWant derives cid_kind from the CID and fails closed on a bad
// one; resumeFrom yields the next unverified range and undefined when complete.

import { beforeAll, describe, expect, it } from 'vitest';
import { cidFor } from '../cid/index.js';
import {
  buildResumeWant,
  buildWant,
  effectiveWantPriority,
  resumeFrom,
  wantPriority,
} from '../sync/index.js';

let blockCid: string;

beforeAll(async () => {
  blockCid = await cidFor('block', new TextEncoder().encode('block-1'));
});

describe('wantPriority (§15.1.1)', () => {
  it('maps trust/liveness gaps to control priority', () => {
    expect(wantPriority('revocation_gap')).toBe(0);
    expect(wantPriority('checkpoint_gap')).toBe(0);
  });

  it('maps content reasons to their lanes', () => {
    expect(wantPriority('missing_dependency')).toBe(1);
    expect(wantPriority('explicit_user_request')).toBe(1);
    expect(wantPriority('room_interest')).toBe(2);
    expect(wantPriority('resume_partial')).toBe(2);
    expect(wantPriority('scarce_replica')).toBe(3);
  });
});

describe('buildWant (§16.8)', () => {
  it('derives cid_kind from the CID and validates the range', () => {
    const w = buildWant({
      cid: blockCid,
      reason: 'resume_partial',
      range: { offset: 0, length: 10 },
    });
    expect(w.cid_kind).toBe('block');
    expect(w.range).toEqual({ offset: 0, length: 10 });
  });

  it('fails closed on a malformed CID', () => {
    expect(() => buildWant({ cid: 'not-a-cid', reason: 'explicit_user_request' })).toThrow();
  });

  it('honors a priority override', () => {
    const w = buildWant({ cid: blockCid, reason: 'scarce_replica', priorityOverride: 0 });
    expect(effectiveWantPriority(w)).toBe(0);
  });

  it('uses the reason priority when no override is given', () => {
    const w = buildWant({ cid: blockCid, reason: 'scarce_replica' });
    expect(effectiveWantPriority(w)).toBe(3);
  });
});

describe('resumeFrom (§16.10)', () => {
  it('returns the next chunk-sized range', () => {
    expect(resumeFrom(0, 100, 40)).toEqual({ offset: 0, length: 40 });
    expect(resumeFrom(40, 100, 40)).toEqual({ offset: 40, length: 40 });
    expect(resumeFrom(80, 100, 40)).toEqual({ offset: 80, length: 20 });
  });

  it('returns undefined when the transfer is complete', () => {
    expect(resumeFrom(100, 100, 40)).toBeUndefined();
  });

  it('rejects a non-positive chunk size', () => {
    expect(() => resumeFrom(0, 100, 0)).toThrow(RangeError);
  });

  it('builds a resume want until complete', () => {
    expect(buildResumeWant(blockCid, 0, 100, 40)?.reason).toBe('resume_partial');
    expect(buildResumeWant(blockCid, 100, 100, 40)).toBeUndefined();
  });
});

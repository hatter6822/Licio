// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-R.14.1a — the §27.1 caps enforced at the server parse (commitBatch): the
// quarantine-byte cap bounds a missing-dependency flood, and the CPU-time cap stops
// a slow import from pinning a worker.  Both surface `rejected_resource_limit` via
// the shared SSOT helper.  A static check asserts the server parse imports the SSOT.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { cidFor, clampCaps, type ValidationResult } from '@licio/lcap';
import { describe, expect, it } from 'vitest';
import { type CommitRecordInput, LcapIngestServer } from '../lcap/server-ingest.js';

const enc = new TextEncoder();
const NET = 'net';
const ROOM = 'room-1';
const accepted: ValidationResult = { state: 'authorized_provisional', missingCids: [], facts: {} };

/** The apps/api source root (resolves from the monorepo root OR the package dir). */
const apiSrcRoot =
  [resolve(process.cwd(), 'apps/api/src'), resolve(process.cwd(), 'src')].find((p) => {
    try {
      readFileSync(resolve(p, 'lcap/server-ingest.ts'));
      return true;
    } catch {
      return false;
    }
  }) ?? resolve(process.cwd(), 'src');

async function recordInput(
  tag: string,
  requires: readonly string[] = [],
): Promise<CommitRecordInput> {
  const body = enc.encode(tag);
  return {
    recordCid: await cidFor('record', body),
    roomId: ROOM,
    authorDeviceKeyId: `device-${tag}`,
    deviceSeq: 0,
    body,
    validation: accepted,
    requires,
  };
}

describe('§27.1 quarantine-byte cap (commitBatch)', () => {
  it('quarantines up to the cap then rejects the overflow with rejected_resource_limit', async () => {
    const absentDep = await cidFor('record', enc.encode('absent-dependency'));
    // Two equal-length bodies that both quarantine (missing dep); the cap admits one.
    const a = await recordInput('qr-aaaaaaaa', [absentDep]); // 11 bytes
    const b = await recordInput('qr-bbbbbbbb', [absentDep]); // 11 bytes
    const caps = clampCaps({ maxQuarantineBytes: a.body.length });
    const srv = new LcapIngestServer(NET, () => 1_000, undefined, caps);

    const res = await srv.commitBatch([a, b]);
    const statuses = res.statuses.map((s) => s.status).sort();
    expect(statuses).toEqual(['quarantined_missing_dependency', 'rejected_resource_limit']);
  });
});

describe('§27.1 import CPU-time cap (commitBatch)', () => {
  it('stops processing and rejects the remainder when the batch runs past the cap', async () => {
    // A clock that reads 0 once (the batch start) then jumps far past the cap.
    let calls = 0;
    const clock = (): number => (calls++ === 0 ? 0 : 10_000);
    const caps = clampCaps({ maxCpuTimeMsPerImportBatch: 1 });
    const srv = new LcapIngestServer(NET, clock, undefined, caps);

    // Two otherwise-committable records; the CPU guard trips before either commits.
    const res = await srv.commitBatch([await recordInput('cpu-a'), await recordInput('cpu-b')]);
    expect(res.statuses.every((s) => s.status === 'rejected_resource_limit')).toBe(true);
    expect(await srv.roomSize(ROOM)).toBe(0); // nothing was committed under the trip
  });

  it('commits normally when the batch stays within the CPU cap', async () => {
    const srv = new LcapIngestServer(NET, () => 1_000); // a constant clock → 0 elapsed
    const res = await srv.commitBatch([await recordInput('ok-a'), await recordInput('ok-b')]);
    expect(res.statuses.every((s) => s.status === 'accepted')).toBe(true);
    expect(await srv.roomSize(ROOM)).toBe(2);
  });
});

describe('§27.1 signed-body record-ref fan-out bound (recordRefsWithinCap)', () => {
  // The §29 commit path checks this O(1) bound BEFORE materializing a contribution's signed-body
  // record refs into its `requires` set.  `parent_record_cids` carries no schema `.max()`, so without
  // the early bound an unbounded array would build a large Set + spread it into the commit input
  // before `commitBatch`'s §27.2 graph guard (the backstop) rejects the fan-out — a §27 CPU/memory DoS.
  const parents = (n: number): string[] => Array.from({ length: n }, (_, i) => `parent-${i}`);
  const srv = new LcapIngestServer(NET, () => 1_000);

  it('accepts a contribution AT the fan-out cap (64 signed-body record refs)', () => {
    expect(srv.recordRefsWithinCap({ parent_record_cids: parents(64) })).toBe(true);
  });

  it('rejects a contribution ONE OVER the cap (65 parents) — counted O(1) via .length', () => {
    expect(srv.recordRefsWithinCap({ parent_record_cids: parents(65) })).toBe(false);
  });

  it('counts the singular refs together with the parents', () => {
    // prev + replaces + target (3 singulars) + 62 parents = 65 > 64 → over the cap.
    expect(
      srv.recordRefsWithinCap({
        prev_device_record_cid: 'p',
        replaces_record_cid: 'r',
        target_record_cid: 't',
        parent_record_cids: parents(62),
      }),
    ).toBe(false);
    // …the same 3 singulars + 61 parents = 64 → within the cap.
    expect(
      srv.recordRefsWithinCap({
        prev_device_record_cid: 'p',
        replaces_record_cid: 'r',
        target_record_cid: 't',
        parent_record_cids: parents(61),
      }),
    ).toBe(true);
  });

  it('uses the SERVER caps PROFILE (not the static default) — a tighter profile bounds tighter', () => {
    const tight = new LcapIngestServer(NET, () => 1_000, undefined, clampCaps({ maxFanOut: 40 }));
    expect(tight.recordRefsWithinCap({ parent_record_cids: parents(40) })).toBe(true);
    expect(tight.recordRefsWithinCap({ parent_record_cids: parents(41) })).toBe(false);
  });
});

describe('static check: the server parse imports the §27.1 caps SSOT', () => {
  it('references the shared caps + helper in server-ingest.ts', () => {
    const src = readFileSync(resolve(apiSrcRoot, 'lcap/server-ingest.ts'), 'utf8');
    expect(src).toContain('checkCap');
    expect(src).toContain('SERVER_CAPS');
    expect(src).toContain('graphLimitsFromCaps');
  });

  it('§29 commit bounds the signed-body record refs BEFORE building the requires set', () => {
    // The DoS fix is an EARLY (O(1)) rejection; commitBatch's graph guard yields the same status as a
    // backstop, so only the ORDER (guard before the Set) proves the wasted-work avoidance.
    const src = readFileSync(resolve(apiSrcRoot, 'lcap/routes.ts'), 'utf8');
    const guardIdx = src.indexOf('server.recordRefsWithinCap(record)');
    const requiresIdx = src.indexOf('const requires = new Set<string>()');
    expect(guardIdx).toBeGreaterThan(-1);
    expect(requiresIdx).toBeGreaterThan(-1);
    expect(guardIdx).toBeLessThan(requiresIdx);
  });
});

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

describe('static check: the server parse imports the §27.1 caps SSOT', () => {
  it('references the shared caps + helper in server-ingest.ts', () => {
    const srcRoot =
      [resolve(process.cwd(), 'apps/api/src'), resolve(process.cwd(), 'src')].find((p) => {
        try {
          readFileSync(resolve(p, 'lcap/server-ingest.ts'));
          return true;
        } catch {
          return false;
        }
      }) ?? resolve(process.cwd(), 'src');
    const src = readFileSync(resolve(srcRoot, 'lcap/server-ingest.ts'), 'utf8');
    expect(src).toContain('checkCap');
    expect(src).toContain('SERVER_CAPS');
    expect(src).toContain('graphLimitsFromCaps');
  });
});

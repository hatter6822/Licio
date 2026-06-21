// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The §27.1 resource-cap SSOT (WS-R.14.1a): one frozen config, profile tuning that
// can never disable or exceed the ceiling, the single enforcement helper, and the
// static assertion that every parser path sources its limits from here (no
// hard-coded limit drifts out of the SSOT).

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_DECOMPRESS_LIMITS } from '../block/compression.js';
import {
  type CapName,
  capsForProfile,
  checkCap,
  clampCaps,
  enforceCap,
  OLD_PHONE_CAPS,
  type ResourceCaps,
  ResourceLimitError,
  SERVER_CAPS,
} from '../limits/caps.js';
import { DEFAULT_GRAPH_LIMITS } from '../limits/graph-guard.js';
import { DEFAULT_READER_CAPS } from '../pack/reader.js';

const CAP_NAMES = Object.keys(SERVER_CAPS) as CapName[];

describe('SERVER_CAPS / OLD_PHONE_CAPS profiles', () => {
  it('freezes the server ceiling (every cap positive + finite)', () => {
    expect(Object.isFrozen(SERVER_CAPS)).toBe(true);
    for (const k of CAP_NAMES) {
      expect(Number.isFinite(SERVER_CAPS[k])).toBe(true);
      expect(SERVER_CAPS[k]).toBeGreaterThan(0);
    }
  });

  it('keeps the old-phone profile ≤ the server ceiling in every dimension', () => {
    expect(Object.isFrozen(OLD_PHONE_CAPS)).toBe(true);
    for (const k of CAP_NAMES) {
      expect(OLD_PHONE_CAPS[k]).toBeLessThanOrEqual(SERVER_CAPS[k]);
      expect(OLD_PHONE_CAPS[k]).toBeGreaterThan(0);
    }
  });

  it('resolves the named profiles', () => {
    expect(capsForProfile('server')).toBe(SERVER_CAPS);
    expect(capsForProfile('old_phone')).toBe(OLD_PHONE_CAPS);
  });
});

describe('clampCaps — tunable but never disable-able / never unlimited', () => {
  it('tunes a cap DOWN', () => {
    expect(clampCaps({ maxPackBytes: 1024 }).maxPackBytes).toBe(1024);
  });

  it('never raises a cap above the ceiling', () => {
    expect(clampCaps({ maxPackBytes: SERVER_CAPS.maxPackBytes * 10 }).maxPackBytes).toBe(
      SERVER_CAPS.maxPackBytes,
    );
  });

  it('collapses Infinity (unlimited) to the ceiling', () => {
    expect(clampCaps({ maxUncompressedBytes: Number.POSITIVE_INFINITY }).maxUncompressedBytes).toBe(
      SERVER_CAPS.maxUncompressedBytes,
    );
  });

  it('collapses 0 / negative (disable) to the floor of 1', () => {
    expect(clampCaps({ maxGraphNodes: 0 }).maxGraphNodes).toBe(1);
    expect(clampCaps({ maxFanOut: -5 }).maxFanOut).toBe(1);
  });

  it('fills omitted fields from the ceiling and floors to integers', () => {
    const c = clampCaps({ maxExpansionRatio: 12.9 });
    expect(c.maxExpansionRatio).toBe(12);
    expect(c.maxPackBytes).toBe(SERVER_CAPS.maxPackBytes); // unspecified → ceiling
    expect(Object.isFrozen(c)).toBe(true);
  });
});

describe('checkCap / enforceCap — the single enforcement helper', () => {
  it('passes at the boundary and fails just over it, naming the cap', () => {
    const caps: ResourceCaps = clampCaps({ maxFanOut: 4 });
    expect(checkCap(4, 'maxFanOut', caps)).toEqual({ ok: true });
    const breach = checkCap(5, 'maxFanOut', caps);
    expect(breach).toEqual({ ok: false, reason: 'rejected_resource_limit', cap: 'maxFanOut' });
  });

  it('throws ResourceLimitError (with the cap name) on breach', () => {
    try {
      enforceCap(SERVER_CAPS.maxPackBytes + 1, 'maxPackBytes', SERVER_CAPS);
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ResourceLimitError);
      expect((err as ResourceLimitError).cap).toBe('maxPackBytes');
      expect((err as ResourceLimitError).reason).toBe('rejected_resource_limit');
    }
    expect(() => enforceCap(0, 'maxPackBytes', SERVER_CAPS)).not.toThrow();
  });
});

describe('every parser path sources its limits from the SSOT (no drift)', () => {
  it('derives the reader / decompressor / graph-guard defaults from SERVER_CAPS', () => {
    expect(DEFAULT_READER_CAPS).toEqual({
      maxPackBytes: SERVER_CAPS.maxPackBytes,
      maxHeaderBytes: SERVER_CAPS.maxHeaderBytes,
      maxTableBytes: SERVER_CAPS.maxTableBytes,
      maxFrameHeaderBytes: SERVER_CAPS.maxFrameHeaderBytes,
      maxFramePayloadBytes: SERVER_CAPS.maxFramePayloadBytes,
      maxEntries: SERVER_CAPS.maxManifestEntries,
    });
    expect(DEFAULT_DECOMPRESS_LIMITS).toEqual({
      maxUncompressedBytes: SERVER_CAPS.maxUncompressedBytes,
      maxExpansionRatio: SERVER_CAPS.maxExpansionRatio,
    });
    expect(DEFAULT_GRAPH_LIMITS).toEqual({
      maxNodes: SERVER_CAPS.maxGraphNodes,
      maxFanOut: SERVER_CAPS.maxFanOut,
      maxDepth: SERVER_CAPS.maxDependencyDepth,
    });
  });

  it('static check: the reader / decompressor / graph-guard import the caps SSOT', () => {
    const srcRoot =
      [resolve(process.cwd(), 'packages/lcap/src'), resolve(process.cwd(), 'src')].find((p) =>
        existsSync(p),
      ) ?? resolve(process.cwd(), 'src');
    const importsCaps = (relPath: string): boolean =>
      /from ['"][./]*(?:limits\/)?caps\.js['"]/.test(
        readFileSync(resolve(srcRoot, relPath), 'utf8'),
      );
    expect(importsCaps('pack/reader.ts')).toBe(true);
    expect(importsCaps('block/compression.ts')).toBe(true);
    expect(importsCaps('limits/graph-guard.ts')).toBe(true);
  });
});

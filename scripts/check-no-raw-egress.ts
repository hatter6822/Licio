// SPDX-License-Identifier: AGPL-3.0-or-later
//
// No-raw-egress CI harness (WS-C.4.1d, SPEC §19.1–19.3). The privacy linchpin:
// raw scroll/touch/dwell traces are processed in-browser and DISCARDED — only the
// bucketed §22.1 AttentionAggregate may leave the device. `assertNoRawEgress` is
// the runtime half; this is the build-failing static half. It enforces, over the
// signal layer (apps/web/src/signals):
//   1. No network-egress primitive (fetch / XHR / WebSocket / EventSource /
//      sendBeacon) — every byte of attention data must go through the single
//      aggregate uploader, never a side channel.
//   2. The only BFF import is `uploadAttentionAggregates` (the bucketed egress).
//   3. The aggregate builder retains the `assertNoRawEgress` runtime guard.
//   4. The shared AttentionAggregate schema names no raw-trace field.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const SIGNAL_DIR = resolve(ROOT, 'apps/web/src/signals');
const AGGREGATE_FILE = resolve(SIGNAL_DIR, 'aggregate.ts');
const AGGREGATE_SCHEMA = resolve(ROOT, 'packages/shared/src/schemas/attention.ts');

// The LCAP offline data plane (WS-R.14.3): the same no-raw-egress doctrine — no raw
// attention trace and no network/location identifier may cross untrusted peers.
const LCAP_DIRS = [
  resolve(ROOT, 'packages/lcap/src'),
  resolve(ROOT, 'packages/lcap-p2p/src'),
  resolve(ROOT, 'apps/web/src/lcap'),
  resolve(ROOT, 'apps/api/src/lcap'),
  // The WS-R.15.4 native courier shell (no raw attention trace / network-address field
  // may ferry over radio either); the generated android/ build output is skipped below.
  resolve(ROOT, 'apps/courier'),
  // The WS-S Private P2P rooms plane (cross-plane doctrine §4) — no raw attention
  // trace / network-address field may appear in any private tree either.
  resolve(ROOT, 'packages/private-p2p/src'),
  resolve(ROOT, 'apps/web/src/private-p2p'),
];

// Directories never worth walking (deps + generated native/build output).
const SKIP_DIRS = new Set(['node_modules', 'build', '.gradle', 'dist']);

const TEST_FILE = /\.(?:test|spec)\.tsx?$/;

/** Network-egress primitives that must never appear in the signal layer. */
const EGRESS_PATTERNS: Array<{ pattern: RegExp; message: string }> = [
  {
    pattern: /\bfetch\s*\(/,
    message: 'direct fetch() — egress must go through the aggregate uploader',
  },
  { pattern: /\bXMLHttpRequest\b/, message: 'XMLHttpRequest in the signal layer' },
  { pattern: /\bnew\s+WebSocket\b/, message: 'WebSocket in the signal layer' },
  { pattern: /\bEventSource\b/, message: 'EventSource in the signal layer' },
  { pattern: /\bsendBeacon\b/, message: 'navigator.sendBeacon in the signal layer' },
];

/** The ONLY BFF export the signal layer may import (the bucketed egress). */
const ALLOWED_API_IMPORTS = new Set(['uploadAttentionAggregates']);

/** Raw-trace field tokens that must never be named in the aggregate schema. */
const FORBIDDEN_SCHEMA_TOKENS = [
  'scrollX',
  'scrollY',
  'scrollTop',
  'scrollLeft',
  'clientX',
  'clientY',
  'pageX',
  'pageY',
  'touches',
  'rawEvents',
  'scrollPositions',
  'dwellMs',
  'durationMs',
];

/**
 * Raw-trace + network/location field tokens that must never appear in LCAP source
 * (qualified forms — `ip_address`, not bare `ip` — avoid "content-addressed" hits).
 */
const LCAP_FORBIDDEN_TOKENS = [
  ...FORBIDDEN_SCHEMA_TOKENS,
  'ip_address',
  'ipAddress',
  'remote_addr',
  'remoteAddr',
  'remoteAddress',
  'x_forwarded',
  'geoip',
  'geolocation',
  'latitude',
  'longitude',
];

/** Strip block + line comments so doctrine prose can mention forbidden constructs. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

function collect(dir: string): string[] {
  const out: string[] = [];
  if (!statSync(dir, { throwIfNoEntry: false })?.isDirectory()) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory() && !SKIP_DIRS.has(entry.name)) out.push(...collect(full));
    else if (entry.isFile() && /\.tsx?$/.test(entry.name) && !TEST_FILE.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

/** Find egress + disallowed-api-import issues in one signal-layer file. Pure. */
export function findEgressIssues(filename: string, content: string): string[] {
  const code = stripComments(content);
  const issues: string[] = [];
  for (const { pattern, message } of EGRESS_PATTERNS) {
    if (pattern.test(code)) issues.push(`${filename}: ${message}`);
  }
  // Any import from the BFF client must import only the sanctioned bucketed egress.
  for (const match of code.matchAll(
    /import\s*\{([^}]*)\}\s*from\s*['"][^'"]*lib\/api[^'"]*['"]/g,
  )) {
    const named = (match[1] ?? '')
      .split(',')
      .map((part) => part.replace(/\btype\b/, '').trim())
      .filter(Boolean);
    for (const name of named) {
      if (!ALLOWED_API_IMPORTS.has(name)) {
        issues.push(
          `${filename}: signal layer imports "${name}" from the BFF client (only uploadAttentionAggregates is allowed)`,
        );
      }
    }
  }
  return issues;
}

/** Confirm the aggregate builder still invokes the runtime no-raw-egress guard. */
export function findGuardIssues(content: string): string[] {
  return stripComments(content).includes('assertNoRawEgress')
    ? []
    : ['aggregate.ts: the assertNoRawEgress runtime guard has been removed'];
}

/** Confirm the §22.1 aggregate schema names no raw-trace field. */
export function findSchemaIssues(content: string): string[] {
  const code = stripComments(content);
  const issues: string[] = [];
  for (const token of FORBIDDEN_SCHEMA_TOKENS) {
    if (new RegExp(`\\b${token}\\b`).test(code)) {
      issues.push(`attention.ts: aggregate schema names a raw-trace field "${token}"`);
    }
  }
  return issues;
}

/** Pure: raw-trace / network-location field violations in one LCAP source file. */
export function findLcapEgressIssues(filename: string, content: string): string[] {
  const code = stripComments(content);
  const issues: string[] = [];
  for (const token of LCAP_FORBIDDEN_TOKENS) {
    if (new RegExp(`\\b${token}\\b`).test(code)) {
      issues.push(`${filename}: LCAP source names a raw-trace/network-location field "${token}"`);
    }
  }
  return issues;
}

function main(): void {
  const errors: string[] = [];
  for (const file of collect(SIGNAL_DIR)) {
    errors.push(...findEgressIssues(file.replace(ROOT, ''), readFileSync(file, 'utf-8')));
  }
  errors.push(...findGuardIssues(readFileSync(AGGREGATE_FILE, 'utf-8')));
  errors.push(...findSchemaIssues(readFileSync(AGGREGATE_SCHEMA, 'utf-8')));

  // WS-R.14.3: the same doctrine over the LCAP offline data plane.
  for (const dir of LCAP_DIRS) {
    for (const file of collect(dir)) {
      errors.push(...findLcapEgressIssues(file.replace(ROOT, ''), readFileSync(file, 'utf-8')));
    }
  }

  if (errors.length > 0) {
    console.error('No-raw-egress harness FAILED — attention privacy violation(s):');
    for (const error of errors) console.error(`  - ${error}`);
    process.exit(1);
  }
  console.log('No-raw-egress harness passed: only the bucketed aggregate leaves the device.');
}

// Run as a script, but stay importable by the unit test.
if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  main();
}

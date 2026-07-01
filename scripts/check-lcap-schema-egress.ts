// SPDX-License-Identifier: AGPL-3.0-or-later
//
// LCAP doctrine schema gate (OFFLINE_SPEC §3.7, §36, WS-R.14.3). The offline data
// plane carries content-addressed records/proofs/receipts across untrusted peers;
// it MUST never encode an identifier-bearing network/location field nor a popularity
// (applause) field. This gate enumerates the LCAP schema surface
// (`packages/lcap/src/schemas`) and fails the build if any record/proof/receipt
// schema names a forbidden field — the LCAP analogue of the §22.1 aggregate
// no-raw-egress assertion + the no-applause static gate. Comments are stripped so
// doctrine may be discussed in prose while a real field still fails the scan.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
// The LCAP schema surface (`@licio/lcap` schemas) + the optional-transport plane
// (`@licio/lcap-p2p`, whose server-blind signaling envelope MUST carry no IP/location
// field — the §19.1 server-blindness depends on it).
const SCHEMA_DIRS = [
  resolve(ROOT, 'packages/lcap/src/schemas'),
  resolve(ROOT, 'packages/lcap-p2p/src'),
  // The WS-R.15.4 native courier shell: no radio/peer/IP identifier may enter any LCAP
  // schema the courier defines (radio metadata is a live-connection property only,
  // §26.4); the generated android/ build output is skipped by SKIP_DIRS below.
  resolve(ROOT, 'apps/courier'),
  // The WS-S Private P2P SCHEMA surface (PRIV-EGRESS-PARITY): the private plane's unlinkability
  // is the crown jewel, so its wire schemas get the FULL strong network/location denylist —
  // including `coordinates`, which the broad check-no-raw-egress scan cannot enforce over the
  // private CRYPTO trees (EC-key "coordinates").  Scoped to `schemas/` (no EC-key code lives
  // there), so the strong list applies exactly where a geolocation field would ever appear.
  resolve(ROOT, 'packages/private-p2p/src/schemas'),
];
const TEST_FILE = /\.(?:test|spec)\.tsx?$/;

// Directories never worth walking (deps, test trees, generated native/build output).
const SKIP_DIRS = new Set(['node_modules', '__tests__', 'build', '.gradle', 'dist']);

// The Capacitor `cap sync` copies the WEB build (apps/web/dist) into the courier's
// `assets/public` — gitignored, generated, and a redundant copy of `apps/web` (scanned at
// source), so a local run after a courier build must not re-scan it (it carries the web app's
// `durationMs` Web-Vitals field, forbidden only in the LCAP plane, not the web app).
const SKIP_PATHS = new Set([resolve(ROOT, 'apps/courier/android/app/src/main/assets/public')]);

/**
 * Forbidden field-name tokens. Each must never appear (outside comments) in an LCAP
 * schema: raw attention traces, network/location identifiers, and applause fields.
 * Tokens are matched at word boundaries; qualified forms (`ip_address`, not bare
 * `ip`) avoid false positives like "content-addressed".
 */
const FORBIDDEN_FIELD_TOKENS: ReadonlyArray<{ token: string; kind: string }> = [
  // Raw attention traces (§22.1 — only bucketed aggregates ever leave a device).
  ...[
    'scrollX',
    'scrollY',
    'scrollTop',
    'scrollLeft',
    'clientX',
    'clientY',
    'pageX',
    'pageY',
    'dwellMs',
    'durationMs',
    'rawEvents',
    'scrollPositions',
  ].map((token) => ({ token, kind: 'raw attention trace' })),
  // Network / location identifiers (§19.1 identity-free posture; no geolocation).
  ...[
    'ip_address',
    'ipAddress',
    'ipaddr',
    'remote_addr',
    'remoteAddr',
    'remote_address',
    'remoteAddress',
    'x_forwarded',
    'xForwarded',
    'geoip',
    'geolocation',
    'geo_location',
    'latitude',
    'longitude',
    'lat_lng',
    'coordinates',
  ].map((token) => ({ token, kind: 'network/location identifier' })),
  // Applause fields (§2.4, §5.1 — no likes/votes/karma/reactions/followers).
  ...[
    'like_count',
    'likeCount',
    'vote_count',
    'voteCount',
    'upvote',
    'upvotes',
    'downvote',
    'downvotes',
    'karma',
    'reaction_count',
    'reactionCount',
    'reactions',
    'follower_count',
    'followerCount',
    'followers',
    'score_count',
    'star_count',
  ].map((token) => ({ token, kind: 'applause field' })),
];

/** Strip block + line comments so doctrine prose may mention forbidden constructs. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

function collect(dir: string): string[] {
  const out: string[] = [];
  if (!statSync(dir, { throwIfNoEntry: false })?.isDirectory()) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory() && !SKIP_DIRS.has(entry.name) && !SKIP_PATHS.has(full)) {
      out.push(...collect(full));
    } else if (entry.isFile() && /\.ts$/.test(entry.name) && !TEST_FILE.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

/** Pure: the forbidden-field violations in one schema source (importable for tests). */
export function findSchemaEgressIssues(filename: string, content: string): string[] {
  const code = stripComments(content);
  const issues: string[] = [];
  for (const { token, kind } of FORBIDDEN_FIELD_TOKENS) {
    if (new RegExp(`\\b${token}\\b`).test(code)) {
      issues.push(`${filename}: LCAP schema names a forbidden ${kind} "${token}"`);
    }
  }
  return issues;
}

function main(): void {
  const files = SCHEMA_DIRS.flatMap((dir) => collect(dir));
  if (files.length === 0) {
    console.error(
      `check:lcap-schema-egress FAILED — no LCAP schema files found in ${SCHEMA_DIRS.join(', ')}`,
    );
    process.exit(1);
  }
  const errors: string[] = [];
  for (const file of files) {
    errors.push(...findSchemaEgressIssues(file.replace(ROOT, ''), readFileSync(file, 'utf-8')));
  }
  if (errors.length > 0) {
    console.error('check:lcap-schema-egress FAILED — LCAP doctrine violation(s):');
    for (const error of errors) console.error(`  - ${error}`);
    process.exit(1);
  }
  console.log(
    `check:lcap-schema-egress passed: ${files.length} LCAP schema files carry no network/location/attention/applause field.`,
  );
}

// Run as a script, but stay importable by the unit test.
if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  main();
}

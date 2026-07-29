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
//   2. The only edge into the BFF client (`apps/web/src/lib`) is a NAMED import
//      of `uploadAttentionAggregates` (the bucketed egress).  Read from the
//      parse, because a module edge has six spellings and a regex sees one.
//   3. The aggregate builder retains the `assertNoRawEgress` runtime guard.
//   4. The shared AttentionAggregate schema names no raw-trace field.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { SyntaxKind } from 'typescript/unstable/ast';
import { blankCommentsIn, blankParsedComments, blankSourceComments } from './gate-comments.js';
import { type Source, type Syntax, walk, withParsedSources } from './ts-source.js';

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
  // Its hand-written surface is Java + one `.mjs` build gate, so this tree holds no
  // TypeScript TODAY — it is configured so a future courier module is covered the day
  // it lands, and `collectOrFail` therefore asks whether the tree EXISTS, not whether
  // it produced files.
  resolve(ROOT, 'apps/courier'),
  // The WS-S Private P2P rooms plane (cross-plane doctrine §4) — no raw attention
  // trace / network-address field may appear in any private tree either.  The
  // server-blind rendezvous is BOTH halves: the route file and the module
  // directory behind it (service/stores/scheduler/mailbox).  It is precisely
  // where a network address would become a cross-bucket linking handle
  // (PRIV-API-RENDEZVOUS-1), so it is the tree that most needs the scan — and it
  // was outside every private-plane gate until this entry existed.
  resolve(ROOT, 'packages/private-p2p/src'),
  resolve(ROOT, 'apps/web/src/private-p2p'),
  resolve(ROOT, 'apps/api/src/private-rendezvous'),
  resolve(ROOT, 'apps/api/src/routes/private-rendezvous.ts'),
];

// Directories never worth walking (deps + generated native/build output).
const SKIP_DIRS = new Set(['node_modules', 'build', '.gradle', 'dist']);

// Specific generated/synced trees to skip by absolute path: the Capacitor `cap sync` copies
// the WEB build (apps/web/dist) into the courier's `assets/public` — gitignored, generated,
// and a redundant copy of `apps/web` (already scanned at source), so a local run after a
// courier build must not re-scan it (it legitimately carries the web app's `durationMs` Web-
// Vitals field, which is forbidden only in the LCAP/attention plane, not the web app).
const SKIP_PATHS = new Set([resolve(ROOT, 'apps/courier/android/app/src/main/assets/public')]);

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
  // These bring the private plane's network/location denylist up to check-lcap-schema-egress's
  // strength (that gate never scans the private trees; PRIV-EGRESS-PARITY).  `coordinates` is
  // DELIBERATELY excluded here: this gate scans the CRYPTO trees (packages/lcap/src/cose,
  // packages/private-p2p/src/crypto) where "coordinates" legitimately names an EC key's
  // x/y coordinates.  Geolocation field names are already covered by geo_location/lat_lng/
  // latitude/longitude above, and `coordinates` is enforced against the SCHEMA surfaces (which
  // carry no EC-key code) by check-lcap-schema-egress, whose SCHEMA_DIRS now include the private
  // schemas.
];

/** A source file this gate judges: `.ts`/`.tsx`, never a test. */
function isScannableSource(name: string): boolean {
  return /\.tsx?$/.test(name) && !TEST_FILE.test(name);
}

/**
 * Every source under `target`, which may be a DIRECTORY or a single FILE.
 *
 * The file form is load-bearing: the private-rendezvous plane is a module
 * directory PLUS a route file that sits outside it, and a configured entry that
 * silently returned nothing (the old directory-only early return) reduced the
 * gate's coverage without failing it.  `main` refuses an empty result for the
 * same reason.  Exported so the DISCOVERY layer is testable: a gate that walks
 * the wrong tree reports success over code it never read, and no scan predicate
 * can catch that.
 */
export function collect(target: string): string[] {
  const stat = statSync(target, { throwIfNoEntry: false });
  if (stat?.isFile()) return isScannableSource(basename(target)) ? [target] : [];
  const out: string[] = [];
  if (!stat?.isDirectory()) return out;
  for (const entry of readdirSync(target, { withFileTypes: true })) {
    const full = join(target, entry.name);
    if (entry.isDirectory() && !SKIP_DIRS.has(entry.name) && !SKIP_PATHS.has(full)) {
      out.push(...collect(full));
    } else if (entry.isFile() && isScannableSource(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

/**
 * The web BFF client surface: every module under `apps/web/src/lib`.
 *
 * Matched on a `lib/` PATH SEGMENT so every relative spelling reaches it
 * (`../lib/api.js`, `../../lib/telemetry.js`).  The predicate used to be the
 * substring `lib/api`, which saw only ONE of the client modules — `lib/wallet-api.js`,
 * `lib/governance-api.js` and `lib/telemetry.js` all perform network I/O and all
 * walked past it.  The whole directory is the BFF client, so the whole directory
 * is what doctrine #2 covers.
 */
const BFF_MODULE = /(?:^|\/)lib\//;

/** The specifier of a module edge, when it is a static string. */
function specifierOf(node: Syntax | undefined): string | undefined {
  if (node === undefined) return undefined;
  if (
    node.kind !== SyntaxKind.StringLiteral &&
    node.kind !== SyntaxKind.NoSubstitutionTemplateLiteral
  ) {
    return undefined;
  }
  return node.text;
}

/**
 * The disallowed BFF edges out of one signal-layer source, read from the PARSE.
 *
 * The braced-named-import REGEX this replaces could only see one of the six
 * spellings of a module edge, so `import * as api from '../lib/api.js'` and
 * `const { submitStory } = await import('../lib/api.js')` were reported CLEAN —
 * a fully unguarded path to every BFF endpoint out of the signal layer, since
 * the only other check here is a token scan for `fetch(`/`XMLHttpRequest`/….
 *
 * A NAMED import is the one form whose reach is statically bounded, so it keeps
 * the per-name allowlist.  Every other form — namespace, default, side-effect,
 * re-export, `import x = require(…)`, dynamic `import()` — hands the signal
 * layer a handle to the WHOLE module, and "which members of it does this handle
 * reach" is the unbounded question the sink gates already refuse to ask (see
 * `dangerous-code-patterns.ts`).  There is nothing to allowlist, so they are
 * flagged unconditionally.  `import type` / `export type` are erased at build
 * and stay permitted, matching check-lcap-p2p-split's carve-out.
 */
function findBffEdgeIssues(filename: string, root: Syntax): string[] {
  const issues: string[] = [];
  const whole = (form: string): void => {
    issues.push(
      `${filename}: signal layer takes a ${form} of the BFF client (only a named import of uploadAttentionAggregates is allowed)`,
    );
  };
  const named = (name: string): void => {
    if (ALLOWED_API_IMPORTS.has(name)) return;
    issues.push(
      `${filename}: signal layer imports "${name}" from the BFF client (only uploadAttentionAggregates is allowed)`,
    );
  };
  const eachName = (clause: Syntax | undefined, form: string): void => {
    for (const element of clause?.elements ?? []) {
      // `import { type X }` / `export { type X }` — erased, like the whole-clause form.
      if (element.isTypeOnly === true) continue;
      const name = (element.propertyName ?? element.name)?.text;
      if (name === undefined) whole(form);
      else named(name);
    }
  };

  for (const node of walk(root)) {
    if (node.kind === SyntaxKind.ImportDeclaration) {
      const specifier = specifierOf(node.moduleSpecifier);
      if (specifier === undefined || !BFF_MODULE.test(specifier)) continue;
      const clause = node.importClause;
      if (clause === undefined) {
        whole('side-effect import');
        continue;
      }
      if (clause.isTypeOnly === true) continue;
      if (clause.name !== undefined) whole('default import');
      const bindings = clause.namedBindings;
      if (bindings?.kind === SyntaxKind.NamespaceImport) whole('namespace import');
      else if (bindings?.kind === SyntaxKind.NamedImports) eachName(bindings, 'named import');
      continue;
    }
    if (node.kind === SyntaxKind.ExportDeclaration) {
      const specifier = specifierOf(node.moduleSpecifier);
      if (specifier === undefined || !BFF_MODULE.test(specifier)) continue;
      if (node.isTypeOnly === true) continue;
      const clause = node.exportClause;
      // `export * from '…'` has no clause at all; `export * as ns from '…'` binds
      // the whole module under a name.  Both republish everything.
      if (clause === undefined) whole('star re-export');
      else if (clause.kind === SyntaxKind.NamespaceExport) whole('namespace re-export');
      else eachName(clause, 'named re-export');
      continue;
    }
    if (node.kind === SyntaxKind.ImportEqualsDeclaration) {
      const specifier = specifierOf(node.moduleReference?.expression);
      if (specifier !== undefined && BFF_MODULE.test(specifier)) whole('require() import');
      continue;
    }
    if (
      node.kind === SyntaxKind.CallExpression &&
      node.expression?.kind === SyntaxKind.ImportKeyword
    ) {
      const specifier = specifierOf(node.arguments?.[0]);
      if (specifier !== undefined && BFF_MODULE.test(specifier)) whole('dynamic import');
    }
  }
  return issues;
}

/** Find egress + disallowed-api-import issues in one signal-layer file. Pure. */
export function findEgressIssues(filename: string, content: string): string[] {
  return findEgressIssuesIn([{ path: filename, content }]).get(filename) ?? [];
}

/** The same, over many signal-layer sources sharing ONE parse. */
export function findEgressIssuesIn(sources: readonly Source[]): Map<string, string[]> {
  return withParsedSources(sources, (parsed) => {
    const byPath = new Map<string, string[]>();
    for (const { path, content, root } of parsed) {
      const code = blankParsedComments(content, root);
      const issues: string[] = [];
      for (const { pattern, message } of EGRESS_PATTERNS) {
        if (pattern.test(code)) issues.push(`${path}: ${message}`);
      }
      issues.push(...findBffEdgeIssues(path, root));
      byPath.set(path, issues);
    }
    return byPath;
  });
}

/**
 * Confirm the aggregate builder still INVOKES the runtime no-raw-egress guard.
 *
 * Import lines are stripped first, and an actual call expression is required:
 * a bare "does the identifier appear" test is satisfied by the `import
 * { assertNoRawEgress }` line alone, so deleting the call while leaving the
 * import passed the check while the runtime guard no longer ran.  The guard is
 * the one defense that inspects the actual VALUE about to egress — the other
 * three checks are structural — so its invocation is what must be pinned.
 */
export function findGuardIssues(content: string): string[] {
  const code = blankSourceComments('aggregate.ts', content)
    // Drop import statements (single- and multi-line) so only real code remains.
    .replace(/^\s*import\s[\s\S]*?from\s*['"][^'"]*['"];?\s*$/gm, '');
  return /\bassertNoRawEgress\s*\(/.test(code)
    ? []
    : ['aggregate.ts: the assertNoRawEgress runtime guard is no longer invoked'];
}

/** Confirm the §22.1 aggregate schema names no raw-trace field. */
export function findSchemaIssues(content: string): string[] {
  const code = blankSourceComments('attention.ts', content);
  const issues: string[] = [];
  for (const token of FORBIDDEN_SCHEMA_TOKENS) {
    if (new RegExp(`\\b${token}\\b`).test(code)) {
      issues.push(`attention.ts: aggregate schema names a raw-trace field "${token}"`);
    }
  }
  return issues;
}

/** The forbidden-token violations `code` (comments already blanked) implies. */
function lcapIssuesIn(filename: string, code: string): string[] {
  const issues: string[] = [];
  for (const token of LCAP_FORBIDDEN_TOKENS) {
    if (new RegExp(`\\b${token}\\b`).test(code)) {
      issues.push(`${filename}: LCAP source names a raw-trace/network-location field "${token}"`);
    }
  }
  return issues;
}

/** Pure: raw-trace / network-location field violations in one LCAP source file. */
export function findLcapEgressIssues(filename: string, content: string): string[] {
  return lcapIssuesIn(filename, blankSourceComments(filename, content));
}

/** The same, over the whole LCAP + private plane sharing ONE parse. */
export function findLcapEgressIssuesIn(sources: readonly Source[]): Map<string, string[]> {
  const byPath = new Map<string, string[]>();
  for (const [path, code] of blankCommentsIn(sources)) {
    byPath.set(path, lcapIssuesIn(path, code));
  }
  return byPath;
}

/**
 * Every source under `target`, refusing a tree that is not THERE.
 *
 * A whole-tree gate that scans nothing reports success over code it never
 * judged, so a renamed or moved tree must fail loudly rather than quietly shrink
 * the gate's coverage — the discipline check:dead-exports already applies when a
 * tracked file falls outside every tsconfig.  Nothing in a scan predicate can
 * catch it: the predicate is never reached.
 *
 * EXISTENCE is the test, not "yielded at least one file", because those are
 * different questions and only the first is always an error: `apps/courier`'s
 * hand-written surface is Java plus one `.mjs` build gate, so it legitimately
 * holds no TypeScript today and is configured so a future courier module is
 * covered from the day it lands.  `SIGNAL_DIR` is held to BOTH in `main` — the
 * signal layer is never empty, and an empty scan of it is the whole gate gone.
 */
function collectOrFail(target: string): string[] {
  if (statSync(target, { throwIfNoEntry: false }) === undefined) {
    console.error(
      `No-raw-egress harness FAILED — configured tree does not exist: ${target.replace(ROOT, '')}`,
    );
    process.exit(1);
  }
  return collect(target);
}

const asSource = (file: string): Source => ({
  path: file.replace(ROOT, ''),
  content: readFileSync(file, 'utf-8'),
});

function main(): void {
  const errors: string[] = [];
  const signalSources = collectOrFail(SIGNAL_DIR).map(asSource);
  if (signalSources.length === 0) {
    console.error(`No-raw-egress harness FAILED — no signal-layer sources under ${SIGNAL_DIR}`);
    process.exit(1);
  }
  errors.push(...[...findEgressIssuesIn(signalSources).values()].flat());
  errors.push(...findGuardIssues(readFileSync(AGGREGATE_FILE, 'utf-8')));
  errors.push(...findSchemaIssues(readFileSync(AGGREGATE_SCHEMA, 'utf-8')));

  // WS-R.14.3: the same doctrine over the LCAP offline data plane — ONE parse
  // for every configured tree (a per-file parse opens a compiler host per file).
  const lcapSources = LCAP_DIRS.flatMap((dir) => collectOrFail(dir).map(asSource));
  errors.push(...[...findLcapEgressIssuesIn(lcapSources).values()].flat());

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

// SPDX-License-Identifier: AGPL-3.0-or-later
//
// LCAP doctrine schema gate (OFFLINE_SPEC §3.7, §36, WS-R.14.3). The offline data
// plane carries content-addressed records/proofs/receipts across untrusted peers;
// it MUST never encode an identifier-bearing network/location field nor a popularity
// (applause) field. This gate enumerates the LCAP schema surface
// (`packages/lcap/src/schemas`) and fails the build if any record/proof/receipt
// schema names a forbidden field — the LCAP analogue of the §22.1 aggregate
// no-raw-egress assertion + the no-applause static gate.
//
// A field is NAMED, so the names are read from the PARSE: identifiers, property
// keys, strings and template chunks.  Prose may discuss doctrine freely because
// a comment is not a node.
//
// That replaced two regexes that blanked comments with no idea what a string is
// — `'a // b'` lost its tail and a `/* */` inside one was blanked, either of
// which could HIDE a real field declared after it.  The search is otherwise
// deliberately as broad as it was: an identifier ANYWHERE still counts, because
// distinguishing a schema field from a local that happens to share its name is
// not something this gate tries to do, and erring wide is the safe direction.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { SyntaxKind } from 'typescript/unstable/ast';
import { type Source, type Syntax, walk, withParsedSources } from './ts-source.js';

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

/**
 * Pure: the forbidden-field violations in one schema source.
 *
 * Read from the PARSE.  Blanking comments with two regexes and then searching
 * the whole file for a word meant prose was stripped by something with no idea
 * what a string is (`'a // b'` lost its tail, a `/* *\/` inside a string was
 * blanked) — and then the search matched any occurrence anywhere, so an
 * unrelated local named `followers` read as a schema field.
 *
 * A field is NAMED by an identifier, a property key, or a string; those are
 * what is searched, so a comment cannot trip the gate and cannot hide a
 * violation either.
 */
/** Every word a source NAMES — in an identifier, a property key or a string. */
function namedWords(root: Syntax): Set<string> {
  const words = new Set<string>();
  for (const node of walk(root)) {
    // Every chunk of a template counts too: a field name can be spelled in one
    // (`\`prefix ipAddress ${x}\``), and reading only the hole-free form would
    // have LOST a case the whole-text search it replaces already covered.
    // A COMPOSED name is the name the schema actually declares.
    if (
      node.kind === SyntaxKind.TemplateExpression ||
      (node.kind === SyntaxKind.BinaryExpression &&
        node.operatorToken?.kind === SyntaxKind.PlusToken)
    ) {
      const folded = staticConcat(node);
      if (folded !== null) {
        for (const word of folded.split(/[^A-Za-z0-9_]+/)) {
          if (word !== '') words.add(word);
        }
      }
      continue;
    }
    if (
      node.kind !== SyntaxKind.Identifier &&
      node.kind !== SyntaxKind.PrivateIdentifier &&
      node.kind !== SyntaxKind.StringLiteral &&
      node.kind !== SyntaxKind.NoSubstitutionTemplateLiteral &&
      node.kind !== SyntaxKind.TemplateHead &&
      node.kind !== SyntaxKind.TemplateMiddle &&
      node.kind !== SyntaxKind.TemplateTail
    ) {
      continue;
    }
    for (const word of (node.text ?? node.getText()).split(/[^A-Za-z0-9_]+/)) {
      if (word !== '') words.add(word);
    }
  }
  return words;
}

/**
 * A string built from static pieces, folded.
 *
 * `['ip_' + 'address']` names the field `ip_address` at runtime, and splitting
 * each literal into words on its own recorded `ip_` and `address` — neither of
 * which is the forbidden token.  The concatenation is where the name actually
 * comes from, so it is folded before the words are taken.
 */
function kidsOf(node: Syntax): Syntax[] {
  const children: Syntax[] = [];
  node.forEachChild((child: Syntax) => {
    children.push(child);
  });
  return children;
}

function staticConcat(node: Syntax, hop = 0): string | null {
  if (hop > 16) return null;
  if (
    node.kind === SyntaxKind.StringLiteral ||
    node.kind === SyntaxKind.NoSubstitutionTemplateLiteral
  ) {
    return node.text ?? '';
  }
  if (node.kind === SyntaxKind.ParenthesizedExpression || node.kind === SyntaxKind.AsExpression) {
    return node.expression === undefined ? null : staticConcat(node.expression, hop + 1);
  }
  // A TEMPLATE whose holes are all static is the same composed name written a
  // second way: `` `ip_${'address'}` `` names `ip_address` exactly as
  // `'ip_' + 'address'` does.
  if (node.kind === SyntaxKind.TemplateExpression) {
    let text = node.head?.text ?? '';
    for (const span of kidsOf(node)) {
      if (span.kind !== SyntaxKind.TemplateSpan) continue;
      const parts = kidsOf(span);
      const hole = parts[0] === undefined ? null : staticConcat(parts[0], hop + 1);
      if (hole === null) return null;
      text += hole + (span.literal?.text ?? '');
    }
    return text;
  }
  if (
    node.kind === SyntaxKind.BinaryExpression &&
    node.operatorToken?.kind === SyntaxKind.PlusToken &&
    node.left !== undefined &&
    node.right !== undefined
  ) {
    const left = staticConcat(node.left, hop + 1);
    const right = staticConcat(node.right, hop + 1);
    return left === null || right === null ? null : left + right;
  }
  return null;
}

/** The forbidden-field violations a source's named words imply. */
function issuesFor(filename: string, named: ReadonlySet<string>): string[] {
  const issues: string[] = [];
  for (const { token, kind } of FORBIDDEN_FIELD_TOKENS) {
    if (named.has(token)) {
      issues.push(`${filename}: LCAP schema names a forbidden ${kind} "${token}"`);
    }
  }
  return issues;
}

/** Pure: the forbidden-field violations in one schema source. */
export function findSchemaEgressIssues(filename: string, content: string): readonly string[] {
  return findSchemaEgressIssuesIn([{ path: filename, content }]).get(filename) ?? [];
}

/** The same, over many sources sharing ONE parse. */
export function findSchemaEgressIssuesIn(
  sources: readonly Source[],
): Map<string, readonly string[]> {
  return withParsedSources(sources, (parsed) => {
    const byPath = new Map<string, readonly string[]>();
    for (const { path, root } of parsed) byPath.set(path, issuesFor(path, namedWords(root)));
    return byPath;
  });
}

function main(): void {
  const files = SCHEMA_DIRS.flatMap((dir) => collect(dir));
  if (files.length === 0) {
    console.error(
      `check:lcap-schema-egress FAILED — no LCAP schema files found in ${SCHEMA_DIRS.join(', ')}`,
    );
    process.exit(1);
  }
  // ONE parse for the whole schema surface.
  const found = findSchemaEgressIssuesIn(
    files.map((file) => ({ path: file.replace(ROOT, ''), content: readFileSync(file, 'utf-8') })),
  );
  const errors = [...found.values()].flat();
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

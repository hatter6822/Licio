// SPDX-License-Identifier: AGPL-3.0-or-later
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const LOCKFILE_PATH = resolve(ROOT, 'pnpm-lock.yaml');

const ALLOWED_HOSTS = new Set(['registry.npmjs.org']);

/**
 * Digest size, in bytes, of every SRI algorithm this gate accepts as coverage.
 *
 * SHA-1 and MD5 are deliberately absent: a lockfile pinned with a broken hash
 * is not integrity-covered, so it must not be counted as such.
 */
const DIGEST_BYTES = new Map<string, number>([
  ['sha256', 32],
  ['sha384', 48],
  ['sha512', 64],
]);

/**
 * A Subresource-Integrity value: an algorithm, then a BASE64 digest.
 *
 * Matched permissively on purpose — the digest is VALIDATED against the
 * declared algorithm in {@link isAlgorithmLengthDigest}, not by this pattern.
 * The trailing lookahead keeps an over-long digest from being accepted on the
 * strength of a prefix.
 */
const INTEGRITY_VALUE = /integrity:\s*(sha[0-9]+)-([A-Za-z0-9+/]*={0,2})(?![A-Za-z0-9+/=])/;

/**
 * True when the line carries a digest of exactly the length its own algorithm
 * produces.
 *
 * A single shared minimum length cannot express this: 40 base64 characters is
 * short of every one of the three (44 / 64 / 88 characters), so `sha512-` +
 * 40 `A`s — a digest a third of the required size, and one no SHA-512 could
 * ever have produced — satisfied it. The decoded byte count is the property
 * that actually matters, so it is the property checked.
 *
 * The round-trip pins the encoding as well as the size. Node's base64 decoder
 * is LENIENT: it skips characters outside the alphabet and tolerates
 * non-canonical padding bits, so `Buffer.from()` alone would silently accept a
 * malformed payload and report a plausible byte count for it. Re-encoding and
 * comparing rejects anything that is not the exact canonical encoding of those
 * bytes.
 */
function isAlgorithmLengthDigest(line: string): boolean {
  const match = INTEGRITY_VALUE.exec(line);
  if (!match) return false;

  const [, algorithm, encoded] = match;
  if (algorithm === undefined || encoded === undefined) return false;

  const expectedBytes = DIGEST_BYTES.get(algorithm);
  if (expectedBytes === undefined) return false;

  const decoded = Buffer.from(encoded, 'base64');
  if (decoded.toString('base64') !== encoded) return false;

  return decoded.byteLength === expectedBytes;
}

/** Entries sit at two spaces, so their own fields sit at four. */
const ENTRY_FIELD_INDENT = 4;

/**
 * How many `packages:` entries there are, and how many carry their OWN digest.
 *
 * Scoped by section rather than matched across the whole file: top-level keys
 * sit at column 0 and entries at two spaces, so the boundary is unambiguous,
 * and `snapshots:` — which repeats every package WITHOUT a resolution — cannot
 * inflate the denominator.
 *
 * Counted PER ENTRY, and only on the entry's own `resolution:` line.  Two
 * running totals compared at the end can be equal while a package is
 * uncovered: one entry carrying a real digest plus any second `integrity:`
 * anywhere in its subtree — a `peerDependenciesMeta` block, a nested field —
 * balanced out the next entry having `resolution: {}` and nothing else, and
 * the gate reported full coverage over a package with no hash at all.  An
 * entry can now contribute at most one, and only from the line that actually
 * pins the tarball.
 */
export function countPackagesSection(content: string): { entries: number; integrity: number } {
  let entries = 0;
  let integrity = 0;
  let inside = false;
  let open = false;
  let covered = false;
  /** Indent of the `resolution:` key while its BLOCK body is being read. */
  let resolutionAt: number | undefined;
  const close = (): void => {
    if (open && covered) integrity += 1;
    open = false;
    covered = false;
    resolutionAt = undefined;
  };
  for (const line of content.split('\n')) {
    if (/^[A-Za-z]/.test(line)) {
      close();
      inside = line.startsWith('packages:');
      continue;
    }
    if (!inside) continue;
    if (/^ {2}\S/.test(line)) {
      close();
      entries += 1;
      open = true;
      // An entry written in YAML's FLOW form carries its whole mapping on this
      // one line — `a@1.0.0: {resolution: {integrity: …}}` — so continuing past
      // it without looking rejected a lockfile pnpm accepts.
      if (/resolution:/.test(line) && isAlgorithmLengthDigest(line)) covered = true;
      continue;
    }
    if (!open) continue;

    const indent = line.length - line.trimStart().length;
    // YAML writes a mapping either INLINE (`resolution: {integrity: …}`) or as
    // an indented BLOCK, and pnpm verifies the digest under both.  Requiring
    // the flow spelling rejected an integrity-covered package outright — a gate
    // refusing valid input, which is worse than one that misses — so the block
    // form is tracked by indentation: the resolution's body is every line
    // indented deeper than its key, and ends at the first line that is not.
    if (resolutionAt !== undefined && indent <= resolutionAt) resolutionAt = undefined;
    // The entry's OWN `resolution:` field, at the entry's field indentation.
    // Accepting one at any depth let a `peerDependenciesMeta` subtree carry a
    // well-formed decoy that covered for the package's own missing digest —
    // the masking this per-entry counting was meant to end, one level down.
    const opensResolution = indent === ENTRY_FIELD_INDENT && /^\s*resolution:/.test(line);
    if (opensResolution) resolutionAt = indent;

    // A DIGEST OF THE DECLARED ALGORITHM, on the RESOLUTION this entry pins —
    // not just the algorithm prefix, not merely something long enough, and not
    // some other `integrity:` further down the same entry.  Matching `sha512-`
    // alone accepted `integrity: sha512-` and `sha512-not!base64` as hashes,
    // and a shared 40-character minimum then accepted a digest a third of
    // SHA-512's size — so a lockfile with every digest emptied or truncated
    // still reported full coverage, the exact failure this check exists to
    // notice.
    const withinResolution = opensResolution || resolutionAt !== undefined;
    if (!covered && withinResolution && isAlgorithmLengthDigest(line)) covered = true;
  }
  close();
  return { entries, integrity };
}

function check(): void {
  const content = readFileSync(LOCKFILE_PATH, 'utf-8');
  const errors: string[] = [];
  let tarballCount = 0;

  const tarballPattern = /tarball:\s*(https?:\/\/[^\s'"]+)/g;
  for (const match of content.matchAll(tarballPattern)) {
    const url = match[1];
    if (!url) continue;
    tarballCount++;

    if (url.startsWith('http://')) {
      errors.push(`Non-HTTPS tarball URL found: ${url}`);
      continue;
    }

    try {
      const parsed = new URL(url);
      if (!ALLOWED_HOSTS.has(parsed.hostname)) {
        errors.push(`Unauthorized registry host: ${parsed.hostname} (URL: ${url.slice(0, 100)})`);
      }
    } catch {
      errors.push(`Unparseable tarball URL: ${url.slice(0, 100)}`);
    }
  }

  // EVERY resolved package carries an integrity hash — the exact property,
  // asked of the `packages:` section alone.
  //
  // It used to be a RATIO over every `name@version:` key in the file, and a
  // pnpm lockfile lists each package twice: once under `packages:` with its
  // resolution, and again under `snapshots:` with its dependency graph.  So the
  // denominator was always about double the numerator, the ratio always about
  // 0.5, and the threshold was `< 0.5` — meaning the check sat permanently on
  // its own boundary and passed or failed on rounding.  Adding two dependencies
  // moved it from 803/1606 (exactly 0.5, passing) to 805/1611 (0.4997,
  // failing), with integrity coverage a full 100% both times.
  const { entries: packageCount, integrity: integrityCount } = countPackagesSection(content);

  if (packageCount > 0 && integrityCount < packageCount) {
    errors.push(
      `${packageCount - integrityCount} of ${packageCount} packages have no integrity hash — ` +
        'every resolved package must carry one',
    );
  }

  if (errors.length > 0) {
    console.error('Lockfile validation FAILED:');
    for (const error of errors) {
      console.error(`  - ${error}`);
    }
    process.exit(1);
  }

  console.log(
    `Lockfile validation passed: ${tarballCount} tarball URLs checked, all ${packageCount} packages carry an integrity hash.`,
  );
}

check();

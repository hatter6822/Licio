// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Dependency-advisory gate over the npm BULK advisory endpoint.
//
// `pnpm audit` (through at least pnpm 11.13) calls the classic
// `/-/npm/v1/security/audits` endpoint, which the registry retired in 2026
// (HTTP 410: "Use the bulk advisory endpoint instead").  This script is the
// replacement gate: it extracts every (name, version) pair from
// `pnpm-lock.yaml` and posts them to the documented successor,
// `/-/npm/v1/security/advisories/bulk`, which performs the vulnerable-range
// matching server-side (the same endpoint `npm audit` uses).  Any advisory at
// or above the threshold severity fails the run; a network or endpoint
// failure also fails the run (a security gate degrades CLOSED, exactly like
// the `pnpm audit` behaviour it replaces).
//
// Usage: tsx scripts/audit-advisories.ts [--audit-level=high]
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const LOCKFILE_PATH = resolve(ROOT, 'pnpm-lock.yaml');
const BULK_ENDPOINT = 'https://registry.npmjs.org/-/npm/v1/security/advisories/bulk';

export const SEVERITY_ORDER = ['low', 'moderate', 'high', 'critical'] as const;
export type Severity = (typeof SEVERITY_ORDER)[number];

export interface BulkAdvisory {
  id: number;
  url: string;
  title: string;
  severity: string;
  vulnerable_versions: string;
}

/**
 * Extract every (name, version) pair from the lockfile's `packages:` section.
 * Lockfile v9 keys look like `  'name@1.2.3':`, `  '@scope/name@1.2.3':`, or
 * (peer-suffixed, in `snapshots:`) `  'vitest@4.1.0(@types/node@22.0.0)':` —
 * the section ends at the next top-level (column-0) key.  Same regex-scan
 * posture as `check-lockfile.ts` (no YAML dependency).
 */
export function extractLockfilePackages(lockfileText: string): Map<string, Set<string>> {
  const packages = new Map<string, Set<string>>();
  let inPackages = false;
  for (const line of lockfileText.split('\n')) {
    if (/^\S/.test(line)) {
      inPackages = line.startsWith('packages:');
      continue;
    }
    if (!inPackages) continue;
    const key = /^ {2}'?([^\s']+?)'?:\s*$/.exec(line)?.[1];
    if (key === undefined) continue;
    // Strip any peer-dependency suffix, then split at the LAST '@' so scoped
    // names keep their leading '@'.
    const bare = key.split('(')[0] ?? key;
    const at = bare.lastIndexOf('@');
    if (at <= 0) continue;
    const name = bare.slice(0, at);
    const version = bare.slice(at + 1);
    if (name === '' || !/^\d/.test(version)) continue;
    const versions = packages.get(name) ?? new Set<string>();
    versions.add(version);
    packages.set(name, versions);
  }
  return packages;
}

/** Advisories at/above the threshold, with the versions that were posted. */
export function filterFindings(
  response: Record<string, BulkAdvisory[]>,
  posted: Map<string, Set<string>>,
  threshold: Severity,
): Array<{ name: string; versions: string[]; advisory: BulkAdvisory }> {
  const floor = SEVERITY_ORDER.indexOf(threshold);
  const findings: Array<{ name: string; versions: string[]; advisory: BulkAdvisory }> = [];
  for (const [name, advisories] of Object.entries(response)) {
    for (const advisory of advisories) {
      const rank = SEVERITY_ORDER.indexOf(advisory.severity as Severity);
      // An unknown severity label is treated as above-threshold (fail-closed).
      if (rank !== -1 && rank < floor) continue;
      findings.push({ name, versions: [...(posted.get(name) ?? [])], advisory });
    }
  }
  return findings;
}

async function postBulk(body: Record<string, string[]>): Promise<Record<string, BulkAdvisory[]>> {
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const response = await fetch(BULK_ENDPOINT, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!response.ok) {
        throw new Error(`bulk advisory endpoint responded ${response.status}`);
      }
      return (await response.json()) as Record<string, BulkAdvisory[]>;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

async function main(): Promise<void> {
  const levelArg = process.argv.find((arg) => arg.startsWith('--audit-level='));
  const threshold = (levelArg?.split('=')[1] ?? 'high') as Severity;
  if (!SEVERITY_ORDER.includes(threshold)) {
    console.error(`Unknown --audit-level: ${threshold}`);
    process.exit(1);
  }

  const packages = extractLockfilePackages(readFileSync(LOCKFILE_PATH, 'utf-8'));
  if (packages.size === 0) {
    console.error('Advisory audit FAILED: extracted zero packages from pnpm-lock.yaml');
    process.exit(1);
  }
  const body: Record<string, string[]> = {};
  for (const [name, versions] of packages) body[name] = [...versions];

  const response = await postBulk(body);
  const findings = filterFindings(response, packages, threshold);
  if (findings.length > 0) {
    console.error(`Advisory audit FAILED: ${findings.length} finding(s) at/above '${threshold}':`);
    for (const { name, versions, advisory } of findings) {
      console.error(
        `  - [${advisory.severity}] ${name}@${versions.join(', ')} — ${advisory.title}\n` +
          `    vulnerable: ${advisory.vulnerable_versions}  (${advisory.url})`,
      );
    }
    process.exit(1);
  }
  const versionCount = [...packages.values()].reduce((sum, set) => sum + set.size, 0);
  console.log(
    `Advisory audit passed: ${packages.size} packages (${versionCount} versions) checked ` +
      `against the bulk advisory endpoint; no findings at/above '${threshold}'.`,
  );
}

// Import-safe for the unit tests; executes only as an entry point.
if (process.argv[1] !== undefined && import.meta.filename === resolve(process.argv[1])) {
  main().catch((error: unknown) => {
    console.error(
      'Advisory audit FAILED (endpoint unreachable — a security gate degrades closed):',
      error,
    );
    process.exit(1);
  });
}

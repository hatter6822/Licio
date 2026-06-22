// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-S.1.5 — the shared, PURE assertion functions behind the seven Private P2P
// server-non-storage CI gates (PRIVATE_SPEC §8, §23.10, Appendix D).  Each gate
// is a thin `scripts/check-*.ts` wrapper over one of these functions; this
// module is unit-tested with positive + negative fixtures (`private-p2p-gates.test.ts`)
// so every gate is proven to BITE on an injected violation.  Keeping the logic
// here (not in @licio/db / apps/api) means the gates have no runtime side
// effects and stay fast file scanners (the `check:no-applause` pattern).
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

export const ROOT = resolve(import.meta.dirname, '..');

/** Recursively collect `.ts`/`.tsx` source files under `dir` (skips generated
 *  Android/build trees + node_modules). */
export function collectSources(dir: string): string[] {
  const out: string[] = [];
  if (!statSync(dir, { throwIfNoEntry: false })?.isDirectory()) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === 'android')
      continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...collectSources(full));
    else if (
      entry.isFile() &&
      /\.(ts|tsx)$/.test(entry.name) &&
      !/\.test\.tsx?$/.test(entry.name)
    ) {
      out.push(full);
    }
  }
  return out;
}

/** Strip `//` line comments + the body of `/* … *␓/` block comments so a gate
 *  scans CODE, not prose (a doc-comment naming a forbidden pattern is fine). */
export function stripComments(content: string): string {
  return content.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

export interface GateViolation {
  file: string;
  line: number;
  detail: string;
}

// ---------------------------------------------------------------------------
// check:no-private-cid-egress (§9.5, §23.10) — no private-room render/sync path
// may reference a PUBLIC IPFS gateway or public routing for a private CID, and
// no server source may log a private CID / op id / invite fragment.  The
// strongest enforceable scan today is the public-gateway/public-routing
// denylist over the private trees (S.4.4 reuses this gate).
// ---------------------------------------------------------------------------

/** Public-gateway / public-routing tokens forbidden in any private-p2p tree. */
export const PUBLIC_GATEWAY_PATTERNS: ReadonlyArray<{ pattern: RegExp; detail: string }> = [
  { pattern: /ipfs\.io/i, detail: 'public ipfs.io gateway' },
  { pattern: /dweb\.link/i, detail: 'public dweb.link gateway' },
  { pattern: /cloudflare-ipfs/i, detail: 'public cloudflare-ipfs gateway' },
  { pattern: /gateway\.pinata/i, detail: 'public pinata gateway' },
  { pattern: /\/ipfs\/[a-z0-9]/i, detail: 'public-gateway /ipfs/<cid> URL path' },
  { pattern: /\/ipns\//i, detail: 'public-gateway /ipns/ URL path' },
  { pattern: /delegated[-_]?routing/i, detail: 'delegated public routing' },
];

export function scanPublicGatewayEgress(
  files: Array<{ path: string; content: string }>,
): GateViolation[] {
  const violations: GateViolation[] = [];
  for (const { path, content } of files) {
    const code = stripComments(content);
    const lines = code.split('\n');
    lines.forEach((line, i) => {
      for (const { pattern, detail } of PUBLIC_GATEWAY_PATTERNS) {
        if (pattern.test(line)) violations.push({ file: path, line: i + 1, detail });
      }
    });
  }
  return violations;
}

// ---------------------------------------------------------------------------
// check:private-bundle-transparency (§20.6, §27.5) — the private-mode bundle
// loads NO dynamic remote code (the half enforceable before the WS-S.10 update
// channel ships; S.10.2b extends this gate to also assert the SW pin + the
// room-lock-on-unverified path).  CSP/Trusted-Types already forbid eval at
// runtime; this is the static half over the private trees.
// ---------------------------------------------------------------------------

export const DYNAMIC_REMOTE_CODE_PATTERNS: ReadonlyArray<{ pattern: RegExp; detail: string }> = [
  { pattern: /\beval\s*\(/, detail: 'eval()' },
  { pattern: /new\s+Function\s*\(/, detail: 'new Function()' },
  { pattern: /importScripts\s*\(/, detail: 'importScripts()' },
  // A dynamic import() of an http(s) URL string (remote code).
  { pattern: /import\s*\(\s*['"`]https?:/i, detail: 'dynamic import() of a remote URL' },
];

export function scanDynamicRemoteCode(
  files: Array<{ path: string; content: string }>,
): GateViolation[] {
  const violations: GateViolation[] = [];
  for (const { path, content } of files) {
    const code = stripComments(content);
    const lines = code.split('\n');
    lines.forEach((line, i) => {
      for (const { pattern, detail } of DYNAMIC_REMOTE_CODE_PATTERNS) {
        if (pattern.test(line)) violations.push({ file: path, line: i + 1, detail });
      }
    });
  }
  return violations;
}

// ---------------------------------------------------------------------------
// The "required marker" gates (§23.3–§23.6): assert the guard/predicate is
// PRESENT in the source it must live in.  Each returns the list of MISSING
// markers (empty ⇒ the guard exists).  A reader resolves `apps/api/src/...`.
// ---------------------------------------------------------------------------

export interface RequiredMarker {
  /** Path relative to `apps/api/src`. */
  file: string;
  /** Substrings that MUST all appear in the file (after comment stripping). */
  markers: string[];
}

export function findMissingMarkers(
  required: readonly RequiredMarker[],
  readApiSource: (relPath: string) => string,
): GateViolation[] {
  const violations: GateViolation[] = [];
  for (const { file, markers } of required) {
    let code: string;
    try {
      code = stripComments(readApiSource(file));
    } catch {
      violations.push({ file, line: 0, detail: 'file not found' });
      continue;
    }
    for (const marker of markers) {
      if (!code.includes(marker)) {
        violations.push({ file, line: 0, detail: `missing required guard marker: ${marker}` });
      }
    }
  }
  return violations;
}

/** §23.3/§23.4 — the endpoint rejection guards (submission/contribution/feed). */
export const P2P_ENDPOINT_REJECTION_MARKERS: readonly RequiredMarker[] = [
  {
    file: 'ingestion/submission.ts',
    markers: ["storageMode === 'p2p'", 'p2p_room_requires_client_sync'],
  },
  { file: 'forum/contributions.ts', markers: ["storageMode === 'p2p'"] },
  { file: 'routes/v1.ts', markers: ["storageMode === 'p2p'", 'p2p_room_local_only'] },
];

/** §23.5 — every retriever predicates server storage (the shared helper + the
 *  room-surface scoper both consult `roomStorageMode`). */
export const P2P_RANKING_EXCLUSION_MARKERS: readonly RequiredMarker[] = [
  { file: 'ranking/retrievers.ts', markers: ['roomStorageMode', "!== 'server'"] },
  { file: 'ranking/services.ts', markers: ['roomStorageMode'] },
];

/** §23.6 — server search indexes + serves only server-storage rooms. */
export const P2P_SEARCH_EXCLUSION_MARKERS: readonly RequiredMarker[] = [
  { file: 'ingestion/search.ts', markers: ["roomStorageMode !== 'server'"] },
  { file: 'ingestion/drizzle-ingestion-stores.ts', markers: ["storage_mode = 'server'"] },
];

// ---------------------------------------------------------------------------
// Shared wrapper helpers.
// ---------------------------------------------------------------------------

/** Read an `apps/api/src/<rel>` source file. */
export function apiSource(rel: string): string {
  return readFileSync(resolve(ROOT, 'apps/api/src', rel), 'utf-8');
}

/** Every private-room source tree the egress/bundle scans cover (those that
 *  exist; the web private-p2p module + courier land with later cards). */
export function privateTreeFiles(): Array<{ path: string; content: string }> {
  const dirs = [
    resolve(ROOT, 'packages/private-p2p/src'),
    resolve(ROOT, 'apps/web/src/private-p2p'),
    resolve(ROOT, 'apps/api/src/routes/private-rooms.ts'),
    resolve(ROOT, 'apps/api/src/routes/private-rendezvous.ts'),
  ];
  const files: string[] = [];
  for (const dir of dirs) {
    const stat = statSync(dir, { throwIfNoEntry: false });
    if (stat?.isDirectory()) files.push(...collectSources(dir));
    else if (stat?.isFile()) files.push(dir);
  }
  return files.map((path) => ({
    path: path.replace(ROOT, ''),
    content: readFileSync(path, 'utf-8'),
  }));
}

/** Report a gate's outcome and exit non-zero on any violation. */
export function reportGate(name: string, violations: GateViolation[]): void {
  if (violations.length > 0) {
    console.error(`${name} FAILED:`);
    for (const v of violations) {
      console.error(`  - ${v.file}${v.line > 0 ? `:${v.line}` : ''} — ${v.detail}`);
    }
    process.exit(1);
  }
  console.log(`${name}: OK`);
}

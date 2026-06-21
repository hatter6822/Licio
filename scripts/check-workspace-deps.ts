// SPDX-License-Identifier: AGPL-3.0-or-later
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');

interface PackageJson {
  name: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

const ALLOWED_WORKSPACE_DEPS: Record<string, string[]> = {
  '@licio/shared': [],
  '@licio/db': ['@licio/shared'],
  '@licio/invariants': ['@licio/shared'],
  // Pure ranking domain logic (WS-I): NEVER @licio/db — the ranking math has
  // no database access by construction (pay-to-rank firewall, SPEC §21.5).
  '@licio/ranking': ['@licio/shared', '@licio/invariants'],
  // Pure AI-governance domain logic (WS-K): schemas + deterministic evaluation
  // math, no database access (it never imports @licio/db) — the same firewall
  // posture as @licio/ranking. Browser-safe so the web client can render labels.
  '@licio/ai-governance': ['@licio/shared'],
  // Pure AI-governed-rooms domain logic (WS-U): policy DSL, kernel, capabilities,
  // elections, ratification, lawmaking — NEVER @licio/db (the governance math has
  // no database access by construction; the pay-to-rank firewall posture).
  '@licio/governance': ['@licio/shared'],
  // Pure LCAP protocol core (WS-R): deterministic CBOR, CIDs, COSE detached
  // proofs, schemas, validation — NEVER @licio/db (the offline-availability
  // protocol library has no database access by construction; the zero-dependency
  // core carries only WebCrypto + Compression Streams, OFFLINE_SPEC §31.1).
  '@licio/lcap': ['@licio/shared'],
  // Optional code-split P2P + public-bridge transports (WS-R.15.6/15.7): WebRTC +
  // the IPFS gateway bridge. Zero npm runtime deps; depends ONLY on @licio/shared +
  // @licio/lcap, NEVER @licio/db. Confined to a separately code-split chunk + excluded
  // from the apps/web direct-dep budget (WS-R.15.8).
  '@licio/lcap-p2p': ['@licio/shared', '@licio/lcap'],
  // WS-R.15.1a/b: the web client takes @licio/lcap for the OFFLINE bundle
  // export/import flows — it runs the real pack writer/reader + validate()
  // client-side (no server round-trip), loaded as a lazy dynamic-import chunk
  // so the protocol core never enters the initial bundle. NEVER @licio/db.
  // @licio/lcap-p2p is permitted but MUST be loaded DYNAMICALLY only (the WS-R.15.8
  // code-split gate `check:lcap-p2p-split` proves no static import in apps/web), so the
  // P2P/transport protocol code stays out of the initial bundle.
  web: [
    '@licio/shared',
    '@licio/invariants',
    '@licio/ai-governance',
    '@licio/lcap',
    '@licio/lcap-p2p',
  ],
  api: [
    '@licio/shared',
    '@licio/db',
    '@licio/invariants',
    '@licio/ranking',
    '@licio/ai-governance',
    '@licio/governance',
    '@licio/lcap',
  ],
};

const WORKSPACE_PACKAGES = [
  '@licio/shared',
  '@licio/db',
  '@licio/invariants',
  '@licio/ranking',
  '@licio/ai-governance',
  '@licio/governance',
  '@licio/lcap',
  '@licio/lcap-p2p',
];

const PACKAGE_PATHS: Record<string, string> = {
  '@licio/shared': resolve(ROOT, 'packages/shared/package.json'),
  '@licio/db': resolve(ROOT, 'packages/db/package.json'),
  '@licio/invariants': resolve(ROOT, 'packages/invariants/package.json'),
  '@licio/ranking': resolve(ROOT, 'packages/ranking/package.json'),
  '@licio/ai-governance': resolve(ROOT, 'packages/ai-governance/package.json'),
  '@licio/governance': resolve(ROOT, 'packages/governance/package.json'),
  '@licio/lcap': resolve(ROOT, 'packages/lcap/package.json'),
  '@licio/lcap-p2p': resolve(ROOT, 'packages/lcap-p2p/package.json'),
  web: resolve(ROOT, 'apps/web/package.json'),
  api: resolve(ROOT, 'apps/api/package.json'),
};

const SOURCE_DIRS: Record<string, string> = {
  '@licio/shared': resolve(ROOT, 'packages/shared/src'),
  '@licio/db': resolve(ROOT, 'packages/db/src'),
  '@licio/invariants': resolve(ROOT, 'packages/invariants/src'),
  '@licio/ranking': resolve(ROOT, 'packages/ranking/src'),
  '@licio/ai-governance': resolve(ROOT, 'packages/ai-governance/src'),
  '@licio/governance': resolve(ROOT, 'packages/governance/src'),
  '@licio/lcap': resolve(ROOT, 'packages/lcap/src'),
  '@licio/lcap-p2p': resolve(ROOT, 'packages/lcap-p2p/src'),
  web: resolve(ROOT, 'apps/web/src'),
  api: resolve(ROOT, 'apps/api/src'),
};

const IMPORT_PATTERN = /(?:import|from|require\()\s*['"](@licio\/[^'"/]+)/g;

function collectSourceFiles(dir: string): string[] {
  const results: string[] = [];
  if (!statSync(dir, { throwIfNoEntry: false })?.isDirectory()) return results;

  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory() && entry.name !== 'node_modules') {
      results.push(...collectSourceFiles(fullPath));
    } else if (entry.isFile() && /\.(ts|tsx|js|jsx)$/.test(entry.name)) {
      results.push(fullPath);
    }
  }
  return results;
}

function check(): void {
  const errors: string[] = [];

  for (const [name, pkgPath] of Object.entries(PACKAGE_PATHS)) {
    const raw = readFileSync(pkgPath, 'utf-8');
    const pkg: PackageJson = JSON.parse(raw);
    const allDeps = {
      ...pkg.dependencies,
      ...pkg.devDependencies,
    };

    const allowed = ALLOWED_WORKSPACE_DEPS[name];
    if (!allowed) {
      continue;
    }

    const workspaceDeps = Object.keys(allDeps).filter((dep) => WORKSPACE_PACKAGES.includes(dep));

    for (const dep of workspaceDeps) {
      if (!allowed.includes(dep)) {
        errors.push(
          `${name} declares ${dep} in package.json, which is not in its allow-list: [${allowed.join(', ')}]`,
        );
      }
    }

    const srcDir = SOURCE_DIRS[name];
    if (!srcDir) continue;
    const sourceFiles = collectSourceFiles(srcDir);

    for (const filePath of sourceFiles) {
      const content = readFileSync(filePath, 'utf-8');
      for (const match of content.matchAll(IMPORT_PATTERN)) {
        const dep = match[1];
        if (dep && WORKSPACE_PACKAGES.includes(dep) && !allowed.includes(dep)) {
          const relative = filePath.replace(ROOT, '');
          errors.push(
            `${name} imports ${dep} in ${relative}, which is not in its allow-list: [${allowed.join(', ')}]`,
          );
        }
      }
    }
  }

  if (errors.length > 0) {
    console.error('Workspace dependency boundary check FAILED:');
    for (const error of errors) {
      console.error(`  - ${error}`);
    }
    process.exit(1);
  }

  console.log('Workspace dependency boundaries: OK');
}

check();

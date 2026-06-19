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
  web: ['@licio/shared', '@licio/invariants', '@licio/ai-governance'],
  api: [
    '@licio/shared',
    '@licio/db',
    '@licio/invariants',
    '@licio/ranking',
    '@licio/ai-governance',
  ],
};

const WORKSPACE_PACKAGES = [
  '@licio/shared',
  '@licio/db',
  '@licio/invariants',
  '@licio/ranking',
  '@licio/ai-governance',
];

const PACKAGE_PATHS: Record<string, string> = {
  '@licio/shared': resolve(ROOT, 'packages/shared/package.json'),
  '@licio/db': resolve(ROOT, 'packages/db/package.json'),
  '@licio/invariants': resolve(ROOT, 'packages/invariants/package.json'),
  '@licio/ranking': resolve(ROOT, 'packages/ranking/package.json'),
  '@licio/ai-governance': resolve(ROOT, 'packages/ai-governance/package.json'),
  web: resolve(ROOT, 'apps/web/package.json'),
  api: resolve(ROOT, 'apps/api/package.json'),
};

const SOURCE_DIRS: Record<string, string> = {
  '@licio/shared': resolve(ROOT, 'packages/shared/src'),
  '@licio/db': resolve(ROOT, 'packages/db/src'),
  '@licio/invariants': resolve(ROOT, 'packages/invariants/src'),
  '@licio/ranking': resolve(ROOT, 'packages/ranking/src'),
  '@licio/ai-governance': resolve(ROOT, 'packages/ai-governance/src'),
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

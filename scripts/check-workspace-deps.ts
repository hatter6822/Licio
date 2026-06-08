// SPDX-License-Identifier: AGPL-3.0-or-later
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

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
  web: ['@licio/shared', '@licio/invariants'],
  api: ['@licio/shared', '@licio/db', '@licio/invariants'],
};

const WORKSPACE_PACKAGES = ['@licio/shared', '@licio/db', '@licio/invariants'];

const PACKAGE_PATHS: Record<string, string> = {
  '@licio/shared': resolve(ROOT, 'packages/shared/package.json'),
  '@licio/db': resolve(ROOT, 'packages/db/package.json'),
  '@licio/invariants': resolve(ROOT, 'packages/invariants/package.json'),
  web: resolve(ROOT, 'apps/web/package.json'),
  api: resolve(ROOT, 'apps/api/package.json'),
};

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
          `${name} imports ${dep}, which is not in its allow-list: [${allowed.join(', ')}]`,
        );
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

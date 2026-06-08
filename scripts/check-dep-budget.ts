// SPDX-License-Identifier: AGPL-3.0-or-later
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');

interface PackageJson {
  dependencies?: Record<string, string>;
}

interface Budget {
  workspace: string;
  path: string;
  limit: number;
}

const BUDGETS: Budget[] = [
  { workspace: 'apps/web', path: resolve(ROOT, 'apps/web/package.json'), limit: 15 },
  { workspace: 'apps/api', path: resolve(ROOT, 'apps/api/package.json'), limit: 20 },
];

function check(): void {
  const errors: string[] = [];

  for (const budget of BUDGETS) {
    const raw = readFileSync(budget.path, 'utf-8');
    const pkg: PackageJson = JSON.parse(raw);
    const deps = pkg.dependencies ?? {};

    const externalDeps = Object.entries(deps).filter(
      ([, version]) => !version.startsWith('workspace:'),
    );

    const count = externalDeps.length;
    const headroom = budget.limit - count;

    console.log(
      `${budget.workspace}: ${count}/${budget.limit} production deps (headroom: ${headroom})`,
    );

    for (const [name] of externalDeps) {
      console.log(`  - ${name}`);
    }

    if (count >= budget.limit) {
      errors.push(
        `${budget.workspace}: ${count} production deps meets or exceeds budget of ${budget.limit}`,
      );
    }
  }

  if (errors.length > 0) {
    console.error('\nDependency budget check FAILED:');
    for (const error of errors) {
      console.error(`  - ${error}`);
    }
    process.exit(1);
  }

  console.log('\nDependency budget check passed.');
}

check();

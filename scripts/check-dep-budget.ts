import { readFileSync } from 'node:fs';
import { join } from 'node:path';

interface PackageJson {
  dependencies?: Record<string, string>;
}

const budgets = [
  { name: 'apps/web', path: 'apps/web/package.json', limitExclusive: 15 },
  { name: 'apps/api', path: 'apps/api/package.json', limitExclusive: 20 },
] as const;

function productionDependencyCount(packageJson: PackageJson): number {
  return Object.entries(packageJson.dependencies ?? {}).filter(
    ([name, version]) => !(name.startsWith('@licio/') && version.startsWith('workspace:')),
  ).length;
}

let failed = false;
for (const budget of budgets) {
  const packageJson = JSON.parse(
    readFileSync(join(process.cwd(), budget.path), 'utf8'),
  ) as PackageJson;
  const count = productionDependencyCount(packageJson);
  const maxAllowed = budget.limitExclusive - 1;
  const remaining = maxAllowed - count;
  const message = `${budget.name}: ${count}/${maxAllowed} direct production dependencies (${remaining} remaining)`;
  if (count >= budget.limitExclusive) {
    failed = true;
    console.error(`Dependency budget exceeded: ${message}`);
  } else {
    console.info(message);
  }
}

if (failed) {
  process.exitCode = 1;
}

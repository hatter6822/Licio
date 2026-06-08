import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const distDir = process.cwd().endsWith('apps/web')
  ? join(process.cwd(), 'dist')
  : join(process.cwd(), 'apps/web/dist');
const forbiddenMarkers = [
  'DATABASE_URL',
  'REDIS_URL',
  'SESSION_SECRET',
  'CORS_ORIGIN',
  'PRIVATE_KEY',
  'SEED_PHRASE',
] as const;

function walk(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? walk(path) : [path];
  });
}

const violations: string[] = [];
for (const file of walk(distDir)) {
  if (!/\.(html|js|css|json|webmanifest)$/.test(file)) {
    continue;
  }
  const content = readFileSync(file, 'utf8');
  for (const marker of forbiddenMarkers) {
    if (content.includes(marker)) {
      violations.push(`${relative(distDir, file)} contains forbidden server-only marker ${marker}`);
    }
  }
}

if (violations.length > 0) {
  for (const violation of violations) {
    console.error(violation);
  }
  process.exitCode = 1;
} else {
  console.info('Client build secret-marker scan passed.');
}

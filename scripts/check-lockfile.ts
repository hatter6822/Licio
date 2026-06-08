import { readFileSync } from 'node:fs';
import { parse } from 'yaml';

interface LockfilePackage {
  resolution?: {
    integrity?: string;
    tarball?: string;
  };
}

interface PnpmLockfile {
  packages?: Record<string, LockfilePackage>;
}

const lockfileText = readFileSync('pnpm-lock.yaml', 'utf8');
const lockfile = parse(lockfileText) as PnpmLockfile;
const violations: string[] = [];

if (lockfileText.includes('http://')) {
  violations.push('lockfile contains an insecure http:// URL');
}

for (const [key, value] of Object.entries(lockfile.packages ?? {})) {
  const tarball = value.resolution?.tarball;
  if (tarball !== undefined && !tarball.startsWith('https://registry.npmjs.org/')) {
    violations.push(`${key}: tarball is not from the npm registry`);
  }

  const integrity = value.resolution?.integrity;
  if (integrity === undefined) {
    violations.push(`${key}: missing integrity`);
  } else if (!integrity.startsWith('sha512-')) {
    violations.push(`${key}: integrity is not sha512`);
  }
}

if (violations.length > 0) {
  for (const violation of violations) {
    console.error(violation);
  }
  process.exitCode = 1;
} else {
  console.info('Lockfile integrity and registry checks passed.');
}

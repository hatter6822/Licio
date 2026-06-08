// SPDX-License-Identifier: AGPL-3.0-or-later
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');

const SOURCE_DIRS = [
  resolve(ROOT, 'apps/web/src'),
  resolve(ROOT, 'apps/api/src'),
  resolve(ROOT, 'packages/shared/src'),
  resolve(ROOT, 'packages/db/src'),
  resolve(ROOT, 'packages/invariants/src'),
];

const BLOCKED_PATTERNS: Array<{ pattern: RegExp; message: string }> = [
  { pattern: /\.innerHTML\s*=/, message: 'Direct innerHTML assignment (use DOMPurify)' },
  { pattern: /\.outerHTML\s*=/, message: 'Direct outerHTML assignment' },
  { pattern: /document\.write\s*\(/, message: 'document.write() call' },
  { pattern: /document\.writeln\s*\(/, message: 'document.writeln() call' },
  {
    pattern: /['"`]javascript\s*:/i,
    message: 'javascript: URL (XSS vector)',
  },
  { pattern: /new\s+Function\s*\(/, message: 'new Function() (equivalent to eval)' },
];

const ALLOWLIST_PATHS = [/trusted-types\.ts$/, /\.test\.ts$/, /\.test\.tsx$/, /\.spec\.ts$/];

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

function lint(): void {
  const errors: string[] = [];

  for (const dir of SOURCE_DIRS) {
    const files = collectSourceFiles(dir);

    for (const filePath of files) {
      if (ALLOWLIST_PATHS.some((p) => p.test(filePath))) continue;

      const content = readFileSync(filePath, 'utf-8');
      const lines = content.split('\n');

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (!line) continue;
        for (const { pattern, message } of BLOCKED_PATTERNS) {
          if (pattern.test(line)) {
            const relative = filePath.replace(ROOT, '');
            errors.push(`${relative}:${i + 1}: ${message}`);
          }
        }
      }
    }
  }

  if (errors.length > 0) {
    console.error('Security lint FAILED:');
    for (const error of errors) {
      console.error(`  - ${error}`);
    }
    process.exit(1);
  }

  console.log('Security lint passed: no blocked DOM/script patterns found.');
}

lint();

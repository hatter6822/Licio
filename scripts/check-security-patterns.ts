import { globSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const patterns = [
  { name: 'innerHTML assignment', regex: /\.innerHTML\s*=/ },
  { name: 'outerHTML assignment', regex: /\.outerHTML\s*=/ },
  { name: 'document.write', regex: /document\.write\s*\(/ },
  { name: 'javascript URL', regex: /javascript:/i },
  { name: 'new Function', regex: /new\s+Function\s*\(/ },
];

const files = globSync('{apps,packages,scripts}/**/*.{ts,tsx,js,jsx}', {
  cwd: root,
  exclude: [
    '**/dist/**',
    '**/node_modules/**',
    'scripts/check-security-patterns.ts',
    'scripts/validate-build.ts',
  ],
});

let failed = false;
for (const file of files) {
  const text = readFileSync(join(root, file), 'utf8');
  for (const pattern of patterns) {
    if (pattern.regex.test(text)) {
      failed = true;
      console.error(`${file}: blocked security pattern (${pattern.name})`);
    }
  }
}

if (!failed) {
  console.info('Security pattern scan passed.');
}
process.exitCode = failed ? 1 : 0;

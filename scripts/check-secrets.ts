import { globSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const allowedFiles = new Set([
  '.env.example',
  'scripts/check-secrets.ts',
  'docs/development/ws-0-foundation.md',
  'docs/planning/01-repository-foundation.md',
]);
const secretPatterns = [
  { name: 'private key block', regex: /-----BEGIN (?:RSA |EC |OPENSSH |)PRIVATE KEY-----/ },
  { name: 'AWS access key', regex: /AKIA[0-9A-Z]{16}/ },
  { name: 'GitHub token', regex: /gh[pousr]_[A-Za-z0-9_]{36,}/ },
  {
    name: 'generic secret assignment',
    regex: /(?:SECRET|TOKEN|PRIVATE_KEY|SEED_PHRASE|MNEMONIC)=[^\s#][^\n]*/i,
  },
];

const files = globSync('**/*', {
  cwd: process.cwd(),
  withFileTypes: false,
  exclude: [
    '**/node_modules/**',
    '**/dist/**',
    '**/dist-types/**',
    '**/coverage/**',
    '**/playwright-report/**',
    '**/test-results/**',
    'pnpm-lock.yaml',
    'LICENSE',
  ],
})
  .filter((file) => !allowedFiles.has(file))
  .filter((file) => /\.(ts|tsx|js|jsx|json|yaml|yml|md|env|example|txt|toml|ini|sh)$/.test(file));

const violations: string[] = [];
for (const file of files) {
  const text = readFileSync(join(process.cwd(), file), 'utf8');
  for (const pattern of secretPatterns) {
    if (pattern.regex.test(text)) {
      violations.push(`${file}: possible ${pattern.name}`);
    }
  }
}

if (violations.length > 0) {
  for (const violation of violations) {
    console.error(violation);
  }
  process.exitCode = 1;
} else {
  console.info('Repository secret scan passed.');
}

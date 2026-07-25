// SPDX-License-Identifier: AGPL-3.0-or-later
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  type CodeSinkPattern,
  SOURCE_CODE_SINKS,
  scanSourceForSinks,
} from './dangerous-code-patterns.js';

const ROOT = resolve(import.meta.dirname, '..');

const SOURCE_DIRS = [
  resolve(ROOT, 'apps/web/src'),
  resolve(ROOT, 'apps/api/src'),
  resolve(ROOT, 'packages/shared/src'),
  resolve(ROOT, 'packages/db/src'),
  resolve(ROOT, 'packages/invariants/src'),
  // The remaining workspaces are browser- and server-shipped too, so the same
  // dangerous-sink ban applies (a stray eval/innerHTML in ranking, governance,
  // or a P2P/crypto package must fail CI exactly as it would in web/api).
  resolve(ROOT, 'packages/ranking/src'),
  resolve(ROOT, 'packages/ai-governance/src'),
  resolve(ROOT, 'packages/governance/src'),
  resolve(ROOT, 'packages/lcap/src'),
  resolve(ROOT, 'packages/lcap-p2p/src'),
  resolve(ROOT, 'packages/private-p2p/src'),
];

const BLOCKED_PATTERNS: CodeSinkPattern[] = [
  { pattern: /\.innerHTML\s*=/, label: 'Direct innerHTML assignment (use DOMPurify)' },
  { pattern: /\.outerHTML\s*=/, label: 'Direct outerHTML assignment' },
  { pattern: /document\s*\.\s*write\s*\(/, label: 'document.write() call' },
  { pattern: /document\s*\.\s*writeln\s*\(/, label: 'document.writeln() call' },
  {
    pattern: /['"`]javascript\s*:/i,
    label: 'javascript: URL (XSS vector)',
  },
  // Dynamic-code sinks — eval(), every Function-constructor call form, and the
  // string-argument timers — come from the shared definition so this gate,
  // check:sw, check:update-channel, and check:private-bundle-transparency can
  // never again drift apart on what counts as runtime code evaluation.
  // (CLAUDE.md documents this gate as the mechanical check for eval() —
  // Biome 2.x cannot block it at the AST level.)
  ...SOURCE_CODE_SINKS,
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

      // `scanSourceForSinks` scans the RAW source AND the comment-stripped copy
      // and unions the results, over the WHOLE text rather than line by line.
      //   • raw    — no strip bug can ever hide a sink (every regression found
      //              in review was a strip that deleted the call it should have
      //              revealed).
      //   • strip  — adds the one form raw cannot see, a call split by an
      //              interposed comment: `Function/*gap*/('…')`.
      //   • whole  — the patterns allow whitespace before `(`, and that
      //              whitespace may be a NEWLINE, which a per-line scan cannot
      //              match however permissive the pattern.
      const relative = filePath.replace(ROOT, '');
      for (const { label, line } of scanSourceForSinks(
        readFileSync(filePath, 'utf-8'),
        BLOCKED_PATTERNS,
      )) {
        errors.push(`${relative}:${line}: ${label}`);
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

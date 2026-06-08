// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Static no-applause scan (WS-B.2.1b / Sections 2.4, 5.1). Greps the web
// component tree for applause affordances so a future change cannot silently
// reintroduce likes, votes, karma, follower counts, or reaction bars. This is
// defense in depth alongside the type-level and runtime tests in
// StoryCard.no-applause.test.tsx.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const SCAN_DIR = resolve(ROOT, 'apps/web/src/components');

// Curated to avoid false positives ("looks like", "Save", "Bridge Active").
const FORBIDDEN: Array<{ pattern: RegExp; message: string }> = [
  { pattern: /\b(?:up|down)votes?\b/i, message: 'upvote/downvote affordance' },
  {
    pattern: /\b(?:like|vote|reaction|follower|share|star)Count\b/,
    message: 'popularity count prop/field',
  },
  { pattern: /\bkarma\b/i, message: 'karma score' },
  { pattern: /\bthumbs[-_ ]?(?:up|down)\b/i, message: 'thumbs-up/thumbs-down icon' },
  { pattern: /\b\d+\s+(?:likes|votes|reactions)\b/i, message: '"X likes/votes/reactions" text' },
  { pattern: /name=["']heart["']/, message: 'heart icon' },
];

const TEST_FILE = /\.(?:test|spec)\.tsx?$/;

function collect(dir: string): string[] {
  const out: string[] = [];
  if (!statSync(dir, { throwIfNoEntry: false })?.isDirectory()) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory() && entry.name !== 'node_modules') out.push(...collect(full));
    else if (entry.isFile() && /\.tsx?$/.test(entry.name) && !TEST_FILE.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Strip comments so doctrine may be DISCUSSED in prose (e.g. "never a downvote")
 * while real affordances in code still fail the scan. Removes inline JSX
 * comments, block comments, line comments, and lines that are part of a
 * doc-comment block (`*`-prefixed).
 */
function stripComments(line: string): string {
  const trimmed = line.trim();
  if (trimmed.startsWith('*') || trimmed.startsWith('//') || trimmed.startsWith('/*')) return '';
  return line
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/, '');
}

function main(): void {
  const errors: string[] = [];
  for (const file of collect(SCAN_DIR)) {
    const lines = readFileSync(file, 'utf-8').split('\n');
    lines.forEach((line, i) => {
      const code = stripComments(line);
      if (!code.trim()) return;
      for (const { pattern, message } of FORBIDDEN) {
        if (pattern.test(code)) {
          errors.push(`${file.replace(ROOT, '')}:${i + 1}: ${message}`);
        }
      }
    });
  }

  if (errors.length > 0) {
    console.error('No-applause scan FAILED — forbidden affordance(s) found:');
    for (const error of errors) console.error(`  - ${error}`);
    process.exit(1);
  }
  console.log('No-applause scan passed: no applause affordances in the component tree.');
}

main();

// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-S.2.1 — the Private-P2P code-split gate.  @licio/private-p2p (the room
// confidentiality & authority plane: MLS/HPKE/AEAD/Ed25519 crypto, the reducer,
// the sync-decision cores, the room engine) is heavy + off the synchronous path.
// Its protocol/crypto code MUST stay out of the apps/web initial bundle, so
// apps/web may reference it ONLY through a DYNAMIC `import('@licio/private-p2p')`
// (a lazy chunk) — never a static VALUE import that would pull it onto the
// synchronous path.  A bare `import type … from '@licio/private-p2p'` is erased
// at build and is allowed (the IndexedDB adapter type-imports the storage port).
// This gate fails the build on a static value import in apps/web/src.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { blankCommentsIn, blankSourceComments } from './gate-comments.js';

const ROOT = resolve(import.meta.dirname, '..');
const WEB_SRC = resolve(ROOT, 'apps/web/src');
const SPECIFIER = '@licio/private-p2p';

/** Pure: the static-value-import violations in one source (importable for tests). */
export function findStaticPrivateP2pImports(filename: string, rawContent: string): string[] {
  // Blank comments through the PARSER, not a regex pair.  A regex has no notion
  // of a string literal, so a `/*` inside one opened a fake block comment that
  // swallowed every line up to the next real `*/` — and any JSDoc later in the
  // file supplies one.  A static `import … from '@licio/…-p2p'` sitting in the
  // swallowed span was invisible and the gate reported clean.  Blanking is
  // length- and newline-preserving, so the reported line still names the real one.
  return scanBlankedPrivate(filename, blankSourceComments(filename, rawContent));
}

/** The scan itself, over content whose comments are ALREADY blanked (see `main`:
 *  the sweep blanks the whole tree in ONE batch rather than per file). */
function scanBlankedPrivate(filename: string, content: string): string[] {
  const issues: string[] = [];
  const staticFrom = new RegExp(`\\bimport\\b([^;]*?)\\bfrom\\s*['"]${SPECIFIER}['"]`, 'g');
  const sideEffect = new RegExp(`\\bimport\\s*['"]${SPECIFIER}['"]`, 'g');
  // An aggregating re-export (`export { X } from '…'` / `export * from '…'`) is a STATIC binding
  // edge: the bundler resolves it synchronously onto the initial path exactly like `import`, so it
  // must be caught too (a re-export barrel would otherwise bypass the gate).  `export type …` is
  // erased at build and is permitted, mirroring the `import type` allowance.
  const exportFrom = new RegExp(`\\bexport\\b([^;]*?)\\bfrom\\s*['"]${SPECIFIER}['"]`, 'g');
  for (const match of content.matchAll(staticFrom)) {
    // `import type …` is erased at build (no runtime weight) and is permitted.
    if (!/^\s*type\b/.test(match[1] ?? '')) {
      issues.push(`${filename}: static value import of ${SPECIFIER} (use a dynamic import())`);
    }
  }
  for (const match of content.matchAll(exportFrom)) {
    if (!/^\s*type\b/.test(match[1] ?? '')) {
      issues.push(`${filename}: static re-export of ${SPECIFIER} (use a dynamic import())`);
    }
  }
  if (sideEffect.test(content)) {
    issues.push(`${filename}: side-effect import of ${SPECIFIER} (use a dynamic import())`);
  }
  return issues;
}

function collect(dir: string): string[] {
  const out: string[] = [];
  if (!statSync(dir, { throwIfNoEntry: false })?.isDirectory()) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory() && entry.name !== 'node_modules') out.push(...collect(full));
    else if (entry.isFile() && /\.(?:ts|tsx)$/.test(entry.name)) out.push(full);
  }
  return out;
}

function main(): void {
  const errors: string[] = [];
  // ONE compiler host for the whole tree — the per-file helper spun up a
  // TypeScript host for each of ~720 files and took this mandatory gate to 46
  // seconds.  A gate slow enough to be killed is a gate that stops being run.
  const files = collect(WEB_SRC);
  const blanked = blankCommentsIn(
    files.map((file) => ({ path: file.replace(ROOT, ''), content: readFileSync(file, 'utf-8') })),
  );
  for (const [filename, content] of blanked) {
    errors.push(...scanBlankedPrivate(filename, content));
  }
  if (errors.length > 0) {
    console.error(
      'check:private-p2p-split FAILED — @licio/private-p2p must be dynamically imported:',
    );
    for (const error of errors) console.error(`  - ${error}`);
    process.exit(1);
  }
  console.log(
    'check:private-p2p-split passed: apps/web references @licio/private-p2p only via dynamic import.',
  );
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  main();
}

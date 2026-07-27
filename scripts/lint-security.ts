// SPDX-License-Identifier: AGPL-3.0-or-later
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  DOM_MEMBER_SINKS,
  findDynamicCodeSinksIn,
  findForbiddenGlobalReferencesIn,
  findJavascriptUrlsIn,
  findMemberSinkUsesIn,
  SOURCE_CODE_SINKS,
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

// A `javascript:` URL is string CONTENT — no receiver, no call chain — so a
// pattern is the right tool for it. The DOM sinks that ARE member accesses
// (`innerHTML`, `document.write`) moved to `DOM_MEMBER_SINKS`, which is walked
// structurally: a pattern anchored on `.innerHTML` reads only the dotted
// spelling, and `node['innerHTML'] = payload` reaches the same sink.

// The DYNAMIC-CODE sinks are not patterns: `eval`, the `Function` constructor
// and the string-argument timers are found by tokenising and walking the
// access chain (`findDynamicCodeSinks`), because the spellings that reach them
// are unbounded. Same shared definition, so this gate, check:sw,
// check:update-channel and check:private-bundle-transparency cannot drift on
// what counts as runtime code evaluation. (CLAUDE.md documents this gate as
// the mechanical check for eval() — Biome 2.x cannot block it at the AST
// level.)

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

  const scanned: Array<{ relative: string; source: string }> = [];
  for (const dir of SOURCE_DIRS) {
    for (const filePath of collectSourceFiles(dir)) {
      if (ALLOWLIST_PATHS.some((p) => p.test(filePath))) continue;
      scanned.push({
        relative: filePath.replace(ROOT, ''),
        source: readFileSync(filePath, 'utf-8'),
      });
    }
  }

  // ONE parse for the whole tree.  The structural scans below share a project;
  // opening one per file turned this gate from seconds into three minutes.
  const sources = scanned.map(({ relative, source }) => ({ path: relative, content: source }));
  const memberUses = findMemberSinkUsesIn(sources, DOM_MEMBER_SINKS);
  const codeSinks = findDynamicCodeSinksIn(sources, SOURCE_CODE_SINKS);
  const jsUrls = findJavascriptUrlsIn(sources);
  const forbiddenRefs = findForbiddenGlobalReferencesIn(sources);
  {
    const relative = '';
    const source = '';
    // FOUR scans, because the sink classes need different machinery — and
    // because two DIFFERENT questions are being asked.
    //
    //   Is it MENTIONED?  For `eval` and `Function`, which this project
    //   references zero times, the reference itself is the violation.  That
    //   question is BOUNDED: every way of laundering one into a call — a
    //   container, a prototype, a proxy, an iterator, a borrowed method — still
    //   has to name it somewhere.  Asking instead whether it is invoked is not
    //   bounded, and six review rounds of `Map` seeds, `Object.create`,
    //   `Proxy.revocable` and `Function.prototype.call.call` were that list
    //   restarting one level up from the spelling regexes: the standard
    //   library, restated by hand.
    //
    //   Is it USED THAT WAY?  `setTimeout` is legitimate 55 times over and
    //   forbidden only with a string; `innerHTML` is forbidden only as an
    //   assignment target.  Those need the value analysis, and its job is now
    //   the small one it can actually finish.
    //
    // Neither is a defence against an author determined to evade it —
    // `globalThis[atob(…)]` defeats any static reading.  The CSP is: no
    // `'unsafe-eval'`, `require-trusted-types-for 'script'`, enforced by the
    // browser and asserted on the BUILT artifact by `check:csp-parity`.
    //   • TEXTUAL sinks (`javascript:`) — string CONTENT with no receiver
    //     and no call chain, so a whole-text regex over both lexings of the
    //     ambiguous `/` is the right tool. Whole-text, not per line, because
    //     a match may span a newline.
    //   • MEMBER DOM sinks (`innerHTML =`, `document.write(…)`) — tokenised,
    //     so the computed spellings reach the same finding the dotted ones do.
    //   • DYNAMIC-CODE sinks — tokenised and walked, so every spelling of
    //     "reference, member accesses, call" is covered structurally rather
    //     than enumerated, and comments cannot produce a finding.
    void relative;
    void source;
  }

  for (const entry of scanned) {
    for (const { label, line } of [
      ...(jsUrls.get(entry.relative) ?? []),
      ...(memberUses.get(entry.relative) ?? []),
      ...(codeSinks.get(entry.relative) ?? []),
      ...(forbiddenRefs.get(entry.relative) ?? []),
    ]) {
      errors.push(`${entry.relative}:${line}: ${label}`);
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

#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-B a11y gate — the semantic hue tokens are used at the right SIZE.
//
// `text-<hue>` and `text-<hue>-on-soft` are DIFFERENT colours.  The design-token
// suite (`apps/web/src/design-system/__tests__/tokens.test.ts`) pins both:
//
//   • `-on-soft` clears 4.5:1 on its soft background AND on the canvas — the
//     normal-text colour (WCAG 1.4.3 AA);
//   • the BARE hue clears only 3:1 in dark mode — enough for LARGE text
//     (1.4.3 large) and for graphical objects (1.4.11 non-text), never for
//     normal text.
//
// Those assertions pin the palette.  This gate pins the USAGE, because nothing
// in the type system distinguishes two strings that both compile.  Eighteen call
// sites had already drifted onto the bare hue for normal text (`role="alert"`
// paragraphs, SLA labels, dispute chips) — a class of defect that reappears the
// moment nobody is checking.
//
// SCOPE.  Every string literal and template chunk in `apps/web/src/**` (`.ts`
// and `.tsx`), LEXED rather than pattern-matched on `className=`: the class name
// reaches the DOM through `cn(...)`, ternaries, class maps, and module constants
// just as often as through a literal attribute, and a guard that sees only the
// last of those cannot enforce the invariant it claims to.  Comments are dropped
// by the lexer, so prose naming a class never trips it.
//
// TWO EXEMPTIONS, both narrow:
//
//   1. `size-<n>` in the same literal — this codebase sizes ICONS that way, and
//      an icon is a graphical object (1.4.11, 3:1).
//   2. An explicit `a11y-bare-hue-ok: <reason>` comment on the offending line or
//      the three lines above it, for a non-text use the lexer cannot recognise
//      (a `<progress>` fill, an SVG stroke).  The reason is REQUIRED — an
//      exemption without a stated reason is indistinguishable from a mistake.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { interpolationSpans, type Token, tokenize } from './js-sink-analyzer.js';

const ROOT = resolve(import.meta.dirname, '..');
export const WEB_SRC = 'apps/web/src';

/**
 * `text-<hue>` NOT followed by `-` (so not `-on-soft`).
 *
 * All FIVE tokens, `primary` included: `tokens.test.ts` asserts the same
 * property of every one of them (`>= 3:1` on the canvas, and in dark mode
 * `< 4.5:1`), so covering only the four "semantic" hues would leave the gate
 * enforcing four fifths of an invariant the palette states about five.  The
 * BottomNav "Submit" tab is the precedent — it was `text-primary` at ~3.3:1 on
 * the dark canvas, and it is not a different defect from `text-error` at 3.35.
 *
 * `:` and `!` join the delimiters so a VARIANT-prefixed class is matched too:
 * `hover:text-error`, `md:text-warning`, `dark:text-info`,
 * `group-hover:text-error`, `[&:focus]:text-error`, `!text-error`.  The colour
 * is still rendered as normal text in that state — a state a user is very
 * likely to be reading in — so the contrast obligation is identical.
 */
const BARE_HUE = /(?:^|[\s'"`{:!])text-(primary|success|warning|error|info)(?![\w-])/;

/** How this codebase sizes an icon — a graphical object, 3:1 under 1.4.11. */
const ICON_SIZE = /(?:^|[\s'"`{])size-\d/;

/** The component that renders an icon here; the ONLY element `size-*` exempts. */
const ICON_ELEMENT = 'Icon';

/** How far back a JSX opening tag may sit from the className literal in it. */
const MAX_TAG_LOOKBACK = 512;

/**
 * The JSX element a literal sits inside — the nearest `<Name` before it.
 *
 * `size-*` alone is NOT enough to exempt a literal: it says the element has a
 * fixed square size, not that it is a graphical object, so
 * `<span className="size-8 text-error">!</span>` is normal text that the size
 * check would wave through.  Pairing the size class with the element that
 * actually renders an icon closes that without demanding a written exemption at
 * the five genuine `<Icon>` call sites.
 *
 * A literal with no element in front of it — a class map entry, a bare
 * constant — resolves to `null` and gets no exemption, which is the right
 * default: those carry no evidence of being non-text, so they need the reasoned
 * marker instead.
 */
function enclosingElement(source: string, at: number): string | null {
  const open = source.lastIndexOf('<', at);
  if (open === -1 || at - open > MAX_TAG_LOOKBACK) return null;
  return /^<\s*([A-Za-z][\w.]*)/.exec(source.slice(open, at))?.[1] ?? null;
}

/** An explicit, REASONED opt-out on a comment line.  `\S` after the colon makes
 *  the reason mandatory: a bare marker would be a silent suppression. */
const EXEMPTION = /(?:\/\/|\/\*|^\s*\*|\{\s*\/\*).*a11y-bare-hue-ok:\s*\S/;

/** A line that is nothing but comment — how far up {@link isExempt} may walk. */
const COMMENT_LINE = /^\s*(?:\/\/|\/\*|\*\/?|\{\s*\/\*)/;

export interface HueFinding {
  readonly file: string;
  readonly line: number;
  readonly hue: string;
  /** The source line, for the failure report. */
  readonly source: string;
}

export interface SourceFile {
  readonly path: string;
  readonly content: string;
}

/** Offsets of every `\n`, ascending — the index `lineOf` binary-searches. */
function newlineIndex(source: string): number[] {
  const offsets: number[] = [];
  for (let i = source.indexOf('\n'); i !== -1; i = source.indexOf('\n', i + 1)) offsets.push(i);
  return offsets;
}

/** 1-based line number of a byte offset. */
function lineOf(newlineOffsets: readonly number[], offset: number): number {
  let low = 0;
  let high = newlineOffsets.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    // biome-ignore lint/style/noNonNullAssertion: `mid` < high <= length.
    if (newlineOffsets[mid]! < offset) low = mid + 1;
    else high = mid;
  }
  return low + 1;
}

/** Nesting depth of `${…}` holes this walk descends into. */
const MAX_INTERPOLATION_DEPTH = 8;

/**
 * Union the string-ish tokens from BOTH regex-preference passes, DESCENDING
 * into template interpolations.
 *
 * The lexer has one undecidable case (`/` opening a regex vs. dividing), and a
 * wrong guess shifts every token after it.  Taking the union means a literal
 * that EITHER pass reads as a string is examined — the fail-closed direction for
 * a gate whose job is to notice class names.
 *
 * The descent is load-bearing, not thoroughness: a template is ONE token, so
 * the nested literal in
 *
 *   className={`base ${bad ? 'text-error' : ''}`}
 *
 * is not emitted separately, and {@link blankInterpolations} then erases its only
 * occurrence before the pattern runs.  That form — a computed class inside a
 * template — would otherwise pass the gate.  Each hole is re-lexed against the
 * ORIGINAL source so the offsets stay absolute and the reported line is right.
 */
function stringTokens(source: string): Token[] {
  const byStart = new Map<number, Token>();
  const visit = (tokens: readonly Token[], preferRegex: boolean, depth: number): void => {
    for (const token of tokens) {
      if (token.kind === 'string') {
        byStart.set(token.start, token);
        continue;
      }
      if (token.kind !== 'template') continue;
      byStart.set(token.start, token);
      if (depth >= MAX_INTERPOLATION_DEPTH) continue;
      for (const span of interpolationSpans(token.value, token.start, preferRegex)) {
        visit(
          tokenize(source, preferRegex, { from: span.offset, stopAtUnmatchedBrace: true }),
          preferRegex,
          depth + 1,
        );
      }
    }
  };
  for (const preferRegex of [false, true]) visit(tokenize(source, preferRegex), preferRegex, 0);
  return [...byStart.values()].sort((a, b) => a.start - b.start);
}

/**
 * A template literal's `${…}` holes hold EXPRESSIONS, not class text.  Blank
 * them — preserving length and newlines so reported offsets stay true — so an
 * interpolated identifier is never read as a class name.  Nothing is lost
 * because {@link stringTokens} DESCENDS into each hole and examines the literals
 * inside it separately; the lexer does not emit them on its own (a template is
 * one token), so the descent is what makes this blanking safe.
 *
 * The hole bounds come from {@link interpolationSpans} rather than a brace
 * counter, for the reason recorded there: a counter is a second, weaker lexer
 * and it mis-read the `}` inside a regex literal.
 */
function blankInterpolations(raw: string): string {
  const blanked = [...raw];
  for (const preferRegex of [false, true]) {
    for (const span of interpolationSpans(raw, 0, preferRegex)) {
      for (let i = span.offset; i < span.offset + span.text.length && i < blanked.length; i += 1) {
        if (blanked[i] !== '\n') blanked[i] = ' ';
      }
    }
  }
  return blanked.join('');
}

/**
 * Whether the class on `line` (1-based) carries a reasoned opt-out.
 *
 * The marker may sit on the line itself (a trailing comment) or ANYWHERE in the
 * contiguous comment block directly above it.  Walking the block rather than a
 * fixed window means the reason can be as long as it needs to be — the point of
 * demanding one is that it explains itself — while still refusing to reach past
 * the first line of real code, so one exemption can never cover the next.
 */
function isExempt(lines: readonly string[], line: number): boolean {
  if (EXEMPTION.test(lines[line - 1] ?? '')) return true;
  for (let i = line - 2; i >= 0; i -= 1) {
    const candidate = lines[i] ?? '';
    if (candidate.trim() === '') continue;
    if (!COMMENT_LINE.test(candidate)) return false;
    if (EXEMPTION.test(candidate)) return true;
  }
  return false;
}

/** Every bare-hue text use in `files` that is neither an icon nor exempted. */
export function findBareHueTextUses(files: readonly SourceFile[]): HueFinding[] {
  const findings: HueFinding[] = [];
  for (const file of files) {
    const newlines = newlineIndex(file.content);
    const lines = file.content.split('\n');
    for (const token of stringTokens(file.content)) {
      const text = token.kind === 'template' ? blankInterpolations(token.value) : token.value;
      // An ICON is a graphical object (WCAG 1.4.11, 3:1).  BOTH halves are
      // required: the size class alone describes a box, not a glyph.
      if (ICON_SIZE.test(text) && enclosingElement(file.content, token.start) === ICON_ELEMENT) {
        continue;
      }
      const match = BARE_HUE.exec(text);
      if (match === null) continue;
      // A template may span lines, so anchor on the HUE rather than the token
      // start: the reported line is where the class actually sits.  `+ 1` skips
      // the delimiter the pattern consumed before `text-`.
      const line = lineOf(newlines, token.start + match.index + 1);
      if (isExempt(lines, line)) continue;
      findings.push({
        file: file.path,
        line,
        // biome-ignore lint/style/noNonNullAssertion: group 1 of a matched regex.
        hue: match[1]!,
        source: (lines[line - 1] ?? '').trim(),
      });
    }
  }
  return findings.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
}

/** Source files this gate reads: web client source, excluding its own tests. */
export function isScannedPath(path: string): boolean {
  if (!path.startsWith(`${WEB_SRC}/`)) return false;
  if (!path.endsWith('.ts') && !path.endsWith('.tsx')) return false;
  return !/\.(?:test|spec)\.tsx?$/.test(path) && !path.includes('/__tests__/');
}

function main(): void {
  const tracked = execFileSync('git', ['ls-files', WEB_SRC], {
    cwd: ROOT,
    encoding: 'utf-8',
    maxBuffer: 32 * 1024 * 1024,
  })
    .split('\n')
    .filter(isScannedPath);

  const files: SourceFile[] = [];
  for (const path of tracked) {
    try {
      files.push({ path, content: readFileSync(resolve(ROOT, path), 'utf-8') });
    } catch {
      // Tracked but absent mid-refactor — skip rather than crash the gate.
    }
  }

  const findings = findBareHueTextUses(files);
  if (findings.length > 0) {
    console.error(
      `check:a11y-hue-usage FAILED — ${findings.length} bare semantic hue(s) on normal text:`,
    );
    for (const finding of findings) {
      console.error(`  - ${finding.file}:${finding.line}  ${finding.source}`);
    }
    console.error(
      '\n  `text-<hue>` clears only 3:1 in dark mode — LARGE text (WCAG 1.4.3) and\n' +
        '  graphical objects (1.4.11), never normal text.  Use `text-<hue>-on-soft`,\n' +
        '  which the token suite pins at >= 4.5:1 on the canvas AND on `bg-<hue>-soft`.\n' +
        '  If the colour is genuinely NOT text (a bar fill, an SVG stroke), say so in\n' +
        '  an `a11y-bare-hue-ok: <reason>` comment on or just above the line.',
    );
    process.exit(1);
  }

  console.log(
    `check:a11y-hue-usage passed: ${files.length} web source files, every semantic hue on normal text uses the -on-soft pair.`,
  );
}

// Run as a CLI only; importing for tests must not trigger the scan.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}

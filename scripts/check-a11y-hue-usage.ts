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
function literalGroups(source: string): LiteralGroup[] {
  const byKey = new Map<string, LiteralGroup>();
  const isLiteral = (token: Token | undefined): boolean =>
    token?.kind === 'string' || token?.kind === 'template';
  const visit = (tokens: readonly Token[], preferRegex: boolean, depth: number): void => {
    for (let i = 0; i < tokens.length; i += 1) {
      const token = tokens[i];
      if (!isLiteral(token) || token === undefined) continue;
      // A maximal `+`-joined run of literals is ONE class string at runtime:
      // `className={'text-' + 'error'}` renders `text-error`, and examining the
      // two halves separately finds neither the utility nor a violation.
      const group: Token[] = [token];
      let j = i + 1;
      while (
        tokens[j]?.kind === 'punct' &&
        tokens[j]?.value === '+' &&
        isLiteral(tokens[j + 1]) &&
        group.length < MAX_CONCAT_OPERANDS
      ) {
        const next = tokens[j + 1];
        if (next === undefined) break;
        group.push(next);
        j += 2;
      }
      byKey.set(group.map((each) => each.start).join(','), { tokens: group, preferRegex });
      if (depth < MAX_INTERPOLATION_DEPTH) {
        for (const part of group) {
          if (part.kind !== 'template') continue;
          for (const span of interpolationSpans(part.value, part.start, preferRegex)) {
            visit(
              tokenize(source, preferRegex, { from: span.offset, stopAtUnmatchedBrace: true }),
              preferRegex,
              depth + 1,
            );
          }
        }
      }
      i = j - 1;
    }
  };
  for (const preferRegex of [false, true]) visit(tokenize(source, preferRegex), preferRegex, 0);
  return [...byKey.values()].sort((a, b) => (a.tokens[0]?.start ?? 0) - (b.tokens[0]?.start ?? 0));
}

/** A `+`-joined run of literals, with the lexing that found it. */
interface LiteralGroup {
  readonly tokens: readonly Token[];
  /** Which `preferRegex` pass produced it — needed to re-read its holes. */
  readonly preferRegex: boolean;
}

/** A runaway guard: no real class expression concatenates this many literals. */
const MAX_CONCAT_OPERANDS = 64;

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

/** A decoded literal, plus the RAW index each decoded unit came from. */
interface Decoded {
  readonly text: string;
  readonly offsets: readonly number[];
}

/** The escapes that stand for one control character. */
const SIMPLE_ESCAPES: ReadonlyMap<string, string> = new Map([
  ['n', '\n'],
  ['t', '\t'],
  ['r', '\r'],
  ['b', '\b'],
  ['f', '\f'],
  ['v', '\v'],
  ['0', '\0'],
]);

/** A code point, or the empty string when the escape does not denote one. */
function codePoint(code: number): string {
  if (!Number.isInteger(code) || code < 0 || code > 0x10ffff) return '';
  return String.fromCodePoint(code);
}

/**
 * Decode a literal's JavaScript escapes, keeping a map back to raw offsets.
 *
 * The gate must read the class the RUNTIME sees, not the characters the source
 * spells it with: `className={'text-error'}` renders `text-error` and puts
 * normal text below the required contrast, while a scan of the raw token text
 * finds nothing.  `\u`, `\u{…}` and `\x` are the forms that can spell a class
 * name; the identity escapes (`\'`, `\\`, and any unrecognised `\c`) are decoded
 * too, since each also changes which characters are adjacent.
 *
 * The offset map is what keeps the REPORT honest.  Decoding shortens the string,
 * so a match index no longer indexes the source — and this gate reports a file
 * and line a person has to open.  Every decoded unit records the raw index of
 * the escape it came from, so the reported line is where the class really sits.
 */
function decodeStringEscapes(raw: string): Decoded {
  if (!raw.includes('\\')) {
    return { text: raw, offsets: Array.from({ length: raw.length }, (_, i) => i) };
  }
  const units: string[] = [];
  const offsets: number[] = [];
  const push = (value: string, at: number): void => {
    // By UTF-16 UNIT, not code point, so the indices stay comparable with the
    // string the regex is run against.
    for (let k = 0; k < value.length; k += 1) {
      units.push(value[k] ?? '');
      offsets.push(at);
    }
  };
  for (let i = 0; i < raw.length; ) {
    const char = raw[i] ?? '';
    if (char !== '\\') {
      push(char, i);
      i += 1;
      continue;
    }
    const next = raw[i + 1] ?? '';
    if (next === 'u' && raw[i + 2] === '{') {
      const close = raw.indexOf('}', i + 3);
      const hex = close === -1 ? '' : raw.slice(i + 3, close);
      if (close !== -1 && /^[0-9a-fA-F]{1,6}$/.test(hex)) {
        push(codePoint(Number.parseInt(hex, 16)), i);
        i = close + 1;
        continue;
      }
    } else if (next === 'u') {
      const hex = raw.slice(i + 2, i + 6);
      if (/^[0-9a-fA-F]{4}$/.test(hex)) {
        push(codePoint(Number.parseInt(hex, 16)), i);
        i += 6;
        continue;
      }
    } else if (next === 'x') {
      const hex = raw.slice(i + 2, i + 4);
      if (/^[0-9a-fA-F]{2}$/.test(hex)) {
        push(codePoint(Number.parseInt(hex, 16)), i);
        i += 4;
        continue;
      }
    }
    const simple = SIMPLE_ESCAPES.get(next);
    if (simple !== undefined) {
      push(simple, i);
      i += 2;
      continue;
    }
    // A LINE CONTINUATION produces nothing at all — and it can therefore join
    // `text-` to a hue across a source line break.
    if (next === '\n') {
      i += 2;
      continue;
    }
    if (next === '\r') {
      i += raw[i + 2] === '\n' ? 3 : 2;
      continue;
    }
    push(next, i); // an identity escape: `\'`, `\"`, `` \` ``, `\\`, or any other
    i += 2;
  }
  return { text: units.join(''), offsets };
}

/**
 * The runtime string a `+`-joined literal group produces, with ABSOLUTE offsets.
 *
 * The delimiters are dropped rather than kept, because the joined value is what
 * the browser receives: `'text-' + 'error'` is `text-error`, and a quote sitting
 * between them exists only in the source.  {@link BARE_HUE} anchors on `^` as
 * well as on a separator, so a class that begins the string still matches while
 * `my-text-error` — a different utility — still does not.
 */
function groupContent(group: LiteralGroup): Decoded {
  const units: string[] = [];
  const offsets: number[] = [];
  const push = (value: string, at: number): void => {
    for (let i = 0; i < value.length; i += 1) {
      units.push(value[i] ?? '');
      offsets.push(at);
    }
  };
  /** Decode `chunk` (raw source text) and append it, mapping back to `at`. */
  const append = (chunk: string, at: number): void => {
    const decoded = decodeStringEscapes(chunk);
    for (let i = 0; i < decoded.text.length; i += 1) {
      push(decoded.text[i] ?? '', at + (decoded.offsets[i] ?? i));
    }
  };

  for (const token of group.tokens) {
    const raw = token.value;
    const inner = () => raw.slice(1, Math.max(1, raw.length - 1));
    if (token.kind !== 'template') {
      append(inner(), token.start + 1);
      continue;
    }
    // A template is chunks and HOLES.  A hole whose expression is statically
    // known is part of the class the browser receives — `` `text-${'error'}` ``
    // renders `text-error` — so it is folded in.  One that is not becomes a
    // single SPACE: dropping it entirely would join the chunks around it and
    // invent a class (`text-${x}error`), which fails a correct build.
    let cursor = 1;
    for (const span of interpolationSpans(raw, 0, group.preferRegex)) {
      const holeAt = Math.max(cursor, span.offset - 2); // the `${`
      append(raw.slice(cursor, holeAt), token.start + cursor);
      const folded = foldStaticHole(span.text, group.preferRegex);
      if (folded === null) push(' ', token.start + holeAt);
      else append(folded, token.start + span.offset);
      cursor = span.offset + span.text.length + 1; // past the closing `}`
    }
    append(raw.slice(cursor, Math.max(cursor, raw.length - 1)), token.start + cursor);
  }
  return { text: units.join(''), offsets };
}

/**
 * A template hole's value when it is statically known, else `null`.
 *
 * Only a literal, or a `+`-joined run of literals, is folded — anything else
 * (an identifier, a call, a ternary) is a value this scan cannot know, and
 * guessing at one would invent class names that never render.
 */
function foldStaticHole(hole: string, preferRegex: boolean): string | null {
  const tokens = tokenize(hole, preferRegex).filter((token) => token.kind !== 'comment');
  if (tokens.length === 0) return null;
  const parts: string[] = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token === undefined) return null;
    if (token.kind !== 'string' && token.kind !== 'template') return null;
    // A template operand with a hole of its own is not statically known here;
    // the descent in `literalGroups` examines it separately.
    if (token.kind === 'template' && token.value.includes('${')) return null;
    parts.push(token.value.slice(1, Math.max(1, token.value.length - 1)));
    const joiner = tokens[i + 1];
    if (joiner === undefined) break;
    if (joiner.kind !== 'punct' || joiner.value !== '+') return null;
    i += 1;
  }
  return parts.join('');
}

/** Every bare-hue text use in `files` that is neither an icon nor exempted. */
export function findBareHueTextUses(files: readonly SourceFile[]): HueFinding[] {
  const findings: HueFinding[] = [];
  for (const file of files) {
    const newlines = newlineIndex(file.content);
    const lines = file.content.split('\n');
    for (const group of literalGroups(file.content)) {
      const start = group.tokens[0]?.start ?? 0;
      // What the RUNTIME sees: the operands joined, delimiters dropped, escapes
      // decoded.  `'text-' + 'error'` is the class `text-error`.
      const { text, offsets } = groupContent(group);
      // An ICON is a graphical object (WCAG 1.4.11, 3:1).  BOTH halves are
      // required: the size class alone describes a box, not a glyph.
      if (ICON_SIZE.test(text) && enclosingElement(file.content, start) === ICON_ELEMENT) {
        continue;
      }
      const match = BARE_HUE.exec(text);
      if (match === null) continue;
      // A template may span lines, so anchor on the HUE rather than the token
      // start: the reported line is where the class actually sits.  `+ 1` skips
      // the delimiter the pattern consumed before `text-`, and the offset map
      // carries that joined index back to the source it was written at.
      const line = lineOf(newlines, offsets[match.index + 1] ?? offsets[match.index] ?? start);
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

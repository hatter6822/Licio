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
//   1. A class that sizes a SQUARE box in the same literal — this codebase sizes
//      ICONS that way — on an element that renders an icon.  An icon is a
//      graphical object (1.4.11, 3:1).  Asked of what the class DECLARES, so
//      `md:size-4` counts and a `w-4` that merely looks similar does not.
//   2. An explicit `a11y-bare-hue-ok: <reason>` comment on the offending line or
//      the three lines above it, for a non-text use the lexer cannot recognise
//      (a `<progress>` fill, an SVG stroke).  The reason is REQUIRED — an
//      exemption without a stated reason is indistinguishable from a mistake.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { interpolationSpans, type Token, tokenize } from './js-sink-analyzer.js';
import { type Declared, readUtilities, type UtilityFacts } from './tailwind-utilities.js';

const ROOT = resolve(import.meta.dirname, '..');
export const WEB_SRC = 'apps/web/src';

// PAIRING IS A CASCADE QUESTION, and the classes are TAILWIND'S to read.
//
// `text-<hue>-fg` is `#FFFFFF`, and the token suite contrast-tests it against
// the SOLID `bg-<hue>` alone — so it is legible exactly where that fill is
// painted, and nowhere else.  Deciding that needs two things: what each class
// paints, and which paint wins where the text renders.
//
// Both were answered here by hand, and both produced a finding a round: a
// hover-only background under always-white text; an `sm:` background replacing
// an unconditional one; an `sm:` background still in force at `sm:hover`; a
// foreground read at one state when it renders in many; the cascade read on
// backgrounds but not on inks; `!important` in one of its two spellings; an
// opacity modifier; a colon inside an arbitrary value.  Every fix was right and
// the next one was always there, because the list was never a list of bugs — it
// was Tailwind's grammar and the CSS cascade, restated badly.
//
// So `tailwind-utilities` asks Tailwind instead, and the questions dissolve:
// `bg-center` paints no colour, `[color:red]` paints one with no `text-` prefix,
// `bg-(--licio-error)` is the error fill, `bg-error/50` is a BLEND of it and so
// is not the flat colour anything was measured against, and both `!bg-canvas`
// and `bg-canvas!` are `!important`.  What is left here is the POLICY — which
// colours may carry normal text — expressed against resolved values rather than
// against the spelling of a class.

/** The five semantic hues, spelled once for every rule that names them. */
const HUES: readonly string[] = ['primary', 'success', 'warning', 'error', 'info'];

/** One class token in a string, and where it sits. */
interface Candidate {
  readonly name: string;
  readonly at: number;
}

/**
 * The class tokens in a string.
 *
 * Whitespace is the ONLY separator, because it is the only one a `class`
 * attribute has — and it is also what an unknown template hole folds to.  What
 * counts as a utility is not decided here at all: anything Tailwind does not
 * recognise simply paints nothing.
 */
function candidates(text: string): Candidate[] {
  const found: Candidate[] = [];
  for (const match of text.matchAll(/\S+/g)) {
    found.push({ name: match[0], at: match.index ?? 0 });
  }
  return found;
}

/** A colour a class paints, with everything needed to place it in the cascade. */
interface Paint {
  readonly candidate: Candidate;
  readonly declared: Declared;
  readonly order: bigint;
}

/** Every paint of one property among `all`, in the class's own order. */
function paintsOf(
  all: readonly Candidate[],
  facts: UtilityFacts,
  property: 'color' | 'background-color',
): Paint[] {
  const paints: Paint[] = [];
  for (const candidate of all) {
    const order = facts.orderOf(candidate.name);
    if (order === undefined) continue;
    for (const declared of facts.declarationsOf(candidate.name)) {
      if (declared.property !== property) continue;
      paints.push({ candidate, declared, order });
    }
  }
  return paints;
}

/** Everything that must hold for a declaration to render. */
function conditionsOf(declared: Declared): string[] {
  return declared.demand === '' ? [...declared.atRules] : [...declared.atRules, declared.demand];
}

/** Whether every condition of `paint` holds in `state`. */
function activeIn(paint: Paint, state: readonly string[]): boolean {
  return conditionsOf(paint.declared).every((condition) => state.includes(condition));
}

/**
 * Whether `contender` is painted over `other` wherever both apply.
 *
 * The CSS cascade, with every input coming from Tailwind rather than from the
 * spelling of a class: `!important` first, then SPECIFICITY, then order.
 *
 * Specificity lives entirely in the selector — an at-rule adds none — so a
 * declaration that demands something of the selector outranks one that demands
 * nothing, and two that make the SAME demand (including none at all) are equally
 * specific.  Between those the cascade consults stylesheet order, which is
 * exactly what Tailwind's own class order reports: `sm:bg-canvas md:bg-error` is
 * decided, not tied, and so is `bg-canvas bg-error`.  A `className` attribute's
 * order is consulted nowhere, because it means nothing.
 *
 * Two DIFFERENT selector demands (`:hover` against `:focus`) would be settled by
 * counting specificity, which these facts do not carry; neither outranks, so
 * both stay candidates and both have to be legible.
 */
function outranks(contender: Paint, other: Paint): boolean {
  const mine = contender.declared;
  const theirs = other.declared;
  if (mine.important !== theirs.important) return mine.important;
  if (mine.demand !== theirs.demand) return theirs.demand === '';
  return contender.order > other.order;
}

/** The paints that could be the one showing in `state`. */
function paintedIn(paints: readonly Paint[], state: readonly string[]): Paint[] {
  const active = paints.filter((paint) => activeIn(paint, state));
  return active.filter((one) => !active.some((other) => outranks(other, one)));
}

/**
 * The value a reference class paints — `text-error` → `var(--licio-error)`.
 *
 * This is how a hue is RECOGNISED: not by the spelling of a class, but by the
 * colour it resolves to, so every other spelling of the same colour is caught
 * with it.  A missing answer means the theme no longer defines the token the
 * whole policy is about, which is a reason to stop rather than to report clean.
 */
function referenceValue(facts: UtilityFacts, candidate: string, property: string): string {
  const declared = facts
    .declarationsOf(candidate)
    .filter((entry) => entry.property === property && conditionsOf(entry).length === 0);
  const value = declared[declared.length - 1]?.value;
  if (value === undefined) {
    throw new Error(
      `check:a11y-hue-usage: Tailwind resolves no ${property} for "${candidate}"; the ` +
        'semantic hue tokens this gate is about are not in the design system.',
    );
  }
  return value;
}

/** The reference colours of one hue, as the design system resolves them. */
interface HueColors {
  readonly hue: string;
  /** `text-<hue>` — 3:1, never normal text. */
  readonly bare: string;
  /** `text-<hue>-fg` — white, measured against the solid fills alone. */
  readonly foreground: string;
  /** The fills `-fg` was measured on. */
  readonly solid: readonly string[];
}

function hueColors(facts: UtilityFacts): HueColors[] {
  return HUES.map((hue) => ({
    hue,
    bare: referenceValue(facts, `text-${hue}`, 'color'),
    foreground: referenceValue(facts, `text-${hue}-fg`, 'color'),
    solid: [`bg-${hue}`, `bg-${hue}-hover`, `bg-${hue}-active`]
      .filter((fill) => facts.orderOf(fill) !== undefined)
      .map((fill) => referenceValue(facts, fill, 'background-color')),
  }));
}

/**
 * Every class name a hue's reference colour needs to be judged through.
 *
 * Included in the batch so `referenceValue` has them, whether or not the source
 * happens to use them.
 */
function hueReferenceCandidates(): string[] {
  return HUES.flatMap((hue) => [
    `text-${hue}`,
    `text-${hue}-fg`,
    `bg-${hue}`,
    `bg-${hue}-hover`,
    `bg-${hue}-active`,
  ]);
}

/**
 * Whether a painted colour IS the reference one, rather than derived from it.
 *
 * An opacity modifier compiles to `color-mix(… var(--licio-error) 50%, …)`:
 * still that hue, no longer that colour.  So `mentions` is what identifies a
 * hue — every spelling that lands on the token, blended or not — while an exact
 * match is what identifies the flat colour the contrast suite measured.
 */
function mentions(value: string, reference: string): boolean {
  return value === reference || value.includes(reference);
}

/** The bare-hue inks in `all` — the 3:1 colour carrying normal text. */
function bareHuePaints(all: readonly Candidate[], facts: UtilityFacts, hues: readonly HueColors[]) {
  const found: Array<{ candidate: Candidate; hue: string }> = [];
  for (const paint of paintsOf(all, facts, 'color')) {
    for (const colors of hues) {
      if (!mentions(paint.declared.value, colors.bare)) continue;
      found.push({ candidate: paint.candidate, hue: colors.hue });
    }
  }
  return found;
}

/**
 * The `-fg` inks that do not render on the fill they were measured against.
 *
 * `-fg` is `#FFFFFF` and was contrast-tested on the SOLID `bg-<hue>` alone, so
 * it is legible exactly where that fill is showing — and it shows in every state
 * its own conditions survive into, not only the one they name.  Each such state
 * is tried, one per background, which is provably enough: if some reachable
 * state shows a bad fill, so does the state built from that fill's conditions.
 *
 * The cascade governs the INK the same way, so a state only counts where this
 * ink is still one of the colours that could be showing.
 */
function unpairedForegrounds(
  all: readonly Candidate[],
  facts: UtilityFacts,
  hues: readonly HueColors[],
) {
  const inks = paintsOf(all, facts, 'color');
  const fills = paintsOf(all, facts, 'background-color');
  const found: Array<{ candidate: Candidate; hue: string }> = [];
  for (const ink of inks) {
    for (const colors of hues) {
      if (!mentions(ink.declared.value, colors.foreground)) continue;
      // A BLENDED `-fg` is no longer the colour that was measured, wherever it
      // lands — so it needs no state to be wrong in.
      const broken =
        ink.declared.value !== colors.foreground ||
        [
          conditionsOf(ink.declared),
          ...fills.map((fill) => [...conditionsOf(ink.declared), ...conditionsOf(fill.declared)]),
        ].some((state) => {
          if (!paintedIn(inks, state).includes(ink)) return false;
          const showing = paintedIn(fills, state);
          return (
            showing.length === 0 ||
            !showing.every((fill) => colors.solid.includes(fill.declared.value))
          );
        });
      if (broken) found.push({ candidate: ink.candidate, hue: colors.hue });
    }
  }
  return found;
}

/**
 * Whether a class sizes a square box — how this codebase sizes ICONS.
 *
 * Asked of the DECLARATIONS rather than the name, so `md:size-4` counts and a
 * `w-4` that only looks similar does not.
 */
function isSquareSize(facts: UtilityFacts, candidate: string): boolean {
  const declared = facts.declarationsOf(candidate);
  const width = declared.find((entry) => entry.property === 'width')?.value;
  const height = declared.find((entry) => entry.property === 'height')?.value;
  return width !== undefined && width === height;
}

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
    const grouping = groupingParens(tokens);
    for (let i = 0; i < tokens.length; i += 1) {
      const token = tokens[i];
      if (!isLiteral(token) || token === undefined) continue;
      // A maximal `+`-joined run of literals is ONE class string at runtime:
      // `className={'text-' + 'error'}` renders `text-error`, and examining the
      // two halves separately finds neither the utility nor a violation.
      const group: Token[] = [token];
      let j = i + 1;
      while (group.length < MAX_CONCAT_OPERANDS) {
        const plus = skipTransparent(tokens, j, grouping);
        if (tokens[plus]?.kind !== 'punct' || tokens[plus]?.value !== '+') break;
        const operand = skipTransparent(tokens, plus + 1, grouping);
        const next = tokens[operand];
        if (!isLiteral(next) || next === undefined) break;
        group.push(next);
        j = operand + 1;
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

/**
 * Indices of `(`/`)` tokens that GROUP rather than call.
 *
 * `('text-') + 'error'` renders `text-error`; `f('text-') + 'error'` does not,
 * and folding it would invent a class that never renders — a false positive
 * that fails a correct build.  The two differ by one token: a `(` directly
 * after an identifier, `)` or `]` opens a CALL or an index.  Anything else —
 * including a keyword, which this lexer also reports as an identifier, so
 * `return ('a') + 'b'` conservatively does not fold — leaves the run unextended.
 *
 * One linear pass with a stack, so the question is answered once per lexing
 * rather than re-derived at each operand.
 */
function groupingParens(tokens: readonly Token[]): ReadonlySet<number> {
  const grouping = new Set<number>();
  const open: Array<{ index: number; isGroup: boolean }> = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token?.kind !== 'punct') continue;
    if (token.value === '(') {
      const before = tokens[i - 1];
      const isCall =
        before?.kind === 'ident' ||
        (before?.kind === 'punct' && (before.value === ')' || before.value === ']'));
      open.push({ index: i, isGroup: !isCall });
      continue;
    }
    if (token.value !== ')') continue;
    const start = open.pop();
    if (start?.isGroup === true) {
      grouping.add(start.index);
      grouping.add(i);
    }
  }
  return grouping;
}

/**
 * Past tokens that carry no characters between two concatenation operands:
 * grouping parentheses, and an `as`/`satisfies` naming a single-word type.
 *
 * A more elaborate type is left alone — the run simply does not extend, which
 * is the direction that cannot invent a class.
 */
function skipTransparent(
  tokens: readonly Token[],
  from: number,
  grouping: ReadonlySet<number>,
): number {
  let i = from;
  for (let hop = 0; hop < MAX_CONCAT_OPERANDS && i < tokens.length; hop += 1) {
    const token = tokens[i];
    if (token?.kind === 'punct' && grouping.has(i)) {
      i += 1;
      continue;
    }
    if (
      token?.kind === 'ident' &&
      (token.value === 'as' || token.value === 'satisfies') &&
      tokens[i + 1]?.kind === 'ident'
    ) {
      i += 2;
      continue;
    }
    return i;
  }
  return i;
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
    for (const piece of templatePieces(raw, group.preferRegex)) {
      if (piece.kind === 'chunk') {
        append(piece.text, token.start + piece.at);
        continue;
      }
      const folded = foldStaticHole(piece.text, group.preferRegex);
      // An unknown hole becomes a single SPACE: dropping it would join the
      // chunks around it and invent a class.
      if (folded === null) push(' ', token.start + piece.at);
      else append(folded, token.start + piece.at);
    }
  }
  return { text: units.join(''), offsets };
}

/** A literal run of a template, or one `${…}` hole, with its offset in `raw`. */
interface TemplatePiece {
  readonly kind: 'chunk' | 'hole';
  /** For a chunk, its source text; for a hole, the EXPRESSION between the braces. */
  readonly text: string;
  /** Offset within `raw`: a chunk's first character, or a hole's `${`. */
  readonly at: number;
}

/**
 * Split a template (backticks included) into its chunks and holes.
 *
 * ONE walk, because two consumers want the same split for different reasons —
 * building the class string with offsets, and folding a nested template to a
 * plain value.  They had the same hole-bounds arithmetic written out twice, and
 * an off-by-one fixed in one of them would have silently not been fixed in the
 * other.  What differs between the callers is only what an UNKNOWN hole means,
 * so that is all they decide.
 */
function* templatePieces(raw: string, preferRegex: boolean): Generator<TemplatePiece> {
  let cursor = 1; // past the opening backtick
  for (const span of interpolationSpans(raw, 0, preferRegex)) {
    const holeAt = Math.max(cursor, span.offset - 2); // the `${`
    yield { kind: 'chunk', text: raw.slice(cursor, holeAt), at: cursor };
    yield { kind: 'hole', text: span.text, at: holeAt };
    cursor = span.offset + span.text.length + 1; // past the closing `}`
  }
  yield { kind: 'chunk', text: raw.slice(cursor, Math.max(cursor, raw.length - 1)), at: cursor };
}

/**
 * A whole template's value when every hole in it is statically known.
 *
 * `raw` includes its backticks.  Returns `null` the moment one hole is a
 * runtime value, because a partially-known class is not a class.
 */
function foldStaticTemplate(raw: string, preferRegex: boolean, depth: number): string | null {
  if (depth > MAX_INTERPOLATION_DEPTH) return null;
  let out = '';
  for (const piece of templatePieces(raw, preferRegex)) {
    if (piece.kind === 'chunk') {
      out += piece.text;
      continue;
    }
    const folded = foldStaticHole(piece.text, preferRegex, depth + 1);
    if (folded === null) return null; // one unknown hole and the whole is unknown
    out += folded;
  }
  return out;
}

/**
 * A template hole's value when it is statically known, else `null`.
 *
 * Only a literal, or a `+`-joined run of literals, is folded — anything else
 * (an identifier, a call, a ternary) is a value this scan cannot know, and
 * guessing at one would invent class names that never render.
 */
function foldStaticHole(hole: string, preferRegex: boolean, depth = 0): string | null {
  if (depth > MAX_INTERPOLATION_DEPTH) return null;
  const tokens: Token[] = [];
  for (const token of tokenize(hole, preferRegex)) {
    if (token.kind === 'comment') continue;
    // Wrappers that yield the value they wrap: `('error')` renders exactly what
    // `'error'` does, and a `('error' as const)` does too.  Including them in
    // the run is what made an otherwise static hole read as unknown.
    if (token.kind === 'punct' && (token.value === '(' || token.value === ')')) continue;
    // `as` / `satisfies` open a TYPE, which contributes no characters.
    if (token.kind === 'ident' && (token.value === 'as' || token.value === 'satisfies')) break;
    tokens.push(token);
  }
  if (tokens.length === 0) return null;
  const parts: string[] = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token === undefined) return null;
    if (token.kind !== 'string' && token.kind !== 'template') return null;
    // A template operand with a hole of its own is not statically known here;
    // the descent in `literalGroups` examines it separately.
    if (token.kind === 'template' && token.value.includes('${')) {
      // A template with holes of its OWN: fold it the same way, so
      // `` `text-${`${'error'}`}` `` reads as the class it renders.  Recursion
      // rather than a second rule — the nesting has no depth limit in source,
      // and `MAX_INTERPOLATION_DEPTH` already bounds how far this walks.
      const inner = foldStaticTemplate(token.value, preferRegex, depth + 1);
      if (inner === null) return null;
      parts.push(inner);
      continue;
    }
    parts.push(token.value.slice(1, Math.max(1, token.value.length - 1)));
    const joiner = tokens[i + 1];
    if (joiner === undefined) break;
    if (joiner.kind !== 'punct' || joiner.value !== '+') return null;
    i += 1;
  }
  return parts.join('');
}

/** One folded class string, and where its characters came from. */
interface Scanned {
  readonly file: SourceFile;
  readonly start: number;
  readonly text: string;
  readonly offsets: readonly number[];
  readonly all: readonly Candidate[];
}

/** Fold every literal group in `files` into the class strings it renders. */
function scan(files: readonly SourceFile[]): Scanned[] {
  const scanned: Scanned[] = [];
  for (const file of files) {
    for (const group of literalGroups(file.content)) {
      // What the RUNTIME sees: the operands joined, delimiters dropped, escapes
      // decoded.  `'text-' + 'error'` is the class `text-error`.
      const { text, offsets } = groupContent(group);
      const all = candidates(text);
      if (all.length === 0) continue;
      scanned.push({ file, start: group.tokens[0]?.start ?? 0, text, offsets, all });
    }
  }
  return scanned;
}

/**
 * Every bare-hue text use in `files` that is neither an icon nor exempted.
 *
 * Asynchronous because the design system is: every class here is resolved by
 * Tailwind, in ONE batch for the whole run, so no part of its grammar has to be
 * anticipated by this file.
 */
export async function findBareHueTextUses(files: readonly SourceFile[]): Promise<HueFinding[]> {
  const scanned = scan(files);
  const facts = await readUtilities([
    ...hueReferenceCandidates(),
    ...scanned.flatMap((entry) => entry.all.map((candidate) => candidate.name)),
  ]);
  const hues = hueColors(facts);

  const findings: HueFinding[] = [];
  for (const entry of scanned) {
    const { file, all } = entry;
    // An ICON is a graphical object (WCAG 1.4.11, 3:1), which is why the BARE
    // hue is allowed on one.  BOTH halves are required: a square size describes
    // a box, not a glyph.
    //
    // It does NOT excuse a `-fg` token.  That one is white and is tested only
    // against its matching SOLID background, so `<Icon className="size-4
    // text-error-fg" />` on the canvas is near-invisible whether or not the
    // glyph counts as graphical — 1.4.11 asks for 3:1 against the ADJACENT
    // colour, and white on near-white clears nothing.
    const isIcon =
      all.some((candidate) => isSquareSize(facts, candidate.name)) &&
      enclosingElement(file.content, entry.start) === ICON_ELEMENT;
    // EVERY offending class, not the first: one string can carry several, and
    // the earlier ones may be perfectly paired.
    const offenders = [
      ...(isIcon ? [] : bareHuePaints(all, facts, hues)),
      ...unpairedForegrounds(all, facts, hues),
    ];
    const match = offenders.sort((left, right) => left.candidate.at - right.candidate.at)[0];
    if (match === undefined) continue;
    // A template may span lines, so anchor on the CLASS rather than the token
    // start: the reported line is where it actually sits, and the offset map
    // carries that folded index back to the source.
    const newlines = newlineIndex(file.content);
    const line = lineOf(newlines, entry.offsets[match.candidate.at] ?? entry.start);
    const lines = file.content.split('\n');
    if (isExempt(lines, line)) continue;
    findings.push({
      file: file.path,
      line,
      hue: match.hue,
      source: (lines[line - 1] ?? '').trim(),
    });
  }
  return findings.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
}

/** Source files this gate reads: web client source, excluding its own tests. */
export function isScannedPath(path: string): boolean {
  if (!path.startsWith(`${WEB_SRC}/`)) return false;
  if (!path.endsWith('.ts') && !path.endsWith('.tsx')) return false;
  return !/\.(?:test|spec)\.tsx?$/.test(path) && !path.includes('/__tests__/');
}

async function main(): Promise<void> {
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

  const findings = await findBareHueTextUses(files);
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
  main().catch((error: unknown) => {
    console.error('check:a11y-hue-usage FAILED to run:', error);
    process.exit(1);
  });
}

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
import { renderTokensCss } from '../apps/web/src/design-system/css.js';
import { breakpoints } from '../apps/web/src/design-system/tokens.js';
import { interpolationSpans, type Token, tokenize } from './js-sink-analyzer.js';

const ROOT = resolve(import.meta.dirname, '..');
export const WEB_SRC = 'apps/web/src';

/**
 * Where a class STARTS in a string, and where it ends.
 *
 * Spelled ONCE because four patterns need it — the bare hue, the `-fg` token,
 * its paired background, and the icon size — and they had three spellings
 * between them: `ICON_SIZE` omitted `:` and `!`, so a variant-prefixed
 * `md:size-4` did not read as a size and an icon carrying one lost its
 * exemption.  A rule that four patterns each restate is a rule that disagrees
 * with itself the first time one of them is edited.
 *
 * The separators include `:` and `!` so a VARIANT-prefixed class matches:
 * `hover:text-error`, `md:text-warning`, `[&:focus]:text-error`, `!text-error`.
 * The colour is still rendered as normal text in that state — a state a user is
 * very likely to be reading in — so the contrast obligation is identical.
 */
// PAIRING IS A CASCADE QUESTION, not a text-matching one.
//
// `text-<hue>-fg` is `#FFFFFF`, and the token suite contrast-tests it against
// the SOLID `bg-<hue>` alone — so it is legible exactly where that fill is
// painted, and nowhere else.  Deciding that means knowing which background is
// in force where the text renders, which four regexes searching for token names
// could not express.  Each round found the next state they got wrong: a
// hover-only background under always-white text, an `sm:` background replacing
// an unconditional one, and an `sm:` background still in force at `sm:hover`.
//
// Modelling the utilities fixed the parse, but the FIRST cut still asked the
// question once — at the foreground's own state — and a foreground is active in
// every state that includes its conditions.  `bg-error text-error-fg
// sm:bg-canvas` is the whole class of misses: read at the empty state the pair
// is perfect, and at `sm` the canvas is under white text.  So each foreground is
// checked in every state it survives into, one per background's conditions,
// which is provably enough — if some state paints a bad fill, the state formed
// from that fill's own conditions paints it too.
//
// Nor does the class attribute decide WHICH background wins: Tailwind sorts its
// output, so within one attribute order carries no cascade meaning at all.  What
// does decide it is CSS's own priority — `!important` first, then conditions,
// since extra conditions mean a later media block, a pseudo-class, or both.
// Where that leaves two backgrounds genuinely tied, the honest answer is that
// the class string does not say, so BOTH have to be solid.

/** The five semantic hues, spelled once for every rule that names them. */
const HUES: ReadonlySet<string> = new Set(['primary', 'success', 'warning', 'error', 'info']);

/**
 * One utility as Tailwind reads it: its VARIANT conditions and the utility name.
 *
 * A class is `variant:variant:utility`, with an optional importance marker.
 * Splitting on whitespace and then on `:` — both OUTSIDE any `[…]` value — is
 * the whole parse, and it replaces four regexes that each embedded their own
 * idea of where a class starts, what a variant prefix looks like and how one
 * ends.  Those regexes could ask "is this token present" but not "is this
 * background IN FORCE where that text renders", which is the question the
 * pairing rule actually turns on.
 */
interface Utility {
  /** The conditions, in source order: `sm:hover:` → `['sm', 'hover']`. */
  readonly variants: readonly string[];
  /** The utility itself, importance stripped: `sm:hover:bg-error!` → `bg-error`. */
  readonly name: string;
  /** Whether it carries the important marker, which outranks everything. */
  readonly important: boolean;
  /** Index of the utility's first character within the class string. */
  readonly at: number;
}

/**
 * Tailwind's important marker, in BOTH of its spellings.
 *
 * v4 moved it to the end (`bg-canvas!`); the v3 leading form (`!bg-canvas`) is
 * no longer a utility and renders nothing.  Reading either as important is the
 * safe direction for a gate: a class string carrying the dead v3 form is broken
 * whichever way it is read, and treating it as inert would hide that.
 */
const IMPORTANT = /^!|!$/;

/**
 * Characters that END a utility — but only outside an arbitrary value.
 *
 * Whitespace separates classes; the rest are the JavaScript punctuation a class
 * string can sit against once the folding layer has joined its operands.
 */
const CLASS_BREAK: ReadonlySet<string> = new Set([
  ' ',
  '\t',
  '\n',
  '\r',
  '\f',
  "'",
  '"',
  '`',
  '{',
  '}',
  '(',
  ')',
  ',',
  ';',
]);

/**
 * The utility spans in a class string, bracket-aware.
 *
 * An ARBITRARY VALUE is written `[…]` and may contain any of the characters that
 * otherwise end a class: `bg-[rgb(255,0,0)]` holds parentheses and commas, and
 * `[@media(min-width:100px)]:bg-canvas` holds them in a VARIANT.  Ending the
 * span at the first `(` cut those into fragments, and a background reduced to a
 * fragment stops taking part in the cascade — which is the direction that hides
 * a defect rather than inventing one.
 */
function classSpans(text: string): Array<{ start: number; end: number }> {
  const spans: Array<{ start: number; end: number }> = [];
  let depth = 0;
  let start = -1;
  for (let index = 0; index <= text.length; index += 1) {
    const character = text[index];
    const inValue = depth > 0;
    if (character === '[') depth += 1;
    else if (character === ']') depth = Math.max(0, depth - 1);
    if (character === undefined || (!inValue && CLASS_BREAK.has(character))) {
      if (start !== -1) spans.push({ start, end: index });
      start = -1;
    } else if (start === -1) {
      start = index;
    }
  }
  return spans;
}

/**
 * Split on the separators Tailwind reads as separators — those OUTSIDE `[…]`.
 *
 * `:` divides a variant from what it qualifies, and an arbitrary value may
 * contain one of its own: `bg-[color:white]` is a single utility, and
 * `[&:focus]:bg-error` is a single variant on one.  Splitting on every `:` read
 * the first as a variant `bg-[color` qualifying a utility `white]` — no utility
 * at all, so an important arbitrary fill dropped out of the cascade silently.
 */
function splitOutsideValues(token: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < token.length; index += 1) {
    const character = token[index];
    if (character === '[') depth += 1;
    else if (character === ']') depth = Math.max(0, depth - 1);
    else if (character === ':' && depth === 0) {
      parts.push(token.slice(start, index));
      start = index + 1;
    }
  }
  parts.push(token.slice(start));
  return parts;
}

/** Split a class string into utilities, keeping each one's offset. */
function utilities(text: string): Utility[] {
  const found: Utility[] = [];
  for (const span of classSpans(text)) {
    const token = text.slice(span.start, span.end);
    const parts = splitOutsideValues(token);
    const raw = parts.pop() ?? '';
    const name = raw.replace(/^!/, '').replace(/!$/, '');
    if (name === '') continue;
    found.push({
      variants: parts,
      name,
      important: IMPORTANT.test(raw),
      at: span.start + token.length - raw.length,
    });
  }
  return found;
}

/**
 * Whether a utility's conditions all hold wherever `state` holds.
 *
 * An UNCONDITIONAL utility is active everywhere; `sm:bg-canvas` is active at
 * `sm:hover` because `sm` still holds there.  Requiring the prefixes to be
 * EQUAL missed exactly that: `bg-error sm:bg-canvas sm:hover:text-error-fg`
 * found no `sm:hover:` background, fell back to the unconditional `bg-error`,
 * and called white-on-canvas paired.
 */
function activeIn(utility: Utility, state: readonly string[]): boolean {
  return utility.variants.every((variant) => state.includes(variant));
}

/** The solid fills a `-fg` token is contrast-tested against. */
function isSolidFill(name: string, hue: string): boolean {
  return name === `bg-${hue}` || name === `bg-${hue}-hover` || name === `bg-${hue}-active`;
}

/**
 * Every colour Tailwind builds a `bg-*` utility from here, read from the SSOT
 * that GENERATES the theme rather than from a list kept alongside it.
 */
const themeColors: ReadonlySet<string> = new Set(
  [...renderTokensCss().matchAll(/--color-([a-z0-9-]+)\s*:/g)].map((match) => match[1] ?? ''),
);

// A colour set that came back empty — a renamed custom property, a generator
// that stopped emitting the block — would make every `-fg` look unbacked and
// bury the real findings under noise.  Fail on the spot instead.
for (const hue of HUES) {
  if (!themeColors.has(hue)) {
    throw new Error(
      `check:a11y-hue-usage: the generated theme declares no --color-${hue}; the pairing ` +
        'rule cannot name the fills it judges.',
    );
  }
}

/** Colour keywords CSS supplies itself, which no theme has to declare. */
const CSS_COLOR_KEYWORDS: ReadonlySet<string> = new Set([
  'transparent',
  'current',
  'inherit',
  'black',
  'white',
]);

/**
 * Whether a utility SETS a colour on `property` (`bg` fills, `text` inks).
 *
 * Both prefixes are shared with utilities that set no colour at all — `bg-` with
 * size, position, repeat, origin, clip and blend; `text-` with the size, align
 * and wrap scales — and under a rule that requires every candidate to be the
 * right colour, one `bg-center` or `text-sm` in the string would fail a correct
 * build.  Four things are colours: a name the theme declares, a keyword CSS
 * supplies, and anything Tailwind resolves on its own — a default-palette step
 * (`red-500`) or an arbitrary value (`[#fff]`).  Those last two are colours this
 * design system never issued, so they can never be the solid hue, which is the
 * reading that reports them rather than waving them through.
 */
function isColorUtility(name: string, property: 'bg' | 'text'): boolean {
  const prefix = `${property}-`;
  if (!name.startsWith(prefix)) return false;
  const colour = name.slice(prefix.length);
  return (
    themeColors.has(colour) ||
    CSS_COLOR_KEYWORDS.has(colour) ||
    /-\d{2,3}$/.test(colour) ||
    colour.startsWith('[')
  );
}

/**
 * The breakpoints, in the order Tailwind emits their media blocks — read from
 * the token SSOT, so a new one participates without being named again here.
 * Index 0 is "unprefixed", which every media block is emitted after.
 */
const BREAKPOINT_ORDER: readonly string[] = ['', ...Object.keys(breakpoints)];

/** The widest breakpoint a utility waits for; 0 when it waits for none. */
function breakpointRank(variants: readonly string[]): number {
  let rank = 0;
  for (const variant of variants) {
    rank = Math.max(rank, BREAKPOINT_ORDER.indexOf(variant));
  }
  return rank;
}

/** The conditions that are NOT a breakpoint: pseudo-classes, `dark`, arbitrary. */
function selectorVariants(variants: readonly string[]): string[] {
  return variants.filter((variant) => !BREAKPOINT_ORDER.includes(variant));
}

/**
 * Whether `contender` is painted over `other` wherever both are active.
 *
 * The class attribute does NOT decide this: Tailwind sorts its own output, so
 * the order two utilities appear in a `className` carries no cascade meaning.
 * What decides it is CSS, along two independent axes — a selector condition
 * (`hover`, `dark`, an arbitrary variant) adds specificity, and a breakpoint
 * moves the rule into a later media block.  A utility wins when it is at least
 * as far along BOTH and strictly further along one; `sm:bg-a md:bg-b` is the
 * ordinary responsive override that a set-inclusion test alone would call a tie.
 *
 * Importance precedes both, since `!important` outranks any specificity.
 */
function outranks(contender: Utility, other: Utility): boolean {
  if (contender.important !== other.important) return contender.important;
  const selectors = selectorVariants(contender.variants);
  const rivals = selectorVariants(other.variants);
  if (!rivals.every((variant) => selectors.includes(variant))) return false;
  const reach = breakpointRank(contender.variants);
  const rivalReach = breakpointRank(other.variants);
  if (reach < rivalReach) return false;
  return selectors.length > rivals.length || reach > rivalReach;
}

/**
 * The backgrounds that could be the one painted in `state`.
 *
 * Usually exactly one.  Two that neither outranks — identical conditions, or
 * conditions that simply do not compare — leave the winner unstated by the class
 * string, so both are returned rather than guessed between.
 */
function paintedIn(backgrounds: readonly Utility[], state: readonly string[]): Utility[] {
  const active = backgrounds.filter((background) => activeIn(background, state));
  return active.filter((one) => !active.some((other) => outranks(other, one)));
}

/**
 * The `text-<hue>-fg` utilities whose background does NOT hold where they render.
 *
 * `-fg` is `#FFFFFF` and the token suite contrast-tests it against the SOLID
 * `bg-<hue>` alone, so it is legible exactly where that fill is in force — and
 * it renders in EVERY state its own conditions survive into, not just the one
 * they name.  `bg-error text-error-fg sm:bg-canvas` is the pair that reads
 * perfectly at the empty state and puts white on the canvas at `sm`.
 *
 * So each state is tried: the foreground's own, and its own widened by each
 * background's conditions.  That is provably every state worth trying — if some
 * reachable state paints a bad fill, the state built from that fill's own
 * conditions paints it too, because narrowing to those conditions can only
 * remove rivals that were already losing to it.
 *
 * The cascade governs the TEXT colour the same way, and a rule applied to one
 * side only reports the wrong half: in `bg-error text-error-fg sm:bg-warning
 * sm:text-warning-fg` the error token is not painted at `sm` at all, because the
 * warning token outranks it there.  So a state counts only where this foreground
 * is still one of the possible inks.
 *
 * `bg-<hue>-soft` is deliberately not solid: it is a pale tint (`error-soft` is
 * `#FBE7E5`) where white is the same defect as on the canvas.
 */
function unpairedForegrounds(all: readonly Utility[]): Utility[] {
  const backgrounds = all.filter((utility) => isColorUtility(utility.name, 'bg'));
  const inks = all.filter((utility) => isColorUtility(utility.name, 'text'));
  const unpaired: Utility[] = [];
  for (const utility of all) {
    const hue = /^text-(\w+)-fg$/.exec(utility.name)?.[1];
    if (hue === undefined || !HUES.has(hue)) continue;
    const states = [
      utility.variants,
      ...backgrounds.map((background) => [...utility.variants, ...background.variants]),
    ];
    const broken = states.some((state) => {
      if (!paintedIn(inks, state).includes(utility)) return false;
      const painted = paintedIn(backgrounds, state);
      return painted.length === 0 || !painted.every((fill) => isSolidFill(fill.name, hue));
    });
    if (broken) unpaired.push(utility);
  }
  return unpaired;
}

/** The BARE `text-<hue>` utilities — no suffix, so not `-on-soft` or `-fg`. */
function bareHues(all: readonly Utility[]): Utility[] {
  return all.filter((utility) => {
    const hue = /^text-(\w+)$/.exec(utility.name)?.[1];
    return hue !== undefined && HUES.has(hue);
  });
}

const ICON_SIZE = /^size-\d/;

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
      // An ICON is a graphical object (WCAG 1.4.11, 3:1), which is why the BARE
      // hue is allowed on one.  BOTH halves are required: the size class alone
      // describes a box, not a glyph.
      //
      // It does NOT excuse a `-fg` token.  That one is white and is tested only
      // against its matching SOLID background, so `<Icon className="size-4
      // text-error-fg" />` on the canvas is near-invisible whether or not the
      // glyph counts as graphical — 1.4.11 asks for 3:1 against the ADJACENT
      // colour, and white on near-white clears nothing.
      const all = utilities(text);
      // A size class is a UTILITY, wherever it sits in the string — matching it
      // against the raw text made its position load-bearing.
      const isIcon =
        all.some((utility) => ICON_SIZE.test(utility.name)) &&
        enclosingElement(file.content, start) === ICON_ELEMENT;
      // EVERY offending utility, not the first: one class can carry several,
      // and the earlier ones may be perfectly paired.
      const offenders = [...(isIcon ? [] : bareHues(all)), ...unpairedForegrounds(all)];
      const match = offenders.sort((left, right) => left.at - right.at)[0];
      if (match === undefined) continue;
      // A template may span lines, so anchor on the UTILITY rather than the
      // token start: the reported line is where the class actually sits, and
      // the offset map carries that folded index back to the source.
      const line = lineOf(newlines, offsets[match.at] ?? start);
      if (isExempt(lines, line)) continue;
      findings.push({
        file: file.path,
        line,
        hue: /^text-(\w+)/.exec(match.name)?.[1] ?? '',
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

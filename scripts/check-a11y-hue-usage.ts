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
// THREE EXEMPTIONS, each narrow:
//
//   0. LARGE text — 1.4.3 permits the 3:1 colour at >= 18pt, or >= 14pt bold.
//      The size and weight are resolved through the theme, not matched against
//      a table of class names.
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
import { renderTokensCss } from '../apps/web/src/design-system/css.js';
import { type ClassString, readClassStrings } from './source-class-strings.js';
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
  property: 'color' | 'background-color' | 'background-image' | 'font-size' | 'font-weight',
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

/** The minimum width an at-rule demands, in px, or null when it demands none. */
function minimumWidth(condition: string): number | null {
  const match = /\(\s*width\s*>=\s*([\d.]+)(px|rem)\s*\)/.exec(condition);
  if (match?.[1] === undefined) return null;
  return match[2] === 'rem' ? Number(match[1]) * 16 : Number(match[1]);
}

/**
 * The pseudo-class segments of a selector demand, at the TOP level.
 *
 * `:hover:focus` is two demands written as one string; `:is(:where(.group):hover
 * *)` is a single one whose colons are nested, so the split respects
 * parentheses rather than cutting on every `:`.
 */
function selectorParts(demand: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (const character of demand) {
    if (character === '(') depth += 1;
    if (character === ')') depth -= 1;
    if (character === ':' && depth === 0) {
      if (current !== '') parts.push(current);
      current = ':';
      continue;
    }
    current += character;
  }
  if (current !== '') parts.push(current);
  return parts;
}

/**
 * Whether one condition is satisfied somewhere in `state`.
 *
 * Conditions IMPLY one another, in two ways, and treating them as independent
 * labels rejected ordinary compliant classes both times.
 *
 * Media queries: at `md` the `sm` minimum width is also true, so
 * `sm:bg-error md:text-error-fg` is a valid pairing.
 *
 * Compound selectors: `:hover:focus` is two demands written as one string, and
 * whenever it renders `:hover` is true as well — so
 * `hover:bg-error hover:focus:text-error-fg` is a solid fill under the
 * foreground, and requiring the exact `:hover` string to appear in a state
 * seeded from `:hover:focus` called it a bare hue on the canvas.  The same
 * subset test covers `group-`/`peer-` states, whose demand is one nested
 * `:is(…)` segment that a naive split on `:` would have torn apart.
 */
function holds(condition: string, state: readonly string[]): boolean {
  if (state.includes(condition)) return true;
  const needed = minimumWidth(condition);
  if (needed !== null) {
    return state.some((each) => {
      const has = minimumWidth(each);
      return has !== null && has >= needed;
    });
  }
  const wanted = selectorParts(condition);
  if (wanted.length === 0) return false;
  return state.some((each) => {
    if (minimumWidth(each) !== null) return false;
    const present = new Set(selectorParts(each));
    return wanted.every((part) => present.has(part));
  });
}

/** Whether every condition of `paint` holds in `state`. */
function activeIn(paint: Paint, state: readonly string[]): boolean {
  return conditionsOf(paint.declared).every((condition) => holds(condition, state));
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

/**
 * The bare-hue inks in `all` that carry NORMAL text.
 *
 * An ink shows in every state its own conditions survive into, and the size it
 * shows at cascades independently — so each state is tried, one per size or
 * weight declaration, and the hue is reported only where the text is not large
 * there.  The same shape as the `-fg` pairing check, for the same reason.
 */
function bareHuePaints(all: readonly Candidate[], facts: UtilityFacts, hues: readonly HueColors[]) {
  const inks = paintsOf(all, facts, 'color');
  const sizes = paintsOf(all, facts, 'font-size');
  const weights = paintsOf(all, facts, 'font-weight');
  const found: Array<{ candidate: Candidate; hue: string }> = [];
  for (const paint of inks) {
    for (const colors of hues) {
      if (!mentions(paint.declared.value, colors.bare)) continue;
      const states = [
        conditionsOf(paint.declared),
        ...[...sizes, ...weights].map((other) => [
          ...conditionsOf(paint.declared),
          ...conditionsOf(other.declared),
        ]),
      ];
      const normal = states.some(
        (state) => paintedIn(inks, state).includes(paint) && !isLargeIn(sizes, weights, state),
      );
      if (normal) found.push({ candidate: paint.candidate, hue: colors.hue });
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
  // An IMAGE paints OVER the colour, so a gradient covers the solid fill the
  // `-fg` token was measured against — `bg-error text-error-fg bg-linear-to-r
  // from-white to-white` renders white on white while the error fill is still
  // in the cascade underneath it.  What the image contains is not knowable
  // here, so a showing one disqualifies the pairing.
  //
  // `none` stays IN the cascade rather than being filtered out of it: it is a
  // declaration like any other, and `bg-none!` is how a gradient is turned off.
  // Dropping it left the gradient looking active and rejected a valid pairing.
  const images = paintsOf(all, facts, 'background-image');
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
          ...[...fills, ...images].map((other) => [
            ...conditionsOf(ink.declared),
            ...conditionsOf(other.declared),
          ]),
        ].some((state) => {
          if (!paintedIn(inks, state).includes(ink)) return false;
          if (paintedIn(images, state).some((image) => image.declared.value !== 'none'))
            return true;
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
 * The custom properties the design system declares.
 *
 * A utility resolves to `font-size: var(--licio-text-2xl)`, not to a length, so
 * the length has to come from the same generator the theme is built from —
 * which keeps a rescaled step correctly classified instead of pinned to a
 * number written here.
 */
const THEME_VARIABLES: ReadonlyMap<string, string> = new Map(
  [...renderTokensCss().matchAll(/(--[a-z0-9-]+)\s*:\s*([^;}]+)/g)].map((match) => [
    match[1] ?? '',
    (match[2] ?? '').trim(),
  ]),
);

/** The px value of a CSS length, following `var(…)` through the theme. */
function pixels(value: string, hop = 0): number | null {
  const text = value.trim();
  if (hop > 8) return null;
  const reference = /^var\(\s*(--[a-z0-9-]+)/.exec(text);
  if (reference?.[1] !== undefined) {
    const resolved = THEME_VARIABLES.get(reference[1]);
    return resolved === undefined ? null : pixels(resolved, hop + 1);
  }
  const rem = /^([\d.]+)rem$/.exec(text);
  if (rem?.[1] !== undefined) return Number(rem[1]) * 16;
  const px = /^([\d.]+)px$/.exec(text);
  return px?.[1] === undefined ? null : Number(px[1]);
}

/** WCAG 1.4.3 large text: >= 18pt (24px), or >= 14pt (18.66px) when bold. */
const LARGE_PX = 24;
const LARGE_BOLD_PX = 18.66;
const BOLD = 700;

/**
 * Whether the text is LARGE in `state`, which the bare hue IS allowed on.
 *
 * The bare hue clears 3:1, and WCAG 1.4.3 permits that for large text exactly
 * as 1.4.11 permits it for a graphical object — so reporting `text-error
 * text-2xl` rejected a use the token suite's own assertions allow.
 *
 * STATE-AWARE, because a size is a cascading declaration like a colour: in
 * `text-error text-sm sm:text-3xl` the hue is large only above the breakpoint
 * and renders as normal-sized text below it.  Reading every declaration at once
 * exempted the whole class string on the strength of a variant that does not
 * hold where the problem is.
 *
 * The values are resolved through the theme rather than matched against a table
 * of class names, so a rescaled step stays correctly classified.
 */
function isLargeIn(
  sizes: readonly Paint[],
  weights: readonly Paint[],
  state: readonly string[],
): boolean {
  const size = paintedIn(sizes, state)
    .map((paint) => pixels(paint.declared.value))
    .find((value) => value !== null);
  if (size === undefined || size === null) return false;
  const weight = paintedIn(weights, state)
    .map((paint) => Number.parseInt(paint.declared.value, 10))
    .find((value) => Number.isFinite(value));
  return (weight ?? 400) >= BOLD ? size >= LARGE_BOLD_PX : size >= LARGE_PX;
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

/** One class string an expression renders, with the classes in it. */
interface Scanned {
  readonly file: SourceFile;
  readonly rendered: ClassString;
  readonly all: readonly Candidate[];
}

/** Every class string `files` can render, from the PARSE of each source. */
function scan(files: readonly SourceFile[]): Scanned[] {
  const scanned: Scanned[] = [];
  const byFile = readClassStrings(files);
  for (const file of files) {
    for (const rendered of byFile.get(file.path) ?? []) {
      const all = candidates(rendered.text);
      if (all.length === 0) continue;
      scanned.push({ file, rendered, all });
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
      entry.rendered.element === ICON_ELEMENT;
    // EVERY offending class, not the first: one string can carry several, and
    // the earlier ones may be perfectly paired.
    // The BARE hue is a 3:1 colour, which WCAG allows on a graphical object
    // (1.4.11); LARGE text (1.4.3) is judged per state inside `bareHuePaints`.
    const offenders = [
      ...(isIcon ? [] : bareHuePaints(all, facts, hues)),
      ...unpairedForegrounds(all, facts, hues),
    ];
    if (offenders.length === 0) continue;
    const newlines = newlineIndex(file.content);
    const lines = file.content.split('\n');
    // EACH offender is judged on ITS OWN line.  Taking only the first and
    // exempting the whole expression on that one line meant a reasoned
    // exemption for a non-text `text-error` also silenced an unrelated,
    // unexempted `text-warning` folded in beside it — one comment covering
    // classes nobody had looked at.  An exemption is a statement about a
    // specific use, so it can only excuse the use it sits on.
    for (const offender of offenders.sort(
      (left, right) => left.candidate.at - right.candidate.at,
    )) {
      // A template may span lines, so anchor on the CLASS rather than the token
      // start: the reported line is where it actually sits, and the offset map
      // carries that folded index back to the source.
      const line = lineOf(
        newlines,
        entry.rendered.offsets[offender.candidate.at] ?? entry.rendered.start,
      );
      if (isExempt(lines, line)) continue;
      const already = findings.some(
        (found) => found.file === file.path && found.line === line && found.hue === offender.hue,
      );
      if (already) continue;
      findings.push({
        file: file.path,
        line,
        hue: offender.hue,
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

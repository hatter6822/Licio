// SPDX-License-Identifier: AGPL-3.0-or-later
//
// What a Tailwind class actually paints — answered by Tailwind.
//
// Reading a class name is not string work.  `bg-error` names a fill, `bg-center`
// names a position, `bg-red-500` names a palette step, `bg-(--licio-error)`
// names the same fill through a CSS variable, `[color:red]` sets a colour with
// no `text-` prefix at all, `bg-error/50` sets a BLEND of one, and `bg-canvas!`
// and `!bg-canvas` both set one `!important`.  Which of those paint, what they
// paint, and which one wins where two apply, are questions about Tailwind's
// grammar, its theme, and the CSS cascade.
//
// Every one of them was answered here by hand at some point, and each answer was
// correct and incomplete: a rule for variants, then one for importance, then one
// for opacity, then one for arbitrary values — because the list is not a list of
// bugs, it is Tailwind's syntax, and the way to stop extending it is to stop
// restating it.
//
// So the design system is loaded from the app's OWN stylesheet and asked:
//
//   • `candidatesToAst` gives each class's declarations — property, value,
//     `!important`, the at-rules and selector it renders under.  A class that is
//     not a utility yields nothing, so "is this even a class" needs no rule.
//   • `getClassOrder` gives Tailwind's own cascade position, which is the order
//     it emits them in — the thing a `className` attribute's order is NOT.
//
// `__unstable__loadDesignSystem` is the entry point Tailwind's own tooling uses
// for exactly this (IntelliSense, the Prettier class sorter).  It is unstable in
// name, so every assumption it feeds is CHECKED at load: if the shape of an
// answer changes, this throws rather than quietly reporting that nothing paints.

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { __unstable__loadDesignSystem } from 'tailwindcss';

const ROOT = resolve(import.meta.dirname, '..');

/** The app's stylesheet — the theme, the plugins, the whole design system. */
const STYLESHEET = resolve(ROOT, 'apps/web/src/styles/app.css');

/** One declaration a class makes, with everything it takes for it to apply. */
export interface Declared {
  /** The CSS property: `color`, `background-color`, `width`, … */
  readonly property: string;
  readonly value: string;
  readonly important: boolean;
  /**
   * The at-rules it renders inside — `@media (width >= 640px)` and the like.
   *
   * These gate WHETHER it applies and contribute no specificity at all, which
   * is why they are kept apart from the selector: two utilities in different
   * media blocks are equally specific, so between them the cascade consults
   * stylesheet order, and `sm:bg-canvas md:bg-error` has a definite winner
   * rather than being a tie.
   */
  readonly atRules: readonly string[];
  /**
   * What the selector demands beyond the class itself: `:hover`, `:focus`, or
   * `''` for nothing.
   *
   * Separate from the at-rules because this is where specificity comes from,
   * and needed at all because `[&:focus]:` compiles to a bare `:focus` with NO
   * at-rule — so a model reading only at-rules would call it unconditional and
   * pair it with text that is always visible.
   */
  readonly demand: string;
}

/** What Tailwind says about the classes it was asked about. */
export interface UtilityFacts {
  /** Every declaration a class makes, in the order it makes them. */
  declarationsOf(candidate: string): readonly Declared[];
  /**
   * Tailwind's cascade position for a class, or `undefined` when it is not a
   * utility.  Later wins between two declarations that are otherwise equal —
   * this is the stylesheet order, which is what the cascade actually consults.
   */
  orderOf(candidate: string): bigint | undefined;
}

/** The AST shape read here; Tailwind's node union is structural. */
interface AstNode {
  readonly kind: string;
  readonly property?: string;
  readonly value?: string | undefined;
  readonly important?: boolean;
  readonly selector?: string;
  readonly name?: string;
  readonly params?: string;
  readonly nodes?: readonly AstNode[];
}

/**
 * What the selector demands BEYOND the class itself.
 *
 * `.hover\:bg-canvas:hover` demands `:hover`; `.bg-error` demands nothing.  The
 * class is escaped into the selector, so the prefix is skipped a character at a
 * time with `\` consumed — and anything that is not the expected shape is
 * returned WHOLE, which reads as a condition nothing else satisfies and so
 * pairs with nothing.  That is the safe direction for an unfamiliar selector.
 */
function selectorCondition(selector: string, candidate: string): string {
  if (!selector.startsWith('.')) return selector;
  let index = 1;
  for (const character of candidate) {
    if (selector[index] === '\\') index += 1;
    if (selector[index] !== character) return selector;
    index += 1;
  }
  return selector.slice(index);
}

/** Flatten one class's AST into its declarations, carrying the conditions down. */
function flatten(
  nodes: readonly AstNode[] | undefined,
  candidate: string,
  atRules: readonly string[],
  demand: string,
): Declared[] {
  const found: Declared[] = [];
  for (const node of nodes ?? []) {
    if (node.kind === 'declaration') {
      if (node.property === undefined || node.value === undefined) continue;
      found.push({
        property: node.property,
        value: node.value,
        important: node.important === true,
        atRules,
        demand,
      });
      continue;
    }
    if (node.kind === 'rule' && node.selector !== undefined) {
      const nested = selectorCondition(node.selector, candidate);
      found.push(...flatten(node.nodes, candidate, atRules, `${demand}${nested}`));
      continue;
    }
    if (node.kind === 'at-rule' && node.name !== undefined) {
      found.push(
        ...flatten(node.nodes, candidate, [...atRules, `${node.name} ${node.params}`], demand),
      );
      continue;
    }
    found.push(...flatten(node.nodes, candidate, atRules, demand));
  }
  return found;
}

/** Resolve an import the way the Vite plugin does: the package, or a sibling. */
async function loadStylesheet(
  id: string,
  base: string,
): Promise<{ path: string; base: string; content: string }> {
  const require = createRequire(import.meta.url);
  const path = id === 'tailwindcss' ? require.resolve('tailwindcss/index.css') : resolve(base, id);
  return { path, base: dirname(path), content: readFileSync(path, 'utf-8') };
}

/**
 * Ask Tailwind what each of `candidates` paints.
 *
 * One design-system load and one batch for the whole run: ~15k distinct tokens
 * from the web source resolve in under a third of a second, so nothing here
 * needs a pre-filter that would have to guess what a utility looks like.
 */
export async function readUtilities(candidates: readonly string[]): Promise<UtilityFacts> {
  const system = await __unstable__loadDesignSystem(readFileSync(STYLESHEET, 'utf-8'), {
    base: dirname(STYLESHEET),
    loadStylesheet,
    // No JS plugin is configured, and silently tolerating one would mean judging
    // a design system that is not the app's.
    loadModule: async (id: string) => {
      throw new Error(`check:a11y-hue-usage: unexpected JS plugin in the stylesheet: ${id}`);
    },
  });

  const unique = [...new Set(candidates)];
  const asts = system.candidatesToAst(unique) as unknown as Array<readonly AstNode[] | undefined>;
  if (asts.length !== unique.length) {
    throw new Error('check:a11y-hue-usage: Tailwind returned an AST per candidate mismatch');
  }

  const declarations = new Map<string, readonly Declared[]>();
  unique.forEach((candidate, index) => {
    declarations.set(candidate, flatten(asts[index], candidate, [], ''));
  });

  const order = new Map<string, bigint>();
  for (const [candidate, position] of system.getClassOrder(unique)) {
    if (position !== null) order.set(candidate, position);
  }

  return {
    declarationsOf: (candidate) => declarations.get(candidate) ?? [],
    orderOf: (candidate) => order.get(candidate),
  };
}

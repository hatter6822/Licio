// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Guard against the recurring "undefined design-token utility" bug: a class like
// `bg-canvas-raised`, `bg-danger`, `border-edge`, or `text-danger` references a
// colour name that is NOT in the token map, so Tailwind emits nothing and the
// element renders with a clear background / missing border / wrong text colour.
// This test walks the client source, extracts every colour-utility class, and
// asserts its colour name resolves to a real token (Object.keys(tailwindColorMap))
// or a Tailwind built-in. The valid set is imported from the SSOT, so adding a
// token automatically permits its utilities — no second list to maintain.
import { readdirSync, readFileSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { tailwindColorMap } from '../css.js';

// Colour-utility prefixes whose argument is a colour token.
const COLOR_PREFIXES = [
  'bg',
  'text',
  'border',
  'ring',
  'fill',
  'stroke',
  'outline',
  'divide',
  'decoration',
  'caret',
  'accent',
  'placeholder',
  'from',
  'to',
  'via',
] as const;

// Tailwind built-in colour keywords that are always valid (not in our token map).
const BUILTIN_COLORS = new Set(['transparent', 'current', 'inherit', 'black', 'white']);

const VALID_COLORS = new Set<string>([...Object.keys(tailwindColorMap), ...BUILTIN_COLORS]);

// Non-colour utilities that share a prefix with a colour utility. A colour name
// matching any of these (per prefix) is ignored. Kept deliberately tight so a
// genuine typo is never silently allowed.
const NON_COLOR: Record<string, RegExp> = {
  bg: /^(clip|origin|blend|gradient|none|cover|contain|center|top|bottom|left|right|fixed|local|scroll|repeat|no-repeat|auto|linear|radial|conic)$/,
  text: /^(xs|sm|base|lg|xl|[2-9]xl|left|center|right|justify|start|end|wrap|nowrap|balance|pretty|ellipsis|clip)$/,
  border:
    /^(solid|dashed|dotted|double|hidden|none|collapse|separate|spacing|reverse|[xytblrse](-\d+)?|\d+)$/,
  ring: /^(inset|offset(-\d+)?|none|\d+)$/,
  fill: /^(none)$/,
  stroke: /^(none|\d+)$/,
  outline: /^(none|dashed|dotted|double|hidden|offset(-\d+)?|\d+)$/,
  divide: /^(solid|dashed|dotted|double|none|reverse|[xy](-reverse)?|\d+)$/,
  decoration: /^(solid|dashed|dotted|double|wavy|none|from-font|auto|slice|clone|\d+)$/,
  caret: /^$/,
  accent: /^(auto)$/,
  placeholder: /^$/,
  from: /^(\d+%?)$/,
  to: /^(\d+%?)$/,
  via: /^(\d+%?)$/,
};

const prefixGroup = COLOR_PREFIXES.join('|');
// A utility token, possibly with leading variants (hover:, sm:, dark:, etc.) and
// a trailing /opacity or arbitrary-value [..]; we only validate static names.
const TOKEN_RE = new RegExp(`(?:^|[\\s"'\`{(:])(${prefixGroup})-([a-z][a-z0-9-]*)`, 'g');

function listSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...listSourceFiles(full));
    } else if ((extname(full) === '.tsx' || extname(full) === '.ts') && !full.endsWith('.d.ts')) {
      out.push(full);
    }
  }
  return out;
}

function findSrcRoots(): string[] {
  const candidates = [resolve(process.cwd(), 'apps/web/src'), resolve(process.cwd(), 'src')];
  return candidates.filter((c) => {
    try {
      return readdirSync(c).length > 0;
    } catch {
      return false;
    }
  });
}

describe('every colour utility in the client references a defined token', () => {
  it('has no bg-/text-/border-/… class pointing at an undefined colour', () => {
    const roots = findSrcRoots();
    expect(roots.length).toBeGreaterThan(0);

    const offenders: string[] = [];
    for (const root of roots) {
      // Skip the design-system layer (the token SSOT + the CSS generator mention
      // token NAMES as data, e.g. `'bg-default': '#…'`, not as utility classes),
      // tests, and generated files.
      const files = listSourceFiles(root).filter(
        (f) =>
          !f.includes('/design-system/') &&
          !f.endsWith('.test.tsx') &&
          !f.endsWith('.test.ts') &&
          !f.endsWith('.gen.ts'),
      );
      for (const file of files) {
        const text = readFileSync(file, 'utf-8');
        for (const match of text.matchAll(TOKEN_RE)) {
          const prefix = match[1] as string;
          const name = match[2] as string;
          if (name.includes('[')) continue; // arbitrary value
          if (VALID_COLORS.has(name)) continue;
          if (NON_COLOR[prefix]?.test(name)) continue;
          offenders.push(`${prefix}-${name}  (${file.split('/apps/web/')[1] ?? file})`);
        }
      }
    }

    expect([...new Set(offenders)].sort()).toEqual([]);
  });
});

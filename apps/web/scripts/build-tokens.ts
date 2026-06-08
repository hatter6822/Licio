// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Writes the generated design-token stylesheet from the SSOT in
// `src/design-system/tokens.ts`. Run via `pnpm --filter web gen:tokens`.
// CI asserts the committed output is up to date
// (`src/design-system/__tests__/tokens.test.ts`), so it never silently drifts.
//
// This lives outside `src/` because it is a Node build script (tsx-run, not
// part of the browser TypeScript program), matching the repo's `scripts/`
// convention.
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { renderTokensCss } from '../src/design-system/css.js';

const OUTPUT = fileURLToPath(new URL('../src/styles/tokens.generated.css', import.meta.url));

writeFileSync(OUTPUT, renderTokensCss(), 'utf-8');
console.log(`Wrote design tokens → ${OUTPUT}`);

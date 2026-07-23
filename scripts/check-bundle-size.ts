// SPDX-License-Identifier: AGPL-3.0-or-later
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { gzipSync } from 'node:zlib';

const DIST_DIR = resolve(import.meta.dirname, '..', 'apps', 'web', 'dist');
const ASSETS_DIR = join(DIST_DIR, 'assets');
const OUTPUT_FILE = join(DIST_DIR, 'bundle-size.json');

// SPEC §6.10 budgets the INITIAL JS payload ("Budgeted and code-split;
// route-level lazy loading"): the entry script plus every chunk index.html
// preloads — what a first paint actually downloads.  Lazy route chunks are
// NOT initial payload, but their sum is still bounded (the total budget) so
// unbounded app growth has a brake too.  The total is a RATCHET: it moves
// only by an explicit, reviewed adjustment when an audited feature ships,
// and always stays within ~3 KiB of the measured build so silent growth
// keeps failing fast.  (Last adjusted for the WS-T story-surface pass:
// +3.0 KiB measured, 324.2 → 327.2 KiB — the live-debates modal, its pure
// sort/search/pin model and the compact discovery row; the dispute-tinted
// story-card edge; and the story article card with its icon-only action row
// (a new `share` glyph + tooltipped controls).  All of it lands in LAZY route
// chunks: the initial payload moved 164.3 → 164.5 KiB.  A previous adjustment
// covered scoped search + the banner governance/sign-in action: +2.3 KiB
// measured.  Splitting the governance modal into its own chunk was measured
// and REJECTED: its tree is shared with the room page, so the split moved
// bytes between chunks and added boundary cost rather than removing any — the
// same reasoning applies to the debate modal, which shares its tree with both
// story surfaces.)
const INITIAL_JS_BUDGET_BYTES = 200 * 1024;
const TOTAL_JS_BUDGET_BYTES = 330 * 1024;
const CSS_BUDGET_BYTES = 50 * 1024;

// WS-S.2.1 / WS-R — the optional DECENTRALIZATION planes are large and lazily
// code-split, reached ONLY through dynamic imports (check:private-p2p-split /
// check:lcap-p2p-split), so they carry no weight for a user who never opts into
// E2EE rooms or P2P/courier sync.  They would blow the core TOTAL-JS
// budget even though they never enter the initial load (PRIVATE_SPEC §9.8), so
// each gets its OWN measured budget and is EXCLUDED from the core total — never
// silently exempt.  Two chunks qualify: the `private-p2p` plane (the E2EE rooms
// stack — MLS/HPKE/curves + the room engine) and the `lcap-p2p` plane (the
// optional WebRTC/IPFS + courier transport carriers).  Vite names each lazy chunk
// after its plane, so the built asset file name contains `private-p2p`/`lcap-p2p`.
const PRIVATE_CHUNK_PATTERN = /private-p2p|lcap-p2p/;
const PRIVATE_CHUNK_BUDGET_BYTES = 2048 * 1024;

interface BundleSizeReport {
  initialJs: {
    raw: number;
    gzipped: number;
    budget: number;
    withinBudget: boolean;
    files: string[];
  };
  js: { raw: number; gzipped: number; budget: number; withinBudget: boolean };
  privateChunk: {
    raw: number;
    gzipped: number;
    budget: number;
    withinBudget: boolean;
    files: string[];
  };
  css: { raw: number; gzipped: number; budget: number; withinBudget: boolean };
  largestChunk: { name: string; raw: number; gzipped: number };
  assets: Array<{ name: string; raw: number; gzipped: number }>;
}

/** The initial-payload JS files: index.html's entry script + preloads. */
function initialJsFiles(): Set<string> {
  const html = readFileSync(join(DIST_DIR, 'index.html'), 'utf8');
  const files = new Set<string>();
  for (const match of html.matchAll(/(?:src|href)="\/assets\/([^"]+\.js)"/g)) {
    const file = match[1];
    if (file !== undefined) files.add(file);
  }
  return files;
}

function check(): void {
  if (!existsSync(ASSETS_DIR)) {
    console.error('No assets directory found. Build first.');
    process.exit(1);
  }

  const files = readdirSync(ASSETS_DIR);
  const initialFiles = initialJsFiles();
  let totalJsGzipped = 0;
  let totalCssGzipped = 0;
  let totalJsRaw = 0;
  let totalCssRaw = 0;
  let initialJsGzipped = 0;
  let initialJsRaw = 0;
  let privateChunkGzipped = 0;
  let privateChunkRaw = 0;
  const privateChunkFiles: string[] = [];
  let largestChunk = { name: '', raw: 0, gzipped: 0 };
  const assets: Array<{ name: string; raw: number; gzipped: number }> = [];

  for (const file of files) {
    const filePath = join(ASSETS_DIR, file);
    const content = readFileSync(filePath);
    const gzipped = gzipSync(content);

    assets.push({ name: file, raw: content.length, gzipped: gzipped.length });

    if (file.endsWith('.js')) {
      // WS-S.2.1 — the lazily code-split private-p2p chunk is measured against
      // its OWN budget and excluded from the core total / largest-chunk figures
      // (it can never reach the initial load, which the CSP/route-split + the
      // `check:lcap-p2p-split`-style dynamic-import discipline guarantee).
      if (PRIVATE_CHUNK_PATTERN.test(file)) {
        privateChunkRaw += content.length;
        privateChunkGzipped += gzipped.length;
        privateChunkFiles.push(file);
        continue;
      }
      totalJsRaw += content.length;
      totalJsGzipped += gzipped.length;
      if (initialFiles.has(file)) {
        initialJsRaw += content.length;
        initialJsGzipped += gzipped.length;
      }
      if (gzipped.length > largestChunk.gzipped) {
        largestChunk = { name: file, raw: content.length, gzipped: gzipped.length };
      }
    } else if (file.endsWith('.css')) {
      totalCssRaw += content.length;
      totalCssGzipped += gzipped.length;
    }
  }

  const report: BundleSizeReport = {
    initialJs: {
      raw: initialJsRaw,
      gzipped: initialJsGzipped,
      budget: INITIAL_JS_BUDGET_BYTES,
      withinBudget: initialJsGzipped <= INITIAL_JS_BUDGET_BYTES,
      files: [...initialFiles].sort(),
    },
    js: {
      raw: totalJsRaw,
      gzipped: totalJsGzipped,
      budget: TOTAL_JS_BUDGET_BYTES,
      withinBudget: totalJsGzipped <= TOTAL_JS_BUDGET_BYTES,
    },
    privateChunk: {
      raw: privateChunkRaw,
      gzipped: privateChunkGzipped,
      budget: PRIVATE_CHUNK_BUDGET_BYTES,
      withinBudget: privateChunkGzipped <= PRIVATE_CHUNK_BUDGET_BYTES,
      files: privateChunkFiles.sort(),
    },
    css: {
      raw: totalCssRaw,
      gzipped: totalCssGzipped,
      budget: CSS_BUDGET_BYTES,
      withinBudget: totalCssGzipped <= CSS_BUDGET_BYTES,
    },
    largestChunk,
    assets,
  };

  writeFileSync(OUTPUT_FILE, `${JSON.stringify(report, null, 2)}\n`);

  const formatSize = (bytes: number) => `${(bytes / 1024).toFixed(1)}KB`;

  console.log('Bundle size report:');
  console.log(
    `  Initial JS (entry + preloads): ${formatSize(initialJsGzipped)} gzipped (budget: ${formatSize(INITIAL_JS_BUDGET_BYTES)})`,
  );
  console.log(
    `  JS total:  ${formatSize(totalJsGzipped)} gzipped (budget: ${formatSize(TOTAL_JS_BUDGET_BYTES)}, private chunk excluded)`,
  );
  if (privateChunkFiles.length > 0) {
    console.log(
      `  Private P2P chunk: ${formatSize(privateChunkGzipped)} gzipped (budget: ${formatSize(PRIVATE_CHUNK_BUDGET_BYTES)})`,
    );
  }
  console.log(
    `  CSS: ${formatSize(totalCssGzipped)} gzipped (budget: ${formatSize(CSS_BUDGET_BYTES)})`,
  );
  console.log(
    `  Largest chunk: ${largestChunk.name} (${formatSize(largestChunk.gzipped)} gzipped)`,
  );

  const errors: string[] = [];
  if (!report.initialJs.withinBudget) {
    errors.push(
      `Initial JS budget exceeded: ${formatSize(initialJsGzipped)} > ${formatSize(INITIAL_JS_BUDGET_BYTES)}`,
    );
  }
  if (!report.js.withinBudget) {
    errors.push(
      `Total JS budget exceeded: ${formatSize(totalJsGzipped)} > ${formatSize(TOTAL_JS_BUDGET_BYTES)}`,
    );
  }
  if (!report.privateChunk.withinBudget) {
    errors.push(
      `Private P2P chunk budget exceeded: ${formatSize(privateChunkGzipped)} > ${formatSize(PRIVATE_CHUNK_BUDGET_BYTES)}`,
    );
  }
  if (!report.css.withinBudget) {
    errors.push(
      `CSS budget exceeded: ${formatSize(totalCssGzipped)} > ${formatSize(CSS_BUDGET_BYTES)}`,
    );
  }

  if (errors.length > 0) {
    console.error('\nBundle size check FAILED:');
    for (const error of errors) {
      console.error(`  - ${error}`);
    }
    process.exit(1);
  }

  console.log('\nBundle size check passed.');
}

check();

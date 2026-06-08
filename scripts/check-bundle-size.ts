// SPDX-License-Identifier: AGPL-3.0-or-later
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { gzipSync } from 'node:zlib';

const DIST_DIR = resolve(import.meta.dirname, '..', 'apps', 'web', 'dist');
const ASSETS_DIR = join(DIST_DIR, 'assets');
const OUTPUT_FILE = join(DIST_DIR, 'bundle-size.json');

const JS_BUDGET_BYTES = 200 * 1024;
const CSS_BUDGET_BYTES = 50 * 1024;

interface BundleSizeReport {
  js: { raw: number; gzipped: number; budget: number; withinBudget: boolean };
  css: { raw: number; gzipped: number; budget: number; withinBudget: boolean };
  largestChunk: { name: string; raw: number; gzipped: number };
  assets: Array<{ name: string; raw: number; gzipped: number }>;
}

function check(): void {
  if (!existsSync(ASSETS_DIR)) {
    console.error('No assets directory found. Build first.');
    process.exit(1);
  }

  const files = readdirSync(ASSETS_DIR);
  let totalJsGzipped = 0;
  let totalCssGzipped = 0;
  let totalJsRaw = 0;
  let totalCssRaw = 0;
  let largestChunk = { name: '', raw: 0, gzipped: 0 };
  const assets: Array<{ name: string; raw: number; gzipped: number }> = [];

  for (const file of files) {
    const filePath = join(ASSETS_DIR, file);
    const content = readFileSync(filePath);
    const gzipped = gzipSync(content);

    assets.push({ name: file, raw: content.length, gzipped: gzipped.length });

    if (file.endsWith('.js')) {
      totalJsRaw += content.length;
      totalJsGzipped += gzipped.length;
      if (gzipped.length > largestChunk.gzipped) {
        largestChunk = { name: file, raw: content.length, gzipped: gzipped.length };
      }
    } else if (file.endsWith('.css')) {
      totalCssRaw += content.length;
      totalCssGzipped += gzipped.length;
    }
  }

  const report: BundleSizeReport = {
    js: {
      raw: totalJsRaw,
      gzipped: totalJsGzipped,
      budget: JS_BUDGET_BYTES,
      withinBudget: totalJsGzipped <= JS_BUDGET_BYTES,
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
    `  JS:  ${formatSize(totalJsGzipped)} gzipped (budget: ${formatSize(JS_BUDGET_BYTES)})`,
  );
  console.log(
    `  CSS: ${formatSize(totalCssGzipped)} gzipped (budget: ${formatSize(CSS_BUDGET_BYTES)})`,
  );
  console.log(
    `  Largest chunk: ${largestChunk.name} (${formatSize(largestChunk.gzipped)} gzipped)`,
  );

  const errors: string[] = [];
  if (!report.js.withinBudget) {
    errors.push(
      `JS budget exceeded: ${formatSize(totalJsGzipped)} > ${formatSize(JS_BUDGET_BYTES)}`,
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

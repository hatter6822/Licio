// SPDX-License-Identifier: AGPL-3.0-or-later
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const DIST_DIR = resolve(import.meta.dirname, '..', 'apps', 'web', 'dist');
const ASSETS_DIR = join(DIST_DIR, 'assets');
const OUTPUT_FILE = join(DIST_DIR, 'sri-manifest.json');

function computeSri(filePath: string): string {
  const content = readFileSync(filePath);
  const hash = createHash('sha384').update(content).digest('base64');
  return `sha384-${hash}`;
}

function generate(): void {
  if (!existsSync(ASSETS_DIR)) {
    console.log('No assets directory found. Skipping SRI generation.');
    return;
  }

  const manifest: Record<string, string> = {};
  const files = readdirSync(ASSETS_DIR);

  for (const file of files) {
    if (file.endsWith('.js') || file.endsWith('.css')) {
      const filePath = join(ASSETS_DIR, file);
      manifest[file] = computeSri(filePath);
    }
  }

  writeFileSync(OUTPUT_FILE, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`SRI manifest generated: ${Object.keys(manifest).length} assets`);

  for (const [file, integrity] of Object.entries(manifest)) {
    console.log(`  ${file}: ${integrity.slice(0, 20)}...`);
  }
}

generate();

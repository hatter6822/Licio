import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { gzipSync } from 'node:zlib';

interface ViteManifestEntry {
  file: string;
  css?: string[];
  imports?: string[];
  isEntry?: boolean;
}

const distDir = process.cwd().endsWith('apps/web')
  ? join(process.cwd(), 'dist')
  : join(process.cwd(), 'apps/web/dist');
const jsBudgetBytes = 200 * 1024;
const cssBudgetBytes = 50 * 1024;

function walk(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? walk(path) : [path];
  });
}

function gzipSize(file: string): number {
  return gzipSync(readFileSync(join(distDir, file))).byteLength;
}

const manifest = JSON.parse(readFileSync(join(distDir, '.vite/manifest.json'), 'utf8')) as Record<
  string,
  ViteManifestEntry
>;
const initialAssets = new Set<string>();

function addEntry(entry: ViteManifestEntry): void {
  initialAssets.add(entry.file);
  for (const cssFile of entry.css ?? []) {
    initialAssets.add(cssFile);
  }
  for (const importedKey of entry.imports ?? []) {
    const imported = manifest[importedKey];
    if (imported !== undefined) {
      addEntry(imported);
    }
  }
}

for (const entry of Object.values(manifest)) {
  if (entry.isEntry === true) {
    addEntry(entry);
  }
}

const assets = walk(distDir)
  .filter((file) => /\.(js|css)$/.test(file))
  .map((file) => {
    const relativePath = relative(distDir, file).replaceAll('\\', '/');
    return {
      file: relativePath,
      rawBytes: statSync(file).size,
      gzipBytes: gzipSize(relativePath),
      initial: initialAssets.has(relativePath),
      type: file.endsWith('.css') ? 'css' : 'js',
    };
  });

const totalInitialJsGzipBytes = assets
  .filter((asset) => asset.initial && asset.type === 'js')
  .reduce((sum, asset) => sum + asset.gzipBytes, 0);
const totalCssGzipBytes = assets
  .filter((asset) => asset.type === 'css')
  .reduce((sum, asset) => sum + asset.gzipBytes, 0);
const largestChunk = assets.reduce(
  (largest, asset) =>
    largest === undefined || asset.gzipBytes > largest.gzipBytes ? asset : largest,
  undefined as (typeof assets)[number] | undefined,
);

const report = { totalInitialJsGzipBytes, totalCssGzipBytes, largestChunk, assets };
writeFileSync(join(distDir, 'bundle-size.json'), `${JSON.stringify(report, null, 2)}\n`);

console.info(
  `Bundle sizes: initial JS ${totalInitialJsGzipBytes} bytes gzip / CSS ${totalCssGzipBytes} bytes gzip; largest chunk ${largestChunk?.file ?? 'none'} (${largestChunk?.gzipBytes ?? 0} bytes gzip).`,
);

if (totalInitialJsGzipBytes >= jsBudgetBytes || totalCssGzipBytes >= cssBudgetBytes) {
  console.error('Bundle size budget exceeded.');
  process.exitCode = 1;
}

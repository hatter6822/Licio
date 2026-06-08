import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const distDir = process.cwd().endsWith('apps/web')
  ? join(process.cwd(), 'dist')
  : join(process.cwd(), 'apps/web/dist');
const manifestPath = join(distDir, 'sri-manifest.json');
const indexPath = join(distDir, 'index.html');
const manifest: Record<string, string> = {};

function walk(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? walk(path) : [path];
  });
}

for (const file of walk(distDir)) {
  if (!/\.(js|css)$/.test(file)) {
    continue;
  }
  const bytes = readFileSync(file);
  const digest = createHash('sha384').update(bytes).digest('base64');
  manifest[relative(distDir, file).replaceAll('\\', '/')] = `sha384-${digest}`;
}

function withIntegrityAttributes(html: string): string {
  return html.replace(
    /<(script|link)\b([^>]*?)(?:\s(?:src|href)="([^"]+)"|\s(?:href|src)="([^"]+)")([^>]*)>/g,
    (
      tag: string,
      elementName: string,
      beforeUrl: string,
      firstUrl: string,
      secondUrl: string,
      afterUrl: string,
    ) => {
      const url = firstUrl || secondUrl;
      const assetPath = url.replace(/^\//, '');
      const integrity = manifest[assetPath];
      if (integrity === undefined || tag.includes(' integrity=')) {
        return tag;
      }
      const crossorigin =
        elementName === 'script' && !tag.includes(' crossorigin') ? ' crossorigin="anonymous"' : '';
      return `<${elementName}${beforeUrl} ${tag.includes('src=') ? 'src' : 'href'}="${url}"${afterUrl} integrity="${integrity}"${crossorigin}>`;
    },
  );
}

writeFileSync(indexPath, withIntegrityAttributes(readFileSync(indexPath, 'utf8')));
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
console.info(`Generated SRI manifest with ${Object.keys(manifest).length} assets.`);

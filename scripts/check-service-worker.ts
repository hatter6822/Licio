import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const distDir = process.cwd().endsWith('apps/web')
  ? join(process.cwd(), 'dist')
  : join(process.cwd(), 'apps/web/dist');
const serviceWorkerPath = join(distDir, 'sw.js');

if (!existsSync(serviceWorkerPath)) {
  console.error(`Service worker not found at ${serviceWorkerPath}`);
  process.exit(1);
}

const serviceWorker = readFileSync(serviceWorkerPath, 'utf8');
const externalImportScripts = [...serviceWorker.matchAll(/importScripts\(([^)]*)\)/g)]
  .map((match) => match[1] ?? '')
  .filter((argumentList) => /['"]https?:\/\//i.test(argumentList));

if (externalImportScripts.length > 0 || /https?:\/\//i.test(serviceWorker)) {
  console.error('Service worker contains external-origin references.');
  for (const externalImportScript of externalImportScripts) {
    console.error(`- importScripts(${externalImportScript})`);
  }
  process.exitCode = 1;
} else {
  console.info('Service worker validation passed: no external-origin references.');
}

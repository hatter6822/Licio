import { globSync, rmSync } from 'node:fs';
import { join } from 'node:path';

for (const entry of globSync('{apps,packages}/**/{dist,dist-types,build,coverage,.vite}', {
  cwd: process.cwd(),
  exclude: ['**/node_modules/**'],
})) {
  rmSync(join(process.cwd(), entry), { recursive: true, force: true });
}
for (const entry of globSync('**/*.tsbuildinfo', {
  cwd: process.cwd(),
  exclude: ['**/node_modules/**'],
})) {
  rmSync(join(process.cwd(), entry), { force: true });
}
console.info('Removed build and TypeScript artifacts.');

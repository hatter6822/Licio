// SPDX-License-Identifier: AGPL-3.0-or-later
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');

interface PackageJson {
  name: string;
  version: string;
  dependencies?: Record<string, string>;
  license?: string;
}

interface SbomComponent {
  type: string;
  name: string;
  version: string;
  purl: string;
  licenses: Array<{ license: { id: string } }>;
}

const AGPL_COMPATIBLE_LICENSES = new Set([
  'MIT',
  'ISC',
  'BSD-2-Clause',
  'BSD-3-Clause',
  'Apache-2.0',
  'CC0-1.0',
  'Unlicense',
  '0BSD',
  'BlueOak-1.0.0',
  'AGPL-3.0-or-later',
  'AGPL-3.0-only',
  'GPL-3.0-or-later',
  'GPL-3.0-only',
  'LGPL-3.0-or-later',
  'LGPL-3.0-only',
  'MPL-2.0',
  'WTFPL',
  'Zlib',
  'CC-BY-4.0',
]);

function resolvePackageLicense(name: string): string {
  try {
    const paths = [
      resolve(ROOT, 'node_modules', '.pnpm', 'node_modules', name, 'package.json'),
      resolve(ROOT, 'node_modules', name, 'package.json'),
    ];
    for (const p of paths) {
      if (existsSync(p)) {
        const raw = readFileSync(p, 'utf-8');
        const pkg: PackageJson = JSON.parse(raw);
        return pkg.license ?? 'UNKNOWN';
      }
    }
  } catch {
    // ignore resolution failures
  }
  return 'UNKNOWN';
}

function generate(): void {
  const apps = ['apps/web', 'apps/api'];
  const components: SbomComponent[] = [];
  const licenseWarnings: string[] = [];

  for (const appPath of apps) {
    const pkgPath = resolve(ROOT, appPath, 'package.json');
    const raw = readFileSync(pkgPath, 'utf-8');
    const pkg: PackageJson = JSON.parse(raw);
    const deps = pkg.dependencies ?? {};

    for (const [name, version] of Object.entries(deps)) {
      if (version.startsWith('workspace:')) {
        continue;
      }

      const cleanVersion = version.replace(/^[\^~>=<]+/, '');
      const license = resolvePackageLicense(name);

      components.push({
        type: 'library',
        name,
        version: cleanVersion,
        purl: `pkg:npm/${name}@${cleanVersion}`,
        licenses: [{ license: { id: license } }],
      });

      if (license !== 'UNKNOWN' && !AGPL_COMPATIBLE_LICENSES.has(license)) {
        licenseWarnings.push(
          `${name}@${cleanVersion}: ${license} (may be incompatible with AGPL-3.0-or-later)`,
        );
      }
    }
  }

  const uniqueComponents = Array.from(new Map(components.map((c) => [c.purl, c])).values());

  const sbom = {
    bomFormat: 'CycloneDX',
    specVersion: '1.5',
    version: 1,
    metadata: {
      timestamp: new Date().toISOString(),
      component: {
        type: 'application',
        name: 'licio',
        version: '0.6.0',
      },
    },
    components: uniqueComponents,
  };

  const outputPath = resolve(ROOT, 'sbom.cdx.json');
  writeFileSync(outputPath, `${JSON.stringify(sbom, null, 2)}\n`);
  console.log(`SBOM generated: ${uniqueComponents.length} components`);

  if (licenseWarnings.length > 0) {
    console.warn('\nLicense compatibility warnings:');
    for (const warning of licenseWarnings) {
      console.warn(`  - ${warning}`);
    }
    process.exit(1);
  }

  console.log('License compatibility check passed.');
}

generate();

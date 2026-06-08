// SPDX-License-Identifier: AGPL-3.0-or-later
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

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
  'MIT-0',
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
  'GPL-2.0-or-later',
  'LGPL-3.0-or-later',
  'LGPL-3.0-only',
  'LGPL-2.1-or-later',
  'MPL-2.0',
  'WTFPL',
  'Zlib',
  'CC-BY-4.0',
  'Python-2.0',
]);

function isLicenseCompatible(license: string): boolean {
  if (AGPL_COMPATIBLE_LICENSES.has(license)) return true;
  const parts = license.split(/\s+OR\s+/).map((p) => p.replace(/^\(|\)$/g, '').trim());
  return parts.some((p) => AGPL_COMPATIBLE_LICENSES.has(p));
}

function resolvePackageJson(name: string): PackageJson | undefined {
  const paths = [
    resolve(ROOT, 'node_modules', '.pnpm', 'node_modules', name, 'package.json'),
    resolve(ROOT, 'node_modules', name, 'package.json'),
  ];
  for (const p of paths) {
    if (existsSync(p)) {
      const raw = readFileSync(p, 'utf-8');
      return JSON.parse(raw) as PackageJson;
    }
  }
  return undefined;
}

function collectTransitiveDeps(name: string, visited: Set<string>): void {
  if (visited.has(name)) return;
  visited.add(name);

  const pkg = resolvePackageJson(name);
  if (!pkg?.dependencies) return;

  for (const dep of Object.keys(pkg.dependencies)) {
    collectTransitiveDeps(dep, visited);
  }
}

function generate(): void {
  const apps = ['apps/web', 'apps/api'];
  const components: SbomComponent[] = [];
  const licenseWarnings: string[] = [];
  const unknownLicenses: string[] = [];
  const allDeps = new Set<string>();

  for (const appPath of apps) {
    const pkgPath = resolve(ROOT, appPath, 'package.json');
    const raw = readFileSync(pkgPath, 'utf-8');
    const pkg: PackageJson = JSON.parse(raw);
    const deps = pkg.dependencies ?? {};

    for (const [name, version] of Object.entries(deps)) {
      if (version.startsWith('workspace:')) continue;
      allDeps.add(name);
      collectTransitiveDeps(name, allDeps);
    }
  }

  for (const name of allDeps) {
    const pkg = resolvePackageJson(name);
    const version = pkg?.version ?? '0.0.0';
    const license = pkg?.license ?? 'UNKNOWN';

    components.push({
      type: 'library',
      name,
      version,
      purl: `pkg:npm/${name.startsWith('@') ? name.replaceAll('/', '%2F') : name}@${version}`,
      licenses: [{ license: { id: license } }],
    });

    if (license === 'UNKNOWN') {
      unknownLicenses.push(`${name}@${version}: license could not be determined`);
    } else if (!isLicenseCompatible(license)) {
      licenseWarnings.push(
        `${name}@${version}: ${license} (may be incompatible with AGPL-3.0-or-later)`,
      );
    }
  }

  const uniqueComponents = Array.from(new Map(components.map((c) => [c.purl, c])).values());

  const rootPkg: PackageJson = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf-8'));

  const sbom = {
    bomFormat: 'CycloneDX',
    specVersion: '1.5',
    version: 1,
    metadata: {
      timestamp: new Date().toISOString(),
      component: {
        type: 'application',
        name: 'licio',
        version: rootPkg.version,
      },
    },
    components: uniqueComponents,
  };

  const outputPath = resolve(ROOT, 'sbom.cdx.json');
  writeFileSync(outputPath, `${JSON.stringify(sbom, null, 2)}\n`);
  console.log(`SBOM generated: ${uniqueComponents.length} components (including transitive deps)`);

  if (unknownLicenses.length > 0) {
    console.warn(`\nUnknown licenses (${unknownLicenses.length}):`);
    for (const warning of unknownLicenses) {
      console.warn(`  - ${warning}`);
    }
  }

  if (licenseWarnings.length > 0) {
    console.error('\nIncompatible license warnings:');
    for (const warning of licenseWarnings) {
      console.error(`  - ${warning}`);
    }
    process.exit(1);
  }

  console.log('License compatibility check passed.');
}

generate();

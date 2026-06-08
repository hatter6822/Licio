import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';

interface PackageJson {
  name: string;
  version?: string;
  license?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

interface LockfilePackage {
  resolution?: {
    integrity?: string;
    tarball?: string;
  };
  version?: string;
}

interface PnpmLockfile {
  packages?: Record<string, LockfilePackage>;
}

function packageNameFromLockfileKey(key: string): { name: string; version: string } {
  const withoutLeadingSlash = key.replace(/^\//, '');
  const peerSuffixIndex = withoutLeadingSlash.indexOf('(');
  const withoutPeers =
    peerSuffixIndex === -1 ? withoutLeadingSlash : withoutLeadingSlash.slice(0, peerSuffixIndex);
  const segments = withoutPeers.split('@');
  if (withoutPeers.startsWith('@')) {
    return { name: `@${segments[1]}`, version: segments[2] ?? '0.0.0' };
  }
  return { name: segments[0] ?? withoutPeers, version: segments[1] ?? '0.0.0' };
}

const workspacePaths = [
  '.',
  'apps/web',
  'apps/api',
  'packages/shared',
  'packages/db',
  'packages/invariants',
];
const workspaceComponents = workspacePaths.map((path) => {
  const manifest = JSON.parse(
    readFileSync(join(process.cwd(), path, 'package.json'), 'utf8'),
  ) as PackageJson;
  return {
    type: path === '.' ? 'application' : 'library',
    name: manifest.name,
    version: manifest.version ?? '0.0.0',
    licenses: [{ license: { id: manifest.license ?? 'NOASSERTION' } }],
    purl: `pkg:generic/${encodeURIComponent(manifest.name)}@${manifest.version ?? '0.0.0'}`,
    properties: [{ name: 'workspace:path', value: path }],
  };
});

const invalidLicenses = workspaceComponents.filter(
  (component) => component.licenses[0]?.license.id !== 'AGPL-3.0-or-later',
);
if (invalidLicenses.length > 0) {
  console.error(
    `Workspace license mismatch: ${invalidLicenses.map((component) => component.name).join(', ')}`,
  );
  process.exitCode = 1;
}

const lockfile = parse(readFileSync(join(process.cwd(), 'pnpm-lock.yaml'), 'utf8')) as PnpmLockfile;
const dependencyComponents = Object.entries(lockfile.packages ?? {}).map(([key, value]) => {
  const parsed = packageNameFromLockfileKey(key);
  return {
    type: 'library',
    name: parsed.name,
    version: value.version ?? parsed.version,
    purl: `pkg:npm/${encodeURIComponent(parsed.name)}@${value.version ?? parsed.version}`,
    hashes: value.resolution?.integrity?.startsWith('sha512-')
      ? [{ alg: 'SHA-512', content: value.resolution.integrity.slice('sha512-'.length) }]
      : undefined,
    externalReferences: value.resolution?.tarball
      ? [{ type: 'distribution', url: value.resolution.tarball }]
      : undefined,
  };
});

const sbom = {
  bomFormat: 'CycloneDX',
  specVersion: '1.6',
  serialNumber: 'urn:uuid:00000000-0000-4000-8000-000000000000',
  version: 1,
  metadata: { component: { type: 'application', name: 'licio', version: '0.0.0' } },
  components: [...workspaceComponents, ...dependencyComponents],
};

const output = join(process.cwd(), 'licio.sbom.json');
writeFileSync(output, `${JSON.stringify(sbom, null, 2)}\n`);
console.info(
  `Generated SBOM scaffold at ${output} with ${workspaceComponents.length} workspaces and ${dependencyComponents.length} locked dependency components.`,
);

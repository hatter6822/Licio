import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const distDir = process.cwd().endsWith('apps/web')
  ? join(process.cwd(), 'dist')
  : join(process.cwd(), 'apps/web/dist');

interface ServiceWorkerSource {
  readonly path: string;
  readonly content: string;
}

interface ReferencePattern {
  readonly name: string;
  readonly regex: RegExp;
}

const operationalExternalReferencePatterns: readonly ReferencePattern[] = [
  {
    name: 'external importScripts dependency',
    regex: /\bimportScripts\s*\([^)]*['"]https?:\/\//gi,
  },
  {
    name: 'external dynamic import dependency',
    regex: /\bimport\s*\(\s*['"]https?:\/\//gi,
  },
  {
    name: 'external module dependency',
    regex: /\bdefine\s*\(\s*\[[^\]]*['"]https?:\/\//gi,
  },
  {
    name: 'external fetch request',
    regex: /\bfetch\s*\(\s*['"]https?:\/\//gi,
  },
  {
    name: 'external Request construction',
    regex: /\bnew\s+Request\s*\(\s*['"]https?:\/\//gi,
  },
  {
    name: 'external precache URL',
    regex: /\burl\s*:\s*['"]https?:\/\//gi,
  },
];

export interface ServiceWorkerViolation {
  readonly file: string;
  readonly kind: string;
  readonly snippet: string;
}

export function validateServiceWorkerReferences(
  sources: readonly ServiceWorkerSource[],
): ServiceWorkerViolation[] {
  return sources.flatMap((source) =>
    operationalExternalReferencePatterns.flatMap((pattern) =>
      [...source.content.matchAll(pattern.regex)].map((match) => ({
        file: source.path,
        kind: pattern.name,
        snippet: (match[0] ?? '').slice(0, 160),
      })),
    ),
  );
}

function serviceWorkerFiles(): string[] {
  const serviceWorkerPath = join(distDir, 'sw.js');
  if (!existsSync(serviceWorkerPath)) {
    console.error(`Service worker not found at ${serviceWorkerPath}`);
    process.exit(1);
  }

  return [
    serviceWorkerPath,
    ...readdirSync(distDir)
      .filter((fileName) => /^workbox-.+\.js$/.test(fileName))
      .map((fileName) => join(distDir, fileName)),
  ];
}

function main(): void {
  const sources = serviceWorkerFiles().map((file) => ({
    path: relative(distDir, file).replaceAll('\\', '/'),
    content: readFileSync(file, 'utf8'),
  }));
  const violations = validateServiceWorkerReferences(sources);

  if (violations.length > 0) {
    console.error('Service worker contains executable or precached external-origin references.');
    for (const violation of violations) {
      console.error(`- ${violation.file}: ${violation.kind}: ${violation.snippet}`);
    }
    process.exitCode = 1;
  } else {
    console.info(
      'Service worker validation passed: no executable or precached external-origin references.',
    );
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}

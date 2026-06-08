import { existsSync, globSync, readFileSync } from 'node:fs';
import { dirname, extname, isAbsolute, join, relative, resolve } from 'node:path';

interface PackageJson {
  name: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
}

const packages = [
  'apps/web',
  'apps/api',
  'packages/shared',
  'packages/db',
  'packages/invariants',
] as const;

const allowedInternalDependencies: Record<(typeof packages)[number], readonly string[]> = {
  'apps/web': ['@licio/shared'],
  'apps/api': ['@licio/shared', '@licio/db'],
  'packages/shared': [],
  'packages/db': ['@licio/shared'],
  'packages/invariants': ['@licio/shared'],
};

const staticImportPattern = /^\s*import\s+(?:type\s+)?(?:[^'";]+?\s+from\s+)?['"]([^'"]+)['"]/;
const sideEffectImportPattern = /^\s*import\s+['"]([^'"]+)['"]/;
const staticExportPattern = /^\s*export\s+(?:type\s+)?[^'";]+?\s+from\s+['"]([^'"]+)['"]/;
const dynamicImportPattern = /import\(\s*['"]([^'"]+)['"]\s*\)/g;
const ignoredBareSpecifiers = new Set(['virtual:pwa-register']);
const sourceExtensions = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'];

function readPackageJson(packagePath: string): PackageJson {
  return JSON.parse(readFileSync(join(process.cwd(), packagePath, 'package.json'), 'utf8'));
}

function isWithin(child: string, parent: string): boolean {
  const childRelativeToParent = relative(parent, child);
  return (
    childRelativeToParent === '' ||
    (!childRelativeToParent.startsWith('..') && !isAbsolute(childRelativeToParent))
  );
}

function packageNameFromSpecifier(specifier: string): string {
  if (specifier.startsWith('@')) {
    const [scope, name] = specifier.split('/');
    return `${scope}/${name}`;
  }
  return specifier.split('/')[0] ?? specifier;
}

function sourceFiles(packagePath: string): string[] {
  return globSync('**/*.{ts,tsx,js,jsx,mjs,cjs}', {
    cwd: join(process.cwd(), packagePath),
    exclude: ['dist/**', 'dist-types/**', 'node_modules/**'],
  }).map((file) => join(packagePath, file));
}

function resolveRelativeImport(importer: string, specifier: string): string {
  const base = resolve(process.cwd(), dirname(importer), specifier);
  if (sourceExtensions.some((extension) => extname(base) === extension)) {
    return base;
  }
  for (const extension of sourceExtensions) {
    const candidate = `${base}${extension}`;
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return base;
}

let failed = false;
for (const packagePath of packages) {
  const manifest = readPackageJson(packagePath);
  const declaredDependencies = {
    ...manifest.dependencies,
    ...manifest.devDependencies,
    ...manifest.peerDependencies,
  };
  const allowedInternal = new Set(allowedInternalDependencies[packagePath]);
  for (const dependencyName of Object.keys(declaredDependencies)) {
    if (dependencyName.startsWith('@licio/') && !allowedInternal.has(dependencyName)) {
      failed = true;
      console.error(`${packagePath} may not depend on ${dependencyName}`);
    }
  }

  const packageRoot = resolve(process.cwd(), packagePath);
  function validateSpecifier(file: string, specifier: string): void {
    if (specifier.startsWith('node:')) {
      return;
    }

    if (specifier.startsWith('.')) {
      const resolvedImport = resolveRelativeImport(file, specifier);
      if (!isWithin(resolvedImport, packageRoot)) {
        failed = true;
        console.error(`${file} uses cross-package relative import ${specifier}`);
      }
      return;
    }

    if (ignoredBareSpecifiers.has(specifier)) {
      return;
    }

    const dependencyName = packageNameFromSpecifier(specifier);
    if (dependencyName.startsWith('@licio/') && !allowedInternal.has(dependencyName)) {
      failed = true;
      console.error(`${file} may not import ${dependencyName}`);
    }
    if (
      !dependencyName.startsWith('@licio/') &&
      !(dependencyName in declaredDependencies) &&
      dependencyName !== manifest.name
    ) {
      failed = true;
      console.error(`${file} imports undeclared dependency ${dependencyName}`);
    }
  }

  for (const file of sourceFiles(packagePath)) {
    const text = readFileSync(join(process.cwd(), file), 'utf8');
    for (const line of text.split('\n')) {
      const staticMatch =
        staticImportPattern.exec(line) ??
        sideEffectImportPattern.exec(line) ??
        staticExportPattern.exec(line);
      if (staticMatch?.[1] !== undefined) {
        validateSpecifier(file, staticMatch[1]);
      }
      for (const dynamicMatch of line.matchAll(dynamicImportPattern)) {
        if (dynamicMatch[1] !== undefined) {
          validateSpecifier(file, dynamicMatch[1]);
        }
      }
    }
  }
}

if (!failed) {
  console.info('Workspace dependency boundaries and import declarations are valid.');
}

process.exitCode = failed ? 1 : 0;

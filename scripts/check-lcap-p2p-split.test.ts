// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { findStaticP2pImports } from './check-lcap-p2p-split.js';

describe('findStaticP2pImports (WS-R.15.8 code-split gate)', () => {
  it('allows a dynamic import()', () => {
    const src = `const { WebrtcTransport } = await import('@licio/lcap-p2p');`;
    expect(findStaticP2pImports('registry.ts', src)).toEqual([]);
  });

  it('allows a type-only static import (erased at build)', () => {
    const src = `import type { DataChannelLike } from '@licio/lcap-p2p';`;
    expect(findStaticP2pImports('a.ts', src)).toEqual([]);
  });

  it('flags a static value import', () => {
    const src = `import { WebrtcTransport } from '@licio/lcap-p2p';`;
    const issues = findStaticP2pImports('bad.ts', src);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain('static value import');
  });

  it('flags a side-effect import', () => {
    expect(findStaticP2pImports('bad.ts', `import '@licio/lcap-p2p';`)[0]).toContain(
      'side-effect import',
    );
  });

  it('ignores an unrelated package import', () => {
    expect(findStaticP2pImports('a.ts', `import { x } from '@licio/lcap';`)).toEqual([]);
  });

  it('flags a named static re-export (export { X } from) — a bundler-static edge', () => {
    const issues = findStaticP2pImports(
      'barrel.ts',
      `export { WebrtcTransport } from '@licio/lcap-p2p';`,
    );
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain('static re-export');
  });

  it('flags a wildcard static re-export (export * from)', () => {
    const issues = findStaticP2pImports('barrel.ts', `export * from '@licio/lcap-p2p';`);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain('static re-export');
  });

  it('allows a type-only re-export (erased at build)', () => {
    expect(
      findStaticP2pImports('barrel.ts', `export type { DataChannelLike } from '@licio/lcap-p2p';`),
    ).toEqual([]);
  });

  it('does not let the word "import" in a comment falsely pair with a real type import', () => {
    const src = [
      '// loaded by a DYNAMIC import in the registry.',
      "import type { DataChannelLike } from '@licio/lcap-p2p';",
    ].join('\n');
    expect(findStaticP2pImports('registry.ts', src)).toEqual([]);
  });
});

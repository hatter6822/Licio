// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { findStaticPrivateP2pImports } from './check-private-p2p-split.js';

describe('findStaticPrivateP2pImports (WS-S.2.1 code-split gate)', () => {
  it('allows a dynamic import()', () => {
    const src = `const { PrivateRoomEngine } = await import('@licio/private-p2p');`;
    expect(findStaticPrivateP2pImports('room-manager.ts', src)).toEqual([]);
  });

  it('allows a type-only static import (erased at build)', () => {
    const src = `import type { PrivateRoomStorage } from '@licio/private-p2p';`;
    expect(findStaticPrivateP2pImports('storage.ts', src)).toEqual([]);
  });

  it('flags a static value import', () => {
    const issues = findStaticPrivateP2pImports(
      'bad.ts',
      `import { PrivateRoomEngine } from '@licio/private-p2p';`,
    );
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain('static value import');
  });

  it('flags a side-effect import', () => {
    expect(findStaticPrivateP2pImports('bad.ts', `import '@licio/private-p2p';`)[0]).toContain(
      'side-effect import',
    );
  });

  it('ignores an unrelated package import', () => {
    expect(findStaticPrivateP2pImports('a.ts', `import { x } from '@licio/lcap';`)).toEqual([]);
  });

  it('does not let the word "import" in a comment falsely pair with a real type import', () => {
    // A regression for the comment-crossing match: the bare word "import" in a
    // doc comment must not pair with the later type import's `from '…'`.
    const src = [
      '// the engine is loaded by a DYNAMIC import in room-manager.ts.',
      '// This adapter only TYPE-imports `@licio/private-p2p`.',
      '',
      "import type { PrivateRoomStorage } from '@licio/private-p2p';",
    ].join('\n');
    expect(findStaticPrivateP2pImports('storage.ts', src)).toEqual([]);
  });
});

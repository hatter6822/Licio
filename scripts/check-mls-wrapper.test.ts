// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-S.3.1a — the MLS-wrapper boundary gate, proven to BITE: a deep `ts-mls`
// import anywhere but the reviewed wrapper is caught; the wrapper itself and
// wrapper-only consumers pass.
import { describe, expect, it } from 'vitest';
import { MLS_WRAPPER_PATH, scanMlsWrapperViolations } from './check-mls-wrapper.js';

describe('check:p2p-mls-wrapper', () => {
  it('allows the wrapper itself to import ts-mls', () => {
    expect(
      scanMlsWrapperViolations([
        { path: MLS_WRAPPER_PATH, content: "import { createCommit } from 'ts-mls';" },
      ]),
    ).toEqual([]);
  });

  it('allows other files that import only the wrapper', () => {
    expect(
      scanMlsWrapperViolations([
        {
          path: 'packages/private-p2p/src/crypto/epoch.ts',
          content: "import { currentEpoch } from './mls.js';",
        },
      ]),
    ).toEqual([]);
  });

  it('catches a deep ts-mls import outside the wrapper', () => {
    const v = scanMlsWrapperViolations([
      {
        path: 'packages/private-p2p/src/reducer.ts',
        content: "import { mlsExporter } from 'ts-mls';",
      },
    ]);
    expect(v).toHaveLength(1);
    expect(v[0]?.path).toBe('packages/private-p2p/src/reducer.ts');
  });

  it('catches a deep subpath import and a dynamic import', () => {
    expect(
      scanMlsWrapperViolations([
        { path: 'a.ts', content: "import x from 'ts-mls/dist/src/mlsExporter.js';" },
        { path: 'b.ts', content: "const m = await import('ts-mls');" },
      ]),
    ).toHaveLength(2);
  });

  it('does not match an unrelated import that merely contains the substring', () => {
    expect(
      scanMlsWrapperViolations([
        { path: 'c.ts', content: "import { x } from './ts-mls-helpers.js';" },
      ]),
    ).toEqual([]);
  });
});

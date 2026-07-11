// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Drift gate for the route-pattern SSOT (WS-P.1.1d): the API normalizes the
// unauthenticated telemetry beacon's route bucket against the shared
// ROUTE_PATTERNS catalog, so the catalog must equal the GENERATED route tree
// exactly.  Adding, renaming, or removing a route without updating
// @licio/shared/constants/route-patterns.ts fails here — a new route would
// otherwise silently bucket its vitals as 'unknown', and a stale entry would
// let a retired pattern keep accepting forged samples.
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ROUTE_PATTERNS } from '@licio/shared';
import { describe, expect, it } from 'vitest';

describe('route-pattern SSOT drift gate', () => {
  it('the shared ROUTE_PATTERNS catalog equals the generated route tree', () => {
    // jsdom rewrites import.meta.url to an http: URL — resolve from the cwd
    // (the workspace root under `pnpm --filter web test`, the repo root under
    // the unified `pnpm test`).
    const file = [
      resolve(process.cwd(), 'src/routeTree.gen.ts'),
      resolve(process.cwd(), 'apps/web/src/routeTree.gen.ts'),
    ].find(existsSync);
    if (!file) throw new Error('routeTree.gen.ts not found from cwd');
    const raw = readFileSync(file, 'utf8');
    const generated = new Set([...raw.matchAll(/\bid: '([^']+)'/g)].map((m) => m[1] as string));
    // Parse sanity floor: an extraction regex that rots must fail loudly,
    // never report an empty tree as "in sync".
    expect(generated.size).toBeGreaterThanOrEqual(10);
    expect([...generated].sort()).toEqual([...ROUTE_PATTERNS].sort());
  });
});

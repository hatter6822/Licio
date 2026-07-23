// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The `pnpm dev` preflight's matcher. This predicate decides what gets KILLED,
// so its boundaries are pinned here rather than left to inspection: everything
// it must catch (or the reclaim silently fails and `pnpm dev` still dies on
// EADDRINUSE) and, more importantly, everything it must NOT touch.
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { classify } from './free-dev-ports.js';

const REPO_ROOT = resolve(import.meta.dirname, '..');
const NODE = '/home/dev/.nvm/versions/node/v24.9.0/bin/node';

describe('free-dev-ports: what it stops', () => {
  it('the api dev WATCHER — the process that respawns the port holder', () => {
    const args = `node ${REPO_ROOT}/apps/api/node_modules/.bin/../tsx/dist/cli.mjs watch src/index.ts`;
    expect(classify(args)).toEqual({ supervisor: true, label: 'api dev watcher' });
  });

  it('the api dev SERVER, whose argv names neither the app nor the workspace', () => {
    // The real shape: tsx's loader hosts it, so only the repo root, the loader
    // path, and the bare entry file appear. Missing this one is what made the
    // first cut of the preflight useless.
    const args =
      `${NODE} --require ${REPO_ROOT}/node_modules/.pnpm/tsx@4.23.1/node_modules/tsx/dist/preflight.cjs` +
      ` --import file://${REPO_ROOT}/node_modules/.pnpm/tsx@4.23.1/node_modules/tsx/dist/loader.mjs src/index.ts`;
    expect(classify(args)).toEqual({ supervisor: false, label: 'api dev server' });
  });

  it('the web dev server (Vite)', () => {
    const args = `node ${REPO_ROOT}/apps/web/node_modules/.bin/../vite/bin/vite.js`;
    expect(classify(args)).toEqual({ supervisor: false, label: 'web dev server' });
  });
});

describe('free-dev-ports: what it must never touch', () => {
  it('anything outside THIS checkout — including another clone of this repo', () => {
    expect(
      classify('node /home/dev/other-clone/apps/api/node_modules/.bin/tsx watch src/index.ts'),
    ).toBeNull();
    expect(classify('node /elsewhere/node_modules/tsx/dist/loader.mjs src/index.ts')).toBeNull();
    expect(
      classify('node /home/dev/other-clone/apps/web/node_modules/vite/bin/vite.js'),
    ).toBeNull();
  });

  it('services that merely hold a port we want', () => {
    expect(classify('postgres: checkpointer')).toBeNull();
    expect(classify('redis-server *:6379')).toBeNull();
    expect(classify('docker-proxy -proto tcp -host-port 3001')).toBeNull();
    expect(classify(`${NODE} /usr/local/bin/some-other-api --port 3001`)).toBeNull();
  });

  it('this repo’s OTHER long-running processes — only the dev stack is ours to reclaim', () => {
    // The E2E harness (`pnpm --filter api e2e:server`) runs a DIFFERENT entry
    // file and is owned by Playwright's webServer, which stops it itself.
    expect(classify(`node ${REPO_ROOT}/node_modules/.bin/tsx src/e2e-server.ts`)).toBeNull();
    // The preview server, the token generator, the gates — none are dev servers.
    expect(classify(`node ${REPO_ROOT}/apps/web/node_modules/.bin/vitest run`)).toBeNull();
    expect(classify(`node ${REPO_ROOT}/node_modules/.bin/tsx scripts/check-policy.ts`)).toBeNull();
    expect(classify(`node ${REPO_ROOT}/apps/web/scripts/build-tokens.ts`)).toBeNull();
  });

  it('a path that merely CONTAINS the entry name is not the entry', () => {
    expect(classify(`node ${REPO_ROOT}/node_modules/.bin/tsx src/index.tsx`)).toBeNull();
    expect(classify(`node ${REPO_ROOT}/node_modules/.bin/tsx other/src/index.ts.bak`)).toBeNull();
  });
});

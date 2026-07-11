// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The production-parity gate must BITE: each leg is proven against a fixture
// replaying the exact historical failure it exists to prevent (the 2026-07
// remediation's gap classes), and the live tree must pass with the current
// allowlists (stale entries are themselves failures, so allowlists cannot rot).
import { describe, expect, it } from 'vitest';
import {
  buildBootClosure,
  checkAdapterCoverage,
  checkAdapterPurity,
  checkEnvKeys,
  collectApiSourceFiles,
  runProdParityGate,
  stripComments,
} from './check-prod-parity.js';

const files = (entries: Record<string, string>): Map<string, string> =>
  new Map(Object.entries(entries));

describe('leg 1 — adapter coverage (the WS-K / CSRF failure shapes)', () => {
  const STORE = `
    export interface TokenStore { get(k: string): Promise<string | undefined>; }
    export class MemoryTokenStore implements TokenStore {
      async get() { return undefined; }
    }
    export class RedisTokenStore implements TokenStore {
      async get() { return undefined; }
    }
    let store: TokenStore = new MemoryTokenStore();
  `;

  it('BITES on an existing-but-never-wired production adapter (the CSRF gap)', () => {
    const tree = files({
      'index.ts': "import { createApp } from './app.js';",
      'app.ts': "import './middleware/csrf.js';",
      'middleware/csrf.ts': STORE,
    });
    const issues = checkAdapterCoverage(tree, buildBootClosure(tree, 'index.ts'), {});
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain('MemoryTokenStore');
    expect(issues[0]).toContain('TokenStore');
  });

  it('passes once the production adapter is instantiated in the boot closure', () => {
    const tree = files({
      'index.ts':
        "import { RedisTokenStore } from './middleware/csrf.js';\n" +
        'const wired = new RedisTokenStore();',
      'middleware/csrf.ts': STORE,
    });
    expect(checkAdapterCoverage(tree, buildBootClosure(tree, 'index.ts'), {})).toEqual([]);
  });

  it('parses generic implements lists at depth 0 (nested type arguments, no phantom names)', () => {
    const tree = files({
      'index.ts':
        "import { RedisPairStore } from './stores.js';\n" + 'const wired = new RedisPairStore();',
      'stores.ts': `
        export interface PairStore<K, V> { get(k: K): Promise<V | undefined>; }
        export interface Closable { close(): Promise<void>; }
        export class MemoryPairStore implements PairStore<string, Map<string, number>>, Closable {
          async get() { return undefined; }
          async close() {}
        }
        export class RedisPairStore implements PairStore<string, Map<string, number>>, Closable {
          async get() { return undefined; }
          async close() {}
        }
        let store: PairStore<string, Map<string, number>> = new MemoryPairStore();
      `,
    });
    // The comma inside Map<string, number> must NOT split the list — both
    // PairStore and Closable are covered by the wired Redis adapter.
    expect(checkAdapterCoverage(tree, buildBootClosure(tree, 'index.ts'), {})).toEqual([]);
  });

  it('BITES on an interface with NO production adapter at all (the WS-K gap)', () => {
    const tree = files({
      'index.ts': "import './ai/stores.js';",
      'ai/stores.ts': `
        export interface ModelRegistryStore { register(): Promise<void>; }
        export class InMemoryModelRegistryStore implements ModelRegistryStore {
          async register() {}
        }
        export const registry = new InMemoryModelRegistryStore();
      `,
    });
    const issues = checkAdapterCoverage(tree, buildBootClosure(tree, 'index.ts'), {});
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain('InMemoryModelRegistryStore');
  });

  it('accepts an allowlisted adapter but flags a stale allowlist entry', () => {
    const tree = files({
      'index.ts': "import './x.js';",
      'x.ts': `
        interface EphemeraStore { get(): void; }
        class InMemoryEphemeraStore implements EphemeraStore { get() {} }
        const s = new InMemoryEphemeraStore();
      `,
    });
    const closure = buildBootClosure(tree, 'index.ts');
    expect(
      checkAdapterCoverage(tree, closure, { InMemoryEphemeraStore: 'documented ephemera' }),
    ).toEqual([]);
    const stale = checkAdapterCoverage(tree, closure, { InMemoryGoneStore: 'obsolete' });
    expect(
      stale.some((issue) => issue.includes("stale ADAPTER_ALLOWLIST entry 'InMemoryGoneStore'")),
    ).toBe(true);
  });

  it('does not follow dynamic imports (dev-only branches stay outside the closure)', () => {
    const tree = files({
      'index.ts': "const dev = await import('./dev-only.js');",
      'dev-only.ts': "import { RedisThingStore } from './thing.js'; new RedisThingStore();",
      'thing.ts': `
        interface ThingStore { x(): void; }
        export class InMemoryThingStore implements ThingStore { x() {} }
        export class RedisThingStore implements ThingStore { x() {} }
        const t = new InMemoryThingStore();
      `,
    });
    // The Redis adapter is instantiated ONLY behind a dynamic import — that is
    // not production wiring, so the gate still bites.
    const issues = checkAdapterCoverage(tree, buildBootClosure(tree, 'index.ts'), {});
    expect(issues).toHaveLength(1);
  });
});

describe('leg 2 — env-key validation (the LCAP_IPFS failure shape)', () => {
  const schemaKeys = new Set(['DATABASE_URL', 'REDIS_URL']);

  it('BITES on an unvalidated production env key', () => {
    const tree = files({
      'lcap/service.ts': "const url = process.env['LCAP_IPFS_GATEWAY_URL'];",
    });
    const issues = checkEnvKeys(tree, schemaKeys, {});
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain('LCAP_IPFS_GATEWAY_URL');
  });

  it('passes schema keys and allowlisted dev flags; flags stale allowlist entries', () => {
    const tree = files({
      'index.ts': "const a = process.env['DATABASE_URL']; const b = process.env.REDIS_URL;",
      'dev.ts': "const sim = process.env['LICIO_SIM'];",
    });
    expect(checkEnvKeys(tree, schemaKeys, { LICIO_SIM: 'dev toggle' })).toEqual([]);
    const stale = checkEnvKeys(tree, schemaKeys, {
      LICIO_SIM: 'dev toggle',
      GONE_FLAG: 'obsolete',
    });
    expect(stale.some((issue) => issue.includes("stale ENV_ALLOWLIST entry 'GONE_FLAG'"))).toBe(
      true,
    );
  });
});

describe('leg 3 — production-adapter purity (the upload-bytes failure shape)', () => {
  it('BITES on a Map field inside a Drizzle adapter', () => {
    const tree = files({
      'forum/drizzle-forum-stores.ts': `
        export class DrizzleUploadStore {
          readonly #memoryBytes = new Map<string, Uint8Array>();
        }
      `,
    });
    const issues = checkAdapterPurity(tree, []);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain('#memoryBytes');
  });

  it('BITES on a composed in-memory adapter; per-call locals stay fine', () => {
    const tree = files({
      'x/drizzle-store.ts': `
        export class DrizzleXStore {
          private readonly mailbox = new InMemoryXStore();
          async list() {
            const out = new Map<string, string>(); // per-call working structure
            return out;
          }
        }
      `,
    });
    const issues = checkAdapterPurity(tree, []);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain('InMemoryXStore');
  });

  it('accepts allowlisted lines and flags stale entries', () => {
    const tree = files({
      'x/drizzle-store.ts': 'class D { private readonly mailbox = new InMemoryXStore(); }',
    });
    expect(
      checkAdapterPurity(tree, [
        {
          file: 'x/drizzle-store.ts',
          needle: 'new InMemoryXStore()',
          reason: 'injectable default',
        },
      ]),
    ).toEqual([]);
    const stale = checkAdapterPurity(tree, [
      { file: 'gone.ts', needle: 'nothing', reason: 'obsolete' },
    ]);
    expect(stale.some((issue) => issue.includes('stale PURITY_ALLOWLIST entry'))).toBe(true);
  });

  it('never trips on comments', () => {
    const source = stripComments('// readonly #x = new Map<string, string>();\nconst y = 1;');
    expect(checkAdapterPurity(files({ 'a/drizzle-a.ts': source }), [])).toEqual([]);
  });
});

describe('stripComments (tokenizer)', () => {
  it('strips line + block comments while preserving newlines (line numbers hold)', () => {
    const stripped = stripComments('a; // gone\n/* also\ngone */ b;');
    expect(stripped).not.toContain('gone');
    expect(stripped).toContain('a;');
    expect(stripped).toContain('b;');
    // Newlines survive so leg-3 finding line numbers stay accurate.
    expect(stripped.split('\n')).toHaveLength(3);
    expect(stripped.split('\n')[2]).toContain('b;');
  });

  it('respects string and template literals (no mangling of // inside strings)', () => {
    expect(stripComments("const u = 'https://x/y'; // tail")).toBe(
      "const u = 'https://x/y';        ",
    );
    expect(stripComments('const s = "a // not a comment";')).toBe(
      'const s = "a // not a comment";',
    );
    expect(stripComments('const t = `block /* kept */ inside`;')).toBe(
      'const t = `block /* kept */ inside`;',
    );
  });

  it('honours escapes so an escaped quote cannot desynchronize the states', () => {
    expect(stripComments("const q = 'it\\'s'; // gone")).toBe("const q = 'it\\'s';        ");
  });
});

describe('the live tree', () => {
  // Walks + parses all of apps/api/src (~600 files): ~2s locally, but slow
  // enough under CI coverage instrumentation to need its own budget.
  it('passes the full gate with the current allowlists (no rot, no regressions)', {
    timeout: 60_000,
  }, () => {
    expect(runProdParityGate(collectApiSourceFiles())).toEqual([]);
  });
});

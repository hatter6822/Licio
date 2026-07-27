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
  collectAdapters,
  collectApiSourceFiles,
  runProdParityGate,
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
    // RAW source, no pre-stripping: the gate reads the parse, so a comment is
    // not a node and cannot be mistaken for state.
    const source = '// readonly #x = new Map<string, string>();\nconst y = 1;';
    expect(checkAdapterPurity(files({ 'a/drizzle-a.ts': source }), [])).toEqual([]);
  });

  it('scopes to a class BODY without counting braces', () => {
    // The old scope tracker counted `{` and `}` per line, so a brace inside a
    // string or template shifted the depth and could end the class region
    // early — carrying the scan out of the production adapter, or leaving it
    // inside one it had already left.
    const source = [
      'export class DrizzleThing implements Store {',
      `  readonly label = \`a } brace \${"in {a} template"}\`;`,
      '  readonly #cache = new Map<string, string>();',
      '}',
      'export class InMemoryThing implements Store {',
      '  readonly #fine = new Map<string, string>();',
      '}',
    ].join('\n');
    const issues = checkAdapterPurity(files({ 'a/thing.ts': source }), []);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain('a/thing.ts:3');
  });

  it('reads a multi-line implements clause', () => {
    // Generic arguments and a wrapped clause both broke a single-line regex.
    const source = [
      'export class InMemoryWide',
      '  implements Store<Map<string, number>>, Other',
      '{',
      '  readonly #x = 1;',
      '}',
      'const made = new InMemoryWide();',
    ].join('\n');
    const adapters = collectAdapters(files({ 'a/wide.ts': source }), /^(?:InMemory|Memory)\w*/);
    expect(adapters).toEqual([
      { className: 'InMemoryWide', interfaces: ['Store', 'Other'], file: 'a/wide.ts' },
    ]);
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

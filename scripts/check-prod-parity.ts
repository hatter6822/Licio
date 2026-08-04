// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Production-parity gate — the recurrence guard from the 2026-07 dev↔prod
// parity remediation.  The project rule (the production-complete posture):
// development may fake a feature, but PRODUCTION must run the real, durable,
// fully functional implementation.  Every gap that remediation closed had one
// of three mechanical shapes; this gate makes each shape a CI failure:
//
//   1. ADAPTER COVERAGE — an in-memory adapter (`InMemory*` / `Memory*`, the
//      mandatory naming convention) is instantiated in server code, but its
//      interface has NO production adapter (`Drizzle*` / `Redis*` / etc.)
//      instantiated anywhere in the production boot's import closure.  This
//      is how the WS-K stores, the push registry, the reply-notification
//      inbox, and the settings map served production from process memory —
//      and how the CSRF RedisTokenStore existed for months without ever
//      being wired.
//   2. ENV VALIDATION — server code reads a `process.env` key that the
//      validated server env schema does not know (and that is not a
//      documented dev-only flag).  This is how the LCAP→IPFS bridge shipped
//      with unvalidated config that silently disabled on a partial pair.
//   3. ADAPTER PURITY — a production adapter file (`drizzle-*` / `redis-*`)
//      holds un-allowlisted in-memory state.  This is how upload blob BYTES
//      lived in a restart-volatile Map inside the Drizzle store, and how the
//      rendezvous signal mailbox stayed process-local under Postgres.
//   4. COMPOSITION PARITY — a composition root does not install the §19.3
//      data-rights hooks, or installs one BESIDE the shared installer.  Every
//      `IdentityServices` export/purge hook is OPTIONAL, and an absent one is a
//      silent no-op: the DSAR archive simply omits that store and the erasure
//      simply leaves it behind, with no error, no log line and no failing test.
//      Assigned inline, each new hook had to be remembered in every root — and
//      was not: the E2E harness ran with the attention, content, client-state,
//      moderation-notice and private-room-directory hooks all absent, so the
//      runtime that drives the authenticated flows could not fail on any
//      disclosure or deletion gap.  `identity/data-rights-hooks.ts` owns them
//      now; this leg is what keeps a root from drifting away from it again.
//
// Every allowlist entry requires a written reason; an entry that no longer
// matches anything is itself an error (allowlists must not rot).
//
// READ FROM THE PARSE.  All three legs ask structural questions — which classes
// implement which interfaces, which modules the boot statically imports, which
// `process.env` keys are read, which state a production adapter holds — and all
// three were answered with regexes over text plus a FOURTH hand-written comment
// stripper.  Leg 3 tracked class scope by counting `{` and `}` per LINE, which
// counts braces inside strings, templates and regexes; and the env-schema
// reader depended on the schema being indented exactly two spaces.
//
// The compiler answers each of them directly, and the one deliberate
// APPROXIMATION survives unchanged: dynamic imports are still not followed
// (see `buildBootClosure`), because under-approximating the boot closure can
// only make this gate stricter.
import { readdirSync, readFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { SyntaxKind } from 'typescript/unstable/ast';
import type { Project } from 'typescript/unstable/sync';
import {
  lineAt,
  newlineIndex,
  type ParsedSource,
  type Syntax,
  walk,
  withParsedSources,
} from './ts-source.js';

const ROOT = resolve(import.meta.dirname, '..');
const API_SRC = resolve(ROOT, 'apps/api/src');
const ENV_SCHEMA_SOURCE = resolve(ROOT, 'packages/shared/src/env/server.ts');
const BOOT_ENTRY = 'index.ts';

/** Leg 4: the module that OWNS the data-rights hooks, and the roots that must
 *  install them.  The E2E harness is a composition root for this purpose even
 *  though it is excluded from the production legs above: it is the runtime the
 *  authenticated E2E flows run against, so a hook missing there is a guarantee
 *  no test can fail on. */
const DATA_RIGHTS_MODULE = resolve(API_SRC, 'identity/data-rights-hooks.ts');
const DATA_RIGHTS_INSTALLER = 'installDataRightsHooks';
const COMPOSITION_ROOTS = ['index.ts', 'e2e-server.ts'] as const;

const TEST_FILE = /\.(?:test|spec)\.tsx?$/;
/** Dev-only trees/files that never serve production (structurally excluded). */
const EXCLUDED = [/(^|\/)__tests__(\/|$)/, /(^|\/)simulator(\/|$)/, /(^|\/)e2e-server\.ts$/];

// ---------------------------------------------------------------------------
// Allowlists.  EVERY entry needs a reason; stale entries fail the gate.
// ---------------------------------------------------------------------------

/** Leg 1: in-memory adapters tolerated WITHOUT a boot-wired production
 *  adapter.  Empty today — the remediation closed every instance.  Adding an
 *  entry requires a written justification a reviewer can weigh. */
export const ADAPTER_ALLOWLIST: Record<string, string> = {};

/** Leg 2: process.env keys legitimately read OUTSIDE the validated schema —
 *  dev/test-only switches that must never gate a production feature. */
export const ENV_ALLOWLIST: Record<string, string> = {
  ALLOW_INSECURE_NULL_MAILER:
    'explicit production opt-OUT (mail-less deployment); documented in DEVELOPMENT.md §7.4',
  DEV_HTTPS: 'local-TLS dev switch (DEVELOPMENT.md §11); never read on a production path',
  LICIO_SIM: 'dev traffic simulator toggle; the simulator tree is excluded from production',
  LICIO_SIM_SEED: 'dev traffic simulator PRNG seed',
  LICIO_LLM_SIM: 'dev simulated governance-LLM toggle; NODE_ENV=development-gated',
  LICIO_LLM_SIM_PORT: 'dev simulated governance-LLM port override',
  LICIO_E2E: 'e2e harness gate; the route it guards 404s outside dev/test',
};

/** Leg 3: in-memory state tolerated INSIDE a production adapter file.  Each
 *  entry pins one file + one needle that must appear on the flagged line. */
export const PURITY_ALLOWLIST: Array<{ file: string; needle: string; reason: string }> = [
  {
    file: 'private-rendezvous/drizzle-store.ts',
    needle: 'new InMemoryRendezvousStore()',
    reason:
      'injectable constructor DEFAULT for the transient signal mailbox; the production boot ' +
      'always passes the Redis mailbox (REDIS_URL is boot-required in production)',
  },
  {
    file: 'forum/redis-broadcasters.ts',
    needle: '#handlers = new Map',
    reason:
      'per-channel handler ROUTING table for the shared subscriber connection — bounded by ' +
      'live SSE subscriptions on this instance, not replicated state',
  },
  {
    file: 'forum/redis-broadcasters.ts',
    needle: '#ready = new Map',
    reason:
      'per-channel SUBSCRIBE-ack promises (subscribe resolves only after Redis acks, closing ' +
      'the snapshot/live race) — connection-local handshake state, not replicated state',
  },
  {
    file: 'ai-governance/model-hub.ts',
    needle: '#cache = new Map',
    reason:
      'bounded TTL cache of THIRD-PARTY hub metadata (huggingface.co reads) — evictable by ' +
      'design, never domain state: a restart merely re-fetches, and the durable candidacy ' +
      'record is the hub_verification snapshot on the governance model row',
  },
];

// ---------------------------------------------------------------------------
// File collection + comment stripping.
// ---------------------------------------------------------------------------

export function isExcluded(relPath: string): boolean {
  return TEST_FILE.test(relPath) || EXCLUDED.some((p) => p.test(relPath));
}

export function collectApiSourceFiles(): Map<string, string> {
  const files = new Map<string, string>();
  collectFiles(API_SRC, API_SRC, files);
  return files;
}

function collectFiles(dir: string, base: string, out: Map<string, string>): void {
  // Dirent-based walk (no separate stat) — atomic type information per entry.
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, entry.name);
    const rel = abs.slice(base.length + 1).replaceAll('\\', '/');
    if (entry.isDirectory()) {
      collectFiles(abs, base, out);
      continue;
    }
    if (!entry.name.endsWith('.ts') || entry.name.endsWith('.d.ts') || isExcluded(rel)) continue;
    out.set(rel, readFileSync(abs, 'utf-8'));
  }
}

/** Shared AST helpers: a name, a static string, and the children of a node. */
function nameOf(node: Syntax | undefined): string | undefined {
  return node === undefined ? undefined : (node.text ?? node.getText());
}

function staticString(node: Syntax | undefined, hop = 0): string | undefined {
  if (node === undefined || hop > 8) return undefined;
  if (
    node.kind === SyntaxKind.StringLiteral ||
    node.kind === SyntaxKind.NoSubstitutionTemplateLiteral
  ) {
    return node.text ?? '';
  }
  // `'KEY' as const` and `('KEY')` are the same string: the wrappers change
  // the TYPE and nothing about the value, and stopping at them read a literal
  // written the ordinary way as unreadable.
  if (
    node.kind === SyntaxKind.AsExpression ||
    node.kind === SyntaxKind.SatisfiesExpression ||
    node.kind === SyntaxKind.ParenthesizedExpression ||
    node.kind === SyntaxKind.NonNullExpression
  ) {
    return staticString(node.expression, hop + 1);
  }
  return undefined;
}

function childrenOf(node: Syntax): Syntax[] {
  const children: Syntax[] = [];
  node.forEachChild((child) => {
    children.push(child);
  });
  return children;
}

/** Parse a file map once, in one project. */
function parseAll(files: Map<string, string>): ParsedSource[] {
  return withParsedSources(
    [...files].map(([path, content]) => ({ path, content })),
    (parsed) => [...parsed],
  );
}

/**
 * Parse and run `body` WITH the project still open.
 *
 * `parseAll` hands the trees back after the project is torn down, which is
 * enough for a purely syntactic leg and useless to one that has to resolve a
 * name.  Two legs do: an adapter reached through an import alias and an
 * environment read reached through a binding are both invisible to a scan that
 * compares the spelling at the use site.
 */
function withParsed<T>(
  files: Map<string, string>,
  body: (parsed: readonly ParsedSource[], project: Project) => T,
): T {
  return withParsedSources(
    [...files].map(([path, content]) => ({ path, content })),
    body,
  );
}

/** The declaration a name binds to, followed through import aliases. */
function declarationOf(node: Syntax, project: Project, file: string): Syntax | undefined {
  const symbol = project.checker.getSymbolAtPosition(file, node.getStart());
  if (symbol === undefined) return undefined;
  let resolved = symbol;
  for (let hop = 0; hop < 8; hop += 1) {
    const handle = resolved.declarations[0];
    if (handle === undefined) return undefined;
    const declaration = handle.resolve(project) as unknown as Syntax | undefined;
    if (declaration === undefined) return undefined;
    // `const Store = InMemoryThing` names the same class in one more hop, so
    // the local alias is followed exactly as the import alias is — the fix that
    // only crossed module edges left the in-file spelling open.
    if (declaration.kind === SyntaxKind.VariableDeclaration) {
      const initializer = declaration.initializer;
      if (initializer?.kind !== SyntaxKind.Identifier) return declaration;
      const next = project.checker.getSymbolAtPosition(file, initializer.getStart());
      if (next === undefined) return declaration;
      resolved = next;
      continue;
    }
    if (!IMPORTED_BINDING.has(declaration.kind)) return declaration;
    try {
      const next = project.checker.getAliasedSymbol(resolved);
      if (next === undefined) return declaration;
      resolved = next;
    } catch {
      return declaration;
    }
  }
  return undefined;
}

/** Bindings that name something declared in another module. */
const IMPORTED_BINDING: ReadonlySet<SyntaxKind> = new Set([
  SyntaxKind.ImportSpecifier,
  SyntaxKind.ImportClause,
  SyntaxKind.NamespaceImport,
  SyntaxKind.ImportEqualsDeclaration,
]);

// ---------------------------------------------------------------------------
// Leg 1 — adapter coverage.
// ---------------------------------------------------------------------------

const IN_MEMORY_PREFIX = /^(?:InMemory|Memory)\w*/;
const PRODUCTION_PREFIX = /^(?:Drizzle|Redis|Postgres|S3|Ses|Http)\w*/;

export interface AdapterInfo {
  className: string;
  interfaces: string[];
  /**
   * The same interfaces as DECLARATION IDENTITIES.
   *
   * Two modules may each declare a `Store`, and they are different contracts.
   * Matching by name treated an in-memory adapter of one as covered by a
   * production adapter of the other — the exact confusion this gate exists to
   * prevent.  The name is kept for the message; the identity does the matching.
   */
  interfaceKeys: string[];
  file: string;
}

/**
 * The classes whose NAME matches `prefix` and the interfaces they implement.
 *
 * A heritage clause is a node, so the generics that made the old regex need a
 * depth-aware splitter (`Store<Map<K, V>>, Other`) are simply not in the way —
 * and a multi-line `implements` list, an `extends X implements Y`, or a type
 * argument containing `{` cannot break it.
 */
function adaptersIn(
  parsed: readonly ParsedSource[],
  prefix: RegExp,
  project: Project,
): AdapterInfo[] {
  const out: AdapterInfo[] = [];
  for (const { path, root } of parsed) {
    const here = String(root.path);
    for (const node of walk(root)) {
      if (node.kind !== SyntaxKind.ClassDeclaration) continue;
      const className = nameOf(node.name);
      if (className === undefined || !prefix.test(className)) continue;
      const interfaces: string[] = [];
      const interfaceKeys: string[] = [];
      for (const clause of childrenOf(node)) {
        if (clause.kind !== SyntaxKind.HeritageClause) continue;
        if (clause.token !== SyntaxKind.ImplementsKeyword) continue;
        for (const implemented of childrenOf(clause)) {
          const named = implemented.expression;
          const name = nameOf(named);
          if (name === undefined || named === undefined) continue;
          interfaces.push(name);
          // The DECLARATION the name resolves to, so two same-named interfaces
          // in different modules are two contracts.  Followed through the
          // IMPORT: an imported interface resolves to the specifier in THIS
          // file, so two files importing the same contract would otherwise get
          // two identities — which is the same confusion in the other
          // direction.  An unresolvable one falls back to the name.
          interfaceKeys.push(interfaceIdentity(named, project, here) ?? `name:${name}`);
        }
      }
      if (interfaces.length > 0) out.push({ className, interfaces, interfaceKeys, file: path });
    }
  }
  return out;
}

export function collectAdapters(files: Map<string, string>, prefix: RegExp): AdapterInfo[] {
  return withParsed(files, (parsed, project) => adaptersIn(parsed, prefix, project));
}

/** Every class NEWED anywhere in these sources. */
function constructedIn(
  parsed: readonly ParsedSource[],
  project: Project,
): Map<string, Set<string>> {
  const byFile = new Map<string, Set<string>>();
  for (const { path, root } of parsed) {
    const names = new Set<string>();
    const here = String(root.path);
    for (const node of walk(root)) {
      if (node.kind !== SyntaxKind.NewExpression) continue;
      const callee = node.expression;
      if (callee === undefined) continue;
      // The SPELLING at the call site is not the class: `import { InMemoryX as
      // Store } from './s.js'; new Store()` records `Store`, while coverage
      // looks for `InMemoryX` — so an in-memory adapter constructed under an
      // alias had no counterpart demanded of it, and production could silently
      // keep process-local state.
      const declared = declarationOf(callee, project, here);
      const name =
        declared?.kind === SyntaxKind.ClassDeclaration ? nameOf(declared.name) : nameOf(callee);
      if (name !== undefined) names.add(name);
    }
    byFile.set(path, names);
  }
  return byFile;
}

/**
 * BFS the PRODUCTION boot's STATIC relative-import closure from `entry`.
 *
 * Dynamic `import(...)` edges are deliberately NOT followed.  The closure is
 * used in exactly one way — as POSITIVE EVIDENCE that a production adapter is
 * wired (leg 1); legs 2 and 3 scan every file regardless.  Under-approximating
 * the closure can therefore only make the gate STRICTER (a false alarm, loud
 * and cheap to resolve); over-approximating it creates the silent false PASS
 * this gate exists to prevent.  A dynamic import is the one syntactic marker
 * of CONDITIONAL execution static analysis can see without evaluating guards
 * — and "referenced but never executed in production" is precisely the CSRF
 * failure shape (the RedisTokenStore existed, was reachable, and never ran).
 *
 * On the current tree the rule is correct-or-redundant by construction: every
 * relative dynamic import in server code is either (a) a dev-only branch
 * (`index.ts` → simulator/link-fixtures, NODE_ENV-gated) where following
 * would be UNSOUND, or (b) a lazy cycle-breaker (forum→ranking,
 * middleware→identity, auth→security-alerts) whose target is ALSO statically
 * imported by the boot, so following adds nothing.  If a future module is
 * ever reachable ONLY via a production dynamic import and carries the sole
 * wiring of an adapter, the gate false-alarms: make the wiring static, or
 * allowlist it with a written reason.  The runtime parity guard
 * (apps/api/src/lib/parity-guard.ts) remains the EXACT check either way — it
 * inspects the real container objects after every boot condition has
 * evaluated.
 */
function closureIn(parsed: readonly ParsedSource[], entry: string): Set<string> {
  // STATIC relative specifiers only.  A dynamic `import(…)` is a call, not an
  // import declaration, so it is not collected — which is the documented
  // approximation above, now true by construction rather than by a regex that
  // happened to require `from`.
  const importsOf = new Map<string, string[]>();
  for (const { path, root } of parsed) {
    const specifiers: string[] = [];
    for (const node of walk(root)) {
      if (
        node.kind !== SyntaxKind.ImportDeclaration &&
        node.kind !== SyntaxKind.ExportDeclaration
      ) {
        continue;
      }
      const specifier = staticString(node.moduleSpecifier);
      if (specifier?.startsWith('.') === true) specifiers.push(specifier);
    }
    importsOf.set(path, specifiers);
  }

  const closure = new Set<string>();
  const queue = [entry];
  while (queue.length > 0) {
    const current = queue.pop() as string;
    if (closure.has(current)) continue;
    const specifiers = importsOf.get(current);
    if (specifiers === undefined) continue; // excluded (dev-only) or external
    closure.add(current);
    for (const specifier of specifiers) {
      queue.push(join(dirname(current), specifier.replace(/\.js$/, '.ts')).replaceAll('\\', '/'));
    }
  }
  return closure;
}

export function buildBootClosure(files: Map<string, string>, entry: string): Set<string> {
  return closureIn(parseAll(files), entry);
}

export function checkAdapterCoverage(
  files: Map<string, string>,
  closure: Set<string>,
  allowlist: Record<string, string> = ADAPTER_ALLOWLIST,
): string[] {
  return withParsed(files, (parsed, project) => coverageIn(parsed, project, closure, allowlist));
}

function coverageIn(
  parsed: readonly ParsedSource[],
  project: Project,
  closure: Set<string>,
  allowlist: Record<string, string> = ADAPTER_ALLOWLIST,
): string[] {
  const issues: string[] = [];
  const inMemory = adaptersIn(parsed, IN_MEMORY_PREFIX, project);
  const production = adaptersIn(parsed, PRODUCTION_PREFIX, project);
  const constructed = constructedIn(parsed, project);

  // interface → production adapter class names.
  const productionByInterface = new Map<string, string[]>();
  for (const adapter of production) {
    for (const iface of adapter.interfaceKeys) {
      const list = productionByInterface.get(iface) ?? [];
      list.push(adapter.className);
      productionByInterface.set(iface, list);
    }
  }

  // Which production adapters are INSTANTIATED within the boot closure?
  const instantiatedInClosure = new Set<string>();
  for (const file of closure) {
    for (const name of constructed.get(file) ?? []) {
      if (PRODUCTION_PREFIX.test(name)) instantiatedInClosure.add(name);
    }
  }

  const usedAllowlist = new Set<string>();
  for (const adapter of inMemory) {
    // Only adapters actually constructed in server code matter.
    const isConstructed = [...constructed.values()].some((names) => names.has(adapter.className));
    if (!isConstructed) continue;
    if (allowlist[adapter.className] !== undefined) {
      usedAllowlist.add(adapter.className);
      continue;
    }
    const covered = adapter.interfaceKeys.some((iface) =>
      (productionByInterface.get(iface) ?? []).some((name) => instantiatedInClosure.has(name)),
    );
    if (!covered) {
      issues.push(
        `${adapter.file}: ${adapter.className} (implements ${adapter.interfaces.join(', ')}) ` +
          'is instantiated in server code but NO production adapter for its interface is ' +
          'instantiated in the production boot import closure — production would serve from ' +
          'process memory. Implement + wire a Drizzle/Redis adapter (the house pattern), or ' +
          'allowlist it in scripts/check-prod-parity.ts with a written justification.',
      );
    }
  }
  for (const name of Object.keys(allowlist)) {
    if (!usedAllowlist.has(name)) {
      issues.push(
        `stale ADAPTER_ALLOWLIST entry '${name}': it no longer matches any constructed ` +
          'in-memory adapter — remove it.',
      );
    }
  }
  return issues;
}

// ---------------------------------------------------------------------------
// Leg 2 — env-key validation.
// ---------------------------------------------------------------------------

export function checkEnvKeys(
  files: Map<string, string>,
  schemaKeys: ReadonlySet<string>,
  allowlist: Record<string, string> = ENV_ALLOWLIST,
): string[] {
  return withParsed(files, (parsed, project) => envKeysIn(parsed, project, schemaKeys, allowlist));
}

/** The `process.env` keys a source reads, in either access spelling. */
/**
 * A stable identity for an interface reference, across the modules that use it.
 *
 * `path#index` of the ORIGINAL declaration, so the same contract imported into
 * two files is one identity and two same-named contracts are two.
 */
function interfaceIdentity(node: Syntax, project: Project, file: string): string | undefined {
  let symbol = project.checker.getSymbolAtPosition(file, node.getStart());
  if (symbol === undefined) return undefined;
  for (let hop = 0; hop < 8; hop += 1) {
    const handle = symbol.declarations[0];
    if (handle === undefined) return undefined;
    const declaration = handle.resolve(project) as unknown as Syntax | undefined;
    if (declaration === undefined || !IMPORTED_BINDING.has(declaration.kind)) {
      return `${String(handle.path)}#${handle.index}`;
    }
    try {
      const next = project.checker.getAliasedSymbol(symbol);
      if (next === undefined) return `${String(handle.path)}#${handle.index}`;
      symbol = next;
    } catch {
      return `${String(handle.path)}#${handle.index}`;
    }
  }
  return undefined;
}

/** The marker for an environment key whose name this gate cannot recover. */
export const UNREADABLE_ENV_KEY = '\u0000unreadable';

/** A string a NAME holds, followed one hop through its binding. */
function constantString(
  node: Syntax | undefined,
  project: Project,
  file: string,
  hop = 0,
): string | undefined {
  if (node?.kind !== SyntaxKind.Identifier || hop > 4) return undefined;
  const declaration = declarationOf(node, project, file);
  if (declaration?.kind !== SyntaxKind.VariableDeclaration) return undefined;
  return (
    staticString(declaration.initializer) ??
    constantString(declaration.initializer, project, file, hop + 1)
  );
}

/** Whether an expression IS `process.env`, however it was reached. */
function isProcessEnv(node: Syntax | undefined, project: Project, file: string, hop = 0): boolean {
  if (node === undefined || hop > 8) return false;
  if (node.kind === SyntaxKind.PropertyAccessExpression) {
    return nameOf(node.expression) === 'process' && nameOf(node.name) === 'env';
  }
  if (node.kind !== SyntaxKind.Identifier) return false;
  // `const env = process.env; env.KEY` reads the environment exactly as the
  // spelled form does; comparing the receiver's SYNTAX saw only the latter.
  const declaration = declarationOf(node, project, file);
  if (declaration?.kind !== SyntaxKind.VariableDeclaration) return false;
  return isProcessEnv(declaration.initializer, project, file, hop + 1);
}

function envKeysOf(root: Syntax, project: Project): string[] {
  const keys: string[] = [];
  const here = String(root.path);
  for (const node of walk(root)) {
    // `const { KEY } = process.env` names the key in a BINDING PATTERN rather
    // than in a property access, and reads it just the same.
    if (node.kind === SyntaxKind.BindingElement) {
      const pattern = node.parent;
      if (pattern?.kind !== SyntaxKind.ObjectBindingPattern) continue;
      if (!isProcessEnv(pattern.parent?.initializer, project, here)) continue;
      const key = nameOf((node.propertyName ?? node.name) as Syntax);
      if (key !== undefined) keys.push(key);
      continue;
    }
    const isProperty = node.kind === SyntaxKind.PropertyAccessExpression;
    const isElement = node.kind === SyntaxKind.ElementAccessExpression;
    if (!isProperty && !isElement) continue;
    if (!isProcessEnv(node.expression, project, here)) continue;
    // The key may be held in a CONSTANT: `const KEY = 'X' as const;
    // process.env[KEY]` reads the environment exactly as the literal does, and
    // reading only the syntax at the access saw nothing.
    const key = isProperty
      ? nameOf(node.name)
      : (staticString(node.argumentExpression) ??
        constantString(node.argumentExpression, project, here));
    // A key this gate CANNOT read is one it cannot match against the schema,
    // and passing it silently is the failure a fail-closed check must not have:
    // `process.env[pick()]` would otherwise read anything at all.
    keys.push(key ?? UNREADABLE_ENV_KEY);
  }
  return keys;
}

function envKeysIn(
  parsed: readonly ParsedSource[],
  project: Project,
  schemaKeys: ReadonlySet<string>,
  allowlist: Record<string, string> = ENV_ALLOWLIST,
): string[] {
  const issues: string[] = [];
  const usedAllowlist = new Set<string>();
  for (const { path: file, root } of parsed) {
    for (const key of envKeysOf(root, project)) {
      if (key === UNREADABLE_ENV_KEY) {
        issues.push(
          `${file}: reads process.env with a key this gate cannot read, so it cannot be matched ` +
            'against the validated server env schema. Use a literal key (or a constant holding ' +
            'one) so the read can be judged.',
        );
        continue;
      }
      if (schemaKeys.has(key)) continue;
      if (allowlist[key] !== undefined) {
        usedAllowlist.add(key);
        continue;
      }
      issues.push(
        `${file}: reads process.env['${key}'], which the validated server env schema ` +
          '(packages/shared/src/env/server.ts) does not know. Add it to the schema (validated ' +
          '+ documented, all-or-none for groups) or — for a dev-only switch — to the ' +
          'ENV_ALLOWLIST in scripts/check-prod-parity.ts with a written justification.',
      );
    }
  }
  for (const key of Object.keys(allowlist)) {
    if (!usedAllowlist.has(key)) {
      issues.push(`stale ENV_ALLOWLIST entry '${key}': no server code reads it — remove it.`);
    }
  }
  return issues;
}

// ---------------------------------------------------------------------------
// Leg 3 — production-adapter purity.
// ---------------------------------------------------------------------------

const PRODUCTION_ADAPTER_FILE = /^(?:drizzle|redis)-[\w-]*\.ts$/;
/**
 * The production-adapter class prefixes (CLAUDE.md store-adapter convention).
 *
 * S3/Ses/Http/Postgres adapters live in conventionally-NAMED files
 * (object-store-s3.ts, mailer-ses.ts, embeddings.ts, gateway.ts, …) that
 * `PRODUCTION_ADAPTER_FILE` does not match, so they are scanned class-scoped
 * instead — otherwise their in-memory state would escape the purity gate.
 *
 * A class NAME now, not a line of source: the declaration is a node, so the
 * `export`/`abstract` modifiers it used to have to spell out are simply part
 * of it.
 */
const PRODUCTION_ADAPTER_CLASS = /^(?:Drizzle|Redis|Postgres|S3|Ses|Http)[A-Z]\w*/;

/**
 * Long-lived in-memory state a production adapter holds.
 *
 * Two shapes: an in-memory adapter COMPOSED anywhere, and a Map/Set held as a
 * CLASS FIELD.  A per-call local (`const out = new Map()` as a working
 * structure) is fine, and telling the two apart is what the old regex needed a
 * modifier alternation for — a field is a `PropertyDeclaration`, so the
 * distinction is structural.
 */
function inMemoryStateIn(region: Syntax): Syntax[] {
  const found: Syntax[] = [];
  for (const node of walk(region)) {
    if (node.kind === SyntaxKind.NewExpression) {
      const name = nameOf(node.expression) ?? '';
      if (/^(?:InMemory|Memory)\w+/.test(name)) found.push(node);
      continue;
    }
    if (node.kind !== SyntaxKind.PropertyDeclaration) continue;
    const initializer = node.initializer;
    if (initializer?.kind !== SyntaxKind.NewExpression) continue;
    const held = nameOf(initializer.expression) ?? '';
    if (held === 'Map' || held === 'Set') found.push(node);
  }
  return found;
}

export function checkAdapterPurity(
  files: Map<string, string>,
  allowlist: Array<{ file: string; needle: string; reason: string }> = PURITY_ALLOWLIST,
): string[] {
  return purityIn(parseAll(files), allowlist);
}

function purityIn(
  parsed: readonly ParsedSource[],
  allowlist: Array<{ file: string; needle: string; reason: string }> = PURITY_ALLOWLIST,
): string[] {
  const issues: string[] = [];
  const usedAllowlist = new Set<number>();
  for (const { path: file, content, root } of parsed) {
    // drizzle-*/redis-* files are production-only (no in-memory classes), so the
    // whole file is scanned.  Any OTHER file is scanned only inside a
    // production-adapter class BODY — a file co-locating an in-memory adapter
    // with a production one must not have the in-memory class's legitimate
    // Map/Set fields flagged.  The class body is a NODE, so the scope needs no
    // brace counting: the old line-by-line depth tracker counted braces inside
    // strings, templates and regexes alike.
    const isPrefixFile = PRODUCTION_ADAPTER_FILE.test(basename(file));
    const regions: Syntax[] = [];
    if (isPrefixFile) regions.push(root);
    else {
      for (const node of walk(root)) {
        if (node.kind !== SyntaxKind.ClassDeclaration) continue;
        const className = nameOf(node.name);
        if (className !== undefined && PRODUCTION_ADAPTER_CLASS.test(className)) regions.push(node);
      }
    }
    const lines = content.split('\n');
    const newlines = newlineIndex(content);
    const reported = new Set<number>();
    for (const region of regions) {
      for (const node of inMemoryStateIn(region)) {
        const line = lineAt(newlines, node.getStart());
        if (reported.has(line)) continue;
        reported.add(line);
        const text = lines[line - 1] ?? '';
        const allowed = allowlist.findIndex(
          (entry) => file.endsWith(entry.file) && text.includes(entry.needle),
        );
        if (allowed >= 0) {
          usedAllowlist.add(allowed);
          continue;
        }
        issues.push(
          `${file}:${line}: a production adapter holds in-memory state ` +
            `(${text.trim().slice(0, 80)}…) — state in a Drizzle/Redis adapter must live in the ` +
            'backing service (this is how upload bytes once vanished on restart). Move it, or ' +
            'allowlist the line in scripts/check-prod-parity.ts with a written justification.',
        );
      }
    }
  }
  allowlist.forEach((entry, index) => {
    if (!usedAllowlist.has(index)) {
      issues.push(
        `stale PURITY_ALLOWLIST entry '${entry.file}' / '${entry.needle}': it no longer ` +
          'matches any line — remove it.',
      );
    }
  });
  return issues;
}

// ---------------------------------------------------------------------------

/** The validated server env keys, parsed from the schema SOURCE (the schema's
 *  fields are SCREAMING_SNAKE zod entries).  A refactor that empties the parse
 *  fails loudly via the sanity floor rather than silently passing leg 2. */
export function parseServerEnvSchemaKeys(source: string): Set<string> {
  // The schema's fields are the PROPERTIES of the object literal it is built
  // from.  The regex this replaces matched a `[\s\S]*?` block and then keys at
  // exactly two spaces of indentation — so reformatting the file would have
  // emptied it silently, which is what the sanity floor below existed to catch.
  const keys = withParsedSources([{ path: 'env.ts', content: source }], (parsed) => {
    const found = new Set<string>();
    const root = parsed[0]?.root;
    if (root === undefined) return found;
    for (const node of walk(root)) {
      if (node.kind !== SyntaxKind.VariableDeclaration) continue;
      if (nameOf(node.name) !== 'serverEnvSchema') continue;
      for (const literal of walk(node)) {
        if (literal.kind !== SyntaxKind.ObjectLiteralExpression) continue;
        // TOP-LEVEL literals only.  Walking every one beneath the declaration
        // read a NESTED validator's fields as environment keys, so
        // `CONFIG: z.object({ UNVALIDATED: z.string() })` added `UNVALIDATED`
        // to the validated set — after which `process.env.UNVALIDATED` passed
        // the gate despite never being parsed from the environment.
        let nested = false;
        for (let above = literal.parent; above !== undefined; above = above.parent) {
          if (above.getStart() === node.getStart()) break;
          if (above.kind === SyntaxKind.ObjectLiteralExpression) {
            nested = true;
            break;
          }
        }
        if (nested) continue;
        for (const member of childrenOf(literal)) {
          const key = nameOf(member.name);
          if (key !== undefined && /^[A-Z][A-Z0-9_]*$/.test(key)) found.add(key);
        }
      }
    }
    return found;
  });
  if (keys.size < 10) {
    throw new Error(
      `check-prod-parity: parsed only ${keys.size} server env schema keys — the schema layout ` +
        'changed; update parseServerEnvSchemaKeys.',
    );
  }
  return keys;
}

// ---------------------------------------------------------------------------
// Leg 4: composition parity — every root installs every data-rights hook.
// ---------------------------------------------------------------------------

/** The hook names the installer owns, read from its OWN assignments. */
export function dataRightsHookNames(installerSource: string): Set<string> {
  const names = withParsed(new Map([['data-rights-hooks.ts', installerSource]]), (parsed) => {
    const found = new Set<string>();
    for (const source of parsed) {
      for (const node of walk(source.root)) {
        if (node.kind !== SyntaxKind.BinaryExpression) continue;
        if (node.operatorToken?.kind !== SyntaxKind.EqualsToken) continue;
        const left = node.left;
        if (left?.kind !== SyntaxKind.PropertyAccessExpression) continue;
        // `identity.<hook> = …`, where `identity` is the installer's own
        // parameter — the name is read off the assignment rather than listed
        // here, so a hook added to the installer is covered the moment it is.
        if (nameOf(left.expression) !== 'identity') continue;
        const hook = nameOf(left.name);
        if (hook !== undefined) found.add(hook);
      }
    }
    return found;
  });
  if (names.size < 5) {
    throw new Error(
      `check-prod-parity: read only ${names.size} data-rights hooks from ` +
        'identity/data-rights-hooks.ts — the installer changed shape; update dataRightsHookNames.',
    );
  }
  return names;
}

export function checkCompositionParity(
  roots: ReadonlyMap<string, string>,
  hooks: ReadonlySet<string>,
): string[] {
  return withParsed(
    [...roots].reduce((m, [k, v]) => m.set(k, v), new Map<string, string>()),
    (parsed) => {
      const issues: string[] = [];
      for (const source of parsed) {
        const newlines = newlineIndex(source.content);
        let installs = false;
        for (const node of walk(source.root)) {
          if (
            node.kind === SyntaxKind.CallExpression &&
            nameOf(node.expression) === DATA_RIGHTS_INSTALLER
          ) {
            installs = true;
          }
          // …and NOT beside it: an inline assignment of a hook the installer owns
          // is one root's private copy, which is exactly how the two drifted.
          if (node.kind !== SyntaxKind.BinaryExpression) continue;
          if (node.operatorToken?.kind !== SyntaxKind.EqualsToken) continue;
          const left = node.left;
          if (left?.kind !== SyntaxKind.PropertyAccessExpression) continue;
          const hook = nameOf(left.name);
          if (hook === undefined || !hooks.has(hook)) continue;
          issues.push(
            `${source.path}:${lineAt(newlines, node.getStart())} assigns the data-rights hook ` +
              `'${hook}' inline; it is owned by identity/data-rights-hooks.ts — add it THERE so ` +
              'every composition root gets it.',
          );
        }
        if (!installs) {
          issues.push(
            `${source.path} does not call ${DATA_RIGHTS_INSTALLER}(): its runtime would export and ` +
              'delete an account without the stores those hooks reach, silently.',
          );
        }
      }
      return issues;
    },
  );
}

export function runProdParityGate(files: Map<string, string>): string[] {
  const closure = buildBootClosure(files, BOOT_ENTRY);
  const schemaKeys = parseServerEnvSchemaKeys(readFileSync(ENV_SCHEMA_SOURCE, 'utf-8'));
  const hooks = dataRightsHookNames(readFileSync(DATA_RIGHTS_MODULE, 'utf-8'));
  const roots = new Map(
    COMPOSITION_ROOTS.map((root) => [root, readFileSync(resolve(API_SRC, root), 'utf-8')]),
  );
  return [
    ...checkAdapterCoverage(files, closure),
    ...checkEnvKeys(files, schemaKeys),
    ...checkAdapterPurity(files),
    ...checkCompositionParity(roots, hooks),
  ];
}

function main(): void {
  const issues = runProdParityGate(collectApiSourceFiles());
  if (issues.length > 0) {
    console.error('Production-parity gate FAILED — dev-fake-serving-production risk(s):');
    for (const issue of issues) console.error(`  - ${issue}`);
    process.exit(1);
  }
  console.log(
    'Production-parity gate passed: every in-memory adapter has a boot-wired production ' +
      'counterpart, every env key is schema-validated or a documented dev flag, no ' +
      'production adapter holds un-allowlisted in-memory state, and every composition root ' +
      'installs the data-rights hooks from the one module that owns them.',
  );
}

// Run as a script, but stay importable by the unit test.
if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  main();
}

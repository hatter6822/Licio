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
//
// Every allowlist entry requires a written reason; an entry that no longer
// matches anything is itself an error (allowlists must not rot).
import { readdirSync, readFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const API_SRC = resolve(ROOT, 'apps/api/src');
const ENV_SCHEMA_SOURCE = resolve(ROOT, 'packages/shared/src/env/server.ts');
const BOOT_ENTRY = 'index.ts';

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

/**
 * Strip block + line comments so prose can never trip a code pattern — via a
 * small tokenizer, not regexes: string/template literals are respected (a
 * regex strip mangles sources carrying `//` inside a string), and newlines
 * are preserved so finding line numbers stay accurate.  Regex literals are
 * not modeled (a quote inside one could open a phantom string state) — an
 * accepted residual far rarer than the regex-stripper's failure modes.
 */
export function stripComments(source: string): string {
  let out = '';
  let state: 'code' | 'line' | 'block' | 'single' | 'double' | 'template' = 'code';
  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i] as string;
    const next = source[i + 1];
    if (state === 'code') {
      if (ch === '/' && next === '/') {
        state = 'line';
        out += '  ';
        i += 1;
      } else if (ch === '/' && next === '*') {
        state = 'block';
        out += '  ';
        i += 1;
      } else {
        if (ch === "'") state = 'single';
        else if (ch === '"') state = 'double';
        else if (ch === '`') state = 'template';
        out += ch;
      }
    } else if (state === 'line') {
      if (ch === '\n') {
        state = 'code';
        out += ch;
      } else {
        out += ' ';
      }
    } else if (state === 'block') {
      if (ch === '*' && next === '/') {
        state = 'code';
        out += '  ';
        i += 1;
      } else {
        out += ch === '\n' ? ch : ' ';
      }
    } else {
      // Inside a string/template literal: emit verbatim, honour escapes.
      if (ch === '\\') {
        out += ch + (next ?? '');
        i += 1;
        continue;
      }
      if (
        (state === 'single' && (ch === "'" || ch === '\n')) ||
        (state === 'double' && (ch === '"' || ch === '\n')) ||
        (state === 'template' && ch === '`')
      ) {
        state = 'code';
      }
      out += ch;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Leg 1 — adapter coverage.
// ---------------------------------------------------------------------------

const IN_MEMORY_CLASS = /class\s+((?:InMemory|Memory)\w*)(?:<[^>{]*>)?\s+implements\s+([^{]+)\{/g;
const PRODUCTION_PREFIX = /^(?:Drizzle|Redis|Postgres|S3|Ses|Http)\w*/;
const PRODUCTION_CLASS =
  /class\s+((?:Drizzle|Redis|Postgres|S3|Ses|Http)\w*)(?:<[^>{]*>)?\s+implements\s+([^{]+)\{/g;

/** Split an `implements` list into interface names: commas split at generic
 *  depth 0 only, and each entry contributes its LEADING identifier — a
 *  positive match, no sanitizing replace (`Store<Map<K, V>>, Other` →
 *  `['Store', 'Other']`). */
function parseInterfaceList(raw: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (const ch of raw) {
    if (ch === '<') depth += 1;
    else if (ch === '>') depth = Math.max(0, depth - 1);
    else if (ch === ',' && depth === 0) {
      parts.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  parts.push(current);
  return parts
    .map((part) => /^\s*([A-Za-z_$][\w$]*)/.exec(part)?.[1])
    .filter((name): name is string => name !== undefined);
}

export interface AdapterInfo {
  className: string;
  interfaces: string[];
  file: string;
}

export function collectAdapters(files: Map<string, string>, pattern: RegExp): AdapterInfo[] {
  const out: AdapterInfo[] = [];
  for (const [file, raw] of files) {
    const source = stripComments(raw);
    for (const match of source.matchAll(pattern)) {
      out.push({
        className: match[1] as string,
        interfaces: parseInterfaceList(match[2] as string),
        file,
      });
    }
  }
  return out;
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
export function buildBootClosure(files: Map<string, string>, entry: string): Set<string> {
  const closure = new Set<string>();
  const queue = [entry];
  const importRe = /(?:import|export)\s[^;]*?from\s+['"](\.{1,2}\/[^'"]+)['"]/g;
  const sideEffectRe = /import\s+['"](\.{1,2}\/[^'"]+)['"]/g;
  while (queue.length > 0) {
    const current = queue.pop() as string;
    if (closure.has(current)) continue;
    const source = files.get(current);
    if (source === undefined) continue; // excluded (dev-only) or external
    closure.add(current);
    const stripped = stripComments(source);
    for (const re of [importRe, sideEffectRe]) {
      for (const match of stripped.matchAll(re)) {
        const spec = (match[1] as string).replace(/\.js$/, '.ts');
        const target = join(dirname(current), spec).replaceAll('\\', '/');
        queue.push(target);
      }
    }
  }
  return closure;
}

export function checkAdapterCoverage(
  files: Map<string, string>,
  closure: Set<string>,
  allowlist: Record<string, string> = ADAPTER_ALLOWLIST,
): string[] {
  const issues: string[] = [];
  const inMemory = collectAdapters(files, IN_MEMORY_CLASS);
  const production = collectAdapters(files, PRODUCTION_CLASS);

  // interface → production adapter class names.
  const productionByInterface = new Map<string, string[]>();
  for (const adapter of production) {
    for (const iface of adapter.interfaces) {
      const list = productionByInterface.get(iface) ?? [];
      list.push(adapter.className);
      productionByInterface.set(iface, list);
    }
  }

  // Which production adapters are INSTANTIATED within the boot closure?
  const instantiatedInClosure = new Set<string>();
  for (const file of closure) {
    const source = stripComments(files.get(file) ?? '');
    for (const match of source.matchAll(/new\s+(\w+)\s*[(<]/g)) {
      const name = match[1] as string;
      if (PRODUCTION_PREFIX.test(name)) instantiatedInClosure.add(name);
    }
  }

  const usedAllowlist = new Set<string>();
  for (const adapter of inMemory) {
    // Only adapters actually constructed in server code matter.
    const constructed = [...files.values()].some((raw) =>
      new RegExp(`new\\s+${adapter.className}\\s*[(<]`).test(stripComments(raw)),
    );
    if (!constructed) continue;
    if (allowlist[adapter.className] !== undefined) {
      usedAllowlist.add(adapter.className);
      continue;
    }
    const covered = adapter.interfaces.some((iface) =>
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
  const issues: string[] = [];
  const usedAllowlist = new Set<string>();
  const envRe = /process\.env(?:\[['"]([A-Za-z0-9_]+)['"]\]|\.([A-Za-z0-9_]+)\b)/g;
  for (const [file, raw] of files) {
    const source = stripComments(raw);
    for (const match of source.matchAll(envRe)) {
      const key = (match[1] ?? match[2]) as string;
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
// The full set of production-adapter class prefixes (CLAUDE.md store-adapter
// convention).  S3/Ses/Http/Postgres adapters live in conventionally-NAMED
// files (object-store-s3.ts, mailer-ses.ts, embeddings.ts, gateway.ts, …) that
// PRODUCTION_ADAPTER_FILE does not match, so they are scanned class-scoped
// instead — otherwise their in-memory state would escape the purity gate.
const PRODUCTION_ADAPTER_CLASS =
  /^\s*(?:export\s+)?(?:abstract\s+)?class\s+(?:Drizzle|Redis|Postgres|S3|Ses|Http)[A-Z]\w*/;
/** Long-lived in-memory state inside a production adapter: an in-memory
 *  adapter composed anywhere, or a Map/Set held as a CLASS FIELD (per-call
 *  locals — `const out = new Map(...)` working structures — are fine). */
const IN_MEMORY_STATE = [
  /new\s+(?:InMemory|Memory)\w+\s*\(/,
  /(?:#\w+|readonly\s+\w+|(?:private|protected|public)\s+[\w\s]*\w+)\s*(?::[^=;]+)?=\s*new\s+(?:Map|Set)\b/,
];

export function checkAdapterPurity(
  files: Map<string, string>,
  allowlist: Array<{ file: string; needle: string; reason: string }> = PURITY_ALLOWLIST,
): string[] {
  const issues: string[] = [];
  const usedAllowlist = new Set<number>();
  for (const [file, raw] of files) {
    const source = stripComments(raw);
    // drizzle-*/redis-* files are production-only (no in-memory classes), so the
    // whole file is scanned.  Any OTHER file is scanned ONLY inside a production-
    // adapter class body — a file that co-locates an in-memory adapter with a
    // production one (e.g. knomosis/gateway.ts) must not have the in-memory
    // class's legitimate Map/Set fields flagged.
    const isPrefixFile = PRODUCTION_ADAPTER_FILE.test(basename(file));
    // Brace-depth tracking scopes the scan to a production-adapter class BODY, so
    // top-level dev-default factories after the class (`getTokenStore()` →
    // `new MemoryTokenStore()`) and co-located in-memory classes are not flagged.
    let depth = 0;
    let classDepth = -1; // brace depth at which the current production class opened
    for (const [index, line] of source.split('\n').entries()) {
      const enteringProd = !isPrefixFile && classDepth < 0 && PRODUCTION_ADAPTER_CLASS.test(line);
      const inRegion = isPrefixFile || classDepth >= 0 || enteringProd;
      if (enteringProd) classDepth = depth;
      depth += (line.match(/{/g)?.length ?? 0) - (line.match(/}/g)?.length ?? 0);
      const wasInRegion = inRegion;
      if (classDepth >= 0 && depth <= classDepth) classDepth = -1; // class body closed
      if (!wasInRegion) continue;
      if (!IN_MEMORY_STATE.some((pattern) => pattern.test(line))) continue;
      const allowed = allowlist.findIndex(
        (entry) => file.endsWith(entry.file) && line.includes(entry.needle),
      );
      if (allowed >= 0) {
        usedAllowlist.add(allowed);
        continue;
      }
      issues.push(
        `${file}:${index + 1}: a production adapter holds in-memory state ` +
          `(${line.trim().slice(0, 80)}…) — state in a Drizzle/Redis adapter must live in the ` +
          'backing service (this is how upload bytes once vanished on restart). Move it, or ' +
          'allowlist the line in scripts/check-prod-parity.ts with a written justification.',
      );
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
  const block = /export const serverEnvSchema = z\.object\(\{([\s\S]*?)\n\}\);/.exec(source);
  const keys = new Set<string>();
  for (const match of (block?.[1] ?? '').matchAll(/^\s{2}([A-Z][A-Z0-9_]*):/gm)) {
    keys.add(match[1] as string);
  }
  if (keys.size < 10) {
    throw new Error(
      `check-prod-parity: parsed only ${keys.size} server env schema keys — the schema layout ` +
        'changed; update parseServerEnvSchemaKeys.',
    );
  }
  return keys;
}

export function runProdParityGate(files: Map<string, string>): string[] {
  const closure = buildBootClosure(files, BOOT_ENTRY);
  const schemaKeys = parseServerEnvSchemaKeys(readFileSync(ENV_SCHEMA_SOURCE, 'utf-8'));
  return [
    ...checkAdapterCoverage(files, closure),
    ...checkEnvKeys(files, schemaKeys),
    ...checkAdapterPurity(files),
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
      'counterpart, every env key is schema-validated or a documented dev flag, and no ' +
      'production adapter holds un-allowlisted in-memory state.',
  );
}

// Run as a script, but stay importable by the unit test.
if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  main();
}

// SPDX-License-Identifier: AGPL-3.0-or-later
//
// `pnpm dev` preflight: stop THIS repository's own leftover dev servers before
// starting new ones.
//
// The failure it removes: a `pnpm dev` whose terminal died (or that was killed
// with SIGKILL rather than Ctrl-C) leaves the `tsx watch` SUPERVISOR alive, and
// the supervisor immediately respawns the API. The next `pnpm dev` then dies on
// `EADDRINUSE :3001` — and killing the process on the port does not help,
// because the watcher puts it straight back. Diagnosing that well (see
// `apps/api/src/lib/listen-diagnostics.ts`) is worth doing, but not having to
// diagnose it at all is better: a dev command that cannot start the dev stack is
// not doing its job.
//
// SAFETY — this kills processes, so its matching is deliberately narrow:
//
//   1. Only processes whose command line contains THIS repo's absolute path. A
//      second checkout, a container, a colleague's service, Postgres on 5432 —
//      none of them match, and nothing is killed merely for holding a port we
//      want.
//   2. Only the two dev-server SHAPES we start ourselves: the api's
//      `tsx … src/index.ts` (supervisor and child) and the web's Vite.
//   3. Plus every DESCENDANT of a matched supervisor. The watcher's child is
//      `node --import …/tsx/loader.mjs src/index.ts` — its argv names neither
//      `apps/api` nor anything else specific to this app, so argv matching
//      alone misses the very process holding the port. Walking the tree is
//      what makes the reclaim actually work; the argv rule then also catches a
//      child already orphaned by an earlier kill.
//   4. Never this process or its ancestors — we are launched BY the `pnpm dev`
//      we are preflighting.
//
// Supervisors are stopped BEFORE their children, or the child is respawned
// between the two kills. SIGTERM first, SIGKILL only for what refuses to go.
// Everything it stops is logged: silent process-killing would be worse than the
// bug. Any failure is non-fatal — a preflight must never be the reason `pnpm
// dev` will not start.
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

const REPO_ROOT = resolve(import.meta.dirname, '..');
const API_DIR = resolve(REPO_ROOT, 'apps', 'api');
const WEB_DIR = resolve(REPO_ROOT, 'apps', 'web');

/** How long a SIGTERM'd process gets before SIGKILL, in ms. */
const TERM_GRACE_MS = 700;

export interface Candidate {
  readonly pid: number;
  readonly args: string;
  /** Supervisors are killed first — they respawn their child otherwise. */
  readonly supervisor: boolean;
  readonly label: string;
}

interface ProcessRow {
  readonly pid: number;
  readonly ppid: number;
  readonly args: string;
}

/** `ps` snapshot with parentage; empty when `ps` is unavailable. */
function processList(): ProcessRow[] {
  try {
    const out = execFileSync('ps', ['-eo', 'pid=,ppid=,args='], {
      encoding: 'utf8',
      maxBuffer: 8 * 1024 * 1024,
    });
    const rows: ProcessRow[] = [];
    for (const raw of out.split('\n')) {
      const line = raw.trim();
      if (line.length === 0) continue;
      const match = /^(\d+)\s+(\d+)\s+(.*)$/.exec(line);
      if (match === null) continue;
      rows.push({ pid: Number(match[1]), ppid: Number(match[2]), args: match[3] as string });
    }
    return rows;
  } catch {
    return [];
  }
}

/** PIDs we must never target: this process and every ancestor of it. */
function selfAndAncestors(): Set<number> {
  const chain = new Set<number>([process.pid]);
  let pid = process.pid;
  for (let hop = 0; hop < 32; hop += 1) {
    let parent: number;
    try {
      parent = Number(
        execFileSync('ps', ['-o', 'ppid=', '-p', String(pid)], { encoding: 'utf8' }).trim(),
      );
    } catch {
      break;
    }
    if (!Number.isInteger(parent) || parent <= 1 || chain.has(parent)) break;
    chain.add(parent);
    pid = parent;
  }
  return chain;
}

/**
 * Decide whether a process is one of OUR dev servers — the safety-critical
 * predicate, exported so its boundaries are pinned by tests rather than by
 * inspection. Returning `null` means "leave it strictly alone".
 */
export function classify(args: string): Pick<Candidate, 'supervisor' | 'label'> | null {
  // Everything we touch must belong to THIS checkout.
  if (!args.includes(REPO_ROOT)) return null;
  // The API supervisor: `tsx watch src/index.ts` under apps/api.
  if (args.includes(API_DIR) && args.includes('tsx') && args.includes('watch')) {
    return { supervisor: true, label: 'api dev watcher' };
  }
  // The API child: loader-hosted, so it names only the repo root, tsx's loader,
  // and the entry file. Narrow enough to be unambiguous (the e2e harness runs
  // `src/e2e-server.ts`, the seeds run their own scripts).
  if (args.includes('tsx') && /(^|[\s/])src\/index\.ts(\s|$)/.test(args)) {
    return { supervisor: false, label: 'api dev server' };
  }
  // The web: Vite — matched on its actual ENTRY FILE, not the substring
  // "vite", which also appears in `vitest`. A `pnpm dev` that killed a running
  // test suite would be a far worse bug than the one this script fixes.
  if (args.includes(WEB_DIR) && /[/\\]vite[/\\]bin[/\\]vite\.js(\s|$)/.test(args)) {
    return { supervisor: false, label: 'web dev server' };
  }
  return null;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function signal(pid: number, sig: NodeJS.Signals): void {
  try {
    process.kill(pid, sig);
  } catch {
    // Already gone (or not ours to signal) — nothing to do either way.
  }
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function main(): void {
  // `ps` is POSIX; on Windows the API's own boot diagnosis is the fallback.
  if (process.platform === 'win32') return;

  const excluded = selfAndAncestors();
  const rows = processList();
  const candidates = new Map<number, Candidate>();

  const add = (row: ProcessRow, kind: Pick<Candidate, 'supervisor' | 'label'>): void => {
    if (excluded.has(row.pid) || candidates.has(row.pid)) return;
    candidates.set(row.pid, { pid: row.pid, args: row.args, ...kind });
  };

  for (const row of rows) {
    if (excluded.has(row.pid)) continue;
    const kind = classify(row.args);
    if (kind !== null) add(row, kind);
  }

  // Descendants of a matched supervisor: the watcher's child holds the port but
  // its argv names nothing app-specific, so parentage is what finds it.
  const supervisors = [...candidates.values()].filter((entry) => entry.supervisor);
  for (const supervisor of supervisors) {
    const queue = [supervisor.pid];
    while (queue.length > 0) {
      const parent = queue.shift() as number;
      for (const row of rows) {
        if (row.ppid !== parent || candidates.has(row.pid) || excluded.has(row.pid)) continue;
        add(row, { supervisor: false, label: 'api dev server' });
        queue.push(row.pid);
      }
    }
  }
  if (candidates.size === 0) return;

  // Supervisors first: killing a child while its watcher lives just restarts it.
  const ordered = [...candidates.values()].sort(
    (a, b) => Number(b.supervisor) - Number(a.supervisor) || a.pid - b.pid,
  );
  for (const target of ordered) {
    console.warn(`dev preflight: stopping leftover ${target.label} (pid ${target.pid})`);
    signal(target.pid, 'SIGTERM');
  }
  sleepSync(TERM_GRACE_MS);
  for (const target of ordered) {
    if (!alive(target.pid)) continue;
    console.warn(`dev preflight: ${target.label} (pid ${target.pid}) ignored SIGTERM — forcing`);
    signal(target.pid, 'SIGKILL');
  }
}

// Side-effecting only when RUN, never when imported (the tests import
// `classify`; importing must not kill anything).
if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  main();
}

// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The two health surfaces an orchestrator points its probes at:
//
//   GET /health        — LIVENESS.  Unconditional: answers 200 whenever the
//                        process is up and serving.  It intentionally checks
//                        nothing else, so a dependency outage never makes the
//                        supervisor kill/restart an otherwise-healthy process.
//   GET /health/ready  — READINESS.  Runs the injected dependency probes
//                        (Postgres, Redis in production; none on an in-memory
//                        boot, which has no external dependencies) and answers
//                        200 only when every probe passes within its timeout —
//                        503 otherwise, so a load balancer never routes traffic
//                        to a replica whose durable stores cannot answer yet.
//
// Both are GETs (outside the CSRF state-changing-method set) and carry no
// secrets: the readiness body names each probe with only 'ok' | 'failed'.

import { Hono } from 'hono';

export const healthRoute = new Hono();

healthRoute.get('/', (c) => {
  return c.json({
    status: 'ok' as const,
    timestamp: new Date().toISOString(),
  });
});

/** A named dependency check the readiness route runs (resolving = ready). */
export interface ReadinessProbe {
  /** Stable probe name surfaced in the response body (e.g. `postgres`). */
  readonly name: string;
  /** Resolves when the dependency answers; a rejection (or timeout) fails it. */
  readonly check: () => Promise<unknown>;
}

/** Per-probe budget: a hung dependency must fail readiness, not hang it. */
const DEFAULT_PROBE_TIMEOUT_MS = 2_000;

async function runProbe(probe: ReadinessProbe, timeoutMs: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      probe.check(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${probe.name} probe timed out`)), timeoutMs);
      }),
    ]);
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Build the readiness route over the boot-injected dependency probes.  All
 * probes run concurrently; the route answers 200 `ready` only when every probe
 * passes, else 503 `unavailable` with the per-probe verdicts.  An empty probe
 * list (the in-memory dev/test boot — the process IS its own store) is ready.
 */
export function createReadyRoute(
  probes: readonly ReadinessProbe[],
  options: { readonly probeTimeoutMs?: number } = {},
) {
  const timeoutMs = options.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  const route = new Hono();
  route.get('/', async (c) => {
    const results = await Promise.all(probes.map((p) => runProbe(p, timeoutMs)));
    const checks: Record<string, 'ok' | 'failed'> = {};
    probes.forEach((p, i) => {
      checks[p.name] = results[i] === true ? 'ok' : 'failed';
    });
    const ready = results.every((r) => r === true);
    return c.json(
      {
        status: ready ? ('ready' as const) : ('unavailable' as const),
        timestamp: new Date().toISOString(),
        checks,
      },
      ready ? 200 : 503,
    );
  });
  return route;
}

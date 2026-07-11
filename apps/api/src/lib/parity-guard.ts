// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Runtime half of the production-parity guarantee (the static half is
// `pnpm check:prod-parity`).  After the boot has wired every durable adapter,
// a PRODUCTION process walks the service containers and REFUSES TO SERVE if
// any field still holds an in-memory adapter (`InMemory*` / `Memory*` by the
// mandatory naming convention) that is not explicitly allowlisted.  This is
// belt-and-braces against a wiring regression the static gate cannot see —
// e.g. an `if (db)` swap accidentally narrowed by a refactor: production then
// crashes loudly at boot instead of silently serving restart-volatile state.
//
// Non-production environments never run this (the in-memory containers ARE the
// dev/test posture).

/** Fields tolerated as in-memory even in production, each with a reason. */
export const RUNTIME_PARITY_ALLOWLIST: Record<string, string> = {
  'identity.objectStore':
    'DSAR export archives without the S3_* group — documented + loudly warned at boot; ' +
    'archives are SecretBox-sealed and simply re-requested after a restart (WS-D.2.2c)',
};

/** True for a value whose class name marks it as an in-memory adapter. */
function isInMemoryAdapter(value: unknown): boolean {
  if (value === null || typeof value !== 'object') return false;
  const name = (value as { constructor?: { name?: string } }).constructor?.name ?? '';
  return name.startsWith('InMemory') || name.startsWith('Memory');
}

/**
 * Walk each container's OWN enumerable fields (one level deep — the container
 * pattern is flat) and collect every un-allowlisted in-memory adapter as
 * `container.field: ClassName`.
 */
export function findInMemoryAdapters(
  containers: Record<string, object>,
  allowlist: Record<string, string> = RUNTIME_PARITY_ALLOWLIST,
): string[] {
  const findings: string[] = [];
  for (const [containerName, container] of Object.entries(containers)) {
    for (const [field, value] of Object.entries(container)) {
      if (!isInMemoryAdapter(value)) continue;
      const key = `${containerName}.${field}`;
      if (allowlist[key] !== undefined) continue;
      const className = (value as { constructor: { name: string } }).constructor.name;
      findings.push(`${key}: ${className}`);
    }
  }
  return findings;
}

/**
 * Production boot assertion: throw (refusing to serve) when any container
 * field still holds an un-allowlisted in-memory adapter after wiring.
 */
export function assertProductionParity(
  containers: Record<string, object>,
  allowlist: Record<string, string> = RUNTIME_PARITY_ALLOWLIST,
): void {
  const findings = findInMemoryAdapters(containers, allowlist);
  if (findings.length === 0) return;
  throw new Error(
    'PRODUCTION PARITY VIOLATION — refusing to serve with in-memory adapters wired where ' +
      `production requires durable ones:\n  - ${findings.join('\n  - ')}\n` +
      'Fix the boot wiring (apps/api/src/index.ts), or — only with a written justification — ' +
      'allowlist the field in apps/api/src/lib/parity-guard.ts.',
  );
}

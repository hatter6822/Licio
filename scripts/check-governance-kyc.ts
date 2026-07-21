// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Governance KYC-eligibility gate (bot-prevention layer 3).  The platform
// floor says: room-governance PARTICIPATION — electing stewards, ratifying
// models, creating/voting/challenging proposals, delegating power, steward
// governance actions — is reserved for KYC-verified accounts
// (apps/api/src/governance/eligibility.ts).  This gate makes that invariant
// STRUCTURAL: every `.post(` route in the governance route files must either
// invoke the eligibility guard (`requireGovernanceEligibility` middleware or
// a handler-level `checkGovernanceEligibility` call) or carry a written
// allowlist justification below.  A new governance mutation route cannot ship
// unclassified, and a stale allowlist entry is itself an error (the
// check-prod-parity allowlist discipline).
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');

/** The route files that own governance-participation surfaces. */
export const GOVERNANCE_ROUTE_FILES = [
  'apps/api/src/routes/governance.ts',
  'apps/api/src/routes/room-governance.ts',
  'apps/api/src/routes/treasury-governance.ts',
] as const;

const GUARD_TOKENS = ['requireGovernanceEligibility(', 'checkGovernanceEligibility('] as const;

/** POST routes tolerated WITHOUT the eligibility guard.  EVERY entry needs a
 *  written reason a reviewer can weigh; a stale entry fails the gate. */
export const ALLOWLIST: ReadonlyArray<{ file: string; path: string; reason: string }> = [
  {
    file: 'apps/api/src/routes/governance.ts',
    path: '/rooms/:roomId/governance/agent/freeze',
    reason:
      'platform legal floor (WS-J `restrict` capability + MFA) — platform staff pausing a ' +
      'community agent is enforcement, not governance participation',
  },
  {
    file: 'apps/api/src/routes/governance.ts',
    path: '/rooms/:roomId/governance/agent/unfreeze',
    reason:
      'platform legal floor (same capability gate as freeze) — enforcement, not participation',
  },
  {
    file: 'apps/api/src/routes/treasury-governance.ts',
    path: '/rooms/:roomId/governance/law-packs/validate',
    reason: 'pure validation — no state changes, nothing is proposed/adopted/voted',
  },
  {
    file: 'apps/api/src/routes/treasury-governance.ts',
    path: '/rooms/:roomId/governance/freeze',
    reason:
      'emergency safety valve (freeze protects funds) — braking must never be delayed by an ' +
      'eligibility lookup; a frozen treasury is un-frozen only by PLATFORM STAFF, never a steward',
  },
  {
    file: 'apps/api/src/routes/treasury-governance.ts',
    path: '/rooms/:roomId/governance/pause',
    reason:
      'emergency safety valve (pause/resume deposits/proposals/executions) — braking must never be ' +
      'delayed by an eligibility lookup, and the route both pauses and resumes; a pause is only ' +
      'reachable on an already-real-asset room whose enabling mode transition + treasury were KYC-gated',
  },
  {
    file: 'apps/api/src/routes/treasury-governance.ts',
    path: '/rooms/:roomId/treasury/payment-intents',
    reason:
      'the real-funds rail: WS-N disclosure-ack gate + jurisdiction/sanctions/fraud verdicts at ' +
      'preflight AND submit own this lane; per-jurisdiction KYC belongs to the kyc_policy cells ' +
      'the compliance engine enforces there (a deposit is a contribution, not a governance vote)',
  },
  {
    file: 'apps/api/src/routes/treasury-governance.ts',
    path: '/rooms/:roomId/treasury/payment-intents/:paymentIntentId/advance',
    reason:
      'real-funds rail lifecycle (owner/steward) — governed by the WS-N/knomosis verdicts above',
  },
  {
    file: 'apps/api/src/routes/treasury-governance.ts',
    path: '/rooms/:roomId/treasury/payment-intents/:paymentIntentId/dispute',
    reason: 'member safety valve on their OWN finalized payment — recourse must not require KYC',
  },
  {
    file: 'apps/api/src/routes/treasury-governance.ts',
    path: '/rooms/:roomId/treasury/grants/:grantId/review',
    reason:
      'staff/steward operations on an ALREADY-APPROVED proposal — the approving votes were ' +
      'KYC-gated; payouts ride the knomosis compliance rail',
  },
  {
    file: 'apps/api/src/routes/treasury-governance.ts',
    path: '/rooms/:roomId/treasury/grants/:grantId/milestones/:milestoneId',
    reason: 'grant lifecycle operations on an approved proposal — same rationale as review',
  },
  {
    file: 'apps/api/src/routes/treasury-governance.ts',
    path: '/rooms/:roomId/treasury/grants/:grantId/clawback',
    reason: 'platform-staff enforcement action — enforcement, not participation',
  },
  {
    file: 'apps/api/src/routes/treasury-governance.ts',
    path: '/rooms/:roomId/governance/delegations/:delegationId/revoke',
    reason:
      'WITHDRAWING delegated power (owner/staff) — a member whose KYC lapsed must still be able ' +
      'to revoke power they delegated while verified',
  },
];

/** Strip // and /* comments (string-literal aware) so prose never satisfies —
 *  or trips — a code token.  Same tokenizer discipline as check-prod-parity. */
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
      } else out += ' ';
    } else if (state === 'block') {
      if (ch === '*' && next === '/') {
        state = 'code';
        out += '  ';
        i += 1;
      } else out += ch === '\n' ? ch : ' ';
    } else {
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

export interface MutationRoute {
  file: string;
  method: string;
  path: string;
  guarded: boolean;
}

/** The HTTP methods that MUTATE governance state — each such route must be
 *  guarded or allowlisted.  GET/HEAD are reads and are only segment boundaries. */
const MUTATION_METHODS = new Set(['post', 'put', 'patch', 'delete']);

/**
 * Extract every MUTATION route (path + whether a guard token appears before the
 * next chained route method). Markers are LINE-ANCHORED — the Hono chain style
 * puts each `.post(`/`.get(` at the start of its own line, so a handler-body
 * `c.get('auth')` or `map.get(key)` can never cut a segment. A mid-line route
 * registration would evade line-anchoring, so `runGovernanceKycGate` ALSO
 * cross-checks the raw `.post(` count (POST is the only method that never
 * appears in a handler body here) and FAILS on any unclassifiable occurrence —
 * fail closed, not silently skipped.
 */
export function extractMutationRoutes(file: string, source: string): MutationRoute[] {
  const stripped = stripComments(source);
  const methodRe = /^\s*\.(post|get|put|patch|delete|use|on|route)\(/gm;
  const markers: Array<{ index: number; method: string }> = [];
  for (const match of stripped.matchAll(methodRe)) {
    markers.push({ index: match.index, method: match[1] as string });
  }
  const routes: MutationRoute[] = [];
  markers.forEach((marker, i) => {
    if (!MUTATION_METHODS.has(marker.method)) return;
    const end = markers[i + 1]?.index ?? stripped.length;
    const segment = stripped.slice(marker.index, end);
    const path = /['"]([^'"]+)['"]/.exec(segment)?.[1];
    if (path === undefined) return;
    const guarded = GUARD_TOKENS.some((token) => segment.includes(token));
    routes.push({ file, method: marker.method, path, guarded });
  });
  return routes;
}

/** Count non-overlapping `.post(` occurrences in the comment-stripped source. */
function countRawPost(source: string): number {
  return (stripComments(source).match(/\.post\(/g) ?? []).length;
}

export function runGovernanceKycGate(
  read: (relPath: string) => string = (relPath) => readFileSync(resolve(ROOT, relPath), 'utf-8'),
): string[] {
  const issues: string[] = [];
  const usedAllowlist = new Set<number>();
  for (const file of GOVERNANCE_ROUTE_FILES) {
    const source = read(file);
    const routes = extractMutationRoutes(file, source);
    // Fail-closed style guard: every `.post(` in the file must be a
    // line-anchored route we extracted. A mid-line `.post(` (a non-chain-style
    // registration) would otherwise ship ungated with a green gate.
    const rawPost = countRawPost(source);
    const extractedPost = routes.filter((r) => r.method === 'post').length;
    if (rawPost !== extractedPost) {
      issues.push(
        `${file}: found ${rawPost} \`.post(\` occurrence(s) but classified ${extractedPost} — a ` +
          'route is not at line-start (the required Hono chain style), so the gate cannot see it. ' +
          'Put each `.post(` at the start of its own line.',
      );
    }
    for (const route of routes) {
      if (route.guarded) continue;
      const allowIndex = ALLOWLIST.findIndex(
        (entry) => entry.file === file && entry.path === route.path,
      );
      if (allowIndex >= 0) {
        usedAllowlist.add(allowIndex);
        continue;
      }
      issues.push(
        `${file}: ${route.method.toUpperCase()} ${route.path} performs a governance mutation ` +
          'without the KYC eligibility guard. Add requireGovernanceEligibility() to its middleware ' +
          'chain (or a handler-level checkGovernanceEligibility call), or allowlist it in ' +
          'scripts/check-governance-kyc.ts with a written justification.',
      );
    }
  }
  ALLOWLIST.forEach((entry, index) => {
    if (!usedAllowlist.has(index)) {
      issues.push(
        `stale ALLOWLIST entry '${entry.file}' / '${entry.path}': it no longer matches an ` +
          'unguarded POST route — remove it.',
      );
    }
  });
  return issues;
}

function main(): void {
  const issues = runGovernanceKycGate();
  if (issues.length > 0) {
    console.error('Governance KYC gate FAILED — ungated governance-participation route(s):');
    for (const issue of issues) console.error(`  - ${issue}`);
    process.exit(1);
  }
  console.log(
    'Governance KYC gate passed: every governance-participation POST route enforces the ' +
      'KYC eligibility guard or carries a written allowlist justification.',
  );
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  main();
}

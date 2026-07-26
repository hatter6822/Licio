// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Governance KYC-eligibility gate (bot-prevention layer 3).  The platform
// floor says: room-governance PARTICIPATION — electing stewards, ratifying
// models, creating/voting/challenging proposals, delegating power, steward
// governance actions — is reserved for KYC-verified accounts
// (apps/api/src/governance/eligibility.ts).  This gate makes that invariant
// STRUCTURAL: every mutation route in the governance route files must either
// invoke the eligibility guard (`requireGovernanceEligibility` middleware or
// a handler-level `checkGovernanceEligibility` call) or carry a written
// allowlist justification below.  A new governance mutation route cannot ship
// unclassified, and a stale allowlist entry is itself an error (the
// check-prod-parity allowlist discipline).
//
// READ FROM THE PARSE, not from the text.  This gate used to find routes with a
// LINE-ANCHORED `/^\s*\.(post|put|patch|delete)\(/gm`, attribute a guard to a
// route by slicing the text between two markers, and strip comments with a
// hand-written state machine of its own.  None of that can express "is this
// call a route registration" or "is the guard invoked INSIDE this route", so it
// carried two compensations: a raw-count reconciliation that failed closed on
// anything it could not classify, and — through that — a STYLE CONSTRAINT on
// the application code, requiring every mutation registration to begin its own
// line.  A gate that dictates how the code it reads must be formatted is a gate
// that cannot read it.
//
// Parsed, all three questions are direct.  A registration is a call on a
// receiver chain rooting at `new Hono()`, which is what separates a route from
// `db.delete(table)`; the path is its first argument; and the guard is a call
// somewhere INSIDE that registration's arguments — containment, so a guard in
// one route can never be attributed to the next, and prose can never satisfy it
// because a comment is not a node.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { SyntaxKind } from 'typescript/unstable/ast';
import type { Project } from 'typescript/unstable/sync';
import { type Source, type Syntax, walk, withParsedSources } from './ts-source.js';

const ROOT = resolve(import.meta.dirname, '..');

/** The route files that own governance-participation surfaces.  `rooms.ts` is
 *  mostly membership/content (allowlisted below), but it owns the steward
 *  join/posting-policy + visibility writes — governance rule-changes that MUST
 *  clear the KYC floor — so the whole file is scanned to keep that structural. */
export const GOVERNANCE_ROUTE_FILES = [
  'apps/api/src/routes/governance.ts',
  'apps/api/src/routes/room-governance.ts',
  'apps/api/src/routes/treasury-governance.ts',
  'apps/api/src/routes/rooms.ts',
] as const;

/** The eligibility guard, in either of the two shapes a route may use it. */
const GUARD_NAMES: ReadonlySet<string> = new Set([
  'requireGovernanceEligibility',
  'checkGovernanceEligibility',
]);

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
  // --- rooms.ts: membership + content + lifecycle (NOT governance rule-making) --
  {
    file: 'apps/api/src/routes/rooms.ts',
    path: '/rooms',
    reason: 'room CREATION is a content act (WS-G.2.3c) — content participation is never KYC-gated',
  },
  {
    file: 'apps/api/src/routes/rooms.ts',
    path: '/rooms/:roomId/join',
    reason:
      'subscribe (POST) / unsubscribe (DELETE): joining or leaving a room is membership, not ' +
      'governance participation — never KYC-gated',
  },
  {
    file: 'apps/api/src/routes/rooms.ts',
    path: '/rooms/:roomId/lens',
    reason: 'selecting the lens one posts under is a per-member content preference, not governance',
  },
  {
    file: 'apps/api/src/routes/rooms.ts',
    path: '/rooms/:roomId/join-requests/:requestId',
    reason:
      'a steward approving/denying a JOIN REQUEST is membership curation (who may enter), not a ' +
      'governance rule-change/vote — the same tier as accepting a subscription',
  },
  {
    file: 'apps/api/src/routes/rooms.ts',
    path: '/rooms/:roomId/lenses',
    reason: 'creating a lens is CONTENT (WS-Q.3.2, tier two), not a governance mutation',
  },
  {
    file: 'apps/api/src/routes/rooms.ts',
    path: '/rooms/:roomId/migration/export',
    reason:
      'server→Private-P2P room MIGRATION (WS-S.9) is an owner/steward room-LIFECYCLE operation, ' +
      'not a governance vote/proposal/law; export merely bundles the room for the member device',
  },
  {
    file: 'apps/api/src/routes/rooms.ts',
    path: '/rooms/:roomId/migration/freeze',
    reason:
      'room-lifecycle migration step (freeze writes before purge) — server-enforced destructive ' +
      'sequencing, not governance participation',
  },
  {
    file: 'apps/api/src/routes/rooms.ts',
    path: '/rooms/:roomId/migration/purge',
    reason:
      'room-lifecycle migration step (server-enforced purge after freeze) — not governance ' +
      'participation',
  },
];

export interface MutationRoute {
  file: string;
  method: string;
  path: string;
  guarded: boolean;
}

/** The HTTP methods that MUTATE governance state — each such route must be
 *  guarded or allowlisted.  GET/HEAD are reads and are judged nowhere. */
const MUTATION_METHODS: ReadonlySet<string> = new Set(['post', 'put', 'patch', 'delete']);

/** Wrappers that yield exactly the expression they wrap. */
const TRANSPARENT: ReadonlySet<number> = new Set([
  SyntaxKind.ParenthesizedExpression,
  SyntaxKind.AsExpression,
  SyntaxKind.SatisfiesExpression,
  SyntaxKind.NonNullExpression,
]);

/** How far a receiver chain or a binding is followed before giving up. */
const MAX_HOPS = 32;

function unwrap(node: Syntax | undefined): Syntax | undefined {
  let current = node;
  for (let hop = 0; current !== undefined && TRANSPARENT.has(current.kind); hop += 1) {
    if (hop > MAX_HOPS) return current;
    current = current.expression;
  }
  return current;
}

/** An identifier's or property's name, escapes already resolved. */
function nameOf(node: Syntax | undefined): string | undefined {
  return node === undefined ? undefined : (node.text ?? node.getText());
}

/** The static string a node denotes, or undefined when it is not one. */
function staticString(node: Syntax | undefined): string | undefined {
  const target = unwrap(node);
  if (target === undefined) return undefined;
  if (
    target.kind === SyntaxKind.StringLiteral ||
    target.kind === SyntaxKind.NoSubstitutionTemplateLiteral
  ) {
    return target.text ?? '';
  }
  return undefined;
}

/** A mutation route found in the parse, or one whose path could not be read. */
interface FoundRoute extends MutationRoute {
  /** Where to point when the path is unreadable and the route must fail closed. */
  readonly line: number;
  readonly readable: boolean;
}

/**
 * Every mutation route a parsed file registers, with its guard resolved.
 *
 * A registration is a call whose receiver chain roots at `new Hono()`.  That is
 * what separates a route from `db.delete(table)` or `map.delete(key)` without a
 * rule about where the call may sit on its line — and it is what lets an
 * UNREADABLE route path fail closed, since a mutation call on a router with a
 * non-static path is a route this gate genuinely cannot classify.
 */
function routesIn(file: string, root: Syntax, project: Project, source: string): FoundRoute[] {
  const lineStarts = [0];
  for (let at = 0; at < source.length; at += 1) if (source[at] === '\n') lineStarts.push(at + 1);
  const lineAt = (offset: number): number => {
    let low = 0;
    let high = lineStarts.length - 1;
    while (low < high) {
      const mid = (low + high + 1) >> 1;
      if ((lineStarts[mid] ?? 0) <= offset) low = mid;
      else high = mid - 1;
    }
    return low + 1;
  };

  const localDeclaration = (node: Syntax): Syntax | undefined => {
    const symbol = project.checker.getSymbolAtPosition(String(root.path), node.getStart());
    const handle = symbol?.declarations.find(
      (declaration) => String(declaration.path) === String(root.path),
    );
    return handle?.resolve(project) as unknown as Syntax | undefined;
  };

  /**
   * Whether a receiver chain roots at `new Hono…()` — i.e. it is a ROUTER.
   *
   * The chain is walked WITHOUT a depth bound, because it is a finite spine of
   * the syntax tree: `new Hono().get(…).post(…)` nests each link inside the one
   * before it, so a file registering thirty routes makes the thirty-first
   * receiver thirty calls deep.  Bounding that walk silently stopped
   * recognising routes past the limit — `treasury-governance.ts` reported 11 of
   * its 19, and the allowlist's stale-entry discipline is what exposed it.
   *
   * Only BINDING hops are bounded, since `const a = b; const b = a` is the one
   * step here that can cycle.
   */
  const isRouter = (node: Syntax | undefined, bindings = 0): boolean => {
    let target = unwrap(node);
    let hops = bindings;
    while (target !== undefined) {
      if (target.kind === SyntaxKind.NewExpression) {
        return (nameOf(unwrap(target.expression)) ?? '').startsWith('Hono');
      }
      if (
        target.kind === SyntaxKind.CallExpression ||
        target.kind === SyntaxKind.PropertyAccessExpression ||
        target.kind === SyntaxKind.ElementAccessExpression
      ) {
        target = unwrap(target.expression);
        continue;
      }
      // `const app = new Hono(); app.post(…)` — the binding says what it holds.
      if (target.kind === SyntaxKind.Identifier) {
        if (hops > MAX_HOPS) return false;
        hops += 1;
        const declaration = localDeclaration(target);
        if (declaration?.kind !== SyntaxKind.VariableDeclaration) return false;
        target = unwrap(declaration.initializer);
        continue;
      }
      return false;
    }
    return false;
  };

  /** Whether the eligibility guard is INVOKED anywhere inside these arguments. */
  const guardedBy = (args: readonly Syntax[]): boolean => {
    for (const argument of args) {
      for (const node of walk(argument)) {
        if (node.kind !== SyntaxKind.CallExpression) continue;
        const callee = unwrap(node.expression);
        if (callee === undefined) continue;
        const called =
          callee.kind === SyntaxKind.Identifier
            ? nameOf(callee)
            : callee.kind === SyntaxKind.PropertyAccessExpression
              ? nameOf(callee.name)
              : undefined;
        if (called !== undefined && GUARD_NAMES.has(called)) return true;
      }
    }
    return false;
  };

  const found: FoundRoute[] = [];
  for (const node of walk(root)) {
    if (node.kind !== SyntaxKind.CallExpression) continue;
    const callee = unwrap(node.expression);
    if (
      callee?.kind !== SyntaxKind.PropertyAccessExpression &&
      callee?.kind !== SyntaxKind.ElementAccessExpression
    ) {
      continue;
    }
    const called =
      callee.kind === SyntaxKind.PropertyAccessExpression
        ? nameOf(callee.name)
        : staticString(callee.argumentExpression);
    if (called === undefined) continue;
    if (!isRouter(callee.expression)) continue;

    const args = [...(node.arguments ?? [])];
    // `.post(path, …)`, and `.on(METHOD, path, …)` / `.on([METHODS], path, …)`,
    // which registers exactly the same route by another name.
    const viaOn = called === 'on';
    if (!viaOn && !MUTATION_METHODS.has(called)) continue;
    const methods = viaOn ? onMethods(args[0]) : [called];
    const pathArgument = viaOn ? args[1] : args[0];
    const mutations = methods.filter((method) => MUTATION_METHODS.has(method));
    if (mutations.length === 0) continue;

    const path = staticString(pathArgument);
    const guarded = guardedBy(viaOn ? args.slice(2) : args.slice(1));
    for (const method of mutations) {
      found.push({
        file,
        method,
        path: path ?? '<non-static path>',
        guarded,
        line: lineAt(node.getStart()),
        readable: path !== undefined,
      });
    }
  }
  return found;
}

/** The methods an `.on(…)` registration covers, lower-cased. */
function onMethods(node: Syntax | undefined): string[] {
  const single = staticString(node);
  if (single !== undefined) return [single.toLowerCase()];
  const target = unwrap(node);
  if (target?.kind !== SyntaxKind.ArrayLiteralExpression) return [];
  const methods: string[] = [];
  target.forEachChild((element) => {
    const value = staticString(element);
    if (value !== undefined) methods.push(value.toLowerCase());
  });
  return methods;
}

/** Parse each source once and extract its mutation routes. */
function routesFor(sources: readonly Source[]): Map<string, FoundRoute[]> {
  return withParsedSources(sources, (parsed, project) => {
    const byFile = new Map<string, FoundRoute[]>();
    for (const { path, content, root } of parsed) {
      byFile.set(path, routesIn(path, root, project, content));
    }
    return byFile;
  });
}

/** Every MUTATION route one file registers, with its guard resolved. */
export function extractMutationRoutes(file: string, source: string): MutationRoute[] {
  return (routesFor([{ path: file, content: source }]).get(file) ?? []).map(
    ({ line: _line, readable: _readable, ...route }) => route,
  );
}

export function runGovernanceKycGate(
  read: (relPath: string) => string = (relPath) => readFileSync(resolve(ROOT, relPath), 'utf-8'),
): string[] {
  const issues: string[] = [];
  const usedAllowlist = new Set<number>();
  // One parse for the whole route tree.
  const byFile = routesFor(
    GOVERNANCE_ROUTE_FILES.map((file) => ({ path: file, content: read(file) })),
  );
  for (const file of GOVERNANCE_ROUTE_FILES) {
    const routes = byFile.get(file) ?? [];
    for (const route of routes) {
      // A mutation registered on a router with a path this gate cannot read is
      // a route it cannot classify, so it fails CLOSED — the only place that
      // discipline is still needed, now that finding the route no longer
      // depends on how the file is formatted.
      if (!route.readable) {
        issues.push(
          `${file}:${route.line}: ${route.method.toUpperCase()} route path is not a static ` +
            'string, so it cannot be matched against the guard or the allowlist. Register the ' +
            'route with a literal path.',
        );
        continue;
      }
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

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
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { SyntaxKind } from 'typescript/unstable/ast';
import type { Project } from 'typescript/unstable/sync';
import { asNode, type Source, type Syntax, walk, withParsedSources } from './ts-source.js';

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

/** Declarations that DEFINE a value here, rather than name one from elsewhere. */
const DEFINED_LOCALLY: ReadonlySet<number> = new Set([
  SyntaxKind.FunctionDeclaration,
  SyntaxKind.VariableDeclaration,
  SyntaxKind.ClassDeclaration,
  SyntaxKind.MethodDeclaration,
  SyntaxKind.Parameter,
]);

/** Equality operators, whose polarity depends on what is on the other side. */
const EQUALITY: ReadonlySet<number> = new Set([
  SyntaxKind.EqualsEqualsEqualsToken,
  SyntaxKind.EqualsEqualsToken,
  SyntaxKind.ExclamationEqualsEqualsToken,
  SyntaxKind.ExclamationEqualsToken,
]);

/** Operators that COMPOSE tests, keeping the verdict's polarity in play. */
const COMPOSITION: ReadonlySet<number> = new Set([
  SyntaxKind.AmpersandAmpersandToken,
  SyntaxKind.BarBarToken,
  SyntaxKind.QuestionQuestionToken,
]);

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
   * What a receiver chain ROOTS at: a router, something definitely else, or
   * something this cannot resolve.
   *
   * The third answer is the point.  This used to be a boolean and an
   * unrecognised receiver meant `false`, which SILENTLY DROPPED the
   * registration — the gate then reported success over a route it never
   * judged, which is the one failure a fail-closed gate must not have.  A
   * governance router built by a local factory (`const app = makeRouter()`)
   * was exactly that: invisible, not unguarded.  Now an unresolvable receiver
   * is treated as a router and its handler must carry a guard like any other.
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
  type Receiver = 'router' | 'other' | 'unknown';

  /** Constructions that are definitely NOT a router, so a route can be skipped. */
  const NOT_A_ROUTER: ReadonlySet<SyntaxKind> = new Set([
    SyntaxKind.ObjectLiteralExpression,
    SyntaxKind.ArrayLiteralExpression,
    SyntaxKind.StringLiteral,
    SyntaxKind.NumericLiteral,
    SyntaxKind.ArrowFunction,
    SyntaxKind.FunctionExpression,
  ]);

  /**
   * Whether a name is an AMBIENT GLOBAL — declared only by the standard
   * library, never by this project.
   *
   * `Promise.all([...])` is a `.all` call on a receiver, and once an
   * unclassifiable receiver stopped being skipped it became a reported route.
   * Asked of the CHECKER rather than of a list of global names: every
   * declaration of `Promise` sits in a `lib.*.d.ts`, and nothing declared there
   * is a Hono router this project built.
   */
  const isAmbientGlobal = (node: Syntax): boolean => {
    const declarations =
      project.checker.getSymbolAtPosition(String(root.path), node.getStart())?.declarations ?? [];
    return (
      declarations.length > 0 && declarations.every((each) => String(each.path).endsWith('.d.ts'))
    );
  };

  /** Bindings that name a value from ANOTHER module, which may well be a router. */
  const IMPORTED: ReadonlySet<SyntaxKind> = new Set([
    SyntaxKind.ImportSpecifier,
    SyntaxKind.ImportClause,
    SyntaxKind.NamespaceImport,
    SyntaxKind.ImportEqualsDeclaration,
  ]);

  /** The module specifier an import binding came from. */
  const importedFrom = (binding: Syntax): string | undefined => {
    let node: Syntax | undefined = binding;
    for (let hop = 0; node !== undefined && hop <= MAX_HOPS; hop += 1) {
      if (node.kind === SyntaxKind.ImportDeclaration) return staticString(node.moduleSpecifier);
      node = node.parent;
    }
    return undefined;
  };

  /**
   * What `new X()` constructs: a router, definitely something else, or unknown.
   *
   * Read from what `X` BINDS TO rather than from how it is spelled.  Testing
   * `nameOf(...).startsWith('Hono')` made `import { Hono as Router } from
   * 'hono'; new Router()` classify as 'other', which DROPPED every route in the
   * file — and, once the corpus became "files that register a route", dropped
   * the file from classification altogether.
   *
   * Anything unrecognised is 'unknown', not 'other': an unresolvable
   * constructor may well be a router, and the registration still has to look
   * like one before it is treated as a route, so failing closed here costs
   * nothing.  `new Map()`/`new Date()` stay 'other' through the checker, which
   * knows their declarations are the standard library's.
   */
  const constructs = (called: Syntax | undefined): Receiver => {
    if (called?.kind !== SyntaxKind.Identifier) return 'unknown';
    const declaration = localDeclaration(called);
    if (declaration !== undefined && IMPORTED.has(declaration.kind)) {
      const from = importedFrom(declaration);
      if (from === 'hono' || from?.startsWith('hono/') === true) return 'router';
      // The ORIGINAL exported name survives an alias: `{ Hono as Router }`.
      const original = nameOf(declaration.propertyName ?? declaration.name ?? called) ?? '';
      return original.startsWith('Hono') ? 'router' : 'unknown';
    }
    if (declaration === undefined && isAmbientGlobal(called)) return 'other';
    return (nameOf(called) ?? '').startsWith('Hono') ? 'router' : 'unknown';
  };

  const receiverKind = (node: Syntax | undefined, bindings = 0): Receiver => {
    let target = unwrap(node);
    let hops = bindings;
    while (target !== undefined) {
      if (target.kind === SyntaxKind.NewExpression) {
        return constructs(unwrap(target.expression));
      }
      if (NOT_A_ROUTER.has(target.kind)) return 'other';
      // A CALL is either a chained registration (`app.post(…).get(…)`) or a
      // FACTORY.  Chaining is read through the callee as before; a factory is
      // read through what its function hands back, so `const app =
      // makeRouter()` classifies exactly as `const app = new Hono()` does.
      if (target.kind === SyntaxKind.CallExpression) {
        const callee = unwrap(target.expression);
        const returned = callee === undefined ? [] : returnsOfCallee(callee, hops);
        if (returned.length > 0) {
          const verdicts = returned.map((each) => receiverKind(each, hops + 1));
          if (verdicts.includes('router')) return 'router';
          if (verdicts.includes('unknown')) return 'unknown';
          // A factory that demonstrably returns something else is not a router,
          // but the CALLEE chain may still be one (`app.post(…).get(…)`).
        }
        target = callee;
        continue;
      }
      if (
        target.kind === SyntaxKind.PropertyAccessExpression ||
        target.kind === SyntaxKind.ElementAccessExpression
      ) {
        target = unwrap(target.expression);
        continue;
      }
      // `const app = new Hono(); app.post(…)` — the binding says what it holds.
      if (target.kind === SyntaxKind.Identifier) {
        if (hops > MAX_HOPS) return 'unknown';
        hops += 1;
        if (isAmbientGlobal(target)) return 'other';
        const declaration = localDeclaration(target);
        if (declaration === undefined) return 'unknown';
        if (declaration.kind === SyntaxKind.Parameter) return 'unknown';
        if (IMPORTED.has(declaration.kind)) return 'unknown';
        if (declaration.kind !== SyntaxKind.VariableDeclaration) return 'other';
        const initializer = unwrap(declaration.initializer);
        if (initializer === undefined) return 'unknown';
        target = initializer;
        continue;
      }
      return 'unknown';
    }
    return 'unknown';
  };

  /** What a locally-declared callee RETURNS, so a factory can be followed. */
  const returnsOfCallee = (callee: Syntax, hops: number): Syntax[] => {
    if (callee.kind !== SyntaxKind.Identifier || hops > MAX_HOPS) return [];
    const declaration = localDeclaration(callee);
    const fn =
      declaration?.kind === SyntaxKind.FunctionDeclaration
        ? declaration
        : unwrap(declaration?.initializer);
    if (
      fn?.kind !== SyntaxKind.FunctionDeclaration &&
      fn?.kind !== SyntaxKind.ArrowFunction &&
      fn?.kind !== SyntaxKind.FunctionExpression
    ) {
      return [];
    }
    const body = fn.body;
    if (body === undefined) return [];
    if (body.kind !== SyntaxKind.Block) return [body];
    const returned: Syntax[] = [];
    for (const node of walk(body)) {
      if (node.kind === SyntaxKind.ReturnStatement && node.expression !== undefined) {
        returned.push(node.expression);
      }
    }
    return returned;
  };

  /** Whether an argument is a route HANDLER — a function handed to the router. */
  function isHandlerShaped(node: Syntax | undefined, hop = 0): boolean {
    const target = unwrap(node);
    if (target === undefined || hop > MAX_HOPS) return false;
    if (
      target.kind === SyntaxKind.ArrowFunction ||
      target.kind === SyntaxKind.FunctionExpression ||
      target.kind === SyntaxKind.FunctionDeclaration
    ) {
      return true;
    }
    // A NAMED handler is still a handler.  Accepting only an inline function
    // meant `import { app } from './router.js'; app.post(path, handler)` — an
    // unreadable receiver AND an unreadable path — qualified as no
    // registration at all and vanished, taking the file out of the corpus with
    // it.  Asked of the binding, the spelling stops mattering.
    if (target.kind !== SyntaxKind.Identifier) return false;
    const declaration = localDeclaration(target);
    if (declaration === undefined) return false;
    if (declaration.kind === SyntaxKind.FunctionDeclaration) return true;
    // An IMPORTED handler is a handler this file cannot see the body of, and
    // "cannot see" must not mean "not a handler": with the router and the path
    // both unresolvable too, rejecting it discarded the registration entirely
    // and took the whole file out of the corpus.  Counted conservatively, the
    // unreadable path below then reports the route, which is the outcome a
    // gate that cannot read something owes.
    if (IMPORTED.has(declaration.kind)) return true;
    return (
      declaration.kind === SyntaxKind.VariableDeclaration &&
      isHandlerShaped(declaration.initializer, hop + 1)
    );
  }

  /** Every identifier in `scope` that binds to the same declaration as `name`. */
  const referencesTo = (name: Syntax, scope: Syntax): Syntax[] => {
    const declaration = project.checker
      .getSymbolAtPosition(String(root.path), name.getStart())
      ?.declarations.find((each) => String(each.path) === String(root.path));
    if (declaration === undefined) return [];
    const key = `${String(declaration.path)}#${declaration.index}`;
    const uses: Syntax[] = [];
    for (const node of walk(scope)) {
      if (node.kind !== SyntaxKind.Identifier) continue;
      const found = project.checker
        .getSymbolAtPosition(String(root.path), node.getStart())
        ?.declarations.find((each) => String(each.path) === String(root.path));
      if (found === undefined) continue;
      if (`${String(found.path)}#${found.index}` === key) uses.push(node);
    }
    return uses;
  };

  /** Whether a statement or expression contains a RETURN or a THROW. */
  const refusesWithin = (node: Syntax | undefined): boolean => {
    if (node === undefined) return false;
    // EVERY PATH must exit, not merely some.  `if (denial) { if (shouldEnforce)
    // return c.json(denial, 403); }` refuses only when the inner condition
    // holds, and an ineligible member walks past when it does not — so the
    // presence of a `return` somewhere in the branch proves nothing.
    //
    // PRUNED at a nested function too: `if (denial) { const f = () => {
    // return 1; } }` declares a callback and exits nothing.
    return alwaysExits(node);
  };

  /**
   * Whether control ALWAYS leaves the handler from this statement.
   *
   * The ordinary definite-exit question: a `return`/`throw` exits; a block
   * exits if any statement in it does (nothing after it runs); an `if` exits
   * only when BOTH branches do, which is what an `else`-less `if` fails.
   */
  const statementsOf = (node: Syntax): Syntax[] => {
    const children: Syntax[] = [];
    node.forEachChild((child: Syntax) => {
      children.push(child);
    });
    return children;
  };

  const alwaysExits = (node: Syntax | undefined): boolean => {
    if (node === undefined) return false;
    if (node.kind === SyntaxKind.ReturnStatement || node.kind === SyntaxKind.ThrowStatement) {
      return true;
    }
    if (node.kind === SyntaxKind.Block) {
      return statementsOf(node).some((statement) => alwaysExits(statement));
    }
    if (node.kind === SyntaxKind.IfStatement) {
      return alwaysExits(node.thenStatement) && alwaysExits(node.elseStatement);
    }
    // A labelled or `try` body can exit too, but only through statements this
    // already recognises; anything else — a loop, an expression — does not.
    if (node.kind === SyntaxKind.TryStatement || node.kind === SyntaxKind.LabeledStatement) {
      return statementsOf(node).some((child) => alwaysExits(child));
    }
    return false;
  };

  /**
   * Whether anything is AWAITED strictly between two positions in the handler.
   *
   * The guard's own `await` ends at `from`, so it is never counted; what this
   * finds is work the handler did while an ineligible member was still on
   * their way to being refused.
   */
  const awaitsBetween = (scope: Syntax, from: number, to: number): boolean => {
    for (const each of walk(scope)) {
      if (each.kind !== SyntaxKind.AwaitExpression) continue;
      if (each.getStart() >= from && each.getEnd() <= to) return true;
    }
    return false;
  };

  /**
   * `null`, `undefined`, or anything whose TYPE is one of them.
   *
   * Reading the syntax alone saw `denial === null` and missed
   * `const eligible: typeof denial = null; denial === eligible`, which is the
   * same test through a binding — so the comparison was treated as an ordinary
   * one and the polarity came out backwards.  The checker knows what the
   * binding holds, so it is asked.
   */
  const isNullish = (node: Syntax | undefined, hop = 0): boolean => {
    const target = unwrap(node);
    if (target === undefined || hop > MAX_HOPS) return false;
    if (target.kind === SyntaxKind.NullKeyword || target.kind === SyntaxKind.VoidExpression) {
      return true;
    }
    if (target.kind !== SyntaxKind.Identifier) return false;
    if (nameOf(target) === 'undefined') return true;
    const type = project.checker.getTypeAtLocation(asNode(target));
    const intrinsic = type?.isIntrinsicType() === true ? type.intrinsicName : undefined;
    if (intrinsic === 'null' || intrinsic === 'undefined') return true;
    // The DECLARED type can be wider than what the binding holds — `const
    // eligible: typeof denial = null` is annotated with the verdict's type and
    // is still nothing — so the initializer settles it when the type does not.
    const declaration = localDeclaration(target);
    if (declaration?.kind !== SyntaxKind.VariableDeclaration) return false;
    return isNullish(declaration.initializer, hop + 1);
  };

  /**
   * Whether this use of the verdict CONTROLS a refusal OF THE INELIGIBLE.
   *
   * Not "is the result used" — a verdict can be read, logged and ignored, and
   * an ineligible account is refused by none of that.  And not "does some
   * branch return" either: `checkGovernanceEligibility` resolves to `null` for
   * an ELIGIBLE member and a denial for an ineligible one, so
   * `if (!denial) return c.json({}, 403)` exits for exactly the wrong people
   * while looking, structurally, like a guard.  Reading the shape without the
   * POLARITY accepted a route that refused everybody who was allowed and let
   * everybody who was not straight through.
   *
   * So the walk carries polarity.  `truthy` means "this expression is truthy
   * exactly when the verdict is" — negation flips it, `=== null` flips it,
   * `!== null` keeps it — and at an `if`/ternary the branch that must refuse is
   * the one taken when the verdict is TRUTHY, because that is the denial.
   */
  const controlsARefusal = (use: Syntax): number | undefined => {
    let node: Syntax = use;
    let truthy = true;
    // Whether the verdict has been consumed as a CONDITION on the way up.
    // `return denial ?? next()` hands the denial itself back; `return denial ?
    // a : b` hands back one of two OTHER values, and which of them refuses is
    // not something this can read.  Without the distinction the return rule
    // vouched for `denial ? castVote() : json({}, 403)` — a route that refuses
    // exactly the members it should admit, which is the same defect polarity
    // was added to catch, one position along.
    let asCondition = false;
    for (let hop = 0; hop < MAX_HOPS; hop += 1) {
      const parent = node.parent;
      if (parent === undefined) return undefined;
      if (parent.kind === SyntaxKind.ReturnStatement || parent.kind === SyntaxKind.ThrowStatement) {
        // Handing the verdict itself back refuses whoever it denies — but only
        // if what is handed back IS the denial, not its negation, and not a
        // value it merely selected between.
        return truthy && !asCondition ? parent.getStart() : undefined;
      }
      if (parent.kind === SyntaxKind.IfStatement) {
        // Only the CONDITION decides anything; the verdict appearing inside a
        // branch is just a value being used there.
        if (parent.expression?.getStart() !== node.getStart()) return undefined;
        return refusesWithin(truthy ? parent.thenStatement : parent.elseStatement)
          ? parent.getStart()
          : undefined;
      }
      if (parent.kind === SyntaxKind.ConditionalExpression) {
        if (parent.condition?.getStart() !== node.getStart()) return undefined;
        if (refusesWithin(truthy ? parent.whenTrue : parent.whenFalse)) return parent.getStart();
        // The ternary's VALUE still tracks the verdict, so an enclosing `if`
        // can still be judged — but the return rule no longer can.
        asCondition = true;
        node = parent;
        continue;
      }
      if (parent.kind === SyntaxKind.PrefixUnaryExpression) {
        // `!denial` is true for the ELIGIBLE, so the branch to check swaps.
        if (parent.operator === SyntaxKind.ExclamationToken) truthy = !truthy;
        node = parent;
        continue;
      }
      if (parent.kind === SyntaxKind.BinaryExpression) {
        const operator = parent.operatorToken?.kind ?? -1;
        const other = parent.left?.getStart() === node.getStart() ? parent.right : parent.left;
        if (EQUALITY.has(operator)) {
          // Comparing AGAINST nothing is the same test spelled as an equality:
          // `denial === null` holds for the eligible, `!== null` for the denied.
          // Against anything ELSE the polarity is not knowable — `denial === x`
          // says nothing about eligibility — so this refuses to guess rather
          // than propagating a polarity it has not established.
          if (!isNullish(other)) return undefined;
          if (
            operator === SyntaxKind.EqualsEqualsEqualsToken ||
            operator === SyntaxKind.EqualsEqualsToken
          ) {
            truthy = !truthy;
          }
          node = parent;
          continue;
        }
        // Composition carries the verdict only when EVERY truthy denial still
        // reaches the refusal.  `denial || x` and `denial ?? x` are truthy
        // whenever `denial` is, so they do.  `denial && x` is not: with `x`
        // false an ineligible member walks past a branch that looks like a
        // guard, so this refuses unless the other operand is literally `true`.
        if (!COMPOSITION.has(operator)) return undefined;
        if (operator === SyntaxKind.AmpersandAmpersandToken) {
          const alwaysTrue = unwrap(other)?.kind === SyntaxKind.TrueKeyword;
          if (!alwaysTrue) return undefined;
        }
        node = parent;
        continue;
      }
      // Ways of spelling the same test, all of which keep the verdict in play.
      if (TRANSPARENT.has(parent.kind) || parent.kind === SyntaxKind.AwaitExpression) {
        node = parent;
        continue;
      }
      return undefined;
    }
    return undefined;
  };

  /**
   * Whether the eligibility guard is invoked AND its verdict refuses somebody.
   *
   * Middleware needs no verdict check: `requireGovernanceEligibility()` is the
   * refusal, installed in the chain.  A handler-level `checkGovernanceEligibility`
   * RETURNS a verdict, and calling it decides nothing on its own.
   */
  /**
   * Whether an import binding was taken from the eligibility module.
   *
   * The specifier is read rather than resolved because the gate parses only the
   * route files: the module itself is not in the batch, so its path is the only
   * evidence there is — and it is enough to tell the real guard from a
   * same-named import of something else.
   */
  const fromEligibilityModule = (declaration: Syntax): boolean => {
    for (let above: Syntax | undefined = declaration; above !== undefined; above = above.parent) {
      if (above.kind !== SyntaxKind.ImportDeclaration) continue;
      const from = staticString(above.moduleSpecifier);
      return from !== undefined && /(^|\/)governance\/eligibility(\.js)?$/.test(from);
    }
    return false;
  };

  /** The FUNCTION a route argument denotes, when it is passed by name. */
  const bodyBehind = (argument: Syntax): Syntax | undefined => {
    const target = unwrap(argument);
    if (target?.kind !== SyntaxKind.Identifier) return undefined;
    const declaration = localDeclaration(target);
    if (declaration === undefined) return undefined;
    if (
      declaration.kind === SyntaxKind.FunctionDeclaration ||
      declaration.kind === SyntaxKind.ArrowFunction ||
      declaration.kind === SyntaxKind.FunctionExpression
    ) {
      return declaration;
    }
    const bound = unwrap(declaration.initializer);
    return bound?.kind === SyntaxKind.ArrowFunction || bound?.kind === SyntaxKind.FunctionExpression
      ? bound
      : undefined;
  };

  const guardedBy = (args: readonly Syntax[]): boolean => {
    for (const spelled of args) {
      // A handler passed BY NAME is the same handler: `app.post(path, handler)`
      // with the guard inside `handler` is guarded, and walking only the
      // identifier saw an empty body and blocked correct code.
      const argument = bodyBehind(spelled) ?? spelled;
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
        if (called === undefined || !GUARD_NAMES.has(called)) continue;
        // The guard is the one from the ELIGIBILITY MODULE.  Matching the NAME
        // alone meant a local function called `checkGovernanceEligibility` —
        // which may return anything — satisfied a fail-closed gate; accepting
        // any import meant `from './fake.js'` did too.  So the import's SOURCE
        // is checked, and a locally defined declaration is never the guard.
        const spelledAs = callee.kind === SyntaxKind.Identifier ? callee : callee.name;
        const declaredAs = spelledAs === undefined ? undefined : localDeclaration(spelledAs);
        if (declaredAs !== undefined && DEFINED_LOCALLY.has(declaredAs.kind)) continue;
        if (declaredAs !== undefined && !fromEligibilityModule(declaredAs)) continue;
        // MIDDLEWARE guards by being INSTALLED, not by being called:
        // `requireGovernanceEligibility()` inside a handler body merely builds
        // a middleware function and drops it, and an ineligible member walks
        // straight past.  It counts only as the registration ARGUMENT itself.
        if (called === 'requireGovernanceEligibility') {
          if (unwrap(argument)?.getStart() === node.getStart()) return true;
          continue;
        }

        // The verdict is either this expression, or the name it was bound to.
        let verdict: Syntax = node;
        for (let hop = 0; hop < MAX_HOPS; hop += 1) {
          const parent = verdict.parent;
          if (parent === undefined) break;
          if (parent.kind === SyntaxKind.AwaitExpression || TRANSPARENT.has(parent.kind)) {
            verdict = parent;
            continue;
          }
          break;
        }
        const declaration = verdict.parent;
        const uses =
          declaration?.kind === SyntaxKind.VariableDeclaration && declaration.name !== undefined
            ? referencesTo(declaration.name, argument)
            : [verdict];
        // WHERE the refusal sits matters as much as that it exists.  With
        //   const denial = await check(id); await castVote();
        //   if (denial) return c.json(denial, 403);
        // the vote is already persisted when the ineligible member is turned
        // away, so the guard refuses nothing that has not already happened.
        //
        // The decidable form of "the refusal dominates the mutations" is that
        // nothing else is AWAITED between the guard and the refusal: the reads
        // real handlers do first (`requireAuth(c)`, `c.req.valid('param')`) are
        // synchronous, and persisting anything in this codebase is not.
        const guardEnds = node.getEnd();
        for (const use of uses) {
          const refusesAt = controlsARefusal(use);
          if (refusesAt === undefined) continue;
          if (!awaitsBetween(argument, guardEnds, refusesAt)) return true;
        }
      }
    }
    return false;
  };

  /**
   * A registration method DESTRUCTURED off a router: `const { post } = app`.
   *
   * Hono installs its verb methods as instance arrow functions bound to the
   * router (`this[method] = (…) => …`), so a destructured `post` registers a
   * route exactly as `app.post` does — but the call's callee is an identifier,
   * not a property access, so it was not read as a registration at all and the
   * file left the corpus unclassified.  The binding says which router the
   * method came off and which method it is, so both are read from it.
   */
  const destructuredMethod = (
    identifier: Syntax,
  ): { readonly method: string; readonly receiver: Syntax } | undefined => {
    const declaration = localDeclaration(identifier);
    if (declaration?.kind !== SyntaxKind.BindingElement) return undefined;
    const pattern = declaration.parent;
    if (pattern?.kind !== SyntaxKind.ObjectBindingPattern) return undefined;
    const source = pattern.parent?.initializer;
    if (source === undefined) return undefined;
    const named = declaration.propertyName ?? declaration.name;
    // `const { ['post']: register } = app` selects the same method the plain
    // spelling does; reading the computed node's TEXT gave `['post']`, which
    // names no method, so the registration was not found at all.
    const method =
      named?.kind === SyntaxKind.ComputedPropertyName
        ? staticString(named.expression)
        : nameOf(named);
    return method === undefined ? undefined : { method, receiver: source };
  };

  const found: FoundRoute[] = [];

  /** Read ONE call as a registration of `called` on a receiver of `receiver`. */
  const register = (node: Syntax, called: string, receiver: Receiver): void => {
    // 'unknown' is deliberately NOT skipped: a receiver this cannot classify
    // may well be a governance router, and dropping it would report success
    // over an endpoint the gate never looked at.
    if (receiver === 'other') return;

    const args = [...(node.arguments ?? [])];
    // The THREE ways Hono registers a route, all of which reach the same
    // handler: the method shorthand, `.on(METHOD(S), PATH(S), …)`, and `.all`,
    // which answers every method — so it is a governance mutation route just as
    // surely as `.post` is, and skipping it let one ship unguarded.
    const viaOn = called === 'on';
    const viaAll = called === 'all';
    if (!viaOn && !viaAll && !MUTATION_METHODS.has(called)) return;
    const declared = viaOn ? staticStrings(args[0]) : { values: [called], complete: true };
    const methods = declared.values.map((method) => method.toLowerCase());
    const pathArgument = viaOn ? args[1] : args[0];
    // When the receiver could not be resolved, the REGISTRATION has to look
    // like one before this is treated as a route.  `db.delete(rows)`,
    // `cache.delete('key')` and `Promise.all([…])` are ordinary calls that
    // happen to share a name with a Hono method.  Asking about the ARGUMENTS
    // rather than the receiver keeps an unresolvable-but-real router in scope
    // without dragging every same-named method call in with it.
    //
    // TWO shapes qualify, because requiring the path alone lost the case that
    // most needs failing closed: `import { app } from './router.js';
    // app.post(path, handler)` has no readable path AND no readable receiver,
    // so it vanished entirely — while the identical computed path on a LOCAL
    // Hono router was correctly reported unreadable.  A registration also looks
    // like one when it HANDS OVER A HANDLER, which an ordinary `.delete(rows)`
    // does not; the unreadable-path failure below then does its job.
    if (receiver === 'unknown') {
      const rooted = staticString(pathArgument)?.startsWith('/') ?? false;
      const handled = args.slice(1).some((each) => isHandlerShaped(each));
      if (!rooted && !handled) return;
    }
    // `.all` covers every mutation; it is reported under its own name rather
    // than four times over, and the allowlist matches on path regardless.
    const mutations = viaAll ? ['all'] : methods.filter((method) => MUTATION_METHODS.has(method));
    // A method list with an unreadable entry may hide a mutation, so the
    // registration is reported rather than skipped.
    if (mutations.length === 0 && declared.complete) return;

    // `.on` accepts an ARRAY of paths, each registering the same handler.
    const paths = staticStrings(pathArgument);
    const guarded = guardedBy(viaOn ? args.slice(2) : args.slice(1));
    const line = lineAt(node.getStart());
    const readable = paths.complete && paths.values.length > 0 && declared.complete;
    const named = mutations.length > 0 ? mutations : ['<unreadable method>'];
    for (const method of named) {
      if (!readable) {
        found.push({
          file,
          method,
          path: paths.values[0] ?? '<non-static path>',
          guarded,
          line,
          readable: false,
        });
        continue;
      }
      for (const path of paths.values) {
        found.push({ file, method, path, guarded, line, readable: true });
      }
    }
  };

  for (const node of walk(root)) {
    if (node.kind !== SyntaxKind.CallExpression) continue;
    const callee = unwrap(node.expression);
    // `const { post } = app; post(…)` — the method was taken OFF the router, so
    // the callee is a plain identifier and the receiver is the binding's source.
    if (callee?.kind === SyntaxKind.Identifier) {
      const off = destructuredMethod(callee);
      if (off !== undefined) register(node, off.method, receiverKind(off.receiver));
      continue;
    }
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
    register(node, called, receiverKind(callee.expression));
  }
  return found;
}

/**
 * A static string, or every static string of an array literal — and whether ALL
 * of them could be read.
 *
 * `complete` is the load-bearing half.  `.on(['GET', mutation], …)` yielded only
 * `GET`, so the registration classified as a read and was skipped entirely,
 * letting an unguarded POST through a gate whose whole point is failing closed.
 * A list this cannot fully read is a list it must not judge.
 */
function staticStrings(node: Syntax | undefined): { values: string[]; complete: boolean } {
  const single = staticString(node);
  if (single !== undefined) return { values: [single], complete: true };
  const target = unwrap(node);
  if (target?.kind !== SyntaxKind.ArrayLiteralExpression) {
    return { values: [], complete: node === undefined };
  }
  const values: string[] = [];
  let complete = true;
  target.forEachChild((element) => {
    const value = staticString(element);
    if (value === undefined) complete = false;
    else values.push(value);
  });
  return { values, complete };
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

/**
 * The composition root the running API is built from.
 *
 * The corpus is derived from HERE rather than assumed, because the gate's
 * guarantee is about governance participation wherever it lives — and a fixed
 * list of four files quietly stops being that the moment a fifth registers a
 * route.
 */

/**
 * Files that register a route but carry NO governance-participation surface.
 *
 * Every file that registers a mutation route must appear here or in
 * `GOVERNANCE_ROUTE_FILES`: a file in neither is one the gate has never looked
 * at, and reporting success over it is exactly the silent gap this list
 * closes.  Adding a governance surface to one of these means moving it, which
 * is a visible act in review.
 *
 * A file that registers no MUTATION is not listed at all — a read-only surface
 * cannot carry participation, and an entry for one is stale by construction.
 * That is why the health probes, the public invariant reads and the model-hub
 * proxy are absent: each said "read-only" in its own reason, and the gate now
 * agrees rather than taking their word for it.
 *
 * A stale entry fails the gate, like every other allowlist here.
 */
export const NON_GOVERNANCE_ROUTES: Readonly<Record<string, string>> = {
  'apps/api/src/routes/v1.ts':
    'versioned BFF surface: settings, attention ingest, telemetry, push and notifications',
  'apps/api/src/routes/csp-report.ts': 'browser CSP violation report sink',
  'apps/api/src/routes/private-rendezvous.ts':
    'WS-S.6.6 server-blind rendezvous — opaque announce/poll/signal, no room state',
  'apps/api/src/lcap/routes.ts':
    '§29 LCAP content/checkpoint sync plane — content availability, never participation',
  'apps/api/src/routes/auth.ts':
    'sign-in and session lifecycle; participation is not governed here',
  'apps/api/src/routes/auth-register.ts':
    'sign-up: proof-of-work CAPTCHA, registration, email verification',
  'apps/api/src/routes/auth-credentials.ts':
    'WebAuthn/email/wallet credential and step-up management for an existing account',
  'apps/api/src/routes/auth-mfa.ts': 'TOTP enrolment and removal — a credential, not a vote',
  'apps/api/src/routes/events-admin.ts':
    'platform event-pipeline operations (requireSteward staff capability + MFA)',
  'apps/api/src/routes/privacy.ts': 'consent and data-rights self-service, never a governance vote',
  'apps/api/src/routes/events.ts': 'attention aggregate ingest — bucketed signal, no participation',
  'apps/api/src/routes/stories.ts': 'content submission and reading',
  'apps/api/src/routes/ingestion-admin.ts': 'platform ingestion operations (staff capability)',
  'apps/api/src/routes/invariants-admin.ts': 'platform invariant operations (staff capability)',
  'apps/api/src/routes/ranking-admin.ts': 'platform ranking operations (staff capability)',
  'apps/api/src/routes/forum.ts':
    'contributions and comments — content participation, never KYC-gated',
  'apps/api/src/routes/trust-safety.ts':
    'reports and appeals; a safety report is not a governance act',
  'apps/api/src/routes/moderation-console.ts':
    'platform enforcement console (staff capability + MFA)',
  'apps/api/src/routes/ai-governance-public.ts': 'model transparency reads',
  'apps/api/src/routes/ai-governance-admin.ts': 'platform model operations (staff capability)',
  'apps/api/src/routes/wallet.ts': 'wallet linking; holding a wallet is not participating',
  'apps/api/src/routes/knomosis.ts': 'finality gateway — submits what governance already decided',
  'apps/api/src/routes/compliance.ts': 'lawful-access and SAR handling under counsel authority',
  // Reached by NOTHING the old mount walk did: these are mounted by the
  // development boot and by `e2e-server.ts`, never by the production root.
  'apps/api/src/simulator/routes.ts':
    'DEV-ONLY traffic-simulator control surface, mounted only when NODE_ENV is development',
  'apps/api/src/routes/test-auth.ts':
    'E2E-ONLY session minter for the BFF harness, mounted only by e2e-server.ts',
  'apps/api/src/routes/test-wallet.ts':
    'E2E-ONLY wallet signer for the BFF harness, mounted only by e2e-server.ts',
};

/** Bindings that name a value from ANOTHER module — every import form there is. */
/**
 * Every file under the API source tree that REGISTERS a route.
 *
 * THE BOUNDED QUESTION, and why it replaced the mount graph.  This gate used
 * to derive its corpus by WALKING the mount graph — following `.route()` calls
 * from the composition root, through import forms, through local wrappers,
 * through bindings — and every round of review found one more shape that walk
 * could not follow: a default import, a namespace import, a router held in a
 * const, a local function returning an imported factory, an imported function
 * returning another module's factory.  Each fix was correct and invited the
 * next, which is the same trap the sink analyzer's header describes: modelling
 * how a value REACHES somewhere is unbounded.
 *
 * "Which files register a route?" is bounded.  It is answered by the same
 * predicate that already decides what a route IS — a mutation call on a
 * receiver chain rooting at `new Hono()` — asked of every tracked source
 * instead of only the ones a walk managed to reach.  No mount shape can hide a
 * file from it, because it never asks how the router got mounted.
 *
 * It is also STRICTLY WIDER than the walk was.  The walk started at the
 * production composition root, so it structurally could not see
 * `simulator/routes.ts` (mounted by the development boot) or the two E2E-only
 * harness routes (mounted by `e2e-server.ts`) — three route-registering files
 * that were classified nowhere while the gate reported success.  All 337
 * tracked sources parse in one project in under a third of a second, so the
 * whole question costs less than the walk it replaces.
 */
const API_SOURCE_ROOT = 'apps/api/src';

/**
 * Tests declare routers of their own; they serve nothing.
 *
 * Spelled out rather than written as one alternation, because this decides what
 * the gate DOES NOT read: `/(?:^|\/)__tests__\/|\.test\.ts$/` anchors its second
 * branch and not its first, which CodeQL flags as misleading precedence and a
 * reader has to work out.  An exclusion nobody can read at a glance is how a
 * real source ends up silently outside a security gate's corpus.
 */
function isTestPath(path: string): boolean {
  return path.endsWith('.test.ts') || path.includes('/__tests__/') || path.startsWith('__tests__/');
}

/**
 * Every tracked API source, from git rather than from a directory walk.
 *
 * A DIRECTORY pathspec, deliberately.  A recursive glob of the double-star
 * form reads as "every TypeScript file under here" and is not: git's `**`
 * required at least one intermediate directory, so the three files that sit
 * directly in `apps/api/src`
 * — `app.ts`, `index.ts` and `e2e-server.ts`, the composition roots — were
 * silently outside the corpus, which is the exact failure this enumeration
 * replaced a mount walk to prevent.  A directory pathspec has no such subtlety:
 * it is every tracked path beneath it, and the extension is filtered here where
 * it can be read.
 */
export function trackedApiSources(): string[] {
  return execFileSync('git', ['ls-files', API_SOURCE_ROOT], { cwd: ROOT, encoding: 'utf-8' })
    .split('\n')
    .filter((each) => each.endsWith('.ts') && !isTestPath(each));
}

export function runGovernanceKycGate(
  read: (relPath: string) => string = (relPath) => readFileSync(resolve(ROOT, relPath), 'utf-8'),
  files: readonly string[] = trackedApiSources(),
): string[] {
  const issues: string[] = [];
  const scanned = new Set<string>(GOVERNANCE_ROUTE_FILES);

  // ONE parse for the whole API tree: it answers which files register a route
  // AND what those routes are, so the corpus and the verdict cannot disagree.
  const byFile = routesFor(
    [...new Set([...files, ...GOVERNANCE_ROUTE_FILES])].map((file) => ({
      path: file,
      content: read(file),
    })),
  );

  // EVERY file that registers a route must be classified.  One that is neither
  // scanned nor declared non-governance is a surface the gate has never read.
  const registering = [...byFile.entries()]
    .filter(([, routes]) => routes.length > 0)
    .map(([file]) => file)
    .sort();
  for (const file of registering) {
    if (scanned.has(file) || NON_GOVERNANCE_ROUTES[file] !== undefined) continue;
    issues.push(
      `${file} REGISTERS a mutation route but is CLASSIFIED NOWHERE. Add it to ` +
        'GOVERNANCE_ROUTE_FILES if it carries a governance-participation surface, or to ' +
        'NON_GOVERNANCE_ROUTES with a written reason it does not.',
    );
  }
  const registers = new Set(registering);
  for (const file of Object.keys(NON_GOVERNANCE_ROUTES)) {
    if (!registers.has(file)) {
      issues.push(
        `stale NON_GOVERNANCE_ROUTES entry '${file}': it registers no mutation route — remove it.`,
      );
    }
  }
  const usedAllowlist = new Set<number>();
  for (const file of GOVERNANCE_ROUTE_FILES) {
    const routes = byFile.get(file) ?? [];
    for (const route of routes) {
      // A mutation registered on a router with a path this gate cannot read is
      // a route it cannot classify, so it fails CLOSED — the only place that
      // discipline is still needed, now that finding the route no longer
      // depends on how the file is formatted.
      if (!route.readable) {
        issues.push(
          `${file}:${route.line}: ${route.method.toUpperCase()} registration could not be read ` +
            '(its method list or path is not a static string), so it cannot be matched against ' +
            'the guard or the allowlist. Register the route with literal methods and a literal ' +
            'path.',
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

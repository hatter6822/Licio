// SPDX-License-Identifier: AGPL-3.0-or-later
//
// AUDITED-WRITE gate — a durable state change and the audit row that accounts
// for it must commit TOGETHER.
//
// This is the recurrence guard for one defect class, found once per review round
// across four workstreams before anyone named it: the handler performs the
// change, then appends the audit, and the two are separate moments.  Either
// order is wrong in its own way.  Audit-then-act leaves a permanent record of a
// transition a failure prevented; act-then-audit leaves an irreversible change
// with no record — and the bridge-request endpoint showed what that costs in
// practice: an append failure answered 500 while leaving a live request behind,
// so the map withheld the target, every retry answered `already_open`, and the
// durable action had no record at all.  A compensating write is itself
// best-effort, so it is not the answer either.
//
// `apps/api/src/moderation/` solved this properly (`ModerationTransactor`: the
// state change and `tx.audit` in one transaction, neither landing alone), and
// for a long time it was the ONLY module that had.  The seam is domain-agnostic
// — `lib/in-memory-unit-of-work.ts` plus a per-domain transactor — so this gate
// asks every route the question that module already answers.
//
// WHAT IT FLAGS.  A route handler that BOTH appends an audit row and performs a
// durable write, where the append is not lexically inside a unit callback
// (`…transactor.run(…)` / `…transact(…)`).
//
// THERE IS NO ALLOWLIST.  There was one, holding the 29 handlers that predated
// this gate, and it was the wrong shape twice over: a rule with an exemption
// list reads to the next author as optional, and the list was a schedule for
// work nobody had committed to doing.  Every one of those handlers now runs
// through its domain's unit — WS-D identity, WS-N compliance, WS-F ingestion,
// WS-G/WS-Q forum and WS-H invariants each gained one, joining WS-J — so the
// gate has nothing left to excuse, and a new violation has no way to be written
// down as acceptable.
//
// …AND THE UNIT ONE CALL AWAY.  A handler that writes and then calls a helper
// which opens the unit and audits inside it reads as two innocent halves —
// handler with a write and no append, helper with an append properly inside a
// unit — while the defect lives in the seam between them.  That is how
// `/mfa/totp/verify` spent a single-use recovery code with a `setAuth` and then
// called `finishMfa`, whose unit recorded the verification: an append failure
// answered 500 having permanently burned the code.  So a same-file helper that
// audits inside its own unit is attributed to its CALLER.  The fix the gate is
// asking for is to hand the write INTO that unit (`finishMfa(…, (tx) =>
// tx.store.consumeRecoveryCode(…))`, the shape the moderation call sites use
// when they pass a transactor's stores), and `insideCallbackTo` recognises it.
//
// WHAT IT DOES NOT CLAIM.  A write with no audit at all is a different question
// this gate does not ask, and attribution stops at the file: a helper imported
// from another module is invisible here.
//
// READ FROM THE PARSE, like every other gate here: a call is a CallExpression
// with a resolved callee shape, not a line matching a regex, and the enclosing
// function is the AST's, not a brace count.
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { SyntaxKind } from 'typescript/unstable/ast';
import { lineAt, newlineIndex, type Syntax, walk, withParsedSources } from './ts-source.js';

const ROOT = resolve(import.meta.dirname, '..');
const ROUTES_DIR = resolve(ROOT, 'apps/api/src/routes');

/** Calls that append to an audit trail.
 *
 *  The receiver is matched case-INSENSITIVELY on its last segment, because the
 *  spellings in the tree are `audit.append`, `tx.audit.append` AND
 *  `tx.identityAudit.append` — and a `\baudit\.append$` pattern silently missed
 *  the third, which is every WS-F/WS-G/WS-Q handler that records to the WS-D
 *  trail. A gate that cannot see a whole domain's audit calls reports that
 *  domain as clean. */
const AUDIT_CALLS = [/(?:^|\.)[A-Za-z]*[Aa]udit\.append$/, /^writeAudit$/, /\bauditChain\b/];
/**
 * READS, not writes — and everything else on a service is a WRITE.
 *
 * This used to be the other way round: an allowlist of write verbs, which fails
 * OPEN. A store method whose name nobody thought of read as a read, so the gate
 * reported the handler clean — and it did, twice, over exactly the defect it
 * advertises: `/mfci/cases/:caseId/resolve` called `mfciCases.resolve()` and
 * `mfciRiskStates.set()` before a bare `identity.audit.append()`, and `/config`
 * called `storeInvariantsConfigValue()` before its own. Neither verb was on the
 * list, so both were invisible, and the commit that introduced the gate claimed
 * a guarantee the gate did not deliver.
 *
 * Inverted, the failure mode inverts with it: an unrecognised verb is now a
 * WRITE, so a new store method is guarded from the moment it exists and the cost
 * of forgetting is a false alarm rather than a silent hole. The list stays
 * deliberately tight — `resolve` is absent because `mfciCases.resolve` is a
 * write, and a verb that is a read on one store and a write on another has to
 * be treated as the dangerous one.
 */
const READ_METHODS =
  /^(get|list|find|count|has|is|exists|load|read|reload|search|fetch|latest|active|peek|all)([A-Z]|$)/;

/**
 * Read methods whose VERB is ambiguous, named exactly rather than by prefix.
 *
 * `resolve` cannot join the prefix list — `mfciCases.resolve` is the write this
 * whole inversion exists to catch — but `users.resolveMany` is a handle lookup,
 * and `decisionLogs.query` is a read whose verb could equally have been a
 * mutation elsewhere. Each entry is a measured exception, so the default stays
 * "unrecognised ⇒ write" and every relaxation is a line someone had to add on
 * purpose.
 */
const READ_EXCEPTIONS = new Set(['resolveMany', 'query', 'verifyChain', 'exportForAccount']);

/**
 * Free functions that write, by name — the ONE place a write allowlist remains.
 *
 * A member call names its receiver, so "is this domain state?" is answerable
 * structurally and the rule can fail closed. A bare call does not: a route file
 * hands services to projections (`toRoomSummary`), emitters
 * (`emitPrivacyRequestEvent`) and helpers that already transact internally
 * (`submitReport`) far more often than to a raw writer, so failing closed there
 * produces alarms on correct code — and a gate that cries wolf is one people
 * learn to skip. So the bare-call form is named, and `storeInvariantsConfigValue`
 * (the `/config` false-green the review found) is why the list exists at all.
 */
const FREE_WRITE_FUNCTIONS =
  /^(store|save|persist|write|apply|purge|anonymize|scrub|freeze|rebaseline|revoke|grant|resolveItemSafetyState)/;

/**
 * Bindings that hold a services/store object — the RECEIVER test that replaces
 * the verb test.
 *
 * Structural rather than a name list: a local initialised from a
 * `get*Services()` / `resolve*()` factory, plus the parameters of unit
 * callbacks (`tx`, `stores`). Everything reached through one of those is domain
 * state; everything else in a handler is Hono, zod, or local computation.
 */
const SERVICE_FACTORY = /^(get[A-Z][A-Za-z]*Services|resolve[A-Z][A-Za-z]*)$/;

/** Opening a unit of work.
 *
 *  `runChainedUnit` is a free function rather than a method, and leaving it out
 *  made every WS-N policy write read as uncommitted — the gate reported a
 *  correctly-transacted handler as a violation, which is the failure mode that
 *  teaches people to ignore it. */
const UNIT_CALLS = /(\.transactor\.run|\.transact|\.runInUnit|^runChainedUnit)$/;

/**
 * Receivers whose writes are NOT the durable state an audit accounts for.
 *
 * Redis-backed ephemera — attempt counters, one-time codes, WebAuthn challenges,
 * a policy cache — expire on their own and nothing audits them. They also cannot
 * join a Postgres transaction, so demanding it would be demanding the
 * impossible. (A Redis effect that MUST NOT outlive a failed record is a
 * different matter, and those are placed inside the unit after the append so an
 * append failure prevents them; see `finishMfa`.)
 */
const EPHEMERAL_RECEIVERS = /\.(otp|challenges|policyCache|cache|metrics|broadcaster)\./;

/**
 * Members of a services object that are NOT stores.
 *
 * A services bundle carries its clock, its id source, its logger and its
 * transactor beside the stores, and none of those hold domain state — `now()`
 * and `uuid()` are pure, `log`/`metrics`/`alert` are observability, `mailer` is
 * an outbound effect that must stay OUTSIDE a unit precisely because it cannot
 * be rolled back. Without this the receiver test flags a handler for reading its
 * own clock.
 */
const NON_STORE_MEMBERS =
  /^(now|uuid|log|logger|metrics|alert|config|mailer|secretBox|rateLimit|transactor|transact)$|^on[A-Z]/;

interface Finding {
  readonly file: string;
  readonly line: number;
  readonly detail: string;
}

function calleeText(call: Syntax): string {
  const expression = call.expression;
  return expression === undefined ? '' : expression.getText();
}

/** The nearest enclosing function-ish node, or undefined at top level. */
function enclosingFunction(node: Syntax): Syntax | undefined {
  for (let at = node.parent; at !== undefined; at = at.parent) {
    if (
      at.kind === SyntaxKind.ArrowFunction ||
      at.kind === SyntaxKind.FunctionExpression ||
      at.kind === SyntaxKind.FunctionDeclaration ||
      at.kind === SyntaxKind.MethodDeclaration
    ) {
      return at;
    }
  }
  return undefined;
}

/** Whether `node` sits inside a unit-of-work callback. */
function insideUnit(node: Syntax): boolean {
  for (let at = node.parent; at !== undefined; at = at.parent) {
    if (at.kind === SyntaxKind.CallExpression && UNIT_CALLS.test(calleeText(at))) return true;
  }
  return false;
}

/** The route path this handler is registered under, for the finding text. */
function handlerLabel(fn: Syntax): string {
  for (let at = fn.parent; at !== undefined; at = at.parent) {
    if (at.kind !== SyntaxKind.CallExpression) continue;
    const first = at.arguments?.[0];
    if (first?.kind === SyntaxKind.StringLiteral) return first.text ?? '';
  }
  return '(unnamed handler)';
}

/**
 * Is this a ROUTE REGISTRATION rather than a durable write?
 *
 * `app.delete('/things/:id', handler)` is Hono declaring an HTTP DELETE, and it
 * matches the write vocabulary exactly as a store's `delete` does. Worse, a
 * chained registration's `getStart()` is the start of the WHOLE chain, so the
 * finding pointed at `new Hono()` on line 132 and named no handler at all — a
 * report a reader cannot act on, attached to code that is not a defect.
 *
 * The discriminator is the first argument: a route path is a string literal
 * beginning with `/`, and no store method here takes one.
 */
function isRouteRegistration(call: Syntax): boolean {
  const first = call.arguments?.[0];
  if (first?.kind !== SyntaxKind.StringLiteral) return false;
  return (first.text ?? '').startsWith('/');
}

/**
 * Is this write on an EXIT PATH that never reaches the handler's record?
 *
 * `if (await store.getUserByEmail(pending)) { await store.setAuth(userId,
 * { pendingEmail: null }); return conflict; }` clears staged state and answers
 * 409 — nothing was accomplished, so there is nothing to account for, and the
 * audit later in the handler belongs to the path this one never reaches.
 * Demanding a unit there would be demanding a transaction around a single
 * statement to satisfy a rule about pairs.
 *
 * The test is deliberately narrow: the write's own block must RETURN, and that
 * block must contain no audit of its own. A write on a path that both changes
 * state and records it is judged normally.
 */
function onExitPathWithoutRecord(write: Syntax, helpers: ReadonlySet<string>): boolean {
  for (let at = write.parent; at !== undefined; at = at.parent) {
    if (at.kind === SyntaxKind.ArrowFunction || at.kind === SyntaxKind.FunctionDeclaration) break;
    if (at.kind !== SyntaxKind.Block) continue;
    // A function's OWN body is not an early exit — every handler ends in a
    // `return c.json(...)`, so treating the body as an exit path would excuse
    // every write in the tree. Only a block NESTED inside the handler counts.
    const parent = at.parent;
    if (
      parent?.kind === SyntaxKind.ArrowFunction ||
      parent?.kind === SyntaxKind.FunctionDeclaration ||
      parent?.kind === SyntaxKind.FunctionExpression ||
      parent?.kind === SyntaxKind.MethodDeclaration
    ) {
      break;
    }
    let returns = false;
    let records = false;
    for (const node of walk(at)) {
      if (node.kind === SyntaxKind.ReturnStatement) returns = true;
      if (node.kind !== SyntaxKind.CallExpression) continue;
      const callee = calleeText(node);
      // …and the record can be one call away here too.
      if (AUDIT_CALLS.some((pattern) => pattern.test(callee)) || helpers.has(callee)) {
        records = true;
      }
    }
    if (returns && !records) return true;
  }
  return false;
}

/**
 * The names in this file that hold a services/store object.
 *
 * `const invariants = resolveInvariants()`, `const forum = getForumServices()`,
 * and the `tx`/`stores` parameter of every unit callback. Collected once per
 * file; a shadowing local of the same name would only ever make the gate ask
 * MORE questions, never fewer, which is the safe direction for a fail-closed
 * rule.
 */
function serviceBindings(root: Syntax): Set<string> {
  const names = new Set<string>(['tx', 'stores']);
  for (const node of walk(root)) {
    if (node.kind === SyntaxKind.VariableDeclaration) {
      const init = node.initializer;
      const name = node.name?.getText();
      if (name === undefined || init?.kind !== SyntaxKind.CallExpression) continue;
      const callee = init.expression?.getText() ?? '';
      // `await getForumServices()` parses with the await outside; either way the
      // initializer's callee is what names the factory.
      if (SERVICE_FACTORY.test(callee)) names.add(name);
      continue;
    }
    // The unit callback's parameter, whatever it is spelled.
    if (node.kind !== SyntaxKind.CallExpression) continue;
    if (!UNIT_CALLS.test(calleeText(node))) continue;
    for (const arg of node.arguments ?? []) {
      if (arg.kind !== SyntaxKind.ArrowFunction && arg.kind !== SyntaxKind.FunctionExpression) {
        continue;
      }
      const first = arg.parameters?.[0]?.name?.getText();
      if (first !== undefined) names.add(first);
    }
  }
  return names;
}

/**
 * The root identifier of `a.b.c` / `a.b.c(...)`, or '' if it is not a chain.
 *
 * A chain rooted in a FACTORY CALL resolves to the factory's name, so
 * `getForumServices().rooms.insert(…)` — a handler reaching a service inline
 * rather than through a local — is judged like `forum.rooms.insert(…)`. Without
 * that, skipping the `const` was enough to leave the gate blind.
 */
function rootIdentifier(node: Syntax | undefined): string {
  let at = node;
  while (at !== undefined && at.kind === SyntaxKind.PropertyAccessExpression) at = at.expression;
  if (at?.kind === SyntaxKind.CallExpression) {
    const callee = at.expression?.getText() ?? '';
    return SERVICE_FACTORY.test(callee) ? callee : '';
  }
  return at?.kind === SyntaxKind.Identifier ? (at.getText() ?? '') : '';
}

/**
 * Is this call a DURABLE WRITE — a change to domain state?
 *
 * Two forms, both keyed on the receiver rather than the verb:
 *   • `services.store.thing(...)` — a member call whose root binding holds a
 *     service, whose final segment is not a read;
 *   • `storeInvariantsConfigValue(store, …)` — a free function HANDED a service
 *     or a store, which is the only way a route file can reach domain state
 *     without naming it. `/config` did exactly this and the gate never saw it.
 */
function isDurableWrite(call: Syntax, services: ReadonlySet<string>): boolean {
  const callee = calleeText(call);
  if (callee === '') return false;
  if (AUDIT_CALLS.some((pattern) => pattern.test(callee))) return false;
  if (EPHEMERAL_RECEIVERS.test(callee)) return false;
  if (isRouteRegistration(call)) return false;
  if (UNIT_CALLS.test(callee)) return false;
  const segments = callee.split('.');
  const last = segments[segments.length - 1] ?? '';
  if (segments.length > 1) {
    const root = rootIdentifier(call.expression);
    if (!services.has(root) && !SERVICE_FACTORY.test(root)) return false;
    // `services.now()` is the clock, not a store.
    if (segments.length === 2 && NON_STORE_MEMBERS.test(last)) return false;
    if (segments.some((segment) => NON_STORE_MEMBERS.test(segment))) return false;
    return !READ_METHODS.test(last) && !READ_EXCEPTIONS.has(last);
  }
  // A bare call: NAMED as a writer (see FREE_WRITE_FUNCTIONS) and handed a
  // service or store, so ordinary projections and local helpers stay out.
  if (!FREE_WRITE_FUNCTIONS.test(last)) return false;
  const first = call.arguments?.[0];
  if (first === undefined) return false;
  // A service VALUE, not a reference to the factory that makes one:
  // `authMiddleware(resolveIdentity)` hands over the function itself.
  if (first.kind === SyntaxKind.CallExpression) {
    return SERVICE_FACTORY.test(rootIdentifier(first.expression));
  }
  return services.has(rootIdentifier(first));
}

/** Every function-ish node in a source, by declared name. */
function namedFunctions(root: Syntax): Map<string, Syntax> {
  const byName = new Map<string, Syntax>();
  for (const node of walk(root)) {
    if (node.kind === SyntaxKind.FunctionDeclaration) {
      const name = node.name?.getText();
      if (name !== undefined) byName.set(name, node);
    }
  }
  return byName;
}

/**
 * Is `node` inside a callback HANDED TO one of `helpers`?
 *
 * This is the sanctioned fix for the seam below, not an exception to it: the
 * caller cannot open the helper's unit, so it passes the write in and the helper
 * runs it on the unit's own handle — `finishMfa(services, …, (tx) =>
 * tx.store.consumeRecoveryCode(…))`, the same shape as passing a transactor's
 * stores to a moderation helper. Lexically the write sits under `finishMfa`
 * rather than under `transact`, so without this the gate would flag exactly the
 * code it exists to ask for.
 */
function insideCallbackTo(node: Syntax, helpers: ReadonlySet<string>): boolean {
  for (let at = node.parent; at !== undefined; at = at.parent) {
    if (at.kind !== SyntaxKind.ArrowFunction && at.kind !== SyntaxKind.FunctionExpression) continue;
    const call = at.parent;
    if (call?.kind === SyntaxKind.CallExpression && helpers.has(calleeText(call))) return true;
  }
  return false;
}

/** Does this function open a unit AND append an audit row inside it? */
function auditsInsideItsOwnUnit(fn: Syntax): boolean {
  for (const node of walk(fn)) {
    if (node.kind !== SyntaxKind.CallExpression) continue;
    if (!AUDIT_CALLS.some((pattern) => pattern.test(calleeText(node)))) continue;
    if (insideUnit(node)) return true;
  }
  return false;
}

export function runAuditedWriteGate(files: Map<string, string>): string[] {
  const findings = withParsedSources(
    [...files].map(([path, content]) => ({ path, content })),
    (parsed) => {
      const out: Finding[] = [];
      for (const source of parsed) {
        const newlines = newlineIndex(source.content);
        // THE RULE: in a handler that records, EVERY durable write is inside the
        // unit that records.
        //
        // Three shapes of the same defect, and only the first was ever asked
        // about. (1) The append itself sits outside a unit. (2) The append is
        // inside a unit the handler opens, but a write ran BEFORE that unit — so
        // the audit rolls back and the change does not, which is how `POST
        // /rooms` could leave a durable room and steward with no record and no
        // creator subscription, answering 500 and then `duplicate_room` on
        // retry. (3) The unit is one call away in a helper, which is how
        // `/mfa/totp/verify` burned a single-use recovery code with a `setAuth`
        // before `finishMfa` recorded the verification.
        //
        // So the question is asked of the WRITE rather than of the append: this
        // handler records something, and here is a durable change of its that no
        // unit covers.
        const services = serviceBindings(source.root);
        const helpers = namedFunctions(source.root);
        const auditingHelpers = new Set(
          [...helpers].filter(([, fn]) => auditsInsideItsOwnUnit(fn)).map(([name]) => name),
        );
        /** Does this function record — directly, or through a helper that does? */
        const records = (fn: Syntax): boolean => {
          for (const inner of walk(fn)) {
            if (inner.kind !== SyntaxKind.CallExpression) continue;
            const callee = calleeText(inner);
            if (AUDIT_CALLS.some((pattern) => pattern.test(callee))) return true;
            if (auditingHelpers.has(callee)) return true;
          }
          return false;
        };
        for (const write of walk(source.root)) {
          if (write.kind !== SyntaxKind.CallExpression) continue;
          if (!isDurableWrite(write, services)) continue;
          if (onExitPathWithoutRecord(write, auditingHelpers)) continue;
          if (insideUnit(write)) continue;
          // Handed INTO a helper's unit — the fix, not the defect.
          if (insideCallbackTo(write, auditingHelpers)) continue;
          // The INNERMOST enclosing function owns the write: attributing it to
          // every ancestor would report one defect once per nesting level.
          const fn = enclosingFunction(write);
          if (fn === undefined) continue;
          // A helper's own body is judged where it is CALLED, not here — else
          // every correct transactor flags itself for the writes inside its unit.
          if (auditingHelpers.has(fn.name?.getText() ?? '')) continue;
          if (!records(fn)) continue;
          out.push({
            file: source.path,
            line: lineAt(newlines, write.getStart()),
            detail: handlerLabel(fn),
          });
        }
      }
      return out;
    },
  );

  const issues: string[] = [];
  // One line, one finding: a write reachable through two walks is still one
  // defect, and a duplicated line reads as two sites to fix.
  const seen = new Set<string>();
  for (const finding of findings) {
    const key = `${finding.file}:${finding.line}`;
    if (seen.has(key)) continue;
    seen.add(key);
    issues.push(
      `${finding.file}:${finding.line} handler '${finding.detail}' appends an audit row and ` +
        'performs a durable write outside a unit of work — an append failure would leave the ' +
        'change with no record. Run both through the domain unit: `services.transact(…)` ' +
        '(WS-D identity, WS-F ingestion, WS-G/Q forum, WS-H invariants) or `transactor.run(…)` ' +
        '(WS-J moderation, WS-N compliance).',
    );
  }
  return issues;
}

export function collectRouteFiles(): Map<string, string> {
  const files = new Map<string, string>();
  for (const entry of readdirSync(ROUTES_DIR, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.ts')) continue;
    if (entry.name.endsWith('.test.ts')) continue;
    files.set(entry.name, readFileSync(join(ROUTES_DIR, entry.name), 'utf-8'));
  }
  if (files.size < 10) {
    throw new Error(
      `check-audited-writes: found only ${files.size} route files — the tree moved; update ROUTES_DIR.`,
    );
  }
  return files;
}

function main(): void {
  const issues = runAuditedWriteGate(collectRouteFiles());
  if (issues.length > 0) {
    console.error('Audited-write gate FAILED — a state change can outlive its record:');
    for (const issue of issues) console.error(`  - ${issue}`);
    process.exit(1);
  }
  console.log(
    'Audited-write gate passed: every route handler that appends an audit row commits it in ' +
      'the same unit as the change it accounts for.',
  );
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  main();
}

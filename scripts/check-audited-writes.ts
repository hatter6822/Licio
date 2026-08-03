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
/** Calls that change durable state. `.append` is excluded — that IS the audit.
 *
 *  `consume` earns its place the hard way: spending a single-use credential is
 *  as durable as any insert and rather less recoverable, and the verb was
 *  missing while `/mfa/totp/verify` burned a recovery code outside the unit
 *  that recorded the verification. */
const WRITE_CALLS =
  /\.(insert|insertIfNoneOpen|update|updateUser|upsert|create|createWithThread|remove|delete|purge|consume|credit|rebaseline|setAuth|applyAction|apply|delist|claim|reassign)[A-Za-z]*$/;
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
const EPHEMERAL_RECEIVERS = /\.(otp|challenges|policyCache|cache|metrics)\./;

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
          const callee = calleeText(write);
          if (!WRITE_CALLS.test(callee)) continue;
          if (EPHEMERAL_RECEIVERS.test(callee)) continue;
          if (isRouteRegistration(write)) continue;
          if (onExitPathWithoutRecord(write, auditingHelpers)) continue;
          // The audit is not the write it accounts for.
          if (AUDIT_CALLS.some((pattern) => pattern.test(callee))) continue;
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

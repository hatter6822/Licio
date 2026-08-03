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
// WHAT IT DOES NOT CLAIM.  Lexical containment is the test, so a handler that
// calls a helper which opens the unit reads as a violation here — the fix is to
// pass the unit's stores, which is what the moderation call sites do.  And a
// write with no audit at all is a different question this gate does not ask.
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

/** Calls that append to an audit trail. */
const AUDIT_CALLS = [/\baudit\.append$/, /^writeAudit$/, /\bauditChain\b/];
/** Calls that change durable state. `.append` is excluded — that IS the audit. */
const WRITE_CALLS =
  /\.(insert|insertIfNoneOpen|update|updateUser|upsert|create|createWithThread|remove|delete|purge|credit|rebaseline|setAuth|applyAction|apply|delist|claim|reassign)[A-Za-z]*$/;
/** Opening a unit of work. */
const UNIT_CALLS = /(\.transactor\.run|\.transact|\.runInUnit)$/;

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

export function runAuditedWriteGate(files: Map<string, string>): string[] {
  const findings = withParsedSources(
    [...files].map(([path, content]) => ({ path, content })),
    (parsed) => {
      const out: Finding[] = [];
      for (const source of parsed) {
        const newlines = newlineIndex(source.content);
        for (const node of walk(source.root)) {
          if (node.kind !== SyntaxKind.CallExpression) continue;
          const callee = calleeText(node);
          if (!AUDIT_CALLS.some((pattern) => pattern.test(callee))) continue;
          if (insideUnit(node)) continue;
          const fn = enclosingFunction(node);
          if (fn === undefined) continue;
          // …and the same function performs a durable write. An audit-only
          // handler (a read that records that it happened) is not this defect.
          let writes = false;
          for (const inner of walk(fn)) {
            if (inner.kind !== SyntaxKind.CallExpression) continue;
            const innerCallee = calleeText(inner);
            if (AUDIT_CALLS.some((pattern) => pattern.test(innerCallee))) continue;
            if (WRITE_CALLS.test(innerCallee)) {
              writes = true;
              break;
            }
          }
          if (!writes) continue;
          out.push({
            file: source.path,
            line: lineAt(newlines, node.getStart()),
            detail: handlerLabel(fn),
          });
        }
      }
      return out;
    },
  );

  const issues: string[] = [];
  for (const finding of findings) {
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

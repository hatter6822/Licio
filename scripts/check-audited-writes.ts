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
// (`…transactor.run(…)` / `…transact(…)`).  An allowlisted site needs a written
// reason; a stale allowlist entry is itself an error, so an entry cannot outlive
// the code it excuses.
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

/**
 * Sites where the change and its record are deliberately NOT one unit.
 *
 * Every entry carries a reason a reviewer can weigh, and the closure target for
 * the ones that are debt rather than design lives in
 * `docs/planning/audit-residuals-2026-07.md`.
 */
export const AUDITED_WRITE_ALLOWLIST: Array<{ file: string; handler: string; reason: string }> = [
  {
    file: 'auth-credentials.ts',
    handler: '/credentials/wallet/:credentialId',
    reason:
      'WS-D identity has no unit of work yet, and these handlers pair SEVERAL store writes with the audit — binding only the audit would advertise a guarantee the handler still does not have. Closing it means an identity transactor. Tracked in docs/planning/audit-residuals-2026-07.md (one PR per domain seam)',
  },
  {
    file: 'auth-credentials.ts',
    handler: '/credentials/webauthn/:credentialId',
    reason:
      'WS-D identity has no unit of work yet, and these handlers pair SEVERAL store writes with the audit — binding only the audit would advertise a guarantee the handler still does not have. Closing it means an identity transactor. Tracked in docs/planning/audit-residuals-2026-07.md (one PR per domain seam)',
  },
  {
    file: 'auth-credentials.ts',
    handler: '/email/disable',
    reason:
      'WS-D identity has no unit of work yet, and these handlers pair SEVERAL store writes with the audit — binding only the audit would advertise a guarantee the handler still does not have. Closing it means an identity transactor. Tracked in docs/planning/audit-residuals-2026-07.md (one PR per domain seam)',
  },
  {
    file: 'auth-mfa.ts',
    handler: '(unnamed handler)',
    reason:
      'WS-D identity has no unit of work yet, and these handlers pair SEVERAL store writes with the audit — binding only the audit would advertise a guarantee the handler still does not have. Closing it means an identity transactor. Tracked in docs/planning/audit-residuals-2026-07.md (one PR per domain seam)',
  },
  {
    file: 'auth-mfa.ts',
    handler: '/mfa/totp/confirm',
    reason:
      'WS-D identity has no unit of work yet, and these handlers pair SEVERAL store writes with the audit — binding only the audit would advertise a guarantee the handler still does not have. Closing it means an identity transactor. Tracked in docs/planning/audit-residuals-2026-07.md (one PR per domain seam)',
  },
  {
    file: 'auth-mfa.ts',
    handler: '/mfa/totp/disable',
    reason:
      'WS-D identity has no unit of work yet, and these handlers pair SEVERAL store writes with the audit — binding only the audit would advertise a guarantee the handler still does not have. Closing it means an identity transactor. Tracked in docs/planning/audit-residuals-2026-07.md (one PR per domain seam)',
  },
  {
    file: 'auth-mfa.ts',
    handler: '/mfa/totp/verify',
    reason:
      'WS-D identity has no unit of work yet, and these handlers pair SEVERAL store writes with the audit — binding only the audit would advertise a guarantee the handler still does not have. Closing it means an identity transactor. Tracked in docs/planning/audit-residuals-2026-07.md (one PR per domain seam)',
  },
  {
    file: 'auth-register.ts',
    handler: '/dev/verify',
    reason:
      'WS-D identity has no unit of work yet, and these handlers pair SEVERAL store writes with the audit — binding only the audit would advertise a guarantee the handler still does not have. Closing it means an identity transactor. Tracked in docs/planning/audit-residuals-2026-07.md (one PR per domain seam)',
  },
  {
    file: 'auth-register.ts',
    handler: '/email/verify',
    reason:
      'WS-D identity has no unit of work yet, and these handlers pair SEVERAL store writes with the audit — binding only the audit would advertise a guarantee the handler still does not have. Closing it means an identity transactor. Tracked in docs/planning/audit-residuals-2026-07.md (one PR per domain seam)',
  },
  {
    file: 'auth-register.ts',
    handler: '/webauthn/signup/verify',
    reason:
      'WS-D identity has no unit of work yet, and these handlers pair SEVERAL store writes with the audit — binding only the audit would advertise a guarantee the handler still does not have. Closing it means an identity transactor. Tracked in docs/planning/audit-residuals-2026-07.md (one PR per domain seam)',
  },
  {
    file: 'auth.ts',
    handler: '/sessions/:ref',
    reason:
      'WS-D identity has no unit of work yet, and these handlers pair SEVERAL store writes with the audit — binding only the audit would advertise a guarantee the handler still does not have. Closing it means an identity transactor. Tracked in docs/planning/audit-residuals-2026-07.md (one PR per domain seam)',
  },
  {
    file: 'auth.ts',
    handler: '/wallet/verify',
    reason:
      'WS-D identity has no unit of work yet, and these handlers pair SEVERAL store writes with the audit — binding only the audit would advertise a guarantee the handler still does not have. Closing it means an identity transactor. Tracked in docs/planning/audit-residuals-2026-07.md (one PR per domain seam)',
  },
  {
    file: 'compliance.ts',
    handler: '/admin/declarations/:userId/verify',
    reason:
      'WS-N compliance keeps its OWN hash-chained trail beside the WS-D audit, so the pairing spans two chains and needs a compliance transactor. Tracked in docs/planning/audit-residuals-2026-07.md (one PR per domain seam)',
  },
  {
    file: 'compliance.ts',
    handler: '/admin/kyc/:userId',
    reason:
      'WS-N compliance keeps its OWN hash-chained trail beside the WS-D audit, so the pairing spans two chains and needs a compliance transactor. Tracked in docs/planning/audit-residuals-2026-07.md (one PR per domain seam)',
  },
  {
    file: 'compliance.ts',
    handler: '/admin/policies',
    reason:
      'WS-N compliance keeps its OWN hash-chained trail beside the WS-D audit, so the pairing spans two chains and needs a compliance transactor. Tracked in docs/planning/audit-residuals-2026-07.md (one PR per domain seam)',
  },
  {
    file: 'compliance.ts',
    handler: '/region/declaration',
    reason:
      'WS-N compliance keeps its OWN hash-chained trail beside the WS-D audit, so the pairing spans two chains and needs a compliance transactor. Tracked in docs/planning/audit-residuals-2026-07.md (one PR per domain seam)',
  },
  {
    file: 'forum.ts',
    handler: '/feed/preferences',
    reason:
      'WS-G forum has a transactor for CONTRIBUTIONS but none for preference state. Tracked in docs/planning/audit-residuals-2026-07.md (one PR per domain seam)',
  },
  {
    file: 'ingestion-admin.ts',
    handler: '/embeddings/cleanup',
    reason:
      'WS-F ingestion has no unit of work yet; these are operator actions on source/syndication/takedown state. Tracked in docs/planning/audit-residuals-2026-07.md (one PR per domain seam)',
  },
  {
    file: 'ingestion-admin.ts',
    handler: '/sources/:sourceId',
    reason:
      'WS-F ingestion has no unit of work yet; these are operator actions on source/syndication/takedown state. Tracked in docs/planning/audit-residuals-2026-07.md (one PR per domain seam)',
  },
  {
    file: 'ingestion-admin.ts',
    handler: '/syndications',
    reason:
      'WS-F ingestion has no unit of work yet; these are operator actions on source/syndication/takedown state. Tracked in docs/planning/audit-residuals-2026-07.md (one PR per domain seam)',
  },
  {
    file: 'ingestion-admin.ts',
    handler: '/takedowns/:takedownId/action',
    reason:
      'WS-F ingestion has no unit of work yet; these are operator actions on source/syndication/takedown state. Tracked in docs/planning/audit-residuals-2026-07.md (one PR per domain seam)',
  },
  {
    file: 'invariants-admin.ts',
    handler: '/promotions',
    reason:
      'the promotion write happens inside promotionService.apply, which owns the regression gate and the observed-evidence reads; binding it to a unit handle needs that service to accept a store per call. Tracked in docs/planning/audit-residuals-2026-07.md (one PR per domain seam)',
  },
  {
    file: 'privacy.ts',
    handler: '/attention/delete',
    reason:
      'WS-D identity has no unit of work yet, and these handlers pair SEVERAL store writes with the audit — binding only the audit would advertise a guarantee the handler still does not have. Closing it means an identity transactor. Tracked in docs/planning/audit-residuals-2026-07.md (one PR per domain seam)',
  },
  {
    file: 'privacy.ts',
    handler: '/delete-account',
    reason:
      'WS-D identity has no unit of work yet, and these handlers pair SEVERAL store writes with the audit — binding only the audit would advertise a guarantee the handler still does not have. Closing it means an identity transactor. Tracked in docs/planning/audit-residuals-2026-07.md (one PR per domain seam)',
  },
  {
    file: 'privacy.ts',
    handler: '/delete-account/cancel',
    reason:
      'WS-D identity has no unit of work yet, and these handlers pair SEVERAL store writes with the audit — binding only the audit would advertise a guarantee the handler still does not have. Closing it means an identity transactor. Tracked in docs/planning/audit-residuals-2026-07.md (one PR per domain seam)',
  },
  {
    file: 'privacy.ts',
    handler: '/export',
    reason:
      'WS-D identity has no unit of work yet, and these handlers pair SEVERAL store writes with the audit — binding only the audit would advertise a guarantee the handler still does not have. Closing it means an identity transactor. Tracked in docs/planning/audit-residuals-2026-07.md (one PR per domain seam)',
  },
  {
    file: 'privacy.ts',
    handler: '/settings',
    reason:
      'WS-D identity has no unit of work yet, and these handlers pair SEVERAL store writes with the audit — binding only the audit would advertise a guarantee the handler still does not have. Closing it means an identity transactor. Tracked in docs/planning/audit-residuals-2026-07.md (one PR per domain seam)',
  },
  {
    file: 'rooms.ts',
    handler: '/rooms',
    reason:
      'WS-Q room lifecycle has no unit of work yet. Tracked in docs/planning/audit-residuals-2026-07.md (one PR per domain seam)',
  },
  {
    file: 'rooms.ts',
    handler: '/rooms/:roomId/join-requests/:requestId',
    reason:
      'WS-Q room lifecycle has no unit of work yet. Tracked in docs/planning/audit-residuals-2026-07.md (one PR per domain seam)',
  },
];

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

export function runAuditedWriteGate(
  files: Map<string, string>,
  allowlist: typeof AUDITED_WRITE_ALLOWLIST = AUDITED_WRITE_ALLOWLIST,
): string[] {
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
  const matched = new Set<string>();
  for (const finding of findings) {
    // EXACT, not a prefix: `/delete-account` would otherwise excuse
    // `/delete-account/cancel`, and an entry that silently covers a handler
    // nobody weighed is the opposite of what an allowlist is for.
    const excuse = allowlist.find(
      (entry) => entry.file === finding.file && entry.handler === finding.detail,
    );
    if (excuse) {
      matched.add(`${excuse.file}::${excuse.handler}`);
      continue;
    }
    issues.push(
      `${finding.file}:${finding.line} handler '${finding.detail}' appends an audit row and ` +
        'performs a durable write outside a unit of work — an append failure would leave the ' +
        'change with no record. Run both through the domain transactor (`services.transact(…)` / ' +
        '`transactor.run(…)`), or allowlist it in scripts/check-audited-writes.ts with a reason.',
    );
  }
  for (const entry of allowlist) {
    if (!matched.has(`${entry.file}::${entry.handler}`)) {
      issues.push(
        `stale AUDITED_WRITE_ALLOWLIST entry '${entry.file}::${entry.handler}': it no longer ` +
          'matches any handler — delete it, so the list keeps describing the code.',
      );
    }
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
      'the same unit as the change it accounts for (allowlisted exceptions carry reasons).',
  );
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  main();
}

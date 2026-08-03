// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Unit coverage for the audited-write gate.
//
// The gate has no allowlist, so the LIVE-tree case at the bottom is the whole
// guarantee: it is what keeps the 29 converted handlers converted.  A gate whose
// only test is on fixtures proves the regex works, not that the tree obeys it.
import { describe, expect, it } from 'vitest';
import { collectRouteFiles, runAuditedWriteGate } from './check-audited-writes.js';

/** Act, then audit: the write lands, the append fails, the record never exists. */
const actThenAudit = `
export function createRoutes() {
  return new Hono().post('/things/:id/freeze', async (c) => {
    await services.store.updateThing(c.req.param('id'), { frozen: true });
    await services.audit.append({ eventType: 'thing_frozen' });
    return c.json({ ok: true });
  });
}
`;

/** The same handler with both inside one unit. */
const inUnit = `
export function createRoutes() {
  return new Hono().post('/things/:id/freeze', async (c) => {
    await services.transact(async (tx) => {
      await tx.store.updateThing(c.req.param('id'), { frozen: true });
      await tx.audit({ eventType: 'thing_frozen' });
    });
    return c.json({ ok: true });
  });
}
`;

/** A read that records that it happened — no durable change to lose. */
const auditOnly = `
export function createRoutes() {
  return new Hono().get('/things/:id/export', async (c) => {
    const rows = await services.store.listThings();
    await services.audit.append({ eventType: 'export_read' });
    return c.json({ rows });
  });
}
`;

/** The moderation spelling of a unit, and the free-function audit writer. */
const moderationShape = `
export function createRoutes() {
  return new Hono().post('/reports/:id/resolve', async (c) => {
    await moderation.transactor.run(async (tx) => {
      await tx.reports.applyAction(c.req.param('id'), 'resolved');
      await writeAudit(tx, { eventType: 'report_resolved' });
    });
    return c.json({ ok: true });
  });
}
`;

/** A helper that opens the unit does NOT discharge the handler's obligation:
 *  lexical containment is the test, and the handler still writes outside it. */
const unitInsideHelper = `
async function record(id: string) {
  await services.transact(async (tx) => tx.audit({ eventType: 'thing_frozen' }));
}
export function createRoutes() {
  return new Hono().post('/things/:id/freeze', async (c) => {
    await services.store.updateThing(c.req.param('id'), { frozen: true });
    await services.audit.append({ eventType: 'thing_frozen' });
    return c.json({ ok: true });
  });
}
`;

describe('check:audited-writes', () => {
  it('flags a handler whose write and audit are separate moments', () => {
    const issues = runAuditedWriteGate(new Map([['things.ts', actThenAudit]]));
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain("handler '/things/:id/freeze'");
    expect(issues[0]).toContain('outside a unit of work');
  });

  it('accepts the same handler once both run in one unit', () => {
    expect(runAuditedWriteGate(new Map([['things.ts', inUnit]]))).toEqual([]);
  });

  it('accepts the moderation spelling (transactor.run + writeAudit)', () => {
    expect(runAuditedWriteGate(new Map([['reports.ts', moderationShape]]))).toEqual([]);
  });

  it('does NOT flag an audit-only handler — there is no change to lose', () => {
    expect(runAuditedWriteGate(new Map([['things.ts', auditOnly]]))).toEqual([]);
  });

  it('still flags when a HELPER opens the unit — containment is the test', () => {
    const issues = runAuditedWriteGate(new Map([['things.ts', unitInsideHelper]]));
    expect(issues).toHaveLength(1);
  });

  it('points at the unguarded WRITE, which is the line to fix', () => {
    // Not the append: the append is where the defect becomes visible, the write
    // is where it is. `actThenAudit` writes on line 4 and audits on line 5, and
    // a reviewer opening line 5 sees a correct-looking audit call.
    const issues = runAuditedWriteGate(new Map([['things.ts', actThenAudit]]));
    expect(issues[0]).toMatch(/^things\.ts:4 /);
  });

  it('flags a write whose UNIT IS ONE CALL AWAY, in a same-file helper', () => {
    // The shape that reads as two innocent halves and cost a user their last
    // recovery code: the handler spends the credential, the helper opens the
    // unit and records the verification, and an append failure burns the one
    // without the other.
    const seam = `
async function finish(services, userId) {
  await services.transact(async (tx) => {
    await tx.audit.append({ actorUserId: userId, eventType: 'mfa_verify' });
    await markVerified(services.sessions);
  });
}
export function createRoutes() {
  return new Hono().post('/mfa/totp/verify', async (c) => {
    await services.store.setAuth(userId, { recoveryCodeHashes: remaining });
    await finish(services, userId);
    return c.json({ ok: true });
  });
}
`;
    const issues = runAuditedWriteGate(new Map([['auth-mfa.ts', seam]]));
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain("handler '/mfa/totp/verify'");
  });

  it('accepts the write HANDED INTO that helper’s unit', () => {
    // The fix the gate is asking for — the caller cannot open the helper's unit,
    // so it passes the write in and the helper runs it on the unit's handle.
    const handedIn = `
async function finish(services, userId, consume) {
  return services.transact(async (tx) => {
    const spent = await consume(tx);
    await tx.audit.append({ actorUserId: userId, eventType: 'mfa_verify' });
    return spent;
  });
}
export function createRoutes() {
  return new Hono().post('/mfa/totp/verify', async (c) => {
    const spent = await finish(services, userId, (tx) =>
      tx.store.consumeRecoveryCode(userId, matched),
    );
    return c.json({ spent });
  });
}
`;
    expect(runAuditedWriteGate(new Map([['auth-mfa.ts', handedIn]]))).toEqual([]);
  });

  it('does not flag the auditing HELPER for its own in-unit writes', () => {
    // The helper writes inside the unit it opened; judging it as its own caller
    // would flag every correct transactor in the tree.
    const helperOnly = `
async function finish(services, userId) {
  await services.transact(async (tx) => {
    await tx.store.setAuth(userId, { mfaPending: false });
    await tx.audit.append({ actorUserId: userId, eventType: 'mfa_verify' });
  });
}
export function createRoutes() {
  return new Hono().post('/mfa/totp/verify', async (c) => finish(services, userId));
}
`;
    expect(runAuditedWriteGate(new Map([['auth-mfa.ts', helperOnly]]))).toEqual([]);
  });

  it('counts spending a single-use credential as a durable write', () => {
    const consumed = `
export function createRoutes() {
  return new Hono().post('/mfa/totp/verify', async (c) => {
    await services.store.consumeRecoveryCode(userId, hash);
    await services.audit.append({ actorUserId: userId, eventType: 'mfa_verify' });
    return c.json({ ok: true });
  });
}
`;
    expect(runAuditedWriteGate(new Map([['auth-mfa.ts', consumed]]))).toHaveLength(1);
  });

  it('passes the LIVE route tree — no handler writes outside its unit', () => {
    expect(runAuditedWriteGate(collectRouteFiles())).toEqual([]);
  });
});

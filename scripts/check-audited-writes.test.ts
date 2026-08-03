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

  it('reports the file and line a reviewer can open', () => {
    const issues = runAuditedWriteGate(new Map([['things.ts', actThenAudit]]));
    expect(issues[0]).toMatch(/^things\.ts:5 /);
  });

  it('passes the LIVE route tree — no handler writes outside its unit', () => {
    expect(runAuditedWriteGate(collectRouteFiles())).toEqual([]);
  });
});

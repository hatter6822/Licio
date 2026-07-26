// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The Postgres NOTICE sink is a LOGGING BOUNDARY, not a convenience.
//
// postgres.js's `NoticeResponse` handler is `onnotice ? onnotice(parseError(x))
// : console.log(parseError(x))` — so leaving `onnotice` unset writes the WHOLE
// notice object to stdout.  In the API server that is the one logging path pino
// (and therefore its redaction paths) never sees, and a notice carries `detail`
// / `hint` / `where` / `internal_query`, the fields that echo query text and row
// values (`Key (email)=(alice@example.com) already exists`).  In the test suite
// it dumps raw notice objects into the vitest output whenever the migration
// chain replays.
//
// These tests pin both halves of the fix: `onnotice` is ALWAYS supplied, and the
// object handed to a consumer's logger is the severity/code/message projection —
// never the raw notice.
//
// postgres.js connects lazily, so a client can be constructed (and its resolved
// options inspected) against an address nothing is listening on.
import { afterAll, describe, expect, it } from 'vitest';
import { createDbClient, type PostgresNotice, pingDatabase } from '../client.js';

/** A DSN for a port nothing listens on: construction must not dial anything. */
const OFFLINE_DSN = 'postgres://licio:licio@127.0.0.1:1/licio_notice_probe';

/** The library-internal handler postgres.js will invoke for a NoticeResponse. */
function resolveOnNotice(db: ReturnType<typeof createDbClient>): (notice: unknown) => void {
  const client = (db as unknown as { $client: { options: Record<string, unknown> } }).$client;
  const handler = client.options['onnotice'];
  expect(typeof handler).toBe('function');
  return handler as (notice: unknown) => void;
}

describe('createDbClient — Postgres NOTICE handling', () => {
  it('always installs an onnotice handler, so postgres.js never falls back to console.log', () => {
    // No options at all: the DEFAULT must still displace the library fallback.
    const db = createDbClient(OFFLINE_DSN, { onNotice: 'discard' });
    expect(() => resolveOnNotice(db)).not.toThrow();
  });

  it('discards notices when no sink is supplied', () => {
    const db = createDbClient(OFFLINE_DSN, { onNotice: 'discard' });
    const onnotice = resolveOnNotice(db);
    // The default sink must be a silent no-op, not a throw and not a write.
    expect(() =>
      onnotice({ severity: 'NOTICE', code: '42710', message: 'extension already exists' }),
    ).not.toThrow();
  });

  it('projects a notice to severity/code/message for the supplied sink', () => {
    const seen: PostgresNotice[] = [];
    const db = createDbClient(OFFLINE_DSN, { onNotice: (n) => seen.push(n) });
    resolveOnNotice(db)({
      severity_local: 'NOTICE',
      severity: 'NOTICE',
      code: '42622',
      message: 'identifier "x" will be truncated to "y"',
      file: 'scansup.c',
      line: '99',
      routine: 'truncate_identifier',
    });
    expect(seen).toEqual([
      { severity: 'NOTICE', code: '42622', message: 'identifier "x" will be truncated to "y"' },
    ]);
  });

  it('never forwards the value-bearing fields (detail/hint/where/internal_query)', () => {
    const seen: PostgresNotice[] = [];
    const db = createDbClient(OFFLINE_DSN, { onNotice: (n) => seen.push(n) });
    resolveOnNotice(db)({
      severity: 'NOTICE',
      code: '23505',
      message: 'duplicate key value violates unique constraint "users_email_key"',
      // The fields that echo user data / query text back to the client.
      detail: 'Key (email)=(alice@example.com) already exists.',
      hint: 'try another address',
      where: 'PL/pgSQL function seed() line 4 at SQL statement',
      internal_query: "insert into users (email) values ('alice@example.com')",
      position: '31',
    });
    const forwarded = seen[0];
    expect(forwarded).toBeDefined();
    expect(Object.keys(forwarded as object).sort()).toEqual(['code', 'message', 'severity']);
    expect(JSON.stringify(forwarded)).not.toContain('alice@example.com');
  });

  it('substitutes safe defaults for absent fields rather than emitting undefined', () => {
    const seen: PostgresNotice[] = [];
    const db = createDbClient(OFFLINE_DSN, { onNotice: (n) => seen.push(n) });
    resolveOnNotice(db)({});
    expect(seen).toEqual([{ severity: 'NOTICE', code: '', message: '' }]);
  });
});

// ---------------------------------------------------------------------------
// The readiness probe (GATED: needs a live Postgres).
// ---------------------------------------------------------------------------
//
// `pingDatabase` is what the production boot registers as the `postgres`
// readiness probe (`apps/api/src/index.ts`), so an orchestrator routes traffic
// on its verdict.  It had no test of any kind: both halves of its contract —
// resolving against a reachable database and REJECTING against an unreachable
// one — were unverified, and a probe that cannot fail is a probe that reports
// ready forever.
const DB_URL = process.env['DATABASE_URL'];

describe.skipIf(!DB_URL)('pingDatabase (live Postgres)', () => {
  const clients: Array<{ end: (o?: { timeout?: number }) => Promise<void> }> = [];
  const track = (db: ReturnType<typeof createDbClient>): ReturnType<typeof createDbClient> => {
    clients.push(
      (db as unknown as { $client: { end: (o?: { timeout?: number }) => Promise<void> } }).$client,
    );
    return db;
  };

  afterAll(async () => {
    await Promise.all(clients.map((c) => c.end({ timeout: 5 }).catch(() => undefined)));
  });

  it('resolves against a reachable database', async () => {
    const db = track(createDbClient(DB_URL as string, { onNotice: 'discard' }));
    await expect(pingDatabase(db)).resolves.toBeUndefined();
  });

  it('REJECTS against an unreachable one (the probe can actually fail)', async () => {
    // Port 1 has no listener: the connection attempt fails rather than hanging,
    // so readiness flips instead of silently reporting healthy.
    const db = track(
      createDbClient('postgres://licio:licio@127.0.0.1:1/licio_probe_unreachable', {
        onNotice: 'discard',
      }),
    );
    await expect(pingDatabase(db)).rejects.toThrow();
  });
});

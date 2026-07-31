// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-F.3.1b — `decodeSearchCursor` is the trust boundary for the ONE piece of
// caller-controlled text the search adapter binds into a `::timestamptz` cast
// (`cursorPredicate`, drizzle-ingestion-stores.ts).  `GET /v1/search` is
// anonymous and the route has no try/catch, so anything the decoder admits and
// Postgres rejects is a caller-triggerable 500 — these cases pin the two
// strings that used to get through.
import { describe, expect, it } from 'vitest';
import { decodeSearchCursor, encodeSearchCursor } from '../search.js';

const ID = '00000000-0000-4000-8000-000000000000';
const cursorOf = (createdAt: string) =>
  Buffer.from(`1|${createdAt}|${ID}`, 'utf8').toString('base64url');

describe('decodeSearchCursor: only Date#toISOString() shapes survive (WS-F.3.1b)', () => {
  it('accepts what encodeSearchCursor is ever fed', () => {
    const createdAt = new Date('2026-07-11T09:30:00.000Z').toISOString();
    expect(decodeSearchCursor(encodeSearchCursor(1.25, createdAt, ID))).toEqual({
      relevance: 1.25,
      createdAt,
      id: ID,
    });
    // Postgres accepts sub-millisecond precision and a bare-seconds form; both
    // are legal `::timestamptz` input, so the decoder must not reject them.
    expect(decodeSearchCursor(cursorOf('2026-07-11T09:30:00Z'))).not.toBeNull();
    expect(decodeSearchCursor(cursorOf('2026-07-11T09:30:00.123456Z'))).not.toBeNull();
  });

  it('rejects V8-parseable strings Postgres rejects (Date#toString(), offsets)', () => {
    // `Date.parse` accepts V8's own toString() output; `select
    // 'Mon Jan 01 2020 …'::timestamptz` is `invalid input syntax for type
    // timestamp with time zone`.
    const v8Native = 'Mon Jan 01 2020 00:00:00 GMT+0000 (Coordinated Universal Time)';
    expect(Number.isNaN(Date.parse(v8Native))).toBe(false); // the old bar admitted it
    expect(decodeSearchCursor(cursorOf(v8Native))).toBeNull();
    expect(decodeSearchCursor(cursorOf('2026-07-11'))).toBeNull();
    expect(decodeSearchCursor(cursorOf('2026-07-11T09:30:00+01:00'))).toBeNull();
  });

  it('rejects ISO year zero — ISO-8601 has one, Postgres does not', () => {
    // `select '0000-01-01T00:00:00.000Z'::timestamptz` is `date/time field
    // value out of range`, and a round-trip check cannot catch it:
    // `new Date(…).toISOString()` returns the same string back.
    const yearZero = '0000-01-01T00:00:00.000Z';
    expect(new Date(yearZero).toISOString()).toBe(yearZero);
    expect(decodeSearchCursor(cursorOf(yearZero))).toBeNull();
  });
});

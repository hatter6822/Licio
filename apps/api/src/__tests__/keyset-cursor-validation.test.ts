// SPDX-License-Identifier: AGPL-3.0-or-later
//
// A MALFORMED CURSOR RESTARTS THE PAGE.  IT DOES NOT 500.
//
// `?cursor=` is a client-supplied string, and its two parts go into a store that casts
// them `::timestamptz` and `::uuid`.  Three of the five queues that page this way checked
// only that both parts were non-empty, so any two tokens — a truncated cursor, one from a
// different queue, a hand-typed one — reached Postgres, raised 22P02, and came back as a
// 500 on a plain read endpoint.  Two of the five DID validate, which is the whole story:
// the check is what a decoder here is for, and five hand-written copies do not all get it.
//
// The decoder is now one module.  These cases are the shapes that used to get through.
import { describe, expect, it } from 'vitest';
import { decodeKeysetCursor, encodeKeysetCursor, isCursorUuid } from '../lib/keyset-cursor.js';

const UUID = '3f2b6a10-1c2d-4e5f-8a9b-0c1d2e3f4a5b';
const WHEN = '2026-07-30T12:00:00.000Z';

const encodeRaw = (raw: string): string => Buffer.from(raw, 'utf-8').toString('base64url');

describe('the keyset cursor is shape-validated, not just non-empty', () => {
  it('round-trips a well-formed position', () => {
    expect(decodeKeysetCursor(encodeKeysetCursor(WHEN, UUID))).toEqual({ time: WHEN, id: UUID });
  });

  it.each([
    ['absent', undefined],
    ['empty', ''],
    ['one part', encodeRaw(UUID)],
    ['empty time', encodeRaw(`|${UUID}`)],
    ['empty id', encodeRaw(`${WHEN}|`)],
    // Each of these is two non-empty tokens — exactly what the old check accepted.
    ['non-timestamp time', encodeRaw(`yesterday|${UUID}`)],
    ['non-uuid id', encodeRaw(`${WHEN}|not-a-uuid`)],
    ['parts swapped', encodeRaw(`${UUID}|${WHEN}`)],
    ['a SQL fragment', encodeRaw(`${WHEN}|') OR 1=1 --`)],
    ['not base64url at all', '!!!!'],
  ])('refuses %s', (_label, cursor) => {
    expect(decodeKeysetCursor(cursor)).toBeNull();
  });

  it('accepts a uuid on its own for the id-only cursor form', () => {
    // The audit trail's legacy cursor carries an exact id whose timestamp is unused, so
    // that form checks the id alone rather than discarding a usable cursor.
    expect(isCursorUuid(UUID)).toBe(true);
    expect(isCursorUuid('not-a-uuid')).toBe(false);
    expect(isCursorUuid('')).toBe(false);
  });
});

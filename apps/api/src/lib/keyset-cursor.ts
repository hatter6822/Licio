// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The `(timestamp, uuid)` keyset cursor — encoded, decoded and SHAPE-VALIDATED once.
//
// Five queues page this way (the report queue, the appeal queue, the audit trail, the
// integrity-incident queue and the evidence log) and each had written its own decoder:
// base64url in, split on `|`, both parts truthy, done.  Truthy is not a shape.  A cursor
// is a client-supplied string, and the parts go into a store that casts them
// `::timestamptz` and `::uuid` — so `?cursor=` of any two non-empty tokens reached
// Postgres, raised 22P02, and came back as a 500 on a read endpoint.  One of the five
// did validate, which is the strongest evidence that a shape check is what a decoder
// here is FOR, and that per-call-site copies do not all get it.
//
// A malformed cursor restarts from the beginning rather than erroring: it is a position,
// not a request, and a stale or truncated one is a client bug the reader should survive.
import { z } from 'zod';

const CURSOR_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A decoded keyset position: the sort key and the tie-breaking id. */
export interface KeysetCursor {
  time: string;
  id: string;
}

/** Encode a keyset position for the wire. */
export const encodeKeysetCursor = (time: string, id: string): string =>
  Buffer.from(`${time}|${id}`, 'utf-8').toString('base64url');

/** Decode a keyset position, or `null` when the cursor is absent or not a well-formed
 *  one.  Both parts are checked against what the store will cast them to. */
export function decodeKeysetCursor(cursor: string | undefined): KeysetCursor | null {
  if (!cursor) return null;
  const [time, id] = Buffer.from(cursor, 'base64url').toString('utf-8').split('|');
  if (!time || !id) return null;
  if (!Number.isFinite(Date.parse(time)) || !CURSOR_UUID_RE.test(id)) return null;
  return { time, id };
}

/** Whether a decoded id is a well-formed uuid — for the cursor forms that carry an id
 *  WITHOUT a timestamp beside it (the audit trail's legacy form). */
export const isCursorUuid = (id: string): boolean => CURSOR_UUID_RE.test(id);

/**
 * A cursor a route will actually be able to READ — validated at the boundary.
 *
 * `decodeKeysetCursor` fails SOFT (null ⇒ no cursor), which is right for the
 * decoder: a route must not 500 on a mangled link. It is wrong as the whole
 * answer, because the caller cannot tell "here is the next page" from "I could
 * not read your cursor, so here is the FIRST page again" — and a client that
 * appends pages then loops on the same first page forever, adding duplicate
 * rows on every scroll. That is not hypothetical: it is what a `?cursor=garbage`
 * did to the §4.2 directory list.
 *
 * So the grammar is checked where the request enters, and a cursor that cannot
 * be read is a `400` naming the field. The decoder stays defensive underneath.
 */
export const keysetCursorSchema = z
  .string()
  .min(1)
  .max(512)
  .refine((cursor) => decodeKeysetCursor(cursor) !== null, {
    message: 'malformed cursor — pass the `next_cursor` from the previous page, or omit it',
  });

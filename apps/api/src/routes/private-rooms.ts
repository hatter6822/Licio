// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-S.1.2 — the Private P2P room DIRECTORY-STUB endpoints (PRIVATE_SPEC
// §21.1–§21.4): `POST /v1/private-rooms`, `GET /directory`,
// `GET /:roomServerId/bootstrap`, `PATCH /:roomServerId`, `DELETE /:roomServerId`,
// `POST /:roomServerId/delist`.
//
// A stub is a bootstrap POINTER, never a room.  It carries cryptographic
// commitments, a rendezvous policy, and — for a `listed` room only — public
// display metadata.  It carries no content, no private CID, no operation head,
// no member list, and no activity state: the §8.1 forbiddance list is the column
// denylist of `private_room_stubs`, and the strict wire schemas here refuse
// those classes at the edge so they never reach a column that does not exist.
//
// Unlike the rendezvous endpoints (which are session-less and therefore fully
// CSRF-exempt), stub writes are AUTHENTICATED — §21.1 requires an account — so
// they ride the ordinary session + CSRF stack and are budgeted PER ACCOUNT
// (§19.1's first sanctioned form; the application never reads a client address).
// `GET /bootstrap` is deliberately unauthenticated: a member joining from an
// invite may have no Licio account at all.  `GET /directory` is unauthenticated
// for the same reason and one more: §4.2 defines `listed` as "the room directory
// can show the room shell", so its contents are public BY THE CREATOR'S EXPLICIT
// CHOICE.  It enumerates `listed` rows only — an `unlisted` room's existence is
// precisely what must never be enumerable (§15.3.1).
import { type Context, Hono } from 'hono';
import { z } from 'zod';
import { perAccountRateLimit, rateLimit } from '../lib/rate-limit.js';
import { type AuthEnv, authMiddleware, requireUnrestricted } from '../middleware/auth.js';
import {
  DIRECTORY_DEFAULT_LIMIT,
  DIRECTORY_MAX_LIMIT,
  getPrivateRoomStubService,
  type StubFailure,
} from '../private-rooms/service.js';
import {
  privateRoomCreateStubRequestSchema,
  privateRoomStubUpdateRequestSchema,
} from '../private-rooms/stores.js';

/**
 * Reject a body larger than this BEFORE parsing it.
 *
 * The zod caps (8 KiB signed stub, bounded display fields) only apply after
 * `c.req.json()` has already buffered and parsed the whole request, so an
 * authenticated account could spend unbounded API memory on ONE enormous or
 * chunked body — a per-account request COUNT does not bound the cost of a
 * single request. Same reader and same bound the private-rendezvous surface
 * uses, enforced whether or not `Content-Length` is present.
 */
const MAX_BODY_BYTES = 32 * 1024;

/** Sentinel for an over-cap body (distinct from a malformed/empty `undefined`). */
const TOO_LARGE = Symbol('too_large');

async function readJsonBounded(c: Context, maxBytes: number): Promise<unknown | typeof TOO_LARGE> {
  const declared = c.req.header('content-length');
  if (declared !== undefined) {
    const n = Number(declared);
    if (Number.isFinite(n) && n > maxBytes) return TOO_LARGE;
  }
  const body = c.req.raw.body;
  if (!body) return undefined;
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        return TOO_LARGE;
      }
      chunks.push(value);
    }
  } catch {
    return undefined;
  }
  if (total === 0) return undefined;
  const buf = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    buf.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(buf));
  } catch {
    return undefined;
  }
}

const roomIdParamSchema = z.object({ roomServerId: z.uuid() });

/** §4.2 directory paging. Both fields are optional; a bad value is a 400 rather
 *  than a silent clamp, so a client never believes it read a page it did not. */
const directoryQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(DIRECTORY_MAX_LIMIT).optional(),
  cursor: z.string().min(1).max(128).optional(),
});

/** The §21.2 invite-derived blind token, supplied as `?token=`. */
const bootstrapQuerySchema = z.object({
  token: z
    .string()
    .min(1)
    .max(512)
    .regex(/^[A-Za-z0-9_-]+$/)
    .optional(),
});

const notFound = {
  error: {
    code: 'not_found',
    message: 'No directory record for that room.',
  },
} as const;

/**
 * Map a service refusal to its wire error.
 *
 * `not_found` covers BOTH an unknown room and a bad bootstrap token on purpose
 * (§15.3.1 applied to the directory): distinguishing them would turn the
 * endpoint into an oracle for which room ids exist.
 */
function refuse(reason: StubFailure): { status: 403 | 404 | 422; body: unknown } {
  switch (reason) {
    case 'not_found':
      return { status: 404, body: notFound };
    case 'forbidden':
      return {
        status: 403,
        body: {
          error: {
            code: 'forbidden',
            message: 'Only the account that created this directory record may change it.',
          },
        },
      };
    case 'display_requires_listed':
      return {
        status: 422,
        body: {
          error: {
            code: 'display_requires_listed',
            message:
              'Display name, description, and avatar exist only for a listed room — an unlisted room publishes none of them.',
          },
        },
      };
    case 'unlisted_requires_token':
      return {
        status: 422,
        body: {
          error: {
            code: 'unlisted_requires_token',
            message:
              'An unlisted room needs a bootstrap_blind_id in its signed stub — without one no invited member could ever resolve it.',
          },
        },
      };
    case 'forbidden_stub_field':
      return {
        status: 422,
        body: {
          error: {
            code: 'forbidden_stub_field',
            message:
              'The signed stub carries a field the server non-storage contract forbids (content, member, operation, CID, or key material).',
          },
        },
      };
  }
}

export function createPrivateRoomsRoutes() {
  const app = new Hono<AuthEnv>();
  const accountId = (c: { get: (k: 'auth') => { userId: string } | undefined }): string | null =>
    c.get('auth')?.userId ?? null;

  // §21.1 — create the stub (and the P2P room shell it points at).
  app.post(
    '/',
    authMiddleware(),
    // A `listed` stub publishes a name, description and avatar to anyone with
    // the id — a PUBLIC contribution, so the WS-J `restrict` sanction has to
    // reach it exactly as it reaches story and comment creation. `authMiddleware`
    // deliberately admits a restricted account (it may still read and
    // self-serve), so the posting bar is a separate guard, here as elsewhere.
    requireUnrestricted(),
    perAccountRateLimit({ limit: 20, windowMs: 60 * 60_000, accountId }),
    async (c) => {
      const auth = c.get('auth');
      if (!auth)
        return c.json({ error: { code: 'unauthenticated', message: 'Sign in required' } }, 401);
      const raw = await readJsonBounded(c, MAX_BODY_BYTES);
      if (raw === TOO_LARGE)
        return c.json(
          { error: { code: 'oversized_request', message: 'Request body too large' } },
          413,
        );
      const parsed = privateRoomCreateStubRequestSchema.safeParse(raw);
      if (!parsed.success) {
        return c.json({ error: { code: 'invalid_request', message: 'Invalid stub payload' } }, 400);
      }
      const result = await getPrivateRoomStubService().create(parsed.data, auth.userId);
      if (!result.ok) {
        const { status, body } = refuse(result.reason);
        return c.json(body, status);
      }
      return c.json(result.value, 201);
    },
  );

  // §4.2 — the PUBLIC directory of `listed` rooms.
  //
  // Registered before the `/:roomServerId/...` routes so a room whose id were
  // ever the literal string "directory" could not shadow it. It cannot be (the
  // param is a uuid), which is the point: the ordering makes that independent
  // of the schema staying that way.
  app.get('/directory', rateLimit({ limit: 300, windowMs: 60_000 }), async (c) => {
    const query = directoryQuerySchema.safeParse({
      limit: c.req.query('limit'),
      cursor: c.req.query('cursor'),
    });
    if (!query.success) {
      return c.json(
        { error: { code: 'invalid_request', message: 'Invalid directory query' } },
        400,
      );
    }
    const page = await getPrivateRoomStubService().listDirectory({
      limit: query.data.limit ?? DIRECTORY_DEFAULT_LIMIT,
      ...(query.data.cursor !== undefined ? { cursor: query.data.cursor } : {}),
    });
    return c.json(page, 200);
  });

  // §21.2 — fetch the bootstrap record.  Listed: open.  Unlisted: the
  // invite-derived blind token, or the same 404 an unknown room returns.
  app.get('/:roomServerId/bootstrap', rateLimit({ limit: 600, windowMs: 60_000 }), async (c) => {
    const params = roomIdParamSchema.safeParse({ roomServerId: c.req.param('roomServerId') });
    // A malformed id is answered with the SAME 404 as an unknown one — a 400
    // here would confirm that a well-formed id is the only kind that can exist.
    if (!params.success) return c.json(notFound, 404);
    const query = bootstrapQuerySchema.safeParse({ token: c.req.query('token') });
    if (!query.success) return c.json(notFound, 404);
    const result = await getPrivateRoomStubService().bootstrap(
      params.data.roomServerId,
      query.data.token,
    );
    if (!result.ok) {
      const { status, body } = refuse(result.reason);
      return c.json(body, status);
    }
    return c.json(result.value, 200);
  });

  // §21.3 — patch the mutable fields (creator only).
  app.patch(
    '/:roomServerId',
    authMiddleware(),
    // Same reason as create: a PATCH can introduce or rewrite the public
    // display metadata, so a restricted account must not reach it either.
    requireUnrestricted(),
    perAccountRateLimit({ limit: 120, windowMs: 60 * 60_000, accountId }),
    async (c) => {
      const auth = c.get('auth');
      if (!auth)
        return c.json({ error: { code: 'unauthenticated', message: 'Sign in required' } }, 401);
      const params = roomIdParamSchema.safeParse({ roomServerId: c.req.param('roomServerId') });
      if (!params.success) return c.json(notFound, 404);
      const raw = await readJsonBounded(c, MAX_BODY_BYTES);
      if (raw === TOO_LARGE)
        return c.json(
          { error: { code: 'oversized_request', message: 'Request body too large' } },
          413,
        );
      const parsed = privateRoomStubUpdateRequestSchema.safeParse(raw);
      if (!parsed.success) {
        return c.json({ error: { code: 'invalid_request', message: 'Invalid stub patch' } }, 400);
      }
      const result = await getPrivateRoomStubService().update(
        params.data.roomServerId,
        parsed.data,
        auth.userId,
      );
      if (!result.ok) {
        const { status, body } = refuse(result.reason);
        return c.json(body, status);
      }
      return c.json(result.value, 200);
    },
  );

  // §21.4 — delist: demote `listed → unlisted` and drop the display metadata.
  // The bootstrap record survives, so existing members still resolve the room.
  app.post(
    '/:roomServerId/delist',
    authMiddleware(),
    perAccountRateLimit({ limit: 60, windowMs: 60 * 60_000, accountId }),
    async (c) => {
      const auth = c.get('auth');
      if (!auth)
        return c.json({ error: { code: 'unauthenticated', message: 'Sign in required' } }, 401);
      const params = roomIdParamSchema.safeParse({ roomServerId: c.req.param('roomServerId') });
      if (!params.success) return c.json(notFound, 404);
      // §11.4 staff arm: an `admin` may delist ANY listed record. That is the
      // single power staff hold over a P2P room, and without it an abusive
      // public name has no removal path when its creator will not act — no
      // other delist implementation exists. Delisting stops the room
      // ADVERTISING itself and touches nothing else: no content, no membership,
      // no keys, and the record stays resolvable for members holding its token.
      const result = await getPrivateRoomStubService().delist(
        params.data.roomServerId,
        auth.userId,
        { staff: auth.roles.includes('admin') },
      );
      if (!result.ok) {
        const { status, body } = refuse(result.reason);
        return c.json(body, status);
      }
      return c.json(result.value, 200);
    },
  );

  // §21.4 — delete the directory record.  The response says what was actually
  // removed: LICIO'S bootstrap record, not the room.  Member devices keep every
  // byte, because the server never held any.
  app.delete(
    '/:roomServerId',
    authMiddleware(),
    perAccountRateLimit({ limit: 60, windowMs: 60 * 60_000, accountId }),
    async (c) => {
      const auth = c.get('auth');
      if (!auth)
        return c.json({ error: { code: 'unauthenticated', message: 'Sign in required' } }, 401);
      const params = roomIdParamSchema.safeParse({ roomServerId: c.req.param('roomServerId') });
      if (!params.success) return c.json(notFound, 404);
      const result = await getPrivateRoomStubService().remove(
        params.data.roomServerId,
        auth.userId,
      );
      if (!result.ok) {
        const { status, body } = refuse(result.reason);
        return c.json(body, status);
      }
      return c.json(
        {
          removed: true,
          removed_what: 'licio_directory_record',
          message:
            "Removed Licio's directory and bootstrap record. Members' devices still hold the room and its content — the server never had a copy to delete.",
        },
        200,
      );
    },
  );

  return app;
}

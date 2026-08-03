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
import { type AuthEnv, authMiddleware } from '../middleware/auth.js';
import { getModerationServices } from '../moderation/services.js';
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

/** The §21.1/§21.3 posting bar, applied to the PAYLOAD rather than the route —
 *  only publishing display metadata is a public contribution. */
function isRestricted(c: Context<AuthEnv>): boolean {
  return c.get('auth')?.accountState === 'restricted';
}

const restrictedBody = {
  error: {
    code: 'account_restricted',
    message: 'This account cannot publish a public room listing right now.',
  },
} as const;

/** The two ways a client names ONE of its own records. */
const mineTargetSchema = z.object({
  room: z.uuid().optional(),
  room_public_key: z
    .string()
    .min(1)
    .max(512)
    .regex(/^[A-Za-z0-9_-]+$/)
    .optional(),
});

/** The optional case a staff delist resolves (the console supplies it). */
const delistBodySchema = z.object({ case_id: z.uuid().optional() }).strict();

const roomIdParamSchema = z.object({ roomServerId: z.uuid() });

/** §4.2 directory paging. Both fields are optional; a bad value is a 400 rather
 *  than a silent clamp, so a client never believes it read a page it did not. */
const directoryQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(DIRECTORY_MAX_LIMIT).optional(),
  cursor: z.string().min(1).max(128).optional(),
});

/**
 * The §21.2 invite-derived blind token, supplied as a HEADER.
 *
 * Not `?token=`. A URL is the one part of a request that is written down
 * everywhere — proxy logs, browser history, the client's own dev console (which
 * logs `String(input)` for every call) — and this capability does not rotate, so
 * a single logged line keeps opening an `unlisted` record long after the invite
 * exchange, including after a delist. A header carries it to the same place
 * without that trail.
 */
const BOOTSTRAP_TOKEN_HEADER = 'x-licio-bootstrap-token';

const bootstrapTokenSchema = z
  .string()
  .min(1)
  .max(512)
  .regex(/^[A-Za-z0-9_-]+$/)
  .optional();

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
    case 'identity_change':
      return {
        status: 422,
        body: {
          error: {
            code: 'identity_change',
            message:
              'A directory record cannot change the key it is signed by. Members verify the record against that key; re-signing it under another device would make an honest record look forged.',
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
      // The `restrict` sanction bars PUBLIC contribution, and only a `listed`
      // stub is one — it publishes a name, description and avatar into a
      // directory anyone can browse. An `unlisted` stub publishes nothing: it
      // is an opaque bootstrap pointer, and §4.2 makes it the MANDATORY default,
      // so barring it turned every restricted account's rooms into `detached`
      // ones whose invites cannot resolve. That is a second, unlegislated
      // sanction on private communication, which the restriction is not.
      if (parsed.data.directory_mode === 'listed' && isRestricted(c)) {
        return c.json(restrictedBody, 403);
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

  // §21.1 — the stubs THIS account created.
  //
  // The endpoint whose absence three separate defects were argued from: "no
  // endpoint lists an account's stubs" made a create whose response was lost
  // unrecoverable, made a failed local write strand a record its own creator
  // could never address, and made the DSAR export the only way to learn a
  // record existed. A POST that commits and whose response never arrives is not
  // an exotic case; it is what a dropped connection looks like.
  //
  // It discloses nothing new: the same rows already reach this account through
  // its Art. 15 archive, and the projection is the owner's own record.
  app.get(
    '/mine',
    authMiddleware(),
    perAccountRateLimit({ limit: 60, windowMs: 60 * 60_000, accountId }),
    async (c) => {
      // OWNER-SCOPED, so never cached. The projection carries the record's own
      // display metadata and — for the export — the capability, and a browser or
      // shared cache keyed on this URL would replay one account's answer to the
      // next signed-in account without `authMiddleware` running again.
      c.header('Cache-Control', 'no-store, private');
      c.header('Vary', 'Cookie', { append: true });
      const auth = c.get('auth');
      if (!auth)
        return c.json({ error: { code: 'unauthenticated', message: 'Sign in required' } }, 401);
      // A TARGETED lookup when the caller names a room — the shape both real
      // callers need. Walking pages to answer "do I own this one" spends a
      // request per page against a per-account budget, so an account with enough
      // stubs could never finish the walk and would read "no" for a deep record.
      const target = mineTargetSchema.safeParse({
        room: c.req.query('room'),
        room_public_key: c.req.query('room_public_key'),
      });
      if (!target.success) {
        return c.json({ error: { code: 'invalid_request', message: 'Invalid lookup' } }, 400);
      }
      if (target.data.room !== undefined || target.data.room_public_key !== undefined) {
        const found = await getPrivateRoomStubService().findOwnedStub(auth.userId, {
          ...(target.data.room !== undefined ? { roomServerId: target.data.room } : {}),
          ...(target.data.room_public_key !== undefined
            ? { roomPublicKey: target.data.room_public_key }
            : {}),
        });
        return c.json({ stubs: found === null ? [] : [found], next_cursor: null }, 200);
      }
      const query = directoryQuerySchema.safeParse({
        limit: c.req.query('limit'),
        cursor: c.req.query('cursor'),
      });
      if (!query.success) {
        return c.json({ error: { code: 'invalid_request', message: 'Invalid page query' } }, 400);
      }
      // PAGED: an account's stub count has no lifetime bound (the creation
      // limit is per hour), and each row carries bounded-but-large display and
      // hint fields, so serving the whole set per request is an amplification
      // path on an endpoint a client polls.
      const page = await getPrivateRoomStubService().listForAccountPage(auth.userId, {
        ...(query.data.limit !== undefined ? { limit: query.data.limit } : {}),
        ...(query.data.cursor !== undefined ? { cursor: query.data.cursor } : {}),
      });
      return c.json(page, 200);
    },
  );

  // §21.2 — fetch the bootstrap record.  Listed: open.  Unlisted: the
  // invite-derived blind token, or the same 404 an unknown room returns.
  app.get('/:roomServerId/bootstrap', rateLimit({ limit: 600, windowMs: 60_000 }), async (c) => {
    // FIRST, so it covers every answer this route can give.
    //
    // Applying it only to the 200 left the refusals cacheable: a 404 produced by
    // a missing or wrong token could be stored against the URL — which no longer
    // distinguishes a capability-bearing request from a bare one — and replayed
    // to a legitimate invitee presenting the right token. The identical-404
    // contract makes the two indistinguishable to a cache as well as to a
    // reader, which is exactly why neither may be stored.
    c.header('Cache-Control', 'no-store, private');
    // APPEND, never assign: `corsMiddleware` has already put `Origin` here, and
    // overwriting it would let a shared cache reuse one origin's
    // `Access-Control-Allow-Origin` decision for another.
    c.header('Vary', BOOTSTRAP_TOKEN_HEADER, { append: true });
    const params = roomIdParamSchema.safeParse({ roomServerId: c.req.param('roomServerId') });
    // A malformed id is answered with the SAME 404 as an unknown one — a 400
    // here would confirm that a well-formed id is the only kind that can exist.
    if (!params.success) return c.json(notFound, 404);
    const token = bootstrapTokenSchema.safeParse(c.req.header(BOOTSTRAP_TOKEN_HEADER));
    if (!token.success) return c.json(notFound, 404);
    const result = await getPrivateRoomStubService().bootstrap(
      params.data.roomServerId,
      token.data,
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
      // Same rule as create, keyed on the patch rather than the route: SETTING
      // display metadata is the public act. Clearing it, refreshing a
      // commitment, or changing a rendezvous policy publishes nothing, and a
      // restricted account must still be able to do those — not least because
      // clearing a name is the thing a sanctioned account most plausibly needs.
      const publishesDisplay =
        typeof parsed.data.display_name === 'string' ||
        typeof parsed.data.display_description === 'string' ||
        typeof parsed.data.display_avatar_public_cid === 'string';
      if (publishesDisplay && isRestricted(c)) return c.json(restrictedBody, 403);
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
      // The staff arm requires the SAME per-session assurance every other
      // steward action does. `admin` on the account is not the bar — a
      // reduced-assurance session (MFA enrolled but not cleared this session) is
      // exactly the stolen-cookie case `requireSteward` exists for, and this
      // action irreversibly demotes a public listing. The OWNER arm is
      // deliberately untouched: a room's own creator is not a steward and must
      // not need MFA to stop advertising their own room.
      const staff = auth.roles.includes('admin') && auth.mfaActive && auth.mfaVerified;
      // The case this delist answers, when it was taken from the console.
      const body = await readJsonBounded(c, MAX_BODY_BYTES);
      const parsedBody = delistBodySchema.safeParse(body === undefined ? {} : body);
      if (!parsedBody.success) {
        return c.json({ error: { code: 'invalid_request', message: 'Invalid delist' } }, 400);
      }
      const caseId = parsedBody.data.case_id;

      // THE STAFF ARM RUNS AS ONE UNIT with its audit record.
      //
      // §11.4 makes delist the single power staff hold over a P2P room and
      // requires every use of it to be recorded. Ordering alone could not
      // deliver that: audit-then-act leaves a permanent record of a transition a
      // store failure prevented, act-then-audit leaves an irreversible demotion
      // with no record, and a compensating write is itself best-effort. Inside
      // the moderation transaction, `tx.audit` throwing takes the demotion down
      // and a store failure takes the record down — neither lands alone.
      //
      // The demotion is CONDITIONAL on the record still being listed, so the
      // write is what establishes there was a public listing to remove: an owner
      // delisting in the same instant makes the unit match nothing, and no
      // record is written for a demotion staff did not perform.
      // OWNERSHIP FIRST. An owner who also holds `admin` is still delisting their
      // OWN room — no platform power is exercised, so no record is required, and
      // routing them through the staff arm would answer with the confirmation
      // shape the owner client does not expect: it validates every success as a
      // full bootstrap record, so parsing fails AFTER the demotion committed and
      // the panel reports failure over stale listed state.
      const owner =
        (await getPrivateRoomStubService().ownerOf(params.data.roomServerId)) === auth.userId;
      if (staff && !owner) {
        const mod = getModerationServices();
        const demoted = await mod.transactor.run(async (tx) => {
          if (!(await tx.delistListedRoom(params.data.roomServerId))) return false;
          // RESOLVE the case in the same unit, when the delist came from one.
          //
          // Without it the remedy ran and the case stayed `new`: back in the
          // queue, with a case-scoped history that does not mention the
          // enforcement. The case transition, the demotion and the audit row are
          // one fact about one action, so they commit together.
          // Only a case ABOUT THIS ROOM — and the VALIDATED id is the only one
          // used afterwards. Declining to resolve a mismatched case while still
          // stamping the audit row with its id would print an enforcement
          // against another room into that case's history, permanently, while
          // the intended case stayed open.
          let matchedCase: string | undefined;
          if (caseId !== undefined) {
            const theCase = await tx.cases.getById(caseId);
            if (
              theCase !== null &&
              theCase.targetType === 'room' &&
              theCase.targetId === params.data.roomServerId
            ) {
              matchedCase = caseId;
              await tx.cases.update(caseId, { status: 'resolved', resolvedActionId: null });
            }
          }
          await tx.audit({
            actorUserId: auth.userId,
            // The doctrine-steward roles do not cover this: §11.4 gives the
            // power to platform staff as such, not to a safety/appeals lane.
            actorRole: null,
            action: 'private_room_stub_delisted',
            targetType: 'private_room_stub',
            targetId: params.data.roomServerId,
            priorState: 'listed',
            nextState: 'unlisted',
            reversible: false,
            ...(matchedCase !== undefined ? { caseId: matchedCase } : {}),
            notes: 'Staff delist of a public directory listing (PRIVATE_SPEC §11.4/§21.4).',
          });
          return true;
        });
        if (demoted) {
          // A CONFIRMATION, not a projection. The record is `unlisted` now, so
          // staff hold no capability for it — §11.4 gives them power over the
          // public LISTING and nothing over the record, and returning the
          // bootstrap body would hand them exactly what the blind token gates.
          return c.json({ room_server_id: params.data.roomServerId, delisted: true }, 200);
        }
        // Nothing matched: unknown room, or the owner delisted first. Same
        // `not_found` a non-owner already gets for a record that is not listed,
        // so a staff caller learns nothing an ordinary one would not.
        return c.json(notFound, 404);
      }

      // The OWNER arm: no platform power is exercised, so no record is required
      // and the ordinary path applies.
      const result = await getPrivateRoomStubService().delist(
        params.data.roomServerId,
        auth.userId,
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

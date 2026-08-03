// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-S.1.2 — the Private P2P room DIRECTORY-STUB surface (PRIVATE_SPEC
// §21.1–§21.4).  The properties under test are the ones the server non-storage
// contract turns on, not the CRUD:
//
//   • §8.1 forbidden classes are refused, including inside `signed_stub` — the
//     one free-form field the column allowlist cannot see into;
//   • display metadata exists for a `listed` room ONLY, and the refusal is
//     explicit rather than a silent drop;
//   • an `unlisted` bootstrap read needs the invite-derived blind token, and a
//     wrong token is INDISTINGUISHABLE from an unknown room (§15.3.1 applied to
//     the directory);
//   • DELETE removes Licio's record, and says so — it is not a room deletion;
//   • the stub surface authenticates writes (§21.1) and leaves reads open.
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../app.js';
import {
  hasBootstrapToken,
  PrivateRoomStubService,
  setPrivateRoomStubService,
} from '../private-rooms/service.js';
import {
  forbiddenSignedStubKeys,
  InMemoryPrivateRoomStubStore,
  type PrivateRoomCreateStubRequest,
  privateRoomCreateStubRequestSchema,
  privateRoomStubUpdateRequestSchema,
  SIGNED_STUB_TOO_DEEP,
} from '../private-rooms/stores.js';

const ACCOUNT = '11111111-1111-4111-8111-111111111111';
const OTHER_ACCOUNT = '22222222-2222-4222-8222-222222222222';
const TOKEN = 'Ym9vdHN0cmFwLWJsaW5kLWlk';
/** The canonical §8.2 stub body — a CLOSED set of commitment fields. */
const SIGNED_STUB = {
  schema: 'licio.private.directory_stub.v1',
  room_public_key: 'cm9vbS1wdWJsaWMta2V5',
  manifest_key_commitment: 'bWFuaWZlc3QtY29tbWl0bWVudA',
  bootstrap_blind_id: TOKEN,
} as const;

/** Deterministic ids so a test can address the room it just created. */
function freshService(): PrivateRoomStubService {
  let n = 0;
  return new PrivateRoomStubService(
    new InMemoryPrivateRoomStubStore(),
    () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`,
  );
}

// TYPED fixtures. The overrides these tests need are all valid members of the
// request type, so the helpers are typed rather than cast: `as any` is barred
// outright by the project's no-`any` rule, and reaching for it here would have
// hidden the fact that nothing actually required it.
function listedRequest(
  over: Partial<PrivateRoomCreateStubRequest> = {},
): PrivateRoomCreateStubRequest {
  return {
    directory_mode: 'listed',
    display_name: 'Neighbourhood watch',
    room_public_key: 'cm9vbS1wdWJsaWMta2V5',
    manifest_key_commitment: 'bWFuaWZlc3QtY29tbWl0bWVudA',
    rendezvous_policy: 'licio_blind',
    signed_stub: SIGNED_STUB,
    stub_signature: 'c3R1Yi1zaWduYXR1cmU',
    ...over,
  };
}

function unlistedRequest(
  over: Partial<PrivateRoomCreateStubRequest> = {},
): PrivateRoomCreateStubRequest {
  return {
    directory_mode: 'unlisted',
    room_public_key: 'cm9vbS1wdWJsaWMta2V5',
    manifest_key_commitment: 'bWFuaWZlc3QtY29tbWl0bWVudA',
    rendezvous_policy: 'licio_blind',
    signed_stub: SIGNED_STUB,
    stub_signature: 'c3R1Yi1zaWduYXR1cmU',
    ...over,
  };
}

/** The SCHEMA cases feed deliberately-invalid shapes; `safeParse` takes
 *  `unknown`, so they need no type at all — and must not borrow the typed
 *  helper, whose whole point is that its output is valid. */
function rawRequest(over: Record<string, unknown> = {}): unknown {
  return { ...listedRequest(), ...over };
}

describe('§21.1 create — the §8.1 boundary is enforced at the wire, not by a handler', () => {
  it('rejects every forbidden §21.1 key by SHAPE (no private CID, op head, or member list)', () => {
    for (const forbidden of [
      { private_cids: ['bafy'] },
      { op_heads: ['op-1'] },
      { members: ['alice'] },
      { latest_manifest_commitment: 'c2V0LWF0LWNyZWF0ZQ' },
      { storage_mode: 'server' },
    ]) {
      const parsed = privateRoomCreateStubRequestSchema.safeParse(rawRequest(forbidden));
      expect(parsed.success, `expected ${Object.keys(forbidden)[0]} to be rejected`).toBe(false);
    }
  });

  it('rejects `detached` — a detached room stores no stub at all (§8.2)', () => {
    expect(
      privateRoomCreateStubRequestSchema.safeParse(rawRequest({ directory_mode: 'detached' }))
        .success,
    ).toBe(false);
  });

  it('finds forbidden classes NESTED inside signed_stub, which no column guard can see', () => {
    expect(forbiddenSignedStubKeys({ ok: 1 })).toEqual([]);
    expect(forbiddenSignedStubKeys({ member_list: ['a'] })).toEqual(['member_list']);
    expect(forbiddenSignedStubKeys({ a: { b: [{ story_id: 'x' }] } })).toEqual(['story_id']);
    // A §8.2-ALLOWED commitment must not false-positive.
    expect(forbiddenSignedStubKeys({ manifest_key_commitment: 'x', room_public_key: 'y' })).toEqual(
      [],
    );
  });

  it('refuses ANY unknown signed-stub field — values, not just keys', () => {
    // `.passthrough()` used to accept arbitrary VALUES under unknown keys, so a
    // private message or member list rode through every key-level check and was
    // persisted verbatim. The body is a CLOSED commitment set now, so the
    // smuggling field is rejected by shape.
    for (const smuggled of [
      { member_list: ['alice'] },
      { x: 'a private message' },
      { note: 'anything at all' },
    ]) {
      const parsed = privateRoomCreateStubRequestSchema.safeParse(
        rawRequest({ signed_stub: { ...SIGNED_STUB, ...smuggled } }),
      );
      expect(parsed.success, `expected ${Object.keys(smuggled)[0]} to be rejected`).toBe(false);
    }
  });

  it('refuses a signed stub missing the bootstrap capability', () => {
    const { bootstrap_blind_id: _dropped, ...withoutToken } = SIGNED_STUB;
    expect(
      privateRoomCreateStubRequestSchema.safeParse(rawRequest({ signed_stub: withoutToken }))
        .success,
    ).toBe(false);
    // …and the service's own guard still answers, for a non-HTTP caller.
    expect(hasBootstrapToken(withoutToken)).toBe(false);
    expect(hasBootstrapToken(SIGNED_STUB)).toBe(true);
  });

  it('refuses display metadata on an unlisted room instead of silently dropping it', async () => {
    const svc = freshService();
    const result = await svc.create(unlistedRequest({ display_name: 'Leaky' }), ACCOUNT);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toBe('display_requires_listed');
  });

  it('returns the room shell id, the stub id, and the rendezvous bootstrap endpoints', async () => {
    const svc = freshService();
    const created = await svc.create(listedRequest(), ACCOUNT);
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.value.room_server_id).not.toBe(created.value.stub_id);
    expect(created.value.bootstrap_endpoints).toContain('/v1/private-rendezvous/announce');
  });
});

describe('review fixes — the scan, the token invariant, and staff delisting', () => {
  it('REFUSES a stub nesting past the scan depth rather than reporting it clean', () => {
    // The scan used to stop descending at the cap, so a forbidden key below it
    // was reported clean and persisted. Bounded recursion that silently stops
    // looking is not a guard: exceeding the depth is now itself a rejection.
    let deep: Record<string, unknown> = { member_list: ['alice'] };
    for (let i = 0; i < 25; i += 1) deep = { nested: deep };
    expect(forbiddenSignedStubKeys(deep)).toEqual([SIGNED_STUB_TOO_DEEP]);
    // …and a normally-shaped stub is unaffected.
    expect(forbiddenSignedStubKeys({ a: { b: { c: 'ok' } } })).toEqual([]);
  });

  it('a delisted record stays resolvable for members holding its token', async () => {
    const svc = freshService();
    const created = await svc.create(listedRequest(), ACCOUNT);
    if (!created.ok) throw new Error('create failed');
    const room = created.value.room_server_id;
    expect((await svc.delist(room, ACCOUNT)).ok).toBe(true);
    // The whole point of §21.4: delisting stops advertising, it does not orphan
    // the members who already hold an invite.
    const read = await svc.bootstrap(room, TOKEN);
    expect(read.ok).toBe(true);
    expect(read.ok && read.value.directory_mode).toBe('unlisted');
  });

  it('refuses a PATCH that replaces only the stub or only its signature', () => {
    // The body and its signature are ONE fact: patching either alone leaves the
    // bootstrap endpoint serving a pair that cannot verify.
    expect(privateRoomStubUpdateRequestSchema.safeParse({ signed_stub: SIGNED_STUB }).success).toBe(
      false,
    );
    expect(privateRoomStubUpdateRequestSchema.safeParse({ stub_signature: 'c2ln' }).success).toBe(
      false,
    );
    expect(
      privateRoomStubUpdateRequestSchema.safeParse({
        signed_stub: SIGNED_STUB,
        stub_signature: 'c2ln',
      }).success,
    ).toBe(true);
  });

  it('lets platform staff delist an abusive listed record the creator will not remove', async () => {
    const svc = freshService();
    const created = await svc.create(listedRequest({ display_name: 'Abusive name' }), ACCOUNT);
    if (!created.ok) throw new Error('create failed');
    const room = created.value.room_server_id;
    // A non-owner without the staff arm still cannot.
    expect((await svc.delist(room, OTHER_ACCOUNT)).ok).toBe(false);
    // §11.4: staff hold exactly this one power over a P2P room.
    const staffed = await svc.delist(room, OTHER_ACCOUNT, { staff: true });
    expect(staffed.ok).toBe(true);
    expect(staffed.ok && staffed.value.display_name).toBe(null);
  });

  it('does NOT let staff delete or patch — delisting is the whole of the power', async () => {
    const svc = freshService();
    const created = await svc.create(listedRequest(), ACCOUNT);
    if (!created.ok) throw new Error('create failed');
    const room = created.value.room_server_id;
    expect((await svc.remove(room, OTHER_ACCOUNT)).ok).toBe(false);
    expect((await svc.update(room, { display_name: 'Staff edit' }, OTHER_ACCOUNT)).ok).toBe(false);
  });

  it('purges every stub an account created (the hard-deletion hook)', async () => {
    const svc = freshService();
    const mine = await svc.create(listedRequest(), ACCOUNT);
    const theirs = await svc.create(listedRequest(), OTHER_ACCOUNT);
    if (!mine.ok || !theirs.ok) throw new Error('create failed');
    expect(await svc.purgeForAccount(ACCOUNT)).toBe(1);
    expect((await svc.bootstrap(mine.value.room_server_id, TOKEN)).ok).toBe(false);
    // Another account's record is untouched.
    expect((await svc.bootstrap(theirs.value.room_server_id, TOKEN)).ok).toBe(true);
  });
});

describe('§21.2 bootstrap — listed is open, unlisted is capability-gated', () => {
  it('serves a listed room with its display metadata and no token', async () => {
    const svc = freshService();
    const created = await svc.create(listedRequest(), ACCOUNT);
    if (!created.ok) throw new Error('create failed');
    const read = await svc.bootstrap(created.value.room_server_id, undefined);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.value.display_name).toBe('Neighbourhood watch');
    expect(read.value.directory_mode).toBe('listed');
  });

  it('serves an unlisted room ONLY with the invite-derived token', async () => {
    const svc = freshService();
    const created = await svc.create(unlistedRequest(), ACCOUNT);
    if (!created.ok) throw new Error('create failed');
    const withToken = await svc.bootstrap(created.value.room_server_id, TOKEN);
    expect(withToken.ok).toBe(true);
    expect(withToken.ok && withToken.value.display_name).toBe(null);
  });

  it('an unknown room, a missing token, and a WRONG token are indistinguishable', async () => {
    const svc = freshService();
    const created = await svc.create(unlistedRequest(), ACCOUNT);
    if (!created.ok) throw new Error('create failed');
    const room = created.value.room_server_id;

    const unknown = await svc.bootstrap('00000000-0000-4000-8000-999999999999', TOKEN);
    const missing = await svc.bootstrap(room, undefined);
    const wrong = await svc.bootstrap(room, 'd3JvbmctdG9rZW4');

    // Same refusal for all three — the endpoint is not an oracle for which
    // room ids exist (§15.3.1 applied to the directory).
    for (const result of [unknown, missing, wrong]) {
      expect(result.ok).toBe(false);
      expect(result.ok === false && result.reason).toBe('not_found');
    }
  });
});

describe('§21.3 update — only the mutable fields, only the creator', () => {
  it('rejects every forbidden §21.3 field by SHAPE', () => {
    for (const forbidden of [
      { members: ['a'] },
      { private_cids: ['bafy'] },
      { op_heads: ['x'] },
      { latest_activity_at: '2026-01-01' },
      { unread_count: 3 },
      { directory_mode: 'listed' },
    ]) {
      expect(privateRoomStubUpdateRequestSchema.safeParse(forbidden).success).toBe(false);
    }
  });

  it('accepts the four §21.3-allowed updates', () => {
    expect(
      privateRoomStubUpdateRequestSchema.safeParse({
        display_name: 'Renamed',
        rendezvous_policy: 'manual_only',
        bootstrap_hints: [{ kind: 'manual', value: 'paste-me' }],
        latest_manifest_commitment: 'bmV3LW1hbmlmZXN0',
      }).success,
    ).toBe(true);
  });

  it('refuses a non-creator (no platform role can edit a room record either)', async () => {
    const svc = freshService();
    const created = await svc.create(listedRequest(), ACCOUNT);
    if (!created.ok) throw new Error('create failed');
    const result = await svc.update(
      created.value.room_server_id,
      { display_name: 'Hijacked' },
      OTHER_ACCOUNT,
    );
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toBe('forbidden');
  });

  it('applies the latest manifest commitment', async () => {
    const svc = freshService();
    const created = await svc.create(listedRequest(), ACCOUNT);
    if (!created.ok) throw new Error('create failed');
    const updated = await svc.update(
      created.value.room_server_id,
      { latest_manifest_commitment: 'bmV3LW1hbmlmZXN0' },
      ACCOUNT,
    );
    expect(updated.ok && updated.value.latest_manifest_commitment).toBe('bmV3LW1hbmlmZXN0');
  });
});

describe('§21.4 delist and delete', () => {
  it('delist demotes to unlisted and DROPS the display metadata', async () => {
    const svc = freshService();
    const created = await svc.create(listedRequest(), ACCOUNT);
    if (!created.ok) throw new Error('create failed');
    const delisted = await svc.delist(created.value.room_server_id, ACCOUNT);
    expect(delisted.ok).toBe(true);
    if (!delisted.ok) return;
    expect(delisted.value.directory_mode).toBe('unlisted');
    expect(delisted.value.display_name).toBe(null);
    expect(delisted.value.display_avatar_public_cid).toBe(null);
  });

  it('delete removes the directory record; the bootstrap read then 404s', async () => {
    const svc = freshService();
    const created = await svc.create(listedRequest(), ACCOUNT);
    if (!created.ok) throw new Error('create failed');
    const room = created.value.room_server_id;
    expect((await svc.remove(room, ACCOUNT)).ok).toBe(true);
    const read = await svc.bootstrap(room, undefined);
    expect(read.ok).toBe(false);
    // Removing the record twice is a 404, not a crash.
    expect((await svc.remove(room, ACCOUNT)).ok).toBe(false);
  });

  it('refuses delist/delete from a non-creator', async () => {
    const svc = freshService();
    const created = await svc.create(listedRequest(), ACCOUNT);
    if (!created.ok) throw new Error('create failed');
    const room = created.value.room_server_id;
    expect((await svc.delist(room, OTHER_ACCOUNT)).ok).toBe(false);
    expect((await svc.remove(room, OTHER_ACCOUNT)).ok).toBe(false);
  });
});

describe('mounted routes (PRIVATE_SPEC §21)', () => {
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    setPrivateRoomStubService(freshService());
    app = createApp();
  });

  it('serves a listed room over GET /v1/private-rooms/:id/bootstrap without a session', async () => {
    const svc = freshService();
    setPrivateRoomStubService(svc);
    const created = await svc.create(listedRequest(), ACCOUNT);
    if (!created.ok) throw new Error('create failed');
    const res = await app.request(`/v1/private-rooms/${created.value.room_server_id}/bootstrap`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { display_name: string; bootstrap_endpoints: string[] };
    expect(body.display_name).toBe('Neighbourhood watch');
    expect(body.bootstrap_endpoints.length).toBeGreaterThan(0);
  });

  it('answers a MALFORMED room id with the same 404 as an unknown one', async () => {
    const malformed = await app.request('/v1/private-rooms/not-a-uuid/bootstrap');
    const unknown = await app.request(
      '/v1/private-rooms/00000000-0000-4000-8000-999999999999/bootstrap',
    );
    expect(malformed.status).toBe(404);
    expect(unknown.status).toBe(404);
    expect(await malformed.json()).toEqual(await unknown.json());
  });

  it('requires a session for every WRITE (§21.1)', async () => {
    const room = '00000000-0000-4000-8000-000000000001';
    for (const [method, path] of [
      ['POST', '/v1/private-rooms'],
      ['PATCH', `/v1/private-rooms/${room}`],
      ['DELETE', `/v1/private-rooms/${room}`],
      ['POST', `/v1/private-rooms/${room}/delist`],
    ] as const) {
      const res = await app.request(path, {
        method,
        headers: { 'content-type': 'application/json', origin: 'http://localhost:5173' },
        // `exactOptionalPropertyTypes` rejects an explicit `body: undefined`,
        // and DELETE carries none.
        ...(method === 'DELETE' ? {} : { body: JSON.stringify({}) }),
      });
      // 401 (no session) or 403 (no CSRF token) — never a 2xx, and never a
      // write that reaches the store.
      expect([401, 403], `${method} ${path} answered ${res.status}`).toContain(res.status);
    }
  });
});

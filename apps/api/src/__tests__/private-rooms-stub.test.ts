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
import { PrivateRoomStubService, setPrivateRoomStubService } from '../private-rooms/service.js';
import {
  forbiddenSignedStubKeys,
  InMemoryPrivateRoomStubStore,
  privateRoomCreateStubRequestSchema,
  privateRoomStubUpdateRequestSchema,
} from '../private-rooms/stores.js';

const ACCOUNT = '11111111-1111-4111-8111-111111111111';
const OTHER_ACCOUNT = '22222222-2222-4222-8222-222222222222';
const TOKEN = 'Ym9vdHN0cmFwLWJsaW5kLWlk';

/** Deterministic ids so a test can address the room it just created. */
function freshService(): PrivateRoomStubService {
  let n = 0;
  return new PrivateRoomStubService(
    new InMemoryPrivateRoomStubStore(),
    () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`,
  );
}

function listedRequest(over: Record<string, unknown> = {}) {
  return {
    directory_mode: 'listed' as const,
    display_name: 'Neighbourhood watch',
    room_public_key: 'cm9vbS1wdWJsaWMta2V5',
    manifest_key_commitment: 'bWFuaWZlc3QtY29tbWl0bWVudA',
    rendezvous_policy: 'licio_blind' as const,
    signed_stub: { room_public_key: 'cm9vbS1wdWJsaWMta2V5' },
    stub_signature: 'c3R1Yi1zaWduYXR1cmU',
    ...over,
  };
}

function unlistedRequest(over: Record<string, unknown> = {}) {
  return {
    directory_mode: 'unlisted' as const,
    room_public_key: 'cm9vbS1wdWJsaWMta2V5',
    manifest_key_commitment: 'bWFuaWZlc3QtY29tbWl0bWVudA',
    rendezvous_policy: 'licio_blind' as const,
    signed_stub: { bootstrap_blind_id: TOKEN },
    stub_signature: 'c3R1Yi1zaWduYXR1cmU',
    ...over,
  };
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
      const parsed = privateRoomCreateStubRequestSchema.safeParse(listedRequest(forbidden));
      expect(parsed.success, `expected ${Object.keys(forbidden)[0]} to be rejected`).toBe(false);
    }
  });

  it('rejects `detached` — a detached room stores no stub at all (§8.2)', () => {
    expect(
      privateRoomCreateStubRequestSchema.safeParse(listedRequest({ directory_mode: 'detached' }))
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

  it('refuses a signed stub carrying a forbidden class (not a silent strip)', async () => {
    const svc = freshService();
    const result = await svc.create(
      // biome-ignore lint/suspicious/noExplicitAny: exercising a rejected runtime shape
      listedRequest({ signed_stub: { member_list: ['alice'] } }) as any,
      ACCOUNT,
    );
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toBe('forbidden_stub_field');
  });

  it('refuses display metadata on an unlisted room instead of silently dropping it', async () => {
    const svc = freshService();
    const result = await svc.create(
      // biome-ignore lint/suspicious/noExplicitAny: exercising a rejected runtime shape
      unlistedRequest({ display_name: 'Leaky' }) as any,
      ACCOUNT,
    );
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toBe('display_requires_listed');
  });

  it('refuses an unlisted room with no bootstrap token — it would be unreachable forever', async () => {
    const svc = freshService();
    const result = await svc.create(
      // biome-ignore lint/suspicious/noExplicitAny: exercising a rejected runtime shape
      unlistedRequest({ signed_stub: { note: 'no token' } }) as any,
      ACCOUNT,
    );
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toBe('unlisted_requires_token');
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

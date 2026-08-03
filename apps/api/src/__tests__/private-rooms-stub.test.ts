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
  type PrivateRoomCreateStubRequest,
  privateRoomCreateStubRequestSchema,
  privateRoomStubUpdateRequestSchema,
  SIGNED_STUB_TOO_DEEP,
} from '../private-rooms/stores.js';

const ACCOUNT = '11111111-1111-4111-8111-111111111111';
const OTHER_ACCOUNT = '22222222-2222-4222-8222-222222222222';
const TOKEN = 'PEaenWxYddN6Q_NT1PiOYfz4EsZu7jRXRlpAsNpBU-A';
/** The canonical §8.2 stub body — a CLOSED set of PUBLIC commitments.
 *  The capability is NOT in here: it is its own never-projected column. */
const SIGNED_STUB = {
  schema: 'licio.private.directory_stub.v2',
  room_public_key: 'HxxbL613hDQCTxU3mGNGknkX9HVabn0_2R8iZTt8MTI',
  manifest_key_commitment: 'BbOr8leaXrZkA814vlV_2GBjOh_iEDx2QgMN7-MsZX8',
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
    rendezvous_policy: 'licio_blind',
    signed_stub: SIGNED_STUB,
    stub_signature:
      'pUOZfYTxJ5g1DAm97yzbFxv0HtPkpfgIry_rDFYmMAm_e1fNo_tkAcgXDt6Ecbtv53kTloLE6i_N5OMKpb47OQ',
    bootstrap_blind_id: TOKEN,
    ...over,
  };
}

function unlistedRequest(
  over: Partial<PrivateRoomCreateStubRequest> = {},
): PrivateRoomCreateStubRequest {
  return {
    directory_mode: 'unlisted',
    rendezvous_policy: 'licio_blind',
    signed_stub: SIGNED_STUB,
    stub_signature:
      'pUOZfYTxJ5g1DAm97yzbFxv0HtPkpfgIry_rDFYmMAm_e1fNo_tkAcgXDt6Ecbtv53kTloLE6i_N5OMKpb47OQ',
    bootstrap_blind_id: TOKEN,
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

  it('refuses a request with no bootstrap capability, and refuses one inside the body', () => {
    // The capability is a REQUIRED top-level field and a NOT NULL column now,
    // so "a stub without a token" is unrepresentable rather than caught.
    const { bootstrap_blind_id: _dropped, ...withoutToken } = listedRequest();
    expect(privateRoomCreateStubRequestSchema.safeParse(withoutToken).success).toBe(false);
    // …and putting it back INSIDE the signed body — the shape that leaked it
    // through every projection of that body — is refused by the closed set.
    expect(
      privateRoomCreateStubRequestSchema.safeParse(
        rawRequest({ signed_stub: { ...SIGNED_STUB, bootstrap_blind_id: TOKEN } }),
      ).success,
    ).toBe(false);
  });

  it('DERIVES the commitment columns from the signed body, so they cannot disagree', async () => {
    const svc = freshService();
    const created = await svc.create(listedRequest(), ACCOUNT);
    if (!created.ok) throw new Error('create failed');
    const read = await svc.bootstrap(created.value.room_server_id, TOKEN);
    if (!read.ok) throw new Error('bootstrap failed');
    // There is no second copy to drift: the wire request has no
    // `room_public_key`/`manifest_key_commitment` of its own.
    expect(read.value.room_public_key).toBe(SIGNED_STUB.room_public_key);
    expect(read.value.manifest_key_commitment).toBe(SIGNED_STUB.manifest_key_commitment);
    expect(read.value.signed_stub).toEqual(SIGNED_STUB);
  });

  it('never projects the capability, in any mode', async () => {
    const svc = freshService();
    const listed = await svc.create(listedRequest(), ACCOUNT);
    const unlisted = await svc.create(unlistedRequest(), ACCOUNT);
    if (!listed.ok || !unlisted.ok) throw new Error('create failed');

    // The open read a `listed` room serves used to hand out `bootstrap_blind_id`
    // inside `signed_stub` — one anonymous GET per room in the §4.2 directory,
    // and the harvested token keeps resolving the record after it is delisted.
    const open = await svc.bootstrap(listed.value.room_server_id, undefined);
    if (!open.ok) throw new Error('bootstrap failed');
    expect(JSON.stringify(open.value)).not.toContain(TOKEN);

    // …and neither does the capability-holding read, which has no need for it.
    const capable = await svc.bootstrap(unlisted.value.room_server_id, TOKEN);
    if (!capable.ok) throw new Error('bootstrap failed');
    expect(JSON.stringify(capable.value)).not.toContain(TOKEN);
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

  it('refuses a capability smuggled into the signed body at any depth', () => {
    // Second lock behind the closed schema: `signed_stub` is projected wholesale
    // to anonymous readers of a listed room, so a secret in it is public.
    expect(forbiddenSignedStubKeys({ bootstrap_blind_id: 'x' })).toEqual(['bootstrap_blind_id']);
    expect(forbiddenSignedStubKeys({ a: { room_blind_id: 'x' } })).toEqual(['room_blind_id']);
    expect(forbiddenSignedStubKeys(SIGNED_STUB)).toEqual([]);
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
    expect(
      privateRoomStubUpdateRequestSchema.safeParse({
        stub_signature:
          'pUOZfYTxJ5g1DAm97yzbFxv0HtPkpfgIry_rDFYmMAm_e1fNo_tkAcgXDt6Ecbtv53kTloLE6i_N5OMKpb47OQ',
      }).success,
    ).toBe(false);
    expect(
      privateRoomStubUpdateRequestSchema.safeParse({
        signed_stub: SIGNED_STUB,
        stub_signature:
          'pUOZfYTxJ5g1DAm97yzbFxv0HtPkpfgIry_rDFYmMAm_e1fNo_tkAcgXDt6Ecbtv53kTloLE6i_N5OMKpb47OQ',
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
        bootstrap_hints: [{ kind: 'manual', value: 'BbOr8leaXrZkA814vlV_2GBjOh_iEDx2QgMN7-MsZX8' }],
        latest_manifest_commitment: 'Muh7CwUy5QuoJ8Hj5dzRVLOgJxwBRE-fnw7RkinJrAE',
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
      { latest_manifest_commitment: 'Muh7CwUy5QuoJ8Hj5dzRVLOgJxwBRE-fnw7RkinJrAE' },
      ACCOUNT,
    );
    expect(updated.ok && updated.value.latest_manifest_commitment).toBe(
      'Muh7CwUy5QuoJ8Hj5dzRVLOgJxwBRE-fnw7RkinJrAE',
    );
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

describe('non-owner refusals — the oracle rule, in one place', () => {
  it('answers not_found for an UNLISTED record and forbidden for a listed one', async () => {
    const svc = freshService();
    const listed = await svc.create(listedRequest(), ACCOUNT);
    const unlisted = await svc.create(unlistedRequest(), ACCOUNT);
    if (!listed.ok || !unlisted.ok) throw new Error('create failed');

    // An unlisted record's EXISTENCE is what the blind token protects, so a
    // mutation route that answered `forbidden` would hand it back for free —
    // §15.3.1 through a status code instead of a response body. A listed
    // record's existence is public by its creator's own choice.
    for (const [target, expected] of [
      [unlisted.value.room_server_id, 'not_found'],
      [listed.value.room_server_id, 'forbidden'],
    ] as const) {
      const patched = await svc.update(target, { rendezvous_policy: 'manual_only' }, OTHER_ACCOUNT);
      const removed = await svc.remove(target, OTHER_ACCOUNT);
      const delisted = await svc.delist(target, OTHER_ACCOUNT);
      expect(patched.ok === false && patched.reason).toBe(expected);
      expect(removed.ok === false && removed.reason).toBe(expected);
      expect(delisted.ok === false && delisted.reason).toBe(expected);
    }
  });
});

describe('delist — what the audit trail is told', () => {
  it('reports staff_action only when staff authority was ACTUALLY used', async () => {
    const svc = freshService();
    const listed = await svc.create(listedRequest(), ACCOUNT);
    if (!listed.ok) throw new Error('create failed');

    // The CREATOR takes the owner arm even holding staff powers, so an audit
    // entry saying staff acted against somebody else's record would be false.
    const own = await svc.delist(listed.value.room_server_id, ACCOUNT, { staff: true });
    expect(own.ok && own.value.staff_action).toBe(false);

    // …and an idempotent owner delist of an already-unlisted record demotes
    // nothing, so it must not record a `listed → unlisted` that did not happen.
    const again = await svc.delist(listed.value.room_server_id, ACCOUNT, { staff: true });
    expect(again.ok && again.value.staff_action).toBe(false);
  });

  it('does not attribute to staff a delist the owner performed first', async () => {
    // The staff arm's write is conditional on the record still being LISTED, so
    // the write decides — a read moments earlier can observe `listed` while the
    // owner delists in between, and an idempotent write would then succeed and
    // be recorded as staff moderation of a transition somebody else made.
    const svc = freshService();
    const listed = await svc.create(listedRequest(), ACCOUNT);
    if (!listed.ok) throw new Error('create failed');
    await svc.delist(listed.value.room_server_id, ACCOUNT);
    const staff = await svc.delist(listed.value.room_server_id, OTHER_ACCOUNT, { staff: true });
    // Same `not_found` a non-owner already gets for a record that is not listed.
    expect(staff.ok).toBe(false);
    expect(staff.ok === false && staff.reason).toBe('not_found');
  });

  it('reports staff_action for a non-owner acting on a listed record', async () => {
    const svc = freshService();
    const listed = await svc.create(listedRequest(), ACCOUNT);
    if (!listed.ok) throw new Error('create failed');
    const staff = await svc.delist(listed.value.room_server_id, OTHER_ACCOUNT, { staff: true });
    expect(staff.ok && staff.value.staff_action).toBe(true);
  });
});

describe('§21.3 — a record cannot change who signed it', () => {
  it('refuses a signed body carrying a different room_public_key', async () => {
    // `directoryStubPayload()` signs with the DEVICE's key, and the owning
    // account can reach the refresh control from a joined device — so a patch
    // that carried the body would re-identify the record under a key members do
    // not know, and every verifier would read an honest record as forged.
    const svc = freshService();
    const created = await svc.create(listedRequest(), ACCOUNT);
    if (!created.ok) throw new Error('create failed');
    const result = await svc.update(
      created.value.room_server_id,
      {
        signed_stub: {
          ...SIGNED_STUB,
          room_public_key: '2SmKENGwc1g33EvYXaxkGw887yekfl1TpU8vP1svz_o',
        },
        stub_signature:
          'pUOZfYTxJ5g1DAm97yzbFxv0HtPkpfgIry_rDFYmMAm_e1fNo_tkAcgXDt6Ecbtv53kTloLE6i_N5OMKpb47OQ',
      },
      ACCOUNT,
    );
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toBe('identity_change');
  });

  it('allows a re-signed body that keeps the same identity', async () => {
    const svc = freshService();
    const created = await svc.create(listedRequest(), ACCOUNT);
    if (!created.ok) throw new Error('create failed');
    const result = await svc.update(
      created.value.room_server_id,
      {
        signed_stub: SIGNED_STUB,
        stub_signature:
          'bj9hfDw3s1fYlzBBPvvBHWfz8IBZGDm3EXZMiRTV54EBt0iB5ZM5iXKxzspGUyoOixlFO34poTRTcGW0df_Xkg',
      },
      ACCOUNT,
    );
    expect(result.ok).toBe(true);
  });
});

describe('§8.2 bootstrap hints — pointers, not a value channel', () => {
  it('refuses free text, key-like material and content in a hint value', () => {
    for (const hint of [
      { kind: 'licio_blind', value: 'a private message about the meeting' },
      { kind: 'manual', value: 'Ask Alice - she is at the community centre' },
      { kind: 'member_relay', value: 'wss://relay.example/?payload=some-room-content' },
      { kind: 'member_relay', value: 'wss://user:secret@relay.example/' },
      { kind: 'member_relay', value: 'file:///etc/passwd' },
    ]) {
      expect(
        privateRoomCreateStubRequestSchema.safeParse(rawRequest({ bootstrap_hints: [hint] }))
          .success,
        `expected ${hint.kind}:${hint.value} to be rejected`,
      ).toBe(false);
    }
  });

  it('refuses a hint value that is not the primitive’s exact size', () => {
    // A blind id IS an HMAC-SHA256 output. `1..512 base64url` left sixteen
    // hints × hundreds of bytes as a content path through a field whose name
    // says pointer.
    for (const value of ['c2hvcnQ', `${'A'.repeat(200)}`]) {
      expect(
        privateRoomCreateStubRequestSchema.safeParse(
          rawRequest({ bootstrap_hints: [{ kind: 'licio_blind', value }] }),
        ).success,
        `expected ${value.length}-char blind hint to be rejected`,
      ).toBe(false);
    }
  });

  it('accepts the pointer each kind is FOR', () => {
    for (const hint of [
      { kind: 'licio_blind', value: 'PEaenWxYddN6Q_NT1PiOYfz4EsZu7jRXRlpAsNpBU-A' },
      { kind: 'manual', value: 'BbOr8leaXrZkA814vlV_2GBjOh_iEDx2QgMN7-MsZX8' },
      { kind: 'member_relay', value: 'wss://relay.example/p2p' },
      { kind: 'member_relay', value: 'https://relay.example' },
    ]) {
      expect(
        privateRoomCreateStubRequestSchema.safeParse(rawRequest({ bootstrap_hints: [hint] }))
          .success,
        `expected ${hint.kind}:${hint.value} to be accepted`,
      ).toBe(true);
    }
  });
});

describe('§21.3 display patch — atomic with the mode it depends on', () => {
  it('refuses a display patch against a record delisted underneath it', async () => {
    const svc = freshService();
    const created = await svc.create(listedRequest(), ACCOUNT);
    if (!created.ok) throw new Error('create failed');
    // Simulate the race by delisting first: the service's mode check ran on a
    // `listed` record in the real race, and the write lands on an unlisted one.
    await svc.delist(created.value.room_server_id, ACCOUNT);
    const patched = await svc.update(
      created.value.room_server_id,
      { display_name: 'Snuck in' },
      ACCOUNT,
    );
    // Refused — and NOT by producing an unlisted record carrying a public name,
    // which is what the in-memory adapter used to do while Postgres 500ed.
    expect(patched.ok).toBe(false);
    const after = await svc.bootstrap(created.value.room_server_id, TOKEN);
    expect(after.ok && after.value.display_name).toBeNull();
  });
});

describe('§4.2 directory — a listed room is one that can actually be found', () => {
  it('treats a cursor whose id is not a uuid as no cursor, not a 500', async () => {
    // The Drizzle adapter compares this half against a `uuid` column, so a
    // mangled link on an UNAUTHENTICATED route would make Postgres reject the
    // statement. Fail-closed to the first page, like every other bad shape.
    const svc = freshService();
    await svc.create(listedRequest(), ACCOUNT);
    const page = await svc.listDirectory({ cursor: '2026-08-03T00:00:00.000Z|not-a-uuid' });
    expect(page.entries).toHaveLength(1);
  });

  it('enumerates listed rooms and NEVER an unlisted one', async () => {
    const svc = freshService();
    const listed = await svc.create(listedRequest(), ACCOUNT);
    const hidden = await svc.create(unlistedRequest(), ACCOUNT);
    if (!listed.ok || !hidden.ok) throw new Error('create failed');

    const page = await svc.listDirectory({});
    expect(page.entries.map((e) => e.room_server_id)).toEqual([listed.value.room_server_id]);
    expect(page.next_cursor).toBeNull();
  });

  it('never publishes the signed stub — browsing must not hand out the bootstrap token', async () => {
    const svc = freshService();
    const created = await svc.create(listedRequest(), ACCOUNT);
    if (!created.ok) throw new Error('create failed');
    const [entry] = (await svc.listDirectory({})).entries;
    // The token gates every UNLISTED record, and a listed room can be delisted
    // tomorrow — so a directory row that carried `signed_stub` would leak the
    // capability for every room that ever changes mode.
    expect(JSON.stringify(entry)).not.toContain(TOKEN);
    expect(entry).not.toHaveProperty('signed_stub');
    expect(entry).not.toHaveProperty('room_public_key');
  });

  it('drops a room from the directory the moment it is delisted', async () => {
    const svc = freshService();
    const created = await svc.create(listedRequest(), ACCOUNT);
    if (!created.ok) throw new Error('create failed');
    await svc.delist(created.value.room_server_id, ACCOUNT);
    expect((await svc.listDirectory({})).entries).toEqual([]);
  });

  it('pages with a keyset cursor that neither repeats nor skips a row', async () => {
    const svc = freshService();
    const ids: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      const created = await svc.create(listedRequest(), ACCOUNT);
      if (!created.ok) throw new Error('create failed');
      ids.push(created.value.room_server_id);
    }
    const first = await svc.listDirectory({ limit: 2 });
    expect(first.entries).toHaveLength(2);
    expect(first.next_cursor).not.toBeNull();

    const seen = [...first.entries.map((e) => e.room_server_id)];
    let cursor = first.next_cursor;
    while (cursor !== null) {
      const page = await svc.listDirectory({ limit: 2, cursor });
      seen.push(...page.entries.map((e) => e.room_server_id));
      cursor = page.next_cursor;
    }
    expect(new Set(seen).size).toBe(5);
    expect([...seen].sort()).toEqual([...ids].sort());
  });

  it('treats a mangled cursor as no cursor rather than failing the browse', async () => {
    const svc = freshService();
    await svc.create(listedRequest(), ACCOUNT);
    const page = await svc.listDirectory({ cursor: 'not-a-cursor' });
    expect(page.entries).toHaveLength(1);
  });

  it('serves the directory over GET /v1/private-rooms/directory without a session', async () => {
    const svc = freshService();
    setPrivateRoomStubService(svc);
    await svc.create(listedRequest(), ACCOUNT);
    const res = await createApp().request('/v1/private-rooms/directory');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { entries: { display_name: string }[] };
    expect(body.entries[0]?.display_name).toBe('Neighbourhood watch');
  });

  it('rejects an out-of-range limit instead of silently clamping it', async () => {
    setPrivateRoomStubService(freshService());
    const res = await createApp().request('/v1/private-rooms/directory?limit=5000');
    expect(res.status).toBe(400);
  });
});

describe('owner reads — paged, and complete where completeness is the point', () => {
  it('pages `/mine` while the EXPORT still returns everything', async () => {
    const svc = freshService();
    for (let i = 0; i < 3; i += 1) await svc.create(listedRequest(), ACCOUNT);

    const first = await svc.listForAccountPage(ACCOUNT, { limit: 2 });
    expect(first.stubs).toHaveLength(2);
    expect(first.next_cursor).not.toBeNull();

    const seen = first.stubs.map((stub) => stub.room_server_id);
    let cursor = first.next_cursor;
    while (cursor !== null) {
      const page = await svc.listForAccountPage(ACCOUNT, { limit: 2, cursor });
      seen.push(...page.stubs.map((stub) => stub.room_server_id));
      cursor = page.next_cursor;
    }
    expect(new Set(seen).size).toBe(3);

    // The Art. 15 archive iterates those pages to completion: an export that
    // truncates is not an export.
    expect(await svc.exportForAccount(ACCOUNT)).toHaveLength(3);
  });
});

describe('the targeted owner lookup', () => {
  it('finds ONE record by room id or by the room’s signing key', async () => {
    const svc = freshService();
    const mine = await svc.create(listedRequest(), ACCOUNT);
    await svc.create(listedRequest(), OTHER_ACCOUNT);
    if (!mine.ok) throw new Error('create failed');

    expect(
      (await svc.findOwnedStub(ACCOUNT, { roomServerId: mine.value.room_server_id }))
        ?.room_server_id,
    ).toBe(mine.value.room_server_id);
    // By the room's own signing key — how a client identifies a record whose
    // SERVER id it never learned, after a create whose response was lost.
    expect(
      (await svc.findOwnedStub(ACCOUNT, { roomPublicKey: SIGNED_STUB.room_public_key }))
        ?.room_server_id,
    ).toBe(mine.value.room_server_id);
  });

  it('answers null for another account’s record rather than finding it', async () => {
    const svc = freshService();
    const theirs = await svc.create(listedRequest(), OTHER_ACCOUNT);
    if (!theirs.ok) throw new Error('create failed');
    expect(
      await svc.findOwnedStub(ACCOUNT, { roomServerId: theirs.value.room_server_id }),
    ).toBeNull();
  });
});

describe('Art. 15 — the export discloses exactly what the purge removes', () => {
  it("exports every stub the account created, and none of anyone else's", async () => {
    const svc = freshService();
    await svc.create(listedRequest(), ACCOUNT);
    await svc.create(unlistedRequest(), ACCOUNT);
    await svc.create(listedRequest(), OTHER_ACCOUNT);

    const mine = await svc.exportForAccount(ACCOUNT);
    expect(mine).toHaveLength(2);
    expect(mine.map((row) => row.directory_mode).sort()).toEqual(['listed', 'unlisted']);
    // The account's own signed body IS its own data — this is the one place it
    // belongs, because the account's device authored it.
    expect(mine[0]?.signed_stub).toEqual(SIGNED_STUB);
    // …and so is the capability, which the purge deletes with the row. Never
    // projected to a READER; Art. 15 asks what is HELD about the account, and
    // it is also what makes the archive actionable — with it they can resolve
    // and remove a record they have lost the local handle to.
    expect(mine[0]?.bootstrap_blind_id).toBe(TOKEN);
  });

  it('exports nothing once the purge has run — the two agree by construction', async () => {
    const svc = freshService();
    await svc.create(listedRequest(), ACCOUNT);
    await svc.create(unlistedRequest(), ACCOUNT);
    expect(await svc.exportForAccount(ACCOUNT)).toHaveLength(2);

    expect(await svc.purgeForAccount(ACCOUNT)).toBe(2);
    expect(await svc.exportForAccount(ACCOUNT)).toEqual([]);
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

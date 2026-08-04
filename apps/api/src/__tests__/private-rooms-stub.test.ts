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

import { randomUUID } from 'node:crypto';
import {
  canonicalDirectoryStubBytes,
  canonicalRegistrationProofBytes,
  defaultPersonalizationSettings,
  defaultPrivacySettings,
  type SignedDirectoryStubBody,
} from '@licio/shared';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../app.js';
import { getIdentityServices } from '../identity/services.js';
import { createSession } from '../identity/sessions.js';
import { getModerationServices } from '../moderation/services.js';
import { PrivateRoomStubService, setPrivateRoomStubService } from '../private-rooms/service.js';
import {
  forbiddenSignedStubKeys,
  InMemoryPrivateRoomStubStore,
  type PrivateRoomCreateStubRequest,
  privateRoomCreateStubRequestSchema,
  privateRoomStubUpdateRequestSchema,
  RoomAlreadyRegisteredError,
  SIGNED_STUB_TOO_DEEP,
} from '../private-rooms/stores.js';

const ACCOUNT = '11111111-1111-4111-8111-111111111111';
const OTHER_ACCOUNT = '22222222-2222-4222-8222-222222222222';
const TOKEN = 'PEaenWxYddN6Q_NT1PiOYfz4EsZu7jRXRlpAsNpBU-A';
const MANIFEST_COMMITMENT = 'BbOr8leaXrZkA814vlV_2GBjOh_iEDx2QgMN7-MsZX8';

/**
 * REAL room keys, because registration now proves possession.
 *
 * The fixtures used to carry an invented `room_public_key` and an unrelated
 * 64-byte `stub_signature`, which is precisely the forgery the server refuses:
 * a founder public key is public, so the signature is the only evidence that
 * the caller holds the room. A pool is generated once (Ed25519 keygen is not
 * free) and handed out one room at a time.
 */
interface RoomKeys {
  readonly publicKey: string;
  readonly privateKey: CryptoKey;
}
const ROOM_KEYS: RoomKeys[] = [];
let roomKeyAt = 0;

async function mintRoomKeys(count: number): Promise<void> {
  const { webcrypto } = await import('node:crypto');
  for (let i = 0; i < count; i += 1) {
    const pair = (await webcrypto.subtle.generateKey({ name: 'Ed25519' }, true, [
      'sign',
      'verify',
    ])) as unknown as { publicKey: CryptoKey; privateKey: CryptoKey };
    const raw = new Uint8Array(await webcrypto.subtle.exportKey('raw', pair.publicKey));
    ROOM_KEYS.push({
      publicKey: Buffer.from(raw).toString('base64url'),
      privateKey: pair.privateKey,
    });
  }
}

/** Sign `message` with a room key. */
async function signWith(keys: RoomKeys, message: Uint8Array): Promise<string> {
  const { webcrypto } = await import('node:crypto');
  const bytes = new Uint8Array(new ArrayBuffer(message.byteLength));
  bytes.set(message);
  const signature = new Uint8Array(
    await webcrypto.subtle.sign({ name: 'Ed25519' }, keys.privateKey, bytes),
  );
  return Buffer.from(signature).toString('base64url');
}

/**
 * A genuinely signed §8.2 body for the NEXT room in the pool, plus the
 * account-bound registration proof.
 *
 * Both, because the stub signature is static and public — replaying it proves
 * only that the replayer has seen a record — so registration also requires a
 * proof over `(room key, commitment, ACCOUNT)`.
 */
async function signedBody(
  keys: RoomKeys,
  accountId: string = ACCOUNT,
): Promise<{
  signed_stub: SignedDirectoryStubBody;
  stub_signature: string;
  registration_proof: string;
}> {
  const body = {
    schema: 'licio.private.directory_stub.v2' as const,
    room_public_key: keys.publicKey,
    manifest_key_commitment: MANIFEST_COMMITMENT,
  };
  return {
    signed_stub: body,
    stub_signature: await signWith(keys, canonicalDirectoryStubBytes(body)),
    registration_proof: await signWith(
      keys,
      canonicalRegistrationProofBytes({
        room_public_key: body.room_public_key,
        manifest_key_commitment: body.manifest_key_commitment,
        account_id: accountId,
      }),
    ),
  };
}

/** The DEFAULT room every fixture uses unless a test asks for another. */
let SIGNED_STUB: SignedDirectoryStubBody;
let SIGNATURE: string;
let REGISTRATION_PROOF: string;
/** The default room's keys, for the cases that register under ANOTHER account:
 *  the proof is account-bound, so it has to be signed for that account. */
let DEFAULT_KEYS: RoomKeys;

/** A registration proof over the default room, for `accountId`. */
async function proofFor(accountId: string, keys: RoomKeys = DEFAULT_KEYS): Promise<string> {
  return await signWith(
    keys,
    canonicalRegistrationProofBytes({
      room_public_key: keys.publicKey,
      manifest_key_commitment: MANIFEST_COMMITMENT,
      account_id: accountId,
    }),
  );
}

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
/**
 * A body for a DIFFERENT room.
 *
 * A room has ONE record, and re-registering it adopts rather than mints — that
 * is what makes a retry converge — so a test that wants two RECORDS has to
 * describe two ROOMS. Passing this explicitly keeps the common fixture
 * deterministic and makes "these are separate rooms" visible at the call site.
 */
const PRESIGNED: Array<{
  signed_stub: SignedDirectoryStubBody;
  stub_signature: string;
  registration_proof: string;
  keys: RoomKeys;
}> = [];
function anotherRoom(): {
  signed_stub: PrivateRoomCreateStubRequest['signed_stub'];
  stub_signature: string;
  registration_proof: string;
} {
  const next = PRESIGNED[roomKeyAt++];
  if (!next) throw new Error('room-key pool exhausted — mint more in beforeAll');
  const { keys: _keys, ...request } = next;
  return request;
}

/** The same, with the proof signed for `accountId` rather than the default. */
async function anotherRoomFor(accountId: string): Promise<{
  signed_stub: PrivateRoomCreateStubRequest['signed_stub'];
  stub_signature: string;
  registration_proof: string;
}> {
  const next = PRESIGNED[roomKeyAt++];
  if (!next) throw new Error('room-key pool exhausted — mint more in beforeAll');
  const { keys, ...request } = next;
  return { ...request, registration_proof: await proofFor(accountId, keys) };
}

function listedRequest(
  over: Partial<PrivateRoomCreateStubRequest> = {},
): PrivateRoomCreateStubRequest {
  return {
    directory_mode: 'listed',
    display_name: 'Neighbourhood watch',
    rendezvous_policy: 'licio_blind',
    signed_stub: SIGNED_STUB,
    stub_signature: SIGNATURE,
    registration_proof: REGISTRATION_PROOF,
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
    stub_signature: SIGNATURE,
    registration_proof: REGISTRATION_PROOF,
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

/** One pool for the whole file: 40 rooms is more than any case needs, and
 *  Ed25519 keygen is the only slow thing here. */
beforeAll(async () => {
  await mintRoomKeys(40);
  const first = ROOM_KEYS[roomKeyAt++];
  if (!first) throw new Error('no room keys');
  DEFAULT_KEYS = first;
  const signed = await signedBody(first);
  SIGNED_STUB = signed.signed_stub;
  SIGNATURE = signed.stub_signature;
  REGISTRATION_PROOF = signed.registration_proof;
  for (let at = roomKeyAt; at < ROOM_KEYS.length; at += 1) {
    const keys = ROOM_KEYS[at];
    if (keys) PRESIGNED.push({ ...(await signedBody(keys)), keys });
  }
  roomKeyAt = 0;
});

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
    const unlisted = await svc.create(unlistedRequest(anotherRoom()), ACCOUNT);
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
    // A non-owner cannot through the ordinary path.
    expect((await svc.delist(room, OTHER_ACCOUNT)).ok).toBe(false);
    // §11.4: staff hold exactly this one power, and it is exercised through the
    // AUDITED unit — there is no flag on the ordinary path that would let it
    // happen without the record.
    const staffed = await svc.delistListed(room);
    expect(staffed).not.toBeNull();
    expect(staffed?.display_name).toBe(null);
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
    // A DIFFERENT room for the other account: one room has one record, so two
    // accounts holding records means two rooms.
    const theirs = await svc.create(
      listedRequest(await anotherRoomFor(OTHER_ACCOUNT)),
      OTHER_ACCOUNT,
    );
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
    const unlisted = await svc.create(unlistedRequest(anotherRoom()), ACCOUNT);
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

describe('§21.4 delist — the owner arm, and the audited staff arm', () => {
  it('is idempotent for the OWNER and needs no record', async () => {
    const svc = freshService();
    const listed = await svc.create(listedRequest(), ACCOUNT);
    if (!listed.ok) throw new Error('create failed');
    expect((await svc.delist(listed.value.room_server_id, ACCOUNT)).ok).toBe(true);
    // Again, on an already-unlisted record: still fine. No platform power is
    // being exercised, so there is nothing to record.
    expect((await svc.delist(listed.value.room_server_id, ACCOUNT)).ok).toBe(true);
  });

  it('offers NO unaudited staff path — a non-owner is refused here', async () => {
    // §11.4's single platform power has to commit with its audit record, so it
    // lives in the moderation unit (`delistListed`) and not behind a flag on
    // this method. A second, unaudited path would be a way to exercise that
    // power without the record.
    const svc = freshService();
    const listed = await svc.create(listedRequest(), ACCOUNT);
    if (!listed.ok) throw new Error('create failed');
    const other = await svc.delist(listed.value.room_server_id, OTHER_ACCOUNT);
    expect(other.ok).toBe(false);
  });

  it('delistListed demotes only a LISTED record, so the write proves there was one', async () => {
    const svc = freshService();
    const listed = await svc.create(listedRequest(), ACCOUNT);
    if (!listed.ok) throw new Error('create failed');

    expect(await svc.delistListed(listed.value.room_server_id)).not.toBeNull();
    // Again: nothing matches, which is how the unit learns the owner got there
    // first and no staff demotion should be recorded.
    expect(await svc.delistListed(listed.value.room_server_id)).toBeNull();
    expect(await svc.delistListed('00000000-0000-4000-8000-999999999999')).toBeNull();
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
    // The room's OWN signature, not merely a 64-byte string: a PATCH replaces
    // the pair every member verifies at bootstrap, so it has to verify here for
    // the same reason a create does.
    const result = await svc.update(
      created.value.room_server_id,
      { signed_stub: SIGNED_STUB, stub_signature: SIGNATURE },
      ACCOUNT,
    );
    expect(result.ok).toBe(true);
  });

  it('REFUSES a replacement body the room did not sign', async () => {
    // The schema checks the signature's SIZE, which is a different question:
    // without this, a buggy or malicious client could leave the room's key
    // attached to a body nobody signed, and every member would then reject the
    // record at bootstrap — broken by its own creator.
    const svc = freshService();
    const created = await svc.create(listedRequest(), ACCOUNT);
    if (!created.ok) throw new Error('create failed');
    const result = await svc.update(
      created.value.room_server_id,
      {
        signed_stub: SIGNED_STUB,
        stub_signature: Buffer.from(new Uint8Array(64).fill(9)).toString('base64url'),
      },
      ACCOUNT,
    );
    expect(result).toEqual({ ok: false, reason: 'signature_invalid' });
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
      // The parts a "no query, no fragment" rule leaves free: an arbitrary path
      // carries a payload just as well.
      { kind: 'member_relay', value: `https://relay.example/${'A'.repeat(60)}` },
      { kind: 'member_relay', value: 'https://relay.example/a/b' },
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
      { kind: 'member_relay', value: 'wss://relay.example' },
      { kind: 'member_relay', value: 'https://relay.example/' },
      { kind: 'member_relay', value: 'wss://relay.example:8443' },
      // At most ONE path segment, and it is a blind id — the only pointer a
      // relay endpoint needs to carry.
      {
        kind: 'member_relay',
        value: 'wss://relay.example/PEaenWxYddN6Q_NT1PiOYfz4EsZu7jRXRlpAsNpBU-A',
      },
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
    const hidden = await svc.create(unlistedRequest(anotherRoom()), ACCOUNT);
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
      const created = await svc.create(listedRequest(anotherRoom()), ACCOUNT);
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

  it('treats a mangled cursor as no cursor INSIDE the service — the route refuses it', async () => {
    // Defensive at the parser (a mangled link must never 500 an unauthenticated
    // route) and REFUSED at the boundary: silently answering page one is what a
    // paging client appends forever, duplicating rows on every scroll.
    const svc = freshService();
    await svc.create(listedRequest(), ACCOUNT);
    const page = await svc.listDirectory({ cursor: 'not-a-cursor' });
    expect(page.entries).toHaveLength(1);
  });

  it('answers 400 for a malformed cursor rather than the first page again', async () => {
    setPrivateRoomStubService(freshService());
    const app = createApp();
    expect((await app.request('/v1/private-rooms/directory?cursor=garbage')).status).toBe(400);
    // The valid grammar still pages.
    const ok = await app.request(
      `/v1/private-rooms/directory?cursor=${encodeURIComponent('2026-08-02T00:00:00.000Z|11111111-1111-4111-8111-111111111111')}`,
    );
    expect(ok.status).toBe(200);
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
    for (let i = 0; i < 3; i += 1) await svc.create(listedRequest(anotherRoom()), ACCOUNT);

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

describe('§11.4 — an abusive LISTED name has an intake', () => {
  it('reports a listed record as publicly listed, and an unlisted one as not', async () => {
    const svc = freshService();
    const listed = await svc.create(listedRequest(), ACCOUNT);
    const unlisted = await svc.create(unlistedRequest(anotherRoom()), ACCOUNT);
    if (!listed.ok || !unlisted.ok) throw new Error('create failed');

    // A listed room publishes its name to anyone browsing, so answering this
    // reveals nothing that is not already public — and staff delisting it is
    // the remedy §11.4 specifies, which needs a way in.
    expect(await svc.isPubliclyListed(listed.value.room_server_id)).toBe(true);
    // An unlisted room and an unknown id answer ALIKE, which is what keeps this
    // from becoming the oracle the bootstrap read refuses to be.
    expect(await svc.isPubliclyListed(unlisted.value.room_server_id)).toBe(false);
    expect(await svc.isPubliclyListed('00000000-0000-4000-8000-999999999999')).toBe(false);
    // …and it stops being reportable the moment it is delisted.
    await svc.delist(listed.value.room_server_id, ACCOUNT);
    expect(await svc.isPubliclyListed(listed.value.room_server_id)).toBe(false);
  });
});

describe('registration proves POSSESSION of the room key', () => {
  /** A real room key pair + a genuinely signed v2 body. */
  async function signedRequest(): Promise<{
    request: PrivateRoomCreateStubRequest;
    publicKey: string;
  }> {
    const { webcrypto } = await import('node:crypto');
    const pair = (await webcrypto.subtle.generateKey({ name: 'Ed25519' }, true, [
      'sign',
      'verify',
    ])) as unknown as { publicKey: CryptoKey; privateKey: CryptoKey };
    const raw = new Uint8Array(await webcrypto.subtle.exportKey('raw', pair.publicKey));
    const publicKey = Buffer.from(raw).toString('base64url');
    const body = {
      schema: 'licio.private.directory_stub.v2' as const,
      room_public_key: publicKey,
      manifest_key_commitment: SIGNED_STUB.manifest_key_commitment,
    };
    const keys: RoomKeys = { publicKey, privateKey: pair.privateKey };
    return {
      publicKey,
      request: listedRequest({
        signed_stub: body,
        stub_signature: await signWith(keys, canonicalDirectoryStubBytes(body)),
        registration_proof: await signWith(
          keys,
          canonicalRegistrationProofBytes({
            room_public_key: publicKey,
            manifest_key_commitment: body.manifest_key_commitment,
            account_id: ACCOUNT,
          }),
        ),
      }),
    };
  }

  it('accepts a record the room actually signed', async () => {
    const svc = freshService();
    const { request } = await signedRequest();
    const created = await svc.create(request, ACCOUNT);
    expect(created.ok).toBe(true);
  });

  it('REFUSES a REPLAY of a published pair under another account', async () => {
    // The stub signature is static and PUBLIC: a `listed` record serves the pair
    // to anyone browsing, and an unlisted one to any invitee. Replaying it after
    // the owner removes their record would otherwise take the room-key
    // uniqueness under the replayer's account — with arbitrary display metadata,
    // and permanently. The account-bound proof is what makes the replay useless.
    const svc = freshService();
    const { request } = await signedRequest();
    const created = await svc.create(request, ACCOUNT);
    if (!created.ok) throw new Error('create failed');
    await svc.remove(created.value.room_server_id, ACCOUNT);

    // The observer has everything the record published, and signs nothing.
    expect(await svc.create(request, OTHER_ACCOUNT)).toEqual({
      ok: false,
      reason: 'signature_invalid',
    });
  });

  it('REFUSES a squat: the founder key is public, the signature is the only proof', async () => {
    // A room'''s founder public key rides every invite and appears in every
    // published record, so it is not a secret. Once one record per room made it
    // the uniqueness key, an unverified create let anyone who had seen one take
    // the row under their own account — after which the founder is refused their
    // own room forever and only the squatter can remove the forgery.
    const svc = freshService();
    const { request, publicKey } = await signedRequest();
    const forged = listedRequest({
      signed_stub: {
        schema: 'licio.private.directory_stub.v2',
        room_public_key: publicKey,
        manifest_key_commitment: SIGNED_STUB.manifest_key_commitment,
      },
      // Correctly SIZED and utterly unrelated — the shape checks pass.
      stub_signature: Buffer.from(new Uint8Array(64).fill(7)).toString('base64url'),
    });
    expect(await svc.create(forged, OTHER_ACCOUNT)).toEqual({
      ok: false,
      reason: 'signature_invalid',
    });
    // …and the room'''s own registration still succeeds afterwards.
    expect((await svc.create(request, ACCOUNT)).ok).toBe(true);
  });

  it('refuses a body whose signature covers DIFFERENT bytes', async () => {
    const svc = freshService();
    const { request } = await signedRequest();
    const tampered = listedRequest({
      signed_stub: {
        ...(request.signed_stub as SignedDirectoryStubBody),
        manifest_key_commitment: 'BbOr8leaXrZkA814vlV_2GBjOh_iEDx2QgMN7-MsZY8',
      },
      stub_signature: request.stub_signature,
    });
    expect(await svc.create(tampered, ACCOUNT)).toEqual({
      ok: false,
      reason: 'signature_invalid',
    });
  });
});

describe('the staff delist is bound to the case it names', () => {
  /** A TOTP-cleared platform admin: the §21.4 staff bar is `admin` + a session
   *  whose MFA was verified THIS session, which is what `requireSteward`-grade
   *  actions demand. */
  async function staffSession(): Promise<{ cookie: string; token: string }> {
    const identity = getIdentityServices();
    const user = await identity.store.createUser(
      {
        handle: `staff${randomUUID().slice(0, 8)}`,
        displayName: 'Staff',
        email: null,
        accountState: 'active',
        locale: null,
        ageBand: 'adult',
        privacySettings: defaultPrivacySettings(),
        personalizationSettings: defaultPersonalizationSettings(),
        roles: ['user', 'admin'],
      },
      Date.now(),
    );
    await identity.store.setAuth(user.userId, { mfaEnabled: true });
    const { token: sid } = await createSession(identity.sessions, {
      userId: user.userId,
      authMethod: 'email_otp',
      deviceLabel: 'test',
      rememberMe: false,
      // Cleared THIS session, which is the §21.4 staff bar — an enrolled but
      // unverified session is exactly the stolen-cookie case it excludes.
      mfaVerified: true,
    });
    const cookie = `__Host-sid=${sid}`;
    const res = await createApp().request('/api/csrf-token', { headers: { Cookie: cookie } });
    const { token } = (await res.json()) as { token: string };
    return { cookie, token };
  }

  /** Wire the moderation unit to a real stub store, as the composition roots do. */
  function bindDelist(svc: PrivateRoomStubService, store: InMemoryPrivateRoomStubStore): void {
    const mod = getModerationServices();
    // The unit can only undo what it knows about — the same registration the
    // composition roots make.
    mod.registerRollback(store);
    mod.delistListedRoom = async (roomServerId: string) =>
      (await svc.delistListed(roomServerId)) !== null;
    mod.isPubliclyListedRoom = async (roomServerId: string) =>
      await svc.isPubliclyListed(roomServerId);
  }

  it('rolls the demotion BACK when the supplied case is not open for this room', async () => {
    // THROUGH THE ROUTE, deliberately. The previous version of this test built
    // its own unit and threw inside it, which proved the transactor rolls back
    // on a throw — a fact about `in-memory-unit-of-work.ts` — while the handler
    // it was written for threw nothing at all: `resolveIfOpen` returning null
    // merely dropped `case_id` from the audit row and committed the demotion.
    // `StaleDelistCaseError` and the whole `case_not_open` response existed and
    // were unreachable. A test that constructs the behaviour it is checking
    // cannot notice that.
    //
    // §21.3 does not make the mode patchable back, so a stale console click —
    // another reviewer resolved the case, or the id names a different room —
    // would otherwise apply the irreversible remedy, leave the named case open
    // in the queue with no mention of the enforcement, and answer 200.
    const store = new InMemoryPrivateRoomStubStore();
    const svc = new PrivateRoomStubService(store);
    setPrivateRoomStubService(svc);
    const created = await svc.create(listedRequest(), ACCOUNT);
    if (!created.ok) throw new Error('create failed');
    bindDelist(svc, store);

    const { cookie, token } = await staffSession();
    const res = await createApp().request(
      `/v1/private-rooms/${created.value.room_server_id}/delist`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          Cookie: cookie,
          'X-CSRF-Token': token,
        },
        body: JSON.stringify({ case_id: randomUUID() }),
      },
    );

    expect(res.status).toBe(409);
    expect((await res.json()) as { error: { code: string } }).toMatchObject({
      error: { code: 'case_not_open' },
    });
    // The record is STILL listed: the unit rolled the demotion back with the
    // refusal, rather than leaving the remedy applied without its case.
    expect(await svc.isPubliclyListed(created.value.room_server_id)).toBe(true);
  });

  it('delists and RESOLVES when the case is open for this room', async () => {
    // The other arm, so the rollback above is not passing for the trivial
    // reason that staff delisting never works through this route.
    const store = new InMemoryPrivateRoomStubStore();
    const svc = new PrivateRoomStubService(store);
    setPrivateRoomStubService(svc);
    const created = await svc.create(listedRequest(), ACCOUNT);
    if (!created.ok) throw new Error('create failed');
    bindDelist(svc, store);

    const mod = getModerationServices();
    const opened = await mod.cases.insert({
      caseId: randomUUID(),
      targetType: 'room',
      targetId: created.value.room_server_id,
      contentKind: null,
      status: 'new',
      severity: 'severe',
      routedTo: 'standard',
      assignedTo: null,
      reportCount: 1,
      enforcementDelayed: false,
      resolvedActionId: null,
      slaDueAt: new Date(Date.now() + 3_600_000).toISOString(),
    });

    const { cookie, token } = await staffSession();
    const res = await createApp().request(
      `/v1/private-rooms/${created.value.room_server_id}/delist`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          Cookie: cookie,
          'X-CSRF-Token': token,
        },
        body: JSON.stringify({ case_id: opened.caseId }),
      },
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ delisted: true });
    expect(await svc.isPubliclyListed(created.value.room_server_id)).toBe(false);
    // …and the case closed WITH the delist, not beside it.
    expect((await mod.cases.getById(opened.caseId))?.status).toBe('resolved');
  });
});

describe('ONE record per room — adopted by its owner, refused to anyone else', () => {
  it('adopts the existing record instead of minting a second', async () => {
    const svc = freshService();
    const first = await svc.create(listedRequest(), ACCOUNT);
    const again = await svc.create(listedRequest(), ACCOUNT);
    if (!first.ok || !again.ok) throw new Error('create failed');
    // A check-then-create is a TOCTOU; the store answers with the row that is
    // already there, so a retry converges rather than accumulating.
    expect(again.value.room_server_id).toBe(first.value.room_server_id);
    expect(await svc.exportForAccount(ACCOUNT)).toHaveLength(1);
  });

  it('refuses in the STORE, so a concurrent pair cannot both create', async () => {
    // The service's pre-check is a check: two registrations for the same room —
    // the same founder device signed into two accounts is the realistic pair —
    // both read "nothing there" before either write. Postgres has its unique
    // index to fall back on; the in-memory adapter is the whole authority in dev
    // and in the E2E harness, so it decides too, and both answer the loser the
    // same way.
    const store = new InMemoryPrivateRoomStubStore();
    const svc = new PrivateRoomStubService(store);
    const insert = (accountId: string) =>
      store.create({
        stubId: randomUUID(),
        roomServerId: randomUUID(),
        directoryMode: 'unlisted',
        displayName: null,
        displayDescription: null,
        displayAvatarPublicCid: null,
        rendezvousPolicy: 'licio_blind',
        bootstrapHints: [],
        signedStub: SIGNED_STUB,
        stubSignature:
          'pUOZfYTxJ5g1DAm97yzbFxv0HtPkpfgIry_rDFYmMAm_e1fNo_tkAcgXDt6Ecbtv53kTloLE6i_N5OMKpb47OQ',
        bootstrapBlindId: TOKEN,
        createdByAccountId: accountId,
      });
    await insert(ACCOUNT);
    await expect(insert(OTHER_ACCOUNT)).rejects.toThrow(RoomAlreadyRegisteredError);
    // …and the caller's OWN row is still adopted rather than duplicated.
    const mine = await insert(ACCOUNT);
    expect(await svc.exportForAccount(ACCOUNT)).toHaveLength(1);
    expect(mine.createdByAccountId).toBe(ACCOUNT);

    // …but the same ACCOUNT is not the same REGISTRATION.  The row is immutable
    // in the parts that matter, so adopting it for a request that asked for
    // something else reports success and hands the caller the opposite — a
    // wizard that requested `listed` dismissing on an `unlisted` record.
    await expect(
      store.create({
        stubId: randomUUID(),
        roomServerId: randomUUID(),
        directoryMode: 'listed',
        displayName: 'A different answer',
        displayDescription: null,
        displayAvatarPublicCid: null,
        rendezvousPolicy: 'licio_blind',
        bootstrapHints: [],
        signedStub: SIGNED_STUB,
        stubSignature:
          'pUOZfYTxJ5g1DAm97yzbFxv0HtPkpfgIry_rDFYmMAm_e1fNo_tkAcgXDt6Ecbtv53kTloLE6i_N5OMKpb47OQ',
        bootstrapBlindId: TOKEN,
        createdByAccountId: ACCOUNT,
      }),
    ).rejects.toThrow(RoomAlreadyRegisteredError);
    // …and nothing was created for it.
    expect(await svc.exportForAccount(ACCOUNT)).toHaveLength(1);
  });

  it('REFUSES another account registering a room that already has a record', async () => {
    // The record is the ROOM's public handle, not an account's possession: its
    // `room_server_id` is what invites carry and what the §4.2 directory
    // publishes. A second record lists the same room twice, under two ids and
    // two bootstrap capabilities, and a member who resolves the wrong one
    // reaches a shell nobody else is using.
    //
    // It needed no race: a founder DEVICE signed into a second account holds
    // the same epoch-0 key, and the old `(account, room)` uniqueness made that
    // a different key.
    const svc = freshService();
    const mine = await svc.create(listedRequest(), ACCOUNT);
    // A VALID proof for the other account — otherwise this would be refused for
    // the signature rather than for the room, and the test would prove neither.
    const theirs = await svc.create(
      listedRequest({ registration_proof: await proofFor(OTHER_ACCOUNT) }),
      OTHER_ACCOUNT,
    );
    if (!mine.ok) throw new Error('create failed');
    expect(theirs).toEqual({ ok: false, reason: 'room_already_registered' });
    // …and the first record is untouched — a refusal must not disturb it.
    expect(await svc.exportForAccount(ACCOUNT)).toHaveLength(1);
    expect(await svc.exportForAccount(OTHER_ACCOUNT)).toHaveLength(0);
  });

  it('refuses a NON-CANONICAL spelling of a room key — one room, one text', async () => {
    // Uniqueness is enforced on the TEXT (`private_room_stubs_room_key_uq`,
    // and `=` everywhere it is compared), while possession is proved against
    // the DECODED bytes. 32 bytes occupy 43 base64url characters with two bits
    // to spare, so a key has four spellings that decode identically — and every
    // one of them would satisfy the signature and the account-bound proof while
    // presenting to Postgres as a different room. That is the room-registration
    // uniqueness bypassed by editing one character, so the boundary takes only
    // the canonical spelling.
    const canonical = DEFAULT_KEYS.publicKey;
    const stem = canonical.slice(0, 42);
    const tail = canonical.slice(42);
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    const index = alphabet.indexOf(tail);
    const siblings = [1, 2, 3].map((offset) => stem + alphabet[(index & ~3) + (offset % 4)]);

    // The premise: same key bytes, different text.
    for (const sibling of siblings) {
      expect(sibling).not.toBe(canonical);
      expect(Buffer.from(sibling, 'base64url').toString('hex')).toBe(
        Buffer.from(canonical, 'base64url').toString('hex'),
      );
      const parsed = privateRoomCreateStubRequestSchema.safeParse(
        listedRequest({
          signed_stub: { ...SIGNED_STUB, room_public_key: sibling },
        }),
      );
      expect(parsed.success).toBe(false);
    }
    // …and the canonical spelling the client's encoder emits still passes.
    expect(privateRoomCreateStubRequestSchema.safeParse(listedRequest()).success).toBe(true);
  });
});

describe('a reported listing is captured before it can be edited', () => {
  it('snapshots what a LISTED room publishes, and nothing for an unlisted one', async () => {
    const svc = freshService();
    const listed = await svc.create(
      listedRequest({ display_name: 'Abusive name', display_description: 'Abusive text' }),
      ACCOUNT,
    );
    const hidden = await svc.create(unlistedRequest(anotherRoom()), ACCOUNT);
    if (!listed.ok || !hidden.ok) throw new Error('create failed');

    expect(await svc.listingSnapshot(listed.value.room_server_id)).toEqual({
      display_name: 'Abusive name',
      display_description: 'Abusive text',
      // The row's own mtime rides along: the capture is claimed as "the listing
      // as reported", and only this makes that claim checkable when a retry
      // records it later (§21.3 lets members edit the text in place).
      updated_at: expect.any(String),
    });
    // An unlisted room publishes nothing to capture; an unknown id answers the
    // same, so this cannot become an existence oracle either.
    expect(await svc.listingSnapshot(hidden.value.room_server_id)).toBeNull();
    expect(await svc.listingSnapshot('00000000-0000-4000-8000-999999999999')).toBeNull();
  });
});

describe('the owner lookup withholds the capability', () => {
  it('omits `bootstrap_blind_id` from /mine while the export keeps it', async () => {
    const svc = freshService();
    const created = await svc.create(listedRequest(), ACCOUNT);
    if (!created.ok) throw new Error('create failed');

    // Both `/mine` callers need only the id, so the token does not travel on a
    // polled endpoint where a cache or a log is one misconfiguration away.
    const found = await svc.findOwnedStub(ACCOUNT, {
      roomServerId: created.value.room_server_id,
    });
    expect(JSON.stringify(found)).not.toContain(TOKEN);
    const page = await svc.listForAccountPage(ACCOUNT, {});
    expect(JSON.stringify(page)).not.toContain(TOKEN);

    // …and the Art. 15 archive still discloses it: what the purge deletes, the
    // export declares.
    expect((await svc.exportForAccount(ACCOUNT))[0]?.bootstrap_blind_id).toBe(TOKEN);
  });

  it('withholds a MIGRATED v1 body, which is where the token lives on those rows', async () => {
    // The capability got its own column, but a preserved v1 record still
    // carries it INSIDE `signed_stub` — the migration left the body exactly as
    // it was signed, because the server holds no room key and cannot re-sign.
    // Dropping the column alone therefore withheld nothing for those rows: the
    // stable token rode the body straight back onto the polled endpoint the
    // column exists to keep it off.
    const store = new InMemoryPrivateRoomStubStore();
    const svc = new PrivateRoomStubService(store);
    await store.create({
      stubId: randomUUID(),
      roomServerId: randomUUID(),
      directoryMode: 'unlisted',
      displayName: null,
      displayDescription: null,
      displayAvatarPublicCid: null,
      rendezvousPolicy: 'licio_blind',
      bootstrapHints: [],
      // A v1 body, token and all — exactly what migration 0120 preserved.
      signedStub: {
        schema: 'licio.private.directory_stub.v1',
        room_public_key: SIGNED_STUB.room_public_key,
        manifest_key_commitment: SIGNED_STUB.manifest_key_commitment,
        bootstrap_blind_id: TOKEN,
      } as unknown as typeof SIGNED_STUB,
      stubSignature:
        'pUOZfYTxJ5g1DAm97yzbFxv0HtPkpfgIry_rDFYmMAm_e1fNo_tkAcgXDt6Ecbtv53kTloLE6i_N5OMKpb47OQ',
      bootstrapBlindId: TOKEN,
      createdByAccountId: ACCOUNT,
    });

    const page = await svc.listForAccountPage(ACCOUNT, {});
    expect(JSON.stringify(page)).not.toContain(TOKEN);
    // Withheld as a PAIR — a signature over a body the caller cannot see
    // verifies nothing.
    expect(page.stubs[0]?.signed_stub).toBeNull();
    expect(page.stubs[0]?.stub_signature).toBeNull();
    // …while the archive still declares the whole record.
    expect(JSON.stringify(await svc.exportForAccount(ACCOUNT))).toContain(TOKEN);
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
    // The proof is ACCOUNT-BOUND, so a record registered by another account is
    // signed for that account.
    const theirs = await svc.create(
      listedRequest({ registration_proof: await proofFor(OTHER_ACCOUNT) }),
      OTHER_ACCOUNT,
    );
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
    await svc.create(unlistedRequest(anotherRoom()), ACCOUNT);
    await svc.create(listedRequest(), OTHER_ACCOUNT);

    const mine = await svc.exportForAccount(ACCOUNT);
    expect(mine).toHaveLength(2);
    expect(mine.map((row) => row.directory_mode).sort()).toEqual(['listed', 'unlisted']);
    // The account's own signed body IS its own data — this is the one place it
    // belongs, because the account's device authored it.
    expect(mine.map((row) => row.signed_stub)).toContainEqual(SIGNED_STUB);
    // …and so is the capability, which the purge deletes with the row. Never
    // projected to a READER; Art. 15 asks what is HELD about the account, and
    // it is also what makes the archive actionable — with it they can resolve
    // and remove a record they have lost the local handle to.
    expect(mine[0]?.bootstrap_blind_id).toBe(TOKEN);
  });

  it('exports nothing once the purge has run — the two agree by construction', async () => {
    const svc = freshService();
    await svc.create(listedRequest(), ACCOUNT);
    await svc.create(unlistedRequest(anotherRoom()), ACCOUNT);
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

  it('never lets a bootstrap answer be cached — including the refusals', async () => {
    const svc = freshService();
    setPrivateRoomStubService(svc);
    const created = await svc.create(listedRequest(), ACCOUNT);
    if (!created.ok) throw new Error('create failed');
    const app2 = createApp();

    // A cached 404 from a wrong token, replayed to an invitee presenting the
    // right one, would lock a legitimate member out of their own room's record
    // — and a cached 200 would serve a capability-gated read to someone who
    // presented nothing. The URL no longer distinguishes them, so neither may
    // be stored.
    for (const path of [
      `/v1/private-rooms/${created.value.room_server_id}/bootstrap`,
      '/v1/private-rooms/00000000-0000-4000-8000-999999999999/bootstrap',
      '/v1/private-rooms/not-a-uuid/bootstrap',
    ]) {
      const res = await app2.request(path);
      expect(res.headers.get('cache-control'), path).toContain('no-store');
      expect(res.headers.get('vary'), path).toContain('x-licio-bootstrap-token');
    }
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

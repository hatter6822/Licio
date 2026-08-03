// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-S.1.2b — the §21.1–§21.4 directory-stub client.
//
// What is worth asserting here is the BOUNDARY, not the plumbing: the request
// body must carry only the §8.2-allowed fields (a stray content/member key
// would be rejected by the server, but the client should never form one), an
// `unlisted` create must not send display metadata, every response must be zod-
// validated before a caller can trust it, and the §21.2 refusal must surface as
// an ordinary not-found rather than as "exists but forbidden".
import { beforeEach, describe, expect, it, vi } from 'vitest';

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

const {
  createPrivateRoomStub,
  deletePrivateRoomStub,
  delistPrivateRoomStub,
  fetchPrivateRoomBootstrap,
  updatePrivateRoomStub,
} = await import('./private-rooms-api.js');

/** A CSRF-token response, then the real one — `apiFetch` fetches a fresh token
 *  before every mutation. */
function respondTo(mutation: unknown, status = 200): void {
  fetchMock.mockImplementation((input: RequestInfo | URL) => {
    if (String(input).includes('/api/csrf-token')) {
      return Promise.resolve(
        new Response(JSON.stringify({ token: 't' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    }
    return Promise.resolve(
      new Response(JSON.stringify(mutation), {
        status,
        headers: { 'content-type': 'application/json' },
      }),
    );
  });
}

const CREATED = {
  room_server_id: 'room-1',
  stub_id: 'stub-1',
  bootstrap_endpoints: ['/v1/private-rendezvous/announce'],
  created_at: '2026-08-02T00:00:00.000Z',
};

const STUB = {
  room_server_id: 'room-1',
  directory_mode: 'listed',
  display_name: 'Neighbourhood watch',
  display_description: null,
  display_avatar_public_cid: null,
  room_public_key: 'cGs',
  manifest_key_commitment: 'bWs',
  latest_manifest_commitment: null,
  rendezvous_policy: 'licio_blind',
  bootstrap_hints: [],
  bootstrap_endpoints: [],
  signed_stub: { bootstrap_blind_id: 'PEaenWxYddN6Q_NT1PiOYfz4EsZu7jRXRlpAsNpBU-A' },
  stub_signature:
    'pUOZfYTxJ5g1DAm97yzbFxv0HtPkpfgIry_rDFYmMAm_e1fNo_tkAcgXDt6Ecbtv53kTloLE6i_N5OMKpb47OQ',
  created_at: '2026-08-02T00:00:00.000Z',
  updated_at: '2026-08-02T00:00:00.000Z',
};

/** The body of the last non-CSRF request. */
function lastBody(): Record<string, unknown> {
  const calls = fetchMock.mock.calls.filter((call) => !String(call[0]).includes('/api/csrf-token'));
  const init = calls[calls.length - 1]?.[1] as RequestInit | undefined;
  return JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
}

beforeEach(() => {
  fetchMock.mockReset();
});

describe('createPrivateRoomStub (§21.1)', () => {
  it('sends only the §8.2-allowed fields', async () => {
    respondTo(CREATED, 201);
    await createPrivateRoomStub({
      directoryMode: 'listed',
      displayName: 'Neighbourhood watch',
      rendezvousPolicy: 'licio_blind',
      signedStub: {
        schema: 'licio.private.directory_stub.v2',
        room_public_key: 'HxxbL613hDQCTxU3mGNGknkX9HVabn0_2R8iZTt8MTI',
        manifest_key_commitment: 'BbOr8leaXrZkA814vlV_2GBjOh_iEDx2QgMN7-MsZX8',
      },
      stubSignature:
        'pUOZfYTxJ5g1DAm97yzbFxv0HtPkpfgIry_rDFYmMAm_e1fNo_tkAcgXDt6Ecbtv53kTloLE6i_N5OMKpb47OQ',
      bootstrapBlindId: 'PEaenWxYddN6Q_NT1PiOYfz4EsZu7jRXRlpAsNpBU-A',
    });
    // No `room_public_key`/`manifest_key_commitment`: the server DERIVES both
    // from the signed body, so there is no second copy to disagree with it.
    // `bootstrap_blind_id` travels BESIDE the body, never inside it.
    expect(Object.keys(lastBody()).sort()).toEqual([
      'bootstrap_blind_id',
      'directory_mode',
      'display_name',
      'rendezvous_policy',
      'signed_stub',
      'stub_signature',
    ]);
  });

  it('omits display metadata entirely on an unlisted room', async () => {
    respondTo(CREATED, 201);
    await createPrivateRoomStub({
      directoryMode: 'unlisted',
      rendezvousPolicy: 'licio_blind',
      signedStub: {
        schema: 'licio.private.directory_stub.v2',
        room_public_key: 'HxxbL613hDQCTxU3mGNGknkX9HVabn0_2R8iZTt8MTI',
        manifest_key_commitment: 'BbOr8leaXrZkA814vlV_2GBjOh_iEDx2QgMN7-MsZX8',
      },
      stubSignature:
        'pUOZfYTxJ5g1DAm97yzbFxv0HtPkpfgIry_rDFYmMAm_e1fNo_tkAcgXDt6Ecbtv53kTloLE6i_N5OMKpb47OQ',
      bootstrapBlindId: 'PEaenWxYddN6Q_NT1PiOYfz4EsZu7jRXRlpAsNpBU-A',
    });
    const body = lastBody();
    expect(body['display_name']).toBeUndefined();
    expect(body['display_description']).toBeUndefined();
    expect(body['display_avatar_public_cid']).toBeUndefined();
  });

  it('rejects a malformed response rather than returning it', async () => {
    respondTo({ room_server_id: 'room-1' }, 201); // missing stub_id + endpoints
    await expect(
      createPrivateRoomStub({
        directoryMode: 'unlisted',
        rendezvousPolicy: 'licio_blind',
        signedStub: {},
        stubSignature:
          'pUOZfYTxJ5g1DAm97yzbFxv0HtPkpfgIry_rDFYmMAm_e1fNo_tkAcgXDt6Ecbtv53kTloLE6i_N5OMKpb47OQ',
        bootstrapBlindId: 'PEaenWxYddN6Q_NT1PiOYfz4EsZu7jRXRlpAsNpBU-A',
      }),
    ).rejects.toThrow();
  });
});

describe('fetchPrivateRoomBootstrap (§21.2)', () => {
  it('passes the invite-derived token as a HEADER, never in the URL', async () => {
    respondTo(STUB);
    const token = 'PEaenWxYddN6Q_NT1PiOYfz4EsZu7jRXRlpAsNpBU-A';
    await fetchPrivateRoomBootstrap('room-1', token);
    const url = String(fetchMock.mock.calls.at(-1)?.[0]);
    expect(url).toContain('/v1/private-rooms/room-1/bootstrap');
    // A URL is written down everywhere — proxy logs, browser history, the
    // client's own dev console — and this capability does not rotate.
    expect(url).not.toContain(token);
    const init = fetchMock.mock.calls.at(-1)?.[1] as RequestInit | undefined;
    expect(new Headers(init?.headers).get('x-licio-bootstrap-token')).toBe(token);
  });

  it('sends no token header when none is supplied (a listed room)', async () => {
    respondTo(STUB);
    await fetchPrivateRoomBootstrap('room-1');
    const init = fetchMock.mock.calls.at(-1)?.[1] as RequestInit | undefined;
    expect(new Headers(init?.headers).get('x-licio-bootstrap-token')).toBeNull();
  });

  it('surfaces a refusal as an ordinary not-found — never "exists but forbidden"', async () => {
    respondTo({ error: { code: 'not_found', message: 'No directory record for that room.' } }, 404);
    await expect(fetchPrivateRoomBootstrap('room-1', 'd3Jvbmc')).rejects.toMatchObject({
      code: 'not_found',
    });
  });
});

describe('updatePrivateRoomStub / delist / delete (§21.3, §21.4)', () => {
  it('sends only the fields actually supplied', async () => {
    respondTo(STUB);
    await updatePrivateRoomStub('room-1', {
      latestManifestCommitment: 'Muh7CwUy5QuoJ8Hj5dzRVLOgJxwBRE-fnw7RkinJrAE',
    });
    expect(lastBody()).toEqual({
      latest_manifest_commitment: 'Muh7CwUy5QuoJ8Hj5dzRVLOgJxwBRE-fnw7RkinJrAE',
    });
  });

  it('delist returns the demoted stub', async () => {
    respondTo({ ...STUB, directory_mode: 'unlisted', display_name: null });
    const result = await delistPrivateRoomStub('room-1');
    expect(result.directory_mode).toBe('unlisted');
    expect(result.display_name).toBe(null);
  });

  it("delete's response says what it removed — the record, not the room", async () => {
    respondTo({
      removed: true,
      removed_what: 'licio_directory_record',
      message: "Removed Licio's directory and bootstrap record. Members' devices still hold it.",
    });
    const result = await deletePrivateRoomStub('room-1');
    expect(result.removed_what).toBe('licio_directory_record');
    expect(result.message).not.toMatch(/deleted everywhere|deleted for everyone/i);
  });
});

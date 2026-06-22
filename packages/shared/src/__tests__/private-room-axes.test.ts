// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-S.0.1 — the three private-room axes (PRIVATE_SPEC §4, §4.1).  The
// coherence refinement (`roomAxesSchema`) is the SSOT the migration `0043` DB
// CHECK constraints mirror, so this matrix is the authoritative accept/reject
// table for the storage/authority/visibility/join/directory tuple.
import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  DEFAULT_P2P_DIRECTORY_MODE,
  ROOM_AUTHORITY_MODELS,
  ROOM_DIRECTORY_MODES,
  ROOM_STORAGE_MODES,
  type RoomAuthorityModel,
  type RoomAxes,
  type RoomDirectoryMode,
  type RoomStorageMode,
  roomAxesSchema,
  roomClassOf,
} from '../schemas/room.js';

describe('WS-S.0.1 room axes enums + types', () => {
  it('pins the three axis value sets', () => {
    expect([...ROOM_STORAGE_MODES]).toEqual(['server', 'p2p']);
    expect([...ROOM_AUTHORITY_MODELS]).toEqual(['platform', 'room_keys']);
    expect([...ROOM_DIRECTORY_MODES]).toEqual(['listed', 'unlisted', 'detached']);
  });

  it("defaults a P2P room's directory mode to unlisted (§4.2)", () => {
    expect(DEFAULT_P2P_DIRECTORY_MODE).toBe('unlisted');
  });

  it('infers the axis literal types', () => {
    expectTypeOf<RoomStorageMode>().toEqualTypeOf<'server' | 'p2p'>();
    expectTypeOf<RoomAuthorityModel>().toEqualTypeOf<'platform' | 'room_keys'>();
    expectTypeOf<RoomDirectoryMode>().toEqualTypeOf<'listed' | 'unlisted' | 'detached'>();
    expectTypeOf<RoomAxes['storage_mode']>().toEqualTypeOf<RoomStorageMode>();
    expectTypeOf<RoomAxes['directory_mode']>().toEqualTypeOf<RoomDirectoryMode | null>();
  });
});

describe('WS-S.0.1 §4.1 coherence refinement — accepts every legal triple', () => {
  it('accepts every legal SERVER room (directory_mode null; any visibility/join)', () => {
    for (const visibility of ['public', 'private'] as const) {
      for (const join_model of ['open', 'request_approval', 'invite'] as const) {
        // A public room with a gated join model is incoherent at the WS-Q layer,
        // but THIS schema only governs the storage/authority axes; it accepts the
        // server tuple regardless of the orthogonal join model.
        const result = roomAxesSchema.safeParse({
          storage_mode: 'server',
          authority_model: 'platform',
          visibility,
          join_model,
          directory_mode: null,
        });
        expect(result.success).toBe(true);
      }
    }
  });

  it('accepts every legal P2P room (room_keys + private + invite + a directory mode)', () => {
    for (const directory_mode of ROOM_DIRECTORY_MODES) {
      const result = roomAxesSchema.safeParse({
        storage_mode: 'p2p',
        authority_model: 'room_keys',
        visibility: 'private',
        join_model: 'invite',
        directory_mode,
      });
      expect(result.success).toBe(true);
    }
  });
});

describe('WS-S.0.1 §4.1 coherence refinement — rejects each illegal combination', () => {
  const legalP2p = {
    storage_mode: 'p2p',
    authority_model: 'room_keys',
    visibility: 'private',
    join_model: 'invite',
    directory_mode: 'unlisted',
  } as const;
  const legalServer = {
    storage_mode: 'server',
    authority_model: 'platform',
    visibility: 'public',
    join_model: 'open',
    directory_mode: null,
  } as const;

  it('rejects p2p + platform authority', () => {
    const r = roomAxesSchema.safeParse({ ...legalP2p, authority_model: 'platform' });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues[0]?.path).toEqual(['authority_model']);
  });

  it('rejects p2p + public visibility', () => {
    const r = roomAxesSchema.safeParse({ ...legalP2p, visibility: 'public' });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues[0]?.path).toEqual(['visibility']);
  });

  it('rejects p2p + open / request_approval join model', () => {
    for (const join_model of ['open', 'request_approval'] as const) {
      const r = roomAxesSchema.safeParse({ ...legalP2p, join_model });
      expect(r.success).toBe(false);
      if (!r.success) expect(r.error.issues[0]?.path).toEqual(['join_model']);
    }
  });

  it('rejects p2p without a directory mode', () => {
    const r = roomAxesSchema.safeParse({ ...legalP2p, directory_mode: null });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues[0]?.path).toEqual(['directory_mode']);
  });

  it('rejects server + room_keys authority', () => {
    const r = roomAxesSchema.safeParse({ ...legalServer, authority_model: 'room_keys' });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues[0]?.path).toEqual(['authority_model']);
  });

  it('rejects a server room carrying a directory mode', () => {
    const r = roomAxesSchema.safeParse({ ...legalServer, directory_mode: 'listed' });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues[0]?.path).toEqual(['directory_mode']);
  });

  it('rejects unknown axis fields (strict)', () => {
    const r = roomAxesSchema.safeParse({ ...legalP2p, extra: true });
    expect(r.success).toBe(false);
  });
});

describe('WS-S.0.1 roomClassOf — §4 three-class mapping', () => {
  it('maps p2p storage to private_p2p regardless of visibility', () => {
    expect(roomClassOf({ storage_mode: 'p2p', visibility: 'private' })).toBe('private_p2p');
  });

  it('maps a public server room to public_server', () => {
    expect(roomClassOf({ storage_mode: 'server', visibility: 'public' })).toBe('public_server');
  });

  it('maps a private server room to restricted_server (members-only server room)', () => {
    expect(roomClassOf({ storage_mode: 'server', visibility: 'private' })).toBe(
      'restricted_server',
    );
  });
});

// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The two encoders of a §21.1 directory-stub body must agree, byte for byte.
//
// The room SIGNS with this package's full canonical DAG-CBOR encoder; the server
// VERIFIES with the narrow one in `@licio/shared`, because `apps/api` may not
// import this package (it holds no per-room key, and the boundary is what keeps
// it that way). Two encoders is the shape that drifts, so this is the cross-check
// that makes them one fact: a disagreement here is a signature every member
// makes and the server rejects — or, worse, one the server accepts under bytes
// nobody signed.
import { canonicalDirectoryStubBytes, type SignedDirectoryStubBody } from '@licio/shared';
import { describe, expect, it } from 'vitest';
import { canonical } from '../crypto/canonical.js';

/** Bodies spanning what the field can hold: the real shape, keys that sort
 *  differently, and lengths either side of CBOR's 23/24-byte head boundary. */
const BODIES: SignedDirectoryStubBody[] = [
  {
    schema: 'licio.private.directory_stub.v2',
    room_public_key: 'HxxbL613hDQCTxU3mGNGknkX9HVabn0_2R8iZTt8MTI',
    manifest_key_commitment: 'BbOr8leaXrZkA814vlV_2GBjOh_iEDx2QgMN7-MsZX8',
  },
  {
    schema: 'licio.private.directory_stub.v2',
    room_public_key: 'a',
    manifest_key_commitment: '',
  },
  {
    schema: 'licio.private.directory_stub.v2',
    room_public_key: 'x'.repeat(23),
    manifest_key_commitment: 'y'.repeat(24),
  },
  {
    schema: 'licio.private.directory_stub.v2',
    room_public_key: 'z'.repeat(255),
    manifest_key_commitment: 'w'.repeat(256),
  },
];

describe('directory-stub canonical bytes (WS-S §21.1)', () => {
  it('agree with the full DAG-CBOR encoder for every body shape', () => {
    for (const body of BODIES) {
      expect(canonicalDirectoryStubBytes(body)).toEqual(canonical({ ...body }));
    }
  });

  it('are ORDER-INDEPENDENT — the map is sorted by encoded key, not by literal', () => {
    const asWritten: SignedDirectoryStubBody = {
      schema: 'licio.private.directory_stub.v2',
      room_public_key: 'HxxbL613hDQCTxU3mGNGknkX9HVabn0_2R8iZTt8MTI',
      manifest_key_commitment: 'BbOr8leaXrZkA814vlV_2GBjOh_iEDx2QgMN7-MsZX8',
    };
    const shuffled = {
      manifest_key_commitment: asWritten.manifest_key_commitment,
      schema: asWritten.schema,
      room_public_key: asWritten.room_public_key,
    };
    expect(canonicalDirectoryStubBytes(asWritten)).toEqual(canonical(shuffled));
  });
});

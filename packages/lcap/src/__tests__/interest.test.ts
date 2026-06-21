// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Interest privacy scoping (§16.6, §26.1, WS-R.6.3): privacy_level gates the
// audience; a private interest never reaches an unknown peer; a clear room_id is
// stripped for peers/relays; the guard forbids constructing a peer-facing
// interest from a private room id.

import { describe, expect, it } from 'vitest';
import type { InterestDescriptorV2 } from '../schemas/index.js';
import {
  assertInterestSafeForAudience,
  type InterestAudience,
  interestAllowedForAudience,
  PeerInterestLeakError,
  scopeInterestForAudience,
} from '../sync/index.js';

const ALL_AUDIENCES: readonly InterestAudience[] = [
  'authenticated_https',
  'trusted_peer',
  'unknown_peer',
  'relay',
  'manual',
];

const base = (over: Partial<InterestDescriptorV2> = {}): InterestDescriptorV2 => ({
  interest_version: 2,
  include_dependencies: true,
  include_proofs: true,
  privacy_level: 'public',
  ...over,
});

describe('interestAllowedForAudience (§26.1)', () => {
  it('public interests reach any audience', () => {
    const i = base({ privacy_level: 'public' });
    for (const a of ALL_AUDIENCES) expect(interestAllowedForAudience(i, a)).toBe(true);
  });

  it('trusted_peer_only forbids unknown peers and relays', () => {
    const i = base({ privacy_level: 'trusted_peer_only' });
    expect(interestAllowedForAudience(i, 'trusted_peer')).toBe(true);
    expect(interestAllowedForAudience(i, 'unknown_peer')).toBe(false);
    expect(interestAllowedForAudience(i, 'relay')).toBe(false);
  });

  it('manual_only reaches only manual + authenticated HTTPS', () => {
    const i = base({ privacy_level: 'manual_only' });
    expect(interestAllowedForAudience(i, 'manual')).toBe(true);
    expect(interestAllowedForAudience(i, 'authenticated_https')).toBe(true);
    expect(interestAllowedForAudience(i, 'trusted_peer')).toBe(false);
    expect(interestAllowedForAudience(i, 'unknown_peer')).toBe(false);
  });
});

describe('assertInterestSafeForAudience (§26.1)', () => {
  it('throws when a private interest would reach an unknown peer', () => {
    const i = base({ visibility_scope: 'private', room_id_hash: new Uint8Array([1]) });
    expect(() => assertInterestSafeForAudience(i, 'unknown_peer')).toThrow(PeerInterestLeakError);
  });

  it('throws when a clear room_id would reach a peer with no hashed hint', () => {
    const i = base({ room_id: 'room-123' });
    expect(() => assertInterestSafeForAudience(i, 'relay')).toThrow(PeerInterestLeakError);
  });

  it('permits a private interest to authenticated HTTPS', () => {
    const i = base({ visibility_scope: 'private', room_id: 'room-123' });
    expect(() => assertInterestSafeForAudience(i, 'authenticated_https')).not.toThrow();
  });
});

describe('scopeInterestForAudience (§16.6)', () => {
  it('strips the clear room_id for a peer audience (hashed hint remains)', () => {
    const i = base({ room_id: 'room-123', room_id_hash: new Uint8Array([2]) });
    const scoped = scopeInterestForAudience(i, 'trusted_peer');
    expect(scoped.room_id).toBeUndefined();
    expect(scoped.room_id_hash).toEqual(new Uint8Array([2]));
  });

  it('leaves an authenticated-HTTPS interest unchanged (clear room_id allowed)', () => {
    const i = base({ room_id: 'room-123' });
    expect(scopeInterestForAudience(i, 'authenticated_https')).toBe(i);
  });

  it('forbids constructing a peer-facing interest from a private room id', () => {
    const i = base({ visibility_scope: 'private', room_id: 'secret-room' });
    expect(() => scopeInterestForAudience(i, 'unknown_peer')).toThrow(PeerInterestLeakError);
  });
});

// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import {
  governanceProposeRequestSchema,
  governedByResponseSchema,
  ratificationViewResponseSchema,
  stewardSeatSchema,
} from '../schemas/governance-api.js';

const UUID = '4c2f8a94-1a5b-4c1e-9f7d-2b6a8c0e1d23';
const ISO = '2026-07-19T00:00:00.000Z';

describe('governance-api wire contracts', () => {
  it('accepts a well-formed steward seat', () => {
    expect(
      stewardSeatSchema.parse({
        room_id: UUID,
        holder_user_id: UUID,
        term_start: ISO,
        term_end: ISO,
        bootstrap: false,
        current_election_id: null,
      }),
    ).toBeDefined();
  });

  it('rejects a non-uuid room id (a Postgres 22P02 hazard on the wire)', () => {
    expect(() =>
      stewardSeatSchema.parse({
        room_id: 'not-a-uuid',
        holder_user_id: null,
        term_start: ISO,
        term_end: ISO,
        bootstrap: true,
        current_election_id: null,
      }),
    ).toThrow();
  });

  it('rejects a non-ISO timestamp', () => {
    expect(() =>
      stewardSeatSchema.parse({
        room_id: UUID,
        holder_user_id: null,
        term_start: 'yesterday',
        term_end: ISO,
        bootstrap: true,
        current_election_id: null,
      }),
    ).toThrow();
  });

  it('is strict — an unknown key is rejected', () => {
    expect(() =>
      stewardSeatSchema.parse({
        room_id: UUID,
        holder_user_id: null,
        term_start: ISO,
        term_end: ISO,
        bootstrap: true,
        current_election_id: null,
        rogue_field: 1,
      }),
    ).toThrow();
  });

  it('bounds the granted capability list', () => {
    const base = {
      active: true,
      frozen: false,
      model_id: UUID,
      recent_actions: [],
    };
    expect(governedByResponseSchema.parse({ ...base, granted: ['moderate'] })).toBeDefined();
    expect(() =>
      governedByResponseSchema.parse({ ...base, granted: Array.from({ length: 33 }, () => 'x') }),
    ).toThrow();
    expect(() => governedByResponseSchema.parse({ ...base, granted: ['x'.repeat(65)] })).toThrow();
  });

  it('rejects unknown keys on the propose request (request SSOT)', () => {
    expect(
      governanceProposeRequestSchema.parse({ bundle: {}, prompt_text: 'hello' }),
    ).toBeDefined();
    expect(() =>
      governanceProposeRequestSchema.parse({ bundle: {}, prompt_text: 'hello', extra: true }),
    ).toThrow();
  });

  it('validates the ratification view with uuid + ISO fields', () => {
    expect(
      ratificationViewResponseSchema.parse({
        vote: {
          vote_id: UUID,
          model_id: UUID,
          opens_at: ISO,
          closes_at: ISO,
          min_quorum: 3,
          in_favor: 2,
          opposed: 1,
        },
      }),
    ).toBeDefined();
    expect(ratificationViewResponseSchema.parse({ vote: null })).toBeDefined();
  });
});

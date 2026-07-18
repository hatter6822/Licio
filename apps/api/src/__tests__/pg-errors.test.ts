// SPDX-License-Identifier: AGPL-3.0-or-later
//
// `lib/pg-errors.ts` — reading a Postgres constraint failure.
//
// This existed nine times across the codebase before it existed once, and one
// of the nine had quietly lost the cause-chain walk, so its race retry never
// fired.  These tests pin the one fact every copy was there to encode.
import { describe, expect, it } from 'vitest';
import {
  isUniqueViolation,
  UniqueViolationError,
  uniqueViolationConstraint,
} from '../lib/pg-errors.js';

/** What Drizzle actually throws: the driver error, wrapped. */
function drizzleWrapped(driver: unknown): Error {
  const wrapper = new Error('Failed query: insert into …');
  wrapper.name = 'DrizzleQueryError';
  (wrapper as { cause?: unknown }).cause = driver;
  return wrapper;
}

describe('isUniqueViolation', () => {
  it('finds the 23505 Drizzle buried on the cause chain', () => {
    // THE fact this module exists for: a direct `.code` check never fires,
    // because the error you catch is the wrapper, not the driver's.  A caller
    // that gets this wrong reads "this already exists" as "the store is
    // broken" — opposite instructions to whoever is retrying.
    const driver = Object.assign(new Error('duplicate key value'), { code: '23505' });
    expect(isUniqueViolation(drizzleWrapped(driver))).toBe(true);
    // …and still finds it nested deeper, should a driver wrap twice.
    expect(isUniqueViolation(drizzleWrapped(drizzleWrapped(driver)))).toBe(true);
  });

  it('recognises the in-memory adapters’ typed error', () => {
    // The house rule: in-memory adapters emulate every DB protection, so a
    // caller reads the same answer from them as from Postgres.
    expect(isUniqueViolation(new UniqueViolationError('(region, effective_at)'))).toBe(true);
  });

  it('does NOT claim an ordinary failure is a duplicate', () => {
    // The dangerous direction: a store outage reported as "already exists"
    // tells the caller to stop retrying something that never landed.
    const other = Object.assign(new Error('connection terminated'), { code: '57P01' });
    expect(isUniqueViolation(drizzleWrapped(other))).toBe(false);
    expect(isUniqueViolation(new Error('boom'))).toBe(false);
    expect(isUniqueViolation(null)).toBe(false);
    expect(isUniqueViolation(undefined)).toBe(false);
    expect(isUniqueViolation('23505')).toBe(false); // a string is not an error
  });

  it('terminates on a self-referential cause chain', () => {
    const loop = new Error('loop');
    (loop as { cause?: unknown }).cause = loop;
    expect(isUniqueViolation(loop)).toBe(false);
  });
});

describe('uniqueViolationConstraint', () => {
  it('names the constraint from anywhere on the chain, or answers empty', () => {
    const driver = Object.assign(new Error('duplicate key value'), {
      code: '23505',
      constraint_name: 'dv_identity_uq',
    });
    expect(uniqueViolationConstraint(drizzleWrapped(driver))).toBe('dv_identity_uq');
    expect(uniqueViolationConstraint(new UniqueViolationError('(user_id)'))).toBe('(user_id)');
    expect(uniqueViolationConstraint(new Error('unnamed'))).toBe('');
  });
});

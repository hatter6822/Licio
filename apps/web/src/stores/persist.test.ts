// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { clearPersisted, loadPersisted, type PersistConfig, savePersisted } from './persist.js';

const schema = z.object({ a: z.number(), b: z.string() });
const config: PersistConfig<{ a: number; b: string }> = { key: 'test', schema, version: 1 };

beforeEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

afterEach(() => {
  localStorage.clear();
});

describe('persist', () => {
  it('round-trips a valid value under the licio: prefix', () => {
    savePersisted(config, { a: 1, b: 'x' });
    expect(localStorage.getItem('licio:test')).not.toBeNull();
    expect(loadPersisted(config)).toEqual({ a: 1, b: 'x' });
  });

  it('returns undefined when nothing is stored', () => {
    expect(loadPersisted(config)).toBeUndefined();
  });

  it('discards corrupt JSON and clears the key', () => {
    localStorage.setItem('licio:test', '{ not valid json');
    expect(loadPersisted(config)).toBeUndefined();
    expect(localStorage.getItem('licio:test')).toBeNull();
  });

  it('discards a version mismatch', () => {
    localStorage.setItem('licio:test', JSON.stringify({ version: 2, state: { a: 1, b: 'x' } }));
    expect(loadPersisted(config)).toBeUndefined();
    expect(localStorage.getItem('licio:test')).toBeNull();
  });

  it('discards a value that fails schema validation', () => {
    localStorage.setItem('licio:test', JSON.stringify({ version: 1, state: { a: 'no', b: 2 } }));
    expect(loadPersisted(config)).toBeUndefined();
    expect(localStorage.getItem('licio:test')).toBeNull();
  });

  it('discards a non-object envelope', () => {
    localStorage.setItem('licio:test', JSON.stringify(42));
    expect(loadPersisted(config)).toBeUndefined();
  });

  it('clears a persisted key', () => {
    savePersisted(config, { a: 1, b: 'x' });
    clearPersisted('test');
    expect(loadPersisted(config)).toBeUndefined();
  });

  it('swallows a quota error on write rather than throwing', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('QuotaExceededError');
    });
    expect(() => savePersisted(config, { a: 1, b: 'x' })).not.toThrow();
  });
});

// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { InMemoryEphemeralStore } from '../ephemeral-store.js';

describe('InMemoryEphemeralStore', () => {
  it('set/get round-trips a value', async () => {
    const store = new InMemoryEphemeralStore();
    await store.set('k', 'v', 1000);
    expect(await store.get('k')).toBe('v');
  });

  it('expires a value after its TTL', async () => {
    let now = 0;
    const store = new InMemoryEphemeralStore(() => now);
    await store.set('k', 'v', 1000);
    now = 1001;
    expect(await store.get('k')).toBeNull();
  });

  it('take reads and deletes (single-use)', async () => {
    const store = new InMemoryEphemeralStore();
    await store.set('k', 'v', 1000);
    expect(await store.take('k')).toBe('v');
    expect(await store.get('k')).toBeNull();
  });

  it('setIfExists does not resurrect a consumed record (SET XX semantics)', async () => {
    const store = new InMemoryEphemeralStore();
    await store.set('k', 'v1', 1000);
    // A valid verification consumes the single-use record via take (GETDEL).
    expect(await store.take('k')).toBe('v1');
    // A concurrent FAILED attempt then tries to re-store (increment attempts): it
    // must NOT re-create the deleted key — otherwise the consumed OTP is redeemable
    // again. setIfExists reports it did not write, and the key stays gone.
    expect(await store.setIfExists('k', 'v2', 1000)).toBe(false);
    expect(await store.get('k')).toBeNull();
    // On a live key it DOES update (the normal failed-attempt increment path).
    await store.set('k2', 'a', 1000);
    expect(await store.setIfExists('k2', 'b', 1000)).toBe(true);
    expect(await store.get('k2')).toBe('b');
  });

  it('concurrent takes consume a single-use secret exactly once', async () => {
    const store = new InMemoryEphemeralStore();
    await store.set('k', 'N1', 1000);
    const results = await Promise.all([store.take('k'), store.take('k')]);
    const nonNull = results.filter((r) => r !== null);
    expect(nonNull).toEqual(['N1']);
  });

  it('take of an expired/absent key returns null', async () => {
    let now = 0;
    const store = new InMemoryEphemeralStore(() => now);
    await store.set('k', 'v', 1000);
    now = 2000;
    expect(await store.take('k')).toBeNull();
    expect(await store.take('missing')).toBeNull();
  });

  it('delete and clear remove entries', async () => {
    const store = new InMemoryEphemeralStore();
    await store.set('a', '1', 1000);
    await store.set('b', '2', 1000);
    await store.delete('a');
    expect(await store.get('a')).toBeNull();
    await store.clear();
    expect(await store.get('b')).toBeNull();
  });
});

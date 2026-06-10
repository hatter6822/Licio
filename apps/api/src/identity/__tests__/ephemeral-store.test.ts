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

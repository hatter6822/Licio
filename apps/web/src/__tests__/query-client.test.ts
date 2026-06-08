// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { createAppQueryClient } from '../lib/query-client.js';

describe('createAppQueryClient', () => {
  it('creates a QueryClient with correct default options', () => {
    const client = createAppQueryClient();
    const defaults = client.getDefaultOptions();

    expect(defaults.queries?.staleTime).toBe(60_000);
    expect(defaults.queries?.retry).toBe(1);
    expect(defaults.queries?.refetchOnWindowFocus).toBe(false);
  });

  it('creates independent instances', () => {
    const client1 = createAppQueryClient();
    const client2 = createAppQueryClient();
    expect(client1).not.toBe(client2);
  });
});

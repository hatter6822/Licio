// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-L.2.1a — EIP-6963 provider discovery: listener-before-request (no missed
// early announcement), late announcements captured, duplicate rdns deduped
// (latest wins), malformed announcements ignored, clean teardown.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { startProviderDiscovery } from './discovery.js';
import type { Eip1193Provider } from './eip1193.js';

const provider = (): Eip1193Provider => ({ request: async () => null });

function announce(info: { uuid: string; name: string; icon: string; rdns: string }): void {
  window.dispatchEvent(
    new CustomEvent('eip6963:announceProvider', {
      detail: { info, provider: provider() },
    }),
  );
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('startProviderDiscovery', () => {
  it('captures a provider that announces synchronously on the request', () => {
    // A wallet that answers the request event immediately (the early case).
    const requestHandler = (): void =>
      announce({ uuid: 'u1', name: 'MetaMask', icon: 'data:,', rdns: 'io.metamask' });
    window.addEventListener('eip6963:requestProvider', requestHandler);
    const seen: string[][] = [];
    const stop = startProviderDiscovery((ps) => seen.push(ps.map((p) => p.info.rdns)));
    stop();
    window.removeEventListener('eip6963:requestProvider', requestHandler);
    expect(seen.at(-1)).toContain('io.metamask');
  });

  it('captures LATE announcements after the initial scan', () => {
    let latest: string[] = [];
    const stop = startProviderDiscovery((ps) => {
      latest = ps.map((p) => p.info.rdns);
    });
    expect(latest).toEqual([]);
    announce({ uuid: 'u2', name: 'Rabby', icon: 'data:,', rdns: 'io.rabby' });
    expect(latest).toEqual(['io.rabby']);
    stop();
  });

  it('dedupes duplicate rdns (latest announcement wins)', () => {
    let providers: { rdns: string; name: string }[] = [];
    const stop = startProviderDiscovery((ps) => {
      providers = ps.map((p) => ({ rdns: p.info.rdns, name: p.info.name }));
    });
    announce({ uuid: 'a', name: 'Old Name', icon: 'data:,', rdns: 'io.wallet' });
    announce({ uuid: 'b', name: 'New Name', icon: 'data:,', rdns: 'io.wallet' });
    expect(providers).toHaveLength(1);
    expect(providers[0]?.name).toBe('New Name');
    stop();
  });

  it('ignores malformed announcements', () => {
    let count = 0;
    const stop = startProviderDiscovery((ps) => {
      count = ps.length;
    });
    window.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail: { info: 'bad' } }));
    window.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail: null }));
    expect(count).toBe(0);
    stop();
  });

  it('stops listening after teardown', () => {
    let updates = 0;
    const stop = startProviderDiscovery(() => {
      updates += 1;
    });
    const before = updates;
    stop();
    announce({ uuid: 'z', name: 'Late', icon: 'data:,', rdns: 'io.late' });
    expect(updates).toBe(before); // no further updates after teardown
  });
});

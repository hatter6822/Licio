// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-L.2.1a — the EIP-6963 provider-discovery store.  Registers the
// `eip6963:announceProvider` listener BEFORE dispatching
// `eip6963:requestProvider` (so no early announcement is missed), dedupes by
// `rdns` (latest announcement wins), captures late announcements, and tears
// down cleanly on unmount / kill-switch.  Providers are informational only —
// no trust decision is made here (WS-L.2.1a security note).

import { type Eip6963ProviderDetail, parseProviderDetail } from './eip1193.js';

export type DiscoveryListener = (providers: readonly Eip6963ProviderDetail[]) => void;

const ANNOUNCE_EVENT = 'eip6963:announceProvider';
const REQUEST_EVENT = 'eip6963:requestProvider';

/**
 * Start listening for provider announcements.  Returns the current snapshot
 * via `onChange` on every update and a teardown function.  Keyed by `rdns` so
 * a wallet re-announcing (e.g. after unlock) replaces its prior entry.
 */
export function startProviderDiscovery(onChange: DiscoveryListener): () => void {
  if (typeof window === 'undefined') return () => {};
  const byRdns = new Map<string, Eip6963ProviderDetail>();

  const emit = (): void => onChange([...byRdns.values()]);

  const onAnnounce = (event: Event): void => {
    const detail = parseProviderDetail((event as CustomEvent<unknown>).detail);
    if (detail === null) return;
    byRdns.set(detail.info.rdns, detail); // latest announcement wins
    emit();
  };

  // Listener FIRST, then request — a wallet that announces synchronously on the
  // request is still captured.
  window.addEventListener(ANNOUNCE_EVENT, onAnnounce as EventListener);
  window.dispatchEvent(new Event(REQUEST_EVENT));
  emit();

  return () => {
    window.removeEventListener(ANNOUNCE_EVENT, onAnnounce as EventListener);
  };
}

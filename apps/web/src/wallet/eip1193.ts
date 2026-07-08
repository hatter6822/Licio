// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-L.2.1a — minimal EIP-1193 provider + EIP-6963 announcement types.  No
// wallet library is bundled (dependency budget): these are the exact shapes
// the browser wallet-extension ecosystem emits, narrowed with `unknown` (no
// `any`).  `rdns` is attacker-controllable and used ONLY as a display/dedup
// key — never a trust boundary (trust is established by SIWE verification
// server-side, WS-L.2.3c).

/** The EIP-1193 request surface Licio uses (personal_sign, typed data). */
export interface Eip1193Provider {
  request(args: { method: string; params?: readonly unknown[] | object }): Promise<unknown>;
  on?(event: string, handler: (...args: unknown[]) => void): void;
  removeListener?(event: string, handler: (...args: unknown[]) => void): void;
}

/** The `info` block of an EIP-6963 announcement. */
export interface Eip6963ProviderInfo {
  /** Per-page-load UUIDv4 (session-scoped). */
  uuid: string;
  name: string;
  /** Data-URI icon. */
  icon: string;
  /** Reverse-DNS id, e.g. "io.metamask" (stable across reloads; DISPLAY only). */
  rdns: string;
}

export interface Eip6963ProviderDetail {
  info: Eip6963ProviderInfo;
  provider: Eip1193Provider;
}

/** Narrow an unknown CustomEvent detail to a well-formed EIP-6963 detail. */
export function parseProviderDetail(detail: unknown): Eip6963ProviderDetail | null {
  if (typeof detail !== 'object' || detail === null) return null;
  const record = detail as Record<string, unknown>;
  const info = record['info'];
  const provider = record['provider'];
  if (typeof info !== 'object' || info === null) return null;
  if (typeof provider !== 'object' || provider === null) return null;
  const infoRecord = info as Record<string, unknown>;
  const { uuid, name, icon, rdns } = infoRecord;
  if (
    typeof uuid !== 'string' ||
    typeof name !== 'string' ||
    typeof icon !== 'string' ||
    typeof rdns !== 'string'
  ) {
    return null;
  }
  if (typeof (provider as Record<string, unknown>)['request'] !== 'function') return null;
  return {
    info: { uuid, name, icon, rdns },
    provider: provider as Eip1193Provider,
  };
}

// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-L.2.3b — client-side EIP-4361 (SIWE) message construction.  The domain is
// a BUILD-PINNED constant (never derived from `window.location` — a look-alike
// runtime origin cannot mint a message that validates, WS-L.2.3b security note),
// the expiration is short-lived, and the EXACT string built here is the string
// passed to `personal_sign` and shown to the user (no display/sign divergence).
//
// The default derives from `VITE_APP_URL` so it stays in LOCKSTEP with the server
// (which derives its SIWE domain/URI from CORS_ORIGIN's host) — otherwise a
// zero-config `localhost` client would sign a message the `localhost:5173` server
// rejects with `siwe_domain_mismatch`.

const APP_URL = (import.meta.env['VITE_APP_URL'] as string | undefined) ?? 'http://localhost:5173';
/** The host (host:port) of the app origin; falls back if VITE_APP_URL is malformed. */
function appHost(): string {
  try {
    return new URL(APP_URL).host;
  } catch {
    return 'localhost:5173';
  }
}

/** Licio's canonical origin for SIWE domain binding (WS-L.2.3b). */
export const LICIO_SIWE_DOMAIN =
  (import.meta.env['VITE_SIWE_DOMAIN'] as string | undefined) ?? appHost();
export const LICIO_SIWE_URI = (import.meta.env['VITE_SIWE_URI'] as string | undefined) ?? APP_URL;

/** EIP-55 checksum an address (pure keccak-free: uppercase per the algorithm
 *  needs keccak, so we defer checksumming to the wallet — here we only lowercase
 *  for the message and rely on the wallet returning its own checksummed form).
 *  The server re-derives the address from the signature, so display casing is
 *  not a trust input. */
export function normalizeAddress(address: string): string {
  return address.toLowerCase();
}

export interface SiweMessageParams {
  address: string;
  chainId: number;
  nonce: string;
  /** ISO timestamp; defaults to now. */
  issuedAt?: string;
  /** Seconds until expiry (default 300 = 5 minutes). */
  expirationSeconds?: number;
}

/**
 * Build the canonical EIP-4361 message string.  Field order and formatting
 * follow the ABNF so it round-trips through any SIWE parser (WS-L.2.3b).
 */
export function buildSiweMessage(params: SiweMessageParams): string {
  const issuedAt = params.issuedAt ?? new Date().toISOString();
  const expiry = new Date(
    Date.parse(issuedAt) + (params.expirationSeconds ?? 300) * 1000,
  ).toISOString();
  const statement = 'Link this wallet to your Licio account. This does not affect ranking.';
  return [
    `${LICIO_SIWE_DOMAIN} wants you to sign in with your Ethereum account:`,
    params.address,
    '',
    statement,
    '',
    `URI: ${LICIO_SIWE_URI}`,
    'Version: 1',
    `Chain ID: ${params.chainId}`,
    `Nonce: ${params.nonce}`,
    `Issued At: ${issuedAt}`,
    `Expiration Time: ${expiry}`,
  ].join('\n');
}

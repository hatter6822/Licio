// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Wallet-drainer link detection (WS-G.4.2c, SPEC §18.5/§25.2).  Pure
// functions shared by the web client (interstitial decision) and the BFF
// (blocklist config validation).  Detection layers:
//
//   1. Blocklist — exact or subdomain match against a maintained drainer-
//      domain list (served by `GET /v1/security/link-blocklist`, updatable
//      without an app deploy).
//   2. Contract-interaction heuristics — URLs whose path/query reference
//      approval/transfer entry points (`approve`, `setApprovalForAll`,
//      `permit`, `transferFrom`).
//   3. dApp mimicry — hostnames that embed or typo a well-known dApp/wallet
//      brand without being that brand's real domain.
//
// The verdict gates an INTERSTITIAL (continue/back), never a silent block,
// and the user's choice is never associated with their identity (§18.5).
import { tryParseUrl } from './whatwg-url.js';

/** Suspicious contract-interaction tokens in a path or query string. */
const CONTRACT_INTERACTION_PATTERNS = [
  'approve',
  'setapprovalforall',
  'permit',
  'transferfrom',
] as const;

/**
 * Canonical domains of frequently-impersonated dApps/wallets.  The REAL
 * domain (and its subdomains) never triggers mimicry; lookalikes do.  This is
 * a fixture seed — the runtime blocklist endpoint extends it without deploys.
 */
export const KNOWN_DAPP_DOMAINS = [
  'uniswap.org',
  'opensea.io',
  'metamask.io',
  'walletconnect.com',
  'etherscan.io',
  'pancakeswap.finance',
  'aave.com',
  'curve.finance',
  'lido.fi',
  'ens.domains',
] as const;

export interface LinkSafetyVerdict {
  /** True → interpose the wallet-drainer interstitial before navigation. */
  readonly suspicious: boolean;
  /** Machine-readable reasons (counted in metrics; never per-user logged). */
  readonly reasons: readonly ('blocklisted_domain' | 'contract_interaction' | 'dapp_mimicry')[];
}

const SAFE_VERDICT: LinkSafetyVerdict = Object.freeze({ suspicious: false, reasons: [] });

/** Lower-case a hostname defensively (URL already lower-cases, but inputs vary). */
function normalizeHost(hostname: string): string {
  return hostname.toLowerCase().replace(/\.$/, '');
}

/** True when `hostname` is `domain` or a subdomain of it. */
export function hostMatchesDomain(hostname: string, domain: string): boolean {
  const host = normalizeHost(hostname);
  const target = normalizeHost(domain);
  return host === target || host.endsWith(`.${target}`);
}

/** Levenshtein distance, bounded for short registrable-domain comparisons. */
function editDistance(a: string, b: string): number {
  if (Math.abs(a.length - b.length) > 2) return 3; // beyond our threshold
  const previous = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j += 1) previous[j] = j;
  for (let i = 1; i <= a.length; i += 1) {
    let diagonal = previous[0] ?? 0;
    previous[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const above = previous[j] ?? 0;
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      previous[j] = Math.min(above + 1, (previous[j - 1] ?? 0) + 1, diagonal + cost);
      diagonal = above;
    }
  }
  return previous[b.length] ?? 3;
}

/** Approximate registrable domain (last two labels — no PSL dependency). */
function registrableDomain(hostname: string): string {
  const labels = normalizeHost(hostname).split('.');
  return labels.slice(-2).join('.');
}

/**
 * dApp mimicry: the hostname is NOT a known dApp domain (or subdomain) but
 * either (a) embeds the brand label in a position the brand does not own
 * (`uniswap.org.evil.example`, `secure-uniswap.example`), or (b) typos the
 * registrable domain within edit distance 1 (`unisvvap.org` would be distance
 * 2 — flagged via the label rule; `uniswao.org` is distance 1).
 */
function detectDappMimicry(hostname: string, knownDomains: readonly string[]): boolean {
  const host = normalizeHost(hostname);
  for (const domain of knownDomains) {
    if (hostMatchesDomain(host, domain)) return false; // the real thing
  }
  const hostLabels = host.split('.');
  const hostRegistrable = registrableDomain(host);
  for (const domain of knownDomains) {
    const brand = domain.split('.')[0] ?? domain;
    // (a) brand label appears anywhere in the hostname's labels.
    if (brand.length >= 4 && hostLabels.some((label) => label.includes(brand))) return true;
    // (b) registrable-domain typo within edit distance 1.
    if (editDistance(hostRegistrable, domain) === 1) return true;
  }
  return false;
}

/**
 * Evaluate a URL against the drainer blocklist + heuristics (WS-G.4.2c).
 * Total: malformed URLs return a safe verdict (they will not navigate
 * anywhere wallet-relevant; the UGC pipeline only emits http/https/mailto).
 */
export function evaluateLinkSafety(
  url: string,
  blocklist: readonly string[],
  knownDappDomains: readonly string[] = KNOWN_DAPP_DOMAINS,
): LinkSafetyVerdict {
  const parsed = tryParseUrl(url);
  if (parsed === null) return SAFE_VERDICT;
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return SAFE_VERDICT;

  const reasons: ('blocklisted_domain' | 'contract_interaction' | 'dapp_mimicry')[] = [];

  if (blocklist.some((domain) => hostMatchesDomain(parsed.hostname, domain))) {
    reasons.push('blocklisted_domain');
  }

  // Include the fragment: hash-routed dApps (e.g. `/#/setApprovalForAll`) carry
  // the contract action in `hash`, which a path+query-only scan would miss.
  const target = `${parsed.pathname}${parsed.search}${parsed.hash}`.toLowerCase();
  if (CONTRACT_INTERACTION_PATTERNS.some((pattern) => target.includes(pattern))) {
    reasons.push('contract_interaction');
  }

  if (detectDappMimicry(parsed.hostname, knownDappDomains)) {
    reasons.push('dapp_mimicry');
  }

  return reasons.length === 0 ? SAFE_VERDICT : { suspicious: true, reasons };
}

/** Validate a configured blocklist entry (a bare lower-case domain). */
export function isValidBlocklistDomain(entry: string): boolean {
  return (
    entry.length >= 4 &&
    entry.length <= 253 &&
    /^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?)+$/.test(entry)
  );
}

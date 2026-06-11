// SPDX-License-Identifier: AGPL-3.0-or-later
//
// URL normalization (WS-F.1.3a, SPEC §14.2 "normalize URL and canonical
// source"). The canonical URL is the dedup key for exact-duplicate detection
// (WS-F.1.3b), the unique index on `story.canonical_url`, and the MERI URL
// canonicalization input (WS-H.2.1a) — so the function must be PURE, TOTAL,
// and IDEMPOTENT: the same input always yields the same output, and
// re-normalizing a canonical URL is a no-op (property-tested).
//
// Deliberate deviation from the WS-F.1.3a task text: the URL *path* keeps its
// case. RFC 3986 §6.2.2.1 defines only the scheme and host as
// case-insensitive; paths are case-SENSITIVE for most publishers (e.g. video
// ids and Wikipedia article paths), so lowercasing them would (a) collide
// genuinely different resources into one canonical URL — false-positive
// duplicate rejections via the unique index — and (b) break the stored
// link-out users follow to the publisher. Scheme and host are lowercased;
// everything else is normalized losslessly.

// ---------------------------------------------------------------------------
// Module-local structural types for the WHATWG `URL` / `URLSearchParams`
// globals (available in every supported runtime: browsers and Node ≥ 18).
// Declared locally — not via the DOM lib or @types/node — so this package
// stays environment-neutral and its compilation cannot accidentally admit
// browser- or node-only globals elsewhere.
// ---------------------------------------------------------------------------

interface WhatwgSearchParams {
  append(name: string, value: string): void;
  sort(): void;
  toString(): string;
  entries(): IterableIterator<[string, string]>;
}

interface WhatwgUrl {
  protocol: string;
  username: string;
  password: string;
  hostname: string;
  port: string;
  pathname: string;
  search: string;
  hash: string;
  readonly searchParams: WhatwgSearchParams;
  toString(): string;
}

const runtimeGlobals = globalThis as unknown as {
  URL: new (input: string) => WhatwgUrl;
  URLSearchParams: new () => WhatwgSearchParams;
};

/** Configurable tracking-parameter denylist (WS-F.1.3a). */
export interface TrackerDenylist {
  /** Exact query-parameter names (lowercase; matched case-insensitively). */
  exact: ReadonlySet<string>;
  /** Name prefixes (lowercase; matched case-insensitively), e.g. `utm_`. */
  prefixes: readonly string[];
}

/**
 * The initial tracker denylist from the WS-F.1.3a task card. Configurable at
 * runtime: the ingestion config (apps/api) can extend it without a code
 * deployment; this constant is only the seed/default.
 */
export const DEFAULT_TRACKER_DENYLIST: TrackerDenylist = {
  exact: new Set([
    // Click identifiers.
    'fbclid',
    'gclid',
    'gclsrc',
    'dclid',
    'gbraid',
    'wbraid',
    'msclkid',
    'twclkd',
    'twclid',
    'igshid',
    'igsh',
    'yclid',
    'wickedid',
    's_kwcid',
    // Mail/marketing campaign ids.
    'mc_cid',
    'mc_eid',
    'oly_anon_id',
    'oly_enc_id',
    'vero_id',
    'vero_conv',
    '_openstat',
    // Referrer/source attribution.
    'ref',
    'referrer',
    'source',
    'cmpid',
    'campaign_id',
    'spm',
    'scm',
    '__twitter_impression',
    'guccounter',
    'guce_referrer',
    'guce_referrer_sig',
  ]),
  // Prefix rules cover the whole utm_* family (utm_source, utm_id, utm_name,
  // utm_cid, utm_reader, utm_referrer, …) and ref_* (ref_src, ref_url, …).
  prefixes: ['utm_', 'ref_'],
};

/** Why a URL was rejected (typed, for field-level 400 responses). */
export type UrlNormalizationFailure =
  | 'malformed_url'
  | 'unsupported_scheme'
  | 'missing_host'
  | 'url_too_long';

export type NormalizedUrl =
  | {
      ok: true;
      /** The full canonical URL (https, no fragment, sorted query). */
      canonicalUrl: string;
      /** The canonical host (lowercase, punycoded, `www.` stripped). */
      canonicalDomain: string;
    }
  | { ok: false; reason: UrlNormalizationFailure };

/** Longest raw URL accepted (matches the request-schema bound). */
export const MAX_URL_LENGTH = 2048;

/**
 * Uppercase remaining percent-escapes and decode RFC 3986 *unreserved*
 * characters (ALPHA / DIGIT / `-` / `.` / `_` / `~`) — §6.2.2.2. Reserved
 * characters (`/`, `?`, `#`, `%`, `&`, `=`, …) are never decoded, so no new
 * path segments or query separators can be introduced. Dot segments are
 * resolved by the WHATWG parser BEFORE this runs (the parser already treats
 * `%2e`/`%2e%2e` segments as dot segments), so decoding a remaining `%2E`
 * inside a longer segment cannot re-create `..`.
 */
function normalizePercentEncoding(component: string): string {
  return component.replace(/%([0-9a-fA-F]{2})/g, (_match, hex: string) => {
    const code = Number.parseInt(hex, 16);
    const isAlpha = (code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a);
    const isDigit = code >= 0x30 && code <= 0x39;
    const isUnreservedMark = code === 0x2d || code === 0x2e || code === 0x5f || code === 0x7e;
    if (isAlpha || isDigit || isUnreservedMark) return String.fromCharCode(code);
    return `%${hex.toUpperCase()}`;
  });
}

/**
 * Strip a leading `www.` label. Conservative: only when the remainder still
 * contains a dot (so the registrable domain `www.com` itself — a different
 * host — is never rewritten to the TLD).
 */
function stripWww(hostname: string): string {
  if (hostname.startsWith('www.')) {
    const rest = hostname.slice(4);
    if (rest.includes('.')) return rest;
  }
  return hostname;
}

function isDeniedParam(name: string, denylist: TrackerDenylist): boolean {
  const lower = name.toLowerCase();
  if (denylist.exact.has(lower)) return true;
  return denylist.prefixes.some((prefix) => lower.startsWith(prefix));
}

/**
 * Normalize a raw URL to its canonical form (WS-F.1.3a). Transformations, in
 * order: parse (reject malformed); upgrade `http`→`https` and reject every
 * other scheme (`javascript`, `data`, `ftp`, … — stored-XSS / open-redirect
 * defense); strip userinfo (`user:pass@` — credential-leak / `bank.com@evil`
 * confusion defense); lowercase + punycode the host (WHATWG parser) and strip
 * a leading `www.`; drop the default port; resolve dot segments (parser),
 * normalize percent-encoding, and trim trailing slashes (root `/` kept);
 * remove denylisted tracking parameters, keep + sort the rest (stable — equal
 * keys keep their value order); drop the fragment.
 *
 * Pure and total: never throws; failures are typed values.
 */
export function normalizeUrl(
  raw: string,
  denylist: TrackerDenylist = DEFAULT_TRACKER_DENYLIST,
): NormalizedUrl {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return { ok: false, reason: 'malformed_url' };
  if (trimmed.length > MAX_URL_LENGTH) return { ok: false, reason: 'url_too_long' };

  let url: WhatwgUrl;
  try {
    url = new runtimeGlobals.URL(trimmed);
  } catch {
    return { ok: false, reason: 'malformed_url' };
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, reason: 'unsupported_scheme' };
  }
  url.protocol = 'https:';

  // Userinfo is stripped for safety (phishing-style `https://bank.com@evil.com`
  // confusion and credential leakage into stored canonical URLs).
  url.username = '';
  url.password = '';

  if (url.hostname.length === 0) return { ok: false, reason: 'missing_host' };
  url.hostname = stripWww(url.hostname);
  // The WHATWG serializer omits the scheme default; after the http→https
  // upgrade an explicit `:443` must also be dropped (`:80` stays — it is a
  // NON-default port for https and changes the resource).
  if (url.port === '443') url.port = '';

  // Path: dot segments are already resolved by the parser; normalize escapes
  // and trim trailing slashes down to (but never including) the root.
  let pathname = normalizePercentEncoding(url.pathname);
  while (pathname.length > 1 && pathname.endsWith('/')) {
    pathname = pathname.slice(0, -1);
  }
  url.pathname = pathname;

  // Query: drop denylisted trackers, then sort for order-independence.
  // URLSearchParams.sort() is stable (equal keys keep their value order) and
  // duplicate keys are preserved, per the task's edge-case rules.
  const kept = new runtimeGlobals.URLSearchParams();
  for (const [name, value] of url.searchParams.entries()) {
    if (!isDeniedParam(name, denylist)) kept.append(name, value);
  }
  kept.sort();
  url.search = kept.toString();

  url.hash = '';

  return { ok: true, canonicalUrl: url.toString(), canonicalDomain: url.hostname };
}

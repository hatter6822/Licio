// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The shared SSRF address policy. Owned HERE (not inside a single feature's
// fetcher) because more than one outbound path must honor exactly the same
// block ranges and the same rebinding-safe resolution gate: the WS-F content
// fetcher (`ingestion/safe-fetch.ts`, which re-exports these) AND the WS-C
// Web Push delivery leg (`lib/vapid.ts`), whose target endpoint is a
// client-registered URL and therefore just as untrusted as a submitted link.
//
// Blocked address space: loopback, RFC 1918 + CGNAT private ranges,
// link-local (incl. the 169.254.169.254 cloud metadata endpoint), multicast,
// reserved, unspecified, IPv6 ULA/link-local, and EVERY IPv6 form that embeds
// an IPv4 — mapped (`::ffff:0:0/96`), compatible (`::/96`), NAT64
// (`64:ff9b::/96`), 6to4 (`2002::/16`) and Teredo (`2001:0000::/32`) — each
// decoded back to its IPv4 and classified by the same v4 rules, because an
// embedded address that skips those rules is a private target wearing a
// global-unicast costume. The `lookup` gate is the only rebinding-safe place to
// validate a hostname: every name resolution passes through the validator, so
// a DNS answer that changes between "check" and "connect" cannot smuggle a
// private address (TOCTOU/DNS-rebinding defense).

import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import { isIP, type LookupFunction } from 'node:net';

/** Whether a literal IPv4 address is in a blocked range. */
export function isBlockedIpv4(address: string): boolean {
  const parts = address.split('.').map((p) => Number.parseInt(p, 10));
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) {
    return true; // malformed ⇒ blocked
  }
  const [a, b] = parts as [number, number, number, number];
  if (a === 0) return true; // 0.0.0.0/8 "this network"
  if (a === 10) return true; // RFC 1918
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64/10 CGNAT
  if (a === 127) return true; // loopback
  if (a === 169 && b === 254) return true; // link-local + cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // RFC 1918
  if (a === 192 && b === 0) return true; // 192.0.0/24 + 192.0.2/24 doc
  if (a === 192 && b === 168) return true; // RFC 1918
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
  if (a === 198 && b === 51) return true; // 198.51.100/24 doc
  if (a === 203 && b === 0) return true; // 203.0.113/24 doc
  // 192.88.99.0/24 — the 6to4 RELAY anycast (RFC 7526 deprecated it and
  // withdrew the assignment). Dialing it hands the request to whatever relay a
  // route happens to point at, which is the same "somewhere other than the host
  // named" problem the ranges above exist to prevent.
  if (a === 192 && b === 88 && (parts[2] as number) === 99) return true;
  if (a >= 224) return true; // multicast + reserved + broadcast
  return false;
}

/**
 * Expand an IPv6 literal to its 16 bytes — handling `::` zero-compression,
 * a zone id, an embedded dotted-IPv4 tail (`::ffff:127.0.0.1`), and the
 * hex-mapped tail (`::ffff:7f00:1`) uniformly. Returns null on anything it
 * cannot parse (callers FAIL CLOSED). This is the canonical form the range
 * checks run on, so neither representation of an embedded IPv4 can slip past.
 */
export function ipv6ToBytes(address: string): number[] | null {
  let addr = address.toLowerCase();
  const zone = addr.indexOf('%'); // strip a scope/zone id (fe80::1%eth0)
  if (zone !== -1) addr = addr.slice(0, zone);

  // An embedded dotted-IPv4 tail becomes its two hextets so the rest of the
  // parser only ever deals with hex groups.
  const lastColon = addr.lastIndexOf(':');
  if (lastColon !== -1 && addr.slice(lastColon + 1).includes('.')) {
    const v4 = addr
      .slice(lastColon + 1)
      .split('.')
      .map((p) => Number.parseInt(p, 10));
    if (v4.length !== 4 || v4.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
    const [a, b, c, d] = v4 as [number, number, number, number];
    addr = `${addr.slice(0, lastColon + 1)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }

  const halves = addr.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] === '' || halves[0] === undefined ? [] : halves[0].split(':');
  const tail =
    halves.length === 2 ? (halves[1] === '' ? [] : (halves[1] as string).split(':')) : null;
  let hextets: string[];
  if (tail === null) {
    hextets = head; // no `::`, must be all 8 groups
  } else {
    const fill = 8 - head.length - tail.length;
    if (fill < 0) return null;
    hextets = [...head, ...Array<string>(fill).fill('0'), ...tail];
  }
  if (hextets.length !== 8) return null;

  const bytes: number[] = [];
  for (const h of hextets) {
    if (!/^[0-9a-f]{1,4}$/.test(h)) return null;
    const value = Number.parseInt(h, 16);
    bytes.push((value >> 8) & 0xff, value & 0xff);
  }
  return bytes;
}

/** Whether a literal IPv6 address is in a blocked range. */
export function isBlockedIpv6(address: string): boolean {
  const bytes = ipv6ToBytes(address);
  if (bytes === null) return true; // unparseable ⇒ blocked (fail closed)
  const [b0, b1, b2, b3] = bytes as [number, number, number, number, ...number[]];

  // IPv4-mapped (`::ffff:0:0/96`) and the deprecated IPv4-compatible (`::/96`,
  // excluding `::` and `::1`) both EMBED an IPv4 in the last four bytes — check
  // it regardless of the textual representation (hex or dotted).
  const high96Zero = bytes.slice(0, 12).every((x) => x === 0);
  if (bytes.slice(0, 10).every((x) => x === 0) && bytes[10] === 0xff && bytes[11] === 0xff) {
    return isBlockedIpv4(`${bytes[12]}.${bytes[13]}.${bytes[14]}.${bytes[15]}`);
  }
  const embedded = `${bytes[12]}.${bytes[13]}.${bytes[14]}.${bytes[15]}`;
  if (high96Zero && embedded !== '0.0.0.0' && embedded !== '0.0.0.1') {
    return isBlockedIpv4(embedded); // IPv4-compatible (deprecated, still routable)
  }

  if (bytes.every((x) => x === 0)) return true; // :: unspecified
  if (high96Zero && embedded === '0.0.0.1') return true; // ::1 loopback
  if (b0 === 0xfe && (b1 & 0xc0) === 0x80) return true; // fe80::/10 link-local
  if ((b0 & 0xfe) === 0xfc) return true; // fc00::/7 ULA
  if (b0 === 0xff) return true; // ff00::/8 multicast
  if (b0 === 0x20 && b1 === 0x01 && b2 === 0x0d && b3 === 0xb8) return true; // 2001:db8::/32 docs

  // NAT64 (RFC 6052).  On IPv6-only infrastructure EVERY ordinary public IPv4
  // destination arrives translated, so blanket-refusing breaks content fetching
  // and Web Push outright (`guardedLookup` serves both) while blocking nothing
  // an attacker could not reach directly.  Decoded instead — but ONLY at the
  // prefix length that actually puts the IPv4 where we look for it.
  //
  // The WELL-KNOWN prefix is `64:ff9b::/96`: ninety-six bits, so bytes 4–11 must
  // be zero too.  Matching on the first four bytes alone is `64:ff9b::/32`, a
  // range 2^64 times larger in which the last four bytes are NOT the translated
  // address — `64:ff9b:1::/48` (RFC 8215 local-use) is inside it and carries the
  // IPv4 at a different offset entirely.  Reading the tail of one of those as
  // the destination lets a synthesised address park a public-looking value there
  // while the real target is private.  So: decode `/96`, and refuse anything
  // else under `64:ff9b::/32`, whose layout this function does not know.
  if (b0 === 0x00 && b1 === 0x64 && b2 === 0xff && b3 === 0x9b) {
    const wellKnown = bytes.slice(4, 12).every((x) => x === 0);
    return wellKnown ? isBlockedIpv4(embedded) : true;
  }

  // TRANSITION formats embed an IPv4 SOMEWHERE OTHER than the last four bytes,
  // so the IPv4-mapped/-compatible checks above cannot see it and the address
  // reaches the v6 range tests, none of which match. Left unhandled,
  // `2002:a9fe:a9fe::` is a perfectly ordinary-looking global-unicast address
  // that decodes to 169.254.169.254 — the cloud metadata endpoint this module's
  // header promises to block.
  //
  // Each is DECODED and run through the SAME v4 rules rather than blanket-
  // refused: the prefix is not itself the danger, the address inside it is, and
  // a 6to4 wrapper around a public IPv4 is a legitimate (if deprecated) way to
  // reach that host. Blanket-refusing would also drift from the v4 policy the
  // moment a range is added there.
  if (b0 === 0x20 && b1 === 0x02) {
    // 6to4 (RFC 3056, deprecated by RFC 7526): 2002:V4V4:V4V4::/48.
    return isBlockedIpv4(`${bytes[2]}.${bytes[3]}.${bytes[4]}.${bytes[5]}`);
  }
  if (b0 === 0x20 && b1 === 0x01 && b2 === 0x00 && b3 === 0x00) {
    // Teredo (RFC 4380): 2001:0000::/32, server IPv4 in bits 32–63 and the
    // CLIENT IPv4 in bits 96–127 obfuscated by a one's complement. Both are
    // dial-able targets, so both are classified.
    const server = `${bytes[4]}.${bytes[5]}.${bytes[6]}.${bytes[7]}`;
    const client = [12, 13, 14, 15].map((i) => ((bytes[i] as number) ^ 0xff) & 0xff).join('.');
    return isBlockedIpv4(server) || isBlockedIpv4(client);
  }
  return false;
}

/** Whether a RESOLVED address may be contacted (the per-hop gate). */
export function isBlockedAddress(address: string, family: number): boolean {
  if (family === 4 || isIP(address) === 4) return isBlockedIpv4(address);
  return isBlockedIpv6(address);
}

/**
 * A rebinding-safe node `lookup` for `http(s).request`/`get`: EVERY DNS answer
 * for the host is validated against `gate` before the socket connects, and any
 * answer in a blocked range aborts the resolution (so the address that was
 * checked is exactly the address that is dialed). Pass a narrowed `gate` only
 * in tests (e.g. to admit loopback for a local server).
 */
export function guardedLookup(
  gate: (address: string, family: number) => boolean = isBlockedAddress,
): LookupFunction {
  return (hostname, options, callback) => {
    // Node's autoSelectFamily (Happy Eyeballs; default in Node 20+) calls this
    // with `options.all === true` and expects an ARRAY back; the legacy path
    // expects a single (address, family) tuple. Honor BOTH shapes: returning a
    // tuple when an array was requested raises ERR_INVALID_IP_ADDRESS, which
    // silently fails EVERY hostname request (literal-IP hosts skip lookup, so
    // this only bites real DNS names — e.g. every FCM/Apple/Mozilla push
    // endpoint and every hostname content fetch). Either way the WHOLE resolved
    // set is validated first, so a blocked answer aborts before connect
    // (rebinding-safe).
    const wantsAll = typeof options === 'object' && options !== null && options.all === true;
    const cb = callback as (
      err: NodeJS.ErrnoException | null,
      address: string | LookupAddress[],
      family?: number,
    ) => void;
    dnsLookup(
      hostname,
      { ...(typeof options === 'object' ? options : {}), all: true },
      (error, addresses) => {
        if (error) {
          cb(error, '', 4);
          return;
        }
        const list = Array.isArray(addresses) ? addresses : [addresses];
        for (const entry of list) {
          if (gate(entry.address, entry.family)) {
            cb(new Error('blocked address range'), '', 4);
            return;
          }
        }
        const first = list[0];
        if (first === undefined) {
          cb(new Error('no addresses resolved'), '', 4);
          return;
        }
        if (wantsAll) {
          cb(null, list);
        } else {
          cb(null, first.address, first.family);
        }
      },
    );
  };
}

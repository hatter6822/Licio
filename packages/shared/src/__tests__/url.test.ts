// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-F.1.3a — URL normalization. Covers the task card's acceptance criteria
// (30+ cases) plus the two required properties: idempotency
// (normalize∘normalize = normalize) and tracker/fragment invariance (URLs
// differing only by denylisted params or fragment normalize identically).
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_TRACKER_DENYLIST,
  MAX_URL_LENGTH,
  normalizeUrl,
  type TrackerDenylist,
} from '../utils/url.js';

function canonical(raw: string): string {
  const result = normalizeUrl(raw);
  if (!result.ok) throw new Error(`expected ok for ${raw}, got ${result.reason}`);
  return result.canonicalUrl;
}

function failure(raw: string): string {
  const result = normalizeUrl(raw);
  if (result.ok) throw new Error(`expected failure for ${raw}, got ${result.canonicalUrl}`);
  return result.reason;
}

describe('normalizeUrl — scheme and host (WS-F.1.3a)', () => {
  it('normalizes the task acceptance example exactly', () => {
    expect(canonical('http://WWW.Example.Com/path/?utm_source=twitter&id=5')).toBe(
      'https://example.com/path?id=5',
    );
  });

  it('upgrades http to https', () => {
    expect(canonical('http://example.com/a')).toBe('https://example.com/a');
  });

  it('lowercases the scheme and host', () => {
    expect(canonical('HTTPS://EXAMPLE.COM/Path')).toBe('https://example.com/Path');
  });

  it('preserves path case (RFC 3986: only scheme/host are case-insensitive)', () => {
    expect(canonical('https://example.com/Watch/AbC123')).toBe('https://example.com/Watch/AbC123');
    // Different-case paths stay distinct resources.
    expect(canonical('https://example.com/watch/abc123')).not.toBe(
      canonical('https://example.com/watch/ABC123'),
    );
  });

  it('removes the www. prefix', () => {
    expect(canonical('https://www.example.com/')).toBe('https://example.com/');
  });

  it('does not strip www when the remainder is a bare label (www.com is a real host)', () => {
    expect(canonical('https://www.com/x')).toBe('https://www.com/x');
  });

  it('removes default ports for both original schemes', () => {
    expect(canonical('http://example.com:80/a')).toBe('https://example.com/a');
    expect(canonical('https://example.com:443/a')).toBe('https://example.com/a');
    expect(canonical('http://example.com:443/a')).toBe('https://example.com/a');
  });

  it('preserves non-default ports', () => {
    expect(canonical('https://example.com:8443/a')).toBe('https://example.com:8443/a');
    // :80 is NOT the https default; dropping it would change the resource.
    expect(canonical('https://example.com:80/a')).toBe('https://example.com:80/a');
  });

  it('punycodes IDN hosts to a single canonical xn-- form', () => {
    expect(canonical('https://münchen.example/straße')).toBe(
      canonical('https://xn--mnchen-3ya.example/straße'),
    );
    expect(
      canonical('https://münchen.example/x').startsWith('https://xn--mnchen-3ya.example/'),
    ).toBe(true);
  });

  it('strips userinfo (credential leakage / bank.com@evil.com confusion)', () => {
    expect(canonical('https://user:secret@example.com/a')).toBe('https://example.com/a');
    expect(canonical('https://bank.com@evil.example/login')).toBe('https://evil.example/login');
  });
});

describe('normalizeUrl — path normalization', () => {
  it('removes a trailing slash except for the root', () => {
    expect(canonical('https://example.com/path/')).toBe('https://example.com/path');
    expect(canonical('https://example.com/')).toBe('https://example.com/');
    expect(canonical('https://example.com')).toBe('https://example.com/');
  });

  it('collapses repeated trailing slashes deterministically', () => {
    expect(canonical('https://example.com/path///')).toBe('https://example.com/path');
  });

  it('resolves . and .. segments', () => {
    expect(canonical('https://example.com/a/./b/../c')).toBe('https://example.com/a/c');
  });

  it('resolves percent-encoded dot segments at parse time (no traversal re-introduction)', () => {
    expect(canonical('https://example.com/a/%2e%2e/b')).toBe('https://example.com/b');
  });

  it('decodes percent-encoded unreserved characters', () => {
    expect(canonical('https://example.com/%41rticle%2Dname')).toBe(
      'https://example.com/Article-name',
    );
  });

  it('uppercases remaining percent-escape hex digits', () => {
    expect(canonical('https://example.com/a%2fb')).toBe('https://example.com/a%2Fb');
  });

  it('never decodes reserved characters (%2F stays an escape, not a separator)', () => {
    expect(canonical('https://example.com/a%2Fb')).toBe('https://example.com/a%2Fb');
    expect(canonical('https://example.com/a%2Fb')).not.toBe(canonical('https://example.com/a/b'));
  });
});

describe('normalizeUrl — query handling', () => {
  it.each([
    'utm_source',
    'utm_medium',
    'utm_campaign',
    'utm_term',
    'utm_content',
    'utm_id',
    'utm_name',
    'utm_cid',
    'utm_reader',
    'utm_referrer',
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
    'mc_cid',
    'mc_eid',
    'yclid',
    '_openstat',
    'oly_anon_id',
    'oly_enc_id',
    'vero_id',
    'vero_conv',
    'wickedid',
    's_kwcid',
    'ref',
    'ref_src',
    'ref_url',
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
  ])('strips the tracking parameter %s', (param) => {
    expect(canonical(`https://example.com/a?${param}=x&id=5`)).toBe('https://example.com/a?id=5');
  });

  it('matches denylisted parameters case-insensitively', () => {
    expect(canonical('https://example.com/a?UTM_Source=x&FBCLID=y&id=5')).toBe(
      'https://example.com/a?id=5',
    );
  });

  it('preserves and alphabetically sorts non-tracking parameters', () => {
    expect(canonical('https://example.com/a?z=1&a=2&m=3')).toBe(
      'https://example.com/a?a=2&m=3&z=1',
    );
  });

  it('preserves duplicate keys in stable (value-order-preserving) sorted order', () => {
    expect(canonical('https://example.com/a?b=2&a=first&a=second')).toBe(
      'https://example.com/a?a=first&a=second&b=2',
    );
  });

  it('omits the ? entirely when stripping empties the query', () => {
    expect(canonical('https://example.com/a?utm_source=x&utm_medium=y')).toBe(
      'https://example.com/a',
    );
  });

  it('keeps an id-bearing parameter that merely resembles a tracker', () => {
    // `reference` is not on the denylist (`ref`/`ref_*`/`referrer` are).
    expect(canonical('https://example.com/a?reference=42')).toBe(
      'https://example.com/a?reference=42',
    );
  });

  it('supports a custom denylist (configurable without code changes)', () => {
    const custom: TrackerDenylist = { exact: new Set(['sessionid']), prefixes: ['trk_'] };
    const result = normalizeUrl('https://example.com/a?sessionid=1&trk_x=2&id=3', custom);
    expect(result.ok && result.canonicalUrl).toBe('https://example.com/a?id=3');
    // The default list is untouched by custom usage.
    expect(canonical('https://example.com/a?sessionid=1')).toBe(
      'https://example.com/a?sessionid=1',
    );
  });
});

describe('normalizeUrl — fragments and rejection', () => {
  it('removes fragments', () => {
    expect(canonical('https://example.com/a#section-2')).toBe('https://example.com/a');
  });

  it('rejects malformed URLs with a typed reason', () => {
    expect(failure('not a url')).toBe('malformed_url');
    expect(failure('')).toBe('malformed_url');
    expect(failure('http://')).toBe('malformed_url');
  });

  it.each([
    'ftp://example.com/file',
    'javascript:alert(1)',
    'data:text/html,hi',
    'file:///etc/passwd',
    'vbscript:x',
  ])('rejects the non-http(s) scheme in %s', (raw) => {
    expect(failure(raw)).toBe('unsupported_scheme');
  });

  it('rejects over-length URLs', () => {
    const raw = `https://example.com/${'a'.repeat(MAX_URL_LENGTH)}`;
    expect(failure(raw)).toBe('url_too_long');
  });

  it('returns the canonical domain alongside the URL', () => {
    const result = normalizeUrl('http://WWW.News.Example.COM/a');
    expect(result.ok && result.canonicalDomain).toBe('news.example.com');
  });
});

describe('normalizeUrl — required properties', () => {
  const corpus = [
    'http://WWW.Example.Com/path/?utm_source=twitter&id=5',
    'https://example.com/a/./b/../c?z=1&a=2#frag',
    'https://user:pass@Example.com:443/Deep/Path///?ref=rss&b=2&a=1&a=0',
    'https://münchen.example/straße?fbclid=abc',
    'https://example.com/%41%2D%7e%2f?q=%41+%2B',
    'http://example.com:80/?guce_referrer=x&keep=yes',
    'https://www.example.co.uk/Article/Title-Case?utm_id=1&page=2&page=1',
    'https://example.com',
  ];

  it('is idempotent: normalize(normalize(url)) === normalize(url)', () => {
    for (const raw of corpus) {
      const once = canonical(raw);
      expect(canonical(once)).toBe(once);
    }
  });

  it('is invariant under denylisted params and fragments', () => {
    for (const raw of corpus) {
      const base = canonical(raw);
      const withNoise = canonical(
        `${raw}${raw.includes('?') ? '&' : '?'}utm_campaign=noise&gclid=123&ref_src=tw#frag2`,
      );
      expect(withNoise).toBe(base);
    }
  });

  it('treats tracker-only differences as the same canonical URL (dedup contract)', () => {
    expect(canonical('http://example.com/path?utm_source=x')).toBe(
      canonical('https://example.com/path'),
    );
  });

  it('exposes prefix rules covering the documented utm_/ref_ families', () => {
    expect(DEFAULT_TRACKER_DENYLIST.prefixes).toContain('utm_');
    expect(DEFAULT_TRACKER_DENYLIST.prefixes).toContain('ref_');
  });
});

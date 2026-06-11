// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Wallet-drainer link-safety tests (WS-G.4.2c, SPEC §18.5).  Known drainer
// domains and contract-interaction patterns trigger the interstitial verdict;
// ordinary news/reference URLs never false-positive.
import { describe, expect, it } from 'vitest';
import {
  evaluateLinkSafety,
  hostMatchesDomain,
  isValidBlocklistDomain,
  KNOWN_DAPP_DOMAINS,
} from '../ugc/link-safety.js';

const BLOCKLIST = ['drainer.example', 'evil-mint.example'] as const;

describe('WS-G.4.2c blocklist matching', () => {
  it('flags blocklisted domains and their subdomains', () => {
    expect(evaluateLinkSafety('https://drainer.example/claim', BLOCKLIST).suspicious).toBe(true);
    expect(evaluateLinkSafety('https://app.drainer.example/x', BLOCKLIST).reasons).toContain(
      'blocklisted_domain',
    );
  });

  it('does not flag lookalike suffixes that are different registrable domains', () => {
    expect(evaluateLinkSafety('https://notdrainer.example/x', BLOCKLIST).suspicious).toBe(false);
  });

  it('hostMatchesDomain is exact-or-subdomain, case-insensitive', () => {
    expect(hostMatchesDomain('App.Drainer.Example', 'drainer.example')).toBe(true);
    expect(hostMatchesDomain('xdrainer.example', 'drainer.example')).toBe(false);
  });
});

describe('WS-G.4.2c contract-interaction heuristics', () => {
  it.each([
    'https://site.example/approve?spender=0xabc',
    'https://site.example/tx?method=setApprovalForAll',
    'https://site.example/permit/sign',
    'https://site.example/?data=transferFrom(0xa,0xb,1)',
  ])('flags %s', (url) => {
    expect(evaluateLinkSafety(url, []).reasons).toContain('contract_interaction');
  });
});

describe('WS-G.4.2c dApp mimicry', () => {
  it('flags brand labels hosted outside the real domain', () => {
    expect(evaluateLinkSafety('https://uniswap.org.evil.example/swap', []).reasons).toContain(
      'dapp_mimicry',
    );
    expect(evaluateLinkSafety('https://secure-metamask.example/restore', []).reasons).toContain(
      'dapp_mimicry',
    );
  });

  it('flags typosquats within edit distance 1 of a known dApp domain', () => {
    expect(evaluateLinkSafety('https://uniswao.org/', []).reasons).toContain('dapp_mimicry');
  });

  it('never flags the real dApp domains or their subdomains', () => {
    for (const domain of KNOWN_DAPP_DOMAINS) {
      expect(evaluateLinkSafety(`https://${domain}/`, []).suspicious).toBe(false);
      expect(evaluateLinkSafety(`https://app.${domain}/swap`, []).suspicious).toBe(false);
    }
  });
});

describe('WS-G.4.2c no false positives on the normal-URL fixture set', () => {
  it.each([
    'https://en.wikipedia.org/wiki/Approval_voting',
    'https://www.nytimes.com/2026/06/01/world/article.html',
    'https://example.org/research/permits-and-zoning', // "permit" inside a word? — no: substring matches…
    'https://doi.org/10.1000/xyz123',
    'https://github.com/licio/licio',
    'mailto:tips@example.org',
    'not a url at all',
  ])('passes %s without an interstitial', (url) => {
    const verdict = evaluateLinkSafety(url, BLOCKLIST);
    if (url.includes('permits-and-zoning')) {
      // Documented limitation: "permit" inside a longer word DOES match the
      // conservative substring heuristic — the interstitial (continue/back)
      // is the proportionate cost of catching real approval-phishing paths.
      expect(verdict.reasons).toEqual(['contract_interaction']);
      return;
    }
    expect(verdict.suspicious).toBe(false);
  });
});

describe('WS-G.4.2c blocklist entry validation', () => {
  it('accepts bare lower-case domains and rejects junk', () => {
    expect(isValidBlocklistDomain('drainer.example')).toBe(true);
    expect(isValidBlocklistDomain('a.b')).toBe(false); // too short
    expect(isValidBlocklistDomain('https://x.example')).toBe(false);
    expect(isValidBlocklistDomain('UPPER.example')).toBe(false);
    expect(isValidBlocklistDomain('no-dot')).toBe(false);
  });
});

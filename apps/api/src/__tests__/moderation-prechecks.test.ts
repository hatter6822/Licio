// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-J.2.6 detection-math tests: pure, total, bounded functions with the
// monotonicity + base-rate (MFCI-1) guarantees the spec relies on.
import { describe, expect, it } from 'vitest';
import { DEFAULT_MODERATION_CONFIG, type ModerationRuntimeConfig } from '../moderation/config.js';
import {
  clamp01,
  classifyDuplicateFlood,
  classifyMalware,
  classifySpam,
  contentSignature,
  coordinationScore,
  HeuristicPolicyRiskClassifier,
  LocalBlocklistReputationProvider,
  noisyOr,
  normalizeForSignature,
  RecentSubmissionTracker,
  temporalConcentration,
  type UrlReputationProvider,
  urlHostname,
} from '../moderation/prechecks.js';

const cfg = (over: Partial<ModerationRuntimeConfig> = {}): ModerationRuntimeConfig => ({
  ...DEFAULT_MODERATION_CONFIG,
  ...over,
});

describe('clamp01 + noisyOr', () => {
  it('clamps to the unit interval and handles NaN', () => {
    expect(clamp01(-1)).toBe(0);
    expect(clamp01(2)).toBe(1);
    expect(clamp01(0.5)).toBe(0.5);
    expect(clamp01(Number.NaN)).toBe(0);
  });

  it('noisyOr is bounded, order-independent, and monotone', () => {
    expect(noisyOr([])).toBe(0);
    expect(noisyOr([1])).toBe(1);
    expect(noisyOr([0.5, 0.5])).toBeCloseTo(0.75, 10);
    expect(noisyOr([0.5, 0.5])).toBeCloseTo(noisyOr([0.5, 0.5].reverse()), 10);
    // Adding a signal never decreases the result.
    expect(noisyOr([0.5, 0.3])).toBeGreaterThanOrEqual(noisyOr([0.5]));
    expect(noisyOr([0.9, 0.9, 0.9])).toBeLessThanOrEqual(1);
  });
});

describe('classifySpam', () => {
  it('passes clean content from an established account', () => {
    const v = classifySpam(
      {
        text: 'A thoughtful question about transit data.',
        urls: [],
        accountAgeDays: 400,
        recentSimilarCount: 0,
      },
      cfg(),
    );
    expect(v.disposition).toBe('pass');
    expect(v.confidence).toBe(0);
  });

  it('auto-blocks a known spam hash (an auto-block path)', () => {
    const text = 'BUY CHEAP FOLLOWERS NOW';
    const v = classifySpam(
      { text, urls: [], accountAgeDays: 400, recentSimilarCount: 0 },
      cfg({ knownSpamHashes: [contentSignature(text)] }),
    );
    expect(v.disposition).toBe('block');
    expect(v.signals).toContain('known_spam_hash');
  });

  it('flags a pattern match below the block threshold', () => {
    const v = classifySpam(
      {
        text: 'visit my-spam-site for free crypto',
        urls: [],
        accountAgeDays: 400,
        recentSimilarCount: 0,
      },
      cfg({ spamPatterns: ['free crypto'] }),
    );
    expect(v.disposition).toBe('flag');
    expect(v.confidence).toBeCloseTo(0.6, 10);
  });

  it('raises confidence with velocity + new-account-link-heavy (noisy-OR)', () => {
    const v = classifySpam(
      {
        text: 'same thing again',
        urls: ['https://a.test', 'https://b.test'],
        accountAgeDays: 0,
        recentSimilarCount: 5,
      },
      cfg(),
    );
    // velocity (0.7) ⊕ new-link (0.5) = 0.85 → block threshold.
    expect(v.confidence).toBeCloseTo(0.85, 10);
    expect(v.disposition).toBe('block');
  });
});

describe('classifyMalware', () => {
  const provider = (
    verdicts: Record<string, 'clear' | 'malicious' | 'unavailable'>,
  ): UrlReputationProvider => ({
    async check(domain) {
      return verdicts[domain] ?? 'clear';
    },
  });

  it('blocks a known malware domain (auto-block path)', async () => {
    const v = await classifyMalware(
      ['https://evil.test/x'],
      provider({ 'evil.test': 'malicious' }),
    );
    expect(v.disposition).toBe('block');
    expect(v.url).toBe('https://evil.test/x');
  });

  it('flags when reputation is unavailable (fail toward flagging, never trusting)', async () => {
    const v = await classifyMalware(
      ['https://maybe.test'],
      provider({ 'maybe.test': 'unavailable' }),
    );
    expect(v.disposition).toBe('flag');
  });

  it('clears when all domains are clean and ignores unparseable urls', async () => {
    const v = await classifyMalware(['https://ok.test', 'not a url'], provider({}));
    expect(v.disposition).toBe('clear');
  });

  it('LocalBlocklistReputationProvider consults the configured set, including subdomains', async () => {
    const p = new LocalBlocklistReputationProvider(() => new Set(['drainer.test']));
    expect(await p.check('drainer.test')).toBe('malicious');
    // A bare blocklist entry covers its subdomains (shared link-safety semantics)
    // — an exact-host lookup would let this through.
    expect(await p.check('app.drainer.test')).toBe('malicious');
    expect(await p.check('a.b.drainer.test')).toBe('malicious');
    expect(await p.check('safe.test')).toBe('clear');
    // A look-alike that merely ends with the string but not on a label boundary
    // is NOT a subdomain (no false positive).
    expect(await p.check('notdrainer.test')).toBe('clear');
    expect(urlHostname('https://Foo.test/a')).toBe('foo.test');
    expect(urlHostname('garbage')).toBeNull();
  });
});

describe('duplicate-flood', () => {
  it('flags near-duplicates across enough rooms in the window, not legitimate cross-posts', () => {
    const tracker = new RecentSubmissionTracker();
    const sig = contentSignature('cross posted text');
    const t0 = 1_000_000;
    tracker.record({ userId: 'u1', signature: sig, roomId: 'r1', atMs: t0 });
    tracker.record({ userId: 'u1', signature: sig, roomId: 'r2', atMs: t0 + 1000 });
    // 2 prior + this one (in a third room r3) = 3 across 3 rooms → flagged.
    const verdict = classifyDuplicateFlood(
      tracker.floodStats('u1', sig, t0 + 2000, 900_000, 'r3'),
      cfg(),
    );
    expect(verdict.flagged).toBe(true);
    expect(verdict.similarCount).toBe(3);
    expect(verdict.distinctRooms).toBe(3);

    // The SAME content reposted three times into the SAME room is 3 posts but
    // only ONE distinct room → NOT cross-room flooding (the bug was counting the
    // current room as always-new, which would inflate this to 2 and flag it).
    const same = contentSignature('same room spam');
    tracker.record({ userId: 'u2', signature: same, roomId: 'rA', atMs: t0 });
    tracker.record({ userId: 'u2', signature: same, roomId: 'rA', atMs: t0 + 1000 });
    const sameRoom = classifyDuplicateFlood(
      tracker.floodStats('u2', same, t0 + 2000, 900_000, 'rA'),
      cfg(),
    );
    expect(sameRoom.distinctRooms).toBe(1);
    expect(sameRoom.flagged).toBe(false);

    // A single cross-post (1 prior in 1 room) is NOT a flood.
    const low = classifyDuplicateFlood(
      tracker.floodStats('u1', contentSignature('unique'), t0, 900_000, 'rX'),
      cfg(),
    );
    expect(low.flagged).toBe(false);
  });

  it('prune drops entries outside the window', () => {
    const tracker = new RecentSubmissionTracker();
    tracker.record({ userId: 'u', signature: 's', roomId: 'r', atMs: 0 });
    tracker.prune(1_000_000, 500);
    expect(tracker.floodStats('u', 's', 1_000_000, 500).similarCount).toBe(0);
  });

  it('normalizeForSignature collapses whitespace + case', () => {
    expect(normalizeForSignature('  Hello   WORLD ')).toBe('hello world');
    expect(contentSignature('a b')).toBe(contentSignature('A   B'));
  });
});

describe('policy-risk classifier (flag, never remove)', () => {
  const classifier = new HeuristicPolicyRiskClassifier();
  it('flags threats as critical and benign content as not flagged', () => {
    expect(classifier.classify('i will kill you').severity).toBe('critical');
    expect(classifier.classify('i will kill you').flagged).toBe(true);
    expect(classifier.classify('A neutral statement about policy.').flagged).toBe(false);
  });
  it('classifies harassment as high', () => {
    const v = classifier.classify("you're worthless");
    expect(v.flagged).toBe(true);
    expect(v.severity).toBe('high');
    expect(v.categories).toContain('harassment');
  });
});

describe('coordination score (base-rate conditioned, MFCI-1)', () => {
  it('is 0 below the volume threshold', () => {
    const v = coordinationScore(
      { distinctReporters: 3, reporterAccountAgesDays: [0, 0, 0], timestampsMs: [1, 2, 3] },
      cfg(),
    );
    expect(v.volumeMet).toBe(false);
    expect(v.score).toBe(0);
  });

  it('does NOT flag a large AUTHENTIC community (diverse, older accounts)', () => {
    const ages = Array.from({ length: 12 }, (_, i) => 30 + i * 20); // all old
    const ts = Array.from({ length: 12 }, (_, i) => 1000 + i * 100);
    const v = coordinationScore(
      { distinctReporters: 12, reporterAccountAgesDays: ages, timestampsMs: ts },
      cfg(),
    );
    expect(v.volumeMet).toBe(true);
    expect(v.newAccountFraction).toBe(0);
    expect(v.score).toBe(0); // base-rate conditioning protects the community
  });

  it('flags a freshly-minted sock-puppet brigade (high new-account fraction, tight timing)', () => {
    const ages = Array.from({ length: 12 }, () => 0); // all brand new
    const ts = Array.from({ length: 12 }, () => 1000); // simultaneous
    const v = coordinationScore(
      { distinctReporters: 12, reporterAccountAgesDays: ages, timestampsMs: ts },
      cfg(),
    );
    expect(v.newAccountFraction).toBe(1);
    expect(v.temporalConcentration).toBe(1);
    expect(v.score).toBeCloseTo(1, 10);
    expect(v.score).toBeGreaterThanOrEqual(cfg().coordinationDelayThreshold);
  });

  it('temporalConcentration is 1 for simultaneous and →0 as spread widens', () => {
    expect(temporalConcentration([5, 5, 5], 1000)).toBe(1);
    expect(temporalConcentration([0, 1000], 1000)).toBe(0);
    expect(temporalConcentration([0, 500], 1000)).toBeCloseTo(0.5, 10);
    expect(temporalConcentration([1], 1000)).toBe(0); // need ≥2
  });
});

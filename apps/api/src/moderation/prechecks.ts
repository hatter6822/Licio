// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-J.2.6 automated pre-checks (SPEC §18.2).  Four detectors, all with the
// human-review-not-auto-removal posture except the two permitted auto-block
// paths (high-confidence spam, malware):
//   • spam (WS-J.2.6a)            — pattern + velocity + known-hash + account-age
//   • malware links (WS-J.2.6b)   — local blocklist + injected reputation provider
//   • duplicate flood (WS-J.2.6c) — per-account near-dup across rooms in a window
//   • policy-risk (WS-J.2.6d)     — toxicity/graphic/etc. heuristics → FLAG only
//   • coordinated reports (WS-J.2.6e) — base-rate-conditioned coordination score
//
// The detection MATH lives here as pure, total, bounded functions (unit-tested
// for monotonicity and the base-rate guarantee); the stateful trackers are
// ephemeral in-memory windows (rebuildable; Redis in production, like the WS-E
// real-time layer).  The classifiers are seams WS-K replaces with governed
// models — they FLAG; they never remove (except the two auto-block paths).
import { createHash } from 'node:crypto';
import type { ModerationRuntimeConfig } from './config.js';

/** Clamp to the unit interval. */
export function clamp01(x: number): number {
  if (Number.isNaN(x)) return 0;
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

/**
 * Probabilistic OR of independent signal probabilities: 1 − ∏(1 − p_i).
 * Monotone non-decreasing in each p_i, bounded in [0,1], and order-independent
 * — the principled way to combine independent "spamminess" signals.
 */
export function noisyOr(probabilities: readonly number[]): number {
  let complement = 1;
  for (const p of probabilities) complement *= 1 - clamp01(p);
  return clamp01(1 - complement);
}

// ---------------------------------------------------------------------------
// Spam (WS-J.2.6a).
// ---------------------------------------------------------------------------

export interface SpamSubmission {
  /** Title + body (what patterns/hash run over). */
  text: string;
  /** URLs the submission carries (link-heavy is a new-account signal). */
  urls: readonly string[];
  /** Submitter account age in days (null = unknown → treated as new). */
  accountAgeDays: number | null;
  /** Count of similar recent submissions by this account in the velocity window. */
  recentSimilarCount: number;
}

export type SpamDisposition = 'block' | 'flag' | 'pass';

export interface SpamVerdict {
  confidence: number;
  disposition: SpamDisposition;
  signals: string[];
}

/** Normalize text for hashing/pattern matching (lower-case, collapse space). */
export function normalizeForSignature(text: string): string {
  return text.toLowerCase().replace(/\s+/g, ' ').trim();
}

/** Stable content signature (sha-256 hex of normalized text). */
export function contentSignature(text: string): string {
  return createHash('sha256').update(normalizeForSignature(text)).digest('hex');
}

/**
 * Spam confidence via noisy-OR of fired signals.  Each signal contributes a
 * bounded probability; the combination is monotone and in [0,1].  Disposition:
 * `block` ≥ block threshold (an auto-block path), `flag` ≥ 0.5, else `pass`.
 */
export function classifySpam(
  submission: SpamSubmission,
  config: ModerationRuntimeConfig,
): SpamVerdict {
  const signals: string[] = [];
  const probs: number[] = [];
  const normalized = normalizeForSignature(submission.text);

  if (config.knownSpamHashes.includes(contentSignature(submission.text))) {
    signals.push('known_spam_hash');
    probs.push(0.99);
  }
  for (const pattern of config.spamPatterns) {
    if (pattern.length > 0 && normalized.includes(pattern.toLowerCase())) {
      signals.push('spam_pattern');
      probs.push(0.6);
      break;
    }
  }
  if (submission.recentSimilarCount + 1 >= config.spamVelocityCount) {
    signals.push('velocity');
    probs.push(0.7);
  }
  const isNew = submission.accountAgeDays === null || submission.accountAgeDays < 1;
  if (isNew && submission.urls.length >= 2) {
    signals.push('new_account_link_heavy');
    probs.push(0.5);
  }

  const confidence = noisyOr(probs);
  const disposition: SpamDisposition =
    confidence >= config.spamBlockThreshold ? 'block' : confidence >= 0.5 ? 'flag' : 'pass';
  return { confidence, disposition, signals };
}

// ---------------------------------------------------------------------------
// Malware links (WS-J.2.6b).
// ---------------------------------------------------------------------------

export type UrlReputation = 'clear' | 'malicious' | 'unavailable';

/**
 * Reputation seam (WS-J.2.6b).  The default consults the local blocklist only
 * (no egress); a production provider adds Safe-Browsing-style lookups + the
 * redirect-chain follower behind an SSRF-restricted fetcher.  Resolving
 * reputation NEVER executes content.
 */
export interface UrlReputationProvider {
  check(domain: string): Promise<UrlReputation>;
}

/** Default provider: the config malware-domain blocklist (fail-closed = the
 *  list is authoritative; an unlisted domain is `clear` here, and the seam is
 *  replaced by the real provider in production). */
export class LocalBlocklistReputationProvider implements UrlReputationProvider {
  readonly #domains: () => ReadonlySet<string>;
  constructor(domains: () => ReadonlySet<string>) {
    this.#domains = domains;
  }
  async check(domain: string): Promise<UrlReputation> {
    return this.#domains().has(domain.toLowerCase()) ? 'malicious' : 'clear';
  }
}

export type MalwareDisposition = 'block' | 'flag' | 'clear';

export interface MalwareVerdict {
  disposition: MalwareDisposition;
  /** The offending URL (block) or the unverifiable URL (flag). */
  url: string | null;
  signal: string | null;
}

/** Extract the lower-case hostname of a URL, or null if unparseable. */
export function urlHostname(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Check submitted URLs against reputation.  A `malicious` verdict BLOCKS (an
 * auto-block path); `unavailable` FLAGS (fail toward flagging, never trusting —
 * WS-J.2.6b observability note); all clear → `clear`.
 */
export async function classifyMalware(
  urls: readonly string[],
  provider: UrlReputationProvider,
): Promise<MalwareVerdict> {
  let flagged: string | null = null;
  const seen = new Set<string>();
  for (const url of urls) {
    const host = urlHostname(url);
    if (host === null || seen.has(host)) continue;
    seen.add(host);
    const reputation = await provider.check(host);
    if (reputation === 'malicious') return { disposition: 'block', url, signal: 'malware_domain' };
    if (reputation === 'unavailable' && flagged === null) flagged = url;
  }
  return flagged !== null
    ? { disposition: 'flag', url: flagged, signal: 'reputation_unavailable' }
    : { disposition: 'clear', url: null, signal: null };
}

// ---------------------------------------------------------------------------
// Duplicate-flood (WS-J.2.6c) — flag, never remove.
// ---------------------------------------------------------------------------

export interface SubmissionFingerprint {
  userId: string;
  signature: string;
  roomId: string;
  atMs: number;
}

/**
 * Ephemeral per-account recent-submission window (rebuildable; Redis in
 * production).  `record` adds a fingerprint; `floodStats` reports, for a NEW
 * fingerprint, how many near-identical posts the account made across how many
 * distinct rooms inside the window.
 */
export class RecentSubmissionTracker {
  readonly #byUser = new Map<string, SubmissionFingerprint[]>();

  record(fp: SubmissionFingerprint): void {
    const list = this.#byUser.get(fp.userId) ?? [];
    list.push(fp);
    this.#byUser.set(fp.userId, list);
  }

  /** Prune entries older than `windowMs` before `nowMs` (bounds memory). */
  prune(nowMs: number, windowMs: number): void {
    const cutoff = nowMs - windowMs;
    for (const [userId, list] of this.#byUser) {
      const kept = list.filter((fp) => fp.atMs >= cutoff);
      if (kept.length === 0) this.#byUser.delete(userId);
      else this.#byUser.set(userId, kept);
    }
  }

  floodStats(
    userId: string,
    signature: string,
    nowMs: number,
    windowMs: number,
  ): { similarCount: number; distinctRooms: number } {
    const cutoff = nowMs - windowMs;
    const matches = (this.#byUser.get(userId) ?? []).filter(
      (fp) => fp.atMs >= cutoff && fp.signature === signature,
    );
    return {
      similarCount: matches.length,
      distinctRooms: new Set(matches.map((m) => m.roomId)).size,
    };
  }

  clear(): void {
    this.#byUser.clear();
  }
}

export interface FloodVerdict {
  flagged: boolean;
  similarCount: number;
  distinctRooms: number;
}

/** Flag (never remove) when an account near-duplicates across enough rooms in
 *  the window.  The new submission is counted, so the threshold is inclusive. */
export function classifyDuplicateFlood(
  stats: { similarCount: number; distinctRooms: number },
  config: ModerationRuntimeConfig,
): FloodVerdict {
  const flagged =
    stats.similarCount + 1 >= config.duplicateFloodCount &&
    stats.distinctRooms + 1 >= config.duplicateFloodMinRooms;
  return { flagged, similarCount: stats.similarCount + 1, distinctRooms: stats.distinctRooms + 1 };
}

// ---------------------------------------------------------------------------
// Policy-risk flagging (WS-J.2.6d) — flag for humans, NEVER auto-remove.
// ---------------------------------------------------------------------------

export type PolicyRiskSeverity = 'low' | 'medium' | 'high' | 'critical';

export interface PolicyRiskVerdict {
  flagged: boolean;
  severity: PolicyRiskSeverity;
  categories: string[];
}

export interface PolicyRiskClassifier {
  classify(text: string): PolicyRiskVerdict;
}

/** Bounded, deterministic keyword heuristics.  WS-K replaces this with governed
 *  models; the contract (flag + severity, never remove) is invariant. */
const POLICY_RISK_RULES: ReadonlyArray<{
  category: string;
  severity: PolicyRiskSeverity;
  patterns: readonly RegExp[];
}> = [
  {
    category: 'threat',
    severity: 'critical',
    patterns: [/\bi('?| wi)ll (kill|hurt|find) you\b/i, /\bgoing to (kill|shoot|stab)\b/i],
  },
  {
    category: 'self_harm',
    severity: 'critical',
    patterns: [/\b(kill myself|end my life|how to (die|suicide))\b/i],
  },
  {
    category: 'harassment',
    severity: 'high',
    patterns: [
      /\byou('?re| are) (worthless|pathetic|disgusting)\b/i,
      /\bnobody (likes|wants) you\b/i,
    ],
  },
  {
    category: 'graphic',
    severity: 'medium',
    patterns: [/\b(gore|dismember|mutilat)\w*\b/i],
  },
];

export class HeuristicPolicyRiskClassifier implements PolicyRiskClassifier {
  classify(text: string): PolicyRiskVerdict {
    const categories: string[] = [];
    let severity: PolicyRiskSeverity = 'low';
    const order: PolicyRiskSeverity[] = ['low', 'medium', 'high', 'critical'];
    for (const rule of POLICY_RISK_RULES) {
      if (rule.patterns.some((p) => p.test(text))) {
        categories.push(rule.category);
        if (order.indexOf(rule.severity) > order.indexOf(severity)) severity = rule.severity;
      }
    }
    return { flagged: categories.length > 0, severity, categories };
  }
}

// ---------------------------------------------------------------------------
// Coordinated-report detection (WS-J.2.6e) — base-rate-conditioned (MFCI-1).
// ---------------------------------------------------------------------------

/**
 * Temporal concentration of report timestamps in a window: 1 when all reports
 * are simultaneous, → 0 as they spread across the full window.  `1 − span/W`.
 */
export function temporalConcentration(timestampsMs: readonly number[], windowMs: number): number {
  if (timestampsMs.length < 2 || windowMs <= 0) return 0;
  const span = Math.max(...timestampsMs) - Math.min(...timestampsMs);
  return clamp01(1 - span / windowMs);
}

export interface CoordinationInputs {
  distinctReporters: number;
  /** Account ages (days) of the distinct reporters; missing → treated as new. */
  reporterAccountAgesDays: ReadonlyArray<number | null>;
  /** Report timestamps (ms) inside the window. */
  timestampsMs: readonly number[];
}

export interface CoordinationVerdict {
  score: number;
  /** True ⇒ the volume/distinct thresholds were met (a candidate cluster). */
  volumeMet: boolean;
  newAccountFraction: number;
  temporalConcentration: number;
}

/**
 * The cheap-statistics coordination score (the sub-minute path; MFCI confirms
 * later).  Base-rate conditioned (MFCI-1): the dominant factor is the
 * NEW-ACCOUNT cohort fraction, so a large AUTHENTIC community (diverse, mostly
 * older accounts) scores near 0 regardless of volume, while a freshly-minted
 * sock-puppet brigade scores high.  Score = newFraction · (0.6 + 0.4·temporal),
 * gated on the volume + distinct-reporter thresholds.
 */
export function coordinationScore(
  inputs: CoordinationInputs,
  config: ModerationRuntimeConfig,
): CoordinationVerdict {
  const distinct = inputs.distinctReporters;
  const total = inputs.timestampsMs.length;
  const volumeMet =
    total >= config.coordinationMinReports && distinct >= config.coordinationMinDistinctReporters;
  const newCount = inputs.reporterAccountAgesDays.filter(
    (age) => age === null || age < config.coordinationNewAccountDays,
  ).length;
  const newAccountFraction =
    inputs.reporterAccountAgesDays.length === 0
      ? 0
      : newCount / inputs.reporterAccountAgesDays.length;
  const concentration = temporalConcentration(
    inputs.timestampsMs,
    config.coordinationWindowSeconds * 1000,
  );
  const score = volumeMet ? clamp01(newAccountFraction * (0.6 + 0.4 * concentration)) : 0;
  return { score, volumeMet, newAccountFraction, temporalConcentration: concentration };
}

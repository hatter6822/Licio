// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Contribution safety pre-checks (WS-G.3.1 — the WS-J.2.6 seam).  The
// classifier interface is what WS-J's governed classifiers replace; the
// default heuristic is deliberately NARROW (flag-for-review posture, never
// auto-removal, and false positives only delay publication):
//
//   • any citation/source/body URL whose domain hits the local malware
//     denylist (the WS-F.1.4c provider — URLs never leave the platform,
//     §19.1) flags the contribution, and
//   • an `unavailable` safety provider fails TOWARD CAUTION (flag), never
//     open.
//
// Flagged contributions persist with `moderation_state = under_review`
// (default-hidden, §18.4) and land in the shared review queue
// (`contribution_safety_hold`) for steward review.
import type { ContributionCreate } from '@licio/shared';
import type { UrlSafetyProvider } from '../ingestion/prechecks.js';

/**
 * The disposition a safety classifier returns (WS-J.2.6):
 *   • `clear` → publish normally
 *   • `flag`  → persist `under_review` (default-hidden) + enqueue for review
 *   • `block` → persist `removed` (high-confidence spam/malware auto-block, an
 *               appealable system action — the only auto-removal paths besides
 *               malware are spam, WS-J.2.6a/b)
 */
export type ContributionSafetyDisposition = 'clear' | 'flag' | 'block';

export interface ContributionSafetyVerdict {
  disposition: ContributionSafetyDisposition;
  /** Machine-readable reasons (counted in metrics; no body text). */
  reasons: string[];
  /** The taxonomy reason code for an auto-block action (spam/malware). */
  reasonCode?: string;
}

/** Per-request author context the WS-J classifiers need (account age, etc.). */
export interface ContributionSafetyContext {
  userId: string;
  /**
   * The thread's home ROOM (WS-Q: every thread belongs to a room).  The
   * duplicate-flood detector counts DISTINCT ROOMS, so this must be the real
   * room id — NOT the thread id.  Two threads in one room are ONE room, so
   * keying flooding off the thread id would read same-room reposts as
   * cross-room flooding (a false positive).
   */
  roomId: string;
}

export interface ContributionSafetyClassifier {
  classify(
    request: ContributionCreate,
    context: ContributionSafetyContext,
  ): Promise<ContributionSafetyVerdict>;
}

const BARE_URL = /https?:\/\/[^\s<>"'`)]{1,2048}/gi;

/** Every URL a contribution carries (citations + body autolinks). */
export function contributionUrls(request: ContributionCreate): string[] {
  const urls: string[] = [];
  if ('citations' in request && request.citations) {
    for (const citation of request.citations) {
      if (citation.url.startsWith('http')) urls.push(citation.url);
      if (citation.archive_url) urls.push(citation.archive_url);
    }
  }
  for (const match of request.body.matchAll(BARE_URL)) urls.push(match[0]);
  return urls;
}

export class HeuristicContributionSafety implements ContributionSafetyClassifier {
  readonly #urlSafety: UrlSafetyProvider;

  constructor(urlSafety: UrlSafetyProvider) {
    this.#urlSafety = urlSafety;
  }

  async classify(request: ContributionCreate): Promise<ContributionSafetyVerdict> {
    const reasons: string[] = [];
    const domains = new Set<string>();
    for (const url of contributionUrls(request)) {
      try {
        domains.add(new URL(url).hostname.toLowerCase());
      } catch {
        // Unparseable URL in body text — inert (renderUGC drops it anyway).
      }
    }
    for (const domain of domains) {
      const verdict = await this.#urlSafety.check(domain);
      if (verdict === 'malicious') {
        reasons.push('malware_domain');
        break;
      }
      if (verdict === 'unavailable') {
        // Fail toward caution (the WS-F.1.4c posture): hold for review.
        reasons.push('url_safety_unavailable');
        break;
      }
    }
    return { disposition: reasons.length > 0 ? 'flag' : 'clear', reasons };
  }
}

// ---------------------------------------------------------------------------
// Upload scanning (WS-G.3.7b — the WS-J.2.6b seam).
// ---------------------------------------------------------------------------

export interface UploadScanVerdict {
  /** `clear` serves immediately; `pending` holds attachment AND serving
   *  until a later `setScanState`; `flagged` is never served. */
  state: 'clear' | 'pending' | 'flagged';
  /** Machine-readable reason (metrics only; never file content). */
  reason: string | null;
}

/**
 * The scanner the upload route consults AFTER the inline local checks
 * (magic-byte/declared-type match, size bounds, metadata strip) have
 * passed.  WS-J.2.6b replaces this with the shared malware intelligence;
 * until then the default scanner clears — the local checks ARE the scan,
 * and `scan_state` stays a real gate (attachment and serving both require
 * `clear`), not a decoration.
 */
export interface UploadScanner {
  scan(bytes: Uint8Array, contentType: string): Promise<UploadScanVerdict>;
}

/** Default scanner: the inline local checks already ran; clear. */
export class LocalChecksUploadScanner implements UploadScanner {
  async scan(): Promise<UploadScanVerdict> {
    return { state: 'clear', reason: null };
  }
}

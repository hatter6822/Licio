// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-J.2.6 pre-check wiring into the WS-G contribution submission path.  The
// `WsJContributionSafety` classifier runs the WS-J detectors on every new
// contribution and returns a disposition the forum honours:
//   • malware domain / high-confidence spam → `block` (auto-removal, the only
//     two permitted auto-block paths — WS-J.2.6a/b), recorded as an APPEALABLE
//     system action via the auto-block sink;
//   • duplicate-flood / policy-risk / unavailable-reputation → `flag`
//     (under_review + the review queue; human-review-not-auto-removal holds).
// The classifier + sink hold the moderation services and are assigned to the
// forum seams at boot — forum never imports moderation (it uses the structural
// `ContributionSafetyClassifier` / `AutoModerationSink` ports).
import { type ModerationReasonCode, reasonCodeAppealable } from '@licio/shared';
import {
  type ContributionSafetyClassifier,
  type ContributionSafetyVerdict,
  contributionUrls,
} from '../forum/safety.js';
import type { AutoModerationSink } from '../forum/services.js';
import { writeAudit } from './audit.js';
import { createActionNotice } from './notices.js';
import {
  classifyDuplicateFlood,
  classifyMalware,
  classifySpam,
  contentSignature,
  urlHostname,
} from './prechecks.js';
import type { ModerationServices } from './services.js';

/** Structural WS-F URL-safety fallback (the ingestion denylist).  Under WS-J a
 *  `malicious` verdict is AUTO-BLOCKED (WS-J.2.6b elevates the shipped flag). */
export interface UrlSafetyFallback {
  check(domain: string): Promise<'safe' | 'malicious' | 'unavailable'>;
}

/** The WS-J contribution safety classifier (replaces the forum default). */
export function createWsJContributionSafety(
  services: ModerationServices,
  urlSafetyFallback?: UrlSafetyFallback,
): ContributionSafetyClassifier {
  return {
    async classify(request, context): Promise<ContributionSafetyVerdict> {
      const config = services.config();
      const reasons: string[] = [];
      const urls = contributionUrls(request);

      // 1. Malware (an auto-block path) — moderation reputation + the WS-F
      //    denylist; an unavailable verdict FLAGS (fail toward flagging).
      const malware = await classifyMalware(urls, services.urlReputation);
      if (malware.disposition === 'block') {
        services.metrics.increment('prechecks.malware_block');
        return {
          disposition: 'block',
          reasons: ['malware_domain'],
          reasonCode: 'MOD_CRYPTO_DRAIN_001',
        };
      }
      let malwareFlag = malware.disposition === 'flag';
      if (urlSafetyFallback) {
        const seen = new Set<string>();
        for (const url of urls) {
          const host = urlHostname(url);
          if (host === null || seen.has(host)) continue;
          seen.add(host);
          const verdict = await urlSafetyFallback.check(host);
          if (verdict === 'malicious') {
            services.metrics.increment('prechecks.malware_block');
            return {
              disposition: 'block',
              reasons: ['malware_domain'],
              reasonCode: 'MOD_CRYPTO_DRAIN_001',
            };
          }
          if (verdict === 'unavailable') malwareFlag = true;
        }
      }
      if (malwareFlag) reasons.push('url_safety_unavailable');

      // 2. Spam (an auto-block path at high confidence) — noisy-OR over pattern/
      //    velocity/known-hash/new-account signals.
      const user = await services.users.resolve(context.userId);
      const signature = contentSignature(request.body);
      const nowMs = services.now();
      const windowMs = config.spamVelocityWindowSeconds * 1000;
      const floodStats = services.submissions.floodStats(
        context.userId,
        signature,
        nowMs,
        windowMs,
      );
      const spam = classifySpam(
        {
          text: request.body,
          urls,
          accountAgeDays: user?.accountAgeDays ?? null,
          recentSimilarCount: floodStats.similarCount,
        },
        config,
      );
      // Record this submission for future velocity/flood (room = thread).
      services.submissions.record({
        userId: context.userId,
        signature,
        roomId: request.thread_id,
        atMs: nowMs,
      });
      if (spam.disposition === 'block') {
        services.metrics.increment('prechecks.spam_block');
        return {
          disposition: 'block',
          reasons: [...reasons, ...spam.signals],
          reasonCode: 'MOD_SPAM_001',
        };
      }
      if (spam.disposition === 'flag') reasons.push(...spam.signals);

      // 3. Duplicate flood (FLAG, never remove — legitimate cross-posting exists).
      const flood = classifyDuplicateFlood(
        services.submissions.floodStats(
          context.userId,
          signature,
          nowMs,
          config.duplicateFloodWindowSeconds * 1000,
        ),
        config,
      );
      if (flood.flagged) reasons.push('duplicate_flood');

      // 4. Policy-risk (FLAG, never remove — the human-review invariant).
      const risk = services.policyRisk.classify(request.body);
      if (risk.flagged) {
        services.metrics.increment('prechecks.policy_risk_flag');
        for (const category of risk.categories) reasons.push(`policy_risk:${category}`);
      }

      return { disposition: reasons.length > 0 ? 'flag' : 'clear', reasons };
    },
  };
}

/** The auto-block accountability sink: records the system action + audit + the
 *  appealable statement-of-reasons notice (WS-J.2.6a/b false-positive recourse). */
export function createAutoModerationSink(services: ModerationServices): AutoModerationSink {
  return {
    async recordContentAutoBlock(input): Promise<void> {
      const action = await services.actions.insert({
        actorUserId: null, // system
        actorRole: null,
        action: 'remove',
        targetType: 'content',
        targetId: input.contributionId,
        subjectUserId: input.authorUserId,
        reasonCode: input.reasonCode,
        duration: null,
        reviewerNote: `automated block: ${input.reasons.join(', ')}`,
        priorState: 'visible',
        nextState: 'removed',
        reversible: true,
        reverted: false,
        linkedActionId: null,
        caseId: null,
        coApproverUserId: null,
        reportIds: [],
      });
      await writeAudit(services, {
        actorUserId: null,
        actorRole: null,
        action: 'auto_block',
        reasonCode: input.reasonCode,
        targetType: 'content',
        targetId: input.contributionId,
        subjectUserId: input.authorUserId,
        priorState: 'visible',
        nextState: 'removed',
        reversible: true,
        notes: input.reasons.join(', '),
      });
      const appealable = reasonCodeAppealable(input.reasonCode as ModerationReasonCode);
      await createActionNotice(services, {
        userId: input.authorUserId,
        actionId: action.actionId,
        action: 'remove',
        reasonCode: input.reasonCode,
        appealable,
      });
      services.metrics.increment('moderation.auto_block');
    },
  };
}

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
      // Both flood windows are sampled BEFORE recording this submission:
      // classifySpam / classifyDuplicateFlood each add one for the current item,
      // so the stats they receive must EXCLUDE it (otherwise it is counted twice
      // and a legitimate cross-post can trip the threshold a submission early).
      const floodStats = services.submissions.floodStats(
        context.userId,
        signature,
        nowMs,
        windowMs,
      );
      const dupWindowStats = services.submissions.floodStats(
        context.userId,
        signature,
        nowMs,
        config.duplicateFloodWindowSeconds * 1000,
        // The current submission's REAL home room (WS-Q: every thread belongs to
        // a room) — folded into the distinct-room count so two threads in ONE
        // room are not miscounted as two rooms (false cross-room flooding).
        context.roomId,
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
      // Record this submission for future velocity/flood, keyed by the real
      // home room (NOT the thread) so cross-room counting is accurate.
      services.submissions.record({
        userId: context.userId,
        signature,
        roomId: context.roomId,
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
      //    Uses the pre-record window stats (the current submission is added by
      //    classifyDuplicateFlood itself — never double-counted).
      const flood = classifyDuplicateFlood(dupWindowStats, config);
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
      // ONE UNIT: the system action row, its audit entry, and the appealable
      // statement-of-reasons notice.  This is a fully AUTOMATED removal with no human
      // actor, so the record is the only account of it that exists — and the notice is
      // the member's only route to appeal, which must not survive a rollback of the
      // removal it describes.
      const appealable = reasonCodeAppealable(input.reasonCode as ModerationReasonCode);
      await services.transactor.run(async (tx) => {
        const action = await tx.actions.insert({
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
        await tx.audit({
          actorUserId: null,
          actorRole: null,
          // No case: an automated pre-publication block precedes any report, so there
          // is nothing to file it under.  NULL here means exactly that.
          caseId: null,
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
        await createActionNotice(
          services,
          {
            userId: input.authorUserId,
            actionId: action.actionId,
            action: 'remove',
            reasonCode: input.reasonCode,
            appealable,
          },
          tx.notices,
        );
      });
      services.metrics.increment('moderation.auto_block');
    },
    async recordAgentHold(input): Promise<void> {
      // A COMMUNITY-layer action (the room's voted agent), distinct from a
      // platform-floor enforcement: it carries NO platform taxonomy reason code,
      // and its recourse is the human review already queued + the support contact
      // — so the notice references the contribution (not a WS-J action) and is not
      // an in-app WS-J appeal. The provenance triple lives in the knomosis log.
      const verb = input.removed ? 'removed' : 'held for review';
      const detail = input.reason ? ` (${input.reason})` : '';
      const note =
        `This room's community-approved agent ${verb} your contribution${detail}. ` +
        'A human reviewer will check it and you will be notified of the outcome.';
      await createActionNotice(services, {
        userId: input.authorUserId,
        actionId: input.contributionId,
        action: input.removed ? 'remove' : 'hide',
        reasonCode: null,
        appealable: false,
        appealAvailableNote: note,
      });
      services.metrics.increment('moderation.agent_hold_notice');
    },
  };
}

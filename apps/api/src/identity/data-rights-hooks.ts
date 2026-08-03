// SPDX-License-Identifier: AGPL-3.0-or-later
//
// ONE installer for the §19.3 data-rights hooks (GDPR Art. 15 / Art. 17), called
// by every composition root.
//
// `IdentityServices` declares each export/purge hook OPTIONAL, and an absent one
// is silently a no-op: the archive omits a store, or the erasure leaves it
// behind. That is the correct default for a unit test building three services,
// and a trap for a composition root — the failure has no error, no log line and
// no failing test, because the store answers reads perfectly well and only the
// two obligations that must find it never do.
//
// The hooks were therefore assigned inline in the production boot, and each new
// one had to be REMEMBERED in the E2E harness too. It was not: the harness ran
// with the attention, content, client-state, moderation-notice and (until the
// review that prompted this module) private-room-directory hooks all absent, so
// the runtime that exercises the authenticated flows could not have failed on a
// disclosure or deletion gap in any of them.
//
// So the hooks live here, as one function over the services they read. A root
// that calls it gets all of them; a hook added here reaches both roots at once;
// and `check:prod-parity` fails a root that does not call it. Deletion and
// disclosure stay one obligation seen from two sides — what the purge can find,
// the export must declare.

import type { Logger } from 'pino';
import {
  applyRetentionPreferenceChange,
  exportUserAttention,
  purgeUserAttention,
} from '../events/retention.js';
import type { EventPipelineServices } from '../events/services.js';
import { anonymizeUserContent, exportUserContent } from '../forum/data-rights.js';
import type { ForumServices } from '../forum/services.js';
import type { IngestionServices } from '../ingestion/services.js';
import { getPreferences, purgePushStateForUser } from '../lib/push-service.js';
import {
  REPLY_NOTIFICATIONS_PER_USER_CAP,
  replyNotifications,
} from '../lib/reply-notifications.js';
import { getUserSettingsStore } from '../lib/user-settings.js';
import { noticeToView } from '../moderation/notices.js';
import type { ModerationServices } from '../moderation/services.js';
import { getPrivateRoomStubService } from '../private-rooms/service.js';
import type { IdentityServices } from './services.js';

/** One page of the moderation-notice export; the loop below is what makes the
 *  export COMPLETE rather than a first page. */
const NOTICE_PAGE = 200;

export interface DataRightsDeps {
  events: EventPipelineServices;
  ingestion: IngestionServices;
  forum: ForumServices;
  moderation: ModerationServices;
  log: Pick<Logger, 'error'>;
}

/**
 * Install every data-rights hook on `identity`.
 *
 * The service objects are captured by REFERENCE and read at call time, so a root
 * that later swaps a store onto one of them (the production boot replaces the
 * moderation stores with their Drizzle adapters after this call) is still
 * exporting from the store it ends up with, not the one it started with.
 */
export function installDataRightsHooks(identity: IdentityServices, deps: DataRightsDeps): void {
  const { events, ingestion, forum, moderation, log } = deps;

  // Attention (WS-E owns the store). The purge MODE distinguishes the attention
  // reset — tiers only — from the account hard purge, which deletes the
  // attention and de-links the remaining owned rows.
  identity.purgeAttention = (userId, mode) => purgeUserAttention(events, userId, mode);
  identity.exportAttention = (userId) => exportUserAttention(events, userId);

  // Content (WS-F stories + WS-G forum/rooms/uploads, WS-Q.3.5 tier tagging).
  // Export covers BOTH visibility tiers; anonymize tombstones the author across
  // tiers and removes private-room memberships + steward rows.
  identity.exportContributions = (userId) => exportUserContent(ingestion, forum, userId);
  identity.anonymizeContributions = (userId) => anonymizeUserContent(forum, userId);

  // A retention-preference change TIGHTENS existing purge deadlines (never
  // extends them), so disabling collection stops it rather than flipping a UI
  // toggle. Fire-and-forget by contract — the settings write must not fail on a
  // downstream propagation error — which is exactly why the failure is logged.
  identity.onPrivacyChange = (change) => {
    void applyRetentionPreferenceChange(events, change.userId, change.retention).catch((err) =>
      log.error({ err }, 'retention preference propagation failed'),
    );
  };

  // Client state (WS-C/WS-T): push subscriptions, notification preferences,
  // settings-sync rows and the reply-notification inbox. Production deletion
  // TOMBSTONES the users row, so no FK action removes any of this implicitly.
  identity.purgeClientState = async (userId) => {
    await purgePushStateForUser(userId);
    await getUserSettingsStore().purge(userId);
    await replyNotifications.purgeForUser(userId);
  };
  identity.exportClientState = async (userId) => ({
    settings: await getUserSettingsStore().get(userId),
    notification_preferences: await getPreferences(userId),
    reply_notifications: await replyNotifications.listForUser(
      userId,
      REPLY_NOTIFICATIONS_PER_USER_CAP,
    ),
  });

  // WS-S §21.4 — the private-room DIRECTORY record dies with its creator's
  // account, and is disclosed to them while it lives. The ROOM is untouched: it
  // lives on member devices, and the server never held it.
  identity.purgePrivateRoomStubs = async (userId) => {
    await getPrivateRoomStubService().purgeForAccount(userId);
  };
  identity.exportPrivateRoomStubs = async (userId) =>
    await getPrivateRoomStubService().exportForAccount(userId);

  // WS-J ↔ WS-D: statement-of-reasons and appeal outcomes are durable user data.
  // Reporter identity never appears (`noticeToView` carries the reason code
  // only), and the paging is what makes the export complete.
  identity.exportModerationNotices = async (userId) => {
    const out: unknown[] = [];
    let after: string | null = null;
    for (;;) {
      const page = await moderation.notices.listByUser(userId, after, NOTICE_PAGE);
      for (const notice of page) out.push(noticeToView(notice));
      if (page.length < NOTICE_PAGE) break;
      after = page[page.length - 1]?.createdAt ?? null;
      if (after === null) break;
    }
    return out;
  };
}

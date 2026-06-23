// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-S.5.7 — per-member LOCAL moderation overlays (PRIVATE_SPEC §14.6, §19.2): a
// device-local view filter (`hidden_members`/`hidden_contributions`/
// `muted_threads`/`blocked_media`) that is NOT synced unless the user explicitly
// exports/imports it.  This is distinct from room-local moderation OPS (the
// signed, capability-gated `contribution.tombstone`/`thread.state`/`member.remove`
// the reducer already applies), and from PLATFORM moderation (which can never
// touch a P2P room, §19.3).  A member can always hide/mute/block locally and
// leave — the overlay is the always-available member-local control.

import { z } from 'zod';
import { decodeCanonical } from '../crypto/canonical.js';
import { canonicalizeRecord } from '../crypto/record-encoding.js';
import { fromBase64Url, toBase64Url } from '../crypto/runtime.js';
import type { RoomReducerState } from './state.js';

/** A member's device-local overlay (never synced unless explicitly exported). */
export interface LocalOverlay {
  readonly hiddenMembers: ReadonlySet<string>;
  readonly hiddenContributions: ReadonlySet<string>;
  readonly mutedThreads: ReadonlySet<string>;
  readonly blockedMedia: ReadonlySet<string>;
}

/** An empty overlay (nothing hidden/muted/blocked). */
export function emptyOverlay(): LocalOverlay {
  return {
    hiddenMembers: new Set(),
    hiddenContributions: new Set(),
    mutedThreads: new Set(),
    blockedMedia: new Set(),
  };
}

/** The visible projection of room state through a member's local overlay. */
export interface VisibleRoomView {
  /** Story ids visible after the overlay (tombstoned + hidden-author removed). */
  readonly visibleStoryIds: string[];
  /** Contribution ids visible after the overlay (tombstoned/hidden/muted removed). */
  readonly visibleContributionIds: string[];
  /** Attachment ids visible after the overlay (blocked-media removed). */
  readonly visibleAttachmentIds: string[];
}

/**
 * Project `state` through a member's local `overlay` into the visible view:
 * tombstoned content is hidden (the reducer's §14.4 decision), AND additionally
 * the member's locally-hidden authors/contributions, muted threads, and blocked
 * media are removed.  Pure + deterministic (sorted output).
 */
export function projectVisibleView(
  state: RoomReducerState,
  overlay: LocalOverlay,
): VisibleRoomView {
  const visibleStoryIds: string[] = [];
  for (const [storyId, story] of state.stories) {
    if (story.tombstoned) continue;
    if (overlay.hiddenMembers.has(story.authorMemberId)) continue;
    visibleStoryIds.push(storyId);
  }

  const visibleContributionIds: string[] = [];
  for (const [contributionId, c] of state.contributions) {
    if (c.tombstoned) continue;
    if (overlay.hiddenContributions.has(contributionId)) continue;
    if (overlay.hiddenMembers.has(c.authorMemberId)) continue;
    if (overlay.mutedThreads.has(c.threadId)) continue;
    visibleContributionIds.push(contributionId);
  }

  const visibleAttachmentIds: string[] = [];
  for (const attachmentId of state.attachments.keys()) {
    if (overlay.blockedMedia.has(attachmentId)) continue;
    visibleAttachmentIds.push(attachmentId);
  }

  const sort = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  return {
    visibleStoryIds: visibleStoryIds.sort(sort),
    visibleContributionIds: visibleContributionIds.sort(sort),
    visibleAttachmentIds: visibleAttachmentIds.sort(sort),
  };
}

const overlayPortableSchema = z
  .object({
    schema: z.literal('licio.private.local_overlay.v1'),
    hidden_members: z.array(z.string().min(1).max(128)).max(100_000),
    hidden_contributions: z.array(z.string().min(1).max(128)).max(100_000),
    muted_threads: z.array(z.string().min(1).max(128)).max(100_000),
    blocked_media: z.array(z.string().min(1).max(256)).max(100_000),
  })
  .strict();

const sorted = (set: ReadonlySet<string>) => [...set].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

/**
 * Export an overlay to a portable base64url blob — the ONLY way an overlay
 * leaves the device (an explicit user action, §14.6).  Deterministic (sorted).
 */
export function exportOverlay(overlay: LocalOverlay): string {
  return toBase64Url(
    canonicalizeRecord({
      schema: 'licio.private.local_overlay.v1',
      hidden_members: sorted(overlay.hiddenMembers),
      hidden_contributions: sorted(overlay.hiddenContributions),
      muted_threads: sorted(overlay.mutedThreads),
      blocked_media: sorted(overlay.blockedMedia),
    }),
  );
}

/** Import an overlay the user explicitly exported earlier (validated). */
export function importOverlay(text: string): LocalOverlay {
  const parsed = overlayPortableSchema.parse(decodeCanonical(fromBase64Url(text)));
  return {
    hiddenMembers: new Set(parsed.hidden_members),
    hiddenContributions: new Set(parsed.hidden_contributions),
    mutedThreads: new Set(parsed.muted_threads),
    blockedMedia: new Set(parsed.blocked_media),
  };
}

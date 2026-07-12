// SPDX-License-Identifier: AGPL-3.0-or-later
import type { ContributionDisputeStatus } from '@licio/shared';
//
// Presentation types for the story surface (WS-B.2.1a). These are no-applause-
// safe BY CONSTRUCTION: there is deliberately no `likeCount`, `voteCount`,
// `score`, `reactions`, `followerCount`, or `shareCount` field anywhere. The
// type system is the first line of the no-applause guarantee (Sections 2.4, 5.1);
// the absence is also asserted at runtime in StoryCard.no-applause.test.tsx.
import type { IconName } from '../ui/Icon/index.js';
import type { RatingLabelKind } from './RatingLabel/index.js';

export interface Story {
  id: string;
  title: string;
  /** Human-readable source/publication name. */
  source: string;
  /** Canonical URL (opened in the in-app reader); optional for offline drafts. */
  url?: string;
  /** Estimated active reading time in minutes (a cognitive-accessibility aid). */
  readingMinutes: number;
}

/**
 * A context chip — e.g. "3 lenses", "2 primary sources", "low coordination
 * risk". A descriptive, human-readable signal of conversation context. It is
 * NOT a popularity count.
 */
export interface ContextChip {
  id: string;
  label: string;
  icon?: IconName;
}

export interface BranchPreviewItem {
  id: string;
  title: string;
}

/** WS-Q.5.2c native media (image/video post); descriptive, never a popularity
 *  signal. URLs are server-minted read paths (signed for room_only media). */
export interface StoryMediaData {
  url: string;
  kind: 'image' | 'video';
  altText: string | null;
  captionsText?: string | null;
  captionsUrl?: string | null;
  posterUrl?: string | null;
}

export interface StoryCardData {
  story: Story;
  ratingLabel: RatingLabelKind;
  /** WS-T dispute posture (SPEC §15.4): drives the "Challenged"/"Incorrect"
   *  badge. Absent ⇒ undisputed. A content-integrity signal, never applause. */
  disputeStatus?: ContributionDisputeStatus;
  /** Human-readable distribution reason; never a raw numeric score. */
  distributionReason: string;
  contextChips?: ContextChip[];
  branchPreview?: BranchPreviewItem[];
  /** WS-Q.5.3b — in-room chip on non-public items (room feeds). */
  inRoom?: boolean;
  /** WS-Q.5.2c — native image/video post media. */
  media?: StoryMediaData;
}

// SPDX-License-Identifier: AGPL-3.0-or-later
import type { MeriExposureLabelWire } from '@licio/shared';
//
// Presentation types for the story surface (WS-B.2.1a). These are no-applause-
// safe BY CONSTRUCTION: there is deliberately no `likeCount`, `voteCount`,
// `score`, `reactions`, `followerCount`, or `shareCount` field anywhere. The
// type system is the first line of the no-applause guarantee (Sections 2.4, 5.1);
// the absence is also asserted at runtime in StoryCard.no-applause.test.tsx.
import type { IconName } from '../ui/Icon/index.js';
import type { RatingLabelKind } from './RatingLabel/index.js';

/** Provenance of a story's source — feeds the origin badge, never a ranking. */
export type StoryOrigin = 'independent' | 'wire' | 'official' | 'aggregator';

export interface Story {
  id: string;
  title: string;
  /** Human-readable source/publication name. */
  source: string;
  origin: StoryOrigin;
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

export interface StoryCardData {
  /** MERI exposure label (WS-H.2.3a) — absent until analysis covers the story. */
  exposureLabel?: MeriExposureLabelWire;
  story: Story;
  ratingLabel: RatingLabelKind;
  /** Human-readable distribution reason; never a raw numeric score. */
  distributionReason: string;
  contextChips?: ContextChip[];
  branchPreview?: BranchPreviewItem[];
}

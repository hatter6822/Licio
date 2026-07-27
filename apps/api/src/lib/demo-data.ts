// SPDX-License-Identifier: AGPL-3.0-or-later
//
// In-memory demo dataset for the FEED read model (WS-I owns the durable
// ranking layer). Threads, contributions, rooms, and lenses are REAL WS-G
// models now — their demo content is seeded through the real stores by
// lib/demo-seed.ts (development only). This fixture is deterministic (fixed
// ids matching the seeded stories) and carries no popularity/applause fields
// — only descriptive, conversation-state signals (no-applause doctrine).
import {
  type FeedItem,
  LEGACY_DISTRIBUTION_REASON,
  type StoryDetail,
  topicIdForSlug,
} from '@licio/shared';

export const DEMO_IDS = {
  STORY_1: '5f5e1000-0000-4000-8000-000000000001',
  STORY_2: '5f5e1000-0000-4000-8000-000000000002',
  STORY_3: '5f5e1000-0000-4000-8000-000000000003',
  THREAD_1: '5f5e2000-0000-4000-8000-000000000001',
  THREAD_2: '5f5e2000-0000-4000-8000-000000000002',
  THREAD_3: '5f5e2000-0000-4000-8000-000000000003',
  ROOM_1: '5f5e3000-0000-4000-8000-000000000001',
  ROOM_2: '5f5e3000-0000-4000-8000-000000000002',
  // WS-Q.1.6 — a PRIVATE demo room hosting forced `room_only` content.
  ROOM_3: '5f5e3000-0000-4000-8000-000000000003',
} as const;
const { STORY_1, STORY_2, STORY_3, THREAD_1, THREAD_2 } = DEMO_IDS;

const feedWater: FeedItem = {
  dispute_status: 'none',
  story_id: STORY_1,
  title: 'Regional water board publishes the full testing dataset',
  source: 'Public Records Office',
  url: 'https://example.org/water-testing-dataset',
  reading_minutes: 6,
  // §5.6 card signals: three sourced comments; one comment was challenged and
  // upheld (validated) — the cross-checked lab report.
  sources_count: 3,
  corrections: { active: 0, validated: 1, incorrect: 0 },
  // DEPRECATED rollout compat (see LEGACY_RATING_LABELS in @licio/shared).
  rating_label: 'deepening',
  distribution_reason: LEGACY_DISTRIBUTION_REASON,
  context_chips: [],
  safety_state: 'ok',
  more_on_this_story: [],
  topic_ids: [topicIdForSlug('climate-environment')],
};

const feedZoning: FeedItem = {
  dispute_status: 'none',
  story_id: STORY_2,
  title: 'Two neighbourhoods read the same zoning proposal very differently',
  source: 'City Desk',
  url: 'https://example.org/zoning-proposal',
  reading_minutes: 9,
  sources_count: 1,
  corrections: { active: 0, validated: 0, incorrect: 0 },
  rating_label: 'bridge-active',
  distribution_reason: LEGACY_DISTRIBUTION_REASON,
  context_chips: [{ id: 'c3', label: 'cross-community', icon: 'bridge' }],
  safety_state: 'ok',
  more_on_this_story: [],
  topic_ids: [topicIdForSlug('local-community')],
};

const feedTransit: FeedItem = {
  dispute_status: 'none',
  story_id: STORY_3,
  title: 'Claim about the new transit timetable is missing a key caveat',
  source: 'Transit Watch',
  reading_minutes: 4,
  // A live correction debate is running over one comment (hourglass tally).
  sources_count: 0,
  corrections: { active: 1, validated: 0, incorrect: 0 },
  rating_label: 'needs-context',
  distribution_reason: LEGACY_DISTRIBUTION_REASON,
  context_chips: [{ id: 'c4', label: 'awaiting evidence', icon: 'circle-question' }],
  safety_state: 'caution',
  more_on_this_story: [],
  topic_ids: [topicIdForSlug('local-community')],
};

export const DEMO_FEED: FeedItem[] = [feedWater, feedZoning, feedTransit];

const STORY_DETAILS: Record<string, StoryDetail> = {
  [STORY_1]: {
    ...feedWater,
    body_summary:
      'The board released raw and processed results alongside the sampling methodology. Several readers opened the dataset and cross-checked it against an independent lab report.',
    thread_id: THREAD_1,
    topic_ids: [topicIdForSlug('climate-environment')],
  },
  [STORY_2]: {
    ...feedZoning,
    body_summary:
      'The proposal text is identical, but two rooms summarise its effects differently. A bridge contribution translated each interpretation for the other.',
    thread_id: THREAD_2,
    topic_ids: [topicIdForSlug('local-community')],
  },
  [STORY_3]: {
    ...feedTransit,
    body_summary:
      'The timetable claim omits a service-frequency caveat. A clarifying question is awaiting a cited source before the record settles.',
    thread_id: null,
    topic_ids: [topicIdForSlug('local-community')],
  },
};

export function demoStory(storyId: string): StoryDetail | undefined {
  return STORY_DETAILS[storyId];
}

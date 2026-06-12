// SPDX-License-Identifier: AGPL-3.0-or-later
//
// In-memory demo dataset for the FEED read model (WS-I owns the durable
// ranking layer). Threads, contributions, rooms, and lenses are REAL WS-G
// models now — their demo content is seeded through the real stores by
// lib/demo-seed.ts (development only). This fixture is deterministic (fixed
// ids matching the seeded stories) and carries no popularity/applause fields
// — only descriptive, conversation-state signals (no-applause doctrine).
import type { FeedItem, SignalLedgerEntry, StoryDetail } from '@licio/shared';

export const DEMO_IDS = {
  STORY_1: '5f5e1000-0000-4000-8000-000000000001',
  STORY_2: '5f5e1000-0000-4000-8000-000000000002',
  STORY_3: '5f5e1000-0000-4000-8000-000000000003',
  THREAD_1: '5f5e2000-0000-4000-8000-000000000001',
  THREAD_2: '5f5e2000-0000-4000-8000-000000000002',
  THREAD_3: '5f5e2000-0000-4000-8000-000000000003',
  ROOM_1: '5f5e3000-0000-4000-8000-000000000001',
  ROOM_2: '5f5e3000-0000-4000-8000-000000000002',
} as const;
const { STORY_1, STORY_2, STORY_3, THREAD_1, THREAD_2 } = DEMO_IDS;

const feedWater: FeedItem = {
  exposure_label: null,
  story_id: STORY_1,
  title: 'Regional water board publishes the full testing dataset',
  source: 'Public Records Office',
  origin: 'official',
  url: 'https://example.org/water-testing-dataset',
  reading_minutes: 6,
  rating_label: 'well-sourced',
  distribution_reason: 'Readers opened the primary dataset and added independent corroboration.',
  context_chips: [
    { id: 'c1', label: '3 primary sources', icon: 'document-check' },
    { id: 'c2', label: '2 lenses', icon: 'layers' },
  ],
  safety_state: 'ok',
  more_on_this_story: [],
  context_card: null,
};

const feedZoning: FeedItem = {
  exposure_label: null,
  story_id: STORY_2,
  title: 'Two neighbourhoods read the same zoning proposal very differently',
  source: 'City Desk',
  origin: 'independent',
  url: 'https://example.org/zoning-proposal',
  reading_minutes: 9,
  rating_label: 'bridge-active',
  distribution_reason: 'A bridge comment reduced cross-community confusion between two rooms.',
  context_chips: [{ id: 'c3', label: 'cross-community', icon: 'bridge' }],
  safety_state: 'ok',
  more_on_this_story: [],
  context_card: null,
};

const feedTransit: FeedItem = {
  exposure_label: null,
  story_id: STORY_3,
  title: 'Claim about the new transit timetable is missing a key caveat',
  source: 'Transit Watch',
  origin: 'aggregator',
  reading_minutes: 4,
  rating_label: 'needs-context',
  distribution_reason: 'A clarifying question identified an ambiguity awaiting evidence.',
  context_chips: [{ id: 'c4', label: 'awaiting evidence', icon: 'circle-question' }],
  safety_state: 'caution',
  more_on_this_story: [],
  context_card: null,
};

export const DEMO_FEED: FeedItem[] = [feedWater, feedZoning, feedTransit];

const STORY_DETAILS: Record<string, StoryDetail> = {
  [STORY_1]: {
    ...feedWater,
    body_summary:
      'The board released raw and processed results alongside the sampling methodology. Several readers opened the dataset and cross-checked it against an independent lab report.',
    thread_id: THREAD_1,
    topic_ids: ['water-quality'],
  },
  [STORY_2]: {
    ...feedZoning,
    body_summary:
      'The proposal text is identical, but two rooms summarise its effects differently. A bridge contribution translated each interpretation for the other.',
    thread_id: THREAD_2,
    topic_ids: ['zoning'],
  },
  [STORY_3]: {
    ...feedTransit,
    body_summary:
      'The timetable claim omits a service-frequency caveat. A clarifying question is awaiting a cited source before the label changes.',
    thread_id: null,
    topic_ids: ['transit'],
  },
};

export const DEMO_LEDGER: SignalLedgerEntry[] = [
  {
    item_id: STORY_1,
    story_title: feedWater.title,
    recorded_at: '2026-06-08T09:20:00.000Z',
    active_dwell_bucket: 'medium',
    source_opened: true,
    context_opened: true,
    branch_depth_bucket: 'moderate',
    return_visit_count_bucket: 'few',
    cap_reached: false,
  },
  {
    item_id: STORY_2,
    story_title: feedZoning.title,
    recorded_at: '2026-06-08T12:00:00.000Z',
    active_dwell_bucket: 'long',
    source_opened: false,
    context_opened: true,
    branch_depth_bucket: 'shallow',
    return_visit_count_bucket: 'none',
    cap_reached: true,
  },
];

export function demoStory(storyId: string): StoryDetail | undefined {
  return STORY_DETAILS[storyId];
}

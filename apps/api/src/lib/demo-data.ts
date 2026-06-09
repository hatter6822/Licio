// SPDX-License-Identifier: AGPL-3.0-or-later
//
// In-memory demo dataset for the BFF read models. This is a DEVELOPMENT FIXTURE
// so the PWA renders real content end-to-end (feed, story, thread, rooms, Signal
// Ledger) and offline read-through is demonstrable. The durable data layer is
// owned by later workstreams (WS-G/H/J); this fixture is deterministic (fixed
// ids) and carries no popularity/applause fields — only descriptive,
// conversation-state signals (no-applause doctrine).
import type {
  BranchContent,
  BranchId,
  FeedItem,
  RoomDetail,
  RoomSummary,
  SignalLedgerEntry,
  StoryDetail,
  ThreadDetail,
} from '@licio/shared';

const STORY_1 = '5f5e1000-0000-4000-8000-000000000001';
const STORY_2 = '5f5e1000-0000-4000-8000-000000000002';
const STORY_3 = '5f5e1000-0000-4000-8000-000000000003';
const THREAD_1 = '5f5e2000-0000-4000-8000-000000000001';
const THREAD_2 = '5f5e2000-0000-4000-8000-000000000002';
const ROOM_1 = '5f5e3000-0000-4000-8000-000000000001';
const ROOM_2 = '5f5e3000-0000-4000-8000-000000000002';
const ROOM_3 = '5f5e3000-0000-4000-8000-000000000003';

const feedWater: FeedItem = {
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
};

const feedZoning: FeedItem = {
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
};

const feedTransit: FeedItem = {
  story_id: STORY_3,
  title: 'Claim about the new transit timetable is missing a key caveat',
  source: 'Transit Watch',
  origin: 'aggregator',
  reading_minutes: 4,
  rating_label: 'needs-context',
  distribution_reason: 'A clarifying question identified an ambiguity awaiting evidence.',
  context_chips: [{ id: 'c4', label: 'awaiting evidence', icon: 'circle-question' }],
  safety_state: 'caution',
};

export const DEMO_FEED: FeedItem[] = [feedWater, feedZoning, feedTransit];

const STORY_DETAILS: Record<string, StoryDetail> = {
  [STORY_1]: {
    ...feedWater,
    body_summary:
      'The board released raw and processed results alongside the sampling methodology. Several readers opened the dataset and cross-checked it against an independent lab report.',
    thread_id: THREAD_1,
  },
  [STORY_2]: {
    ...feedZoning,
    body_summary:
      'The proposal text is identical, but two rooms summarise its effects differently. A bridge contribution translated each interpretation for the other.',
    thread_id: THREAD_2,
  },
  [STORY_3]: {
    ...feedTransit,
    body_summary:
      'The timetable claim omits a service-frequency caveat. A clarifying question is awaiting a cited source before the label changes.',
    thread_id: null,
  },
};

const THREADS: Record<string, ThreadDetail> = {
  [THREAD_1]: {
    thread_id: THREAD_1,
    story_id: STORY_1,
    room_id: ROOM_1,
    title: 'Water testing dataset — discussion',
    conversation_state: 'deepening',
    safety_state: 'ok',
    created_at: '2026-06-08T09:00:00.000Z',
    available_branches: ['overview', 'evidence', 'questions', 'lenses'],
    current_summary: 'Readers are corroborating the official dataset with independent sources.',
  },
  [THREAD_2]: {
    thread_id: THREAD_2,
    story_id: STORY_2,
    room_id: ROOM_2,
    title: 'Zoning proposal — discussion',
    conversation_state: 'active',
    safety_state: 'ok',
    created_at: '2026-06-08T11:30:00.000Z',
    available_branches: ['overview', 'lenses', 'challenges'],
    current_summary: 'A bridge comment is reconciling two community interpretations.',
  },
};

const BRANCH_CONTRIBUTIONS: Record<string, BranchContent['contributions']> = {
  [`${THREAD_1}:overview`]: [
    {
      contribution_id: '5f5e4000-0000-4000-8000-000000000001',
      author_handle: 'mara',
      body: 'The processed results match the raw samples within the stated tolerance.',
      created_at: '2026-06-08T09:15:00.000Z',
    },
  ],
  [`${THREAD_1}:evidence`]: [
    {
      contribution_id: '5f5e4000-0000-4000-8000-000000000002',
      author_handle: 'devin',
      body: 'Independent lab report (PDF) corroborates the nitrate figures.',
      created_at: '2026-06-08T10:02:00.000Z',
    },
  ],
};

const roomHealth: RoomSummary = {
  room_id: ROOM_1,
  name: 'Public Health',
  slug: 'public-health',
  kind: 'topic',
  description: 'Evidence-led discussion of public-health reporting.',
  joined: true,
};
const roomRiverside: RoomSummary = {
  room_id: ROOM_2,
  name: 'Riverside',
  slug: 'riverside',
  kind: 'local',
  description: 'Local news and civic decisions for the Riverside district.',
  joined: false,
};
const roomLens: RoomSummary = {
  room_id: ROOM_3,
  name: 'Urban Planning Lens',
  slug: 'urban-planning-lens',
  kind: 'lens',
  description: 'A community lens interpreting planning stories.',
  joined: false,
};

export const DEMO_ROOMS: RoomSummary[] = [roomHealth, roomRiverside, roomLens];

const ROOM_DETAILS: Record<string, RoomDetail> = {
  [ROOM_1]: { ...roomHealth, created_at: '2026-05-01T00:00:00.000Z', governance_available: true },
  [ROOM_2]: {
    ...roomRiverside,
    created_at: '2026-05-02T00:00:00.000Z',
    governance_available: false,
  },
  [ROOM_3]: { ...roomLens, created_at: '2026-05-03T00:00:00.000Z', governance_available: false },
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
export function demoThread(threadId: string): ThreadDetail | undefined {
  return THREADS[threadId];
}
export function demoBranch(threadId: string, branch: BranchId): BranchContent {
  return {
    thread_id: threadId,
    branch,
    contributions: BRANCH_CONTRIBUTIONS[`${threadId}:${branch}`] ?? [],
  };
}
export function demoRoom(roomId: string): RoomDetail | undefined {
  return ROOM_DETAILS[roomId];
}

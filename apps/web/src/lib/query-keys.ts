// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Query-key factory (WS-C.1.2). One place that mints consistent, serializable
// tuple keys used for both reads and targeted invalidation, so a typo can never
// silently split a cache entry in two.
import { DEFAULT_FEED_MODE, type FeedMode } from '@licio/shared';

export const queryKeys = {
  feed: (mode: FeedMode = DEFAULT_FEED_MODE) => ['feed', mode] as const,
  story: (storyId: string) => ['story', storyId] as const,
  storyInterpretations: (storyId: string) => ['story', storyId, 'interpretations'] as const,
  /** WS-H.2.3a — the SPEC §7.6 independent-sources drawer payload. */
  storyIndependentSources: (storyId: string) => ['story', storyId, 'independent-sources'] as const,
  /** WS-F.1.2a — the story's public claim projections. */
  storyClaims: (storyId: string) => ['story', storyId, 'claims'] as const,
  storyComments: (
    storyId: string,
    options: {
      order?: 'newest' | 'oldest';
      filter?: 'sources' | 'corrections';
      root?: string;
      depth?: 1 | 2;
    } = {},
  ) => ['story', storyId, 'comments', options] as const,
  thread: (threadId: string) => ['thread', threadId] as const,
  /** WS-T debate arena. */
  debate: (debateId: string) => ['debate', debateId] as const,
  /** WS-T story-level active-debate discovery list. */
  storyDebates: (storyId: string) => ['story', storyId, 'debates'] as const,
  rooms: () => ['rooms'] as const,
  room: (roomId: string) => ['room', roomId] as const,
  roomFeed: (roomId: string) => ['room', roomId, 'feed'] as const,
  /** WS-G.2.2 — the room's interpretation lenses. */
  roomLenses: (roomId: string) => ['room', roomId, 'lenses'] as const,
  // WS-U AI-governed rooms.
  governedBy: (roomId: string) => ['room', roomId, 'governed-by'] as const,
  stewardSeat: (roomId: string) => ['room', roomId, 'steward'] as const,
  governanceModels: (roomId: string) => ['room', roomId, 'governance-models'] as const,
  ratification: (roomId: string) => ['room', roomId, 'ratification'] as const,
  authStatus: () => ['auth-status'] as const,
  settings: () => ['settings'] as const,
  signalLedger: () => ['signal-ledger'] as const,
  savedStories: () => ['saved-stories'] as const,
  featureFlags: () => ['feature-flags'] as const,
  notificationPreferences: () => ['notification-preferences'] as const,
  notificationBudget: () => ['notification-budget'] as const,
  authSessions: () => ['auth-sessions'] as const,
  authCredentials: () => ['auth-credentials'] as const,
  securityActivity: () => ['security-activity'] as const,
  exportStatus: (jobId: string) => ['export-status', jobId] as const,
  deletionStatus: () => ['deletion-status'] as const,
  durablePrivacySettings: () => ['durable-privacy-settings'] as const,
  // WS-J trust & safety.
  blocks: () => ['blocks'] as const,
  mutes: () => ['mutes'] as const,
  moderationNotices: () => ['moderation-notices'] as const,
  appealEligibility: (actionId: string) => ['appeal-eligibility', actionId] as const,
  supportContact: () => ['support-contact'] as const,
  modQueue: (filterKey: string) => ['mod-queue', filterKey] as const,
  modCase: (caseId: string) => ['mod-case', caseId] as const,
  modAppeals: () => ['mod-appeals'] as const,
  modAppeal: (appealId: string) => ['mod-appeal', appealId] as const,
  modAudit: (filterKey: string) => ['mod-audit', filterKey] as const,
  modIncidents: () => ['mod-incidents'] as const,
  modEvidenceQueue: () => ['mod-evidence-queue'] as const,
  modEvidenceDecisions: () => ['mod-evidence-decisions'] as const,
  // WS-L wallets + knomosis.
  wallets: () => ['wallets'] as const,
  walletRiskState: (walletId: string) => ['wallet-risk-state', walletId] as const,
  governanceTab: (roomId: string) => ['room', roomId, 'governance-tab'] as const,
  governanceProposals: (roomId: string) => ['room', roomId, 'governance-proposals'] as const,
  comprehensionQuiz: (roomId: string) => ['room', roomId, 'comprehension-quiz'] as const,
  roomReadiness: (roomId: string) => ['room', roomId, 'readiness'] as const,
} as const;

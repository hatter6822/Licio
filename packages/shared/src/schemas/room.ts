// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Canonical room + lens contracts (WS-G.2, SPEC §16.1/§16.2/§16.5/§17.4).
// Rooms are topic/locality/community spaces; lenses are INTERPRETATION
// CONTEXTS (never echo chambers or scoreboards — no per-lens applause
// framing exists on any wire shape).  `governance_mode` defaults to
// `ordinary` and is read-only in WS-G (mode changes land with WS-L/M).
import { z } from 'zod';
import { isoTimestampSchema, paginatedSchema, uuidSchema } from './common.js';

// ---------------------------------------------------------------------------
// Enums (WS-G.2.1/2.2; STEWARD_ROLES mirrors docs/policy/STEWARD_ROLES.md).
// ---------------------------------------------------------------------------

export const ROOM_TYPES = [
  'global_topic',
  'local_geographic',
  'professional_domain',
  'event',
  'learning',
  'steward',
] as const;
export type RoomType = (typeof ROOM_TYPES)[number];
export const roomTypeSchema = z.enum(ROOM_TYPES);

// WS-Q.1.1a — binary room visibility (SPEC §16.1).  The conflated three-value
// enum (`public|restricted|expert_led`) is replaced by `public|private`, with
// the old values' membership and posting semantics moved to two ORTHOGONAL
// axes below (`join_model`, `posting_policy`).  Tier one (room EXISTENCE) is
// universal; tier two (CONTENT) is members-only for private rooms.
export const ROOM_VISIBILITIES = ['public', 'private'] as const;
export type RoomVisibility = (typeof ROOM_VISIBILITIES)[number];
export const roomVisibilitySchema = z.enum(ROOM_VISIBILITIES);

/** §16.2 join model — HOW a user becomes a member (orthogonal to visibility). */
export const ROOM_JOIN_MODELS = ['open', 'request_approval', 'invite'] as const;
export type RoomJoinModel = (typeof ROOM_JOIN_MODELS)[number];
export const roomJoinModelSchema = z.enum(ROOM_JOIN_MODELS);

/** §16.2 posting policy — WHO may create top-level content (orthogonal). */
export const ROOM_POSTING_POLICIES = ['all_members', 'experts_and_stewards'] as const;
export type RoomPostingPolicy = (typeof ROOM_POSTING_POLICIES)[number];
export const roomPostingPolicySchema = z.enum(ROOM_POSTING_POLICIES);

/** The three legacy three-value visibility values (migration input only). */
export type LegacyRoomVisibility = 'public' | 'restricted' | 'expert_led';

/**
 * WS-Q.1.1b — the SINGLE behavior-preserving mapping from the legacy
 * three-value visibility onto the binary visibility + the two orthogonal axes
 * (SPEC §16.1).  This pure total helper is the SSOT the SQL backfill
 * (migration `0014`) mirrors row-for-row and any compatibility shim reuses:
 *
 *   public      → { public,  open,             all_members }
 *   restricted  → { private, request_approval, all_members }
 *   expert_led  → { private, request_approval, experts_and_stewards }
 *
 * Neither legacy non-public value ever maps to `public` (no read-access
 * widening — property-tested), and the `expert_led` posting restriction is
 * preserved exactly by the posting-policy axis.
 */
export function mapLegacyRoomVisibility(v: LegacyRoomVisibility): {
  visibility: RoomVisibility;
  join_model: RoomJoinModel;
  posting_policy: RoomPostingPolicy;
} {
  switch (v) {
    case 'public':
      return { visibility: 'public', join_model: 'open', posting_policy: 'all_members' };
    case 'restricted':
      return {
        visibility: 'private',
        join_model: 'request_approval',
        posting_policy: 'all_members',
      };
    case 'expert_led':
      return {
        visibility: 'private',
        join_model: 'request_approval',
        posting_policy: 'experts_and_stewards',
      };
    default: {
      const exhaustive: never = v;
      throw new Error(`unhandled legacy room visibility: ${String(exhaustive)}`);
    }
  }
}

/** §17.4 governance lifecycle; `ordinary` is always the default. */
export const GOVERNANCE_MODES = [
  'ordinary',
  'simulated',
  'testnet',
  'capped_production',
  'mature_production',
  'frozen',
  'migrating',
] as const;
export type GovernanceMode = (typeof GOVERNANCE_MODES)[number];
export const governanceModeSchema = z.enum(GOVERNANCE_MODES);

/** The five WS-A.2.2 steward roles (1:1 with the ROLE_* policy ids). */
export const ROOM_STEWARD_ROLES = [
  'community_steward',
  'evidence_steward',
  'safety_moderator',
  'appeals_reviewer',
  'integrity_analyst',
] as const;
export type RoomStewardRole = (typeof ROOM_STEWARD_ROLES)[number];
export const roomStewardRoleSchema = z.enum(ROOM_STEWARD_ROLES);

/**
 * WS-Q.1.6 — the system **Commons** room: every backfilled room-less story
 * lands here, and it is the composer's default home-room suggestion. The id is
 * PINNED so the 0015 SQL seed and the boot-time app-ensure agree exactly; the
 * SQL migration hard-codes this same literal (a unit test asserts they match).
 */
export const COMMONS_ROOM_ID = 'c0000000-0000-4000-8000-000000000000';
export const COMMONS_SLUG = 'commons';

/** Slugs a USER cannot claim at room creation (reserved for system rooms). */
export const RESERVED_ROOM_SLUGS: readonly string[] = [COMMONS_SLUG];

/** §16.2 lens types — interpretation contexts for SCOI. */
export const LENS_TYPES = [
  'local_resident',
  'beginner',
  'expert',
  'affected_community',
  'skeptical',
  'policy',
  'historical',
] as const;
export type LensType = (typeof LENS_TYPES)[number];
export const lensTypeSchema = z.enum(LENS_TYPES);

// ---------------------------------------------------------------------------
// Lens projections (WS-G.2.2/2.4).
// ---------------------------------------------------------------------------

export const lensPublicSchema = z
  .object({
    lens_id: uuidSchema,
    room_id: uuidSchema,
    name: z.string().min(1).max(100),
    lens_type: lensTypeSchema,
    description: z.string().min(1).max(1_000).nullable(),
    created_at: isoTimestampSchema,
  })
  .strict();
export type LensPublic = z.infer<typeof lensPublicSchema>;

export const lensCreateRequestSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    lens_type: lensTypeSchema,
    description: z.string().trim().min(1).max(1_000).optional(),
  })
  .strict();
export type LensCreateRequest = z.infer<typeof lensCreateRequestSchema>;

// ---------------------------------------------------------------------------
// Room projections (WS-G.2.3a/b).
// ---------------------------------------------------------------------------

export const roomSummarySchema = z
  .object({
    room_id: uuidSchema,
    name: z.string().min(1).max(100),
    slug: z.string().min(1).max(120),
    room_type: roomTypeSchema,
    visibility: roomVisibilitySchema,
    /** §16.2 orthogonal axes: how members join and who may post top-level. */
    join_model: roomJoinModelSchema,
    posting_policy: roomPostingPolicySchema,
    description: z.string().max(2_000).nullable(),
    /** Descriptive counts (display only — NEVER recommendation inputs). */
    thread_count: z.number().int().min(0),
    member_count: z.number().int().min(0),
    latest_activity_at: isoTimestampSchema.nullable(),
    governance_mode: governanceModeSchema,
    /** True when the requesting user has an active subscription. */
    joined: z.boolean(),
    created_at: isoTimestampSchema,
  })
  .strict();
export type RoomSummary = z.infer<typeof roomSummarySchema>;

export const roomListResponseSchema = paginatedSchema(roomSummarySchema);
export type RoomListResponse = z.infer<typeof roomListResponseSchema>;

export const roomStewardPublicSchema = z
  .object({
    user_handle: z.string().min(1),
    display_name: z.string().min(1).nullable(),
    role: roomStewardRoleSchema,
    assigned_at: isoTimestampSchema,
  })
  .strict();
export type RoomStewardPublic = z.infer<typeof roomStewardPublicSchema>;

/** Governance info — present ONLY for non-ordinary rooms (§16.5). */
export const roomGovernanceInfoSchema = z
  .object({
    mode: governanceModeSchema,
    note: z.string().min(1).max(2_000),
  })
  .strict();

export const roomDetailSchema = roomSummarySchema
  .extend({
    lenses: z.array(lensPublicSchema).max(7),
    stewards: z.array(roomStewardPublicSchema).max(100),
    /** Omitted (null) for `ordinary` rooms per §16.5. */
    governance: roomGovernanceInfoSchema.nullable(),
    charter_summary: z.string().max(5_000).nullable(),
    /** Pending join request for the requesting user (private rooms). */
    join_pending: z.boolean(),
  })
  .strict();
export type RoomDetail = z.infer<typeof roomDetailSchema>;

// ---------------------------------------------------------------------------
// Room creation (WS-G.2.3c) — per-type required fields.
// ---------------------------------------------------------------------------

// WS-Q.1.1a — the create request is a PURE VALIDATOR: `visibility`,
// `join_model`, and `posting_policy` are all optional here; the route/service
// layer (WS-Q.3.3a) applies the documented defaults (`public→open`,
// `private→request_approval`, steward⇒private; posting `all_members`).  The
// schema only REJECTS incoherent EXPLICIT combinations (the superRefine).
const roomCreateBaseShape = {
  name: z.string().trim().min(1).max(100),
  description: z.string().trim().min(1).max(2_000),
  visibility: roomVisibilitySchema.optional(),
  join_model: roomJoinModelSchema.optional(),
  posting_policy: roomPostingPolicySchema.optional(),
} as const;

export const roomCreateRequestSchema = z
  .discriminatedUnion('room_type', [
    z
      .object({
        ...roomCreateBaseShape,
        room_type: z.literal('global_topic'),
        initial_topics: z.array(z.string().trim().min(1).max(64)).min(1).max(10),
      })
      .strict(),
    z
      .object({
        ...roomCreateBaseShape,
        room_type: z.literal('local_geographic'),
        /** A user-chosen content region — never a detected location (§19.1). */
        geographic_scope: z.string().trim().min(1).max(200),
      })
      .strict(),
    z
      .object({
        ...roomCreateBaseShape,
        room_type: z.literal('professional_domain'),
        domain_descriptor: z.string().trim().min(1).max(200),
      })
      .strict(),
    z
      .object({
        ...roomCreateBaseShape,
        room_type: z.literal('event'),
        event_start: isoTimestampSchema,
        event_end: isoTimestampSchema,
      })
      .strict()
      .refine((value) => Date.parse(value.event_start) < Date.parse(value.event_end), {
        message: 'event_end must be after event_start',
        path: ['event_end'],
      }),
    z
      .object({
        ...roomCreateBaseShape,
        room_type: z.literal('learning'),
        curriculum_outline: z.string().trim().min(1).max(5_000),
      })
      .strict(),
    z
      .object({
        ...roomCreateBaseShape,
        room_type: z.literal('steward'),
      })
      .strict(),
  ])
  .superRefine((value, ctx) => {
    // Steward rooms are private (§16.1).  An EXPLICIT `public` is rejected;
    // omitting visibility lets the service default a steward room to private.
    if (value.room_type === 'steward' && value.visibility === 'public') {
      ctx.addIssue({
        code: 'custom',
        message: 'Steward rooms must be private',
        path: ['visibility'],
      });
    }
    // Coherence (§16.2): a PUBLIC room is openly joinable — `request_approval`
    // and `invite` only make sense on a private room (where membership gates
    // content).  Reject the incoherent explicit combinations; omitted
    // join_model is defaulted by the service per visibility.
    if (value.visibility === 'public' && value.join_model !== undefined) {
      if (value.join_model === 'request_approval' || value.join_model === 'invite') {
        ctx.addIssue({
          code: 'custom',
          message: 'Public rooms use the open join model (private rooms gate membership)',
          path: ['join_model'],
        });
      }
    }
  });
export type RoomCreateRequest = z.infer<typeof roomCreateRequestSchema>;

// ---------------------------------------------------------------------------
// Subscription management (WS-G.2.3d).
// ---------------------------------------------------------------------------

export const roomJoinResponseSchema = z
  .object({
    status: z.enum(['active', 'pending']),
    room: roomSummarySchema,
  })
  .strict();
export type RoomJoinResponse = z.infer<typeof roomJoinResponseSchema>;

export const roomNotificationPreferencesSchema = z
  .object({
    threads: z.enum(['all', 'mentions', 'none']),
    new_evidence: z.boolean(),
    bridge_requests: z.boolean(),
    steward_announcements: z.boolean(),
  })
  .strict();
export type RoomNotificationPreferences = z.infer<typeof roomNotificationPreferencesSchema>;

export const DEFAULT_ROOM_NOTIFICATION_PREFERENCES: RoomNotificationPreferences = {
  threads: 'mentions',
  new_evidence: false,
  bridge_requests: false,
  steward_announcements: true,
};

export const roomJoinRequestDecisionSchema = z
  .object({ decision: z.enum(['approve', 'deny']) })
  .strict();

export const roomJoinRequestPublicSchema = z
  .object({
    request_id: uuidSchema,
    room_id: uuidSchema,
    user_handle: z.string().min(1),
    requested_at: isoTimestampSchema,
  })
  .strict();
export type RoomJoinRequestPublic = z.infer<typeof roomJoinRequestPublicSchema>;

// ---------------------------------------------------------------------------
// Lens reads for SCOI (WS-G.2.4) — interpretation contexts, not factions.
// ---------------------------------------------------------------------------

export const storyLensGroupSchema = z
  .object({
    lens: lensPublicSchema,
    /** Lens-tagged contribution ids (bodies load via the thread reads). */
    contribution_ids: z.array(uuidSchema).max(100),
  })
  .strict();

export const storyLensesResponseSchema = z
  .object({
    story_id: uuidSchema,
    groups: z.array(storyLensGroupSchema).max(7),
    /** SCOI divergence summary when WS-H.4 has produced one; null before. */
    divergence: z
      .object({
        summary: z.string().min(1).max(2_000),
        computed_at: isoTimestampSchema,
      })
      .strict()
      .nullable(),
  })
  .strict();
export type StoryLensesResponse = z.infer<typeof storyLensesResponseSchema>;

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

// ---------------------------------------------------------------------------
// WS-S.0.1 — the three private-room axes (PRIVATE_SPEC §4, §4.1).  These are
// ADDED ALONGSIDE the existing `visibility`/`join_model`/`posting_policy` axes,
// never by overloading them: `visibility` stays the binary WS-Q server read
// bar, while `storage_mode` decides WHERE content lives (Licio server vs member
// devices) and `authority_model` decides WHO holds authority (the platform vs
// room keys only).  The third room class — `private_p2p` (PRIVATE_SPEC §4) — is
// exactly `storage_mode = 'p2p'`; "private" UNQUALIFIED is reserved for it
// (§20.1).  A server-hosted restricted room is a "members-only server room".
// ---------------------------------------------------------------------------

/** §4.1 — WHERE a room's content lives.  `p2p` content never touches the server
 *  (the §8 non-storage contract); the column defaults to `server`. */
export const ROOM_STORAGE_MODES = ['server', 'p2p'] as const;
export type RoomStorageMode = (typeof ROOM_STORAGE_MODES)[number];
export const roomStorageModeSchema = z.enum(ROOM_STORAGE_MODES);

/** §4.1 — WHO holds authority.  `platform` = Licio + room roles (server rooms);
 *  `room_keys` = the room's cryptographic capabilities only (P2P rooms — no
 *  platform role can read/moderate/recover/add-members, §11.4). */
export const ROOM_AUTHORITY_MODELS = ['platform', 'room_keys'] as const;
export type RoomAuthorityModel = (typeof ROOM_AUTHORITY_MODELS)[number];
export const roomAuthorityModelSchema = z.enum(ROOM_AUTHORITY_MODELS);

/** §4.2 — how discoverable a P2P room's existence is.  `listed` leaks a public
 *  shell (name/description), `unlisted` leaks only an opaque stub, `detached`
 *  leaks nothing (no server stub at all).  Server rooms carry no directory
 *  mode (it is NULL for them). */
export const ROOM_DIRECTORY_MODES = ['listed', 'unlisted', 'detached'] as const;
export type RoomDirectoryMode = (typeof ROOM_DIRECTORY_MODES)[number];
export const roomDirectoryModeSchema = z.enum(ROOM_DIRECTORY_MODES);

/** §4.2 — the MANDATORY default for a P2P room: `unlisted`.  `listed` requires
 *  explicit user action + plain-language disclosure (WS-S.7.1). */
export const DEFAULT_P2P_DIRECTORY_MODE: RoomDirectoryMode = 'unlisted';

/**
 * WS-S.0.1 — the §4.1 coherence rules as ONE strict validator (the SSOT the
 * DB CHECK constraints in migration `0043` mirror, PRIVATE_SPEC §23.2):
 *
 *   storage='server' ⇒ authority='platform' ∧ directory_mode IS NULL
 *   storage='p2p'    ⇒ authority='room_keys'
 *                    ∧ visibility='private'
 *                    ∧ join_model='invite'
 *                    ∧ directory_mode IS NOT NULL
 *
 * `posting_policy` is deliberately NOT constrained: for a P2P room it is
 * advisory UI only — real posting is capability-gated by the room's signed ops
 * (PRIVATE_SPEC §4.1), so it is not part of this tuple.  Use `.safeParse(...)`
 * to test an axis combination (accept ⇒ legal triple; reject ⇒ incoherent).
 */
export const roomAxesSchema = z
  .object({
    storage_mode: roomStorageModeSchema,
    authority_model: roomAuthorityModelSchema,
    visibility: roomVisibilitySchema,
    join_model: roomJoinModelSchema,
    /** NULL for server rooms; one of the three modes for P2P rooms. */
    directory_mode: roomDirectoryModeSchema.nullable(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.storage_mode === 'server') {
      if (value.authority_model !== 'platform') {
        ctx.addIssue({
          code: 'custom',
          message: "Server-stored rooms must use the 'platform' authority model",
          path: ['authority_model'],
        });
      }
      // A server room has no P2P directory mode (the column is NULL).
      if (value.directory_mode !== null) {
        ctx.addIssue({
          code: 'custom',
          message: 'Server-stored rooms have no directory mode',
          path: ['directory_mode'],
        });
      }
    } else {
      // storage_mode === 'p2p' — the strong privacy class.
      if (value.authority_model !== 'room_keys') {
        ctx.addIssue({
          code: 'custom',
          message: "Private P2P rooms must use the 'room_keys' authority model",
          path: ['authority_model'],
        });
      }
      if (value.visibility !== 'private') {
        ctx.addIssue({
          code: 'custom',
          message: 'Private P2P rooms must be private',
          path: ['visibility'],
        });
      }
      if (value.join_model !== 'invite') {
        ctx.addIssue({
          code: 'custom',
          message: 'Private P2P rooms must use the invite join model',
          path: ['join_model'],
        });
      }
      if (value.directory_mode === null) {
        ctx.addIssue({
          code: 'custom',
          message: 'Private P2P rooms require a directory mode',
          path: ['directory_mode'],
        });
      }
    }
  });
export type RoomAxes = z.infer<typeof roomAxesSchema>;

/** The three room classes (PRIVATE_SPEC §4) derived from the axes: a single
 *  helper so UI/labels never re-derive the mapping ad hoc. */
export type RoomClass = 'public_server' | 'restricted_server' | 'private_p2p';

/** Map a coherent axis tuple onto its §4 room class.  `private_p2p` is exactly
 *  `storage_mode='p2p'`; a server room is `public_server` when publicly visible,
 *  else `restricted_server` (a "members-only server room"). */
export function roomClassOf(axes: {
  storage_mode: RoomStorageMode;
  visibility: RoomVisibility;
}): RoomClass {
  if (axes.storage_mode === 'p2p') return 'private_p2p';
  return axes.visibility === 'public' ? 'public_server' : 'restricted_server';
}

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

/**
 * WS-G.2.2 — the canonical name for the default, no-committed-lens POSTING state
 * that is present in EVERY room.  A member who has not chosen a specific
 * interpretation lens (membership `lens_id` is null) posts as "Undecided"; it is
 * always the default and needs no per-room provisioning (it IS the null state, so
 * it can never be deleted or absent).  The label is the single source of truth
 * for the server default-note and the client's lens picker/filter.
 */
export const UNDECIDED_LENS_LABEL = 'Undecided';

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
    /** WS-Q.5.1a — true when the requesting user may open top-level content here
     *  (posting_policy + membership/steward; a public room auto-joins on post).
     *  Lets the composer offer only postable rooms. Absent ⇒ false. */
    can_post: z.boolean().default(false),
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
    /** WS-Q.5.3c — true when the requesting user is a steward of this room
     *  (gates the steward-only governance/visibility controls). */
    is_steward: z.boolean().optional(),
    /** WS-G.2.2 — the requesting member's chosen POSTING lens for this room: the
     *  interpretation a top-level comment they write here joins.  `null` is the
     *  default "Undecided" state ([[UNDECIDED_LENS_LABEL]]).  Chosen when the
     *  member joins and changed ONLY through the room's lens control — it is
     *  never a side effect of the reading/filter lens.  `null` for a non-member. */
    my_lens_id: uuidSchema.nullable().default(null),
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

/** WS-G.2.2 — the POSTING lens a member chooses when they join a room.  Omitted
 *  or `null` = the default "Undecided" ([[UNDECIDED_LENS_LABEL]]); a uuid picks a
 *  specific interpretation to represent.  The server validates the lens belongs
 *  to the room. */
export const roomJoinRequestBodySchema = z
  .object({ lens_id: uuidSchema.nullable().optional() })
  .strict();
export type RoomJoinRequestBody = z.infer<typeof roomJoinRequestBodySchema>;

/** WS-G.2.2 — change the caller's POSTING lens for a room they are a member of.
 *  `null` returns to "Undecided"; a uuid must be one of the room's lenses.  This
 *  is the ONLY way to change the lens a member posts through (the reading/filter
 *  lens never touches it). */
export const roomLensSelectionSchema = z.object({ lens_id: uuidSchema.nullable() }).strict();
export type RoomLensSelection = z.infer<typeof roomLensSelectionSchema>;

export const roomJoinRequestDecisionSchema = z
  .object({ decision: z.enum(['approve', 'deny']) })
  .strict();

/** WS-Q.3.3b — steward governance write (join/posting only; NOT visibility). */
export const roomGovernanceSettingsRequestSchema = z
  .object({
    join_model: roomJoinModelSchema.optional(),
    posting_policy: roomPostingPolicySchema.optional(),
  })
  .strict();
export type RoomGovernanceSettingsRequest = z.infer<typeof roomGovernanceSettingsRequestSchema>;

/** WS-Q.3.4 — steward room-visibility cascade (public⇄private). */
export const roomVisibilityChangeRequestSchema = z
  .object({ visibility: roomVisibilitySchema })
  .strict();
export type RoomVisibilityChangeRequest = z.infer<typeof roomVisibilityChangeRequestSchema>;

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

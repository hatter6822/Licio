# WS-G: Forum, Conversation, Rooms, and Lenses

**Milestone:** M1 | **Priority:** P1 | **Dependencies:** WS-F.1 (story/claim schema), WS-D.1 (accounts), WS-B.2 (application components) | **Wave:** 4 | **Estimated duration:** 4-5 weeks

---

## Overview

The forum is where participation happens. Threads have **structured branches**, not flat comment lists (Section 6.4). Rooms provide topic and community scoping (Section 16.1). Lenses provide interpretation contexts for SCOI (Section 16.2). Contributions are **typed** -- question, answer, evidence, correction, synthesis, counterexample, explanation, local context, direct experience, moderation concern, meta-discussion (11 types, Section 15.1) -- not generic comments, because classification improves ranking, moderation, and readability. Reputation exists **without applause**: it is derived from contribution outcomes, never from likes, votes, hearts, karma, or follower counts (Section 15.6). The composer reduces low-information replies by guiding substance through structured modes and opens in under 300ms (Section 6.6, 6.10).

UGC safety is **defense-in-depth** (Sections 25, 18.4): raw user text -> strict Markdown-lite AST -> HTML string -> DOMPurify (`RETURN_TRUSTED_TYPE: true`) -> TrustedHTML -> React render, with a wallet-drainer link interstitial (Section 18.5) on external navigation. No single bypass defeats all layers. The chain is channel-independent and legally mandated for a user-content platform (Section 18.4: report mechanism, timely moderation, blocking, default-hiding, age assurance, published content rating).

### Conventions for this workstream

- **No-applause invariant.** No task introduces a like, upvote, downvote, heart, reaction, karma, follower, or follower-count affordance. Branch and contribution ordering derive from typed-contribution structure, recency, and invariant scores (Section 15.3) -- never from popularity. This is verified by the WS-A.1.1 signal denylist and re-asserted in this workstream's definition of done.
- **Typed contributions.** Every contribution carries a `type` from the fixed 11-member enum. The enum never changes after creation; edits change body/citations only.
- **Structured branches.** Contributions form a tree (`parent_contribution_id`) and are surfaced through the structured reading sections (Overview / Questions / Evidence / Challenges / Local + Expert Lenses / Chronology), not a flat list.
- **UGC defense-in-depth.** All user-authored text and all external links route through the `renderUGC` pipeline and the link-safety check. There are no bypass paths; Biome lint enforces this.
- **Accessibility.** All composer and reader UI meets WCAG 2.2 AA (Section 26): keyboard operability, visible focus, screen-reader labels, 200% zoom reflow, and contrast. Accessibility is a release gate.
- **Observability.** Each API task emits structured `pino` logs and metrics (latency histograms, error rates, validation-rejection counts by type) with no UGC body text or PII in log lines.
- **Field-name canon.** This document is the source of truth for forum field names. Where the schema and metadata diverge from earlier drafts, the schema definitions in WS-G.1 govern. `EvidenceCard.claim_id` (not `target_claim_id`) is the evidence-to-claim link; contribution metadata fields (`included_branch_ids`, `uncertainty_note`, `scope`, `location`, `time_context`, `reason_code`, `urgency`, `target_text_excerpt`, `attachment_ids`, `assumptions`, `caveats`, `relevance_explanation`, `evidence_type`) live in the `metadata` JSONB column defined in WS-G.1.2a-2.

---

## WS-G.1 Thread and contribution schema

### WS-G.1.1 Thread schema
**ID:** WS-G.1.1
**Ref:** Sections 22.1, 6.4

**Description:**
Define the `Thread` Drizzle table in `packages/db/src/schema/thread.ts`. A thread is the conversation shell attached to a story (one thread per story branch). Fields: `thread_id` (UUID PK, default `gen_random_uuid()`), `story_id` (UUID FK to `stories`, NOT NULL, ON DELETE CASCADE), `room_id` (UUID FK to `rooms`, nullable, ON DELETE SET NULL), `branch_index` (integer, default 0 -- a story may host multiple thread branches), `current_summary_id` (UUID FK to `summaries`, nullable, ON DELETE SET NULL), `conversation_state` (enum `conversation_state`: `active`, `deepening`, `tense`, `under_review`, `resolved`, `archived`, default `active`), `safety_state` (enum `safety_state`: `normal`, `elevated`, `under_review`, `restricted`, default `normal`), `created_at` (timestamptz, default now), `updated_at` (timestamptz, default now). State transitions are constrained to a valid graph (see acceptance criteria). Threads are created automatically by the WS-F.1 story-submission flow (every story creates a thread shell).

**Acceptance criteria:**
- Thread table created with all fields, both Postgres enums, and correct FK constraints with the ON DELETE behaviors above.
- Threads are created automatically when stories are submitted (WS-F.1 integration); the thread's `branch_index` defaults to 0.
- Multiple branches per `story_id` are supported; `(story_id, branch_index)` is unique.
- `conversation_state` transitions are validated: `active -> {deepening, tense, under_review, resolved}`, `tense <-> under_review`, `under_review -> {active, restricted, resolved}`, any -> `archived`. Illegal transitions are rejected at the data-access layer with a typed error.
- `safety_state` transitions are validated and any change is written to the moderation audit log (WS-J) with actor, reason, and timestamp.
- Indexes on `story_id`, `room_id`, `conversation_state`, `safety_state`, and `created_at`.

**Testing:**
- Unit: schema validation rejects invalid `conversation_state` / `safety_state` values.
- Unit: state-transition guard accepts the legal graph and rejects every illegal edge (table-driven).
- Integration: thread creation on story submission produces correct FK links and a single branch-0 thread.
- Integration: a `safety_state` change emits an audit-log entry.
- Migration: up and down migrations are idempotent and reversible.

**Dependencies:** WS-F.1 (story schema for `story_id` FK), WS-0 (Drizzle/db tooling). Soft: WS-G.2.1 (rooms) and WS-G.1.4 (summaries) for the nullable FKs -- columns are nullable so this task does not block on them.

---

### WS-G.1.2a Contribution table schema
**ID:** WS-G.1.2a
**Ref:** Sections 22.1, 15.1

**Description:**
Define the `Contribution` Drizzle table in `packages/db/src/schema/contribution.ts`. Fields: `contribution_id` (UUID PK), `thread_id` (UUID FK to `threads`, NOT NULL, ON DELETE CASCADE), `user_id` (UUID FK to `users`, NOT NULL, ON DELETE SET NULL -- preserve thread integrity with a tombstone author rather than deleting content), `type` (enum `contribution_type`: `question`, `answer`, `evidence`, `correction`, `synthesis`, `counterexample`, `explanation`, `local_context`, `direct_experience`, `moderation_concern`, `meta_discussion`), `body` (text, NOT NULL -- raw Markdown-lite, never pre-rendered HTML), `citations` (JSONB, default `[]` -- array of citation objects), `metadata` (JSONB, default `{}` -- per-type structured fields per WS-G.1.2b), `target_claim_id` (UUID FK to `claims`, nullable, ON DELETE SET NULL -- used by correction/evidence/counterexample), `parent_contribution_id` (UUID FK to `contributions`, nullable, ON DELETE SET NULL -- tree structure), `edit_history_ref` (UUID FK to `edit_history`, nullable), `moderation_state` (enum `moderation_state`: `published`, `under_review`, `hidden`, `removed`, default `published`), `created_at` (timestamptz, default now), `updated_at` (timestamptz, default now). The `metadata` column is the canonical home for the per-type fields referenced throughout WS-G.3 (`included_branch_ids`, `uncertainty_note`, `scope`, `location`, `time_context`, `reason_code`, `urgency`, `target_text_excerpt`, `attachment_ids`, `assumptions`, `caveats`, `relevance_explanation`, `evidence_type`).

**Acceptance criteria:**
- All 11 contribution types are represented in the `contribution_type` Postgres enum, in the fixed order above.
- `citations` JSONB validates as an array of citation objects (each with at least `url`; `title`, `accessed_at`, `archive_url` optional) at the application layer.
- `metadata` JSONB defaults to `{}`; its shape is enforced per-type by WS-G.1.2b validation, not by the column.
- `target_claim_id` and `parent_contribution_id` FKs enforce referential integrity with ON DELETE SET NULL.
- `moderation_state` defaults to `published`; transitions are auditable (WS-J).
- Indexes on `thread_id`, `user_id`, `parent_contribution_id`, `type`, `moderation_state`, and `created_at`; composite index on `(thread_id, type, created_at)` for structured-section queries; GIN index on `citations` and `metadata` for containment queries.
- `body` stores raw Markdown only; a CHECK or application guard rejects any value containing a stored `<script` substring is **not** used (sanitization is a render-time concern, WS-G.4) -- the column stores text verbatim.

**Testing:**
- Unit: insertion with each of the 11 types succeeds; insertion with an invalid type is rejected by the enum.
- Unit: `citations` containment query returns rows whose citation array contains a given URL.
- Integration: FK constraints enforced -- inserting with nonexistent `thread_id` or `user_id` fails; deleting a parent contribution sets children's `parent_contribution_id` to NULL.
- Integration: deleting a user sets `user_id` NULL (tombstone) and leaves the contribution body intact.
- Migration: up/down idempotent and reversible.

**Dependencies:** WS-G.1.1 (thread table), WS-D.1 (user schema for `user_id` FK). Soft: WS-F.1 (claims) for `target_claim_id`.

---

### WS-G.1.2b Contribution type validation rules
**ID:** WS-G.1.2b
**Ref:** Sections 15.1, 15.5, 6.6

**Description:**
Define the required and optional fields per contribution type, the canonical home of each (`body`, `citations`, FK columns, or `metadata`), and the per-type error messages. Validation runs server-side before persistence (WS-G.3.1) and client-side before submission (WS-G.3.4-3.6), driven by the shared zod schemas (WS-G.1.2c) so client and server agree. Fields written to `metadata` are listed in the table; `body` is required for every type.

| Type | Required fields | Optional fields | Metadata-resident fields |
|---|---|---|---|
| question | body | target_claim_id | -- |
| answer | body, parent_contribution_id (must reference a `question`) | citations | -- |
| evidence | body, citations (>= 1), target_claim_id | evidence_type | evidence_type |
| correction | body, target_claim_id, citations (>= 1, supporting) | target_text_excerpt | target_text_excerpt |
| synthesis | body, included_branch_ids (>= 2) | uncertainty_note | included_branch_ids, uncertainty_note |
| counterexample | body, target_claim_id, relevance_explanation | source_url | relevance_explanation, source_url |
| explanation | body | assumptions, caveats | assumptions, caveats |
| local_context | body, scope | location, time_context | scope, location, time_context |
| direct_experience | body, scope, privacy_acknowledged (=== true) | location, time_context | scope, location, time_context, privacy_acknowledged |
| moderation_concern | body, target_contribution_id, reason_code (from WS-A.1.2 taxonomy) | urgency | reason_code, urgency, target_contribution_id |
| meta_discussion | body | target_contribution_id | target_contribution_id |

**Acceptance criteria:**
- Server-side validation rejects contributions missing required fields for their type with HTTP 422 and a structured per-field error body.
- `evidence` requires >= 1 citation; submission without citations returns 422 ("Evidence contributions require at least one citation").
- `correction` requires `target_claim_id` and >= 1 supporting citation.
- `synthesis` requires `included_branch_ids` with >= 2 distinct branch IDs that belong to the same thread.
- `direct_experience` requires `metadata.privacy_acknowledged === true`.
- `answer` requires `parent_contribution_id` resolving to a contribution of type `question` in the same thread.
- `moderation_concern` requires a `reason_code` drawn from the WS-A.1.2 moderation-escalation taxonomy and a `target_contribution_id`.
- Error messages are specific per type and field; no generic "invalid input".

**Testing:**
- Unit: one test per type verifying required-field enforcement (>= 11 tests).
- Unit: boundary cases -- empty `citations` for evidence; `included_branch_ids` with 1 entry or with duplicates for synthesis; `included_branch_ids` referencing a foreign thread; `privacy_acknowledged` false/absent for direct_experience.
- Unit: `answer` with a `parent_contribution_id` pointing to a non-question is rejected.
- Integration: API returns 422 with structured error body for each missing required field.

**Dependencies:** WS-G.1.2a (table), WS-A.1.2 (moderation taxonomy for `reason_code`).

---

### WS-G.1.2c Contribution zod schemas in packages/shared
**ID:** WS-G.1.2c
**Ref:** Sections 22.1, 15.1

**Description:**
Author shared zod schemas in `packages/shared/src/schemas/contribution.ts`, consumed by both the Hono BFF and the React client so there is no schema drift. Use a discriminated union keyed on `type` for creation. Schemas: `ContributionCreateSchema` (discriminated union with 11 per-type branches, each encoding the WS-G.1.2b required/optional rules -- e.g., `EvidenceCreateSchema` requires `citations.min(1)` and `target_claim_id`; `SynthesisCreateSchema` requires `included_branch_ids.min(2)`; `DirectExperienceCreateSchema` requires `privacy_acknowledged: z.literal(true)`); `ContributionUpdateSchema` (partial `body`/`citations`/`metadata` update with `contribution_id` required; `type` is omitted so it cannot change); `ContributionPublicSchema` (response shape including computed `author_display_name`, `child_count`, `depth`, `moderation_state`); `CitationSchema` (`url` constrained to http/https or `doi:` form, `title?`, `accessed_at?` ISO datetime, `archive_url?`).

**Acceptance criteria:**
- All schemas exported from `packages/shared/src/schemas/contribution.ts`.
- `ContributionCreateSchema` is a zod discriminated union on `type` with 11 branches.
- Type inference produces correct TypeScript types (`ContributionCreate`, `ContributionUpdate`, `ContributionPublic`, `Citation`).
- Client and server import the same module -- no duplicate definitions.
- `CitationSchema` rejects `javascript:`, `data:`, `vbscript:`, and `file:` URLs and accepts http/https/doi.
- `type` is absent from `ContributionUpdateSchema` (compile-time guarantee).

**Testing:**
- Unit: parse valid payloads for each of the 11 types.
- Unit: parse rejects invalid payloads (missing required fields, wrong citation scheme, `type` present in update).
- Unit: TypeScript type-inference assertions (`expectTypeOf`) match expected shapes.
- Unit: `CitationSchema` rejects each dangerous URL scheme.

**Dependencies:** WS-G.1.2b (validation rules), WS-0 (shared package + zod).

---

### WS-G.1.2d-1 Recursive tree query and depth limit
**ID:** WS-G.1.2d-1
**Ref:** Sections 15.5, 22.1

**Description:**
Contributions form a tree within a thread via `parent_contribution_id`. Implement (a) a recursive CTE that fetches a contribution and all descendants in tree order, (b) a max-depth limit of 10 levels enforced at write time, and (c) a same-thread parent guard. The depth limit and parent guard run in the WS-G.3.1 create path before persistence. This sub-task covers correctness of traversal and the write-time guards; path materialization for read performance is WS-G.1.2d-2.

**Acceptance criteria:**
- Recursive CTE returns the correct subtree (root + all descendants) for any contribution, in depth-first tree order with a `depth` indicator.
- Depth limit enforced: creating a contribution whose parent is already at depth 10 returns 422 ("Maximum thread depth exceeded.").
- Cross-thread parent references are rejected: the parent must belong to the same `thread_id` as the new contribution (422).
- Ancestor walk (contribution -> root) and descendant walk (depth-first) helpers are provided and unit-tested.

**Testing:**
- Unit: tree construction and traversal with 3-level, 5-level, and 10-level trees.
- Unit: depth-limit rejection at level 11.
- Unit: cross-thread parent rejection.
- Integration: recursive CTE correctness with realistic shapes (wide, deep, mixed).

**Dependencies:** WS-G.1.2a (table).

---

### WS-G.1.2d-2 Path materialization and subtree read performance
**ID:** WS-G.1.2d-2
**Ref:** Sections 15.5, 22.1

**Description:**
Add a materialized `path` column (Postgres `ltree`, or a JSONB array of ancestor UUIDs if ltree is unavailable) maintained on insert so subtree reads do not require a recursive CTE on the hot read path. The path is set in application code (or a trigger) at insert time from the parent's path. Expose `GET /v1/threads/:threadId/contributions?root=:contributionId` returning the subtree using the indexed `path` prefix match.

**Acceptance criteria:**
- `path` column maintained on every insert; backfilled for existing rows by the migration.
- Subtree query via `path` prefix returns the same set as the recursive CTE (parity test against WS-G.1.2d-1).
- GIST (ltree) or GIN (JSONB) index on `path`; subtree read uses the index (no recursive CTE, no full scan).
- Subtree read performance: < 50ms for trees up to 500 contributions on the benchmark dataset.
- Reparenting is disallowed (contributions are immutable in parent), so paths never need bulk rewrites; a guard rejects any update to `parent_contribution_id`.

**Testing:**
- Unit: path assignment for inserts at varying depths.
- Integration: path-based subtree equals CTE subtree for wide/deep/mixed trees.
- Performance: benchmark with a 500-contribution thread; assert < 50ms p95.

**Dependencies:** WS-G.1.2d-1.

---

### WS-G.1.3 Evidence card schema
**ID:** WS-G.1.3
**Ref:** Sections 22.1, 15.6

**Description:**
Define the `EvidenceCard` Drizzle table in `packages/db/src/schema/evidence-card.ts`. Fields: `evidence_id` (UUID PK), `claim_id` (UUID FK to `claims`, NOT NULL, ON DELETE CASCADE -- canonical evidence-to-claim link; supersedes any `target_claim_id` naming), `contribution_id` (UUID FK to `contributions`, nullable, ON DELETE SET NULL -- the contribution that introduced this card), `source_id` (UUID FK to `sources`, nullable, ON DELETE SET NULL), `submitted_by` (UUID FK to `users`, ON DELETE SET NULL), `evidence_type` (enum `evidence_type`: `primary_source`, `dataset`, `transcript`, `legal_text`, `report`, `expert_reference`, `fact_check`), `citation_url_or_ref` (text, NOT NULL), `relevance_note` (text, NOT NULL), `verification_state` (enum `verification_state`: `unverified`, `verified`, `disputed`, `retracted`, default `unverified`), `independence_group_id` (UUID, nullable -- links to MERI independence groups, WS-H.2), `created_at`, `updated_at`. The reputation-without-applause model (Section 15.6) draws on evidence reliability (cards that stay useful and are cited by later summaries), so verification-state changes must be auditable.

**Acceptance criteria:**
- Evidence cards created with all required fields; `claim_id`, `citation_url_or_ref`, `relevance_note`, and `evidence_type` are NOT NULL.
- `independence_group_id` links evidence to MERI independence groups (WS-H.2) and is nullable until a group is assigned.
- `verification_state` defaults to `unverified`; every transition writes an audit record (actor, from, to, reason, timestamp).
- Evidence cards linked to claims and sources via FK; deleting a claim cascades, deleting a source nulls `source_id`.
- Indexes on `claim_id`, `source_id`, `submitted_by`, `evidence_type`, `verification_state`, and `independence_group_id`.

**Testing:**
- Unit: schema validation for all 7 evidence types; NOT NULL enforcement on required fields.
- Integration: evidence card creation and linkage to a claim and source.
- Integration: verification-state transition produces an audit record.
- Migration: up/down idempotent.

**Dependencies:** WS-G.1.2a (contributions), WS-F.1 (claims and sources), WS-D.1 (users). Soft: WS-H.2 (MERI independence groups) -- column nullable so no hard block.

---

### WS-G.1.4 Summary schema and layering
**ID:** WS-G.1.4
**Ref:** Sections 15.4, 24.3

**Description:**
Define the `Summary` Drizzle table in `packages/db/src/schema/summary.ts` backing the three summary layers (Section 15.4): `summary_id` (UUID PK), `thread_id` (UUID FK, NOT NULL, ON DELETE CASCADE), `layer` (enum `summary_layer`: `automated_draft`, `community_synthesis`, `steward_summary`), `body` (text, Markdown-lite), `cited_branch_ids` (JSONB array), `cited_evidence_ids` (JSONB array), `unresolved_uncertainty` (text -- required for community/steward layers per Section 24.3), `minority_views_note` (text, nullable -- relevant minority views per Section 24.3), `authored_by` (UUID FK to users, nullable for automated), `approved_by` (UUID FK to users, nullable -- steward who approved a steward summary), `created_at`, `updated_at`. `Thread.current_summary_id` (WS-G.1.1) points at the active summary. Automated drafts are always labeled machine-generated and are never final.

**Acceptance criteria:**
- Summary table created with the `summary_layer` enum and FKs.
- `automated_draft` rows carry a non-removable machine-generated label and cannot be promoted to `current_summary_id` as a final summary without a community or steward layer existing.
- `community_synthesis` and `steward_summary` require a non-empty `unresolved_uncertainty` field (Section 24.3).
- `steward_summary` requires `approved_by` to be a user with a steward role (validated at write time; role source WS-A.2.2 / WS-J).
- `Thread.current_summary_id` FK resolves to a row in this table.

**Testing:**
- Unit: layer enum validation; uncertainty-required enforcement for community/steward layers.
- Integration: steward summary rejected when `approved_by` lacks steward role.
- Integration: setting `current_summary_id` to a summary in another thread is rejected.
- Migration: up/down idempotent.

**Dependencies:** WS-G.1.1 (thread), WS-D.1 (users), WS-A.2.2 (steward roles). Soft: WS-K (automated summarization) populates `automated_draft` rows later.

---

## WS-G.2 Room and lens schema

### WS-G.2.1 Room schema
**ID:** WS-G.2.1
**Ref:** Sections 16.1, 22.1

**Description:**
Define the `Room` Drizzle table in `packages/db/src/schema/room.ts`. Fields: `room_id` (UUID PK), `name` (text, NOT NULL), `slug` (text, NOT NULL, unique per `room_type`), `description` (text), `room_type` (enum `room_type`: `global_topic`, `local_geographic`, `professional_domain`, `event`, `learning`, `steward`), `visibility` (enum `room_visibility`: `public`, `restricted`, `expert_led`, default `public`), `created_by` (UUID FK to users, ON DELETE SET NULL), `governance_mode` (enum `governance_mode`: `ordinary`, `simulated`, `testnet`, `capped_production`, `mature_production`, `frozen`, `migrating`, default `ordinary` -- Section 17.4; ordinary is always the default), `charter_summary` (text, nullable), `created_at`, `updated_at`. Steward assignment is normalized into a separate `room_steward` join table (`room_id`, `user_id`, `role` from the WS-A.2.2 steward-role enum, `assigned_at`) rather than a UUID array, for referential integrity and per-role queries.

**Acceptance criteria:**
- Room table and `room_steward` join table created with all fields and FK constraints.
- `room_type`, `visibility`, and `governance_mode` enforced by Postgres enums; `governance_mode` defaults to `ordinary`.
- `(room_type, slug)` is unique; duplicate name within the same `room_type` is rejected at the API layer (WS-G.2.3c) with 409.
- `room_steward` enforces referential integrity to users; a user may hold multiple roles in a room.
- Indexes on `room_type`, `visibility`, `governance_mode`, and `created_at`; index on `room_steward(room_id)` and `room_steward(user_id)`.

**Testing:**
- Unit: schema validation rejects invalid `room_type`, `visibility`, or `governance_mode`.
- Integration: room creation with all six types succeeds; steward join rows resolve to real users.
- Migration: up/down idempotent.

**Dependencies:** WS-D.1 (users for `created_by` and stewards), WS-A.2.2 (steward-role enum).

---

### WS-G.2.2 Lens schema
**ID:** WS-G.2.2
**Ref:** Sections 16.2, 10.2

**Description:**
Define the `Lens` Drizzle table in `packages/db/src/schema/lens.ts`. Fields: `lens_id` (UUID PK), `room_id` (UUID FK to rooms, NOT NULL, ON DELETE CASCADE), `name` (text, NOT NULL), `lens_type` (enum `lens_type`: `local_resident`, `beginner`, `expert`, `affected_community`, `skeptical`, `policy`, `historical`), `description` (text), `created_at`, `updated_at`. A lens is an **interpretation context, not a private echo chamber** (Section 16.2): lenses describe a vantage point from which a story reads differently, and SCOI uses them to identify where meanings diverge. A room may have multiple lenses; `(room_id, lens_type)` is unique.

**Acceptance criteria:**
- Lens table created with FK to rooms and the 7-member `lens_type` enum.
- A room can have multiple lenses; `(room_id, lens_type)` is unique.
- SCOI can query lens interpretations per room per story (read path provided in WS-G.2.4).
- Deleting a room cascades to its lenses.

**Testing:**
- Unit: schema validation for all 7 lens types; uniqueness on `(room_id, lens_type)`.
- Integration: multiple lenses per room created and queried.
- Migration: up/down idempotent.

**Dependencies:** WS-G.2.1 (rooms).

---

### WS-G.2.3a Room listing and discovery
**ID:** WS-G.2.3a
**Ref:** Section 16.1

**Description:**
Implement `GET /v1/rooms` with query parameters: `type` (filter by `room_type`), `joined` (boolean -- rooms the authenticated user has subscribed to), `recommended` (boolean -- include rooms the user has not joined, ranked by topic relevance and activity; explicitly **not** by popularity or any like/follower count, per the no-applause invariant), `q` (text search on name/description). Cursor-based pagination (default page size 20, max 50). Response per room: `room_id`, `name`, `slug`, `room_type`, `visibility`, `thread_count`, `member_count`, `latest_activity_at`, `governance_mode`.

**Acceptance criteria:**
- Endpoint returns a paginated room list with each filter applied correctly.
- `joined=true` returns only rooms the authenticated user has subscribed to.
- `recommended=true` includes not-yet-joined rooms ranked by topic relevance and activity recency; ranking inputs contain no popularity/applause signal (assert against WS-A.1.1 denylist).
- `q` searches `name` and `description`.
- Unauthenticated users see only `public` rooms; `restricted` and `expert_led` rooms are excluded.
- Response includes `next_cursor`; stable ordering under insertion.

**Testing:**
- Integration: list rooms with each filter combination and pagination across 100+ rooms.
- Integration: unauthenticated request excludes restricted/expert_led rooms.
- Unit: recommendation ranking inputs exclude denylisted signals.
- Performance: room listing < 100ms with 1000 rooms.

**Dependencies:** WS-G.2.1 (rooms), WS-G.2.3d (subscription, for `joined`). Soft: WS-A.1.1 (signal denylist) for the recommendation assertion.

---

### WS-G.2.3b Room detail
**ID:** WS-G.2.3b
**Ref:** Sections 16.1, 16.2, 16.3, 16.5

**Description:**
Implement `GET /v1/rooms/:roomId` returning full room detail: room metadata, active lenses with descriptions (WS-G.2.2), steward list (display names and roles per Section 16.3 from `room_steward`), governance info (present only when `governance_mode != ordinary`, per Section 16.5), paginated thread list (most recent first, cursor-based), member count, and room rules/charter summary (Section 16.4). Restricted/expert_led rooms return 403 to non-members unless the requester holds a steward role in that room.

**Acceptance criteria:**
- Response includes all room fields, lenses, stewards (with role type), governance status, charter summary, and a paginated thread list.
- Steward roles surfaced from the WS-A.2.2 enum: community steward, evidence steward, safety moderator, appeals reviewer, integrity analyst.
- Governance info section present only for non-ordinary rooms; omitted otherwise (Section 16.5).
- Restricted/expert_led room returns 403 for non-members; stewards of that room bypass.
- Thread list paginated with `next_cursor`.

**Testing:**
- Integration: detail for each room type returns the correct structure.
- Integration: restricted room access control enforced; room steward bypass works.
- Integration: lenses and stewards included; governance section present/absent by `governance_mode`.

**Dependencies:** WS-G.2.1, WS-G.2.2, WS-G.1.1 (threads), WS-A.2.2 (roles).

---

### WS-G.2.3c Room creation
**ID:** WS-G.2.3c
**Ref:** Sections 16.1, 16.4

**Description:**
Implement `POST /v1/rooms`. Authorization: authenticated users may create `public` rooms; `restricted` and `expert_led` rooms require an elevated permission (steward role or platform staff); `steward` rooms require platform staff. Required fields vary by `room_type` (table below). The creator is automatically inserted into `room_steward` as community steward. Room rules default to platform-wide rules (Section 16.4); custom rules require steward approval. Duplicate name within the same `room_type` returns 409.

| Room type | Required fields |
|---|---|
| global_topic | name, description, initial_topics |
| local_geographic | name, description, geographic_scope |
| professional_domain | name, description, domain_descriptor |
| event | name, description, event_start, event_end |
| learning | name, description, curriculum_outline |
| steward | name, description (platform staff only) |

**Acceptance criteria:**
- Creation with valid per-type fields succeeds and returns the new room.
- Authorization enforces role requirements for `restricted`/`expert_led` visibility and staff-only `steward` rooms; unauthorized attempts return 403.
- Creator auto-added as community steward in `room_steward`.
- Rules default to platform-wide; custom rules require steward approval before taking effect.
- Duplicate name within the same `room_type` returns 409 Conflict.
- New rooms default to `governance_mode = ordinary`.

**Testing:**
- Integration: create each room type with valid fields.
- Integration: authorization rejection for restricted creation by a regular user; steward-room creation by a non-staff user returns 403.
- Integration: duplicate-name detection; creator appears as community steward.

**Dependencies:** WS-G.2.1, WS-D.1 (auth/roles), WS-A.2.2 (roles).

---

### WS-G.2.3d Room subscription management
**ID:** WS-G.2.3d
**Ref:** Section 16.1

**Description:**
Implement join/leave and per-room notification preferences. `POST /v1/rooms/:roomId/join` subscribes (for `restricted` rooms, creates a join request pending steward approval). `DELETE /v1/rooms/:roomId/join` leaves and removes preferences. `PATCH /v1/rooms/:roomId/notifications` updates preferences: `threads` (all | mentions | none), `new_evidence` (boolean), `bridge_requests` (boolean), `steward_announcements` (boolean). `PATCH /v1/rooms/:roomId/join-requests/:requestId` lets stewards approve/deny. Backed by a `room_subscription` table.

**Acceptance criteria:**
- Joining a public room is immediate; response includes room detail.
- Joining a restricted room creates a pending request; response indicates pending status; steward approval transitions to active.
- Leaving removes the subscription and all per-room notification preferences.
- Notification preferences persist per room per user.
- Idempotent join: joining an already-joined room returns 200 with the existing subscription.

**Testing:**
- Integration: join public room and verify subscription.
- Integration: join restricted room -> pending -> approve -> active.
- Integration: leave removes subscription and preferences.
- Integration: notification preference update and retrieval; idempotent join.

**Dependencies:** WS-G.2.1, WS-D.1.

---

### WS-G.2.4 Lens interpretation API for SCOI
**ID:** WS-G.2.4
**Ref:** Sections 16.2, 10.2, 15.3

**Description:**
Expose the lens read paths that SCOI (WS-H.4) consumes to identify where interpretations diverge. `GET /v1/rooms/:roomId/lenses` lists a room's lenses. `GET /v1/stories/:storyId/lenses?roomId=` returns, per applicable lens, the lens-tagged contributions and any SCOI divergence label for that story (where two or more lenses read the same claims differently). This task provides the data contract and read endpoints only; the SCOI scoring itself lives in WS-H.4 and writes `InvariantOutput` rows that this endpoint surfaces. Lenses must never be presented as factions or scoreboards (no per-lens counts framed as applause); they are interpretation contexts.

**Acceptance criteria:**
- `GET /v1/rooms/:roomId/lenses` returns all lenses for the room with descriptions.
- `GET /v1/stories/:storyId/lenses` returns lens-grouped contributions and a divergence summary sourced from SCOI `InvariantOutput` (WS-H.4) when present; absent gracefully when SCOI has not yet run.
- Response framing presents lenses as interpretation contexts (no leaderboard, no popularity counts).
- Unauthenticated access respects room visibility (restricted/expert_led lenses hidden to non-members).

**Testing:**
- Integration: lens list per room; story-lens grouping across multiple lenses.
- Integration: divergence summary present when an SCOI output exists, omitted otherwise.
- Integration: visibility enforcement for restricted rooms.

**Dependencies:** WS-G.2.2 (lenses), WS-G.1.2a (contributions). Soft: WS-H.4 (SCOI) for divergence labels -- endpoint degrades gracefully without it.

---

## WS-G.3 Contribution API and composer

### WS-G.3.1 Contribution creation endpoint
**ID:** WS-G.3.1
**Ref:** Sections 23.2, 15.1

**Description:**
Implement `POST /v1/contributions`. Validate `type` and required fields per type using the WS-G.1.2c zod schemas and WS-G.1.2b rules. Validate citation URLs (scheme/format; reachability check optional and non-blocking). Run spam/safety pre-checks (rate limiting, content classification via WS-J.2.6) before persistence; flagged content enters `under_review`. Enforce the depth limit and same-thread parent guard (WS-G.1.2d-1). Deduplicate on a client-provided `client_draft_id`. Validate the client integrity token. Body is stored as raw Markdown-lite (sanitization is render-time, WS-G.4).

**Acceptance criteria:**
- All 11 types created with proper validation per WS-G.1.2b/1.2c.
- Invalid type or missing required fields return 422 with a structured per-field error body.
- Rate limiting: max 10 contributions/minute/user; 429 with `Retry-After`.
- `client_draft_id` deduplication is idempotent: resubmitting the same draft ID returns the existing contribution (no duplicate).
- Safety pre-checks run before persistence; flagged content is persisted with `moderation_state = under_review` and enqueued to the moderation queue (WS-J.2.1).
- Depth-limit and cross-thread-parent violations rejected (422) per WS-G.1.2d-1.
- Response includes the full `ContributionPublic` shape (WS-G.1.2c).
- Structured logs/metrics emitted: per-type creation counts, validation-rejection counts, safety-flag counts; no body text or PII in logs.

**Testing:**
- Integration: create one contribution of each type with valid fields.
- Integration: validation rejection for each type's missing required fields.
- Integration: rate-limit enforcement (429 + Retry-After); `client_draft_id` dedup.
- Integration: safety-flagged content enters `under_review` and appears in the moderation queue.
- Security: body containing `<script>...</script>` is stored verbatim and is never executed (render-time sanitization verified in WS-G.4 against this stored value).

**Dependencies:** WS-G.1.2c (zod), WS-G.1.2b (rules), WS-G.1.2d-1 (depth guard), WS-J.2.6 (safety pre-checks), WS-J.2.1 (queue). Soft: WS-G.1.3 for evidence-card co-creation (WS-G.3.2).

---

### WS-G.3.2 Evidence card endpoint
**ID:** WS-G.3.2
**Ref:** Sections 22.1, 15.6

**Description:**
Implement `POST /v1/evidence` to create an `EvidenceCard` (WS-G.1.3) -- citation URL/ref, relevance note, `claim_id` reference, `evidence_type` classification, optional `contribution_id` link, and MERI independence-group assignment (WS-H.2). When invoked from the Evidence composer (WS-G.3.5a), an evidence contribution and its evidence card are created together transactionally so they cannot diverge.

**Acceptance criteria:**
- Evidence cards created and linked to a claim; `citation_url_or_ref`, `relevance_note`, `claim_id`, and `evidence_type` required.
- Independence-group assignment performed (or deferred to WS-H.2) without blocking creation; `independence_group_id` may be null until assigned.
- Citation URL validated for scheme/format (http/https/doi).
- Co-creation with an evidence contribution is atomic (both persist or neither).
- Structured logs/metrics: evidence-card creation count by `evidence_type`.

**Testing:**
- Integration: evidence card creation and claim linkage; each `evidence_type`.
- Integration: independence-group assignment path.
- Integration: atomic co-creation with an evidence contribution; rollback on partial failure.
- Unit: URL/DOI format validation.

**Dependencies:** WS-G.1.3 (evidence schema), WS-G.3.1 (contribution create). Soft: WS-H.2 (MERI groups).

---

### WS-G.3.3 Thread reading endpoints
**ID:** WS-G.3.3
**Ref:** Sections 15.2, 15.3, 15.4, 15.5, 6.4

**Description:**
Implement the thread read APIs that back the structured reading sections (Section 6.4). `GET /v1/threads/:id` returns the overview: branch index plus structured sections (Overview, Questions, Evidence, Challenges, Local/Expert Lenses, Chronology), each populated by contribution type (questions -> Questions; evidence/counterexample -> Evidence; correction -> Challenges; local_context/direct_experience plus lens-tagged contributions -> Local/Expert Lenses; all in time order -> Chronology) and summary status (automated draft / community synthesis / steward summary, Section 15.4). `GET /v1/threads/:id/branches/:branch` returns one branch's contributions in tree order with depth indicators (WS-G.1.2d-2). Support semantic anchoring for deep links to a specific contribution and lazy loading for long branches.

**Acceptance criteria:**
- Overview returns the six structured sections organized by contribution type, plus current summary status and layer.
- Branch endpoint returns contributions in tree order with `depth` indicators (uses materialized `path`).
- Semantic anchoring: a deep link to a specific contribution resolves to its branch and scroll anchor.
- Lazy loading: branches with > 50 contributions return the first 50 with a continuation cursor.
- Ordering within sections is by recency and tree structure -- never by any popularity/applause signal.

**Testing:**
- Integration: overview structure matches the six expected sections and routes each type correctly.
- Integration: branch content in correct tree order with depth indicators.
- Integration: deep-link resolution to a specific contribution.
- Integration: lazy loading with a 100+ contribution thread (first page + cursor).

**Dependencies:** WS-G.1.2d-2 (path/tree reads), WS-G.1.4 (summaries). Soft: WS-G.2.4 (lenses) for the Local/Expert Lenses section.

---

### WS-G.3.4a Composer -- type selector UI
**ID:** WS-G.3.4a
**Ref:** Sections 15.1, 6.4, 6.6, 6.10

**Description:**
Build the Participation Composer entry point. A floating "Contribute" button is anchored bottom-right of the thread view (Section 6.4). Tapping opens the type selector -- "What are you adding?" -- presenting all 11 contribution types as labeled icons with one-line descriptions, grouped for discoverability. Opening must meet the < 300ms budget (Section 6.10) by pre-mounting the selector shell and lazy-loading individual mode bundles. Selecting a type transitions to the corresponding composer mode (WS-G.3.4b-3.6c).

Groups:
- **Ask:** question
- **Respond:** answer, explanation
- **Evidence:** evidence, counterexample, local_context, direct_experience
- **Improve:** correction, synthesis
- **Meta:** moderation_concern, meta_discussion

**Acceptance criteria:**
- Floating button visible on all thread views (bottom-right on mobile and desktop) without obscuring content or violating contrast.
- Button-to-selector transition opens in < 300ms (instrumented; see Testing).
- All 11 types displayed with icons, labels, and one-line descriptions, in the five groups above.
- Keyboard accessible: Tab to button, Enter to open, arrow keys to move between types, Enter to select, Esc to close.
- Screen reader: button labeled "Add contribution"; the selector is a labeled dialog; each type announces name + description.
- WCAG 2.2 AA: focus is trapped in the open dialog and restored to the button on close; target sizes meet AA.

**Testing:**
- E2E (Playwright): button renders, opens selector, all 11 types present in correct groups.
- Performance: measure open time via Performance API; assert p95 < 300ms.
- E2E: keyboard navigation and Esc-to-close with focus restoration.
- Accessibility (axe-core): no violations on the selector dialog.
- Visual: snapshot tests for expanded and collapsed states.

**Dependencies:** WS-B.2 (design-system dialog/button primitives), WS-G.1.2c (types). 

---

### WS-G.3.4b Composer -- Ask mode (question)
**ID:** WS-G.3.4b
**Ref:** Sections 15.1, 6.6

**Description:**
Composer mode for `question`. Prompt: "What would clarify this?" Fields: question text (required, multiline, max 2000 chars, with live character count) and an optional claim-reference selector (typeahead over claims in the current thread; selection sets `target_claim_id`).

**Acceptance criteria:**
- Question text input with character count and limit enforcement.
- Claim-reference typeahead returns claims in the current thread; selection populates `target_claim_id`.
- Submit creates a `question` contribution via WS-G.3.1.
- Empty question text shows a validation error on submit.
- Claim reference is optional; omission is valid.

**Testing:**
- E2E: compose and submit a question with and without a claim reference.
- E2E: character-limit enforcement.
- Unit: claim-reference search returns matching claims.

**Dependencies:** WS-G.3.4a, WS-G.3.1.

---

### WS-G.3.4c Composer -- Flag mode (moderation_concern)
**ID:** WS-G.3.4c
**Ref:** Sections 15.1, 6.6, 18.4

**Description:**
Composer mode for `moderation_concern`. Prompt: "What policy or safety issue exists?" Fields: reason selector mapped to the WS-A.1.2 moderation taxonomy (e.g., harassment, misinformation, spam, manipulation, illegal content, self-harm, privacy violation), target content reference (auto-populated when flagging from a specific contribution's context menu), and urgency (normal | urgent, urgent reserved for imminent harm). This satisfies the channel-independent duty to provide a content-report mechanism (Section 18.4).

**Acceptance criteria:**
- Reason selector presents WS-A.1.2 taxonomy categories with brief descriptions.
- Target contribution auto-populated when flagging from a contribution context menu (sets `target_contribution_id`).
- Urgency defaults to normal; urgent option labeled "Use for imminent harm".
- Submit creates a `moderation_concern` with `reason_code`, `urgency`, and `target_contribution_id` in `metadata`.
- Urgent flags are prioritized in the moderation queue (WS-J.2.1).
- Confirmation shown: "Your concern has been recorded. A steward will review it."

**Testing:**
- E2E: flag a contribution with each reason category; urgent submission.
- Integration: flag creates a `moderation_concern` with correct `reason_code`/`target_contribution_id`.
- Integration: urgent flags surface at the top of the moderation queue.

**Dependencies:** WS-G.3.4a, WS-G.3.1, WS-A.1.2 (taxonomy), WS-J.2.1 (queue).

---

### WS-G.3.5a Composer -- Evidence mode
**ID:** WS-G.3.5a
**Ref:** Sections 15.1, 22.1, 6.6

**Description:**
Composer mode for `evidence`. Prompt: "What source should readers inspect?" Fields: link/citation input (required -- URL or structured citation), relevance note (required, max 500 chars), claim-reference selector (required -- sets `target_claim_id`), and evidence-type selector (the 7 `evidence_type` values). Submit creates both an `evidence` contribution and an `EvidenceCard` atomically (WS-G.3.2). Pasting a URL auto-populates the citation field (WS-G.3.7a).

**Acceptance criteria:**
- Citation input accepts http/https URLs and DOI references; format validated on input; dangerous schemes rejected.
- Relevance note required (max 500 chars); claim reference required (typeahead over thread claims).
- Evidence-type selector exposes all 7 types.
- Submit creates the evidence contribution and evidence card together (atomic).
- Paste detection auto-populates the citation field.

**Testing:**
- E2E: submit evidence with a URL citation and each evidence type; DOI input; paste auto-population.
- Integration: evidence contribution and evidence card created together; rollback on partial failure.
- Unit: URL/DOI format validation; dangerous-scheme rejection.

**Dependencies:** WS-G.3.4a, WS-G.3.2, WS-G.1.3, WS-G.3.7a (paste/citation capture).

---

### WS-G.3.5b Composer -- Correction mode
**ID:** WS-G.3.5b
**Ref:** Sections 15.1, 6.6

**Description:**
Composer mode for `correction`. Prompt: "What is incorrect or missing?" Fields: correction text (required, multiline, max 2000 chars), supporting evidence links (required, >= 1 citation, up to 5), and target-text highlight (pre-populated if the user selected text before opening the composer, else manual input; stored as `target_text_excerpt`). `target_claim_id` is auto-populated from the claim containing the target text where resolvable.

**Acceptance criteria:**
- Correction text required (max 2000 chars); >= 1 and <= 5 supporting citations.
- Target text pre-populated from a prior selection, or manually entered; stored in `metadata.target_text_excerpt`.
- `target_claim_id` auto-populated from the claim containing the target text when resolvable.
- Submit creates a `correction` contribution with `target_text_excerpt` in `metadata`.
- Empty correction text or zero citations returns a validation error.

**Testing:**
- E2E: submit with pre-populated target text; with manual target text; validation rejection with zero citations.
- Integration: correction created with correct `target_claim_id` and `target_text_excerpt`.

**Dependencies:** WS-G.3.4a, WS-G.3.1.

---

### WS-G.3.5c Composer -- Synthesis mode
**ID:** WS-G.3.5c
**Ref:** Sections 15.1, 15.4, 6.6

**Description:**
Composer mode for `synthesis`. Prompt: "What can be fairly summarized?" Fields: summary editor (required, Markdown-lite, max 5000 chars), branch selector (required -- checkboxes over thread branches with summaries; >= 2 distinct branches), and an optional uncertainty note ("What remains unresolved?", max 1000 chars). Submit creates a `synthesis` contribution with `included_branch_ids` and optional `uncertainty_note` in `metadata`.

**Acceptance criteria:**
- Summary editor accepts Markdown-lite up to 5000 chars (rendered later through the WS-G.4 pipeline).
- Branch selector lists current-thread branches; >= 2 distinct branches must be selected.
- Uncertainty note optional (max 1000 chars), labeled "What remains unresolved?".
- Submit creates a `synthesis` with correct `included_branch_ids` and `uncertainty_note`.
- Fewer than 2 branches returns "Synthesis requires at least two branches."

**Testing:**
- E2E: compose synthesis selecting 3 branches with an uncertainty note; rejection with 1 branch.
- Integration: `metadata.included_branch_ids` matches selection; branches verified same-thread.

**Dependencies:** WS-G.3.4a, WS-G.3.1, WS-G.1.2b (synthesis rule).

---

### WS-G.3.6a Composer -- Counterexample mode
**ID:** WS-G.3.6a
**Ref:** Sections 15.1, 6.6

**Description:**
Composer mode for `counterexample`. Prompt: "What case complicates this?" Fields: example text (required, multiline, max 2000 chars), relevance explanation (required, max 500 chars), optional source link (validated as URL if present, stored as `metadata.source_url`), and a required claim-reference selector (sets `target_claim_id`).

**Acceptance criteria:**
- Example text required (max 2000 chars); relevance explanation required (max 500 chars).
- Source link optional; validated as http/https URL when provided.
- `target_claim_id` set via the required claim-reference selector.
- Submit creates a `counterexample` contribution with `relevance_explanation` and optional `source_url` in `metadata`.

**Testing:**
- E2E: submit with and without a source link; validation with missing relevance explanation.
- Integration: counterexample created with `target_claim_id` and metadata fields.

**Dependencies:** WS-G.3.4a, WS-G.3.1.

---

### WS-G.3.6b Composer -- Experience mode
**ID:** WS-G.3.6b
**Ref:** Sections 15.1, 6.6, 19

**Description:**
Composer mode for `direct_experience`. Prompt: "What direct context do you have?" Fields: scope (required, freeform, max 200 chars), optional location/time context (structured approximate location + time period). A prominent privacy warning is shown before the inputs: "This shares personal experience publicly. Do not include identifying details you wish to keep private." A required acknowledgment checkbox sets `metadata.privacy_acknowledged`; submit is disabled until checked.

**Acceptance criteria:**
- Scope required (max 200 chars); location/time optional structured fields.
- Privacy warning shown in a visually distinct callout (amber) before inputs.
- Acknowledgment checkbox required ("I understand this will be shared publicly."); submit disabled until checked.
- `metadata.privacy_acknowledged === true` is required for submission (mirrors server rule WS-G.1.2b).
- Submit creates a `direct_experience` with `scope`, `location`, `time_context`, `privacy_acknowledged` in `metadata`.

**Testing:**
- E2E: submit with scope and location/time; submission blocked without acknowledgment.
- Accessibility: privacy warning is announced by screen readers and associated with the field group.

**Dependencies:** WS-G.3.4a, WS-G.3.1, WS-G.1.2b (privacy rule).

---

### WS-G.3.6c Composer -- Explain mode
**ID:** WS-G.3.6c
**Ref:** Sections 15.1, 6.6

**Description:**
Composer mode for `explanation`. Prompt: "Can you make this easier to understand?" Fields: explanation text (required, multiline, max 3000 chars), optional assumptions ("Assumptions this relies on.", max 500 chars), optional caveats ("Limitations or exceptions.", max 500 chars). Optional fields do not block submission; both store to `metadata`.

**Acceptance criteria:**
- Explanation text required (max 3000 chars).
- Assumptions and caveats optional (max 500 chars each), with the labels above.
- Submit creates an `explanation` contribution with `assumptions`/`caveats` in `metadata` when provided.
- Optional fields do not block submission.

**Testing:**
- E2E: submit with and without assumptions/caveats; character-limit enforcement on all fields.
- Integration: metadata includes `assumptions`/`caveats` when provided.

**Dependencies:** WS-G.3.4a, WS-G.3.1.

---

### WS-G.3.6d Composer -- Respond mode (answer)
**ID:** WS-G.3.6d
**Ref:** Sections 15.1, 15.5, 6.6

**Description:**
Composer mode for `answer`. Reached when a user responds directly to a `question` contribution (the "Respond" group, or a reply affordance on a question). Fields: answer text (required, multiline, max 3000 chars), optional citations (>= 0). `parent_contribution_id` is set to the question being answered and must reference a `question`-type contribution in the same thread (mirrors server rule WS-G.1.2b). This mode is split out so the answer flow is not implicitly bundled into the type selector with no field spec.

**Acceptance criteria:**
- Answer text required (max 3000 chars); citations optional and validated when present.
- `parent_contribution_id` pre-set to the target question; the UI prevents answering a non-question (the affordance only appears on questions).
- Submit creates an `answer` contribution; server rejects an `answer` whose parent is not a question (422).
- Empty answer text shows a validation error.

**Testing:**
- E2E: answer a question; verify parent linkage; attempt to answer a non-question is not offered in UI and is rejected if forced via API.
- Integration: answer created with correct `parent_contribution_id`.

**Dependencies:** WS-G.3.4a, WS-G.3.1, WS-G.1.2b (answer rule).

---

### WS-G.3.7a Citation capture
**ID:** WS-G.3.7a
**Ref:** Sections 15.5, 6.6, 20

**Description:**
Implement browser share-target citation capture and paste detection. Register a PWA `share_target` in the web manifest (`action`, `method: POST`, `enctype`) so sharing a URL to Licio opens the composer with a citation draft. Detect pasted URLs in any citation field and auto-format them. Extract a title from the URL (og:title or `<title>`, with a domain fallback) and build a structured citation (`url`, `title`, `accessed_at`). Show a citation preview (title + domain) before submission. All captured URLs are subject to the link-safety check (WS-G.4.2c) before any preview fetch follows redirects.

**Acceptance criteria:**
- Share target registered; sharing a URL from the browser opens Licio with the citation pre-populated.
- Pasting a URL into any citation field auto-detects and formats it.
- Title extraction succeeds with og:title or `<title>`; falls back to the domain name otherwise.
- Citation preview shows the formatted citation before submission.
- Works on Android (primary PWA install target); graceful copy-paste fallback on iOS.
- Title/preview fetch does not follow links flagged by WS-G.4.2c.

**Testing:**
- E2E: paste a URL and verify detection/formatting and preview.
- Integration: share-target payload processing.
- Unit: URL-pattern detection regex; citation formatting with and without an available title.

**Dependencies:** WS-C.2 (PWA manifest), WS-G.4.2c (link safety). Soft: WS-G.3.5a/3.5b consume it.

---

### WS-G.3.7b Image/document attachment
**ID:** WS-G.3.7b
**Ref:** Sections 15.5, 6.6

**Description:**
Allow image/document attachments on contributions with privacy protections. Endpoint `POST /v1/uploads` (multipart). Allowed types: images (JPEG, PNG, WebP, AVIF), documents (PDF). Size limits: images 5MB, documents 10MB. Strip EXIF (and other location/device) metadata from images before storage. Show a privacy warning before upload: "Uploaded files are publicly visible. Image metadata (location, device info) will be stripped." Require alt text for images before submission (accessibility). Uploaded files link to contributions via `metadata.attachment_ids`.

**Acceptance criteria:**
- Upload accepts allowed types within size limits; disallowed types return 415; oversized files return 413.
- EXIF stripping verified: an uploaded JPEG with GPS returns an image without EXIF GPS.
- Privacy warning shown before upload starts.
- Alt text required for images; submission blocked without it.
- Files linked via `metadata.attachment_ids`; uploads scanned by malware-link/file checks (WS-J.2.6b) before becoming visible.

**Testing:**
- Integration: upload each allowed type within limits; rejection of disallowed/oversized.
- Unit: EXIF stripping verification.
- E2E: privacy-warning display; alt-text requirement enforced.
- Accessibility: alt text associated with the rendered image.

**Dependencies:** WS-G.3.1, WS-J.2.6b (file/link scanning). Soft: WS-G.4 for safe rendering of attachment references.

---

### WS-G.3.7c Local draft autosave
**ID:** WS-G.3.7c
**Ref:** Section 20

**Description:**
Persist composition drafts in IndexedDB for recovery across interruptions, app restarts, and browser closures. IndexedDB store `contribution_drafts` keyed by `client_draft_id` (client-generated UUID). Autosave on: every 5 seconds while composing, on blur, on type-selector change, and on app backgrounding. Draft schema: `client_draft_id`, `thread_id`, `type`, `fields` (full form state), `updated_at`. On opening the composer for a thread with an existing draft, prompt "You have an unsaved draft. Resume or discard?" On sync, if the draft's `client_draft_id` already exists server-side (contribution created), mark synced and clear it (server dedup via WS-G.3.1). Drafts older than 30 days are auto-deleted on app start.

**Acceptance criteria:**
- Draft saved to IndexedDB within 5 seconds of typing and on each trigger above.
- Draft persists across restart; reopening the composer shows the recovery prompt.
- Conflict resolution: submitting an already-synced draft does not create a duplicate (server dedup on `client_draft_id`).
- Draft expiry: drafts older than 30 days cleaned up on app start.
- Multiple drafts for different threads coexist without interference.

**Testing:**
- E2E: compose partial contribution, close app, reopen, verify recovery prompt.
- E2E: submit a draft and verify no duplicate on re-submission.
- Unit: IndexedDB CRUD for drafts; expiry logic.

**Dependencies:** WS-C.2 (IndexedDB/offline), WS-G.3.1 (server dedup).

---

### WS-G.3.7d Voice dictation
**ID:** WS-G.3.7d
**Ref:** Sections 15.5, 6.6

**Description:**
Add Web Speech API voice dictation for body text where available. Detect `window.SpeechRecognition` / `window.webkitSpeechRecognition`. Show a microphone button in the body field only when the API exists. While recording, show a clear indicator (pulsing mic, "Listening..."). Display interim results live; append the final result at the cursor. Provide a stop button. Use the device/user language. Gracefully render nothing when the API is unavailable.

**Acceptance criteria:**
- Microphone button visible only when the Web Speech API is available.
- Recording indicator clearly visible while active.
- Dictated text appended at the cursor position; interim results shown live.
- Stop button ends dictation cleanly.
- Graceful fallback: no button and no error when the API is unavailable.
- No misleading claim that audio is private; behavior matches the browser's default (the browser may use a remote service).

**Testing:**
- E2E (mocked SpeechRecognition): dictation flow.
- Unit: API-availability detection.
- Visual: recording indicator renders.
- Graceful degradation: behavior on a browser without SpeechRecognition.

**Dependencies:** WS-G.3.4a.

---

### WS-G.3.8 Feed preferences endpoint
**ID:** WS-G.3.8
**Ref:** Sections 23.2, 13

**Description:**
Implement `PATCH /v1/feed/preferences` to update personalization mode, topic preferences, feed-mode selection, and notification preferences. Integrates with ranking (WS-I) and privacy (WS-D.2). Valid feed modes: Best, Rising, Sources, Debates, New (Section 11.6; the legacy pre-redesign values stay wire-accepted and normalize forward until stale bundles age out). No feed mode is influenced by likes/followers; changing a mode never exposes popularity ordering (no-applause invariant). Persist per user; changes take effect on the next feed request.

**Acceptance criteria:**
- Preferences persist per user; round-trip via GET/PATCH.
- Feed-mode changes take effect immediately on the next feed request (WS-I).
- Valid feed modes restricted to the five above; invalid values rejected (422).
- No mode introduces popularity/applause ordering; verified against the WS-A.1.1 denylist.

**Testing:**
- Integration: preference update and retrieval; invalid feed mode rejected.
- Integration: feed-mode change reflected in the next feed response.
- Unit: mode set contains no popularity-derived ordering option.

**Dependencies:** WS-D.2 (privacy), WS-I (ranking consumes preferences). Soft: WS-A.1.1 (denylist assertion).

---

## WS-G.4 UGC safety

### WS-G.4.1 Markdown-lite parser
**ID:** WS-G.4.1
**Ref:** Sections 15.5, 25, 18.4

**Description:**
Implement a strict Markdown-lite parser in `packages/shared/src/ugc/markdown.ts` producing a safe AST (the first stage of the defense-in-depth pipeline). Allowed nodes: paragraphs, headings (h1-h3), bold, italic, inline code, code blocks, links (normalized to http/https/mailto), blockquotes, ordered/unordered lists. Stripped: raw HTML (no tag passthrough), `javascript:`/`data:`/`vbscript:` URLs, event-handler attributes. Protocol-relative URLs are normalized to https. The parser never emits raw HTML; it emits an AST that a serializer turns into a constrained HTML string for DOMPurify (WS-G.4.2a). This is the channel-independent sanitization mandated by Section 18.4.

**Acceptance criteria:**
- Parser produces a safe AST from Markdown-lite input; all allowed elements parse correctly.
- Raw HTML is stripped completely (no tag passthrough, including inline `<script>`, `<img onerror>`, `<iframe>`).
- `javascript:`, `data:`, and `vbscript:` URLs are stripped from links.
- Event-handler attributes (`onclick`, `onerror`, etc.) never appear in output.
- Protocol-relative URLs receive an https prefix; non-allowed schemes are dropped.
- Disallowed node types (e.g., raw HTML blocks, autolinks to dangerous schemes) are omitted, not passed through.

**Testing:**
- Unit (Vitest): parse each allowed element type.
- Unit: raw-HTML stripping (`<script>`, `<img onerror>`, `<iframe>`).
- Unit: dangerous URL-scheme stripping; protocol-relative normalization.
- Unit: edge cases -- nested formatting, malformed markdown, unicode, extremely long input.

**Dependencies:** WS-0 (shared package + build tooling).

---

### WS-G.4.2a DOMPurify configuration
**ID:** WS-G.4.2a
**Ref:** Sections 6.12.7, 25

**Description:**
Configure DOMPurify (in `packages/shared/src/ugc/dompurify.ts`) as the second sanitization stage, with `RETURN_TRUSTED_TYPE: true` for Trusted Types integration and an explicit allow-list. Register a named Trusted Types policy (e.g., `licio-ugc`) so the CSP `trusted-types` directive can restrict TrustedHTML creation to this policy only. Configuration: `ALLOWED_TAGS` = p, h1, h2, h3, strong, em, code, pre, a, blockquote, ul, ol, li, br; `ALLOWED_ATTR` = href (on `a` only), class (for syntax highlighting); `ALLOWED_URI_REGEXP` matching only http, https, mailto; `RETURN_TRUSTED_TYPE: true`; `FORBID_TAGS` = script, style, iframe, object, embed, form, input, textarea, select, button, svg, math; `FORBID_ATTR` = `on*` (all event handlers), style, srcset, formaction. Add `rel="noopener noreferrer"` and `target` handling for links via a hook. The instance is centralized so every UGC path uses the same config.

**Acceptance criteria:**
- DOMPurify instantiated with the configuration above in a single shared utility, registering the `licio-ugc` Trusted Types policy.
- Output is `TrustedHTML`; direct string assignment to `innerHTML` is blocked by the CSP `trusted-types` directive (WS-0.5.1).
- All forbidden tags/attributes stripped from any input; allowed tags/attributes preserved.
- Links get `rel="noopener noreferrer"`; only http/https/mailto hrefs survive.
- Configuration is centralized -- all UGC rendering paths use this instance (no per-call config).

**Testing:**
- Unit: each allowed tag passes; each forbidden tag is stripped; event-handler attrs stripped.
- Unit: output is `TrustedHTML`; `javascript:` hrefs stripped; `rel` added to anchors.
- Unit: the Trusted Types policy name matches the CSP directive value.

**Dependencies:** WS-G.4.1 (AST/serializer), WS-0.5.1 (CSP/Trusted Types baseline).

---

### WS-G.4.2b Defense-in-depth pipeline
**ID:** WS-G.4.2b
**Ref:** Sections 25, 18.4

**Description:**
Compose the full pipeline as a single function `renderUGC(markdown: string): TrustedHTML` in `packages/shared/src/ugc/render.ts`: raw text -> Markdown-lite AST (WS-G.4.1) -> constrained HTML string -> DOMPurify (WS-G.4.2a) -> TrustedHTML -> React render. No path may bypass any stage. There is no direct `dangerouslySetInnerHTML` outside this function. A Biome lint rule flags `dangerouslySetInnerHTML` usage not routed through `renderUGC`. The CSP `trusted-types` directive ensures only the `licio-ugc` policy can mint TrustedHTML. The server stores only raw markdown; it never stores pre-rendered HTML.

**Acceptance criteria:**
- All UGC rendering goes through `renderUGC`.
- No bypass paths exist; the Biome rule catches direct `dangerouslySetInnerHTML` and CI fails on violation.
- CSP `trusted-types` directive active; violations are reported to the CSP reporting endpoint and logged.
- Server stores raw markdown; rendering happens client-side through the pipeline.
- Pipeline handles empty, null/undefined, and very long (> 50KB) input gracefully (returns safe empty/truncated TrustedHTML, never throws into render).

**Testing:**
- Integration: end-to-end render from raw markdown to DOM; assert no forbidden elements present.
- Unit: lint rule catches a deliberate bypass attempt.
- E2E: a forced bypass triggers a Trusted Types CSP violation (mock).
- Unit: edge cases -- empty, null, oversized input.

**Dependencies:** WS-G.4.2a, WS-0.4.1 (Biome unsafe-DOM rule), WS-0.5.1 (CSP).

---

### WS-G.4.2c Wallet-drainer link interstitial
**ID:** WS-G.4.2c
**Ref:** Sections 25, 18.5

**Description:**
Detect suspicious contract-interaction URLs that could drain a connected wallet and interpose an interstitial before navigation (Section 18.5). Detection: a maintained drainer-domain blocklist (fetched from a configuration endpoint, updatable without app deploy -- e.g., a community list such as chainpatrol), plus heuristic patterns (URLs with `approve`, `setApprovalForAll`, `permit`, `transferFrom` in path/query; URLs mimicking popular dApp interfaces). All external links in UGC pass through this safety check before navigation (and before any citation-preview fetch, WS-G.3.7a). The interstitial shows the full URL: "This link may interact with your wallet. Verify the URL and contract before proceeding." with continue/back options. The user's choice is not logged beyond the safety-check counter (no per-user click tracking).

**Acceptance criteria:**
- Known drainer-domain URLs trigger the interstitial; suspicious contract-interaction patterns trigger it.
- The interstitial displays the full URL for inspection; continue/back available.
- The blocklist is updatable without app deployment (config endpoint) and cache-busts on update.
- Normal URLs (news sites, Wikipedia, etc.) pass through without an interstitial (no false positives on the fixture set).
- The user's continue/back choice is not associated with their identity in logs.

**Testing:**
- Unit: pattern matching against known drainer URL patterns; normal URLs do not false-positive.
- E2E: clicking a drainer URL shows the interstitial; a safe URL does not.
- Integration: blocklist update propagates to detection; cache invalidation works.

**Dependencies:** WS-G.4.2b (links arrive sanitized), WS-J.2.6b (shared malware/link intelligence). Soft: WS-N config delivery for the blocklist endpoint.

---

### WS-G.4.2d XSS vector testing
**ID:** WS-G.4.2d
**Ref:** Sections 25, OWASP XSS Prevention Cheat Sheet, 18.4

**Description:**
Build a comprehensive XSS test suite in `packages/shared/src/__tests__/xss-vectors.test.ts` running OWASP cheat-sheet vectors through the full `renderUGC` pipeline. Vector families (>= 50 total): script injection (`<script>`, `</script>` breakouts), event-handler injection (`onerror`, `onload`, `onmouseover`), URL-scheme injection (`javascript:`, `data:text/html`, `vbscript:`), CSS injection (`expression()`, `url(javascript:)`), SVG injection (`<svg/onload>`), MathML injection, encoding tricks (HTML entities, numeric/hex entities, unicode, percent-encoding, mixed case, null bytes, overlong UTF-8), mutation XSS (mXSS via `noscript`/`template`/`mglyph`), and DOM clobbering. Every vector is asserted to produce safe output (no script execution, no event handlers, no dangerous URLs in the resulting DOM). The suite is a CI gate; failure blocks merge.

**Acceptance criteria:**
- >= 50 OWASP cheat-sheet vectors covered across all families above.
- Every vector produces safe output through `renderUGC`; no vector yields executable JavaScript or surviving event handlers/dangerous URLs in the DOM.
- The suite runs in CI on every PR and blocks merge on failure.
- The fixture file is maintained and extended when new vectors are published; each fixture documents its source.
- Vectors are also run against contribution bodies persisted via WS-G.3.1 (stored-XSS path), confirming server-stored raw markdown renders safely.

**Testing:**
- Unit (Vitest): each vector as a parameterized case.
- Integration: stored-XSS path -- persist a malicious body via the API, render via `renderUGC`, assert safe DOM.
- Visual: spot-check rendered output for a subset of vectors.
- CI: suite is a required gate.

**Dependencies:** WS-G.4.2b (pipeline), WS-G.3.1 (stored-XSS path), WS-O.1 (security test framework).

---

## Task dependency summary

| Task | ID | Depends on |
|---|---|---|
| Thread schema | WS-G.1.1 | WS-F.1 (story schema), WS-0 |
| Contribution table | WS-G.1.2a | WS-G.1.1, WS-D.1 (users) |
| Contribution validation rules | WS-G.1.2b | WS-G.1.2a, WS-A.1.2 (taxonomy) |
| Contribution zod schemas | WS-G.1.2c | WS-G.1.2b, WS-0 |
| Tree query + depth limit | WS-G.1.2d-1 | WS-G.1.2a |
| Path materialization | WS-G.1.2d-2 | WS-G.1.2d-1 |
| Evidence card schema | WS-G.1.3 | WS-G.1.2a, WS-F.1 (claims/sources), WS-D.1 |
| Summary schema | WS-G.1.4 | WS-G.1.1, WS-D.1, WS-A.2.2 |
| Room schema | WS-G.2.1 | WS-D.1, WS-A.2.2 (roles) |
| Lens schema | WS-G.2.2 | WS-G.2.1 |
| Room listing | WS-G.2.3a | WS-G.2.1, WS-G.2.3d |
| Room detail | WS-G.2.3b | WS-G.2.1, WS-G.2.2, WS-G.1.1, WS-A.2.2 |
| Room creation | WS-G.2.3c | WS-G.2.1, WS-D.1, WS-A.2.2 |
| Room subscription | WS-G.2.3d | WS-G.2.1, WS-D.1 |
| Lens API for SCOI | WS-G.2.4 | WS-G.2.2, WS-G.1.2a |
| Contribution create endpoint | WS-G.3.1 | WS-G.1.2c, WS-G.1.2b, WS-G.1.2d-1, WS-J.2.6, WS-J.2.1 |
| Evidence card endpoint | WS-G.3.2 | WS-G.1.3, WS-G.3.1 |
| Thread reading endpoints | WS-G.3.3 | WS-G.1.2d-2, WS-G.1.4 |
| Composer -- type selector | WS-G.3.4a | WS-B.2, WS-G.1.2c |
| Composer -- Ask | WS-G.3.4b | WS-G.3.4a, WS-G.3.1 |
| Composer -- Flag | WS-G.3.4c | WS-G.3.4a, WS-G.3.1, WS-A.1.2, WS-J.2.1 |
| Composer -- Evidence | WS-G.3.5a | WS-G.3.4a, WS-G.3.2, WS-G.1.3, WS-G.3.7a |
| Composer -- Correction | WS-G.3.5b | WS-G.3.4a, WS-G.3.1 |
| Composer -- Synthesis | WS-G.3.5c | WS-G.3.4a, WS-G.3.1, WS-G.1.2b |
| Composer -- Counterexample | WS-G.3.6a | WS-G.3.4a, WS-G.3.1 |
| Composer -- Experience | WS-G.3.6b | WS-G.3.4a, WS-G.3.1, WS-G.1.2b |
| Composer -- Explain | WS-G.3.6c | WS-G.3.4a, WS-G.3.1 |
| Composer -- Respond (answer) | WS-G.3.6d | WS-G.3.4a, WS-G.3.1, WS-G.1.2b |
| Citation capture | WS-G.3.7a | WS-C.2 (manifest), WS-G.4.2c |
| Image/document attachment | WS-G.3.7b | WS-G.3.1, WS-J.2.6b |
| Local draft autosave | WS-G.3.7c | WS-C.2 (IndexedDB), WS-G.3.1 |
| Voice dictation | WS-G.3.7d | WS-G.3.4a |
| Feed preferences | WS-G.3.8 | WS-D.2, WS-I |
| Markdown-lite parser | WS-G.4.1 | WS-0 |
| DOMPurify configuration | WS-G.4.2a | WS-G.4.1, WS-0.5.1 (CSP/Trusted Types) |
| Defense-in-depth pipeline | WS-G.4.2b | WS-G.4.2a, WS-0.4.1, WS-0.5.1 |
| Wallet-drainer interstitial | WS-G.4.2c | WS-G.4.2b, WS-J.2.6b |
| XSS vector testing | WS-G.4.2d | WS-G.4.2b, WS-G.3.1, WS-O.1 |

---

## Workstream definition of done

WS-G is complete when ALL of the following hold:

1. **All 11 contribution types.** Every type in the fixed enum -- `question`, `answer`, `evidence`, `correction`, `synthesis`, `counterexample`, `explanation`, `local_context`, `direct_experience`, `moderation_concern`, `meta_discussion` -- is implemented, validated server- and client-side per WS-G.1.2b, and renderable in threads. (Corrects the earlier draft, which listed a non-existent type set.)

2. **Per-type validation enforced.** Required/optional field rules (WS-G.1.2b) are enforced through shared zod schemas (WS-G.1.2c) with identical client/server behavior: evidence requires a citation; correction requires target claim + supporting evidence; synthesis requires >= 2 included branches; direct_experience requires privacy acknowledgment; answer requires a question parent.

3. **Thread branching.** Contributions form a tree (`parent_contribution_id`) with a depth limit and same-thread parent guard (WS-G.1.2d-1) and materialized-path reads (WS-G.1.2d-2). The tree is traversable and renderable at any depth, surfaced through the six structured reading sections (Overview / Questions / Evidence / Challenges / Local + Expert Lenses / Chronology) with semantic anchoring and lazy loading (WS-G.3.3).

4. **Rooms and lenses.** Rooms support creation, listing/discovery, detail, subscription, and steward roles, with `governance_mode` defaulting to ordinary (WS-G.2.1, WS-G.2.3a-d). Lenses are interpretation contexts (not echo chambers or scoreboards) and are queryable per room per story for SCOI (WS-G.2.2, WS-G.2.4). Summaries exist in three layers with required uncertainty notes (WS-G.1.4).

5. **Composer performance and modes.** The composer opens in under 300ms (WS-G.3.4a) with all modes available -- Ask, Respond, Evidence, Correction, Synthesis, Counterexample, Experience, Explain, Flag -- including claim attachment, evidence linking, citation capture, attachment privacy warnings, IndexedDB draft autosave/recovery, and voice dictation (WS-G.3.4-3.7).

6. **UGC sanitization (defense-in-depth).** All user content renders through `renderUGC`: Markdown-lite AST -> DOMPurify (`RETURN_TRUSTED_TYPE: true`, `licio-ugc` policy) -> TrustedHTML -> React, with Trusted Types and strict CSP enforced and no bypass path (WS-G.4.1, WS-G.4.2a-b). The server stores raw markdown only.

7. **Zero XSS pass-through.** The OWASP XSS vector suite (>= 50 vectors, including stored-XSS via the API) passes as a CI gate; no vector yields executable JS, surviving event handlers, or dangerous URLs (WS-G.4.2d).

8. **Wallet-drainer protection.** External links route through the link-safety check with a wallet-drainer interstitial and an updatable blocklist (WS-G.4.2c). Citation-preview fetches respect the same check (WS-G.3.7a).

9. **No applause anywhere.** No like, upvote, downvote, heart, reaction, karma, follower, or follower-count affordance exists in any forum, room, lens, composer, or reader surface. Branch/contribution/room ordering and recommendations derive from typed structure, recency, and invariant scores -- never popularity -- verified against the WS-A.1.1 signal denylist.

10. **Accessibility and observability.** All composer and reader UI meets WCAG 2.2 AA (keyboard, focus, screen-reader labels, 200% zoom, contrast), verified by axe-core in CI. Every API task emits structured logs and metrics (latency, error rate, validation-rejection and safety-flag counts) without UGC body text or PII.

11. **Channel-independent UGC duties.** The report mechanism, timely moderation routing, blocking, default-hiding of flagged content, and the published self-declared content rating required by Section 18.4 are wired through the forum's flag flow (WS-G.3.4c) and moderation integration (WS-J).

# WS-G: Forum, Conversation, Rooms, and Lenses

**Milestone:** M1 | **Priority:** 1 | **Dependencies:** WS-F.1, WS-D.1, WS-B.2 | **Wave:** 4 | **Estimated duration:** 4-5 weeks

---

## Overview

The forum is where participation happens. Threads have structured branches, not flat comment lists. Rooms provide topic and community scoping. Lenses provide interpretation contexts for SCOI. Contributions are typed (question, evidence, correction, synthesis, etc.) -- not generic comments. UGC safety is defense-in-depth: Markdown AST to DOMPurify to render, with Trusted Types enforced throughout.

---

## WS-G.1 Thread and contribution schema

### WS-G.1.1 Thread schema
**Ref:** Section 22.1

`Thread` in Drizzle: `thread_id` (UUID PK), `story_id` (FK), `room_id` (FK, nullable), `branch_index`, `current_summary_id` (FK, nullable), `conversation_state` (enum: active, deepening, tense, under_review, resolved, archived), `safety_state` (enum: normal, elevated, under_review, restricted), `created_at`.

**Acceptance criteria:**
- Thread table created with all fields and correct FK constraints.
- Threads are created automatically when stories are submitted.
- Multiple branches per thread are supported and indexed.
- `conversation_state` and `safety_state` enums enforce valid transitions.
- Indexes on `story_id`, `room_id`, and `created_at` for efficient querying.

**Testing:**
- Unit: schema validation rejects invalid state values.
- Integration: thread creation on story submission produces correct FK links.
- Migration: up and down migrations are idempotent.

---

### WS-G.1.2a Contribution table schema
**Ref:** Section 22.1

`Contribution` in Drizzle with all fields: `contribution_id` (UUID PK), `thread_id` (FK to threads), `user_id` (FK to users), `type` (enum: question, answer, evidence, correction, synthesis, counterexample, explanation, local_context, direct_experience, moderation_concern, meta_discussion), `body` (text, required), `citations` (JSONB array, default empty), `target_claim_id` (FK to claims, nullable -- used by correction, evidence, counterexample), `parent_contribution_id` (FK to contributions, nullable -- enables tree structure), `edit_history_ref` (FK to edit_history, nullable), `moderation_state` (enum: published, under_review, hidden, removed), `created_at` (timestamp with timezone).

**Acceptance criteria:**
- All 11 contribution types are represented in the type enum.
- `citations` JSONB validates as an array of citation objects (each with url, title, accessed_at at minimum).
- `target_claim_id` and `parent_contribution_id` FKs enforce referential integrity with ON DELETE SET NULL.
- `moderation_state` defaults to `published`.
- Indexes on `thread_id`, `user_id`, `parent_contribution_id`, `type`, and `created_at`.
- Composite index on `(thread_id, type, created_at)` for structured thread queries.

**Testing:**
- Unit: insertion with each of the 11 types succeeds; insertion with invalid type rejects.
- Unit: JSONB citations field validates structure.
- Integration: FK constraints enforced -- inserting with nonexistent thread_id or user_id fails.
- Migration: up/down idempotent.

---

### WS-G.1.2b Contribution type validation rules
**Ref:** Sections 15.1, 15.5, 6.6 (contribution type table)

Define required and optional fields per contribution type. Validation runs server-side before persistence and client-side before submission.

| Type | Required fields | Optional fields |
|---|---|---|
| question | body | target_claim_id |
| answer | body, parent_contribution_id (must be a question) | citations |
| evidence | body, citations (at least one), target_claim_id | evidence_type |
| correction | body, target_claim_id, citations (supporting evidence) | target_text_excerpt |
| synthesis | body, included_branch_ids (JSONB, at least 2) | uncertainty_note |
| counterexample | body, target_claim_id | source_url, relevance_explanation |
| explanation | body | assumptions, caveats |
| local_context | body, scope (geographic or community descriptor) | location, time_context |
| direct_experience | body, scope | location, time_context, privacy_acknowledged (boolean, must be true) |
| moderation_concern | body, target_contribution_id, reason_code (from moderation taxonomy) | urgency |
| meta_discussion | body | target_contribution_id |

**Acceptance criteria:**
- Server-side validation rejects contributions missing required fields for their type.
- `evidence` type requires at least one citation; submission without citations returns 422 with clear error.
- `correction` type requires `target_claim_id` and at least one supporting citation.
- `synthesis` type requires `included_branch_ids` with at least 2 entries.
- `direct_experience` type requires `privacy_acknowledged = true`.
- `answer` type requires `parent_contribution_id` pointing to a question-type contribution.
- Error messages are specific per type and field ("Evidence contributions require at least one citation").

**Testing:**
- Unit: one test per type verifying required-field enforcement (11 tests minimum).
- Unit: boundary cases -- empty citations array for evidence, included_branch_ids with 1 entry for synthesis.
- Integration: API returns 422 with structured error body for each missing required field.

---

### WS-G.1.2c Contribution zod schemas in packages/shared
**Ref:** Sections 22.1, 15.1

Shared zod schemas for contribution types used by both client and server. Define discriminated unions keyed on `type` field.

Schemas to create:
- `ContributionCreateSchema` -- discriminated union with per-type schemas (e.g., `EvidenceCreateSchema` requires `citations.min(1)` and `target_claim_id`).
- `ContributionUpdateSchema` -- partial body/citations update with `contribution_id` required; type cannot change after creation.
- `ContributionPublicSchema` -- response shape including computed fields (`author_display_name`, `child_count`, `depth`).
- `CitationSchema` -- `url` (string URL), `title` (string, optional), `accessed_at` (ISO datetime, optional), `archive_url` (string, optional).

**Acceptance criteria:**
- All schemas exported from `packages/shared/src/schemas/contribution.ts`.
- `ContributionCreateSchema` is a zod discriminated union on `type` with 11 branches.
- Type inference produces correct TypeScript types (`ContributionCreate`, `ContributionUpdate`, `ContributionPublic`).
- Client and server import the same schemas -- no schema drift.
- Schema validates citation URL format (must be http/https or doi).

**Testing:**
- Unit: parse valid payloads for each of the 11 types.
- Unit: parse rejects invalid payloads (missing required fields, wrong citation format).
- Unit: TypeScript type inference matches expected shapes (compile-time test).

---

### WS-G.1.2d Parent-child tree structure
**Ref:** Section 15.5, 22.1

Contributions form a tree within a thread. `parent_contribution_id` references another contribution in the same thread. The tree supports recursive queries for branch traversal and enforces depth limits.

Implementation:
- Recursive CTE query for fetching a contribution and all descendants.
- Depth limit of 10 levels enforced at write time (server rejects contributions exceeding max depth).
- Efficient path materialization: `path` column (ltree or JSONB array of UUIDs) for fast subtree queries without recursive CTE on reads.
- API: `GET /v1/threads/:threadId/contributions?root=:contributionId` returns subtree.
- Branch traversal: given a contribution, walk ancestors to root; walk descendants depth-first.

**Acceptance criteria:**
- Recursive CTE returns correct subtree for any contribution.
- Depth limit enforced: creating a contribution at depth 11 returns 422 with message "Maximum thread depth exceeded."
- Path column is maintained by trigger or application code on insert.
- Subtree query performance: < 50ms for trees up to 500 contributions (measured with test dataset).
- Cross-thread parent references are rejected (parent must belong to same thread).

**Testing:**
- Unit: tree construction and traversal with 3-level, 5-level, and 10-level trees.
- Unit: depth limit rejection at level 11.
- Integration: recursive CTE correctness with realistic thread shapes (wide, deep, mixed).
- Performance: query benchmark with 500-contribution thread.

---

### WS-G.1.3 Evidence card schema
**Ref:** Section 22.1

`EvidenceCard`: `evidence_id` (UUID PK), `claim_id` (FK), `source_id` (FK, nullable), `submitted_by` (FK), `evidence_type` (enum: primary_source, dataset, transcript, legal_text, report, expert_reference, fact_check), `citation_url_or_ref`, `relevance_note`, `verification_state` (enum: unverified, verified, disputed, retracted), `independence_group_id`. Links to claims and sources.

**Acceptance criteria:**
- Evidence cards created with all required fields.
- `independence_group_id` links evidence to MERI independence groups.
- `verification_state` transitions are audited.
- Evidence cards linked to claims and sources via FK.

**Testing:**
- Unit: schema validation for all evidence types.
- Integration: evidence card creation and linkage to claims.
- Unit: verification state transition audit logging.

---

## WS-G.2 Room and lens schema

### WS-G.2.1 Room schema
**Ref:** Sections 16.1, 22.1

`Room` entity: `room_id` (UUID PK), `name`, `description`, `room_type` (enum: global_topic, local_geographic, professional_domain, event, learning, steward), `visibility` (enum: public, restricted, expert_led), `created_by` (FK), `steward_ids` (array), `created_at`, `updated_at`.

**Acceptance criteria:**
- Room table created with all fields and FK constraints.
- Room types and visibility levels enforced by enum.
- `steward_ids` stored as UUID array with referential integrity check at application level.
- Indexes on `room_type`, `visibility`, and `created_at`.

**Testing:**
- Unit: schema validation rejects invalid room_type or visibility values.
- Integration: room creation with all six types succeeds.
- Migration: up/down idempotent.

---

### WS-G.2.2 Lens schema
**Ref:** Sections 16.2, 10.2

`Lens` entity: `lens_id` (UUID PK), `room_id` (FK), `name`, `lens_type` (enum: local_resident, beginner, expert, affected_community, skeptical, policy, historical), `description`. Lenses are interpretation contexts, not echo chambers. SCOI uses lenses to identify where meanings diverge.

**Acceptance criteria:**
- Lens table created with FK to rooms.
- All 7 lens types represented in enum.
- A room can have multiple lenses.
- SCOI can query lens interpretations per room per story.

**Testing:**
- Unit: schema validation for all lens types.
- Integration: multiple lenses per room created and queried.

---

### WS-G.2.3a Room listing and discovery
**Ref:** Section 16.1

`GET /v1/rooms` with query parameters: `type` (filter by room_type), `joined` (boolean, filter to rooms user has joined), `recommended` (boolean, include recommended rooms), `q` (text search on name/description). Paginated with cursor-based pagination. Response includes room summary (id, name, type, visibility, thread_count, member_count, latest_activity_at).

**Acceptance criteria:**
- Endpoint returns paginated room list with correct filters applied.
- `joined=true` returns only rooms the authenticated user has subscribed to.
- `recommended=true` includes rooms the user has not joined, ranked by topic relevance and activity.
- Text search on `q` parameter searches name and description fields.
- Unauthenticated users see only public rooms.
- Response includes `next_cursor` for pagination; page size default 20, max 50.

**Testing:**
- Integration: list rooms with each filter combination.
- Integration: pagination correctness with 100+ rooms.
- Integration: unauthenticated request excludes restricted rooms.
- Performance: room listing < 100ms with 1000 rooms.

---

### WS-G.2.3b Room detail
**Ref:** Sections 16.1, 16.2, 16.3

`GET /v1/rooms/:roomId` returns full room detail: room metadata, active lenses with descriptions, steward list (display names and roles per Section 16.3), governance info (if Knomosis-enabled per Section 16.5), thread list (paginated, most recent first), member count, and room rules/charter summary.

**Acceptance criteria:**
- Response includes all room fields, lenses, stewards, and governance status.
- Thread list is paginated with cursor-based pagination.
- Restricted rooms return 403 for non-members unless user has steward role.
- Steward list includes role type (community steward, evidence steward, safety moderator, appeals reviewer, integrity analyst).
- Governance info section present only for Knomosis-enabled rooms; otherwise omitted.

**Testing:**
- Integration: detail for each room type returns correct structure.
- Integration: restricted room access control enforced.
- Integration: lenses and stewards included in response.

---

### WS-G.2.3c Room creation
**Ref:** Sections 16.1, 16.4

`POST /v1/rooms` creates a new room. Authorization: authenticated users can create public rooms; restricted and expert_led rooms require elevated permissions (steward role or platform staff). Required fields vary by room type:

| Room type | Required fields |
|---|---|
| global_topic | name, description, initial_topics |
| local_geographic | name, description, geographic_scope |
| professional_domain | name, description, domain_descriptor |
| event | name, description, event_start, event_end |
| learning | name, description, curriculum_outline |
| steward | name, description (restricted to platform staff) |

**Acceptance criteria:**
- Room creation with valid fields succeeds and returns the new room.
- Authorization checks enforce role requirements for restricted/expert_led visibility.
- Steward rooms can only be created by platform staff.
- Creator is automatically added as the initial community steward.
- Room rules default to platform-wide rules (Section 16.4); custom rules require steward approval.
- Duplicate name within same room_type returns 409 Conflict.

**Testing:**
- Integration: create each room type with valid fields.
- Integration: authorization rejection for restricted room creation by regular user.
- Integration: steward room creation by non-staff returns 403.
- Integration: duplicate name detection.

---

### WS-G.2.3d Room subscription management
**Ref:** Section 16.1

Join and leave rooms. Notification preferences per room.

- `POST /v1/rooms/:roomId/join` -- subscribe to room. For restricted rooms, creates a join request pending steward approval.
- `DELETE /v1/rooms/:roomId/join` -- leave room. Removes subscription and notification preferences.
- `PATCH /v1/rooms/:roomId/notifications` -- update notification preferences: `threads` (all, mentions, none), `new_evidence` (boolean), `bridge_requests` (boolean), `steward_announcements` (boolean).

**Acceptance criteria:**
- Joining a public room is immediate; response includes room detail.
- Joining a restricted room creates a pending request; response indicates pending status.
- Stewards can approve/deny join requests via `PATCH /v1/rooms/:roomId/join-requests/:requestId`.
- Leaving a room removes subscription and all per-room notification preferences.
- Notification preferences persist per room per user.
- A user cannot join the same room twice (idempotent -- returns current subscription).

**Testing:**
- Integration: join public room, verify subscription.
- Integration: join restricted room, verify pending state, approve, verify active.
- Integration: leave room, verify subscription and preferences removed.
- Integration: notification preference update and retrieval.
- Integration: idempotent join returns 200 with existing subscription.

---

## WS-G.3 Contribution API and composer

### WS-G.3.1 Contribution creation endpoint
**Ref:** Section 23.2

`POST /v1/contributions`. Validate type and required fields per type (WS-G.1.2b validation rules). Citation URL validation (format, reachability check optional). Spam/safety pre-checks (rate limiting, content classification). Local draft ID for offline sync (client provides `client_draft_id`; server deduplicates on it). Client integrity token validation.

**Acceptance criteria:**
- All 11 types created with proper validation per WS-G.1.2b rules.
- Invalid type or missing required fields return 422 with structured errors.
- Rate limiting: max 10 contributions per minute per user; 429 response with Retry-After header.
- `client_draft_id` deduplication: resubmitting same draft ID returns existing contribution (idempotent).
- Safety pre-checks run before persistence; flagged content enters `under_review` moderation state.
- Response includes full `ContributionPublic` shape.

**Testing:**
- Integration: create one contribution of each type with valid fields.
- Integration: validation rejection for each type's missing required fields.
- Integration: rate limit enforcement.
- Integration: client_draft_id deduplication.
- Integration: safety-flagged content enters under_review state.

---

### WS-G.3.2 Evidence card endpoint
**Ref:** Section 22.1

`POST /v1/evidence`. Citation URL/ref, relevance note, claim reference. Evidence-type classification. Link to independence group for MERI.

**Acceptance criteria:**
- Evidence cards created and linked to claims.
- Independence group assignment for MERI integration.
- Citation URL validated for format.

**Testing:**
- Integration: evidence card creation and claim linkage.
- Integration: independence group assignment.

---

### WS-G.3.3 Thread reading endpoints
**Ref:** Sections 15.2, 15.3, 15.4, 15.5

`GET /v1/threads/:id` -- overview with branch index and structured sections (Overview, Questions, Evidence, Challenges, Local/Expert Lenses, Chronology per Section 6.4). `GET /v1/threads/:id/branches/:branch` -- branch content. Semantic anchoring for deep links. Lazy loading for long branches.

**Acceptance criteria:**
- Thread overview returns structured sections organized by contribution type.
- Branch endpoint returns contributions in tree order with depth indicators.
- Semantic anchoring: deep links to specific contributions resolve correctly.
- Lazy loading: branches with > 50 contributions return first 50 with continuation cursor.
- Response includes summary status (automated draft, community synthesis, steward summary per Section 15.4).

**Testing:**
- Integration: thread overview structure matches expected sections.
- Integration: branch content in correct tree order.
- Integration: deep link resolution to specific contribution.
- Integration: lazy loading with large thread (100+ contributions).

---

### WS-G.3.4a Composer -- type selector UI
**Ref:** Sections 15.1, 6.10

Participation Composer UI entry point. Floating "Contribute" button anchored to bottom-right of thread view. Tapping opens type selector: "What are you adding?" with all 11 contribution types displayed as labeled icons with short descriptions.

Types grouped into categories:
- **Ask**: question
- **Respond**: answer, explanation
- **Evidence**: evidence, counterexample, local_context, direct_experience
- **Improve**: correction, synthesis
- **Meta**: moderation_concern, meta_discussion

**Acceptance criteria:**
- Floating button visible on all thread views, positioned per platform conventions (bottom-right on mobile, bottom-right fixed on desktop).
- Button-to-selector transition opens in < 300ms (Section 6.10 performance budget).
- All 11 types displayed with icons, labels, and one-line descriptions.
- Type grouping aids discoverability without requiring users to memorize categories.
- Keyboard accessible: Tab to button, Enter to open, arrow keys to navigate types, Enter to select.
- Screen reader: button labeled "Add contribution"; type selector announces type name and description.
- Selection transitions to the appropriate composer mode (WS-G.3.4b through WS-G.3.6c).

**Testing:**
- E2E (Playwright): button renders, opens selector in < 300ms, all 11 types present.
- E2E: keyboard navigation through type selector.
- Accessibility (axe-core): no violations on selector panel.
- Visual: snapshot tests for selector in expanded and collapsed states.

---

### WS-G.3.4b Composer -- Ask mode
**Ref:** Section 15.1

Composer mode for `question` type. Fields: question text input (required, multiline, max 2000 chars), optional claim reference selector (search existing claims in thread, select one to attach as `target_claim_id`).

**Acceptance criteria:**
- Question text input with character count and limit enforcement.
- Claim reference selector: typeahead search of claims in current thread; selection populates `target_claim_id`.
- Submit creates a contribution of type `question`.
- Empty question text shows validation error on submit attempt.
- Claim reference is optional; omitting it is valid.

**Testing:**
- E2E: compose and submit a question with and without claim reference.
- E2E: character limit enforcement.
- Unit: claim reference search returns matching claims.

---

### WS-G.3.4c Composer -- Flag mode
**Ref:** Sections 15.1, moderation taxonomy (WS-A)

Composer mode for `moderation_concern` type. Fields: reason selector (mapped to moderation taxonomy from WS-A -- categories such as harassment, misinformation, spam, manipulation, illegal content, self-harm, privacy violation), target content reference (auto-populated if flagging from a specific contribution), urgency indicator (normal, urgent -- urgent for imminent harm situations).

**Acceptance criteria:**
- Reason selector presents moderation taxonomy categories with brief descriptions.
- Target contribution is auto-populated when flagging from a contribution's context menu.
- Urgency indicator defaults to normal; urgent option available with explanation ("Use for imminent harm").
- Submit creates a contribution of type `moderation_concern` with `reason_code` and `urgency` in metadata.
- Urgent flags are prioritized in the moderation queue (WS-J.2).
- User sees confirmation: "Your concern has been recorded. A steward will review it."

**Testing:**
- E2E: flag a contribution with each reason category.
- E2E: urgent flag submission.
- Integration: flag creates moderation_concern contribution with correct reason_code.
- Integration: urgent flags appear at top of moderation queue.

---

### WS-G.3.5a Composer -- Evidence mode
**Ref:** Sections 15.1, 22.1

Composer mode for `evidence` type. Fields: link/citation input (required -- URL or structured citation), relevance note (required, explains how evidence relates to the claim), claim reference selector (required -- which claim this evidence supports or challenges), evidence type selector (primary_source, dataset, transcript, legal_text, report, expert_reference, fact_check per Section 22.1).

**Acceptance criteria:**
- Citation input accepts URLs (http/https) and DOI references; validates format on input.
- Relevance note required; max 500 chars.
- Claim reference required; typeahead search of claims in current thread.
- Evidence type selector with all 7 types from evidence card schema.
- Submit creates both a contribution of type `evidence` and an `EvidenceCard` (WS-G.1.3).
- Paste detection: pasting a URL auto-populates the citation field.

**Testing:**
- E2E: submit evidence with URL citation and each evidence type.
- E2E: DOI reference input.
- E2E: paste URL auto-population.
- Integration: evidence contribution and evidence card created together.
- Unit: URL and DOI format validation.

---

### WS-G.3.5b Composer -- Correction mode
**Ref:** Section 15.1

Composer mode for `correction` type. Fields: correction text (required -- the corrected information), supporting evidence links (required, at least one citation), target text highlight (the specific text being corrected -- populated if user selected text before opening composer, or manual input).

**Acceptance criteria:**
- Correction text input required, multiline, max 2000 chars.
- Supporting evidence: at least one citation URL required; up to 5 citations.
- Target text: if user highlighted text before opening composer, pre-populated; otherwise manual input.
- `target_claim_id` auto-populated from the claim containing the target text.
- Submit creates a contribution of type `correction` with target_text_excerpt in metadata.
- Validation: empty correction text or zero citations returns error.

**Testing:**
- E2E: submit correction with pre-populated target text.
- E2E: submit correction with manually entered target text.
- E2E: validation rejection with zero citations.
- Integration: correction contribution created with correct metadata.

---

### WS-G.3.5c Composer -- Synthesis mode
**Ref:** Sections 15.1, 15.4

Composer mode for `synthesis` type. Fields: summary editor (required -- the synthesized understanding), branch selector (required -- checkboxes for which branches to synthesize, minimum 2), uncertainty note field (optional -- what remains unresolved or uncertain).

**Acceptance criteria:**
- Summary editor: rich text (Markdown-lite), max 5000 chars.
- Branch selector: displays branches in current thread as checkboxes with branch summaries; at least 2 must be selected.
- Uncertainty note: optional free text, max 1000 chars; appears labeled "What remains unresolved?"
- Submit creates a contribution of type `synthesis` with `included_branch_ids` and optional `uncertainty_note` in metadata.
- Validation: fewer than 2 branches selected returns error "Synthesis requires at least two branches."

**Testing:**
- E2E: compose synthesis selecting 3 branches with uncertainty note.
- E2E: validation rejection with 1 branch selected.
- Integration: synthesis contribution metadata includes correct branch IDs.

---

### WS-G.3.6a Composer -- Counterexample mode
**Ref:** Section 15.1

Composer mode for `counterexample` type. Fields: example text (required -- description of the counterexample), relevance explanation (required -- why this example challenges the claim), source link (optional -- citation for the counterexample).

**Acceptance criteria:**
- Example text required, multiline, max 2000 chars.
- Relevance explanation required, max 500 chars.
- Source link optional; validated as URL if provided.
- `target_claim_id` populated via claim reference selector (required).
- Submit creates a contribution of type `counterexample`.

**Testing:**
- E2E: submit counterexample with and without source link.
- E2E: validation with missing relevance explanation.
- Integration: counterexample contribution created with target_claim_id.

---

### WS-G.3.6b Composer -- Experience mode
**Ref:** Section 15.1

Composer mode for `direct_experience` type. Fields: scope field (required -- geographic, community, or situational context of the experience), location/time context (optional -- when and where the experience occurred), privacy warning displayed prominently: "This shares personal experience publicly. Do not include identifying details you wish to keep private."

**Acceptance criteria:**
- Scope field required; freeform text describing the context, max 200 chars.
- Location/time context optional; structured fields for approximate location and time period.
- Privacy warning displayed in a visually distinct callout (yellow/amber background) before the input fields.
- Privacy acknowledgment checkbox required: "I understand this will be shared publicly."
- `privacy_acknowledged` must be `true` for submission; submit button disabled until checked.
- Submit creates a contribution of type `direct_experience` with scope, location, and time_context in metadata.

**Testing:**
- E2E: submit experience with scope and location/time.
- E2E: privacy warning visible and acknowledgment required.
- E2E: submit blocked without privacy acknowledgment.
- Accessibility: privacy warning announced by screen readers.

---

### WS-G.3.6c Composer -- Explain mode
**Ref:** Section 15.1

Composer mode for `explanation` type. Fields: explanation text (required -- the explanation itself), assumptions field (optional -- "What assumptions does this explanation rely on?"), caveats field (optional -- "What are the limitations or exceptions?").

**Acceptance criteria:**
- Explanation text required, multiline, max 3000 chars.
- Assumptions field optional, max 500 chars, labeled "Assumptions this relies on."
- Caveats field optional, max 500 chars, labeled "Limitations or exceptions."
- Submit creates a contribution of type `explanation` with assumptions and caveats in metadata.
- Optional fields do not block submission.

**Testing:**
- E2E: submit explanation with and without assumptions/caveats.
- E2E: character limit enforcement on all fields.
- Integration: explanation contribution metadata includes assumptions and caveats when provided.

---

### WS-G.3.7a Citation capture
**Ref:** Sections 15.5, 20 (PWA)

Browser share target integration for citation capture. When users share a URL to Licio from their browser or another app, it is captured as a citation draft.

Implementation:
- PWA share target registration in web manifest (`share_target` with `action`, `method: POST`, `enctype`).
- Paste URL detection in all citation input fields: detect pasted text matching URL patterns, auto-populate citation fields.
- Citation formatting: extract title from URL (via metadata fetch or og:title), format as structured citation with url, title, accessed_at.
- Citation preview: show title and domain before submission.

**Acceptance criteria:**
- Share target registered in web manifest; sharing a URL from browser opens Licio with citation pre-populated.
- Pasting a URL into any citation field auto-detects and formats it.
- Title extraction succeeds for URLs with og:title or <title> tags; falls back to domain name if unavailable.
- Citation preview shows formatted citation before submission.
- Share target works on Android (primary PWA install target); graceful fallback on iOS (copy-paste).

**Testing:**
- E2E: paste URL into citation field, verify auto-detection and formatting.
- Integration: share target payload processing.
- Unit: URL pattern detection regex.
- Unit: citation formatting with and without available title.

---

### WS-G.3.7b Image/document attachment
**Ref:** Section 15.5

Upload images and documents as attachments to contributions. Privacy warnings for uploads containing metadata.

Implementation:
- File upload endpoint: `POST /v1/uploads` with multipart form data.
- Allowed file types: images (JPEG, PNG, WebP, AVIF), documents (PDF).
- Size limits: images max 5MB, documents max 10MB.
- Metadata stripping: EXIF data stripped from images before storage (prevents location/device leakage).
- Privacy warning displayed before upload: "Uploaded files are publicly visible. Image metadata (location, device info) will be stripped."
- Accessibility: uploaded images require alt text before submission.

**Acceptance criteria:**
- Upload accepts allowed file types within size limits.
- Rejected file types return 415 Unsupported Media Type.
- Oversized files return 413 Payload Too Large.
- EXIF stripping verified: uploaded JPEG with GPS data returns image without EXIF GPS.
- Privacy warning displayed before upload starts.
- Alt text required for images; submission blocked without it.
- Uploaded files linked to contributions via `attachment_ids` in contribution metadata.

**Testing:**
- Integration: upload each allowed file type within size limits.
- Integration: rejection of disallowed file types and oversized files.
- Unit: EXIF stripping verification.
- E2E: privacy warning display.
- Accessibility: alt text requirement enforced.

---

### WS-G.3.7c Local draft autosave
**Ref:** Section 20 (PWA offline)

Save composition drafts locally in IndexedDB for recovery after interruption. Drafts persist across app restarts and browser closures.

Implementation:
- IndexedDB store `contribution_drafts` keyed by `client_draft_id` (UUID generated client-side).
- Autosave triggers: every 5 seconds while composing, on blur, on type selector change, on app backgrounding.
- Draft schema: `client_draft_id`, `thread_id`, `type`, `fields` (all current form state), `updated_at`.
- Draft recovery: on opening composer for a thread, check for existing drafts; prompt "You have an unsaved draft. Resume or discard?"
- Conflict resolution on sync: if draft's `client_draft_id` already exists server-side (contribution was created), mark draft as synced and clear it.
- Draft expiry: drafts older than 30 days auto-deleted.

**Acceptance criteria:**
- Draft saved to IndexedDB within 5 seconds of typing.
- Draft persists across app restart; reopening composer shows recovery prompt.
- Conflict resolution: submitting a draft that was already synced does not create a duplicate (server deduplication on `client_draft_id`).
- Draft expiry: drafts older than 30 days are cleaned up on app start.
- Multiple drafts for different threads coexist without interference.

**Testing:**
- E2E: compose partial contribution, close app, reopen, verify draft recovery prompt.
- E2E: submit draft, verify no duplicate on re-submission.
- Unit: IndexedDB CRUD operations for drafts.
- Unit: draft expiry logic.

---

### WS-G.3.7d Voice dictation
**Ref:** Section 15.5

Voice dictation for contribution body text using the Web Speech API where available.

Implementation:
- Check `window.SpeechRecognition` or `window.webkitSpeechRecognition` availability.
- Microphone button in composer body field; only shown when API is available.
- Clear UI indicator while recording: pulsing microphone icon, "Listening..." text.
- Interim results displayed in real-time; final result appended to body text.
- Stop button to end dictation.
- Language detection: use device language or user's preferred language setting.

**Acceptance criteria:**
- Microphone button visible only when Web Speech API is available.
- Recording indicator clearly visible while dictation is active.
- Dictated text appended to body field at cursor position.
- Stop button ends dictation cleanly.
- Graceful fallback: if API unavailable, microphone button not rendered (no error).
- Privacy: no indication that audio is sent to a third-party service beyond browser's default behavior.

**Testing:**
- E2E (with mock): dictation flow with mocked SpeechRecognition API.
- Unit: API availability detection.
- Visual: recording indicator renders correctly.
- Graceful degradation: test on browser without SpeechRecognition.

---

### WS-G.3.8 Feed preferences endpoint
**Ref:** Section 23.2

`PATCH /v1/feed/preferences` -- update personalization mode, topic preferences, feed mode selection, notification preferences. Integrates with ranking (WS-I) and privacy (WS-D.2).

**Acceptance criteria:**
- Preferences persist per user.
- Feed mode changes take effect immediately on next feed request.
- Valid feed modes: Balanced, Chronological, Source-diverse, Local, Low personalization.

**Testing:**
- Integration: preference update and retrieval.
- Integration: feed mode change reflected in next feed response.

---

## WS-G.4 UGC safety

### WS-G.4.1 Markdown-lite parser
**Ref:** Section 15.5

Strict Markdown-lite parser producing safe AST. Allowed: paragraphs, headings (h1-h3), bold, italic, code (inline and block), links (normalized to http/https), blockquotes, lists (ordered and unordered). Stripped: raw HTML, `javascript:` URLs, `data:` URLs, event-handler attributes.

**Acceptance criteria:**
- Parser produces safe AST from Markdown-lite input.
- All allowed elements render correctly.
- Raw HTML stripped completely (no tag passthrough).
- `javascript:`, `data:`, and `vbscript:` URLs stripped from links.
- Event-handler attributes (onclick, onerror, etc.) never present in output.
- Link URLs normalized: protocol-relative URLs get https prefix.

**Testing:**
- Unit (Vitest): parse each allowed element type.
- Unit: raw HTML stripping (inline `<script>`, `<img onerror>`, `<iframe>`).
- Unit: dangerous URL scheme stripping.
- Unit: edge cases -- nested formatting, malformed markdown, unicode.

---

### WS-G.4.2a DOMPurify configuration
**Ref:** Section 6.12.7, 25

DOMPurify configured with `RETURN_TRUSTED_TYPE: true` for Trusted Types integration. Explicit allow-list of tags, attributes, and URL schemes.

Configuration:
- `ALLOWED_TAGS`: p, h1, h2, h3, strong, em, code, pre, a, blockquote, ul, ol, li, br.
- `ALLOWED_ATTR`: href (on a only), class (for syntax highlighting).
- `ALLOWED_URI_REGEXP`: matches only http, https, and mailto schemes.
- `RETURN_TRUSTED_TYPE: true` -- output is a TrustedHTML object.
- `FORBID_TAGS`: script, style, iframe, object, embed, form, input, textarea, select, button, svg, math.
- `FORBID_ATTR`: on* (all event handlers), style, srcset, formaction.

**Acceptance criteria:**
- DOMPurify instantiated with above configuration in a shared utility.
- Output is TrustedHTML; direct string assignment to innerHTML blocked by CSP.
- All forbidden tags and attributes stripped from any input.
- Allowed tags and attributes preserved.
- Configuration is centralized -- all UGC rendering paths use the same DOMPurify instance.

**Testing:**
- Unit: each allowed tag passes through.
- Unit: each forbidden tag is stripped.
- Unit: event-handler attributes stripped.
- Unit: output is TrustedHTML type.
- Unit: javascript: URLs in href stripped.

---

### WS-G.4.2b Defense-in-depth pipeline
**Ref:** Section 25

The full UGC rendering pipeline: raw user text -> Markdown-lite AST (WS-G.4.1) -> HTML string -> DOMPurify sanitization (WS-G.4.2a) -> TrustedHTML -> React render. The chain must never break -- no path should bypass any stage.

Implementation:
- Single rendering function `renderUGC(markdown: string): TrustedHTML` that chains all stages.
- No direct `dangerouslySetInnerHTML` usage outside this function.
- Biome lint rule to flag `dangerouslySetInnerHTML` usage not through `renderUGC`.
- CSP `trusted-types` directive ensures only the DOMPurify policy can create TrustedHTML.
- Server-side: store raw markdown only; never store pre-rendered HTML.

**Acceptance criteria:**
- All UGC rendering goes through `renderUGC` pipeline.
- No bypass paths exist -- Biome lint catches direct dangerouslySetInnerHTML.
- CSP trusted-types directive active; violations logged to reporting endpoint.
- Server stores raw markdown; rendering happens client-side through the pipeline.
- Pipeline handles empty input, null input, and extremely long input (> 50KB) gracefully.

**Testing:**
- Integration: end-to-end rendering from raw markdown to DOM, verify no forbidden elements present.
- Unit: lint rule catches bypass attempts.
- E2E: CSP violation triggered by attempted bypass (mock test).
- Unit: edge cases -- empty, null, oversized input.

---

### WS-G.4.2c Wallet-drainer link detection
**Ref:** Section 25

Detect and interstitial suspicious contract interaction URLs that could drain connected wallets. These are URLs that, when visited, prompt wallet approval for malicious transactions.

Implementation:
- Pattern matching for suspicious URLs: known drainer domains (maintained blocklist), URLs with `approve`, `setApprovalForAll`, `permit`, `transferFrom` in path/query parameters, URLs mimicking popular dApp interfaces.
- Interstitial warning page: "This link may interact with your wallet. Verify the URL and contract before proceeding." with options to continue or go back.
- Blocklist source: community-maintained list (e.g., chainpatrol) updated regularly.
- All external links in UGC pass through link safety check before navigation.

**Acceptance criteria:**
- Known drainer domain URLs trigger interstitial warning.
- URLs with suspicious contract interaction patterns trigger interstitial warning.
- Interstitial displays the full URL for user inspection.
- User can choose to proceed or go back; choice is not logged beyond the safety check.
- Blocklist is updatable without app deployment (fetched from configuration endpoint).
- Normal URLs (news sites, Wikipedia, etc.) pass through without interstitial.

**Testing:**
- Unit: pattern matching against known drainer URL patterns.
- Unit: normal URLs do not trigger false positives.
- E2E: clicking a drainer URL shows interstitial; clicking safe URL does not.
- Integration: blocklist update propagates to detection.

---

### WS-G.4.2d XSS vector testing
**Ref:** Section 25, OWASP XSS Prevention Cheat Sheet

Comprehensive XSS test suite against all UGC rendering paths, based on the OWASP XSS cheat-sheet vectors.

Implementation:
- Test suite in `packages/shared/src/__tests__/xss-vectors.test.ts`.
- OWASP XSS cheat-sheet vectors as test fixtures: script injection, event handler injection, URL scheme injection, CSS injection, SVG injection, MathML injection, encoding tricks (HTML entities, unicode, percent-encoding, mixed case), mutation XSS, DOM clobbering.
- Every vector run through the full `renderUGC` pipeline.
- Every vector verified to produce safe output (no script execution, no event handlers, no dangerous URLs).
- Test suite runs in CI on every commit.

**Acceptance criteria:**
- All OWASP XSS cheat-sheet vectors covered (minimum 50 vectors).
- Every vector produces safe output through the rendering pipeline.
- No vector results in executable JavaScript in the rendered DOM.
- Test suite is a CI gate -- failure blocks merge.
- Test fixture file is maintained and updated when new vectors are published.

**Testing:**
- Unit (Vitest): each XSS vector as a parameterized test case.
- Visual: spot-check rendered output for a subset of vectors.
- CI: test suite runs on every PR and blocks merge on failure.

---

## Dependency Summary

| Task | Depends on |
|---|---|
| WS-G.1.1 | WS-F.1 (story schema for story_id FK) |
| WS-G.1.2a | WS-G.1.1, WS-D.1 (user schema for user_id FK) |
| WS-G.1.2b | WS-G.1.2a |
| WS-G.1.2c | WS-G.1.2b |
| WS-G.1.2d | WS-G.1.2a |
| WS-G.1.3 | WS-G.1.2a, WS-F.1 (claims schema) |
| WS-G.2.1 | WS-D.1 (user schema for created_by FK) |
| WS-G.2.2 | WS-G.2.1 |
| WS-G.2.3a | WS-G.2.1 |
| WS-G.2.3b | WS-G.2.1, WS-G.2.2 |
| WS-G.2.3c | WS-G.2.1 |
| WS-G.2.3d | WS-G.2.1 |
| WS-G.3.1 | WS-G.1.2c (zod schemas) |
| WS-G.3.2 | WS-G.1.3 |
| WS-G.3.3 | WS-G.1.2d (tree queries) |
| WS-G.3.4a | WS-B.2 (design system components) |
| WS-G.3.4b | WS-G.3.4a |
| WS-G.3.4c | WS-G.3.4a, WS-A (moderation taxonomy) |
| WS-G.3.5a | WS-G.3.4a, WS-G.1.3 |
| WS-G.3.5b | WS-G.3.4a |
| WS-G.3.5c | WS-G.3.4a |
| WS-G.3.6a | WS-G.3.4a |
| WS-G.3.6b | WS-G.3.4a |
| WS-G.3.6c | WS-G.3.4a |
| WS-G.3.7a | WS-C.2 (PWA manifest) |
| WS-G.3.7b | WS-G.3.1 |
| WS-G.3.7c | WS-C.2 (IndexedDB/offline) |
| WS-G.3.7d | WS-G.3.4a |
| WS-G.4.1 | WS-0 (build tooling) |
| WS-G.4.2a | WS-G.4.1, WS-0.5.1 (CSP/Trusted Types) |
| WS-G.4.2b | WS-G.4.2a |
| WS-G.4.2c | WS-G.4.2a |
| WS-G.4.2d | WS-G.4.2b |

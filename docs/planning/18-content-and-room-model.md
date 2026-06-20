# WS-Q: Content–Room Ownership and Visibility

**Milestone:** M3 (remodel of shipped M1–M3 surfaces) | **Priority:** P1 | **Dependencies:** WS-F (ingestion), WS-G (forum/rooms), WS-I (ranking) — all complete; WS-E (topic registry) for the new event topic | **Wave:** 9 (first post-WS-I workstream; lands before WS-J takes queue ownership) | **Estimated duration:** 4-5 weeks | **Task count:** 60 atomic cards

---

## Overview

WS-Q implements the SPEC v0.7 structural model (Sections 3.4, 14.1, 14.5, 16.1–16.2, 21.3, 22.1, 23.2):

    Room  ⊃  Content (story)  ⊃  Thread  ⊃  Contributions

1. **Rooms own content.** Every content item — link story, original brief, **image post**, **video post**, question, evidence card, local update, live thread — is posted in exactly one **home room**, chosen at submission. There is no room-less content. Today stories are global and reach rooms only through the thread's nullable `room_id`; WS-Q makes `Story.room_id` authoritative and NOT NULL, with `Thread.room_id` denormalized from it.
2. **Content owns conversation.** Already structurally true (one thread shell per story, WS-F.1); WS-Q ties the thread's room to the owning story and documents the ownership contract.
3. **Two-tier visibility.** Room visibility becomes **binary** (`public | private`), replacing the conflated three-value `public | restricted | expert_led` enum; the old values' membership and posting semantics move to two new orthogonal axes, `join_model` and `posting_policy`. Content visibility is `public | room_only`, derived per SPEC Section 14.5 by ONE shared helper: a private room **forces** `room_only`; a public room lets the author choose, defaulting to `public`.
4. **The front page is the public tier's showcase.** Global surfaces (front page, `?topic=`, global search, cross-room recommendation) serve only `public` content from public rooms; room surfaces serve the room's full pool to users who pass the room read bar. WS-I already enforces the room read bar on the distribution side (`filterByRoomVisibility` over `roomContentVisibleToUser`); WS-Q extends that bar to item-level visibility and adds the containment test suite.
5. **Native media content.** Image and video posts ride the WS-G.4.4 upload pipeline (content-type allowlist, byte-level metadata stripping, scan gate, required alt text), extended with video containers.

The behavior-preserving migration maps existing data onto the new model: `restricted` rooms → `private` + `request_approval`; `expert_led` rooms → `private` + `request_approval` + `experts_and_stewards` (preserving their current read gating exactly); `public` rooms stay public with `open` join; stories backfill `room_id` from their thread's room, or into the system **Commons** room when no room exists; stories in private rooms backfill `visibility = room_only`, all others `public`. Net effect for existing data: nothing becomes more visible, and nothing publicly visible disappears.

### Verified integration points (current code)

These are the exact files/symbols WS-Q touches; they are confirmed against the shipped tree so each card is actionable without rediscovery.

| Concern | Symbol / file | WS-Q change |
|---|---|---|
| Room enum (wire) | `roomVisibilitySchema` / `packages/shared/src/schemas/room.ts` | `public\|restricted\|expert_led` → `public\|private` + `join_model` + `posting_policy` |
| Room enum (storage) | `roomVisibilityEnum` / `packages/db/src/schema/room.ts` | enum recreation + two columns + CHECKs |
| Submission types | `SUBMISSION_TYPES` / `packages/shared/src/schemas/events/content.ts` (+ `submissionTypeEnum` DB mirror) | append `image_post`, `video_post` |
| Story create payload | `storyCreateBaseShape` / `packages/shared/src/schemas/story.ts` | add `room_id` (required) + `visibility` in ONE place (all branches inherit) |
| Story read projection | `storyPublicSchema` / same | add `room_id` + `visibility` |
| Story entity | `stories` / `packages/db/src/schema/story.ts` | add `room_id`, `visibility`, `media_upload_ref`, `canonical_public_story_id` |
| Content events | `contentShape` / `events/content.ts` | add `room_id` + `visibility` (covers `content.submitted` + `content.normalized`) |
| Event registry | `CORE_EVENT_SCHEMAS` / `licioEventSchema` / `TOPIC_REGISTRY` / `events/registry.ts` | register `content.visibility.changed` (core 14 → 15) |
| Audit taxonomy | `AUDIT_EVENT_TYPES` / `packages/shared/src/schemas/audit.ts` | add `story_visibility_change`, `room_visibility_change` (governance writes keep `forum_config_change`) |
| Upload scan gate | `uploadScanStateEnum` (`pending\|clear\|flagged`) + `UploadScanner` / `apps/api/src/forum/safety.ts`; CHECK in `packages/db/src/schema/upload.ts` | extend content-type allowlist with video; reuse the scan gate |
| Room read bar | `roomVisibleToUser` (tier one) + `roomContentVisibleToUser` (tier two) + `joinRoom` / `apps/api/src/forum/rooms.ts` | retarget to binary + add `userMayPostTopLevel` + `join_model` rewrite |
| Submission guard chain | `apps/api/src/ingestion/submission.ts` | room/membership/posting guards + visibility derivation |
| Dedup | `signatureStory` / `findNearDuplicates` / `classifyDuplicate` / `apps/api/src/ingestion/dedup.ts` | tier-scope exact-URL + near-dup |
| Search | `SearchIndex` / `apps/api/src/ingestion/search.ts` (+ Drizzle FTS adapter) | tier predicate + room scoping |
| Distribution gate | `filterByRoomVisibility` / `apps/api/src/ranking/service.ts` | rename `filterByVisibility`; add surface-aware item-tier clause |
| Candidate boundary | `Candidate` / `packages/ranking/src/schemas/candidate.ts` | add `visibility` |
| Retrievers | eight organic retrievers + `RoomSurfaceRetriever` / `apps/api/src/ranking/retrievers.ts` | public predicate on the eight; room pool on the scoper |
| Neutrality gate | `apps/api/src/__tests__/ranking-neutrality.test.ts` (`pnpm check:neutrality`) | add the containment leg |

### Migration strategy (expand → backfill → contract, online-safe)

Schema change follows the **expand/contract** pattern so the running system is never blocked by a long lock and so a half-applied chain is always forward-recoverable. Migration numbers continue the chain after the shipped `0013`:

| # | Card | Phase | Online-safety note |
|---|---|---|---|
| `0014` | WS-Q.1.2 | rooms: enum recreate + columns + CHECKs + backfill | one txn; rooms table is small (bounded by room count) so the rewrite is cheap |
| `0015` | WS-Q.1.4a | stories: ADD nullable `room_id`/`visibility`(default `public`)/`media_upload_ref`/`canonical_public_story_id`; append enum values; Commons seed | additive + defaulted; no rewrite of existing rows' data; `ADD VALUE` is non-locking |
| *(deploy)* | WS-Q.2.1c + 1.4a | deploy the dual-write serving code (every insert path writes `room_id`/`visibility`) | required BETWEEN `0015` and `0016` — see "Deploy ordering" below |
| `0016` | WS-Q.1.4b | stories: BACKFILL `room_id`/`visibility` in batches, then `SET NOT NULL` | batched UPDATE (keyset by `created_at`); NOT NULL only after the dual-write deploy AND the backfill complete |
| `0017` | WS-Q.1.4c | stories: drop global URL unique; add the two partial unique indexes | `CREATE INDEX CONCURRENTLY` (outside a txn) to avoid write locks |
| `0018` | WS-Q.1.5 | threads: backfill `room_id`, `SET NOT NULL`, consistency trigger | batched backfill before NOT NULL/trigger |
| `0019` | WS-Q.1.7b | audit enum: `ADD VALUE` the two new audit types | non-locking enum extension |
| `0020` | WS-Q.2.3c | uploads: extend content-type CHECK with video containers | drop+add CHECK NOT VALID then VALIDATE to avoid a full-table lock |

Every migration ships an idempotent down path; where a down path is lossy (e.g. rooms created with `invite` after `0014`) the card documents it explicitly. Each gated integration test runs the REAL chain in CI's Postgres service container (the WS-D…WS-I precedent).

**Deploy ordering (expand → dual-write → contract).** The `NOT NULL` and uniqueness contracts are NOT applied in the same window as the additive expand, because the currently-shipped insert paths do not write `stories.room_id` (`apps/api/src/ingestion/drizzle-ingestion-stores.ts` story insert) and the in-memory thread shell still sets `roomId: null` (`apps/api/src/ingestion/stores.ts`). If `0016`'s `SET NOT NULL` ran while an old API instance is still live, that instance's NULL-`room_id` inserts would fail (or, before NOT NULL, would re-introduce NULL rows the backfill just cleared). The required order is therefore: (1) ship `0015` (additive, nullable — old code keeps working); (2) **deploy the dual-write serving code** — WS-Q.2.1c plus the store-level insert paths above, every one of which now writes `room_id`/`visibility` (private/old submissions default to the Commons room and `deriveStoryVisibility`); (3) once no old instance remains, run `0016` (batched backfill, then `SET NOT NULL`) and `0017`/`0018`. WS-Q.2.1c updates those store insert paths (`drizzle-ingestion-stores.ts` story insert; the in-memory `stores.ts` thread shell) so the dual-write deploy is real, and WS-Q.6.2's rollout plan gates `0016` on that deploy being live everywhere.

**Transient-default safety.** `0015` adds `stories.visibility` as `NOT NULL DEFAULT 'public'`, so between `0015` and the `0016` backfill an existing private-room story is briefly stamped `public` at rest. This is never a live over-exposure window because the runtime distribution gate (WS-Q.4.2a) and read bar (WS-Q.3.2) — deployed with the dual-write code, before `0016` — re-derive containment from `room.visibility` at serve time, so even a `public`-stamped row in a private room is dropped from every global surface and gated on reads. The migration harness (WS-Q.6.1) asserts the post-`0016` end state, not the transient.

### Conventions for this workstream

- **Fail-closed visibility.** Wherever visibility cannot be established (unknown room, unreadable row, missing flag), the item is EXCLUDED from the surface. Unknown ⇒ private. This mirrors the WS-I safety-filter posture.
- **404-over-403.** Private-room content reads return 404 to outsiders and pending applicants, never 403 (WS-D.1.6a house rule). Tier one (room existence) is the only thing a non-member can see.
- **One derivation, one bar.** `deriveStoryVisibility` (visibility forcing) and `storyReadableByUser` (item read bar) each live in exactly one place; every server and client path calls the shared function — no re-implementation, no drift.
- **No contribution-level visibility.** Contributions inherit reach from their thread's story and room; there is no per-contribution visibility flag.
- **No-applause invariant.** No task introduces likes, votes, karma, reactions, or follower mechanics; "popular" on the front page means PWAtt-ranked participation-weighted attention under the Section 13 constraints, computed exactly as today.
- **Identity-free privacy (Section 19.1).** No task reads or stores IP addresses or geolocation. Visibility checks key on account membership only.
- **Private ≠ secret.** Every private-room surface states the SPEC Section 14.5.7 honest limits: distribution-bounded, not end-to-end encrypted, reachable by moderation and legal process. No task may describe private rooms as "encrypted" or "secret".
- **Forward-compat — WS-S terminology.** WS-Q ships binary *server* visibility as `public | private`. The post-M3 E2EE extension **WS-S** (`docs/planning/19-decentralized-data-plane.md`, §20.1) adds a third room class `private_p2p` ("Private P2P room"), **renames** this workstream's server-hosted "private room" to "**members-only server room**", and reserves the unqualified word "private" for `private_p2p`. The "Private ≠ secret" invariant above stays true and unchanged for server-hosted rooms — the rename is a labelling correction (the storage/authority model does not change), and "not encrypted" is precisely the honest limit that separates a members-only server room from a `private_p2p` room. No WS-Q card is rewritten by this note.
- **Tier-scoped dedup canon (Section 14.5.6).** Public tier: at most one public story per canonical URL (global). Room tier: at most one `room_only` story per `(canonical_url, room_id)`. An in-room item never blocks a public submission; cross-tier pairs link.
- **Schema canon.** `Room.visibility ∈ {public, private}`; `Room.join_model ∈ {open, request_approval, invite}`; `Room.posting_policy ∈ {all_members, experts_and_stewards}`; `Story.visibility ∈ {public, room_only}`; `Story.room_id` NOT NULL FK; `Story.media_upload_ref` nullable FK to `uploads`; `Story.canonical_public_story_id` nullable self-FK. New submission types: `image_post`, `video_post`. New event topic: `content.visibility.changed`. New audit types: `story_visibility_change`, `room_visibility_change`.
- **Forward-compat — WS-S axes + WS-R ingress.** WS-S extends this same room schema with three **orthogonal** axes — `storage_mode ∈ {server, p2p}`, `authority_model ∈ {platform, room_keys}`, `directory_mode ∈ {listed, unlisted, detached}` — via an additive expand migration continuing the chain after `0020` and reusing this workstream's `join_model` column (`p2p ⇒ join_model = invite`); existing rooms stay `server`/`platform` (WS-S §23.2). WS-R (LCAP, `docs/planning/19-decentralized-data-plane.md`) is an **alternate signed ingress/egress** whose reconciled records land in this exact canonical room/visibility state — `mapLcapVisibilityToStory` is total over `public | in_room | private` and round-trips `in_room ↔ room_only` against `Story.visibility`. Both extensions are additive and non-breaking to WS-Q's shipped model.
- **Financial denylist unchanged.** No new table or column may carry a financial field (WS-F.2.5b assertion + the wallet↔ranking BFS proof re-run in CI on the modified schemas).
- **Monorepo atomicity.** Wire-shape changes land in `@licio/shared` first; both sides consume the same schemas. Offline caches bump their record-schema version so stale cached shapes are evicted, never mis-parsed.
- **Task sizing (Section 30.8).** Every card below is one deliverable — one schema, one helper, one migration phase, one guard, one endpoint, one client state — reviewable, testable, and reversible in ≤ 1-3 engineering days. Sub-area headers group cards; the dependency graph at the end fixes their order.

---

## WS-Q.1 Shared schemas, storage, and migrations

### WS-Q.1.1a Shared room schema: binary visibility + join model + posting policy
**ID:** WS-Q.1.1a | **Ref:** Sections 16.1, 16.2, 22.1

**Description:** In `packages/shared/src/schemas/room.ts` replace `ROOM_VISIBILITIES = ['public','restricted','expert_led']` with `['public','private']`; add `ROOM_JOIN_MODELS = ['open','request_approval','invite']` and `ROOM_POSTING_POLICIES = ['all_members','experts_and_stewards']` with their `z.enum` schemas and inferred types. Extend `roomSummarySchema`/`roomDetailSchema` with `join_model` and `posting_policy`; extend `roomCreateRequestSchema` (all six type branches) with optional `join_model`/`posting_policy` and a `superRefine` enforcing coherence: `public` ⇒ `join_model = open` only (reject `request_approval`/`invite`); steward rooms ⇒ `private`. Defaults are applied by the route/service layer (WS-Q.3.3a), not the schema, so the schema stays a pure validator.

**Acceptance criteria:**
- `roomVisibilitySchema` accepts exactly `public|private`; the three legacy values fail parsing.
- `join_model`/`posting_policy` appear on every room wire projection and the create request.
- Coherence refinement rejects `public`+`request_approval`, `public`+`invite`, and public steward rooms; accepts every legal combination.
- No applause/financial field appears on any room shape (existing denylist tests stay green).

**Testing:** Unit — parse/reject matrix over visibility × join_model × posting_policy; updated room-schema tests; `expectTypeOf` for the new fields.

**Dependencies:** none (shared leaf). Blocks all room-touching WS-Q cards.

---

### WS-Q.1.1b `mapLegacyRoomVisibility` migration helper
**ID:** WS-Q.1.1b | **Ref:** Section 16.1

**Description:** Export a pure total helper `mapLegacyRoomVisibility(v: 'public'|'restricted'|'expert_led'): { visibility: RoomVisibility; join_model: RoomJoinModel; posting_policy: RoomPostingPolicy }` — `public → {public, open, all_members}`, `restricted → {private, request_approval, all_members}`, `expert_led → {private, request_approval, experts_and_stewards}`. This is the single SSOT the SQL backfill (WS-Q.1.2) mirrors and any compatibility shim reuses.

**Acceptance criteria:**
- Total over the three legacy values; exhaustive `switch` with a `never` default.
- Property test: neither legacy non-public value ever maps to `public` (no read-access widening).

**Testing:** Unit — three-row table test; the no-widening property.

**Dependencies:** WS-Q.1.1a.

---

### WS-Q.1.2 DB room schema + migration 0014 (enum recreate + axes + backfill)
**ID:** WS-Q.1.2 | **Ref:** Sections 16.1, 16.2, 22.1

**Description:** In `packages/db/src/schema/room.ts` recreate `roomVisibilityEnum` as `('public','private')`; add `joinModelEnum`, `postingPolicyEnum`, and the `join_model`/`posting_policy` NOT NULL columns; add CHECKs `(visibility = 'private' OR join_model = 'open')` and `(room_type <> 'steward' OR visibility = 'private')`. Migration `0014` (one txn, following the 0008 enum-recreation precedent) must derive the new axes **from the legacy value BEFORE that value is collapsed**, in this exact order: (1) add `join_model`/`posting_policy` as nullable; (2) backfill them from the still-present three-value `visibility` per `mapLegacyRoomVisibility` (`public→open/all_members`, `restricted→request_approval/all_members`, `expert_led→request_approval/experts_and_stewards`) — this is the only step that can still distinguish `expert_led`, so it MUST precede the enum change; (3) only then recreate the enum and `ALTER COLUMN visibility ... USING` map (`restricted→private`, `expert_led→private`); (4) set the two columns NOT NULL and add the CHECKs. Reordering — collapsing the enum first — would erase the `expert_led` distinction and silently widen those rooms' top-level posting to `all_members`; the row-order above prevents that. The rooms table is bounded by room count, so the rewrite is cheap and a single txn is safe.

**Acceptance criteria:**
- Migration is green on a DB seeded with all three legacy values; the mapped triples are asserted row-by-row.
- CHECKs reject `public`+`request_approval`/`invite` and public steward rooms.
- Down migration restores the legacy enum (`private`+`all_members`→`restricted`; `private`+`experts_and_stewards`→`expert_led`), documented lossy only for post-migration `invite` rooms.
- The DB enums mirror the shared enums exactly (storage-layer defense in depth).

**Testing:** Gated integration (Postgres) — real chain, seeded legacy rows, CHECK-violation cases. Unit — DB-enum ≡ shared-enum mirror test.

**Dependencies:** WS-Q.1.1a, WS-Q.1.1b.

---

### WS-Q.1.3a Story submission schema: home room + visibility
**ID:** WS-Q.1.3a | **Ref:** Sections 14.1, 14.5, 22.1, 23.2

**Description:** In `packages/shared/src/schemas/story.ts` add `storyVisibilitySchema = z.enum(['public','room_only'])`. Add `room_id: uuidSchema` (**required**) and `visibility: storyVisibilitySchema.optional()` to `storyCreateBaseShape` — ONE insertion point that every one of the six discriminated-union branches inherits through `.extend()`. Add `room_id` + `visibility` to `storyPublicSchema` and `storyCreateResponseSchema`. (Derivation is WS-Q.1.3b; media branches are WS-Q.1.3c.)

**Acceptance criteria:**
- Every branch's create payload requires `room_id`; omission yields a per-field error naming `room_id`.
- `visibility` is optional on input (server derives it) and present on the read projection/response.
- `.strict()` still rejects unknown keys on every branch.

**Testing:** Unit — required-`room_id` rejection on each of the six branches; projection round-trip with the new fields.

**Dependencies:** WS-Q.1.1a (visibility values share the room vocabulary review).

---

### WS-Q.1.3b `deriveStoryVisibility` helper
**ID:** WS-Q.1.3b | **Ref:** Section 14.5

**Description:** Export the pure helper `deriveStoryVisibility(roomVisibility: RoomVisibility, requested?: StoryVisibility): StoryVisibility` implementing Section 14.5 exactly: `private` room ⇒ always `room_only` (forcing, never an error); `public` room ⇒ `requested ?? 'public'`. This is the ONLY place the rule lives; server guard (WS-Q.2.1c) and client composer (WS-Q.5.1b) both call it.

**Acceptance criteria:**
- `deriveStoryVisibility('private', 'public') === 'room_only'`; `deriveStoryVisibility('public', undefined) === 'public'`; `deriveStoryVisibility('public','room_only') === 'room_only'`.
- No throw path — forcing is silent (callers may compare requested vs derived to emit a metric).

**Testing:** Unit — full 2×3 (room-visibility × requested∈{public,room_only,undefined}) truth table.

**Dependencies:** WS-Q.1.1a, WS-Q.1.3a.

---

### WS-Q.1.3c Media submission types: `image_post` and `video_post`
**ID:** WS-Q.1.3c | **Ref:** Sections 14.1, 14.2, 15.5

**Description:** Append `image_post`, `video_post` to `SUBMISSION_TYPES` in `events/content.ts` (the SSOT `submissionTypeSchema` and the DB `submissionTypeEnum` mirror both extend; existing values keep their order). Add two zod metadata branches to `submissionMetadataSchema`/`storyCreateRequestSchema`: `image_post` (`upload_id` uuid required; `alt_text` 1–1,000 chars required; no `canonical_url`) and `video_post` (`upload_id` required; exactly one of `captions_text` ≤ 20,000 or `captions_upload_id`; no `canonical_url`). Both inherit `room_id`/`visibility` from the base shape. Both are exempt from URL normalization and crawling (`extraction_state = not_applicable`, `media_type ∈ {image,video}`).

**Acceptance criteria:**
- `image_post` without `alt_text` fails (alt text is required for image content — WCAG).
- `video_post` rejects both-captions or neither beyond the allowed (text XOR upload, both optional-but-not-both).
- Both require `room_id`; the union still rejects unknown `submission_type`.
- The DB `submissionTypeEnum` `ADD VALUE`s are appended (handled in 0015, WS-Q.1.4a).

**Testing:** Unit — valid/invalid payloads per branch (missing alt text, both caption fields); type-inference assertions.

**Dependencies:** WS-Q.1.3a.

---

### WS-Q.1.4a Stories schema + migration 0015 (EXPAND: additive columns + Commons seed)
**ID:** WS-Q.1.4a | **Ref:** Sections 14.5, 22.1

**Description:** In `packages/db/src/schema/story.ts` add: `roomId` uuid FK→`rooms` (nullable for now), `visibility` (new `storyVisibilityEnum('public','room_only')`, NOT NULL DEFAULT `'public'`), `mediaUploadRef` uuid FK→`uploads` (nullable), `canonicalPublicStoryId` uuid self-FK (nullable, ON DELETE SET NULL); append `image_post`,`video_post` to `submissionTypeEnum`; add btree indexes `(room_id, created_at)` and `(visibility, lifecycle_state)`. Migration `0015` is purely additive (nullable/defaulted columns, non-locking `ADD VALUE`) and seeds the **Commons** room with a pinned UUID `ON CONFLICT DO NOTHING` so WS-Q.1.4b's backfill can target it deterministically in the same chain.

**Acceptance criteria:**
- All columns/indexes/enum values added; no existing row is rewritten (defaults are metadata-only in PG ≥ 11).
- Commons row exists with the pinned id after 0015; re-running 0015 is a no-op.
- Down migration drops the additive columns/indexes; the appended enum values are documented as non-removable (PG limitation) and left in place.

**Testing:** Gated integration — additive apply + Commons idempotency. Unit — DB schema mirror for the new enum/columns.

**Dependencies:** WS-Q.1.3a, WS-Q.1.3c, WS-Q.1.2 (rooms exist for the FK).

---

### WS-Q.1.4b Stories migration 0016 (BACKFILL room + visibility, then NOT NULL)
**ID:** WS-Q.1.4b | **Ref:** Section 14.5

**Description:** Migration `0016` backfills in batches (keyset by `created_at`, bounded statement timeout): `room_id` from the story's branch-0 thread's `room_id` where present, else the Commons id; `visibility = 'room_only'` for every story whose (post-0014) home room is `private`, else leave `'public'`. After the backfill completes, `ALTER COLUMN room_id SET NOT NULL`. The batched shape avoids a single long-locking UPDATE on a large table.

**Acceptance criteria:**
- `count(*) FROM stories WHERE room_id IS NULL` = 0 after the migration.
- A story whose thread pointed at a legacy `restricted`/`expert_led` room ends `room_only`; thread-roomed public-room stories and previously room-less stories end `public` (no item gains reach; no public item disappears).
- Re-running 0016 is idempotent (already-backfilled rows are skipped).
- Down migration drops NOT NULL (data backfill is not reverted — documented).

**Online-rollout guard:** `0016` runs ONLY after the WS-Q.2.1c dual-write deploy is live on every API instance (see "Deploy ordering"). Until then, an old instance could insert a NULL `room_id` and either fail the new constraint or re-introduce a NULL row after the backfill; the deploy gate (WS-Q.6.2) closes that window. The backfill is re-runnable, so a late straggler row is caught by re-running the batch before `SET NOT NULL`.

**Testing:** Gated integration — every backfill branch on seeded data; a NULL-insert-during-window simulation proving `SET NOT NULL` is reached only after dual-write; the monotonic-visibility property (asserted fully in WS-Q.6.1).

**Dependencies:** WS-Q.1.4a, WS-Q.2.1c (dual-write must deploy first), WS-Q.1.6 (Commons app-ensure is parallel; the seed row is created in 0015).

---

### WS-Q.1.4c Stories migration 0017 (tier-scoped uniqueness)
**ID:** WS-Q.1.4c | **Ref:** Section 14.5.6

**Description:** Migration `0017` replaces the global canonical-URL partial unique index with the tier-scoped pair, created `CONCURRENTLY` (outside a txn) to avoid blocking writes: `UNIQUE (canonical_url) WHERE canonical_url IS NOT NULL AND visibility = 'public' AND hidden_state IS NULL` and `UNIQUE (canonical_url, room_id) WHERE canonical_url IS NOT NULL AND visibility = 'room_only' AND hidden_state IS NULL`. Drop the old global index after the new public index is valid.

**Takedown-bypass guard (regression vs. the shipped global index).** The old index covered ALL non-null URLs, so a taken-down/safety-hidden URL stayed blocked from re-submission. The `hidden_state IS NULL` predicate above is required (a hidden row must not occupy the live unique slot) but, on its own, would let the same URL be re-submitted as a fresh public or room-only story — bypassing the takedown. To preserve the takedown decision, the **submission guard (WS-Q.2.2a) consults a canonical-URL takedown/tombstone denylist** on every insert path: a URL whose prior story was removed by takedown (not merely author-narrowed) is rejected at submission regardless of tier. The denylist keys on the normalized canonical URL and is written by the takedown actioning path (WS-Q.2.6); it is the companion the partial index requires.

**Acceptance criteria:**
- Two public stories with one canonical URL are impossible; the same URL may exist `room_only` in two rooms; a `room_only` row never blocks a public insert.
- A URL taken down on a prior story is rejected on re-submission in BOTH tiers (the denylist check), proving no takedown bypass via the `hidden_state` predicate.
- Index creation does not hold a write lock (CONCURRENTLY; migration marked non-transactional).
- Down migration restores the global unique index (valid only when no tier-duplicate URLs exist — documented).

**Testing:** Gated integration — concurrent public-insert race (exactly one wins, the rest 409 at the service layer, WS-Q.2.2a); same-URL-different-rooms both succeed; re-submitting a taken-down URL is rejected in both tiers.

**Dependencies:** WS-Q.1.4b. Soft: WS-Q.2.6 (takedown writes the denylist).

---

### WS-Q.1.5 Threads: room NOT NULL + consistency trigger (migration 0018) + schema sweep
**ID:** WS-Q.1.5 | **Ref:** Sections 3.4, 22.1

**Description:** Migration `0018` backfills `threads.room_id` from the owning story's `room_id` (batched), sets it NOT NULL, and adds a trigger rejecting any INSERT/UPDATE where `threads.room_id <> stories.room_id` (a programming-error guard; story room moves are out of v1 scope and documented). Update `threadSummarySchema.room_id` from nullable to required in `@licio/shared`, then sweep the dead room-less branches (e.g. the WS-I retrievers' `thread?.roomId ?? null`); typecheck proves the nullable type is gone.

**Acceptance criteria:**
- No nullable-room thread remains; the wire schema requires `room_id`.
- The trigger rejects divergent thread/story rooms with a typed integrity error.
- All `?? null` room-less call sites are removed; `pnpm typecheck` passes with the non-null type.

**Testing:** Gated integration — backfill + trigger rejection. Unit — updated thread schema parse; retriever tests with non-null rooms.

**Dependencies:** WS-Q.1.4b.

---

### WS-Q.1.6 Commons room app-ensure, reserved slug, demo data
**ID:** WS-Q.1.6 | **Ref:** Sections 3.4, 14.5

**Description:** Add a boot-time idempotent `ensureCommonsRoom` (mirroring the demo-seed pattern) so in-memory stores (tests/demo) expose the same Commons the 0015 seed creates in Postgres; reserve the `commons` slug in room-creation validation; update `apps/api/src/lib/demo-data.ts`/`demo-seed.ts` so every demo story has a home room (stable demo room ids), demo rooms carry the new axes, and at least one demo **private** room with `room_only` content exists to exercise every gated path.

**Acceptance criteria:**
- Boot on an empty in-memory store yields exactly one Commons with the pinned id; running boot twice is a no-op.
- User room creation rejects the reserved `commons` slug.
- Demo seed produces ≥ 1 public room (public + `room_only` stories), ≥ 1 private room (forced `room_only`), and the Commons.

**Testing:** Unit — boot idempotency; reserved-slug rejection; demo-seed shape assertions.

**Dependencies:** WS-Q.1.2 (room columns), WS-Q.1.4a (Commons seed/pinned id).

---

### WS-Q.1.7a `content.visibility.changed` event + registry wiring
**ID:** WS-Q.1.7a | **Ref:** Sections 14.5, 21.3, 22.4

**Description:** Add `contentVisibilityChangedEventSchema` (payload: `story_id`, `room_id`, `from`/`to ∈ {public,room_only}`, `trigger ∈ {author,room_visibility_change,migration}`, `actor_ref?`; `privacy_classification: 'public'`, retention `operational`/non-Knomosis envelope). Register it in `events/registry.ts`: add to `CORE_EVENT_SCHEMAS` (14→15), the `licioEventSchema` discriminated union, and `TOPIC_REGISTRY` (`entry(schema,'public',<tier>,false)`). Update the registry count-pinning tests (14→15 core).

**Acceptance criteria:**
- The union parses the new topic and still rejects unknown `event_type`/extra keys.
- `CORE_TOPICS.length === 15`; the count tests are updated in the same commit.
- The topic carries no attention values and no financial fields; the pay-to-rank firewall test covers it trivially.

**Testing:** Unit — schema parse/reject; registry count; envelope round-trip; firewall classification.

**Dependencies:** WS-Q.1.3a (visibility values).

---

### WS-Q.1.7b Audit taxonomy + migration 0019
**ID:** WS-Q.1.7b | **Ref:** Sections 14.5, 16.1

**Description:** Add `story_visibility_change` and `room_visibility_change` to shared `AUDIT_EVENT_TYPES` (`packages/shared/src/schemas/audit.ts`); migration `0019` `ADD VALUE`s them to the DB audit-event enum (non-locking; the 0013 audit-enum-extension precedent). Governance setting writes continue to use the existing `forum_config_change` type — only visibility transitions use the two new types.

**Acceptance criteria:**
- The two new audit types parse; the enum extension is additive (no rewrite).
- A test asserts governance writes still emit `forum_config_change`, not a new type.

**Testing:** Unit — audit-type parse. Gated integration — audit enum `ADD VALUE`.

**Dependencies:** WS-Q.1.7a.

---

### WS-Q.1.7c `content.submitted`/`content.normalized` gain room + visibility (classification tracks visibility)
**ID:** WS-Q.1.7c | **Ref:** Sections 14.5, 14.5.7, 21.3

**Description:** Add `room_id` and `visibility` to the content events AND make their privacy classification track the content's visibility — the two changes ship together. Today `contentShape` hardcodes `privacy_classification: z.literal('public')` / `retention_tier: z.literal('public_contribution')`, which assert "the author intends this public." For a `room_only` submission that assertion is FALSE: a `public`-classified `content.submitted` is consumable by generic public/scoring consumers, so naively adding `room_id`/`canonical_url`/`topics`/`submitted_by` would disclose in-room metadata past the room read bar. Therefore: a `public`-visibility submission keeps `privacy_classification: 'public'` / `public_contribution` (unchanged); a `room_only` submission emits with a non-public **in-room** classification (the restricted first-party tier) so the generic public consumers do not read it, while the visibility-aware internal consumers that legitimately need it (lifecycle init, search-index population scoped by visibility, ranking feature population that must EXCLUDE room_only from global) subscribe explicitly and honor the bar. Implementation choice (separate in-room classification on the existing union vs. a redacted public variant + a full in-room variant) is settled in this card's design step; the binding requirement is that **no in-room story's URL/topics/submitter ever flow to a consumer that treats the event as public.** Update the firewall/parse tests accordingly.

**Acceptance criteria:**
- A `room_only` submission's `content.submitted`/`content.normalized` is NOT classified `public`; a test proves a generic public-topic consumer never receives a `room_only` event's `canonical_url`/`topics`/`submitted_by`.
- A `public` submission's events are byte-compatible with today's shape (no regression for public content).
- The visibility-aware internal consumers (lifecycle, search, ranking feature population) receive the new fields and honor visibility; no consumer treats `visibility` as a behavioral signal.
- The pay-to-rank firewall test still passes (no financial field introduced).

**Testing:** Unit — content-event parse for both visibilities; the "public consumer never sees in-room metadata" assertion; consumer wiring smoke tests.

**Dependencies:** WS-Q.1.3a. Related: WS-E topic registry (classification/retention taxonomy) — if a new in-room first-party classification value is required, it is added here with the registry count/firewall tests updated.

---

## WS-Q.2 Ingestion and submission (WS-F deltas)

### WS-Q.2.1a Submission guard: room existence + read bar + active membership
**ID:** WS-Q.2.1a | **Ref:** Sections 14.1, 14.5, 16.1, 23.2

**Description:** In `apps/api/src/ingestion/submission.ts`, after auth and before the existing WS-F pre-checks, add the first guards: (1) the destination room exists (404 on unknown id — never confirm/deny beyond tier one); (2) the submitter passes `roomContentVisibleToUser` AND holds `active` membership. For public rooms, first submission auto-joins when the composer passed the consent flag (the user chose this room); for private rooms, a pending or absent applicant gets 404. The guard returns a typed outcome the route maps to status.

**Acceptance criteria:**
- Unknown/unreadable room ⇒ 404 (no tier-two leakage).
- Private-room outsider/pending ⇒ 404; active member/steward ⇒ passes.
- Public-room non-member with consent flag ⇒ auto-joined `active` then passes; without consent ⇒ a "join to post here" outcome.

**Testing:** Unit (service) — room-existence/membership matrix (outsider/pending/active/steward × public/private); auto-join consent path.

**Dependencies:** WS-Q.3.1a (`roomContentVisibleToUser` binary), WS-Q.3.1c (`joinRoom`).

---

### WS-Q.2.1b Submission guard: posting policy
**ID:** WS-Q.2.1b | **Ref:** Sections 14.1, 16.1, 16.2

**Description:** Add the posting-policy guard after membership: `userMayPostTopLevel(room, userId)` must hold for top-level story creation. `experts_and_stewards` rooms admit only steward-role holders or expert-lens assignees (the WS-G expert seam); a member who can read but not post gets a distinct in-room error ("posting here is steward/expert-led"), not a 404, since they already passed the content bar.

**Acceptance criteria:**
- `all_members` rooms admit any active member; `experts_and_stewards` rooms admit only stewards/experts.
- A read-capable member who cannot post gets the distinct in-room error, never a 404 (they can see the room) and never a generic 403.

**Testing:** Unit — posting-policy × role matrix; the member-can't-post error shape.

**Dependencies:** WS-Q.2.1a, WS-Q.3.1b (`userMayPostTopLevel`).

---

### WS-Q.2.1c Visibility derivation + transactional room-stamped insert
**ID:** WS-Q.2.1c | **Ref:** Sections 14.5, 22.1

**Description:** Compute `visibility = deriveStoryVisibility(room.visibility, payload.visibility)` (the shared helper). The transactional story+thread insert stamps `room_id` on both rows and `visibility` on the story (both-or-neither). Emit `content.submitted` with the new `room_id`/`visibility` fields. When the request asked `public` in a private room, increment a `submission.visibility_forced` metric (no user error — the composer locks the control).

**Acceptance criteria:**
- A request asking `public` in a private room is stored `room_only` and bumps the forced metric.
- Story and thread land in the same room transactionally; a failure rolls back both.
- The existing WS-F pre-checks (rate limit, account-age, spam-title, malware) run unchanged AFTER these guards.

**Testing:** Unit — derivation+forced metric; both-or-neither rollback. Integration — room-stamped insert + `content.submitted` payload.

**Dependencies:** WS-Q.1.3b, WS-Q.2.1b, WS-Q.1.7c.

---

### WS-Q.2.2a Tier-scoped exact-URL duplicate detection
**ID:** WS-Q.2.2a | **Ref:** Section 14.5.6

**Description:** Scope the existing exact-URL 409 path by tier (backed by the WS-Q.1.4c partial unique indexes, race-safe as today): a `public` submission 409s against any public story with the same canonical URL (global); a `room_only` submission 409s only against a `room_only` story with the same URL in the SAME room. The 409 body still returns the existing story id as the redirect suggestion.

**Acceptance criteria:**
- public/public same URL ⇒ 409; room_only/room_only same URL same room ⇒ 409; room_only same URL different rooms ⇒ both live; concurrency races resolve to exactly one winner per tier.

**Testing:** Unit — the URL-collision matrix. Gated integration — concurrent inserts per tier against the partial indexes.

**Dependencies:** WS-Q.1.4c, WS-Q.2.1c.

---

### WS-Q.2.2b Cross-tier linking (`canonical_public_story_id`)
**ID:** WS-Q.2.2b | **Ref:** Section 14.5.6

**Description:** A `room_only` submission whose URL matches an existing public story succeeds and records `canonical_public_story_id` on the new row; a public submission whose URL matches only `room_only` rows succeeds, becomes canonical, and opportunistically back-links those rows (batched UPDATE, no transaction coupling). Surface a read-only "a public conversation about this link exists" pointer on the in-room story's `StoryDetail` (room-readers only).

**Acceptance criteria:**
- room_only-then-public and public-then-room_only both succeed with the correct forward/back link.
- The in-room story detail exposes the canonical-public pointer to room readers only.

**Testing:** Unit — both cross-tier orderings set the link; the detail pointer renders only behind the read bar.

**Dependencies:** WS-Q.2.2a.

---

### WS-Q.2.2c Near-duplicate + syndication scoping to the public tier
**ID:** WS-Q.2.2c | **Ref:** Section 14.5.6

**Description:** Scope `findNearDuplicates`/`classifyDuplicate` candidate queries to `visibility = 'public'` so in-room content never feeds public near-dup/syndication clusters and is never flagged against them. `signatureStory` still computes and stores MinHash signatures for ALL stories (so a later widen joins the public clusters without recompute). Room-tier near-dup detection is explicitly out of scope for v1 (documented).

**Acceptance criteria:**
- LSH band queries filter `visibility='public'`; a `room_only` twin of a public story is neither flagged nor flags others.
- Signatures exist for `room_only` rows (verified by a widen-then-cluster test seam).

**Testing:** Unit — candidate queries exclude `room_only` (seeded store); signature presence for room_only.

**Dependencies:** WS-Q.1.4a, WS-Q.2.2a.

---

### WS-Q.2.3a Image-post intake (upload guard + store)
**ID:** WS-Q.2.3a | **Ref:** Sections 14.1, 14.2, 15.5

**Description:** Wire `image_post` through the WS-G.4.4 upload path: the composer uploads first (EXIF/GPS/XMP stripped, content-type allowlisted, scan-gated), then submits referencing `upload_id`. The submission guard verifies the upload exists, is owned by the submitter, is an image type, and is not already claimed; `scanState='pending'` holds the story in the WS-F review-hold path (fail-toward-caution), `flagged` rejects, `clear` publishes. Store `media_upload_ref`; set `extraction_state='not_applicable'`, `media_type='image'`; persist `alt_text` as the story accessibility text.

**Acceptance criteria:**
- Unscanned upload ⇒ story enters review-hold, never published-then-hidden; `flagged` ⇒ rejected; `clear` ⇒ published.
- A claimed upload cannot anchor a second story.

**Testing:** Unit — ownership/type/scan-state guard matrix; claim-uniqueness.

**Dependencies:** WS-Q.1.3c, WS-Q.2.1c.

---

### WS-Q.2.3b Image-post serving (gated path + EXIF-absence proof)
**ID:** WS-Q.2.3b | **Ref:** Sections 15.5, 25

**Description:** Serve image-post bytes only through the existing scan-gated upload read path; the story card/page reference the gated URL with the required alt text. Add an end-to-end test asserting served image bytes carry no EXIF/GPS (the pipeline strips at upload; this proves it through the story path).

**Acceptance criteria:**
- Image bytes are reachable only via the gated, scan-checked URL; a removed/flagged media post collapses to a clear state (no broken element).
- Served bytes contain no EXIF/GPS metadata.

**Testing:** Integration — submit→store→gated serve; EXIF-absence on served bytes.

**Dependencies:** WS-Q.2.3a.

---

### WS-Q.2.3c Video container allowlist + caps config + migration 0020
**ID:** WS-Q.2.3c | **Ref:** Sections 14.1, 14.2

**Description:** Extend the upload content-type allowlist with `video/mp4` and `video/webm` in BOTH the shared check and the DB CHECK (migration `0020`: drop+`ADD CONSTRAINT ... NOT VALID` then `VALIDATE CONSTRAINT` to avoid a full-table lock). Add fail-closed runtime-config caps `ingestion.video_max_bytes` (default 200 MB) and `ingestion.video_max_seconds` (default 600) with write-time 422 validation like other config keys.

**Acceptance criteria:**
- The allowlist admits mp4/webm and nothing else new; the DB CHECK matches the shared allowlist.
- Caps load fail-closed (invalid stored values ⇒ reviewed defaults, logged); oversize/overlong is rejected pre-storage.

**Testing:** Unit — config loader fail-closed; allowlist parity (shared ≡ DB CHECK). Gated integration — CHECK migration apply.

**Dependencies:** WS-Q.1.3c.

---

### WS-Q.2.3d Video byte-sniffing + container metadata stripping (validate-only)
**ID:** WS-Q.2.3d | **Ref:** Sections 14.2, 15.5

**Description:** Add validate-only video admission to the upload pipeline: byte-level container sniffing (MP4 box / WebM EBML magic + structural sanity) so extension/MIME spoofing is caught by content, not headers; strip droppable container-level metadata (MP4 `udta`/location boxes like `©xyz`; WebM `Tags`) WITHOUT re-encoding. No transcoding in v1 (documented: codec compatibility is the submitter's responsibility; the player shows a fallback for undecodable streams). The scan gate (`UploadScanner`) applies as for images.

**Acceptance criteria:**
- Spoofed-extension/corrupt-container uploads are rejected by the sniffer.
- MP4 location boxes are stripped before storage; no re-encode occurs.

**Testing:** Unit — sniffer fixtures (valid mp4/webm, spoofed, corrupt); metadata-strip assertions on crafted fixtures.

**Dependencies:** WS-Q.2.3c.

---

### WS-Q.2.3e Video-post intake + serving (no autoplay)
**ID:** WS-Q.2.3e | **Ref:** Sections 14.1, 15.5, 5.3

**Description:** Mirror WS-Q.2.3a/b for `video_post`: the submission guard verifies the upload (owned, video type, scan state) and stores `media_upload_ref`/`media_type='video'`/`extraction_state='not_applicable'`; serving uses range requests through the gated read path. Playback is a native `<video controls>` with no autoplay; dwell on a video post follows the standard §5.3 caps (no per-second video credit) — re-asserted by the no-raw-egress/cap tests.

**Acceptance criteria:**
- Video stories admit only `clear`/held uploads; serving supports range requests behind the gate.
- No autoplay anywhere; video dwell cannot exceed the standard per-item caps.

**Testing:** Unit — intake guard; cap assertion (no per-second credit). Integration — upload→submit→ranged serve.

**Dependencies:** WS-Q.2.3d, WS-Q.2.3a.

---

### WS-Q.2.4a Narrow transition (`public → room_only`)
**ID:** WS-Q.2.4a | **Ref:** Section 14.5.2

**Description:** `PATCH /v1/stories/{id}/visibility` to narrow (author-only, 404-over-403): set `visibility='room_only'`, row-locked and idempotent; write the audit log (`story_visibility_change`) and emit `content.visibility.changed` (`trigger='author'`) only on an actual state change; propagate synchronously to the search-index visibility column and enqueue a candidate/feature reindex (the serving-side bar makes the async gap safe).

**Acceptance criteria:**
- Author-only; editors/stewards cannot narrow another author's item here.
- Idempotent — repeated calls emit one event per real change; row-locked against concurrent transitions.

**Testing:** Unit — narrow idempotency + single-event + audit contents; non-author rejection.

**Dependencies:** WS-Q.1.7a, WS-Q.1.7b.

---

### WS-Q.2.4b Widen transition (`room_only → public`)
**ID:** WS-Q.2.4b | **Ref:** Section 14.5.2

**Description:** Extend the same endpoint to widen, allowed ONLY when the home room is public (private-room widen ⇒ 422 citing 14.5.1). Widening re-runs the FULL public-admission path synchronously — the same checks a fresh public submission gets — because WS-Q.2.2c deliberately kept the item out of the public near-dup/syndication clusters while it was `room_only`: tier-scoped exact-URL dedup (409 + pointer to the existing public story on collision), **`findNearDuplicates`/`classifyDuplicate` against the public cluster** (so a near-duplicate-but-not-exact item gets the same MERI/syndication flagging and auto-link/candidate routing as any public submission — its stored signature from WS-Q.2.2c makes this a query, not a recompute), spam-title/malware pre-checks, freshness-baseline (re)init, and a search/feature reindex enqueue. Audit + `content.visibility.changed` (`trigger='author'`).

**Acceptance criteria:**
- Widen in a private room ⇒ 422; widen colliding with an existing public URL ⇒ 409 + pointer (no silent merge); otherwise the item becomes `public` and globally eligible on the next serve.
- A `room_only` item that is a NEAR-duplicate (not exact-URL) of a public story is evaluated by `findNearDuplicates`/`classifyDuplicate` on widen and receives the normal near-dup/syndication outcome — it cannot enter the public tier unscreened.

**Testing:** Unit — widen matrix (public/private room × exact-URL collision × near-dup). Gated integration — widen re-runs exact AND near-dup dedup against the live public cluster.

**Dependencies:** WS-Q.2.4a, WS-Q.2.2a.

---

### WS-Q.2.5a Global search tier predicate (both adapters)
**ID:** WS-Q.2.5a | **Ref:** Sections 14.5.3, 14.5.4

**Description:** Section 14.5 scopes global surfaces to "public content **from public rooms**," so the predicate is BOTH conditions, not just the item flag: global search in both `SearchIndex` adapters (in-memory FTS semantics and the Drizzle FTS) filters `story.visibility = 'public' AND room.visibility = 'public'` (the Drizzle adapter joins or `EXISTS`-checks `rooms`; the in-memory adapter checks the room record), alongside the existing hidden/retracted exclusions. Embedding-similarity reads feeding GLOBAL surfaces (related stories, public claim pages) apply the same two-condition filter. The room-visibility conjunct is deliberate defense-in-depth: a story is only ever `public` in a public room in steady state (private rooms force `room_only`), but the migration window (0015 default `public` before the 0016 backfill) and any future cascade bug could transiently leave a private-room row stamped `public`; checking the room closes that gap so a mislabeled row never surfaces even to a reader who passes that room's bar. Keyset pagination is unchanged.

**Acceptance criteria:**
- A `room_only` story never appears in any global FTS or vector result in either adapter (adversarial twin-title test: identical-title public + room_only ⇒ only public returns globally).
- A story stamped `public` whose home room is `private` (the transient/cascade-bug case) ALSO never appears on a global surface — the room-visibility conjunct excludes it.

**Testing:** Unit — both adapters' two-condition predicate; the twin-title test; the mislabeled-row (public story / private room) exclusion. Gated integration — Drizzle FTS join predicate + pagination.

**Dependencies:** WS-Q.1.4a.

---

### WS-Q.2.5b Room-scoped search + similarity
**ID:** WS-Q.2.5b | **Ref:** Sections 14.5.3, 14.5.4

**Description:** Add a `?room=` parameter to the search endpoint: the caller must pass the room read bar (404 for private rooms otherwise), then search that room's full pool (`public` + `room_only` of that room only). Room-surface embedding similarity may include that room's pool only. No other room's content is reachable through a room-scoped query.

**Acceptance criteria:**
- `?room=` without read-bar passage ⇒ 404 (existence is tier one; content search is tier two).
- Room search returns the room's `room_only` rows to members and excludes other rooms entirely.

**Testing:** Unit — room-scoped predicate; cross-room exclusion. Gated integration — room-scoped pagination round-trip.

**Dependencies:** WS-Q.2.5a, WS-Q.3.2 (read bar).

---

### WS-Q.2.6 Takedown + moderation reach over room-tier content
**ID:** WS-Q.2.6 | **Ref:** Sections 14.5.7, 16.1, 18

**Description:** Verify and close moderation reach over in-room content: the public takedown intake resolves `room_only` ids (receipt never confirms existence beyond the standard response); steward takedown actioning hides a `room_only` story from its room exactly as it hides public stories (`hidden_state` already serves this — add the room-feed/room-search exclusion tests); the WS-F review queue and WS-G moderation-concern flow operate on room-tier content; platform-scope stewards see private-room held/flagged items in their queues (room privacy never shields content from review — Section 16.1).

**Acceptance criteria:**
- Takedown actioning on a `room_only` story removes it from room feed, room search, and direct reads (404), audit intact.
- Review-queue listings include private-room items for platform stewards; the moderation-concern intake works from private-room threads end-to-end.

**Testing:** Unit — hidden-state exclusion on room feed/search. Integration — takedown→action→all-surface exclusion for a `room_only` story.

**Dependencies:** WS-Q.2.1c, WS-Q.4.2a.

---

## WS-Q.3 Forum, rooms, and the read bar (WS-G deltas)

### WS-Q.3.1a Adapt the room read bar to binary visibility
**ID:** WS-Q.3.1a | **Ref:** Sections 16.1, 16.2

**Description:** Retarget the two existing bar functions in `apps/api/src/forum/rooms.ts` to the binary enum. This is a **deliberate semantic change** from the shipped restricted-room behavior, required by SPEC §16.1/§16.2: tier one (room *existence* — name, description, visibility class, join affordance) is visible to ALL so private rooms are discoverable and joinable. `roomVisibleToUser` (tier one) therefore returns `true` for every non-archived room — public AND private — to everyone, signed-in or not (the old code returned `false` for a non-subscribed restricted room, which would hide private rooms and strand the join affordance; that hiding is dropped). `roomContentVisibleToUser` (tier two — content) is unchanged in spirit: `true` for `public`; for `private`, ACTIVE membership or steward role. Net: existence is universal; content is members-only. (Steward rooms are private and thus discoverable-by-existence per the SPEC; if "unlisted/secret" rooms are later wanted, that is a new SPEC axis — now realized as WS-S's `directory_mode ∈ {listed, unlisted, detached}` axis (`docs/planning/19-decentralized-data-plane.md` §23.2), still out of scope for WS-Q.)

**Acceptance criteria:**
- `roomVisibleToUser` is `true` for any non-archived room for any user including signed-out (tier-one existence is universal); it is NOT gated by subscription.
- `roomContentVisibleToUser` is `true` for public rooms (all) and private rooms (active member/steward only); pending applicants and outsiders fail tier two.
- A signed-out user can resolve a private room's tier-one shell and reach its join affordance (the WS-Q.5.3a dependency holds); they read no content.

**Testing:** Unit — tier-one universality (incl. signed-out + non-member) and tier-two truth table over visibility × membership-state × steward.

**Dependencies:** WS-Q.1.1a, WS-Q.1.2.

---

### WS-Q.3.1b `userMayPostTopLevel`
**ID:** WS-Q.3.1b | **Ref:** Sections 16.1, 16.2

**Description:** Add `userMayPostTopLevel(room, userId)`: `true` when the user passes `roomContentVisibleToUser` AND (`posting_policy === 'all_members'` OR the user holds a steward role OR an expert-lens assignment for the room). The single chokepoint for "may create top-level content here", consumed by the submission guard (WS-Q.2.1b) and the composer's postable-room filter (WS-Q.5.1a).

**Acceptance criteria:**
- `all_members` ⇒ any reader-member may post; `experts_and_stewards` ⇒ only stewards/experts.
- A non-reader never passes (composes the content bar first).

**Testing:** Unit — posting_policy × role × membership matrix.

**Dependencies:** WS-Q.3.1a.

---

### WS-Q.3.1c `joinRoom` rewrite against `join_model`
**ID:** WS-Q.3.1c | **Ref:** Section 16.2

**Description:** Rewrite `joinRoom` to branch on `join_model`: `open` ⇒ immediate `active`; `request_approval` ⇒ `pending`; `invite` ⇒ reject self-join with an "invite-only" outcome (invitations are a separate steward action, seam stubbed for WS-J). Idempotent: re-joining returns the existing subscription unchanged.

**Acceptance criteria:**
- All three join models honored; `invite` rejects self-join cleanly; re-join is idempotent.

**Testing:** Unit/integration — join flow per model; idempotent re-join.

**Dependencies:** WS-Q.3.1a.

---

### WS-Q.3.2 `storyReadableByUser` item-level read bar
**ID:** WS-Q.3.2 | **Ref:** Sections 14.5.3, 15.3

**Description:** Add a single helper `storyReadableByUser(story, room, userId)` = "passes the room content bar AND the item visibility": a `public` story is readable by anyone who can reach its (necessarily public) room; a `room_only` story requires `roomContentVisibleToUser`. Wire it into `GET /v1/stories/{id}`, the thread overview (`threadVisibleToUser` composes it), branch/subtree reads, and contribution reads. Fail-closed: unknown room/story ⇒ not readable ⇒ 404.

**Acceptance criteria:**
- `room_only` story in a private room ⇒ 404 for outsiders/pending, 200 for active members/stewards; `public` story ⇒ 200 for anyone.
- Thread/branch/subtree/contribution reads all 404 when the owning story is unreadable (no body leakage).
- The rule lives only in this helper; all five read paths call it.

**Testing:** Unit — `storyReadableByUser` truth table. Integration — each of the five read endpoints 404s for an unreadable `room_only` story.

**Dependencies:** WS-Q.3.1a, WS-Q.1.4b, WS-Q.1.5.

---

### WS-Q.3.3a Room creation accepts visibility/join/posting
**ID:** WS-Q.3.3a | **Ref:** Sections 16.1, 16.2

**Description:** Update room creation (`apps/api/src/routes/rooms.ts`/`forum/rooms.ts`) to accept and validate `visibility`/`join_model`/`posting_policy` (through the shared coherence refinement), apply the documented defaults (`public→open`, `private→request_approval`; posting `all_members`), and make the creator the first `community_steward`. Creating a private room is allowed to any account within the existing room-creation rate limits.

**Acceptance criteria:**
- Create accepts the new fields with defaults; incoherent combinations ⇒ 422 (shared refinement).
- The creator becomes `community_steward`; private-room creation is rate-limited like public.

**Testing:** Unit — create/validate matrix; first-steward assignment.

**Dependencies:** WS-Q.1.1a, WS-Q.3.1a.

---

### WS-Q.3.3b Governance writes for join/posting; visibility routed away; recommendation-input assertion
**ID:** WS-Q.3.3b | **Ref:** Sections 16.2, 16.4, 13.6

**Description:** The audited governance-settings write may change `join_model`/`posting_policy` freely (audit type `forum_config_change`, before/after recorded). A `visibility` change is REJECTED here (422 pointing to the visibility-cascade endpoint, WS-Q.3.4a). Add an assertion that `visibility`/`join_model`/`posting_policy` never appear in `RECOMMENDATION_INPUT_KEYS` (they gate eligibility; they never score).

**Acceptance criteria:**
- Join/posting writes are audited as `forum_config_change`; a visibility change via the generic write ⇒ 422 with the cascade pointer.
- The recommendation-input exclusion assertion is green.

**Testing:** Unit — governance-write audit contents; visibility-rejection; recommendation-input exclusion.

**Dependencies:** WS-Q.3.3a, WS-Q.1.7b.

---

### WS-Q.3.4a Room cascade: public → private
**ID:** WS-Q.3.4a | **Ref:** Sections 14.5.2, 16.1

**Description:** A steward-only, audited endpoint flips a room public→private with the content cascade: every `public` story in the room is forced `room_only` via a durable, idempotent, lease-guarded per-story sweep (the WS-E/WS-F sweep pattern), each emitting `content.visibility.changed` (`trigger='room_visibility_change'`); the room row flips and `open` join_model becomes `request_approval`; existing `active` memberships are retained. One room-audit record summarizes the count; a confirmation states "N stories will leave public surfaces". Crash mid-cascade resumes without double-emitting for already-converted stories.

**Acceptance criteria:**
- Every story ends `room_only`; none remains on a global surface after reindex; one event per story; one summary audit record.
- The sweep is resumable/idempotent; only governance-capable stewards can invoke (others 404).

**Testing:** Unit — cascade semantics + idempotent resume + per-story emission. Integration — reindex removes items from the global feed (composed with WS-Q.4.2a).

**Dependencies:** WS-Q.2.4a, WS-Q.1.7a, WS-Q.4.2a.

---

### WS-Q.3.4b Room cascade: private → public
**ID:** WS-Q.3.4b | **Ref:** Sections 14.5.2, 16.1

**Description:** The reverse flip makes the room readable by all but auto-publishes NO content: every story stays `room_only` until its author widens it (WS-Q.2.4b); `join_model` may be set to `open`. One audited transaction over the room row; no per-story sweep (nothing changes at the item level).

**Acceptance criteria:**
- Zero stories change visibility; the room becomes globally listable; authors can then widen individually.
- Steward-only; audited (`room_visibility_change`).

**Testing:** Unit — no-item-change semantics; listability flip. Integration — content stays in-room post-flip.

**Dependencies:** WS-Q.3.4a.

---

### WS-Q.3.5 DSAR + anonymization across both tiers
**ID:** WS-Q.3.5 | **Ref:** Sections 14.5.7, 19.3

**Description:** Extend the WS-D/WS-G privacy hooks: `exportContributions` returns the user's own stories/contributions REGARDLESS of visibility (including `room_only` items and private-room memberships), each tagged `room_ref`+`visibility` (self-access is not bounded by distribution). `anonymizeContributions` tombstones room-tier contributions and strips private-room memberships/steward rows. Conversation-health rollups compute identically for `room_only` threads and never enter ranking.

**Acceptance criteria:**
- DSAR export includes `room_only` content and private-room subscriptions with `room_ref`+`visibility`.
- Account purge tombstones room-tier content and removes private-room membership rows.

**Testing:** Unit — DSAR composition across both tiers (private-room fixture); purge strips memberships.

**Dependencies:** WS-Q.3.2.

---

## WS-Q.4 Ranking and distribution (WS-I deltas)

### WS-Q.4.1a Candidate carries visibility
**ID:** WS-Q.4.1a | **Ref:** Sections 13.2, 14.5.3

**Description:** Add `visibility: 'public' | 'room_only'` to the strict `Candidate` stage-boundary schema (`packages/ranking/src/schemas/candidate.ts`) and populate it from the story row in the feature-store join and every retriever path. The orchestrator's strict re-validation now also asserts `visibility` is present.

**Acceptance criteria:**
- Every `Candidate` carries `visibility`; the boundary schema rejects a candidate without it.

**Testing:** Unit — candidate boundary rejects missing `visibility`; population smoke test.

**Dependencies:** WS-Q.1.4a.

---

### WS-Q.4.1b Visibility-scoped retrievers
**ID:** WS-Q.4.1b | **Ref:** Sections 13.2, 14.5.3

**Description:** Scope retrieval by surface: the EIGHT organic retrievers that feed the front page/topic (`subscribed_rooms_v1`, `local_news_v1`, `global_pwatt_v1`, `emerging_discussions_v1`, `independent_additions_v1`, `cross_community_bridges_v1`, `expert_explanations_v1`, `chronological_catch_up_v1`) gain the global predicate `story.visibility='public' AND room.visibility='public'` — both conjuncts, matching the global-search rule (WS-Q.2.5a), so a transiently-mislabeled `public` story in a private room is excluded here too and even a user's own subscribed private-room content stays off the public front page; `RoomSurfaceRetriever` queries the target room's full pool (`public` + `room_only`).

**Acceptance criteria:**
- A `room_only` story matching every front-page heuristic appears in NONE of the eight organic retrievers (adversarial sweep).
- A `public`-stamped story whose home room is `private` also appears in none of the eight (the room-visibility conjunct).
- The room scoper emits the room's `room_only` items for a reader who passes the bar.

**Testing:** Unit — per-retriever public predicate; the adversarial exclusion sweep across all eight; room-scoper inclusion.

**Dependencies:** WS-Q.4.1a.

---

### WS-Q.4.2a Surface-aware distribution gate (`filterByVisibility`)
**ID:** WS-Q.4.2a | **Ref:** Sections 13.2, 14.5.3

**Description:** Rename `filterByRoomVisibility`→`filterByVisibility` and add the item-tier clause as the authoritative always-on backstop. On `front_page`/`topic` the rule is the SAME two-condition test the retrievers and search use — drop a candidate unless `item.visibility='public' AND its room.visibility='public'` — so a `room_only` item OR a `public`-stamped item in a private room (the migration-transient/cascade-bug case) is dropped even if a buggy retriever emitted it; on `room`, keep `room_only` only for the surface's own room. Keep the existing per-distinct-room `roomContentVisibleToUser` clause. Remove the dead "room-less items pass through" branch (every item now has a room; unknown room ⇒ fail closed). Each drop is logged with a reason (`item_visibility` / `room_private_on_global` / `room_bar`). The per-distinct-room lookup the gate already does supplies `room.visibility` cheaply (no extra query).

**Acceptance criteria:**
- A force-injected `room_only` candidate cannot appear on `front_page`/`topic`; a force-injected `public` candidate whose room is `private` also cannot; on `room`, foreign-room `room_only` is dropped and own-room `room_only` passes (behind the bar); unknown room fails closed on every surface.

**Testing:** Unit — surface × visibility × membership matrix; force-injected `room_only` on front_page is dropped; reason-coded logging.

**Dependencies:** WS-Q.4.1b, WS-Q.3.1a.

---

### WS-Q.4.2b Gate the fallback path + decision-log excluded count
**ID:** WS-Q.4.2b | **Ref:** Sections 13.2, 14.5.3

**Description:** Apply `filterByVisibility` identically on the score-blind chronological fallback path (so paused ranking never widens reach) and record the visibility-excluded count in the `RankingDecisionLog`. A neutrality-style invariant asserts fallback reach ⊆ ranked reach for visibility.

**Acceptance criteria:**
- The fallback applies the identical gate (force-inject + assert absence); the decision log records the excluded count.

**Testing:** Unit — fallback gate application; decision-log field.

**Dependencies:** WS-Q.4.2a.

---

### WS-Q.4.3 Feature store + decision log: visibility as non-scoring eligibility
**ID:** WS-Q.4.3 | **Ref:** Sections 13.3, 22.4, 30.6

**Description:** Record `visibility` in the feature vector and decision log as an eligibility/audit field in the explicit "non-scoring eligibility fields" set the scoring stage ignores (like the safety flags) — it gates candidacy, never scores. Replay re-applies the surface-aware gate at the recorded surface (pre-WS-Q logs without `visibility` replay via a `public` default, since every pre-WS-Q served item was public). Re-run the WS-I.2.1b financial denylist and the wallet↔ranking BFS isolation proof on the modified feature-store/`Candidate`/`stories` shapes.

**Acceptance criteria:**
- A property test proves flipping ONLY `visibility` on already-eligible same-room items changes neither order nor scores.
- Replay reproduces the served set including the gate; legacy logs replay with the `public` default.
- Denylist + BFS isolation tests stay green on the new columns/shapes.

**Testing:** Unit — visibility-not-a-score property; legacy-log replay default; denylist/isolation re-run.

**Dependencies:** WS-Q.4.2b, WS-Q.1.4a.

---

### WS-Q.4.4a Containment neutrality tests
**ID:** WS-Q.4.4a | **Ref:** Sections 13.2, 14.5, 30.6

**Description:** Add containment assertions to `apps/api/src/__tests__/ranking-neutrality.test.ts`: (1) no global surface (front_page, topic, global search, embedding similarity feeding public pages) returns a `room_only` item, across ranked AND fallback, proven against a seeded store where every public-surface heuristic is satisfied by a planted `room_only` story; (2) the eight-retriever front-page UNION is visibility-pure; (3) a private room's content is absent from a non-member's every surface (feed, search, story read, share preview).

**Acceptance criteria:**
- `pnpm check:neutrality` fails if any global surface leaks a `room_only` item; the three assertions cover ranked + fallback and all global surfaces.

**Testing:** The suite IS the test; add fixtures to the api neutrality suite + the ranking package.

**Dependencies:** WS-Q.4.2b, WS-Q.4.3, WS-Q.2.5a.

---

### WS-Q.4.4b Not-a-signal + transition + import-closure assertions
**ID:** WS-Q.4.4b | **Ref:** Sections 13.2, 14.5, 30.6

**Description:** Add to the neutrality gate: (4) the WS-Q.4.3 "visibility is not a ranking signal" property, lifted into the gate; (5) widen (`room_only→public`) makes an item eligible and narrow removes it on the next serve, asserted end-to-end; (6) extend the existing transitive import-closure walk (neutrality tests 8/9) to assert no global retrieval path bypasses `filterByVisibility`. Document the containment leg in the gate's header.

**Acceptance criteria:**
- The gate proves visibility is non-scoring, that widen/narrow flip eligibility, and that every global path routes through `filterByVisibility`.

**Testing:** Extends `check:neutrality`; the import-closure walk fails if a global path skips the gate.

**Dependencies:** WS-Q.4.4a.

---

## WS-Q.5 Client surfaces (WS-C/WS-B/WS-G deltas)

### WS-Q.5.1a Composer: home-room picker
**ID:** WS-Q.5.1a | **Ref:** Sections 6.3, 6.6, 14.5

**Description:** Add a required home-room picker to the submit flow (`apps/web/src/routes/submit.tsx` + composer): the user's joined rooms filtered to postable-to (per `posting_policy`, via the room detail the API exposes), Commons as the default suggestion, and a typeahead over discoverable rooms. Submit is disabled with an accessible explanation until a room is chosen.

**Acceptance criteria:**
- Submitting without a room is impossible; the disabled state has an accessible reason.
- Only postable rooms are selectable (non-postable rooms are shown disabled with the reason, not hidden, so the user understands).

**Testing:** Unit (jsdom) — picker disabled-state, postable filtering. E2E — choose room → enabled submit; axe on the control.

**Dependencies:** WS-Q.1.1a, WS-Q.3.1b.

---

### WS-Q.5.1b Composer: visibility control (locked for private rooms)
**ID:** WS-Q.5.1b | **Ref:** Section 14.5

**Description:** Add a public/in-room visibility toggle that calls the SHARED `deriveStoryVisibility` so the shown value equals the server-derived value. The control is locked to in-room and explained when the chosen room is private ("This room is private — posts stay in the room"); defaults to public in public rooms. Encrypted-draft autosave persists room + visibility; share-target intake defaults room to last-used or Commons.

**Acceptance criteria:**
- Private-room selection locks the toggle to in-room; the user can never request public there.
- The displayed final visibility equals the server-stored value for every room/choice combination (shared-helper parity test).
- Draft autosave/restore round-trips room + visibility.

**Testing:** Unit — private-room lock + derivation parity; draft round-trip. E2E — compose shows room+visibility; payload matches.

**Dependencies:** WS-Q.5.1a, WS-Q.1.3b.

---

### WS-Q.5.2a Composer: image-post mode
**ID:** WS-Q.5.2a | **Ref:** Sections 14.1, 26

**Description:** Add the image-post composer mode: file picker (allow-listed types), client-side preview, REQUIRED alt-text field (submit blocked without it), and upload-progress + scan-pending states ("Posted, pending a safety check" when the scan is still pending).

**Acceptance criteria:**
- Image submit is blocked without alt text; the error is field-tied and accessible.
- Scan-pending posts show the pending state, not a failure.

**Testing:** Unit — alt-text gating; scan-pending state. E2E — image post + axe.

**Dependencies:** WS-Q.5.1b, WS-Q.2.3a.

---

### WS-Q.5.2b Composer: video-post mode
**ID:** WS-Q.5.2b | **Ref:** Sections 14.1, 26

**Description:** Add the video-post composer mode: file picker (allow-listed containers, client-side size/duration hints matching the server caps), optional captions (text or upload), and upload-progress/scan-pending states. Oversize/overlong files are rejected client-side with the cap reason before upload starts.

**Acceptance criteria:**
- Captions accept text XOR upload, not both; oversize/overlong is rejected pre-upload with the cap reason.

**Testing:** Unit — caption XOR; cap pre-check. E2E — video post flow.

**Dependencies:** WS-Q.5.2a, WS-Q.2.3c.

---

### WS-Q.5.2c Media rendering (image + video)
**ID:** WS-Q.5.2c | **Ref:** Sections 15.5, 26, 6.9

**Description:** Render media on `StoryCard` and the story page: images through the gated upload URL with alt text; videos through a native `<video controls>` (no autoplay; poster where available; a fallback message for undecodable codecs). Respect reduced-motion (no autoplay ever) and offline (cached posters; graceful offline degradation). A flagged/removed media post collapses to a clear state, not a broken element. Players use platform elements — no new dependency (the budget is unchanged).

**Acceptance criteria:**
- No autoplay in any state; video controls are keyboard-operable; captions render when present.
- Media loads only via the gated URL; flagged/removed collapses honestly; bundle-size budget holds.

**Testing:** Unit — no-autoplay; degraded/collapsed states. E2E — image/video render + keyboard + axe.

**Dependencies:** WS-Q.5.2b, WS-Q.2.3b, WS-Q.2.3e.

---

### WS-Q.5.3a Room shell for non-members (tier one)
**ID:** WS-Q.5.3a | **Ref:** Sections 16.1, 16.2, 14.5.7

**Description:** Render the tier-one shell for non-members of a private room (`apps/web/src/routes/rooms*.tsx`): private-room badge, name/description, a "Request to join" or "Invite only" CTA per `join_model`, a pending state for applicants, and the honest-limits notice ("private from the public, not from moderation; not encrypted"). No content renders until the content bar passes. (Under WS-S this shell's label becomes "Members-only server room"; its "not encrypted" honest-limit is exactly what distinguishes it from a `private_p2p` room — no WS-Q behaviour changes.)

**Acceptance criteria:**
- Non-members see only the tier-one shell + honest notice; pending applicants see a pending state; content never renders for them.

**Testing:** Unit — tier-one vs tier-two render gating per membership state. E2E — private-room non-member shell + axe.

**Dependencies:** WS-Q.1.1a, WS-Q.3.1a.

---

### WS-Q.5.3b Room feed surface + in-room chip
**ID:** WS-Q.5.3b | **Ref:** Sections 16.1, 16.2

**Description:** Wire the room feed to `GET /v1/rooms/:roomId/feed` (the room's full pool for readers who pass the bar) and add an in-room chip to every non-public item; public items in a public room carry no chip. Empty/loading/offline states designed and accessible.

**Acceptance criteria:**
- The in-room chip marks every `room_only` item on a room feed; public items carry no chip.
- All states pass axe.

**Testing:** Unit — chip logic; states. E2E — member room feed shows own `room_only` with chip.

**Dependencies:** WS-Q.5.3a, WS-Q.4.2a.

---

### WS-Q.5.3c Room create/settings UI + directory
**ID:** WS-Q.5.3c | **Ref:** Sections 16.1, 16.2

**Description:** Expose visibility/join-model/posting-policy in room creation and settings UI with the coherence rules enforced client-side (mirroring the shared refinement); update the directory to list public rooms and discoverable private rooms (tier one) with public-only thread counts.

**Acceptance criteria:**
- The UI cannot submit an incoherent visibility/join/posting combination.
- The directory shows private rooms at tier one with public-only counts.

**Testing:** Unit — coherence enforcement; directory listing. E2E — create flow per visibility + axe.

**Dependencies:** WS-Q.5.3a, WS-Q.3.3a.

---

### WS-Q.5.4a Author visibility management control
**ID:** WS-Q.5.4a | **Ref:** Sections 6.3, 14.5.2

**Description:** Add an author-facing "Change visibility" control on the story page wired to `PATCH /v1/stories/{id}/visibility`: narrow always offered; widen offered only in public rooms; surface the widen outcomes — including the "a public story already exists for this link" 409 with a link to it. The Signal Ledger reason links continue to resolve for the owner's in-room items.

**Acceptance criteria:**
- Narrow/widen controls appear per the rules; widen collision shows the existing public story; private-room items offer no widen.

**Testing:** Unit — control visibility per room/visibility; collision rendering. E2E — narrow then confirm the item leaves the front page.

**Dependencies:** WS-Q.5.3b, WS-Q.2.4b.

---

### WS-Q.5.4b Front-page framing + prohibited-language fixtures
**ID:** WS-Q.5.4b | **Ref:** Sections 6.3, 32.1

**Description:** Update front-page/explanation framing copy to reflect that it shows public content earning the most meaningful participation-weighted attention (never "most liked"/"most upvoted"); add the new copy to the prohibited-language fixtures so the render-time no-applause gate and the x-pseudo localization proof cover it.

**Acceptance criteria:**
- No string implies likes/votes/applause; the prohibited-language gate and x-pseudo proof pass on the new copy.

**Testing:** Unit — prohibited-language fixtures include the new copy; render-time gate green.

**Dependencies:** WS-Q.5.4a.

---

### WS-Q.5.5 Offline cache schema bump + queued-submission reconciliation
**ID:** WS-Q.5.5 | **Ref:** Section 6.9

**Description:** Bump the offline IndexedDB record-schema version so pre-WS-Q cached feed/story/room shapes (no `room_id`/`visibility`/binary room visibility) are evicted and refetched, never mis-parsed; adopt the new shapes in the read-through cache and the zod integrity layer. Reconcile pre-WS-Q queued offline submissions (no room) on sync by surfacing them for home-room selection — never silently dropped, never auto-posted to Commons without consent.

**Acceptance criteria:**
- Stale cached records evict on the version bump; no parse error reaches the UI.
- A pre-WS-Q queued submission without a room is surfaced for room selection, not lost and not auto-posted.

**Testing:** Unit (`fake-indexeddb`) — version-bump eviction; queued-submission reconciliation.

**Dependencies:** WS-Q.1.1a, WS-Q.1.3a.

---

## WS-Q.6 Cross-cutting: migration validation, rollout, docs

### WS-Q.6.1 End-to-end migration validation harness
**ID:** WS-Q.6.1 | **Ref:** Sections 14.5, 16.1, 22.1

**Description:** A gated integration harness that seeds a realistic pre-WS-Q dataset (public/restricted/expert_led rooms; thread-roomed and room-less stories; link/brief/question/evidence stories; public near-dup clusters), runs the full chain (`0014`–`0020` + Commons seed), and asserts the global safety property: **the (item, viewer) read/distribute set never grows for any existing item and never shrinks for any item that was publicly visible.** Concretely: every formerly-global story stays global iff its mapped room is public; every restricted/expert_led story becomes `room_only`; no story is room-less; no public near-dup invariant is violated by the tier-scoped indexes. Include a dry-run report mode (per-branch counts) for operational confidence.

**Acceptance criteria:**
- Passes on the seeded dataset; emits a per-branch count report; the monotonic-visibility property holds; re-running the chain is a no-op (idempotent), including the Commons seed.

**Testing:** Gated integration (Postgres + Redis service containers).

**Dependencies:** WS-Q.1.2, WS-Q.1.4a, WS-Q.1.4b, WS-Q.1.4c, WS-Q.1.5, WS-Q.1.6.

---

### WS-Q.6.2 Feature-flag rollout and reversibility
**ID:** WS-Q.6.2 | **Ref:** Sections 30.8, 30.9

**Description:** Gate the user-visible surface behind fail-closed flags so behavior rolls out/back independently of the additive schema: `content.media_posts_enabled` (image/video submission), `content.in_room_visibility_enabled` (the public/in-room author choice — off ⇒ public rooms behave pre-WS-Q with all content public; private rooms STILL force `room_only`), `rooms.binary_visibility_ui` (the new room controls). The distribution-side gate (WS-Q.4.2a) and the read bar (WS-Q.3.2) are ALWAYS ON — there is no off switch, since disabling them could leak in-room content. Document the rollback: disabling the author-choice flag stops new in-room items while existing ones stay contained by the always-on gate.

**Acceptance criteria:**
- Flags fail closed (unreadable ⇒ feature off ⇒ pre-WS-Q behavior, except containment/read-bar which are unconditionally on and privacy which is never flagged off).
- A test asserts no flag can widen in-room reach (containment is not flaggable).

**Testing:** Unit — flag fail-closed defaults; containment-not-flaggable assertion.

**Dependencies:** WS-Q.4.2a, WS-Q.3.2, WS-Q.5.1b.

---

### WS-Q.6.3 Documentation, status, index, version
**ID:** WS-Q.6.3 | **Ref:** Documentation rules (CLAUDE.md)

**Description:** In the same change set as the implementation, update: `docs/SPEC.md` (keep in sync if implementation forces refinements); `docs/forum/README.md`, `docs/ingestion/README.md`, `docs/ranking/README.md` (room-ownership, visibility, media-post, containment behaviors); `README.md` (status + new submission types); `CLAUDE.md`/`AGENTS.md` kept byte-identical (current-status summary, source-layout deltas, the new event topic, the WS-Q roadmap row — per the file's no-workstream-reference convention, keep WS-Q to the one-line status row only); `docs/planning/00-index.md` (WS-Q registered). Bump the root `package.json` PATCH version.

**Acceptance criteria:**
- `pnpm check:policy` and doc gates pass; `CLAUDE.md` ≡ `AGENTS.md` (empty `diff`); the master index lists WS-Q accurately; no `claude.ai/code/session_*` URL in any doc or PR body.

**Testing:** `pnpm check:policy`; the CLAUDE.md ≡ AGENTS.md byte-identical assertion.

**Dependencies:** all WS-Q implementation cards (lands with them).

---

## Dependency graph (within WS-Q)

```
Q.1.1a ─ Q.1.1b ─ Q.1.2 ──────────────────────────────────────────┐
Q.1.1a ─ Q.1.3a ─ Q.1.3b                                            │
            └──── Q.1.3c                                            │
Q.1.2 + Q.1.3a + Q.1.3c ─ Q.1.4a ─ Q.1.4b ─ Q.1.4c                 │
Q.1.4a ─ Q.1.6 (Commons app-ensure)                                │
Q.1.4b ─ Q.1.5 (threads NOT NULL + trigger)                        │
Q.1.3a ─ Q.1.7a ─ Q.1.7b ;  Q.1.3a ─ Q.1.7c                        │
                                                                   ▼
Q.3.1a ─ Q.3.1b ─ Q.3.1c ;  Q.3.1a ─ Q.3.2 ─ Q.3.5                 (read bar)
Q.3.1a ─ Q.3.3a ─ Q.3.3b ;  Q.2.4a ─ Q.3.4a ─ Q.3.4b               (rooms/cascade)
Q.2.1a ─ Q.2.1b ─ Q.2.1c ─┬─ Q.2.2a ─ Q.2.2b ; Q.2.2a ─ Q.2.2c     (submission/dedup)
                          ├─ Q.2.3a ─ Q.2.3b ; Q.2.3c ─ Q.2.3d ─ Q.2.3e
                          ├─ Q.2.4a ─ Q.2.4b
                          └─ Q.2.5a ─ Q.2.5b ; Q.2.1c ─ Q.2.6
Q.1.4a ─ Q.4.1a ─ Q.4.1b ─ Q.4.2a ─ Q.4.2b ─ Q.4.3 ─ Q.4.4a ─ Q.4.4b
Q.5.1a ─ Q.5.1b ─ Q.5.2a ─ Q.5.2b ─ Q.5.2c ; Q.5.3a ─ Q.5.3b ─ Q.5.3c
Q.5.3b ─ Q.5.4a ─ Q.5.4b ; Q.1.1a/Q.1.3a ─ Q.5.5
Q.1.* ─ Q.6.1 ; Q.4.2a + Q.3.2 + Q.5.1b ─ Q.6.2 ; (all) ─ Q.6.3
```

Cross-stream order: **Q.1** (shared schemas → rooms migration → stories expand/backfill/contract → threads → events/audit) → **Q.3** read bar + **Q.2** submission/dedup/media/search in parallel → **Q.4** ranking (after the read bar and candidate visibility) → **Q.5** client (after the wire shapes) → **Q.6** validation/rollout/docs (last). The eight expand/contract migrations (`0014`–`0020`) are strictly ordered; nothing sets NOT NULL or a tier-scoped unique index before its backfill completes.

### Downstream extensions (WS-R, WS-S)

WS-Q is the room/content/visibility foundation that two **post-M3 extension workstreams** build on; both are **additive and non-breaking** to WS-Q's shipped model:

- **WS-R — Offline Content Availability / LCAP v0.2** (`docs/planning/19-decentralized-data-plane.md`, `docs/OFFLINE_SPEC.md`) is an alternate signed ingress/egress for WS-F/WS-G/WS-Q content, **never a parallel truth**: a reconciled LCAP record lands in this workstream's canonical room/thread/visibility state and traverses the identical validation pipeline regardless of transport. `mapLcapVisibilityToStory` round-trips `in_room ↔ room_only` against `Story.visibility`; the always-on distribution gate and `storyReadableByUser` apply unchanged to LCAP-reconciled items.
- **WS-S — Private P2P Rooms / E2EE** (`docs/planning/19-decentralized-data-plane.md`, `docs/PRIVATE_SPEC.md`) adds a third room class `private_p2p` plus the orthogonal `storage_mode`/`authority_model`/`directory_mode` axes to this room schema (an additive expand migration continuing after `0020`, reusing `join_model`), and **renames** WS-Q's server-hosted "private room" to "members-only server room" (§20.1). WS-Q's binary server visibility, the always-on distribution gate, and `storyReadableByUser` are unchanged; WS-S predicates every retriever/search/event path on `rooms.storage_mode = 'server'` and prepends a `409 p2p_room_requires_client_sync` submission guard ahead of the WS-Q.2.1a guard chain, so `private_p2p` content is never server-stored, retrieved, ranked, or searched.

## Milestone gate additions

| Gate | Cards | Requirement |
|---|---|---|
| Home room required | Q.2.1a, Q.2.1c, Q.1.5 | No content without a home room; `Story.room_id` and `Thread.room_id` NOT NULL. |
| Two-tier containment | Q.4.2a, Q.4.2b, Q.4.4a/b | In-room content never reaches a global surface (ranked or fallback), proven in CI. |
| Private-room read bar | Q.3.2 | Outsiders/pending see only tier one; content reads 404. |
| Visibility forcing | Q.1.3b, Q.2.1c | Private rooms force `room_only`; no override path. |
| Media safety | Q.2.3a–e | Image/video EXIF/metadata-stripped, scan-gated, alt-text required, no autoplay. |
| Migration monotonicity | Q.6.1 | No existing item gains reach; no public item loses it; chain idempotent. |
| Neutrality preserved | Q.4.3, Q.4.4a/b | Visibility never scores; financial denylist + BFS isolation still green. |
| Docs byte-identical | Q.6.3 | CLAUDE.md ≡ AGENTS.md; index + READMEs updated; version bumped. |

## Definition of done (workstream)

- Every content item has exactly one home room (`Story.room_id` NOT NULL); every thread's room equals its story's room (trigger-enforced).
- Room visibility is binary with orthogonal join-model/posting-policy axes; the legacy three-value enum is fully migrated with no read-access widening.
- Content visibility is `public`/`room_only`, derived by the single shared helper; private rooms force `room_only`; transitions are bounded, audited, and emit `content.visibility.changed`.
- Image and video posts are first-class submission types through the scan-gated, metadata-stripping pipeline, with required alt text and no autoplay.
- Global surfaces serve public content only; room surfaces serve the room pool behind the read bar; the distribution-side gate is always-on, fail-closed, and applies to ranked and fallback paths.
- The neutrality + containment CI gate proves no in-room leak and that visibility is not a ranking signal; the financial denylist and wallet↔ranking BFS isolation remain green.
- All client states pass WCAG 2.2 AA and the no-applause/prohibited-language gates; the offline cache is version-bumped and reconciles pre-WS-Q queued submissions.
- The migration is idempotent, online-safe (expand/contract; CONCURRENTLY indexes; batched backfills), resumable where it sweeps, and validated by the monotonic-visibility harness; the user-visible surface is feature-flagged and reversible while containment and the read bar are unconditionally enforced.
- `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm lint:security`, `pnpm check:deps`, `pnpm check:workspace-deps`, `pnpm check:no-applause`, `pnpm check:no-raw-egress`, `pnpm check:neutrality`, and `pnpm check:policy` all pass; docs are updated in the same change set and the PATCH version is bumped.

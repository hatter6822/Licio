# WS-Q: Content–Room Ownership and Visibility

**Milestone:** M3 (remodel of shipped M1–M3 surfaces) | **Priority:** P1 | **Dependencies:** WS-F (ingestion), WS-G (forum/rooms), WS-I (ranking) — all complete; WS-E (topic registry) for the new event topic | **Wave:** 9 (first post-WS-I workstream; lands before WS-J queue ownership) | **Estimated duration:** 3-4 weeks

---

## Overview

WS-Q implements the SPEC v0.7 structural model (Sections 3.4, 14.1, 14.5, 16.1–16.2, 21.3, 22.1, 23.2):

    Room  ⊃  Content (story)  ⊃  Thread  ⊃  Contributions

1. **Rooms own content.** Every content item — link story, original brief, **image post**, **video post**, question, evidence card, local update, live thread — is posted in exactly one **home room**, chosen at submission. There is no room-less content. Today stories are global and reach rooms only through the thread's nullable `room_id`; WS-Q makes `Story.room_id` authoritative and NOT NULL, with `Thread.room_id` denormalized from it.
2. **Content owns conversation.** Already structurally true (one thread shell per story, WS-F.1); WS-Q ties the thread's room to the owning story and documents the ownership contract.
3. **Two-tier visibility.** Room visibility becomes **binary** (`public | private`), replacing the conflated three-value `public | restricted | expert_led` enum; the old values' membership and posting semantics move to two new orthogonal axes, `join_model` and `posting_policy`. Content visibility is `public | room_only`, derived per SPEC Section 14.5: a private room **forces** `room_only`; a public room lets the author choose, defaulting to `public`.
4. **The front page is the public tier's showcase.** Global surfaces (front page, `?topic=`, global search, cross-room recommendation) serve only `public` content from public rooms; room surfaces serve the room's full pool to users who pass the room read bar. WS-I already enforces the room read bar on the distribution side (`roomContentVisibleToUser`); WS-Q extends that bar to item-level visibility and adds the containment test suite.
5. **Native media content.** Image and video posts ride the WS-G.4.4 upload pipeline (content-type allowlist, byte-level metadata stripping, scan gate, required alt text), extended with video containers.

The behavior-preserving migration maps existing data onto the new model: `restricted` rooms → `private` + `request_approval`; `expert_led` rooms → `private` + `request_approval` + `experts_and_stewards` (preserving their current read gating exactly); `public` rooms stay public with `open` join; stories backfill `room_id` from their thread's room, or into the system **Commons** room when no room exists; stories in private rooms backfill `visibility = room_only`, all others `public`. Net effect for existing data: nothing becomes more visible, and nothing publicly visible disappears.

### Conventions for this workstream

- **Fail-closed visibility.** Wherever visibility cannot be established (unknown room, unreadable row, missing flag), the item is EXCLUDED from the surface. Unknown ⇒ private. This mirrors the WS-I safety-filter posture.
- **404-over-403.** Private-room content reads return 404 to outsiders and pending applicants, never 403 (WS-D.1.6a house rule). Tier one (room existence) is the only thing a non-member can see.
- **No contribution-level visibility.** Contributions inherit reach from their thread's story and room; there is no per-contribution visibility flag. The room read bar (one function) gates every read.
- **No-applause invariant.** No task introduces likes, votes, karma, reactions, or follower mechanics; "popular" on the front page means PWAtt-ranked participation-weighted attention under the Section 13 constraints, computed exactly as today.
- **Identity-free privacy (Section 19.1).** No task reads or stores IP addresses or geolocation. Visibility checks key on account membership only.
- **Private ≠ secret.** Every private-room surface states the SPEC Section 14.5.7 honest limits: distribution-bounded, not end-to-end encrypted, reachable by moderation and legal process. No task may describe private rooms as "encrypted" or "secret".
- **Tier-scoped dedup canon (Section 14.5.6).** Public tier: at most one public story per canonical URL (global). Room tier: at most one `room_only` story per `(canonical_url, room_id)`. An in-room item never blocks a public submission; cross-tier pairs link.
- **Schema canon.** `Room.visibility ∈ {public, private}`; `Room.join_model ∈ {open, request_approval, invite}`; `Room.posting_policy ∈ {all_members, experts_and_stewards}`; `Story.visibility ∈ {public, room_only}`; `Story.room_id` NOT NULL FK; `Story.media_upload_ref` nullable FK to `uploads`. New submission types: `image_post`, `video_post`. New event topic: `content.visibility.changed`.
- **Financial denylist unchanged.** No new table or column may carry a financial field (WS-F.2.5b assertion + the wallet↔ranking BFS proof re-run in CI on the modified schemas).
- **Monorepo atomicity.** Client and server ship together; wire-shape changes (room visibility values, FeedItem additions) land in `@licio/shared` first and both sides consume the same schemas. Offline caches bump their record-schema version so stale cached shapes are evicted, never mis-parsed.

---

## WS-Q.1 Schemas, storage, and migration

### WS-Q.1.1 Room schema canon: binary visibility + join model + posting policy
**ID:** WS-Q.1.1
**Ref:** Sections 16.1, 16.2, 22.1

**Description:**
Rework the shared room contracts in `packages/shared/src/schemas/room.ts`. Replace `ROOM_VISIBILITIES = ['public','restricted','expert_led']` with `['public','private']`, and add two new closed enums: `ROOM_JOIN_MODELS = ['open','request_approval','invite']` and `ROOM_POSTING_POLICIES = ['all_members','experts_and_stewards']`. Extend `roomSummarySchema`/`roomDetailSchema` with `join_model` and `posting_policy`; extend `roomCreateRequestSchema` (all six type branches) with optional `join_model`/`posting_policy` defaulted per visibility (`public → open`, `private → request_approval`; posting defaults `all_members`). Keep the steward-room refinement, retargeted: steward rooms must be `private`. Add a `superRefine` rejecting incoherent combinations (`public` + `invite` is rejected — public rooms are open-join by definition; `public` + `request_approval` is rejected for the same reason). Export a pure legacy-mapping helper `mapLegacyRoomVisibility(v: 'public'|'restricted'|'expert_led'): { visibility, join_model, posting_policy }` (public→{public, open, all_members}; restricted→{private, request_approval, all_members}; expert_led→{private, request_approval, experts_and_stewards}) as the single source of truth the migration and any compatibility shim both use.

**Acceptance criteria:**
- `roomVisibilitySchema` accepts exactly `public|private`; the old values fail parsing.
- `join_model` and `posting_policy` are present on every room wire projection, with documented defaults applied at create time.
- Steward rooms cannot be public (schema-level rejection, as today).
- `public` rooms can only be `open` join; `private` rooms can be `request_approval` or `invite`.
- `mapLegacyRoomVisibility` is total over the three legacy values and is property-tested to never widen read access (restricted/expert_led both map to `private`).
- No applause/financial field appears on any room shape (denylist tests stay green).

**Testing:**
- Unit: parse/reject matrices for visibility × join_model × posting_policy combinations.
- Unit: legacy-mapping table test (3 rows, exact expected triples).
- Unit: existing room schema tests updated; `zod` inference type assertions for the new fields.

**Dependencies:** None (shared package leaf). Blocks every other WS-Q task that touches rooms.

---

### WS-Q.1.2a Story submission schemas: home room + visibility on every type
**ID:** WS-Q.1.2a
**Ref:** Sections 14.1, 14.5, 22.1, 23.2

**Description:**
Extend the shared §14.1 submission discriminated union (`packages/shared/src/schemas/` story submission contracts) so EVERY branch carries `room_id` (uuid, **required**) and `visibility` (`storyVisibilitySchema = z.enum(['public','room_only'])`, optional, default `'public'`). Add `storyVisibilitySchema` and export the derivation helper `deriveStoryVisibility(roomVisibility, requested?): 'public'|'room_only'` implementing SPEC Section 14.5 exactly: private room ⇒ `room_only` regardless of the request; public room ⇒ requested value, defaulting to `public`. The helper is pure and is the ONLY place the rule lives (server guard chain and client composer both call it). Extend the story/feed wire projections (`StoryDetail`, submission receipts) with `room_id` and `visibility`.

**Acceptance criteria:**
- Submission payloads without `room_id` fail validation with a structured per-field error on every one of the eight type branches.
- `deriveStoryVisibility('private', 'public') === 'room_only'` (forcing, never an error — the composer locks the choice; the server silently derives, and logs a metric when a mismatch was requested).
- `deriveStoryVisibility('public', undefined) === 'public'` (default-public in public rooms).
- Wire projections expose `room_id` + `visibility`; no projection leaks room-membership data.
- Client and server import the same module (no drift).

**Testing:**
- Unit: derivation table test (all 2×3 room-visibility × request combinations).
- Unit: per-branch required-`room_id` rejection (8 tests).
- Unit: projection parse round-trips.

**Dependencies:** WS-Q.1.1 (room visibility enum).

---

### WS-Q.1.2b Media submission types: `image_post` and `video_post`
**ID:** WS-Q.1.2b
**Ref:** Sections 14.1, 14.2, 15.5

**Description:**
Add two new branches to the §14.1 submission union: `image_post` (`upload_id` uuid required — a WS-G upload record in `clear` scan state owned by the submitter; `alt_text` required, 1–1,000 chars; `title`; `topic`) and `video_post` (`upload_id` required; `title`; `topic`; `captions_text` optional ≤ 20,000 chars or `captions_upload_id` optional). Mirror the two values into the shared `submissionType` enum and types. Neither branch carries `canonical_url`; both are exempt from URL normalization/dedup (WS-Q.2.2 scopes dedup to link stories) and from crawling/extraction (`extraction_state = not_applicable`). Document the §22.1 field `Story.media_upload_ref` as the storage-side pointer the API layer resolves from `upload_id`.

**Acceptance criteria:**
- `image_post` without `alt_text` fails validation (WCAG: alt text is required, not optional, for image content).
- `video_post` accepts captions as inline text or a second upload reference, not both.
- Both branches require `room_id` like every other type (WS-Q.1.2a).
- The submission union still rejects unknown types; the enum order is appended-only (no reordering of existing values).

**Testing:**
- Unit: valid/invalid payloads per branch (missing alt text, both captions fields, missing upload_id).
- Unit: type-inference assertions for the new branches.

**Dependencies:** WS-Q.1.2a.

---

### WS-Q.1.3 Rooms migration: enum split with USING maps
**ID:** WS-Q.1.3
**Ref:** Sections 16.1, 16.2, 22.1

**Description:**
Drizzle migration (next number in the chain; referred to here as `001A`) reworking `packages/db/src/schema/room.ts` + generated SQL: recreate the room visibility enum as `('public','private')` with a `USING` map (`restricted → private`, `expert_led → private`) following the 0008 enum-recreation precedent; add `join_model` (enum, NOT NULL) and `posting_policy` (enum, NOT NULL) columns backfilled from the OLD visibility value via `mapLegacyRoomVisibility` semantics expressed in SQL (`public → open/all_members`, `restricted → request_approval/all_members`, `expert_led → request_approval/experts_and_stewards`); add CHECK constraints `(visibility = 'private' OR join_model = 'open')` and `(room_type <> 'steward' OR visibility = 'private')`. The backfill and the enum map run in one transaction so no row is ever observable in a mixed state.

**Acceptance criteria:**
- Migration runs green on a database seeded with all three legacy visibility values and verifies the mapped triples row-by-row.
- CHECKs reject `public` + `request_approval`, `public` + `invite`, and public steward rooms at the storage layer.
- Down migration restores the legacy enum (private + all_members → restricted; private + experts_and_stewards → expert_led) — documented as lossy only for rooms created post-migration with `invite`.
- The drizzle schema file mirrors the shared enums exactly (storage-layer defense in depth, the WS-E house pattern).

**Testing:**
- Gated integration (Postgres): real migration chain run; seeded legacy rows assert mapped values; CHECK violation tests.
- Unit: schema mirror test (db enum values === shared enum values).

**Dependencies:** WS-Q.1.1.

---

### WS-Q.1.4 Stories migration: home room, visibility, media ref, tier-scoped uniqueness
**ID:** WS-Q.1.4
**Ref:** Sections 14.5, 22.1

**Description:**
Migration `001B` on `packages/db/src/schema/story.ts`: (1) add `room_id` uuid FK → `rooms` (nullable at first); (2) add `visibility` enum `('public','room_only')` NOT NULL DEFAULT `'public'`; (3) add `media_upload_ref` uuid FK → `uploads` (nullable; set only for media posts); (4) extend `story_submission_type` with `image_post`, `video_post` (`ALTER TYPE ... ADD VALUE`, appended); (5) backfill `room_id` from the story's branch-0 thread's `room_id` where present, else the Commons room (WS-Q.1.6 creates it earlier in the same chain); (6) backfill `visibility = 'room_only'` for every story whose home room is `private` (post-WS-Q.1.3 mapping); (7) set `room_id` NOT NULL; (8) replace the global canonical-URL partial unique index with the tier-scoped pair: `UNIQUE (canonical_url) WHERE canonical_url IS NOT NULL AND visibility = 'public' AND hidden_state IS NULL` and `UNIQUE (canonical_url, room_id) WHERE canonical_url IS NOT NULL AND visibility = 'room_only' AND hidden_state IS NULL`; (9) add indexes `(room_id, created_at)` and `(visibility, lifecycle_state)` for room feeds and global retrieval; (10) add `canonical_public_story_id` uuid NULL FK → `stories` (the cross-tier link WS-Q.2.2 sets so an in-room item can point at the canonical public story for the same URL; self-referential, ON DELETE SET NULL).

**Acceptance criteria:**
- After migration, `SELECT count(*) FROM stories WHERE room_id IS NULL` = 0 on any seeded dataset.
- A story whose thread pointed at a legacy `restricted`/`expert_led` room ends `room_only`; thread-roomed public stories and previously room-less stories end `public` (no item becomes MORE visible than before; no public item disappears).
- Duplicate-URL semantics: two public stories with one canonical URL are impossible; the same URL may exist `room_only` in two different rooms; a `room_only` row does not block a public insert (race-safety preserved through the partial unique indexes, as in WS-F.1.3a).
- Down migration drops the new columns/indexes and restores the global unique index, documented as valid only when no tier-duplicate URLs were created.

**Testing:**
- Gated integration: migration chain on seeded data covering every backfill branch; uniqueness race test (concurrent public inserts of one URL — exactly one wins with 409 semantics at the service layer).
- Unit: schema mirror test for the new enums/columns.

**Dependencies:** WS-Q.1.3, WS-Q.1.6 (Commons room exists before backfill).

---

### WS-Q.1.5 Threads: denormalized room consistency
**ID:** WS-Q.1.5
**Ref:** Sections 3.4, 22.1

**Description:**
Migration `001C` + storage contract: backfill `threads.room_id` from the owning story's new `room_id`, set NOT NULL, and keep it consistent thereafter (the thread is created in the story's home room at submission; a story can change rooms only through the explicit move/repost path, out of scope for v1 — documented). Add a lightweight consistency trigger (or a CHECK-equivalent trigger function) rejecting an INSERT/UPDATE where `threads.room_id` differs from the owning story's `room_id`. Update `threadSummarySchema.room_id` from nullable to required in `@licio/shared`, and sweep the API/forum/ranking code paths that handled `room_id: null` (the WS-I retrievers' `thread?.roomId ?? null` branches become dead and are removed).

**Acceptance criteria:**
- No nullable-room thread remains; the wire schema requires `room_id`.
- Trigger rejects divergent thread/story rooms with a typed error surfaced as a 500-class integrity failure (this is a programming-error guard, not a user path).
- All call sites that special-cased room-less threads are removed; typecheck is the proof (the nullable type is gone).

**Testing:**
- Gated integration: backfill correctness; trigger rejection.
- Unit: updated thread schema parse tests; retriever tests updated for non-null rooms.

**Dependencies:** WS-Q.1.4.

---

### WS-Q.1.6 The Commons room, seed, and demo data
**ID:** WS-Q.1.6
**Ref:** Sections 3.4, 14.5

**Description:**
Create the system **Commons** room — a public `global_topic` room with the reserved slug `commons`, `open` join, `all_members` posting — as the home for pre-WS-Q room-less stories and the default suggestion for new submitters. Creation is an idempotent seed inside the migration chain (insert with a pinned UUID, `ON CONFLICT DO NOTHING`) so the WS-Q.1.4 backfill can target it deterministically in the same chain, plus a boot-time idempotent ensure (mirroring the demo-seed pattern) for fresh in-memory stores. Reserve the slug (`commons` joins the route/slug reserved list). Update `apps/api/src/lib/demo-data.ts` / `demo-seed.ts`: every demo story gets a home room (stable demo room ids), demo rooms carry the new fields, and at least one demo private room with `room_only` content exists so every gated read path is exercised by the dev stack.

**Acceptance criteria:**
- Running migrations on an empty database, on a seeded database, and twice in a row each yield exactly one Commons room with the pinned id.
- Room creation by users rejects the reserved slug.
- Demo seed produces: ≥ 1 public room with public + `room_only` stories, ≥ 1 private room with forced-`room_only` stories, and the Commons.
- In-memory stores (tests, demo mode) expose the same Commons via the boot ensure.

**Testing:**
- Gated integration: idempotency (run twice), pinned id stability.
- Unit: demo-seed shape assertions; reserved-slug rejection.

**Dependencies:** WS-Q.1.3 (room columns exist). Blocks WS-Q.1.4.

---

### WS-Q.1.7 `content.visibility.changed` topic + audit taxonomy
**ID:** WS-Q.1.7
**Ref:** Sections 14.5, 21.3, 22.4

**Description:**
Add the `content.visibility.changed` topic to the WS-E topic registry (`packages/shared/src/schemas/events/`): payload `{ story_id, room_id, from: 'public'|'room_only', to: 'public'|'room_only', trigger: 'author'|'room_visibility_change'|'migration', actor_ref? }`, standard envelope, `operational` retention tier (it carries no attention data), core (non-Knomosis) classification. Extend the shared audit-event taxonomy with `story_visibility_change` and `room_visibility_change` (+ the db audit enum extension migration, following the 0013 precedent). The topic count assertions in the registry tests move from 14 to 15 core topics.

**Acceptance criteria:**
- Discriminated-union event parsing accepts the new topic and still rejects unknown topics.
- Registry SSOT lists 15 core topics; the count-pinning tests are updated in the same commit.
- The topic is NOT subscribable by scoring consumers in any way that could create a visibility-keyed ranking signal — it is a cache-invalidation/audit topic; the pay-to-rank firewall tests are extended to assert the new topic carries no financial fields (trivially true) and the payload never includes attention values.
- Audit enum migration extends, never rewrites, the existing enum.

**Testing:**
- Unit: schema parse/reject; registry count; envelope round-trip.
- Gated integration: audit enum migration.

**Dependencies:** WS-Q.1.2a (visibility values).

---

## WS-Q.2 Submission and ingestion (WS-F deltas)

### WS-Q.2.1 Submission guard chain: room, membership, posting policy, derived visibility
**ID:** WS-Q.2.1
**Ref:** Sections 14.1, 14.5, 16.1, 23.2

**Description:**
Extend `apps/api/src/ingestion/submission.ts` (`POST /v1/stories`). New guards, inserted after auth and before the existing WS-F pre-checks, in order: (1) the destination room exists (404 on unknown id — never confirm/deny beyond tier one); (2) the submitter passes the room read bar AND holds `active` membership (public rooms: membership granted on join — the route auto-joins on first submission with the user's consent flag from the composer; private rooms: pending applicants 404); (3) the room's `posting_policy` admits the submitter for top-level content (`experts_and_stewards` checks the steward table + the expert-lens assignment seam; violation → 403-equivalent 404-over-403 per house rule, with a distinct in-room error for members who can read but not post); (4) `visibility = deriveStoryVisibility(room.visibility, requested)` — the SHARED helper, never re-implemented. The transactional story+thread insert stamps `room_id` on both rows and `visibility` on the story. `content.submitted` gains `room_id` + `visibility` payload fields (additive registry change).

**Acceptance criteria:**
- Submission without a readable room: 404. Readable-but-not-postable: a structured error distinguishing "join to post" (public, not yet member) from "posting is steward/expert-led here" (members who cannot post) — both without leaking private-room internals to outsiders.
- A request asking `public` in a private room is accepted and stored `room_only` (forced derivation; a `visibility_forced` counter increments — no user error, the composer locks the control client-side).
- The thread shell lands in the same room transactionally (both-or-neither).
- The existing WS-F pre-checks (rate limits, account-age, spam-title, malware denylist) run unchanged after the new guards.
- `content.submitted` consumers (lifecycle, search index, ranking feature population) receive the new fields; the registry change is additive and parse-tested.

**Testing:**
- Unit (service level): guard-order table tests — each guard fires before the next; forced-derivation metric.
- Unit: 404-over-403 for private rooms (outsider, pending, member matrices).
- Integration: transactional both-or-neither story+thread insert with room stamping.

**Dependencies:** WS-Q.1.2a, WS-Q.1.4, WS-Q.1.5, WS-Q.3.2 (read bar).

---

### WS-Q.2.2 Tier-scoped duplicate detection
**ID:** WS-Q.2.2
**Ref:** Section 14.5.6

**Description:**
Rework `apps/api/src/ingestion/dedup.ts` + the submission 409 path. Exact-URL: the public tier keeps the global 409-through-the-normalizer behavior, now scoped `WHERE visibility = 'public'` (backed by the WS-Q.1.4 partial unique index, race-safe as today); a `room_only` submission 409s only against a `room_only` story with the same canonical URL in the SAME room. Cross-tier: a `room_only` submission whose URL matches an existing public story succeeds and records a `canonical_public_story_id` link on the story row (one nullable uuid column, added in WS-Q.1.4's migration file); a public submission whose URL matches only `room_only` rows succeeds, becomes the canonical public story, and back-links existing in-room rows opportunistically (batched update, no transaction coupling). Near-duplicate (MinHash/LSH) and syndication classification scope their candidate queries to the PUBLIC tier only — in-room content never feeds public near-dup clusters and is never flagged against them (room-tier near-dup detection is explicitly out of scope for v1; documented).

**Acceptance criteria:**
- Public/public same URL: 409 (unchanged). Room-only/room-only same URL same room: 409. Room-only same URL different rooms: both live. Room-only then public: public succeeds + back-link. Public then room-only: room-only succeeds + forward link.
- LSH band queries filter `visibility = 'public'`; signatures are still computed and stored for all stories (so a later widen can join the public clusters without recompute).
- The story read surface exposes "a public conversation about this link exists" on in-room items carrying the link (wire field on `StoryDetail`, room-readers only).

**Testing:**
- Unit: the five URL-collision matrix cases above.
- Gated integration: concurrent insert races per tier against the partial unique indexes.
- Unit: LSH candidate queries exclude `room_only` rows (seeded store).

**Dependencies:** WS-Q.1.4, WS-Q.2.1.

---

### WS-Q.2.3a Image-post intake
**ID:** WS-Q.2.3a
**Ref:** Sections 14.1, 14.2, 15.5

**Description:**
Wire `image_post` submissions through the WS-G.4.4 upload pipeline: the composer uploads first (existing `/v1/uploads` surface — EXIF/GPS/XMP stripped at byte level, content-type allowlist, scan gate), then submits the story referencing `upload_id`. The submission guard verifies: the upload exists, is owned by the submitter, is an image type, is in `clear` scan state (a `pending` scan holds the story in the WS-F review-hold path rather than rejecting; `flagged` rejects), and is not already claimed by another story or contribution. On success the story stores `media_upload_ref`; `extraction_state = 'not_applicable'`; `media_type = 'image'`. Serving rides the existing scan-gated upload read path. Alt text from the payload is stored as the story's accessibility text and required at render.

**Acceptance criteria:**
- Story creation with an unscanned upload lands in the review-hold state (fail-toward-caution), never published-then-hidden.
- A claimed upload cannot anchor a second story (uniqueness guard).
- The stored image never retains EXIF/GPS (pipeline already proves this; the new test asserts it end-to-end through the story path).
- Story cards and the story page render the image only through the gated upload URL with the required alt text.

**Testing:**
- Unit: ownership/type/scan-state guard matrix.
- Integration: end-to-end submit → stored story → gated serving; EXIF-absence assertion on served bytes.

**Dependencies:** WS-Q.1.2b, WS-Q.2.1.

---

### WS-Q.2.3b Video-post intake (validate-only v1)
**ID:** WS-Q.2.3b
**Ref:** Sections 14.1, 14.2, 15.5

**Description:**
Extend the upload pipeline's allowlist with video containers — `video/mp4` (H.264/AAC) and `video/webm` (VP9/Opus) — behind strict caps (default: ≤ 200 MB, ≤ 10 minutes where duration is cheaply readable from container metadata; runtime-config keys `ingestion.video_max_bytes` / `ingestion.video_max_seconds`, fail-closed loader). v1 is **validate-only**: byte-level container sniffing (magic numbers + box/EBML structure sanity), metadata stripping limited to droppable container-level tags (MP4 `udta`/location boxes; WebM `Tags`) without re-encoding, scan-gate seam (the `UploadScanner` interface already gates attachment and serving), and NO transcoding (documented trade-off: codec compatibility is the submitter's responsibility; the player shows a fallback message for undecodable streams). The uploads-table content-type CHECK is extended by migration. Serving uses range requests through the gated read path; playback is a native `<video>` element with `controls`, no autoplay (autoplay can never feed PWAtt — re-asserted by the no-raw-egress/cap tests).

**Acceptance criteria:**
- Disallowed containers/types are rejected at upload by both the allowlist CHECK and the byte sniffer (extension/mime spoofing is caught by content sniffing, not headers).
- Location metadata in MP4 boxes (e.g. `©xyz`) is stripped before storage.
- Oversize/overlong uploads are rejected pre-storage with structured errors; the caps are runtime-tunable with write-time 422 validation like other config keys.
- Autoplay is absent; dwell on a video post follows the standard §5.3 caps (no per-second video credit).

**Testing:**
- Unit: sniffer fixtures (valid mp4/webm; spoofed extensions; corrupt boxes); metadata-strip assertions on crafted fixtures.
- Unit: config loader fail-closed on invalid caps.
- Integration: upload → submit → ranged serving round-trip.

**Dependencies:** WS-Q.2.3a (shared intake path).

---

### WS-Q.2.4 Visibility transition service
**ID:** WS-Q.2.4
**Ref:** Section 14.5.2

**Description:**
New service + endpoints for bounded, audited visibility transitions. `PATCH /v1/stories/{id}/visibility` (author-only; 404-over-403): **narrow** `public → room_only` always allowed; **widen** `room_only → public` allowed only when the home room is public, and re-runs the public-admission checks synchronously — tier-scoped exact-URL dedup (409 if a public story now holds the URL; the response offers the existing story), spam-title/malware pre-checks, freshness-baseline (re)initialization, and search/feature reindex enqueue. Every transition writes the audit log (`story_visibility_change`) and emits `content.visibility.changed` with the correct `trigger`. Narrowing propagates synchronously to the search index row's visibility column and asynchronously (next serve) to candidate pools — the serving-side bar (WS-Q.4.2) makes the gap safe.

**Acceptance criteria:**
- Author-only; editors/stewards cannot change another author's item visibility through this endpoint (room privacy flips are WS-Q.3.4's separate, steward-audited cascade).
- Widen in a private room: structurally impossible (422 citing Section 14.5.1).
- Widen that collides with an existing public URL: 409 + pointer to the canonical public story (no silent merge).
- Narrow is idempotent; repeated calls emit one event per actual state change only.
- Every transition row-locks the story (no lost updates under concurrent transitions).

**Testing:**
- Unit: transition matrix (narrow/widen × public/private room × URL-collision).
- Unit: idempotency + single-event emission; audit record contents.
- Integration: widen re-runs dedup against live partial indexes.

**Dependencies:** WS-Q.2.2, WS-Q.1.7.

---

### WS-Q.2.5 Search: tier-scoped global search + room-scoped search
**ID:** WS-Q.2.5
**Ref:** Sections 14.5.3, 14.5.4

**Description:**
Extend the WS-F search surfaces. Global search (`GET /v1/stories/search` and the embedding similarity helpers feeding public surfaces) adds `visibility = 'public'` to the server-side visibility predicate (alongside the existing takedown/safety-hidden/retracted exclusions) in BOTH adapters (in-memory FTS semantics and the Drizzle FTS). Room-scoped search (`?room=` parameter on the same endpoint) requires the caller to pass the room read bar, then searches that room's full pool (`public` + `room_only` of that room). Embedding similarity reads used by GLOBAL surfaces (related stories, claim similarity on public pages) filter to the public tier; room-surface similarity (if requested by a room reader) may include that room's pool only. The keyset pagination contract is unchanged.

**Acceptance criteria:**
- A `room_only` story never appears in any global search result, FTS or vector, in either adapter (seeded adversarial test: identical title public + room_only — only the public row returns globally).
- `?room=` without read-bar passage: 404 for private rooms (existence is tier one; content search is tier two).
- Room search returns the room's `room_only` rows to members and excludes other rooms' content entirely.
- Query building remains tokenization-only (injection posture unchanged).

**Testing:**
- Unit: both adapters' predicate tests; the adversarial twin-title test.
- Gated integration: Drizzle FTS with the new predicate; room-scoped pagination round-trip.

**Dependencies:** WS-Q.1.4, WS-Q.3.2.

---

### WS-Q.2.6 Takedown and moderation reach into the room tier
**ID:** WS-Q.2.6
**Ref:** Sections 14.5.7, 18, 16.4

**Description:**
Verify and close the moderation-reach paths over in-room content: the public takedown intake accepts URLs/ids that resolve to `room_only` stories (the intake never confirms existence to the reporter beyond the standard receipt); steward takedown actioning hides a `room_only` story from its room exactly as it hides public stories from everywhere (`hidden_state` already serves this — add the room-feed exclusion test); the WS-F review queue, the WS-G moderation-concern flow, and the WS-E safety states all operate identically on room-tier content. No moderation surface filters by visibility: stewards with platform-scope roles see held/flagged items from private rooms in their queues (room privacy never shields content from the review pipeline — SPEC Section 16.1).

**Acceptance criteria:**
- Takedown actioning on a `room_only` story removes it from the room feed, room search, and direct reads (404), with the audit trail intact.
- Review-queue listings include private-room items for platform stewards; room-level stewards see their own room's items.
- The moderation-concern intake works from private-room threads end-to-end.

**Testing:**
- Unit: hidden-state exclusion on the room feed/search paths.
- Integration: takedown → actioning → all-surface exclusion for a `room_only` story.

**Dependencies:** WS-Q.2.1, WS-Q.4.1.

---

## WS-Q.3 Forum, rooms, and the read bar (WS-G deltas)

### WS-Q.3.1 Room read bar: binary visibility + join model + posting policy
**ID:** WS-Q.3.1
**Ref:** Sections 16.1, 16.2

**Description:**
Adapt the two existing bar functions in `apps/api/src/forum/rooms.ts` to the new model WITHOUT changing their call sites' contract. `roomVisibleToUser` (tier one — existence) returns true for `public` rooms and for `private` rooms where the user has any subscription (active OR pending) or a steward role — unchanged logic, retargeted to the binary enum. `roomContentVisibleToUser` (tier two — content) returns true for `public` rooms and for `private` rooms with ACTIVE membership or a steward role — unchanged logic, retargeted. Add `userMayPostTopLevel(room, userId)`: `true` when the user passes the content bar AND (`posting_policy === 'all_members'` OR the user holds a steward role OR an expert-lens assignment for the room). Rewrite `joinRoom` against `join_model`: `open` → immediate `active`; `request_approval` → `pending`; `invite` → reject self-join with a "this room is invite-only" outcome (invitations are a separate steward action, seam stubbed for WS-J). The functions remain the single chokepoint; no route re-implements the predicate.

**Acceptance criteria:**
- Behavior parity for migrated rooms: a former `restricted` room (now `private` + `request_approval`) gates reads exactly as before; a former `expert_led` room additionally blocks non-expert top-level posting via `userMayPostTopLevel`.
- `joinRoom` honors all three join models; `invite` rooms reject self-join cleanly.
- Signed-out users pass neither bar for private rooms and see only tier one.
- The directory listing still shows private rooms at tier one (existence) with VISIBLE-only (now public-only) thread counts.

**Testing:**
- Unit: bar truth tables across visibility × membership-state × steward × join_model.
- Unit: `userMayPostTopLevel` across posting_policy × role.
- Integration: join flows per join model.

**Dependencies:** WS-Q.1.1, WS-Q.1.3.

---

### WS-Q.3.2 Item-level read bar: thread/contribution/story reads honor story visibility
**ID:** WS-Q.3.2
**Ref:** Sections 14.5.3, 15.3

**Description:**
Extend the read gate so that reaching a story/thread requires passing BOTH the room content bar AND the item's visibility: a `room_only` story is readable only by users who pass `roomContentVisibleToUser` for its home room; a `public` story is readable by anyone who can reach its room (public rooms: everyone). Because a `public` story can only live in a public room (a private room forces `room_only`), the item bar reduces to: "public story ⇒ room is public ⇒ readable; room_only story ⇒ active membership/steward." Implement as a single `storyReadableByUser(story, room, userId)` helper used by `GET /v1/stories/{id}`, the thread reads (`threadVisibleToUser` composes it), the branch/subtree reads, and the contribution reads. Fail-closed: unknown room or story ⇒ not readable ⇒ 404.

**Acceptance criteria:**
- A `room_only` story in a private room: 404 for outsiders and pending applicants; 200 for active members and stewards.
- A `public` story: 200 for anyone (its room is necessarily public).
- Thread, branch, subtree, and contribution reads all 404 when the owning story is unreadable (no partial leakage of contribution bodies).
- The helper is the only place the rule lives; call sites pass through it.

**Testing:**
- Unit: `storyReadableByUser` truth table.
- Integration: every read endpoint returns 404 for an unreadable `room_only` story (story, thread, branch, subtree, contribution — 5 paths).

**Dependencies:** WS-Q.3.1, WS-Q.1.4, WS-Q.1.5.

---

### WS-Q.3.3 Room creation and governance: visibility/join/posting writes
**ID:** WS-Q.3.3
**Ref:** Sections 16.1, 16.2, 16.4

**Description:**
Update `apps/api/src/routes/rooms.ts` + `apps/api/src/forum/rooms.ts` room creation and the audited governance-settings writes to accept and validate `visibility`, `join_model`, and `posting_policy` (through the shared schema's coherence refinement). Creating a private room is allowed to any account within the existing room-creation rate limits; the creator becomes the first `community_steward`. Governance-settings updates may change `join_model` and `posting_policy` freely (audited); changing `visibility` is the WS-Q.3.4 cascade and routes through that path. The `RECOMMENDATION_INPUT_KEYS` transparency list is reviewed to confirm visibility/join/posting are NOT recommendation inputs (they gate eligibility; they never score) — add an assertion.

**Acceptance criteria:**
- Room creation accepts the new fields with documented defaults; incoherent combinations are rejected (422) by the shared schema.
- Governance writes for join/posting are audited (`room_governance_change`) with before/after.
- Visibility changes are NOT accepted through the generic governance write — they 422 with a pointer to the visibility-cascade endpoint.
- A test asserts visibility/join_model/posting_policy never appear in `RECOMMENDATION_INPUT_KEYS`.

**Testing:**
- Unit: create/validate matrices; governance-write audit contents.
- Unit: recommendation-input exclusion assertion.

**Dependencies:** WS-Q.1.1, WS-Q.3.1.

---

### WS-Q.3.4 Room visibility cascade: public ⇄ private
**ID:** WS-Q.3.4
**Ref:** Sections 14.5.2, 16.1

**Description:**
A dedicated steward-only, audited endpoint to flip a room's visibility, with the content cascade SPEC Section 14.5.2 mandates. **Public → private:** every `public` story in the room is forced to `room_only` (batched, row-locked, each emitting `content.visibility.changed` with `trigger: 'room_visibility_change'`); the room's content leaves all global surfaces on the next index/serve cycle; existing `active` memberships are retained, future joins become `request_approval` (the join_model is set to `request_approval` if it was `open`). **Private → public:** the room becomes readable by all, but **no content auto-publishes** — every story stays `room_only` until its author widens it (WS-Q.2.4); the join_model may be set to `open`. Both directions are a single audited transaction over the room row + a durable, resumable per-story sweep (the sweep is idempotent and lease-guarded, mirroring the WS-E/WS-F sweep pattern, so a crash mid-cascade resumes safely). A steward-facing confirmation states the consequence count ("N stories will leave public surfaces").

**Acceptance criteria:**
- Public → private: every story ends `room_only`; none remains on a global feed/search after reindex; one event per story; one room-audit record summarizing the count.
- Private → public: zero stories change visibility; the room becomes globally listable; authors can then widen individually.
- The cascade is resumable: interrupting it and re-running completes without double-emitting events for already-converted stories.
- Only stewards with the governance capability can invoke it; others 404.

**Testing:**
- Unit: cascade direction semantics; idempotent resume; per-story event emission.
- Integration: public→private reindex removes items from the global feed (composed with WS-Q.4.2); private→public leaves content in-room.

**Dependencies:** WS-Q.2.4, WS-Q.1.7, WS-Q.4.2.

---

### WS-Q.3.5 DSAR, anonymization, and conversation-health under the room tier
**ID:** WS-Q.3.5
**Ref:** Sections 14.5.7, 19.3

**Description:**
Confirm and extend the WS-D/WS-G privacy hooks for room-tier content. `exportContributions` (DSAR Art. 15) returns the user's own stories and contributions **regardless of visibility**, including `room_only` items and private-room memberships, each tagged with its room and visibility (a user's own data is theirs to export even from private rooms — distribution bounds do not bound self-access). `anonymizeContributions` tombstones the user's room-tier contributions and removes private-room memberships/steward rows exactly as for public ones. Conversation-health rollups remain per-thread and owner/steward-facing only (never a ranking input) and are computed identically for room_only threads. Add tests proving DSAR completeness across both tiers.

**Acceptance criteria:**
- DSAR export includes `room_only` stories/contributions and private-room subscriptions, each carrying `room_ref` + `visibility`.
- Account purge tombstones room-tier content and strips private-room memberships (membership is personal data, WS-D.2.4 rule).
- Health metrics compute for room_only threads and never enter ranking.

**Testing:**
- Unit: DSAR composition includes both tiers (seeded fixture with one private-room contribution).
- Unit: purge removes private-room membership rows.

**Dependencies:** WS-Q.3.2.

---

## WS-Q.4 Ranking and distribution (WS-I deltas)

### WS-Q.4.1 Candidate carries visibility; retrievers are visibility-scoped
**ID:** WS-Q.4.1
**Ref:** Sections 13.2, 14.5.3

**Description:**
Add `visibility: 'public' | 'room_only'` to the strict `Candidate` stage-boundary schema (`packages/ranking/src/schemas/candidate.ts`) and populate it from the story row in every retriever and in the feature-store join. Scope each retriever's pool query by SURFACE: the eight organic retrievers that feed GLOBAL surfaces (front page, topic) query `WHERE visibility = 'public'` (and, as today, not hidden/archived); the `room_surface_v1` scoper queries the target room's full pool (`public` + `room_only`). The orchestrator's strict-boundary re-validation now also asserts `visibility` is present. The "PWAtt-threshold global", "constructive-velocity emerging", "seen-story evidence additions", "SCOI bridge", and "expert-led explanations" retrievers all gain the public predicate; the "subscribed rooms" and "per-room chronological catch-up" retrievers feed only room-eligible content and keep their room scoping.

**Acceptance criteria:**
- Every `Candidate` carries `visibility`; the boundary schema rejects a candidate without it.
- Global-surface retrievers never emit a `room_only` candidate (seeded adversarial test: a `room_only` story matching every retriever's criteria appears in NONE of them).
- The room scoper emits the room's `room_only` items (for a reader who passes the bar).
- Subscribed-rooms retriever: a user's subscription to a private room surfaces that room's `room_only` items into the user's room-eligible candidate set but NEVER onto the front page (the front-page assembly drops them — WS-Q.4.2).

**Testing:**
- Unit: per-retriever visibility-predicate tests; the adversarial `room_only` exclusion sweep across all eight.
- Unit: candidate boundary rejects missing `visibility`.

**Dependencies:** WS-Q.1.4, WS-Q.5-none (pure-ish; uses retriever ports).

---

### WS-Q.4.2 Distribution-side visibility bar: surface-aware containment
**ID:** WS-Q.4.2
**Ref:** Sections 13.2, 14.5.3

**Description:**
Extend `filterByRoomVisibility` (rename to `filterByVisibility`) in `apps/api/src/ranking/service.ts` into a two-clause, surface-aware, fail-closed gate that runs on EVERY served request as the authoritative backstop (independent of retriever correctness — defense in depth, the WS-I posture): (1) **item-tier clause** — on `front_page` and `topic` surfaces, drop every candidate whose `visibility === 'room_only'` (global surfaces are public-only, Section 14.5); on `room` surfaces, keep `room_only` only for the surface's own room. (2) **room-bar clause** — the existing per-distinct-room `roomContentVisibleToUser` check, retained unchanged. The dead "room-less items pass through" branch is removed (every item now has a room; an item whose room is unknown fails closed). Each exclusion is logged with a reason (`item_visibility` vs `room_bar`). The chronological fallback runs the SAME gate (its candidate set is visibility-filtered identically), so paused ranking never widens reach.

**Acceptance criteria:**
- A `room_only` item cannot appear on `front_page` or `topic` even if a buggy retriever emits it (the gate drops it; covered by a test that force-injects one).
- On a `room` surface, the room's own `room_only` items pass (for a reader who passes the bar) and OTHER rooms' `room_only` items are dropped.
- Unknown-room items fail closed on every surface.
- The fallback path applies the identical gate; a neutrality-style test asserts fallback reach ⊆ ranked reach for visibility.
- Every drop is logged with a distinguishable reason; the decision log records the visibility-excluded count.

**Testing:**
- Unit: surface × visibility × room-membership matrix; force-injected `room_only` on front_page is dropped.
- Unit: fallback applies the gate (force-inject + assert absence).
- Integration: room feed shows own `room_only`, hides foreign `room_only`.

**Dependencies:** WS-Q.4.1, WS-Q.3.1.

---

### WS-Q.4.3 Feature store + decision log: visibility-aware, financially clean
**ID:** WS-Q.4.3
**Ref:** Sections 13.3, 22.4, 30.6

**Description:**
Thread visibility through the WS-I feature store and decision log without making it a SCORING input. The feature vector may record `visibility` as an eligibility/audit field (like the safety flags) but it MUST NOT enter PWAtt or any invariant join as a positive/negative weight (it gates candidacy, it never scores) — add it to the explicit "non-scoring eligibility fields" set the scoring stage ignores. The `RankingDecisionLog` records, per request, the surface, the visibility-excluded count, and per-item `visibility` (for replay fidelity); replay re-applies the surface-aware gate at the recorded surface so a replayed decision reproduces the served set exactly. The WS-I.2.1b financial denylist runs unchanged on the modified feature-store writes (no financial field is introduced; the BFS isolation proof and the db table denylist re-run on the new `stories` columns and the `Candidate`/feature shapes).

**Acceptance criteria:**
- `visibility` is present in the feature vector and the decision log but is provably ignored by `rankFeasibleSet` (a property test: flipping only `visibility` on already-eligible, same-room items never changes their relative order or scores).
- Replay reproduces the served ordering including the visibility gate at the recorded surface (backward-compatible: pre-WS-Q decision logs without `visibility` replay via a `public` default, since every pre-WS-Q served item was on a public surface).
- The financial denylist + BFS isolation tests pass on the new columns/shapes.

**Testing:**
- Unit: visibility-is-not-a-score property test; replay-with-default for legacy logs.
- Unit: denylist + isolation re-run green on the new schema.

**Dependencies:** WS-Q.4.2, WS-Q.1.4.

---

### WS-Q.4.4 Neutrality + containment test suite extension
**ID:** WS-Q.4.4
**Ref:** Sections 13.2, 14.5, 30.6

**Description:**
Extend the named ranking-neutrality CI gate (`pnpm check:neutrality`) and the ranking package suite with **content-containment** tests as first-class, transitive-closure-style assertions: (1) no global surface (front_page, topic, global search, embedding similarity feeding public pages) ever returns a `room_only` item, across ranked AND fallback paths, proven against a seeded store where every public-surface heuristic is satisfied by a planted `room_only` story; (2) the front-page/topic candidate UNION (all eight retrievers) is visibility-pure; (3) a private room's content is absent from a non-member's every surface (feed, search, story read, share preview); (4) widening (`room_only → public`) makes an item eligible and narrowing removes it on the next serve, asserted end-to-end; (5) visibility is not a ranking signal (the WS-Q.4.3 property test, lifted into the neutrality gate). These run alongside the existing ten WS-I.3 tests; the gate's documentation enumerates them as the containment leg.

**Acceptance criteria:**
- `pnpm check:neutrality` includes the containment leg and fails if any global surface leaks a `room_only` item.
- The transitive import-closure walk already used by neutrality test 8/9 is extended to assert the visibility predicate is applied on every global retrieval path (no path bypasses `filterByVisibility`).
- Tests cover ranked and fallback, front_page/topic/room/search surfaces.

**Testing:**
- The suite IS the test; CI runs it as a named step. Add fixtures to the ranking package and the api neutrality suite.

**Dependencies:** WS-Q.4.2, WS-Q.4.3, WS-Q.2.5.

---

## WS-Q.5 Client surfaces (WS-C/WS-B/WS-G deltas)

### WS-Q.5.1 Composer: home-room picker + visibility control
**ID:** WS-Q.5.1
**Ref:** Sections 6.3, 6.6, 14.5

**Description:**
Extend the submit flow (`apps/web/src/routes/submit.tsx` + the composer) with a required **home-room picker** (the user's joined rooms, postable-to per `posting_policy`, with the Commons as the default suggestion and a typeahead over discoverable rooms) and a **visibility control** (a two-option public/in-room toggle). The control is **locked to in-room and explained** when the chosen room is private ("This room is private — posts stay in the room"); it defaults to public in public rooms. The payload builder calls the SHARED `deriveStoryVisibility` so the client-shown value equals the server-derived value (no drift), and validates the whole payload through the shared submission schema. Image/video post modes (WS-Q.5.2) reuse the same picker/toggle. Encrypted-draft autosave persists the chosen room + visibility; share-target intake defaults the room to the last-used or Commons.

**Acceptance criteria:**
- Submitting without a room is impossible (the submit button is disabled with an accessible explanation until a room is chosen).
- Private-room selection visibly locks the toggle to in-room and never lets the user request public (matches server forcing).
- The displayed final visibility equals what the server will store for every room/choice combination (shared-helper parity, asserted in a test).
- Draft autosave/restore round-trips room + visibility; accessibility (labels, focus, 200% reflow) holds on the new controls.

**Testing:**
- Unit (jsdom): picker disabled-state, private-room lock, derivation parity.
- E2E (workbench/preview): compose → room+visibility shown → payload matches; axe on the new controls.

**Dependencies:** WS-Q.1.1, WS-Q.1.2a.

---

### WS-Q.5.2 Image/video post composer modes + media rendering
**ID:** WS-Q.5.2
**Ref:** Sections 14.1, 15.5, 26

**Description:**
Add image-post and video-post modes to the composer: file picker (allow-listed types), client-side preview, **required alt-text field for images** (submit blocked without it, WCAG), optional captions for video, upload-progress and scan-pending states (the story enters review-hold if the scan is still pending — the UI says "Posted, pending a safety check"). Add the rendering surfaces: `StoryCard` and the story page render images through the gated upload URL with alt text, and videos through a native `<video controls>` (no autoplay; poster frame where available; a fallback message for undecodable codecs). Media respects reduced-motion (no autoplay ever) and offline (cached posters; the player degrades gracefully offline).

**Acceptance criteria:**
- Image submit is blocked without alt text; the error is field-tied and accessible.
- Video has no autoplay in any state; controls are keyboard-operable; captions render when present.
- Images/videos load only via the gated, scan-checked URL; a flagged/removed media post collapses honestly (no broken element, a clear state).
- New media states pass axe; the bundle-size budget still holds (media players use platform elements, no heavy deps — the dependency budget is unchanged).

**Testing:**
- Unit: alt-text gating; no-autoplay assertion; degraded states.
- E2E: image/video post render + keyboard operability + axe.

**Dependencies:** WS-Q.5.1, WS-Q.2.3a, WS-Q.2.3b.

---

### WS-Q.5.3 Room surfaces: binary visibility, join models, two-tier reveal
**ID:** WS-Q.5.3
**Ref:** Sections 16.1, 16.2

**Description:**
Update the room routes/components (`apps/web/src/routes/rooms*.tsx`, room detail, directory) for the binary model: a **private-room badge** and a tier-one shell for non-members (name, description, "Request to join" / "Invite only" per `join_model`, and the honest private-room notice from Section 14.5.7 — "private from the public, not from moderation; not encrypted"); a content area that renders only after the user passes the content bar (otherwise the request/pending state). The room feed calls `GET /v1/rooms/:roomId/feed` and shows the room's full pool (public + in-room) with an **in-room chip** on items that are not public. The directory lists public rooms and discoverable private rooms (tier one) with public-only thread counts. Room creation/settings UI exposes visibility, join model, and posting policy with the coherence rules enforced client-side (mirroring the shared refinement).

**Acceptance criteria:**
- Non-members of a private room see only the tier-one shell + the honest notice, never content; pending applicants see a pending state.
- The in-room chip marks every non-public item on a room feed; public items in a public room carry no chip.
- Creation/settings UI cannot submit an incoherent visibility/join/posting combination.
- All states (empty/loading/pending/forbidden/offline) are designed and pass axe.

**Testing:**
- Unit: tier-one vs tier-two render gating; chip logic; coherence enforcement.
- E2E: private-room non-member shell; member content; join flow per model; axe on each state.

**Dependencies:** WS-Q.1.1, WS-Q.3.1.

---

### WS-Q.5.4 Visibility management + front-page framing
**ID:** WS-Q.5.4
**Ref:** Sections 6.3, 14.5.2

**Description:**
Add author-facing visibility management on the story page (a "Change visibility" control wired to `PATCH /v1/stories/{id}/visibility`: narrow always offered; widen offered only in public rooms, with the re-admission/dup-collision outcomes surfaced — including the "a public story already exists for this link" 409 with a link to it). Update front-page framing copy to reflect that it shows public content earning the most meaningful participation-weighted attention (never "most liked"/"most upvoted" — the no-applause language gate already forbids those strings; add the new copy to the prohibited-language fixtures so "popular" is never rendered as an applause claim). The signal-ledger reason links continue to resolve for in-room items (the owner sees their own in-room participation).

**Acceptance criteria:**
- Narrow/widen controls appear per the rules; widen collision shows the existing public story; private-room items offer no widen.
- Front-page/explanation copy passes the prohibited-language gate and the x-pseudo localization proof; no string implies likes/votes/applause.
- Owners see Signal Ledger entries for their in-room participation; readers never see a global score.

**Testing:**
- Unit: control visibility per room/visibility; collision rendering.
- Unit: prohibited-language fixtures include the new copy; render-time gate green.
- E2E: narrow then confirm item leaves the front page (composed with API).

**Dependencies:** WS-Q.2.4, WS-Q.5.3.

---

### WS-Q.5.5 Offline + cache schema bump for room/visibility shapes
**ID:** WS-Q.5.5
**Ref:** Section 6.9

**Description:**
Bump the offline IndexedDB record-schema version so cached feed/story/room shapes from before WS-Q (no `room_id`/`visibility`/binary room visibility) are evicted and refetched rather than mis-parsed against the new zod schemas. The read-through cache mapping and the offline store's zod-validated integrity layer adopt the new shapes; a versioned migration drops incompatible cached records. Queued offline submissions created pre-WS-Q (without a room) are reconciled on sync: they are held and surfaced to the user to choose a home room (never silently dropped, never auto-posted to Commons without consent — the eviction/reconciliation discipline of WS-C).

**Acceptance criteria:**
- Stale cached records (old shape) are evicted on version bump; no parse error reaches the UI.
- A pre-WS-Q queued submission without a room is surfaced for room selection on sync, not lost and not auto-posted.
- The offline integrity tests (`fake-indexeddb`) cover the migration and the reconciliation path.

**Testing:**
- Unit: schema-version migration eviction; queued-submission reconciliation.

**Dependencies:** WS-Q.1.1, WS-Q.1.2a.

---

## WS-Q.6 Cross-cutting: migration validation, docs, and rollout

### WS-Q.6.1 End-to-end migration validation harness
**ID:** WS-Q.6.1
**Ref:** Sections 14.5, 16.1, 22.1

**Description:**
A gated integration harness that seeds a realistic pre-WS-Q dataset (public/restricted/expert_led rooms; thread-roomed and room-less stories; link/brief/question/evidence stories; public near-dup clusters) and runs the full WS-Q migration chain (`001A`–`001C` + Commons seed), then asserts the global safety property: **the set of (item, viewer) pairs that can read or be-distributed an item never grows for any existing item, and never shrinks for any item that was publicly visible.** Concretely: every formerly global story remains global iff its (mapped) room is public; every restricted/expert_led-room story becomes `room_only`; no story is left room-less; no public near-dup invariants are violated by the tier-scoped indexes. Include a dry-run report mode (counts per backfill branch) for operational confidence before the real run.

**Acceptance criteria:**
- The harness passes on the seeded dataset and emits a per-branch count report.
- The monotonic-visibility property holds (no widening of existing items; no loss of public reach).
- Re-running the chain is a no-op (idempotent), including the Commons seed.

**Testing:**
- Gated integration (Postgres + Redis service containers, as in CI).

**Dependencies:** WS-Q.1.3, WS-Q.1.4, WS-Q.1.5, WS-Q.1.6.

---

### WS-Q.6.2 Documentation, status, and roadmap updates
**ID:** WS-Q.6.2
**Ref:** Documentation rules (CLAUDE.md)

**Description:**
In the SAME change set as the implementation, update: `docs/SPEC.md` (already carries the v0.7 model — keep in sync if implementation forces refinements); `docs/forum/README.md` and `docs/ingestion/README.md` and `docs/ranking/README.md` (the room-ownership, visibility, media-post, and containment behaviors); `README.md` (status line + the new submission types); `CLAUDE.md` and `AGENTS.md` kept **byte-identical** (current-status summary, source-layout deltas, the new event topic, the WS-Q row in the roadmap table); and `docs/planning/00-index.md` (register `18-content-and-room-model.md` as WS-Q with its task count, milestone, wave, and dependency-graph edge). Bump the root `package.json` PATCH version.

**Acceptance criteria:**
- `pnpm check:policy` and all doc-touching gates pass; CLAUDE.md and AGENTS.md are byte-identical (`diff` is empty).
- The master index lists WS-Q with an accurate task count and the dependency edge from WS-I/WS-F/WS-G.
- No `claude.ai/code/session_*` URL appears in any doc or PR body (PR-authoring policy).

**Testing:**
- `pnpm check:policy`; a CI/byte-identical assertion for CLAUDE.md ≡ AGENTS.md.

**Dependencies:** all WS-Q implementation tasks (lands with them).

---

### WS-Q.6.3 Feature-flag rollout and reversibility
**ID:** WS-Q.6.3
**Ref:** Sections 30.8, 30.9

**Description:**
Gate the user-visible surface area behind a fail-closed feature flag set so the remodel rolls out and back independently of the schema migration (the schema is additive and backward-compatible; the flag controls behavior): `content.media_posts_enabled` (image/video submission), `content.in_room_visibility_enabled` (the public/in-room author choice — when off, public rooms behave exactly as pre-WS-Q with all content public), and `rooms.binary_visibility_ui` (the new room creation/settings controls). The distribution-side containment gate (WS-Q.4.2) and the read bar (WS-Q.3.2) are ALWAYS ON (they are safety/correctness, never flagged off — turning them off could leak in-room content, so there is no off switch). Document the rollback: disabling the author-choice flag stops new in-room items; existing in-room items remain correctly contained because the always-on gate enforces them regardless of the flag.

**Acceptance criteria:**
- Flags are fail-closed (unreadable ⇒ feature off ⇒ pre-WS-Q behavior, except containment which is unconditionally on).
- With `content.in_room_visibility_enabled` off, the composer offers no in-room choice and the server forces `public` in public rooms (private rooms still force `room_only` — privacy is never flag-gated off).
- Containment and the read bar have no disable path; a test asserts no flag can widen in-room reach.

**Testing:**
- Unit: flag fail-closed defaults; containment-not-flaggable assertion.

**Dependencies:** WS-Q.4.2, WS-Q.3.2, WS-Q.5.1.

---

## Dependency graph (within WS-Q)

```
WS-Q.1.1 (room enum) ──┬─ WS-Q.1.2a (story room+visibility) ─ WS-Q.1.2b (media types)
                       ├─ WS-Q.1.3 (rooms migration) ─ WS-Q.1.6 (Commons) ─ WS-Q.1.4 (stories migration) ─ WS-Q.1.5 (threads)
                       └─ WS-Q.1.7 (visibility event)
WS-Q.1.* ─ WS-Q.2.1 (submission guards) ─┬─ WS-Q.2.2 (tier dedup)
                                         ├─ WS-Q.2.3a (image) ─ WS-Q.2.3b (video)
                                         ├─ WS-Q.2.4 (transitions) ─ WS-Q.2.5 (search)
                                         └─ WS-Q.2.6 (takedown reach)
WS-Q.3.1 (read bar) ─ WS-Q.3.2 (item bar) ─ WS-Q.3.3 (governance) ─ WS-Q.3.4 (cascade) ─ WS-Q.3.5 (DSAR)
WS-Q.4.1 (candidate) ─ WS-Q.4.2 (dist gate) ─ WS-Q.4.3 (feature/log) ─ WS-Q.4.4 (neutrality)
WS-Q.5.1 (composer) ─ WS-Q.5.2 (media UI) ─ WS-Q.5.3 (room UI) ─ WS-Q.5.4 (visibility mgmt) ─ WS-Q.5.5 (offline)
WS-Q.6.1 (migration harness) ─ WS-Q.6.2 (docs) ─ WS-Q.6.3 (rollout)
```

Cross-stream order: WS-Q.1 (schemas/migrations) → WS-Q.2/3 (server) in parallel → WS-Q.4 (ranking, after the read bar) → WS-Q.5 (client, after the wire shapes) → WS-Q.6 (validation/docs/rollout, last).

## Milestone gate additions

| Gate | Task | Requirement |
|---|---|---|
| Home room required | WS-Q.2.1 | No content can be created without a home room; `Story.room_id` NOT NULL. |
| Two-tier containment | WS-Q.4.2, WS-Q.4.4 | In-room content never reaches a global surface (ranked or fallback), proven in CI. |
| Private-room read bar | WS-Q.3.2 | Outsiders/pending see only tier one; content reads 404. |
| Visibility forcing | WS-Q.1.2a, WS-Q.2.1 | Private rooms force `room_only`; no override path. |
| Media safety | WS-Q.2.3a/b | Image/video posts EXIF/metadata-stripped, scan-gated, alt-text required, no autoplay. |
| Migration monotonicity | WS-Q.6.1 | No existing item gains reach; no public item loses it. |
| Neutrality preserved | WS-Q.4.3, WS-Q.4.4 | Visibility never scores; financial denylist + BFS isolation still green. |
| Docs byte-identical | WS-Q.6.2 | CLAUDE.md ≡ AGENTS.md; index + READMEs updated; version bumped. |

## Definition of done (workstream)

- Every content item has exactly one home room (`Story.room_id` NOT NULL), and every thread's room matches its story's room.
- Room visibility is binary (`public`/`private`) with orthogonal join-model and posting-policy axes; the legacy three-value enum is fully migrated with no read-access widening.
- Content visibility is `public`/`room_only`, derived by the single shared helper; private rooms force `room_only`; transitions are bounded, audited, and emit `content.visibility.changed`.
- Image and video posts are first-class submission types through the scan-gated, metadata-stripping media pipeline, with required alt text and no autoplay.
- Global surfaces (front page, topic, global search, embedding similarity, share previews) serve public content only; room surfaces serve the room pool to readers who pass the bar; the distribution-side gate is always-on, fail-closed, and applies to ranked and fallback paths.
- The neutrality + containment CI gate proves no in-room leak and that visibility is not a ranking signal; the financial denylist and wallet↔ranking BFS isolation remain green on the modified schemas.
- All client states (compose, media, room shells, visibility management, offline) pass WCAG 2.2 AA and the no-applause/prohibited-language gates; the offline cache is version-bumped and reconciles pre-WS-Q queued submissions.
- The migration is idempotent, resumable where it sweeps, and validated by the monotonic-visibility harness; the user-visible surface is feature-flagged and reversible while containment and the read bar are unconditionally enforced.
- `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm lint:security`, `pnpm check:deps`, `pnpm check:workspace-deps`, `pnpm check:no-applause`, `pnpm check:no-raw-egress`, `pnpm check:neutrality`, and `pnpm check:policy` all pass; docs are updated in the same change set and the PATCH version is bumped.

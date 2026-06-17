# WS-T: Conversation as Comments — Inline Comment Sections

**Milestone:** M3 (remodel of shipped M1/M3 surfaces) | **Priority:** P1 | **Dependencies:** WS-G (forum/threads/contributions/composer/UGC), WS-Q (room/content/visibility/native media), WS-E (events/PWAtt/attention signals), WS-J (report/block/mute affordances), WS-C (PWA: push, notification budget, offline drafts, routing/signals) — all complete; WS-H/WS-I consume contributions and MUST keep their inputs | **Wave:** 12 (post-WS-Q remodel; lands after the WS-R/WS-S extensions are sequenced, parallelizable with them) | **Estimated duration:** 5-6 weeks | **Task count:** 40 atomic cards

---

## Overview

WS-T replaces Licio's **structured-thread** conversation model — six fixed sections read "never as a flat list" (SPEC §6.4/§15.3) plus an eleven-mode participation composer (§6.6/§15.1) reached through a separate `/submit` page — with a **lightly-nested comment section embedded directly in the content page** (`/stories/$storyId`). This is a deliberate SPEC change (§3.4.2, §6.4, §6.6, §15.1, §15.3, §15.5, §24.3 are amended), executed so that the rich invariant/ranking/summary machinery underneath keeps working.

The redesign rests on one finding from the dependency audit: **the six sections are a read-time projection, not stored data.** A contribution's "branch" is computed from its `type` by the static `SECTION_TYPES` map in `apps/api/src/forum/tree.ts`; there is no `branch`/`section` column. Retiring the sections is therefore a read-layer change with no data migration, and the materialized-path `contributions` tree (depth ≤ 10, GIN-indexed) **already supports** lightly-nested comments unchanged.

The model becomes:

    Room  ⊃  Content (story)  ⊃  Thread (comment section)  ⊃  Comments (lightly nested)

1. **Comment is the core unit.** A comment is Markdown-lite text **and/or** an uploaded image/GIF, posted inline on the story page, optionally as a reply (lightly nested: top-level comments + one collapsible reply level + a "continue thread" link deeper). It replaces "post for applause" exactly as the eleven typed contributions did — there is still no react/like/vote anywhere (no-applause doctrine; a GIF is comment *content*, authored and threaded and reportable, never a one-tap reaction tally).
2. **Two typed enrichments survive, as optional toggles on a comment** (the user-ratified subset): **Cite a source** (→ the existing `evidence` type + evidence card, which feeds MERI and the evidence drawer) and **Mark a correction** (→ the existing `correction` type, which feeds correction-accuracy reputation §15.6 and the Hodge `correction` interaction signal). They are not separate composer modes; they are progressive controls that change the comment's stored `type`. The interpretation **lens** is retained in the data model (SCOI depends on `metadata.lens_id`) behind an unobtrusive optional control.
3. **The other nine types are retired for new writes** (existing rows keep their type and render as comments): `question`/`answer` become ordinary comments/replies; `counterexample`/`explanation`/`local_context`/`direct_experience`/`meta_discussion` become ordinary comments; `moderation_concern` becomes the **WS-J Report flow** mounted on every comment; `synthesis` becomes the **community-synthesis summary layer** that already exists in the `summaries` table. The full `contribution_type` enum stays for backward-compatible reads.
4. **The six sections become (at most) light optional filters.** The default read is a single lightly-nested chronological stream; an optional, de-emphasized filter exposes **Sources** and **Corrections** (derived from `type`), and the **Overview** becomes the §24.3 summary shown atop the section. No mandatory six-tab structure, no per-branch reads.
5. **The conversation lives on the content page.** The separate `/threads` directory tab, the `/threads/$threadId` reader, and the `/threads_/$threadId_/branches/$branchId` route are retired; `/threads/$threadId` survives only as a thin redirect to the owning story for back-compat deep links. `/submit` reverts to **story submission only**.
6. **Comments stream live** over same-origin Server-Sent Events (already permitted by `connect-src 'self'` — no CSP change), built on the existing Redis pub/sub pattern, with a chronological-refetch fallback. **Replies to your comments notify you** through the existing WS-C push + per-day notification-budget system, plus an in-app indicator.
7. **GIFs are first-class comment media** via the existing same-origin upload pipeline: `image/gif` joins the content-type allowlist with a GIF-aware metadata stripper (drops Comment/XMP extension blocks, **preserves** animation control so looping animated GIFs survive), a size cap, the scan gate, and required alt text. Animated GIFs respect reduced-motion (a static first-frame poster with a play control).

The net effect for existing data: every stored contribution stays readable (rendered as a comment, with its evidence/correction enrichment surfaced); nothing publicly visible disappears; the invariant inputs (MERI evidence groups, SCOI `lens_id`, GWEI tree depth + lens keys, Hodge `type`→`kind`, WS-I story/thread aggregates) are all preserved.

### Verified integration points (current code)

These are the exact files/symbols WS-T touches, confirmed against the shipped tree so each card is actionable without rediscovery.

| Concern | Symbol / file | WS-T change |
|---|---|---|
| Write contracts | `contributionCreateSchema` (11-branch union) / `packages/shared/src/schemas/contribution.ts` | shrink the **write** union to `comment\|evidence\|correction`; add `commentCreateSchema`; allow media-only (body optional with media) |
| Read projection | `contributionPublicSchema` / same | keep the full `type` enum for back-compat reads; add resolved `media` (attachments → URL/kind/alt) |
| Type taxonomy | `CONTRIBUTION_TYPES` / same (+ `contributionTypeEnum` DB mirror) | append `comment`; deprecate the nine for new writes (kept on read) |
| Section projection | `SECTION_TYPES`, `sectionOfType` / `apps/api/src/forum/tree.ts`; `BranchId`, `contributionAnchorSchema.branch` / `contribution.ts` | retire the six-section read layer; anchor becomes `(thread_id, root_contribution_id)` only |
| Thread reads | `branchContent`, `threadOverview` / `apps/api/src/forum/threads.ts`; the `/threads/:id/branches/:branch` + `/contributions/:id/anchor` routes / `apps/api/src/routes/forum.ts` | replace branch reads with `GET /v1/stories/:storyId/comments` (nested, keyset, optional `filter`); overview → comment/sources/corrections counts |
| Create path | `createContribution` guard chain + `FORUM_TO_EVENT_TYPE` / `apps/api/src/forum/contributions.ts` | accept `comment`; map `comment`→event type + Hodge kind; media-or-body rule; reuse guards |
| Hodge input | `KIND_BY_TYPE` / `apps/api/src/invariants/data.ts` | add `comment: 'attention'` |
| Deepening | `maybeDeepenConversation` evidence-bearing set / `apps/api/src/forum/transitions.ts` | evidence-bearing = `evidence` + `correction` (counterexample retired) |
| Summaries | `summaries.cited_branch_ids` / `packages/db/src/schema/summary.ts` + `summary.ts` schema | rename → `cited_contribution_ids` (back-compat alias); §24.3 wording |
| Upload allowlist | `UPLOAD_IMAGE_TYPES` / `packages/shared/src/schemas/forum-api.ts`; `matchesMagic` + `stripUploadMetadata` / `apps/api/src/forum/exif.ts` | add `image/gif` + `MAX_GIF_BYTES`; add GIF-aware `stripGif` |
| Attachment render | (none — `attachment_ids` never rendered today) | NEW: `CommentMedia` renders comment image/GIF inline |
| Composer | `ParticipationComposer`, `modes.ts`, `payload.ts` / `apps/web/src/components/composer/ParticipationComposer/` | retire; replace with `CommentComposer`; reuse `Attachment`, `CitationCapture`, `VoiceDictation` |
| Story page | `StoryDetailContent` "View the conversation" `Link` / `apps/web/src/routes/-pages/stories.tsx` | replace with the embedded `<CommentSection>` |
| Thread routes | `threads.tsx`, `threads_.$threadId.tsx`, `threads_.$threadId_.branches.$branchId.tsx`, `-pages/threads.tsx`, `ThreadBranchNav` / `apps/web` | retire; add `/threads/$threadId` → story redirect |
| Navigation | `defaultNavItems`, `activeTabId` / `BottomNav.tsx`, `__root.tsx` | remove the Threads tab (5 → 4 tabs) |
| Submit | `SubmitPage`, `submitSearchSchema` / `apps/web/src/routes/-pages/submit.tsx`, `routing/search.ts` | story submission only; drop the `?threadId&branch` contribution mode |
| Attention signal | `branch_depth_bucket`/`branchDepthBucket` / `packages/shared/src/schemas/attention.ts`; `recordBranchVisit`, `TraversalTracker` / `apps/web/src/signals/` | repurpose to **reply-depth** semantics; remove `recordBranchVisit` branch calls |
| Live + notify | Redis pub/sub pattern (`*-redis-*-stores.ts`); `push-service.ts`, `notification-meter.ts`, `notifications.ts` schema | NEW: SSE comment stream + reply-notification trigger |

### Migration strategy (additive; the tree is already comment-ready)

Schema change is minimal because the `contributions` materialized-path tree already models nested comments and the six sections were never stored. Migration numbers continue the chain after the shipped `0028`.

| # | Card | Phase | Online-safety note |
|---|---|---|---|
| `0029` | WS-T.2.1 | `ADD VALUE 'comment'` to `contribution_type` | non-locking enum extension; old code never emits it, so additive-only |
| `0030` | WS-T.2.2 | relax `contributions` body CHECK from `1..5000` to `0..5000` | drop+add `CHECK NOT VALID` then `VALIDATE` (no full-table lock); the "non-empty body OR media" rule is enforced at the zod boundary |
| `0031` | WS-T.2.3 | uploads content-type CHECK: add `image/gif` | drop+add `CHECK NOT VALID` then `VALIDATE`, mirroring the `0020` video precedent |
| `0032` | WS-T.2.4 | summaries: add `cited_contribution_ids`, backfill from `cited_branch_ids`, keep the old column as a read alias | expand→backfill→(deferred contract); cosmetic clarity, never read-breaking |

Every migration ships an idempotent down path. No migration drops an enum value or a column in the same window it is still read (the nine deprecated types and `cited_branch_ids` are retained). Each gated integration test runs the real chain in CI's Postgres service container (the WS-D…WS-Q precedent).

### Conventions for this workstream

- **No-applause invariant (unchanged).** No card introduces likes, votes, karma, reactions, or follower counts. A GIF/image is comment content, not a reaction; the `check:no-applause` route/component scan is extended to the new comment surfaces, and the no-applause composer test is ported to `CommentComposer`.
- **Back-compat reads.** Every contribution ever written stays readable. The `contribution_type` enum and `summaries.cited_branch_ids` are retained; the read projection renders any legacy type as a comment (surfacing the evidence/correction enrichment). No card deletes historical data.
- **One create path, one read bar.** Client and server validate the SAME shared write schema (`comment\|evidence\|correction`); the WS-Q room read bar (`storyReadableByUser`) and visibility gate continue to gate every comment read, the SSE stream, and notifications. No re-implementation, no drift.
- **Privacy unchanged.** Comments carry no raw attention traces; the §22.1 aggregate stays bucketed (the `check:no-raw-egress` gate is re-run after the reply-depth repurpose). SSE frames and notification payloads carry only the public projection — ids/handles/bodies that already cross the REST boundary, never scores or private data.
- **Identity-free (Section 19.1).** No card reads or stores IP/geolocation. The SSE endpoint and reply-rate limits key on the existing account ref + global budgets, never the client address (the `no-client-address` static test stays green).
- **Same-origin only.** GIFs are served from `/v1/uploads/:id` (`img-src 'self'`); the comment stream is same-origin SSE (`connect-src 'self'`). No external origin is added to the CSP, and no external GIF provider is contacted.
- **Animation respects motion preference.** Animated GIFs never auto-animate when the OS or the in-app motion setting prefers reduced motion (WS-B fabric/motion doctrine): render a static first frame with an explicit Play control.
- **Deliberate doctrine simplifications, recorded not hidden.** Retiring the question/answer flag, the direct-experience privacy acknowledgment, and the six structured sections are explicit SPEC edits (WS-T.1.1), not silent omissions. The general "files carry hidden metadata / don't post others' private info" privacy warning is retained on the attach control; the §19 first-hand-account acknowledgment is dropped per the ratified scope decision and noted in the SPEC.
- **Reuse over rebuild.** `CommentComposer` reuses `Attachment` (file input + privacy warning), `CitationCapture` (the source enrichment), `VoiceDictation`, the UGC pipeline (`renderUGC`/`UgcBody`), and the encrypted offline-draft layer (`draft-crypto`, `client_draft_id` idempotency). The materialized-path tree, the conversation/safety state machines, and the safety pre-check → insert → intake flow are unchanged.
- **Monorepo atomicity.** Wire-shape changes land in `@licio/shared` first; both sides consume the same schemas. Offline caches bump their record-schema version so stale cached shapes (old branch snapshots, the renamed aggregate field) are evicted, never mis-parsed.
- **Task sizing (Section 30.8).** Every card below is one deliverable — one schema, one migration phase, one endpoint, one component, one guard — reviewable, testable, and reversible in ≤ 1-3 engineering days. Sub-area headers group cards; the dependency graph at the end fixes their order.

---

## WS-T.1 Shared schemas and doctrine

### WS-T.1.1 SPEC amendment: comments replace structured branches
**ID:** WS-T.1.1 | **Ref:** Sections 3.4, 6.4, 6.6, 15.1, 15.3, 15.5, 24.3

**Description:** Amend `docs/SPEC.md` to make the comment section the canonical conversation model. (1) §3.4.2 — "anchors its own thread (with structured branches, Section 15.3)" → "anchors its own **comment thread** — a lightly-nested comment section (Section 15.3)". (2) §6.4 "Thread layout" — rewrite from six structured branches to: the comment section is embedded in the content page; comments are lightly nested (top-level + a collapsible reply level + "continue thread"); the default read is chronological with optional Sources/Corrections filters; the Overview is the §24.3 summary atop the section. (3) §6.6 "Participation composer" — replace the eleven-mode table with the simple comment composer (text and/or image/GIF) plus two optional enrichments (Cite a source; Mark a correction) and an optional lens. (4) §15.1 — comment is the base unit; `evidence` and `correction` are typed enrichments; the remaining nine are retired for new writes (question/answer → comments/replies; counterexample/explanation/local-context/direct-experience/meta-discussion → comments; moderation-concern → the §18.4 report flow; synthesis → the community-synthesis summary §15.4). (5) §15.3 — replace "six fixed structured sections … never a flat list" with the lightly-nested comment tree and comment-level scoring (nonredundant evidence MERI, lens divergence SCOI, tension Hodge, corrections, reader utility). (6) §15.5 — note comments are the primary unit and may carry an image/GIF through the shared media pipeline. (7) §24.3 — "cite source branches and evidence cards" → "cite source **comments** and evidence cards". Record the three deliberate removals (question/answer flag, direct-experience acknowledgment, six sections) in the changed text so the simplification is explicit, not silent.

**Acceptance criteria:**
- Every listed section reads coherently post-edit; no dangling reference to "six sections", "structured branches", or the eleven-mode composer survives in §3.4/§6.4/§6.6/§15/§24.3 (`rg` check in the testing step).
- The no-applause language is preserved verbatim wherever it appeared.
- `pnpm check:policy` passes (doctrine-document validation unaffected).

**Testing:** `rg -n "structured branches|six (fixed )?(structured )?sections|eleven (typed|modes)" docs/SPEC.md` returns no stale hits in the amended sections; manual read-through diff.

**Dependencies:** none (document). Should land first so the code cards have a ratified target.

---

### WS-T.1.2 `commentCreateSchema` + shrunk write union + media-or-body rule
**ID:** WS-T.1.2 | **Ref:** Sections 15.1, 15.5, 25.2

**Description:** In `packages/shared/src/schemas/contribution.ts` add `comment` to `CONTRIBUTION_TYPES` (read enum stays full) and `CONTRIBUTION_BODY_LIMITS` (`comment: 5_000`). Add `commentCreateSchema` over `createBaseShape` with `type: z.literal('comment')`, an OPTIONAL `body` (Markdown-lite, ≤ 5000) and the reused optional `attachment_ids` (now the comment's media), plus a top-level `.superRefine` enforcing **body-or-media**: at least one of a non-empty trimmed `body` or ≥ 1 `attachment_ids` must be present (specific error otherwise). Keep `evidenceCreateSchema` and `correctionCreateSchema` (they already encode the citation/claim requirements that feed MERI/reputation) and define the **new write union** `contributionWriteCreateSchema = z.discriminatedUnion('type', [commentCreateSchema, evidenceCreateSchema, correctionCreateSchema])`. Mark the legacy nine create schemas `@deprecated` (retained for one release for any in-flight client) and stop exporting them from the write union. `evidence`/`correction` keep requiring a non-empty `body` (the relevance/correction note).

**Acceptance criteria:**
- `comment` parses with body-only, media-only, and body+media; rejects empty-and-medialess with the specific message.
- `contributionWriteCreateSchema` accepts exactly the three live types; the nine legacy literals fail discrimination.
- `contributionPublicSchema.type` still accepts all twelve values (back-compat reads).
- No applause/financial field appears on any comment shape (existing denylist/no-applause schema tests stay green).

**Testing:** Unit — parse/reject matrix over the three write branches; body-or-media property; `expectTypeOf` for the union; a fixture proving a stored legacy `question`/`synthesis` row still parses as `ContributionPublic`.

**Dependencies:** WS-T.1.1.

---

### WS-T.1.3 GIF upload type in shared contracts
**ID:** WS-T.1.3 | **Ref:** Sections 14.1, 15.5, 25.2

**Description:** In `packages/shared/src/schemas/forum-api.ts` add `'image/gif'` to `UPLOAD_IMAGE_TYPES` and define `MAX_GIF_BYTES = 8 * 1024 * 1024` (animated GIFs run large; a dedicated cap the steward `ingestion.*` config may only LOWER). Extend `uploadPublicSchema.content_type` (it derives from the type tuples, so confirm `image/gif` flows through) and ensure `byte_size`'s max accommodates the GIF cap. Keep `alt_text` REQUIRED for the image group (GIF included). Export an `isAnimatableImage(contentType)` helper (`true` for `image/gif`) the client uses to decide reduced-motion handling.

**Acceptance criteria:**
- `image/gif` is a valid `uploadPublicSchema.content_type`; a GIF upload public projection round-trips.
- `MAX_GIF_BYTES` is exported and ≤ the DB hard ceiling added in WS-T.2.3.
- `alt_text` remains non-nullable for `image/gif`.

**Testing:** Unit — `uploadPublicSchema` accepts an `image/gif` record with alt text and rejects one without; `isAnimatableImage` truth table.

**Dependencies:** WS-T.1.1.

---

### WS-T.1.4 Resolved comment media on the read projection
**ID:** WS-T.1.4 | **Ref:** Sections 15.5, 22.1, 23.3

**Description:** Today `attachment_ids` lives in `metadata` but no surface resolves it. Add an OPTIONAL `media` array to `contributionPublicSchema`: each entry `{ upload_id, url, kind: 'image', content_type, alt_text, animatable: boolean }` — the server-resolved, visibility-gated, same-origin read URL for each cleared attachment, reusing the WS-Q `media-urls.ts` mint/verify for `room_only` parents. The `metadata.attachment_ids` raw field is retained (DSAR/back-compat); `media` is the render-ready projection. Cap at the existing 4 attachments. (`kind` is `'image'` for all current upload image types incl. GIF; the enum is left open for a future `video` comment attachment without a schema break.)

**Acceptance criteria:**
- `media` is present and ordered to match `attachment_ids` for a comment with cleared attachments; absent/empty when none.
- `animatable` is `true` exactly for `image/gif`.
- A `room_only` parent's media `url` carries a signed token; a public parent's does not (mirrors WS-Q.5.2c).

**Testing:** Unit — projection over {no media, 1 image, 1 GIF, mixed}; signed-vs-bare URL by visibility; `expectTypeOf`.

**Dependencies:** WS-T.1.2, WS-T.1.3.

---

### WS-T.1.5 Summary `cited_contribution_ids` rename
**ID:** WS-T.1.5 | **Ref:** Section 24.3

**Description:** In `packages/shared/src/schemas/summary.ts` add `cited_contribution_ids` (the accurate name; these were always contribution UUIDs) as the canonical field on the public + create shapes, accept `cited_branch_ids` as a deprecated input alias mapped onto it, and emit only `cited_contribution_ids` on the wire. Update the §24.3 helper text. (DB column rename is WS-T.2.4.)

**Acceptance criteria:**
- Create requests using either field name validate; the public projection always carries `cited_contribution_ids`.
- §24.3 uncertainty/minority-view constraints are unchanged.

**Testing:** Unit — alias acceptance; egress always-renamed; the existing summary §24.3 tests stay green.

**Dependencies:** WS-T.1.1.

---

### WS-T.1.6 Retire the branch projection types; deprecate synthesis writes
**ID:** WS-T.1.6 | **Ref:** Sections 6.4, 15.3, 24.3

**Description:** Remove the six-section read vocabulary from the shared layer: simplify `contributionAnchorSchema` to `{ contribution_id, thread_id, root_contribution_id }` (drop the `branch` enum and the `BranchId` export). Mark `synthesisCreateSchema` `@deprecated` (community synthesis is authored through the summary layer, WS-T.3 + the existing `/summaries` endpoint) and drop it from any write union. Anything still importing `BranchId` must move to the comment-stream/anchor shapes.

**Acceptance criteria:**
- `BranchId` and `contributionAnchorSchema.branch` no longer exist; `pnpm typecheck` flags every consumer (resolved in WS-T.3/WS-T.8).
- `synthesis` is absent from the live write union but still a valid read `type`.

**Testing:** Unit — anchor parse over the new shape; type-level proof `BranchId` is gone (compile error fixture removed).

**Dependencies:** WS-T.1.2.

---

### WS-T.1.7 Repurpose the attention reply-depth signal
**ID:** WS-T.1.7 | **Ref:** Sections 22.1, 19.1

**Description:** With branches gone, repurpose the §22.1 traversal signal from "distinct branches visited" to "distinct reply-depth levels read". In `packages/shared/src/schemas/attention.ts` rename `branch_depth_bucket` → `reply_depth_bucket` (same `'none'|'shallow'|'moderate'|'deep'` buckets; rename `branchDepthBucket` → `replyDepthBucket`, same thresholds). The field stays a coarse bucket (no raw counts) and has no downstream scorer (audit-confirmed), so the change is privacy-neutral. Bump the offline aggregate record-schema version so stale cached aggregates are evicted.

**Acceptance criteria:**
- `reply_depth_bucket` is the only traversal field on the §22.1 aggregate; `branch_depth_bucket` is gone.
- `assertNoRawEgress`/`check:no-raw-egress` still pass (no raw trace added).
- Offline cache version bumped; a stale `branch_depth_bucket` aggregate fails parse and is evicted, not mis-read.

**Testing:** Unit — `replyDepthBucket` thresholds; no-raw-egress over the new aggregate; an eviction test for the renamed field.

**Dependencies:** WS-T.1.1. Pairs with WS-T.8.4 (the web signal source).

---

## WS-T.2 Database and migrations

### WS-T.2.1 DB enum + migration 0029 (`ADD VALUE 'comment'`)
**ID:** WS-T.2.1 | **Ref:** Sections 15.1, 22.1

**Description:** In `packages/db/src/schema/contribution.ts` append `comment` to `contributionTypeEnum` (mirroring the shared enum order). Migration `0029_ws_t_comment_type.sql` runs `ALTER TYPE contribution_type ADD VALUE IF NOT EXISTS 'comment'` (non-locking; cannot run inside a transaction block with other DDL — ship it as a standalone statement, the `0015 ADD VALUE` precedent). No backfill: existing rows keep their historical type and render as comments via the read projection.

**Acceptance criteria:**
- Migration green on a DB seeded with all eleven legacy types; `comment` is insertable afterward.
- The DB enum mirrors the shared enum exactly (storage-layer defense in depth; the existing enum-parity test extends to `comment`).
- Down path documented as a no-op (Postgres cannot drop an enum value safely; the value is harmless if unused).

**Testing:** Gated integration — apply `0029`, insert a `comment` row, read it back; enum-parity unit test.

**Dependencies:** WS-T.1.2.

---

### WS-T.2.2 Migration 0030 — relax the body CHECK for media-only comments
**ID:** WS-T.2.2 | **Ref:** Sections 15.5

**Description:** The `contributions` table CHECK `char_length(body) BETWEEN 1 AND 5000` forbids an empty body, blocking a GIF-only comment. Migration `0030_ws_t_body_optional.sql` replaces it with `0..5000` using `DROP CONSTRAINT` + `ADD CONSTRAINT ... CHECK (...) NOT VALID` then `VALIDATE CONSTRAINT` (no full-table lock). The "non-empty body OR ≥1 attachment" invariant is enforced at the zod write boundary (WS-T.1.2) and re-asserted in the create service (WS-T.3.2); the DB keeps the length ceiling. Update the in-memory store's mirrored CHECK comment.

**Acceptance criteria:**
- A row with `body = ''` and a non-empty `metadata.attachment_ids` inserts; a row with empty body AND no attachments is rejected by the service (not necessarily the DB).
- Existing rows are unaffected; `VALIDATE` succeeds without a long lock in the gated harness.
- Idempotent down path restores the `1..5000` CHECK (lossy only if media-only rows exist, documented).

**Testing:** Gated integration — apply `0030`; insert media-only + body-only rows; confirm the service rejects empty-and-medialess.

**Dependencies:** WS-T.2.1.

---

### WS-T.2.3 Migration 0031 — uploads allow `image/gif`
**ID:** WS-T.2.3 | **Ref:** Sections 14.1, 15.5

**Description:** In `packages/db/src/schema/upload.ts` extend the content-type CHECK to include `image/gif`; raise the byte-size CHECK ceiling if `MAX_GIF_BYTES` exceeds the current image bound (it does not — 8 MB < the 200 MB video ceiling — so the existing `uploads_byte_size_range` already covers it; assert this). Migration `0031_ws_t_gif_upload.sql` performs the CHECK swap via `NOT VALID` + `VALIDATE` (the `0020` video precedent).

**Acceptance criteria:**
- An `image/gif` upload row inserts; a non-allowlisted type still fails the CHECK.
- The byte-size CHECK admits up to `MAX_GIF_BYTES`.
- Down path removes `image/gif` from the CHECK (lossy only for stored GIF rows, documented).

**Testing:** Gated integration — apply `0031`; insert a GIF upload; reject an unsupported type.

**Dependencies:** WS-T.1.3.

---

### WS-T.2.4 Migration 0032 — summaries `cited_contribution_ids`
**ID:** WS-T.2.4 | **Ref:** Section 24.3

**Description:** In `packages/db/src/schema/summary.ts` add `cited_contribution_ids` (JSONB array, same CHECK as the old column) and migration `0032_ws_t_summary_citations.sql` backfills it from `cited_branch_ids`, keeping the old column as a retained read alias (no contract drop this workstream). The Drizzle store reads/writes `cited_contribution_ids`; a compatibility read coalesces the old column for any un-backfilled row.

**Acceptance criteria:**
- Post-migration every summary has `cited_contribution_ids` equal to its prior `cited_branch_ids`.
- New inserts populate only `cited_contribution_ids`; the old column is never written again.
- Idempotent; re-runnable backfill.

**Testing:** Gated integration — seed summaries with `cited_branch_ids`, run `0032`, assert equality + new-insert behavior.

**Dependencies:** WS-T.1.5.

---

## WS-T.3 Forum backend: comment reads, writes, and branch retirement

### WS-T.3.1 `GET /v1/stories/:storyId/comments` — the nested comment read
**ID:** WS-T.3.1 | **Ref:** Sections 6.4, 15.3, 16.2, 23.2

**Description:** Add the single comment-read endpoint in `apps/api/src/routes/forum.ts`, backed by a new `forum/comments.ts` read assembled from the existing `ContributionStore`. It resolves the story's thread, applies the WS-Q room read bar + WS-J hide/mute filter + tombstone-honest collapsing (reuse `visibleRows`), and returns a **lightly-nested** page: top-level comments keyset-paginated by `(created_at, id)` (default newest-first, `?order=oldest` supported), each carrying up to `REPLY_PREVIEW = 3` newest descendants plus a `reply_count` and a `has_more_replies` flag; deeper levels load via the existing subtree read (WS-T.3.x reuses `subtreeContent` under a `?root=` form). Optional `?filter=sources|corrections` narrows to `type IN ('evidence')` / `('correction')` (derived, not stored). Response carries the resolved `media` (WS-T.1.4) and the current §24.3 summary for the Overview slot.

**Acceptance criteria:**
- Returns top-level comments with bounded reply previews + accurate `reply_count`; keyset cursor is replayable and stable under inserts.
- `filter=sources|corrections` returns only the matching types; absent filter returns the full stream.
- Room read bar + block/mute + tombstone behavior is identical to the retired branch read (golden-output parity test against a seeded thread).
- Private/`room_only` parents are never served to non-members (WS-Q containment leg extended).

**Testing:** Unit + gated integration — pagination determinism; filter correctness; visibility parity vs. the old `branchContent` on a shared fixture; axe-free JSON (no markup).

**Dependencies:** WS-T.1.2, WS-T.1.4, WS-T.1.6.

---

### WS-T.3.2 Accept `comment` on the create path
**ID:** WS-T.3.2 | **Ref:** Sections 15.1, 15.5, 21.3

**Description:** In `apps/api/src/forum/contributions.ts` extend the create guard chain to accept the WS-T write union. Add `comment` to `FORUM_TO_EVENT_TYPE` (map to the WS-E `low_info_reply` event type only when body is empty/GIF-only; otherwise a neutral `explanation`-class participation event — confirm against the WS-E `EventContributionType` set and the §30.6 firewall) and to `KIND_BY_TYPE` in `apps/api/src/invariants/data.ts` (`comment: 'attention'`). Enforce the body-or-media rule server-side (defense in depth over zod). `metadataFromRequest` carries `attachment_ids`/`lens_id` for comments exactly as today. Everything else in the chain — rate limit (per-account), visibility, dedup (`client_draft_id`), parent depth ≤ 10, block check, attachment ownership + scan-clear, safety pre-check → insert → intake → event emission (published only) — is unchanged. `evidence`/`correction` continue to co-create their evidence card / require citations.

**Acceptance criteria:**
- A `comment` (body, media, or both) creates, emits `contribution.created` only when published, and dedups on `client_draft_id`.
- `comment` never co-creates an evidence card; `evidence`/`correction` still do / still require citations.
- Hodge `KIND_BY_TYPE['comment'] === 'attention'`; the firewall/no-applause event tests stay green.
- A GIF-only comment routes through the same safety pre-check (attachment scan-clear required before publish).

**Testing:** Unit — create matrix over comment/evidence/correction × {body, media, both}; event-emission + Hodge-kind assertions; the WS-J safety-hold path for a comment.

**Dependencies:** WS-T.1.2, WS-T.2.1, WS-T.2.2, WS-T.4.2 (GIF clearance for media-only).

---

### WS-T.3.3 Retire the six-section read layer
**ID:** WS-T.3.3 | **Ref:** Sections 6.4, 15.3

**Description:** Remove `SECTION_TYPES`, `sectionOfType`, and `branchContent` from `apps/api/src/forum/tree.ts`/`threads.ts`; delete the `GET /v1/threads/:id/branches/:branch` route and the `branch` field from the anchor route (`GET /v1/contributions/:id/anchor` now returns `{contribution_id, thread_id, root_contribution_id}`). Replace `threadOverview`'s six section counts with `{ comment_count, sources_count, corrections_count }` (derived by `countByType` over the surviving types). Keep `subtreeContent` (powers "continue thread") and the `GET /v1/threads/:id` overview (now feeding redirects + counts). Resolve the WS-T.1.6 type-errors at every call site.

**Acceptance criteria:**
- No route or function references the six `BranchId` values; `pnpm typecheck` is clean.
- Overview returns the three derived counts; `subtreeContent` still paginates a reply subtree.
- The removed endpoints return 404 (route gone), not 500.

**Testing:** Unit — overview counts on a mixed-type fixture; subtree pagination unchanged; a route test asserting `/branches/:branch` is gone.

**Dependencies:** WS-T.3.1.

---

### WS-T.3.4 Resolve comment media for reads
**ID:** WS-T.3.4 | **Ref:** Sections 15.5, 22.1

**Description:** Implement the `media` resolution behind WS-T.1.4 in the comment read path: for each visible comment, map cleared `attachment_ids` to `{upload_id, url, content_type, alt_text, animatable}` using the upload store + the WS-Q `lib/media-urls.ts` minting (signed token for `room_only` parents; bare immutable URL for public). Skip `pending`/`flagged` uploads (never served). Cache-friendly: the URL carries the existing immutable cache hint for public media.

**Acceptance criteria:**
- Public-parent media → bare `/v1/uploads/:id`; `room_only`-parent media → signed URL; flagged/pending omitted.
- Order matches `attachment_ids`; `animatable` true only for `image/gif`.
- Resolution adds no N+1 over the page (batch the upload lookups).

**Testing:** Unit — resolution over visibility × scan-state × type; batch-read assertion.

**Dependencies:** WS-T.1.4, WS-T.3.1.

---

### WS-T.3.5 Update the deepening trigger's evidence-bearing set
**ID:** WS-T.3.5 | **Ref:** Sections 15.4

**Description:** In `apps/api/src/forum/transitions.ts` `maybeDeepenConversation`, redefine the evidence-bearing set as `{evidence, correction}` (counterexample is retired for new writes; legacy counterexamples still count on read if present). The structural `active → deepening` trigger (reply depth ≥ N, published count ≥ M, evidence-bearing ≥ K) is otherwise unchanged. Update the forum config doc/keys comment.

**Acceptance criteria:**
- Deepening fires on evidence+correction accumulation; the audited `thread.state.changed` event/reason string is unchanged in shape.
- Legacy counterexample rows still contribute to the count for historical threads.

**Testing:** Unit — deepening fires/doesn't across {evidence, correction, comment-only} mixes; reason-string snapshot.

**Dependencies:** WS-T.3.2.

---

### WS-T.3.6 Thread → story redirect resolver
**ID:** WS-T.3.6 | **Ref:** Sections 6.4, 23.2

**Description:** Old deep links (`/threads/:threadId`, shared anchors) must keep working after the routes retire. Expose the owning `story_id` for a thread so the client redirect (WS-T.8.2) can resolve it — either reuse the existing `GET /v1/threads/:id` overview (which already knows `story_id`) or add a tiny `GET /v1/threads/:id/location` returning `{story_id}` gated by the same read bar (404 to outsiders). Prefer reusing the overview to avoid a new endpoint.

**Acceptance criteria:**
- A valid thread id resolves to its `story_id` for a permitted reader; returns 404 to a reader who fails the room read bar.
- No new endpoint unless the overview cannot serve it (documented choice).

**Testing:** Unit — resolve + read-bar 404; redirect-target correctness.

**Dependencies:** WS-T.3.3.

---

## WS-T.4 GIF upload pipeline

### WS-T.4.1 GIF-aware metadata stripper (`stripGif`)
**ID:** WS-T.4.1 | **Ref:** Sections 15.5, 25.2

**Description:** In `apps/api/src/forum/exif.ts` add a GIF case. (1) `matchesMagic`: accept the GIF signature `47 49 46 38 {37|39} 61` (`GIF87a`/`GIF89a`). (2) `stripGif(bytes)`: parse the GIF block stream — Header, Logical Screen Descriptor, optional Global Color Table, then a sequence of blocks until the trailer `0x3B`. **Drop** privacy-bearing extension blocks: the Comment Extension (`0x21 0xFE`) and the XMP Application Extension (`0x21 0xFF` with the `XMP DataXMP` identifier). **Preserve** everything that controls rendering/animation: Graphics Control Extensions (`0x21 0xF9`, per-frame timing/disposal), the NETSCAPE2.0 Application Extension (`0x21 0xFF` `NETSCAPE2.0`, the loop count — dropping it would break looping), Image Descriptors + Local Color Tables, and all image data sub-blocks. Walk sub-block chains by their length-prefix bytes (terminator `0x00`). Return `{ ok, bytes, stripped }`; on a structurally invalid/truncated GIF return a typed failure (the route maps it to 415, mirroring the AVIF `metadata_strip_unsupported` path). This is byte-level, no re-encode, length-shrinking only by the bytes removed.

**Acceptance criteria:**
- An animated, looping GIF with a Comment + XMP block: stripped of both, still a valid looping animation (NETSCAPE + all GCEs + frames intact) — verified by re-parsing the output block stream.
- A clean static/animated GIF passes through unchanged except a `stripped=false` flag.
- A malformed/truncated GIF returns the typed failure, never a partial write.
- No fixed-offset assumptions: a GIF with a Global Color Table of any size parses correctly.

**Testing:** Unit/property — round-trip block-stream re-parse asserting preserved vs. dropped blocks; fuzz truncations reject cleanly; a fixture animated GIF keeps its frame count + loop count after stripping.

**Dependencies:** WS-T.1.3.

---

### WS-T.4.2 Wire `image/gif` into `POST /v1/uploads`
**ID:** WS-T.4.2 | **Ref:** Sections 14.1, 15.5, 25.2

**Description:** In `apps/api/src/routes/forum.ts` admit `image/gif` to the upload handler: route it through `stripUploadMetadata` (now GIF-aware), enforce `MAX_GIF_BYTES`, require `alt_text` (image group), set `metadata_stripped`, and run the existing `uploadScanner.scan` gate (flagged → rejected at creation, never served). Serving (`GET /v1/uploads/:id`) needs no change — GIF falls under `img-src 'self'`, inline `Content-Disposition`, the WS-Q story-scoped authorization. Update the 415 "Allowed:" message to include GIF.

**Acceptance criteria:**
- A valid GIF uploads, is metadata-stripped + scan-cleared, and serves inline same-origin with `alt_text`.
- A GIF over `MAX_GIF_BYTES` → 413/415 per the existing size path; a GIF without alt text → 422.
- The shipped test that asserts `image/gif` → 415 (`forum-coverage.test.ts:146`) is updated to assert acceptance instead.

**Testing:** Route tests — accept valid GIF; reject oversize, missing-alt, and malformed; confirm scan-gate hold path; update the legacy 415 assertion.

**Dependencies:** WS-T.4.1.

---

## WS-T.5 Live comments (same-origin SSE)

### WS-T.5.1 Comment fan-out pub/sub
**ID:** WS-T.5.1 | **Ref:** Sections 23.5, 25.4

**Description:** Add a `CommentBroadcaster` port in `apps/api/src/forum/` with `publish(threadId, frame)` and `subscribe(threadId, handler): () => void`. Ship two adapters mirroring the existing store pattern: an **in-process `EventTarget`/emitter** (dev, e2e-server, single-instance) and a **Redis pub/sub** adapter (prod, channel `licio:comments:{threadId}`, reusing the `ioredis` client + the `*-redis-*-stores.ts` gating). The contribution create flow (WS-T.3.2) publishes a frame **only for published comments** (held/removed emit nothing), carrying the same public projection the REST read returns (incl. resolved `media`) plus the parent id for client placement. Wire the adapter through the injectable forum service container; default-closed if Redis is unconfigured in prod (log + fall back to in-process, which is correct for a single instance).

**Acceptance criteria:**
- A published comment fans out to every subscriber of its thread; a held/removed one does not.
- Frames carry only the public projection (no scores, no raw attention, no private fields) — asserted by an introspection test.
- Redis adapter is gated like the other prod adapters; the in-process adapter needs no infra for dev/e2e.

**Testing:** Unit — publish/subscribe/unsubscribe over the in-process adapter; held-comment suppression; projection-shape assertion. Gated — Redis fan-out across two subscribers.

**Dependencies:** WS-T.3.2, WS-T.3.4.

---

### WS-T.5.2 `GET /v1/stories/:storyId/comments/stream` (SSE)
**ID:** WS-T.5.2 | **Ref:** Sections 16.2, 19.1, 23.5, 25.2

**Description:** Add a same-origin SSE endpoint (Hono streaming) that resolves the story's thread, **enforces the WS-Q room read bar once at connect** (404 to outsiders), subscribes via `CommentBroadcaster`, and emits `event: comment` frames (`data:` = the public projection) as they publish. Send periodic `: heartbeat` comments (~25 s) to keep the connection alive through proxies, and honor `Last-Event-ID` by replaying any comments created after that id from the store on (re)connect (bounded catch-up window). The endpoint is `connect-src 'self'` (no CSP change). Apply a global per-endpoint connection budget (identity-free, the §19.1 pattern — never the client address) and clean up the subscription on disconnect. Block/mute filtering is applied per-frame for the connecting user.

**Acceptance criteria:**
- EventSource against the endpoint receives new public comments live; outsiders to a private room get 404 at connect and no stream.
- Heartbeats keep the stream open; `Last-Event-ID` reconnect replays the gap with no duplicates and no missed comments.
- Blocked/muted authors' comments are not delivered to the connecting user.
- No IP/address is read; the connection budget is global/per-endpoint.

**Testing:** Integration — connect + receive a published comment; reconnect with `Last-Event-ID` replays exactly the gap; read-bar 404; block/mute filtering; the `no-client-address` test stays green.

**Dependencies:** WS-T.5.1.

---

### WS-T.5.3 Client `useCommentStream` (EventSource + cache merge + fallback)
**ID:** WS-T.5.3 | **Ref:** Sections 6.4, 11.6, 23.5

**Description:** Add a `useCommentStream(storyId)` hook in `apps/web/src/lib/` that opens an `EventSource` to the WS-T.5.2 endpoint, validates each frame through the shared comment zod schema before use (the WS-C boundary rule), and merges new comments into the TanStack Query cache for the comment list. New comments from OTHERS surface as a non-disruptive **"N new comments"** affordance (do not yank the reader's scroll); the reader's OWN just-posted comment is reconciled optimistically (dedup by `client_draft_id`). Reconnect with exponential backoff + `Last-Event-ID`; on `EventSource` unavailability or repeated failure, fall back to the SWR refetch-on-focus + interval poll already in the query layer. Respect the reader's focus/visibility (pause the "new" nudge when the tab is hidden).

**Acceptance criteria:**
- A comment posted elsewhere appears via the "N new" affordance without scroll disruption; clicking reveals it.
- The reader's own post is not double-rendered (idempotent merge by `client_draft_id`).
- Falls back to polling cleanly where `EventSource` is unavailable (older WebViews); no console errors.
- Every streamed frame is zod-validated before entering the cache.

**Testing:** Unit/jsdom — mock `EventSource`: merge + dedup + "N new" gating; fallback path when `EventSource` is undefined; schema-rejection of a malformed frame.

**Dependencies:** WS-T.5.2, WS-T.7.1.

---

## WS-T.6 Reply notifications

### WS-T.6.1 Reply-notification trigger + schema
**ID:** WS-T.6.1 | **Ref:** Sections 18.4, 19.1, 21.3

**Description:** Extend `packages/shared/src/schemas/notifications.ts` with a `reply` notification kind (`{ kind: 'reply', notification_id, story_id, thread_id, comment_id, parent_comment_id, actor_handle, created_at }` — ids/handles only, no body text, no scores). In the create flow (WS-T.3.2), when a **published** comment has a `parent_contribution_id`, look up the parent's author; if the parent author ≠ the new author, is not in a block/mute relationship with the new author (reuse the WS-J `RelationshipReader`), and the comment is not held, enqueue exactly one `reply` notification for the parent author. Enqueue is best-effort/detached (never blocks the create response) and idempotent on `comment_id` (a reply edit does not re-notify).

**Acceptance criteria:**
- A published reply to user A's comment enqueues one `reply` notification for A; a top-level comment, a self-reply, a blocked/muted pair, or a held comment enqueues none.
- The payload carries no body text, no attention data, no scores.
- Editing the reply does not re-notify.

**Testing:** Unit — trigger matrix (reply/self/top-level/blocked/muted/held); idempotency on re-publish; payload-shape assertion.

**Dependencies:** WS-T.3.2.

---

### WS-T.6.2 Deliver via push + notification budget
**ID:** WS-T.6.2 | **Ref:** Sections 11.6, 19.4, 25.3

**Description:** Route the `reply` notification through the existing delivery stack: the server `push-service.ts` (VAPID web-push) for subscribed devices, gated by the client `notification-meter.ts` per-day budget and the WS-H.6.1c quiet-topic policy (a narrow-loop topic shows silently). Respect the user's notification preferences (the WS-D privacy/notification settings already gate categories) — a `reply` category opt-out suppresses both push and buzz while still recording the in-app item. No new secret, no new dependency (VAPID keys already provisioned).

**Acceptance criteria:**
- A subscribed, in-budget, opted-in user receives a push for a reply; out-of-budget/quiet-topic delivers silently; opted-out delivers nothing (but see WS-T.6.3 in-app).
- Delivery reads no client address; keying is the existing account/subscription ref.
- The notification deep-links to the story page anchored at the comment.

**Testing:** Unit — delivery decision matrix over {subscribed, budget, quiet-topic, opt-out}; deep-link target correctness.

**Dependencies:** WS-T.6.1.

---

### WS-T.6.3 In-app reply indicator + list
**ID:** WS-T.6.3 | **Ref:** Sections 6.5, 11.6

**Description:** Surface replies-to-you in-app independent of push: a small unread indicator (on the Profile tab and/or an app-shell affordance) and a notifications list rendering `reply` items (actor handle, story title, relative time) that deep-link to the story page at the comment. Reuse the existing notifications query/route plumbing; mark-read on view. This is the always-available channel when push is off/unsupported (the SPEC availability-over-confidentiality posture for notifications).

**Acceptance criteria:**
- New replies raise the unread indicator; opening the list and viewing clears it; each item deep-links to the comment.
- Works with push disabled/unsupported; no layout shift on the app shell; axe-clean.
- No applause surface is introduced (the list shows replies, never counts/reactions) — `check:no-applause` extended to the new components.

**Testing:** Unit/jsdom — indicator state machine; deep-link nav; axe; no-applause scan of the new components.

**Dependencies:** WS-T.6.1.

---

## WS-T.7 Web client: the comment section

### WS-T.7.1 `CommentSection` embedded in the story page
**ID:** WS-T.7.1 | **Ref:** Sections 6.4, 15.3, 23.3

**Description:** Add `apps/web/src/components/comments/CommentSection/` and mount it in `apps/web/src/routes/-pages/stories.tsx`, **replacing** the "View the conversation" `Link` with the inline section below the story body. It owns: the §24.3 summary slot (Overview), the top-level `CommentComposer` (WS-T.7.3), the `CommentList` (WS-T.7.2), the optional filter chips (WS-T.7.5), "load more" pagination, and the live-stream wiring (WS-T.7.7). Add the comment query hooks to `apps/web/src/lib/queries.ts` (keyset list + infinite "load more") and the typed client calls to `apps/web/src/lib/api.ts`, every response zod-validated before cache (WS-C boundary rule). The section carries the `id="comments"` anchor used by the back-compat redirect and notification deep links, and marks the story the active signal item (existing dwell behavior) — the comment section is part of the story, so no separate active-item churn.

**Acceptance criteria:**
- Opening a story shows the conversation inline (no navigation); the old conversation link is gone.
- Comments load (with skeleton), paginate, and survive the offline read-through fallback (cached snapshot) like the old thread did.
- `#comments` anchor scrolls to the section; the summary renders in the Overview slot when present.
- All comment responses are zod-validated before entering the cache.

**Testing:** Unit/jsdom — render with seeded comments; load-more; empty state; offline snapshot fallback; anchor scroll; axe.

**Dependencies:** WS-T.3.1.

---

### WS-T.7.2 `CommentList` + `CommentItem` (lightly nested)
**ID:** WS-T.7.2 | **Ref:** Sections 6.4, 15.5, 18.4

**Description:** Render the lightly-nested stream: top-level `CommentItem`s, each with its bounded reply preview and a collapsible "N replies"/"continue thread" control that loads deeper replies via the subtree read (one visible nesting level; deeper indentation is capped and replaced by "continue thread"). Each `CommentItem` shows author handle/display name, relative time, the UGC-rendered body (`UgcBody`/`renderUGC`), inline `CommentMedia` (WS-T.7.4), `edited`/`under_review` badges, and the honest tombstone state for removed/hidden ancestors. Per-comment actions: **Reply** (opens WS-T.7.6), **Report** (the WS-J `ReportButton` — this is where `moderation_concern` went), **block/mute** (the WS-J controls), and author-only **Edit**/**Delete** (reuse the existing edit/tombstone mutations). An `evidence`/`correction` comment shows a small, non-scored badge ("Source"/"Correction") and its citation card (reuse the WS-G evidence card render). No score, count, or reaction affordance anywhere.

**Acceptance criteria:**
- Lightly-nested layout: top-level + one collapsible reply level + "continue thread"; depth never visually runs past the cap.
- Edit/delete/report/block/mute are present per the user's permissions; tombstones preserve replies.
- `evidence`/`correction` badges + citation cards render; legacy typed contributions render as comments with the right badge (or none).
- `check:no-applause` passes over `components/comments/**`.

**Testing:** Unit/jsdom — nesting + collapse; tombstone; author vs. non-author action sets; legacy-type rendering; no-applause scan; axe.

**Dependencies:** WS-T.7.1, WS-T.7.4.

---

### WS-T.7.3 `CommentComposer` (simple box + enrichments + drafts)
**ID:** WS-T.7.3 | **Ref:** Sections 6.6, 15.1, 15.5, 25.2

**Description:** Add `apps/web/src/components/comments/CommentComposer/` — the inline composer that replaces `ParticipationComposer` for conversation. Default state: a Markdown-lite textarea (reuse `VoiceDictation`) + an **image/GIF attach** (reuse `Attachment` with `accept="image/jpeg,image/png,image/webp,image/avif,image/gif"`, single file, local preview via `blob-url.ts`, required alt-text field, client-side size check vs. `MAX_GIF_BYTES`/`MAX_IMAGE_BYTES`) + **Post**. Two progressive enrichment toggles: **Add a source** (reveals `CitationCapture` + claim ref → submits as `type: 'evidence'` with the relevance note = body) and **Mark a correction** (reveals citation + claim ref → `type: 'correction'`); with neither, it submits `type: 'comment'`. An optional, collapsed "viewpoint (lens)" select keeps SCOI fed. Enforce body-or-media client-side (mirror WS-T.1.2). Persist an **encrypted offline draft** (reuse `draft-crypto` + `client_draft_id` idempotency) with autosave/recovery; optimistic insert into the list on submit; clear the draft on success. Port the no-applause composer test.

**Acceptance criteria:**
- Posting text, a GIF, or both works; empty-and-medialess is blocked with a clear message; alt text is required for media.
- "Add a source"/"Mark a correction" submit the correct `type` with citations/claim; default is `comment`.
- Drafts encrypt at rest, autosave, recover after reload, and dedup via `client_draft_id`; optimistic insert reconciles with the server/stream echo.
- No mode chooser, no eleven-mode UI; `check:no-applause` + the ported composer test pass.

**Testing:** Unit/jsdom — submit matrix (comment/evidence/correction × text/media/both); alt-text + body-or-media gating; draft encrypt/recover/dedup; optimistic insert; axe; no-applause.

**Dependencies:** WS-T.1.2, WS-T.1.3, WS-T.3.2.

---

### WS-T.7.4 `CommentMedia` (image/GIF render, motion-safe)
**ID:** WS-T.7.4 | **Ref:** Sections 6.4, 15.5; WS-B motion doctrine

**Description:** Add `apps/web/src/components/comments/CommentMedia/` rendering a comment's resolved `media` (WS-T.1.4): a same-origin `<img>` (`img-src 'self'`) with required `alt`, intrinsic sizing to avoid layout shift, and `loading="lazy"`. For **animatable** GIFs, respect reduced motion (the OS `prefers-reduced-motion` AND the in-app `ui` motion setting): when reduced, render a **static first-frame poster** (draw frame 1 to a `<canvas>` once, show it with a visible **Play** control that swaps in the animated `<img>` on activation); when motion is allowed, render the animated `<img>` directly with a Pause affordance. No third-party image library (canvas first-frame only). Never autoplay video (none here) and never animate against the reader's stated preference.

**Acceptance criteria:**
- Image/GIF renders inline, same-origin, with alt text and no CLS.
- Under reduced-motion, GIFs do not animate until the reader presses Play; otherwise they animate with a Pause control.
- No external origin contacted; no new dependency added.

**Testing:** Unit/jsdom — reduced-motion poster vs. animated path; alt present; play/pause toggle; axe; (the canvas first-frame is mocked in jsdom).

**Dependencies:** WS-T.1.4.

---

### WS-T.7.5 Optional Sources/Corrections filter
**ID:** WS-T.7.5 | **Ref:** Sections 6.4, 15.3

**Description:** A light, de-emphasized filter row (chips: **All** · **Sources (N)** · **Corrections (N)**) over the single comment stream, driving the `?filter=` param of WS-T.3.1; counts come from the overview projection (WS-T.3.3). This is the residue of the six sections — discoverability of evidence/corrections without a mandatory tab structure. Default is All; the filter is keyboard-operable and announced.

**Acceptance criteria:**
- Selecting Sources/Corrections narrows the stream to the derived type; All restores it; counts match the overview.
- Filter state is shareable via the URL search param and accessible (roving tabindex / aria-pressed).

**Testing:** Unit/jsdom — filter switch + count display; URL param round-trip; axe.

**Dependencies:** WS-T.7.1.

---

### WS-T.7.6 Inline reply composer + "continue thread"
**ID:** WS-T.7.6 | **Ref:** Sections 6.4, 15.5

**Description:** Reply affordance on each `CommentItem` opens an inline `CommentComposer` instance pre-bound to `parent_contribution_id` (reusing WS-T.7.3 wholesale). "Continue thread"/"N replies" expands deeper descendants via the subtree query (keyset "show more"). Focus management: opening a reply moves focus into the textarea; posting returns focus to the new comment; collapsing returns focus to the toggle (WS-C a11y focus rules).

**Acceptance criteria:**
- Replying nests correctly under the parent (depth-capped) and appears optimistically; "continue thread" loads deeper replies.
- Focus moves predictably on open/post/collapse; the depth cap shows "continue thread" rather than infinite indentation.

**Testing:** Unit/jsdom — reply submit + nesting; subtree expand; focus assertions; axe.

**Dependencies:** WS-T.7.3.

---

### WS-T.7.7 Wire live updates + reply indicator into the section
**ID:** WS-T.7.7 | **Ref:** Sections 6.4, 11.6, 23.5

**Description:** Connect `useCommentStream` (WS-T.5.3) into `CommentSection`: render the non-disruptive "N new comments" affordance, reconcile the reader's own optimistic posts, and surface the in-app reply indicator (WS-T.6.3) contextually when a reply to the reader arrives in the open thread. Pause the stream/affordance when the tab is hidden or the section is offscreen; resume on focus. Tie into the existing offline/eviction toasts for a degraded (poll-only) mode.

**Acceptance criteria:**
- New comments from others surface via "N new" without scroll disruption; the reader's own appear immediately and aren't duplicated.
- Stream pauses when hidden/offscreen and resumes on focus; poll-only fallback is silent and correct.
- A reply-to-you in the open thread is reflected in the in-app indicator.

**Testing:** Unit/jsdom — stream merge into the live section; visibility pause/resume; fallback; dedup of own post.

**Dependencies:** WS-T.5.3, WS-T.7.1, WS-T.6.3.

---

## WS-T.8 Navigation and route retirement

### WS-T.8.1 Remove the Threads tab (5 → 4 tabs)
**ID:** WS-T.8.1 | **Ref:** Sections 6.4; WS-B.1.5 nav

**Description:** In `apps/web/src/components/ui/BottomNav/BottomNav.tsx` drop the `threads` item from `defaultNavItems` (now Front Page · Rooms · Submit · Profile, Submit staying the prominent center entry). In `apps/web/src/routes/__root.tsx` remove the `/threads` branch from `activeTabId`. Re-balance the bar layout for four items (thumb-zone spacing on mobile, side rail on lg+). Update the nav i18n keys/tests.

**Acceptance criteria:**
- The Threads tab is gone; the four remaining tabs are evenly laid out on mobile and the rail; the active state is correct for `/`, `/rooms`, `/submit`, `/profile`.
- No dangling `nav.threads` usage; existing BottomNav tests updated.

**Testing:** Unit/jsdom — nav renders four items; active-tab mapping; axe; (the no-applause nav check stays green).

**Dependencies:** WS-T.7.1 (conversation reachable inline before the tab is removed).

---

### WS-T.8.2 Retire the thread/branch routes; add a back-compat redirect
**ID:** WS-T.8.2 | **Ref:** Sections 6.4, 23.2

**Description:** Delete `apps/web/src/routes/threads.tsx` (directory), `threads_.$threadId_.branches.$branchId.tsx` (branch), the `-pages/threads.tsx` page components, and the `ThreadBranchNav` component (+ its tests). Replace `threads_.$threadId.tsx` with a **redirect route**: resolve the thread's `story_id` (WS-T.3.6) and `navigate`/redirect to `/stories/$storyId#comments` (preserving any contribution anchor as the comment `#id`); on 404/unreadable, render the existing not-found/`ErrorState`. Remove the retired routes from `routeTree.gen.ts` (regenerated) and the threads search schema from `routing/search.ts`. Update the WS-G.3.3 thread-discovery E2E to the story→comments path (or retire it in favor of WS-T.9.2).

**Acceptance criteria:**
- `/threads/$threadId` (and old branch/anchor deep links) redirect to the owning story's comment section; unreadable/unknown → not-found.
- The directory and branch routes no longer exist; `pnpm typecheck` + route generation are clean.
- No reference to `BranchId`/`ThreadBranchNav` remains in the web app.

**Testing:** Unit/jsdom + E2E — redirect target + anchor; 404 path; route-tree snapshot; grep proof the retired symbols are gone.

**Dependencies:** WS-T.3.6, WS-T.7.1.

---

### WS-T.8.3 `/submit` reverts to story submission only
**ID:** WS-T.8.3 | **Ref:** Sections 6.6, 14.1

**Description:** In `apps/web/src/routes/-pages/submit.tsx` and `routing/search.ts` remove the contribution-composer mode (the `?threadId`/`?branch` branch that hosted `ParticipationComposer`); `SubmitPage` renders only `StoryComposer` (story submission, WS-Q.5). Delete `apps/web/src/components/composer/ParticipationComposer/` (`ParticipationComposer.tsx`, `modes.ts`, `payload.ts`, indexes, tests) and any now-orphaned `ComposerAffordances` used only by it (keep `Attachment`, `CitationCapture`, `VoiceDictation`, `PrivacyWarning`, `ContextWarning` — reused by `CommentComposer`). Simplify `submitSearchSchema` accordingly.

**Acceptance criteria:**
- `/submit` shows only the story composer; no `threadId`/`branch` search params remain valid.
- `ParticipationComposer` + `modes.ts` + `payload.ts` are deleted; no import survives; shared affordances still used by `CommentComposer` remain.
- `pnpm typecheck`, `pnpm lint`, and the bundle-size gate pass (bundle should shrink).

**Testing:** Unit/jsdom — `/submit` renders the story composer only; grep proof the composer files are gone; bundle-size check.

**Dependencies:** WS-T.7.3 (the comment composer must exist before the participation composer is deleted).

---

### WS-T.8.4 Signals: drop branch visits, source the reply-depth bucket
**ID:** WS-T.8.4 | **Ref:** Sections 22.1, 19.1

**Description:** Remove `recordBranchVisit` calls (the retired thread page was the only caller) and repoint `TraversalTracker` to record **reply-depth levels read** in the comment section, feeding `replyDepthBucket` (WS-T.1.7). In `apps/web/src/signals/`, rename the tracker method/field accordingly and have `CommentSection`/`CommentItem` report the deepest reply level the reader expands (coarse, in-browser only; nothing raw leaves). Ensure `buildAggregate` consumes the renamed input. Keep the story-as-active-item dwell behavior unchanged.

**Acceptance criteria:**
- No `recordBranchVisit`/branch traversal remains; the aggregate carries `reply_depth_bucket` sourced from comment expansion.
- `check:no-raw-egress` + `assertNoRawEgress` pass; only the bucket (never a raw depth/count) is emitted.
- Dwell/return tracking for the story is unchanged.

**Testing:** Unit — tracker records reply depth → bucket; no-raw-egress; aggregate build with the renamed field.

**Dependencies:** WS-T.1.7, WS-T.7.2.

---

## WS-T.9 Tests, gates, and documentation

### WS-T.9.1 Extend the static doctrine gates to the comment surfaces
**ID:** WS-T.9.1 | **Ref:** Sections 13, 22.1, 30.6

**Description:** Make the new surfaces first-class under the existing CI gates. `check:no-applause` already scans `components/` + `routes/`; confirm `components/comments/**` and the story-page comment section are covered (a GIF/image attach and a reply are content affordances, never reactions — add an explicit allow-rationale comment where the scanner might false-positive on "media"). Re-run `check:no-raw-egress` after the `reply_depth_bucket` repurpose. Add an introspection test asserting SSE frames and `reply` notification payloads contain no score/raw-attention/financial fields (the §30.6 firewall + no-applause posture extended to the live channels). Confirm `check:neutrality` is unaffected (ranking consumes story/thread aggregates, not comment shape) — add a one-line note to the neutrality suite that the comment remodel does not touch ranking inputs.

**Acceptance criteria:**
- `pnpm check:no-applause`, `pnpm check:no-raw-egress`, `pnpm check:neutrality` all pass on the remodeled tree.
- The SSE/notification payload introspection test fails if a score/raw field is ever added.

**Testing:** the gate scripts themselves + the new introspection unit test.

**Dependencies:** WS-T.5.2, WS-T.6.1, WS-T.7.x.

---

### WS-T.9.2 BFF-in-the-loop E2E for the comment flow
**ID:** WS-T.9.2 | **Ref:** Sections 6.4, 15.5, 23.5; WS-P E2E harness

**Description:** Add a `*.bff.spec.ts` authenticated E2E (the in-memory `e2e-server` + gated test-login + proxied preview) driving the full flow in real browsers: open a story → see the inline comment section → post a text comment → reply to it → attach and post a GIF (asserting it renders inline, motion-safe) → observe a second session's comment arrive live via SSE → report a comment (WS-J sheet). Wire the `e2e-server` with the in-process `CommentBroadcaster` and the GIF upload path. axe-core assertions on the story page with the section open.

**Acceptance criteria:**
- The spec posts/replies/attaches/streams/reports against a real BFF over one same-origin host and passes on Chromium/Firefox/WebKit in CI.
- The GIF renders inline; the live comment appears without reload; axe is clean.

**Testing:** the E2E spec itself (CI E2E job).

**Dependencies:** WS-T.7.x, WS-T.4.2, WS-T.5.2.

---

### WS-T.9.3 Documentation sync
**ID:** WS-T.9.3 | **Ref:** Section 30; CLAUDE.md documentation rules

**Description:** Update, in the same workstream: `docs/forum/README.md` (the WS-G implementation reference → describe the comment model, the surviving evidence/correction enrichments, the retired sections/types, GIF media, SSE, reply notifications, and the back-compat read posture); `docs/pwa-client/README.md` (routing changes — Threads tab/routes retired, `/submit` story-only; the comment-section signals/`reply_depth_bucket`; SSE + reply push); `README.md` (status/quickstart if surfaced); `CLAUDE.md` **and** `AGENTS.md` byte-identical (source-layout: new `components/comments/**`, `forum/comments.ts`, the retired composer/threads files; current-status line for WS-T; the GIF/SSE notes); `DEVELOPMENT.md` (the seeded demo now shows inline comments incl. a GIF; sign-in flow unchanged); `docs/planning/00-index.md` (add the WS-T row to the Document Map, bump the task total + a revision-history entry, and extend the dependency graph). SPEC edits are WS-T.1.1.

**Acceptance criteria:**
- Every listed doc reflects the shipped behavior; `CLAUDE.md`/`AGENTS.md` are byte-identical; the index totals/graph include WS-T.
- `pnpm check:policy` passes; no doc claims a retired surface still exists.

**Testing:** doc lint/policy check; a diff review that `CLAUDE.md`/`AGENTS.md` match (the repo's existing identity check).

**Dependencies:** all prior WS-T cards (documents the shipped end state).

---

### WS-T.9.4 Migration-validation + back-compat read harness (gated)
**ID:** WS-T.9.4 | **Ref:** Sections 15.1, 22.1, 30.8

**Description:** A gated (Postgres) harness that applies `0029`–`0032` over a DB seeded with all eleven legacy contribution types + legacy summaries (with `cited_branch_ids`) and asserts: every legacy contribution reads back through `GET /v1/stories/:storyId/comments` as a comment (evidence/correction enrichment surfaced; question/answer/synthesis/etc. rendered as plain comments); media-only comments insert; summaries expose `cited_contribution_ids`; GIF uploads strip+serve. Property check: no historical row becomes unreadable or changes visibility as a result of the remodel.

**Acceptance criteria:**
- The full chain is green in CI's Postgres container; all legacy types render; no visibility/readability regression.
- The harness fails if any legacy row is dropped, mistyped, or made unreadable.

**Testing:** the gated integration harness (CI Test & Coverage job).

**Dependencies:** WS-T.2.x, WS-T.3.1, WS-T.4.2.

---

## Dependency graph

```
WS-T.1.1 (SPEC amendment)
 ├── WS-T.1.2 (comment write schema) ──┬── WS-T.2.1 (enum 0029) ── WS-T.2.2 (body CHECK 0030)
 │                                     ├── WS-T.3.2 (create accepts comment) ──┬── WS-T.3.5 (deepening set)
 │                                     │                                       ├── WS-T.5.1 (broadcaster) ── WS-T.5.2 (SSE) ── WS-T.5.3 (client stream)
 │                                     │                                       └── WS-T.6.1 (reply trigger) ──┬── WS-T.6.2 (push)
 │                                     │                                                                      └── WS-T.6.3 (in-app)
 │                                     └── WS-T.1.6 (retire BranchId/synthesis write)
 ├── WS-T.1.3 (GIF shared types) ──┬── WS-T.2.3 (gif CHECK 0031)
 │                                 └── WS-T.4.1 (stripGif) ── WS-T.4.2 (uploads accept GIF)
 ├── WS-T.1.4 (read media projection) ── WS-T.3.4 (resolve media)
 ├── WS-T.1.5 (summary rename) ── WS-T.2.4 (summary col 0032)
 ├── WS-T.1.7 (reply-depth signal) ── WS-T.8.4 (web signal source)
 └── WS-T.3.1 (comments read) ──┬── WS-T.3.3 (retire sections) ── WS-T.3.6 (thread→story resolver)
                                ├── WS-T.7.1 (CommentSection) ──┬── WS-T.7.2 (list/item) ── WS-T.7.4 (media render)
                                │                               ├── WS-T.7.3 (composer) ── WS-T.7.6 (reply composer)
                                │                               ├── WS-T.7.5 (filters)
                                │                               └── WS-T.7.7 (live + indicator)
                                └── WS-T.8.x (nav + route retirement: 8.1 → 8.2 → 8.3 after 7.3; 8.4 after 7.2)

WS-T.9.1/9.2/9.3/9.4 (gates, E2E, docs, migration harness) depend on the relevant feature cards above.
```

**Suggested execution order (waves within WS-T):**

1. **Doctrine + schemas:** T.1.1 → T.1.2, T.1.3, T.1.4, T.1.5, T.1.6, T.1.7.
2. **Storage:** T.2.1 → T.2.2; T.2.3; T.2.4 (parallel).
3. **GIF pipeline:** T.4.1 → T.4.2 (parallel with storage).
4. **Backend reads/writes:** T.3.2 → T.3.5; T.3.1 → T.3.3 → T.3.6; T.3.4.
5. **Live + notifications:** T.5.1 → T.5.2; T.6.1 → T.6.2, T.6.3.
6. **Client UX:** T.7.1 → T.7.2/T.7.3/T.7.4/T.7.5 → T.7.6 → T.5.3/T.7.7.
7. **Nav + retirement:** T.8.1, T.8.2 (after redirect), T.8.3 (after the comment composer ships), T.8.4.
8. **Gates, E2E, docs, harness:** T.9.1, T.9.2, T.9.4, then T.9.3 last (documents the shipped end state).

**Forward-compat notes.** WS-R (LCAP offline ingress) reconciles records into the same `contributions` rows; comments are LCAP-carriable unchanged. WS-S (E2EE P2P rooms) keeps its server-non-storage contract — the SSE broadcaster and reply notifications MUST exclude `private_p2p` rooms (no server-side comment storage to stream), tracked as a WS-S gate, not a WS-T card. WS-K (AI governance) owns the automated-draft summary; the §24.3 rename (`cited_contribution_ids`) is the only field it must follow.


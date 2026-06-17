# WS-T: Conversation as Comments — Inline Comment Sections

**Milestone:** M3 (remodel of shipped M1/M3 surfaces) | **Priority:** P1 | **Dependencies:** WS-G (forum/threads/contributions/composer/UGC), WS-Q (room/content/visibility/native media + `media-urls.ts`), WS-E (events/PWAtt/attention signals), WS-J (report/block/mute affordances + `RelationshipReader`), WS-C (PWA: push, notification budget, offline drafts, routing/signals) — all complete; WS-H/WS-I consume contributions and MUST keep their inputs | **Wave:** 12 (post-WS-Q remodel; does not block WS-R/WS-S, parallelizable with them) | **Estimated duration:** 6-8 weeks | **Task count:** 64 atomic cards

---

## Overview

WS-T replaces Licio's **structured-thread** conversation model — six fixed sections read "never as a flat list" (SPEC §6.4/§15.3) plus an eleven-mode participation composer (§6.6/§15.1) reached through a separate `/submit` page — with a **lightly-nested comment section embedded directly in the content page** (`/stories/$storyId`). This is a deliberate SPEC change (§3.4.2, §6.4, §6.5, §6.6, §15.1, §15.3, §15.5, §24.3 are amended), executed so that the rich invariant/ranking/summary machinery underneath keeps working.

The redesign rests on three audit findings, each verified against the shipped tree:

1. **The six sections are a read-time projection, not stored data.** A contribution's "branch" is computed from its `type` by the static `SECTION_TYPES` map in `apps/api/src/forum/tree.ts`; there is no `branch`/`section` column. Retiring the sections is a read-layer change with no data migration.
2. **The materialized-path `contributions` tree already supports comments.** `path` (JSONB, depth ≤ 10, GIN-indexed), `parent_contribution_id`, `client_draft_id` idempotency, edit history, and tombstones are exactly what a lightly-nested comment section needs — unchanged.
3. **The invariants key on `type` / `metadata.lens_id` / evidence cards / tree depth, never on the six sections.** MERI (claim-independence evidence groups), SCOI (`lens_id`), GWEI (tree depth + lens keys), Hodge (`type`→`kind` via `KIND_BY_TYPE`), and WS-I (story/thread-level aggregates) all survive a section retirement as long as `type`, `lens_id`, and evidence cards are preserved.

The model becomes:

    Room  ⊃  Content (story)  ⊃  Thread (comment section)  ⊃  Comments (lightly nested)

1. **Comment is the core unit.** A comment is Markdown-lite text **and/or** an uploaded image/GIF, posted inline on the story page, optionally as a reply (lightly nested: top-level comments + one collapsible reply level + a "continue thread" link deeper). It replaces "post for applause" exactly as the eleven typed contributions did — there is still no react/like/vote anywhere (no-applause doctrine; a GIF is comment *content*, authored and threaded and reportable, never a one-tap reaction tally).
2. **Two typed enrichments survive, as optional toggles on a comment** (the user-ratified subset): **Cite a source** (→ the existing `evidence` type + evidence card, which feeds MERI and the evidence drawer) and **Mark a correction** (→ the existing `correction` type, which feeds correction-accuracy reputation §15.6 and the Hodge `correction` signal). They are progressive controls that change the comment's stored `type`, not separate composer modes. The interpretation **lens** stays in the data model (SCOI depends on `metadata.lens_id`) behind an unobtrusive optional control.
3. **The other nine types are retired for new writes** (existing rows keep their type and render as comments): `question`/`answer` become ordinary comments/replies; `counterexample`/`explanation`/`local_context`/`direct_experience`/`meta_discussion` become ordinary comments; `moderation_concern` becomes the **WS-J Report flow** mounted on every comment; `synthesis` becomes the **community-synthesis summary layer** that already exists in the `summaries` table. The full `contribution_type` enum stays for backward-compatible reads, and `FORUM_TO_EVENT_TYPE`/`KIND_BY_TYPE` keep all eleven legacy keys plus the new `comment`.
4. **The six sections become (at most) light optional filters.** The default read is a single lightly-nested chronological stream; an optional, de-emphasized filter exposes **Sources** and **Corrections** (derived from `type`), and the **Overview** becomes the §24.3 summary shown atop the section. No mandatory six-tab structure, no per-branch reads.
5. **The conversation lives on the content page.** The `/threads` directory tab, the `/threads/$threadId` reader, and the `/threads_/$threadId_/branches/$branchId` route are retired; `/threads/$threadId` survives only as a thin redirect to the owning story for back-compat deep links. `/submit` reverts to **story submission only**.
6. **Comments stream live** over same-origin Server-Sent Events (already permitted by `connect-src 'self'` — no CSP change), built on the existing Redis pub/sub pattern, with a chronological-refetch fallback. **Replies to your comments notify you** through the existing WS-C push + per-day notification-budget system (extended with a user-scoped send path and a `reply_notifications` preference), plus a new in-app indicator + list (none exists today).
7. **GIFs are first-class comment media** via the existing same-origin upload pipeline: `image/gif` joins the content-type allowlist with a GIF-aware metadata stripper (drops Comment/XMP extension blocks, **preserves** the graphics-control and NETSCAPE-loop blocks so looping animated GIFs survive), the `MAX_GIF_BYTES` cap, the scan gate, and required alt text. Animated GIFs respect reduced-motion (a static first-frame poster with a play control).

The net effect for existing data: every stored contribution stays readable (rendered as a comment, with its evidence/correction enrichment surfaced); nothing publicly visible disappears; the invariant inputs are all preserved.

### Verified integration points (current code)

Confirmed against the shipped tree (paths + symbols verified) so each card is actionable without rediscovery.

| Concern | Symbol / file (verified) | WS-T change |
|---|---|---|
| Write contracts | `contributionCreateSchema` (11-branch discriminated union) / `packages/shared/src/schemas/contribution.ts` | add `commentCreateSchema`; new write union `comment\|evidence\|correction`; body optional with media |
| Read projection | `contributionPublicSchema` / same | keep the full `type` enum on read; add resolved `media[]` (attachment → URL/kind/alt/animatable) |
| Type taxonomy | `CONTRIBUTION_TYPES`, `CONTRIBUTION_BODY_LIMITS` / same (+ `contributionTypeEnum` DB mirror) | append `comment`; deprecate the nine for new writes (kept on read) |
| Section projection | `SECTION_TYPES`, `sectionOfType` / `apps/api/src/forum/tree.ts`; `BranchId`, `contributionAnchorSchema.branch` / `contribution.ts` | retire the six-section read layer; anchor → `(thread_id, root_contribution_id)` |
| Thread reads | `branchContent`, `subtreeContent`, `visibleRows` / `apps/api/src/forum/threads.ts`; routes `/threads/:id`, `/threads/:id/branches/:branch`, `/contributions/:id/anchor` / `apps/api/src/routes/forum.ts` | new `GET /v1/stories/:storyId/comments` (nested, keyset, `?root=`, `?filter=`); overview → counts; reuse `visibleRows`+`subtreeContent` |
| Stores | `listByThread`, `listDescendants`, `childCounts`, `countByType`, `CreatedAtCursor` / `apps/api/src/forum/stores.ts` | reuse unchanged for the nested read + counts |
| Create path | `createContribution` chain; `FORUM_TO_EVENT_TYPE` (`Record<ContributionType, EventContributionType>`); `classifyLowInfoReplyV0` / `apps/api/src/forum/contributions.ts` | accept `comment`; `FORUM_TO_EVENT_TYPE.comment='explanation'` + extend the low-info conditional; reuse all guards |
| Hodge input | `KIND_BY_TYPE` / `apps/api/src/invariants/data.ts` | add `comment: 'attention'` |
| Deepening | `maybeDeepenConversation` evidence-bearing set / `apps/api/src/forum/transitions.ts` | evidence-bearing = `evidence`+`correction` |
| Summaries | `summaryCreateRequestSchema`/`summaryPublicSchema` `cited_branch_ids` / `summary.ts`; `createSummary` / `apps/api/src/forum/summaries.ts` | rename → `cited_contribution_ids` (back-compat alias); §24.3 wording |
| Upload allowlist | `UPLOAD_IMAGE_TYPES` / `forum-api.ts`; `matchesMagic` + `stripUploadMetadata` + `StripOutcome` / `apps/api/src/forum/exif.ts` | add `image/gif` + `MAX_GIF_BYTES`; add `stripGif` to the dispatch |
| Media URLs | `MediaUrlMinter`, `signedMediaUrlPath`, `MEDIA_URL_TTL_MS` / `apps/api/src/lib/media-urls.ts`; `feedMediaOf` / `lib/story-media.ts` | add `commentMediaOf(attachment, mint)`; resolve comment media (signed for `room_only`) |
| Scan gate | `UploadScanVerdict {clear\|pending\|flagged}`, `UploadScanner.scan` / `apps/api/src/forum/safety.ts` | reuse for GIF; flagged never served |
| Attachment render | (none — `attachment_ids` never rendered) | NEW `CommentMedia` renders comment image/GIF inline, motion-safe |
| Composer | `ParticipationComposer`, `modes.ts`, `payload.ts` / `apps/web/src/components/composer/ParticipationComposer/`; reusable `Attachment`, `CitationCapture`, `VoiceDictation`, `PrivacyWarning` / `ComposerAffordances/` | retire `ParticipationComposer`; new `CommentComposer` reuses the affordances |
| Client API | `createContribution`, `fetchThread/Branch`, `parseResponse`, serialized-CSRF `apiFetch` / `apps/web/src/lib/api.ts`; `useThreadQuery`/`useThreadBranchQuery` / `lib/queries.ts` | add `createComment`, `fetchStoryComments`, `useStoryCommentsQuery`; reuse CSRF + `parseResponse` |
| Offline drafts | `saveDraft`/`loadDraft`/`listDraftsForThread`; `draftContributionRecordSchema` (`branch: branchIdSchema`, `contributionType`) / `apps/web/src/offline/drafts.ts`, `offline/schemas.ts`; `encryptDraftValues`/`decryptDraftValues` / `draft-crypto.ts` | drop `branch` from the draft schema, allow `comment`; reuse crypto; bump `RECORD_SCHEMA_VERSION` |
| Story page | `StoryDetailContent` "View the conversation" `Link`; `StoryDetail` (`thread_id`, `is_owner`, `visibility`, `room_visibility`, `media`, `topic_ids`) / `apps/web/src/routes/-pages/stories.tsx` | replace the link with `<CommentSection>` |
| Thread routes | `threads.tsx`, `threads_.$threadId.tsx`, `threads_.$threadId_.branches.$branchId.tsx`, `-pages/threads.tsx`, `ThreadBranchNav`; `threadSearchSchema`/`submitSearchSchema` / `routing/search.ts` | retire; add `/threads/$threadId` → story redirect |
| Navigation | `defaultNavItems`, `activeTabId` / `BottomNav.tsx`, `__root.tsx` | remove the Threads tab (5 → 4 tabs) |
| Attention signal | `branch_depth_bucket`/`branchDepthBucket` (`attention.ts`, the "exactly eleven fields" aggregate); `recordBranchVisit`, `TraversalTracker` / `apps/web/src/signals/`; `FORBIDDEN_KEYS`/`assertNoRawEgress` / `signals/privacy.ts` | rename → `reply_depth_bucket` (still a bucket, not in `FORBIDDEN_KEYS`); remove branch visits |
| Live + notify | Redis pub/sub pattern; `push-service.ts` (session-scoped `getSubscriptions`/`suppressionReason`), `notification-meter.ts`, `notificationPreferencesSchema` (no category system) / shared + apps | NEW `CommentBroadcaster` + SSE; user-scoped push send; `reply_notifications` preference; in-app inbox (none today) |

### Migration strategy (additive; the tree is already comment-ready)

Schema change is minimal because the tree already models nested comments and the six sections were never stored. Migration numbers continue the chain after the shipped `0028`. Each ships an idempotent down path; none drops an enum value or a still-read column in the same window.

| # | Card | Phase | Online-safety note |
|---|---|---|---|
| `0029` | WS-T.2.1 | `ALTER TYPE contribution_type ADD VALUE 'comment'` | non-locking enum extension; old code never emits it (additive-only); standalone statement (cannot share a txn) |
| `0030` | WS-T.2.2 | relax `contributions` body CHECK `1..5000` → `0..5000` | `DROP`/`ADD … CHECK NOT VALID` then `VALIDATE` (no full-table lock); "body OR media" enforced at the zod + service boundary |
| `0031` | WS-T.2.3 | uploads content-type CHECK: add `image/gif` | `NOT VALID` + `VALIDATE`, the `0020` video precedent; the existing `byte_size` CHECK already covers `MAX_GIF_BYTES` (8 MB < 200 MB ceiling) |
| `0032` | WS-T.2.4 | summaries: add `cited_contribution_ids`, backfill from `cited_branch_ids`, keep old column as a read alias | expand→backfill→(deferred contract); cosmetic clarity, never read-breaking |
| `0033` | WS-T.2.5 | `attention_aggregates`: add `reply_depth_bucket` (col + enum), backfill from `branch_depth_bucket`, dual-accept ingest until clients upgrade | expand→dual-write/read→(deferred contract); the durable side of the WS-T.1.7 wire rename, deploy-ordered before the client cutover (WS-T.8.4) |

### Conventions for this workstream

- **No-applause invariant (unchanged).** No card introduces likes, votes, karma, reactions, or follower counts. A GIF/image is comment content, not a reaction; `check:no-applause` is extended to `components/comments/**` and the route copy, and the no-applause composer test is ported to `CommentComposer`.
- **Back-compat reads.** Every contribution ever written stays readable. The `contribution_type` enum, `FORUM_TO_EVENT_TYPE`'s eleven legacy keys, `KIND_BY_TYPE`, and `summaries.cited_branch_ids` are retained; the read projection renders any legacy type as a comment. No card deletes historical data.
- **Event mapping is firewall-safe.** `comment` maps to the public, non-Knomosis event type `explanation`, downgraded to `low_info_reply` by the existing `classifyLowInfoReplyV0(body, hasCitation)` when the body is empty/GIF-only and uncited — so a substantive comment earns participation credit and a bare-GIF reaction earns none, without any new firewall surface (`contribution.created` stays `privacy_classification: 'public'`, carries no body text).
- **One create path, one read bar.** Client and server validate the SAME shared write schema (`comment\|evidence\|correction`); the WS-Q room read bar + visibility gate continue to gate every comment read, the SSE stream, and notifications. No re-implementation, no drift.
- **Privacy unchanged.** Comments carry no raw attention traces; the §22.1 aggregate stays "exactly eleven bucketed fields" (the `reply_depth_bucket` rename is a bucket, never a raw value, and is not in `FORBIDDEN_KEYS`). SSE frames and notification payloads carry only the public projection — ids/handles/bodies that already cross the REST boundary, never scores or private data.
- **Identity-free (Section 19.1).** No card reads or stores IP/geolocation. The SSE endpoint and reply triggers key on the account ref + global budgets, never the client address (the `no-client-address` test stays green).
- **Same-origin only.** GIFs serve from `/v1/uploads/:id` (`img-src 'self'`); the stream is same-origin SSE (`connect-src 'self'`). No external origin enters the CSP; no external GIF provider is contacted.
- **Animation respects motion preference.** Animated GIFs never auto-animate when `prefers-reduced-motion` or the in-app `ui.reducedMotion` setting (`data-motion`) prefers reduced motion: a static first frame + an explicit Play control.
- **Deliberate doctrine simplifications, recorded not hidden.** Retiring the question/answer flag, the direct-experience privacy acknowledgment, and the six sections are explicit SPEC edits (WS-T.1.1a/b), not silent omissions. The general "files carry hidden metadata / don't share others' private info" warning is retained on the attach control; the §19 first-hand-account acknowledgment is dropped per the ratified scope decision and noted in the SPEC.
- **Reuse over rebuild.** `CommentComposer` reuses `Attachment`, `CitationCapture`, `VoiceDictation`, the UGC pipeline (`renderUGC`/`UgcBody`), and the encrypted offline-draft layer (`encryptDraftValues`/`client_draft_id`). The materialized-path tree, the conversation/safety state machines, the safety pre-check → insert → intake flow, and the CSRF-serialized `apiFetch` client are unchanged.
- **Monorepo atomicity.** Wire-shape changes land in `@licio/shared` first; both sides consume the same schemas. Offline caches bump `RECORD_SCHEMA_VERSION` so stale cached shapes (old branch snapshots/drafts, the renamed aggregate field) are evicted, never mis-parsed.
- **Task sizing (Section 30.8).** Every card is one deliverable — one schema, one migration phase, one service, one endpoint, one component, one guard — reviewable, testable, and reversible in ≤ 1-2 engineering days. Complex concerns are split into sub-cards (`a`/`b`/`c`); the dependency graph at the end fixes their order.

---

## WS-T.1 Shared schemas and doctrine

### WS-T.1.1a SPEC amendment — structural sections → comment section
**ID:** WS-T.1.1a | **Ref:** Sections 3.4, 6.4, 6.5, 15.1, 15.3

**Description:** Amend the read-model sections of `docs/SPEC.md`. Exact edits:
- **§3.4.2** "Content owns conversation. Every content item anchors its own thread (with structured branches, Section 15.3)." → "…anchors its own **comment thread** — a lightly-nested comment section (Section 15.3)."
- **§6.4 "Thread layout"** — replace the six structured branches + floating Contribute button with: the comment section is embedded in the content page; comments are lightly nested (top-level + a collapsible reply level + "continue thread"); the default read is chronological (newest/oldest) with optional **Sources**/**Corrections** filters; the **Overview** is the §24.3 summary atop the section.
- **§6.5 "Context cards"** — leave the conversation-state list (deepening, fragmented, bridged, tense, under review) intact (the state machines are preserved); only drop any "branch" phrasing.
- **§15.1 "Structured contribution taxonomy"** — comment is the base unit; `evidence` and `correction` are typed enrichments; the other nine are retired for new writes (question/answer → comments/replies; counterexample/explanation/local-context/direct-experience/meta-discussion → comments; moderation-concern → the §18.4 report flow; synthesis → the §15.4 community-synthesis summary). Record the deliberate removals (question/answer flag; direct-experience acknowledgment) explicitly.
- **§15.3 "Thread structure and branch scoring"** — replace "six fixed structured sections … never a flat list" with the lightly-nested comment tree; reframe "branch scoring" as comment-level signals (nonredundant evidence MERI, lens divergence SCOI, tension Hodge, corrections, reader utility). Keep "No branch receives score from likes" as "No comment receives score from likes."

**Acceptance criteria:**
- No "structured branches", "six (fixed) sections", or "never a flat list" phrasing survives in §3.4/§6.4/§6.5/§15.1/§15.3.
- The no-applause sentence is preserved (reworded from "branch" to "comment", not deleted).
- `pnpm check:policy` passes.

**Testing:** `rg -n "structured branches|six (fixed )?(structured )?sections|never a flat list" docs/SPEC.md` returns no hits in those sections; manual diff review.

**Dependencies:** none (document). Lands first.

---

### WS-T.1.1b SPEC amendment — composer, comments, summaries
**ID:** WS-T.1.1b | **Ref:** Sections 6.6, 15.5, 24.3

**Description:** Amend the write/summary sections of `docs/SPEC.md`:
- **§6.6 "Participation composer"** — replace the eleven-mode table with the simple comment composer (text and/or image/GIF) plus two optional enrichments (Cite a source; Mark a correction) and an optional lens; note the inline placement (no separate page) and the GIF support.
- **§15.5 "Comments and replies"** — confirm comments are the primary unit; add that a comment may carry an image **or GIF** through the shared media pipeline (content-type allowlist incl. `image/gif`, byte-level metadata stripping, scan gate, required alt text); keep the edit-history/tombstone/translation/abuse-reporting language.
- **§24.3 "Summarization constraints"** — "cite source branches and evidence cards" → "cite source **comments** and evidence cards."

**Acceptance criteria:**
- §6.6 no longer lists the eleven modes; §15.5 mentions GIF; §24.3 says "comments" not "branches".
- The §24.3 fact/claim/interpretation + uncertainty + correction-workflow requirements are unchanged.
- `pnpm check:policy` passes.

**Testing:** `rg` for the eleven mode names + "source branches" in those sections returns clean; manual diff.

**Dependencies:** none (document). Parallel with WS-T.1.1a.

---

### WS-T.1.2a Add the `comment` type + body-or-media rule
**ID:** WS-T.1.2a | **Ref:** Sections 15.1, 15.5, 25.2

**Description:** In `packages/shared/src/schemas/contribution.ts` append `comment` to `CONTRIBUTION_TYPES` and add `comment: 5_000` to `CONTRIBUTION_BODY_LIMITS`. Add `commentCreateSchema` over the existing `createBaseShape` (`thread_id`, `client_draft_id`, optional `parent_contribution_id`, optional `lens_id`, optional `attachment_ids` ≤ 4) with `type: z.literal('comment')` and an **optional** `body` (trimmed, ≤ 5000). Add a top-level `.superRefine` enforcing **body-or-media**: a non-empty trimmed `body` OR ≥ 1 `attachment_ids`, else a specific issue on `body`. **Normalize the body**: a `.transform` coerces a missing/whitespace-only `comment` body to `''` (the create service reads `request.body.length`, runs the safety classifiers over it, and inserts into the NOT-NULL `body` column — a media-only comment must enter the unchanged service chain as `''`, never `undefined`/whitespace). Export `commentCreateSchema` and its inferred type.

**Acceptance criteria:**
- `comment` parses with body-only, media-only, and body+media; rejects empty-and-medialess with a clear message.
- A media-only (or whitespace-body) comment normalizes `body` to `''` (never `undefined`); the unchanged create service + NOT-NULL `body` column accept it.
- `attachment_ids` cap (4) and `lens_id`/`parent_contribution_id` optionality match `createBaseShape`.
- No applause/financial field appears on the shape (denylist/no-applause schema tests stay green).

**Testing:** Unit — parse/reject matrix {body, media, both, neither}; cap enforcement; `expectTypeOf` for the new type.

**Dependencies:** WS-T.1.1a.

---

### WS-T.1.2b Shrink the write union; deprecate the nine + synthesis
**ID:** WS-T.1.2b | **Ref:** Sections 15.1, 24.3

**Description:** Define `contributionWriteCreateSchema = z.discriminatedUnion('type', [commentCreateSchema, evidenceCreateSchema, correctionCreateSchema])` and route the create endpoint (WS-T.3.2a) through it. Mark `questionCreateSchema`, `answerCreateSchema`, `synthesisCreateSchema`, `counterexampleCreateSchema`, `explanationCreateSchema`, `localContextCreateSchema`, `directExperienceCreateSchema`, `moderationConcernCreateSchema`, `metaDiscussionCreateSchema` `@deprecated` and remove them from the live write union (retained one release for any in-flight client). `evidenceCreateSchema`/`correctionCreateSchema` keep their citation/claim requirements (unchanged — they feed MERI/reputation). `contributionPublicSchema.type` keeps the full twelve-value enum for back-compat reads.

**Acceptance criteria:**
- `contributionWriteCreateSchema` accepts exactly `comment|evidence|correction`; the nine legacy literals fail discrimination.
- `contributionPublicSchema` still parses a stored `question`/`synthesis`/… row.
- The legacy create schemas remain exported (deprecated) for one release.

**Testing:** Unit — union accept/reject; a fixture proving a legacy-type row parses as `ContributionPublic`; `expectTypeOf` of the union members.

**Dependencies:** WS-T.1.2a.

---

### WS-T.1.3 GIF upload contracts
**ID:** WS-T.1.3 | **Ref:** Sections 14.1, 15.5, 25.2

**Description:** In `packages/shared/src/schemas/forum-api.ts` add `'image/gif'` to `UPLOAD_IMAGE_TYPES`; add `export const MAX_GIF_BYTES = 8 * 1024 * 1024` (a dedicated cap the steward `ingestion.*` config may only LOWER). Confirm `uploadPublicSchema.content_type` (derived from the type tuples) admits `image/gif` and that `byte_size`'s max (`MAX_VIDEO_BYTES`) already covers `MAX_GIF_BYTES`. Keep `alt_text` required for the image group. Export `isAnimatableImage(contentType): boolean` (`true` iff `image/gif`) for the client's reduced-motion branch.

**Acceptance criteria:**
- `image/gif` is a valid `uploadPublicSchema.content_type`; a GIF public projection round-trips with `alt_text`.
- `MAX_GIF_BYTES` exported; `isAnimatableImage` truth table correct.
- `alt_text` non-nullable for `image/gif`.

**Testing:** Unit — projection accept (with alt) / reject (without alt); `isAnimatableImage` over all image types.

**Dependencies:** WS-T.1.1b.

---

### WS-T.1.4 Resolved comment media on the read projection
**ID:** WS-T.1.4 | **Ref:** Sections 15.5, 22.1, 23.3

**Description:** Two additions in `packages/shared/src/schemas`. (1) Add an OPTIONAL **defined** `media` array to `contributionPublicSchema`: `{ upload_id, url, kind: z.enum(['image']), content_type, alt_text, animatable: boolean }` — a *defined* optional field, so the `.strict()` schema still accepts it; capped at 4, ordered to match `attachment_ids`; raw `metadata.attachment_ids` retained (DSAR/back-compat). (2) Add a DEDICATED `commentItemSchema` for the nested read = the contribution projection PLUS `replies: commentItemSchema[]` (the bounded preview), `reply_count: z.number().int().min(0)`, and `has_more_replies: z.boolean()` — a SEPARATE schema, NOT extra fields on strict `contributionPublicSchema` (which has only `child_count`, and would reject the nesting fields on egress). The `kind` enum is left extensible for a future `video`.

**Acceptance criteria:**
- `media` is a defined optional on `contributionPublicSchema` (strict-schema egress still passes); `commentItemSchema` carries `replies`/`reply_count`/`has_more_replies`; `animatable` is `true` exactly for `image/gif`.
- `media` present and order-aligned for a comment with cleared attachments; absent/empty otherwise.
- A schema-level test fixes both shapes; server resolution is WS-T.3.4.

**Testing:** Unit — projection over {none, image, gif, mixed}; `animatable` correctness; `expectTypeOf`.

**Dependencies:** WS-T.1.2a, WS-T.1.3.

---

### WS-T.1.5 Summary `cited_contribution_ids` rename
**ID:** WS-T.1.5 | **Ref:** Section 24.3

**Description:** In `packages/shared/src/schemas/summary.ts` add `cited_contribution_ids` (the accurate name) to `summaryPublicSchema` and `summaryCreateRequestSchema`, accept `cited_branch_ids` as a deprecated input alias mapped onto it (via `.transform`/preprocess), and emit only `cited_contribution_ids` on the wire. The §24.3 `unresolved_uncertainty` refine and `cited_evidence_ids` are unchanged.

**Acceptance criteria:**
- Create requests using either field name validate; the public projection always carries `cited_contribution_ids`.
- The §24.3 uncertainty refine still fires for community/steward layers.

**Testing:** Unit — alias acceptance; egress always-renamed; existing summary §24.3 tests stay green.

**Dependencies:** WS-T.1.1b.

---

### WS-T.1.6 Retire `BranchId` + the anchor `branch`
**ID:** WS-T.1.6 | **Ref:** Sections 6.4, 15.3

**Description:** Simplify `contributionAnchorSchema` to `{ contribution_id, thread_id, root_contribution_id }` (drop the `branch` enum and the `BranchId` export). All consumers (forum reads WS-T.3.3, the web thread routes WS-T.8.2, the offline draft schema WS-T.7.3d, the signal tracker WS-T.8.4) move off `BranchId`. `pnpm typecheck` becomes the worklist for the retirement.

**Acceptance criteria:**
- `BranchId` and `contributionAnchorSchema.branch` no longer exist; `typecheck` flags every consumer.
- The anchor parses under the new three-field shape.

**Testing:** Unit — anchor parse; a grep proof `BranchId` is unexported.

**Dependencies:** WS-T.1.2b.

---

### WS-T.1.7 Rename the attention traversal signal to reply-depth
**ID:** WS-T.1.7 | **Ref:** Sections 22.1, 19.1

**Description:** In `packages/shared/src/schemas/attention.ts` rename `branch_depth_bucket` → `reply_depth_bucket`, `BRANCH_DEPTH_BUCKETS` → `REPLY_DEPTH_BUCKETS` (same `none|shallow|moderate|deep`), and `branchDepthBucket` → `replyDepthBucket` (input = distinct reply-depth levels read, 0..10; keep `n<=0→none`, `n===1→shallow`, `n<=3→moderate`, else `deep`). The aggregate stays "exactly eleven fields"; `reply_depth_bucket` is a bucket, not a raw value, and is NOT added to `FORBIDDEN_KEYS` (it is allowed). This is a wire rename, so the **durable WS-E path must move with it** — the `attention_aggregates` table persists a `branch_depth_bucket` column (+ enum) and the ingest/PWAtt readers read it; WS-T.2.5 carries the DB migration AND a server ingest **dual-accept window** (reads/writes both `branch_depth_bucket` and `reply_depth_bucket` until clients have upgraded), and WS-T.8.4 sequences the client cutover after that deploy. Web sourcing is WS-T.8.4; the offline aggregate cache version bump rides WS-T.7.3d's `RECORD_SCHEMA_VERSION` bump.

**Acceptance criteria:**
- `reply_depth_bucket` is the only traversal field on the wire shape; `branch_depth_bucket` is gone from `@licio/shared`.
- The shared rename is paired with the durable migration + dual-accept ingest (WS-T.2.5); no aggregate upload fails validation and PWAtt keeps its input across the rollout.
- `assertNoRawEgress`/`check:no-raw-egress` still pass (no forbidden key introduced).
- `replyDepthBucket` keeps the total/monotone/deterministic properties (the attention property suite extends to it).

**Testing:** Unit — `replyDepthBucket` thresholds + monotonicity; no-raw-egress over the renamed aggregate.

**Dependencies:** WS-T.1.1a.

---

## WS-T.2 Database and migrations

### WS-T.2.1 DB enum + migration 0029 (`ADD VALUE 'comment'`)
**ID:** WS-T.2.1 | **Ref:** Sections 15.1, 22.1

**Description:** Append `comment` to `contributionTypeEnum` in `packages/db/src/schema/contribution.ts` (mirroring the shared enum order). Migration `0029_ws_t_comment_type.sql`: `ALTER TYPE contribution_type ADD VALUE IF NOT EXISTS 'comment';` — a standalone, non-transactional statement (Postgres forbids `ADD VALUE` inside a multi-statement txn that then uses the value; follow the `0015` precedent). No backfill. Extend the existing enum-parity test (shared ⇄ DB) to include `comment`.

**Acceptance criteria:**
- Green on a DB seeded with all eleven legacy types; a `comment` row inserts afterward.
- DB enum mirrors the shared enum exactly (parity test extended).
- Down path documented as a no-op (Postgres cannot safely drop an enum value; an unused value is harmless).

**Testing:** Gated integration — apply `0029`, insert + read a `comment`; enum-parity unit.

**Dependencies:** WS-T.1.2a.

---

### WS-T.2.2 Migration 0030 — relax the body CHECK for media-only comments
**ID:** WS-T.2.2 | **Ref:** Section 15.5

**Description:** The `contributions` CHECK `char_length(body) BETWEEN 1 AND 5000` blocks a GIF-only comment. Migration `0030_ws_t_body_optional.sql`: `ALTER TABLE contributions DROP CONSTRAINT <body_len>; ALTER TABLE contributions ADD CONSTRAINT <body_len> CHECK (char_length(body) BETWEEN 0 AND 5000) NOT VALID; ALTER TABLE contributions VALIDATE CONSTRAINT <body_len>;` (no full-table lock). The "non-empty body OR ≥1 attachment" invariant lives at the zod boundary (WS-T.1.2a) + the create service (WS-T.3.2a); the DB keeps the 5000 ceiling. Update the in-memory store's mirrored CHECK comment + the schema CHECK in `contribution.ts`.

**Acceptance criteria:**
- A row with `body=''` and ≥1 `attachment_ids` inserts; empty-and-medialess is rejected by the service (not necessarily the DB).
- `VALIDATE` completes without a long lock in the gated harness; existing rows unaffected.
- Down path restores `1..5000` (lossy only if media-only rows exist; documented).

**Testing:** Gated integration — apply `0030`; insert media-only + body-only; service rejects empty-and-medialess.

**Dependencies:** WS-T.2.1.

---

### WS-T.2.3 Migration 0031 — uploads allow `image/gif`
**ID:** WS-T.2.3 | **Ref:** Sections 14.1, 15.5

**Description:** Extend the `uploads` content-type CHECK in `packages/db/src/schema/upload.ts` to include `image/gif`; assert the existing `byte_size` CHECK ceiling already admits `MAX_GIF_BYTES` (8 MB ≪ the 200 MB video bound, so no byte-range change). Migration `0031_ws_t_gif_upload.sql` swaps the content-type CHECK via `NOT VALID` + `VALIDATE` (the `0020` video precedent).

**Acceptance criteria:**
- An `image/gif` upload row inserts; a non-allowlisted type still fails the CHECK; the byte CHECK admits up to `MAX_GIF_BYTES`.
- Down path removes `image/gif` (lossy only for stored GIF rows; documented).

**Testing:** Gated integration — apply `0031`; insert a GIF upload; reject an unsupported type.

**Dependencies:** WS-T.1.3.

---

### WS-T.2.4 Migration 0032 — summaries `cited_contribution_ids`
**ID:** WS-T.2.4 | **Ref:** Section 24.3

**Description:** Add `cited_contribution_ids` (JSONB array, same `jsonb_typeof = 'array'` CHECK) to `packages/db/src/schema/summary.ts`. Migration `0032_ws_t_summary_citations.sql`: add the column (default `'[]'`), `UPDATE summaries SET cited_contribution_ids = cited_branch_ids;` (idempotent backfill), keep `cited_branch_ids` as a retained read alias (no contract drop this workstream). The Drizzle store reads/writes `cited_contribution_ids`; a compatibility read coalesces the old column for any un-backfilled row.

**Acceptance criteria:**
- Post-migration every summary's `cited_contribution_ids` equals its prior `cited_branch_ids`; new inserts write only the new column.
- Re-runnable backfill; idempotent down path.

**Testing:** Gated integration — seed `cited_branch_ids` summaries, run `0032`, assert equality + new-insert behavior.

**Dependencies:** WS-T.1.5.

---

### WS-T.2.5 Migration 0033 — durable attention `reply_depth_bucket` + dual-accept ingest
**ID:** WS-T.2.5 | **Ref:** Sections 22.1, 19.1, 30.6

**Description:** The §22.1 aggregate is persisted: `packages/db/src/schema/events.ts` (or the WS-E aggregate schema) has an `attention_aggregates.branch_depth_bucket` column with a `branch_depth_bucket` enum, and the WS-E ingest + PWAtt readers read it. The WS-T.1.7 wire rename therefore needs a durable, online-safe migration, NOT a pure type rename. Migration `0033_ws_t_reply_depth_bucket.sql` (expand): add the `reply_depth_bucket` column + enum (the four buckets), backfill `reply_depth_bucket = branch_depth_bucket` for existing rows, and keep `branch_depth_bucket` as a retained column (no contract drop this workstream). The **ingest boundary dual-accepts**: the attention-ingest validator accepts an aggregate carrying EITHER `branch_depth_bucket` or `reply_depth_bucket` (coalescing to the new field) for a deploy window, and writes both columns; PWAtt readers read `reply_depth_bucket` coalesced to the old column. WS-T.8.4 (the client cutover to emit `reply_depth_bucket`) is gated to deploy AFTER this dual-accept is live everywhere, so an upgraded client is never rejected by an old ingest.

**Acceptance criteria:**
- Post-`0033` every row's `reply_depth_bucket` equals its prior `branch_depth_bucket`; the ingest accepts BOTH field names and writes both columns during the window; PWAtt keeps reading the value.
- A pre-cutover client (old field) and a post-cutover client (new field) both ingest successfully; no upload is rejected and no PWAtt input is lost.
- Idempotent down path; `check:no-raw-egress` still green (both fields are buckets).

**Testing:** Gated integration — apply `0033`; ingest aggregates with each field name; assert dual-write + PWAtt read; backfill equality.

**Dependencies:** WS-T.1.7.

---

### WS-T.3.1a Comment-read service (nested assembly + reply previews)
**ID:** WS-T.3.1a | **Ref:** Sections 6.4, 15.3, 16.2

**Description:** Add `apps/api/src/forum/comments.ts` with a pure-ish `commentPage(bundle, threadId, requesterUserId, resolveAuthor, opts)` returning a **lightly-nested** page. The current store contracts do NOT support this as-is — `listByThread` has no roots predicate (it returns all depths) and `listDescendants` returns ALL depths ascending — so reusing them would page nested replies as top-level and preview grandchildren while omitting their direct parent. **Add two store methods** (in-memory + Drizzle): `listRoots(threadId, { states, after, limit })` (`parent_contribution_id IS NULL`, keyset `(created_at,id)`, `opts.order` flips it) for the top-level page, and `listChildren(parentId, { limit })` (DIRECT children only — depth = parent depth + 1 — newest-first) for the `REPLY_PREVIEW = 3` previews; `reply_count` from `childCounts`, `has_more_replies = reply_count > REPLY_PREVIEW`. Fetch with the `states: ['published','under_review']` set AND the rows `visibleRows` needs for honest tombstones (a removed/hidden parent with visible children must still tombstone), then run `visibleRows(rows, requesterUserId, hideAuthorIds)` (`hideAuthorIds` from `ViewerRelationshipReader.setsFor`) for the published/under-review/tombstone + block-mute filtering. Return the `commentItemSchema` shape (WS-T.1.4, with resolved `media` from WS-T.3.4). This is the read counterpart of the retired `branchContent`, minus the section filter.

**Acceptance criteria:**
- New `listRoots`/`listChildren` predicates back the roots/direct-children reads: no nested reply is paged as a top-level comment, and no grandchild is previewed without its direct parent; the preview is newest-first with a defined descending cursor.
- Top-level comments paginate by a replayable `(created_at,id)` keyset; bounded reply previews + accurate `reply_count`/`has_more_replies`; tombstone rows are included where a removed parent has visible children.
- Published/under-review (own)/tombstone/block-mute behavior matches `branchContent('chronology')` on a shared fixture; newest/oldest order both correct and stable under inserts.

**Testing:** Unit — nesting + preview bounds; keyset determinism; a golden-output parity test vs. `branchContent('chronology')` on a seeded thread.

**Dependencies:** WS-T.1.6.

---

### WS-T.3.1b `GET /v1/stories/:storyId/comments` route
**ID:** WS-T.3.1b | **Ref:** Sections 16.2, 23.2, 23.3

**Description:** Add the route in `apps/api/src/routes/forum.ts` (soft session): resolve story → thread (one shell per story), enforce the WS-Q room read bar (404 to outsiders / `room_only` non-members), call `commentPage` (WS-T.3.1a), and return `{ comments: commentItemSchema[], next_cursor, overview: { comment_count, sources_count, corrections_count }, summary }` (the §24.3 current summary for the Overview slot). Add the response zod schema to `@licio/shared` (`storyCommentsResponseSchema`, over `commentItemSchema` — WS-T.1.4 — not the flat contribution shape). Accept `?cursor=`, `?order=newest|oldest`.

**Acceptance criteria:**
- Returns the nested page + counts + current summary; cursor round-trips; private/`room_only` content never served to non-members (extends the WS-Q containment leg).
- Response validated by the shared schema on egress (the WS-C.1.2 boundary).

**Testing:** Route + gated integration — happy path; read-bar 404; cursor pagination; egress-schema validation.

**Dependencies:** WS-T.3.1a, WS-T.1.5 (summary shape).

---

### WS-T.3.1c Continue-thread subtree read
**ID:** WS-T.3.1c | **Ref:** Sections 6.4, 15.3

**Description:** Support deeper replies under the comments endpoint via a `?root=<contribution_id>` form that delegates to the existing `subtreeContent(bundle, threadId, rootId, requesterUserId, resolveAuthor, cursor)` (root must be visible; first page includes the root; keyset cursor). This powers "continue thread" without a second endpoint or new store method.

**Acceptance criteria:**
- `?root=` returns the root + descendants, keyset-paginated; an invisible root anchors nothing (parity with `subtreeContent`).
- Without `?root=`, the endpoint returns the top-level nested page (WS-T.3.1b).

**Testing:** Unit — `?root=` subtree pagination; invisible-root gate.

**Dependencies:** WS-T.3.1b.

---

### WS-T.3.1d Sources / Corrections filter
**ID:** WS-T.3.1d | **Ref:** Sections 6.4, 15.3

**Description:** Add `?filter=sources|corrections` to the comments endpoint: `sources` → `listByThread` with `types: ['evidence']`; `corrections` → `types: ['correction']` (derived, not stored). Absent filter returns the full stream. Filtered reads still nest + paginate. Counts for the chips come from the overview (`countByType`).

**Acceptance criteria:**
- `filter=sources|corrections` narrows to the matching type; counts match the overview; pagination still keyset.
- An unknown `filter` value is ignored (returns all) or 400 (pick one; document).

**Testing:** Unit — filter correctness + count agreement; unknown-value handling.

**Dependencies:** WS-T.3.1b.

---

### WS-T.3.2a Create accepts `comment`
**ID:** WS-T.3.2a | **Ref:** Sections 15.1, 15.5

**Description:** Route `POST /v1/contributions` through `contributionWriteCreateSchema` (WS-T.1.2b) so it accepts `comment|evidence|correction`. Enforce body-or-media server-side (defense in depth over zod): reject a `comment` with empty body and no cleared attachments. `metadataFromRequest` carries `attachment_ids`/`lens_id` for `comment` exactly as today; a `comment` never co-creates an evidence card. **Two added guards for comment media** (the existing attachment guard only checks ownership + scan state): (1) **image-only allowlist** — reject a `comment` whose `attachment_ids` resolve to any non-image upload, since `/v1/uploads` also admits PDF/video/caption and the read projection renders attachments as `kind:'image'`; a comment may attach only `image/*` (GIF capped), enforced server-side, not just in the composer; (2) **claim each attachment for the parent story** — set the upload's `ownerStoryId` to the comment's story on insert, so the existing story-scoped `/v1/uploads/:id` serving gate covers `room_only` comment media (today contribution attachments are stored with `ownerStoryId: null` and served unrestricted, which would let a private-room GIF be fetched via the bare URL even though WS-T.3.4 signs it). Everything else in the guard chain — per-account rate limit, visibility, dedup (`client_draft_id`), parent depth ≤ 10, block check, attachment ownership + `scan_state==='clear'`, safety pre-check → insert → intake → event emission (published only) — is unchanged.

**Acceptance criteria:**
- A `comment` (body, media, or both) creates, dedups on `client_draft_id`, and respects depth/visibility/block guards; `evidence`/`correction` still require citations/claims and co-create cards.
- A `comment` attaching a non-image upload (PDF/video/caption) is rejected server-side; each attached upload is claimed for the comment's story (`ownerStoryId`) so `room_only` comment media cannot be fetched via the bare `/v1/uploads/:id` URL.
- A GIF-only comment passes the attachment scan-clear gate before publish.

**Testing:** Unit — create matrix over comment/evidence/correction × {body, media, both}; dedup; the WS-J safety-hold path for a comment.

**Dependencies:** WS-T.1.2b, WS-T.2.1, WS-T.2.2, WS-T.4.2 (GIF clearance for media-only).

---

### WS-T.3.2b `comment` event mapping (firewall-safe, low-info-aware)
**ID:** WS-T.3.2b | **Ref:** Sections 21.3, 30.6

**Description:** Add `comment: 'explanation'` to `FORUM_TO_EVENT_TYPE` (TypeScript requires the entry — the map is `Record<ContributionType, EventContributionType>`). Extend the existing emission conditional so the low-info downgrade also applies to `comment`: today it reads `(request.type === 'answer' || request.type === 'explanation') && classifyLowInfoReplyV0(request.body, hasCitation)`; add `|| request.type === 'comment'`. A media-only/empty/uncited comment → `low_info_reply` (volume, no constructive weight); a substantive comment → `explanation`. `contribution.created` stays `privacy_classification: 'public'`, carries no body text, and reaches the scoring consumer unchanged (no firewall surface added — verified against `events/router.ts` `assertDeliverable`).

**Acceptance criteria:**
- `FORUM_TO_EVENT_TYPE.comment === 'explanation'`; a GIF-only/empty comment emits `low_info_reply`; a text comment emits `explanation`.
- The pay-to-rank firewall test and the no-body-text event assertion stay green.

**Testing:** Unit — event-type matrix over comment {empty, short-ack, substantive, cited}; firewall + no-PII event assertions.

**Dependencies:** WS-T.3.2a.

---

### WS-T.3.2c Hodge interaction kind for `comment`
**ID:** WS-T.3.2c | **Ref:** Sections 8 (Hodge), 15.3

**Description:** Add `comment: 'attention'` to `KIND_BY_TYPE` in `apps/api/src/invariants/data.ts` (TS requires the entry once `comment` joins `ContributionType`). A plain comment is neutral participation (`attention`); `correction` keeps `'correction'`, `evidence` keeps `'agreement'` — so Hodge's harmonic-tension input is unchanged for the surviving enrichments and gains a neutral default for comments. Legacy types keep their mappings (read-time interactions on historical threads).

**Acceptance criteria:**
- `KIND_BY_TYPE.comment === 'attention'`; all eleven legacy keys unchanged; the Hodge property/oracle suite stays green.

**Testing:** Unit — `KIND_BY_TYPE` exhaustiveness over the twelve types; Hodge interaction-derivation on a comment-bearing fixture.

**Dependencies:** WS-T.3.2a.

---

### WS-T.3.3 Retire the six-section read layer
**ID:** WS-T.3.3 | **Ref:** Sections 6.4, 15.3

**Description:** Remove `SECTION_TYPES`, `sectionOfType`, and `branchContent` from `apps/api/src/forum/tree.ts`/`threads.ts`; delete `GET /v1/threads/:id/branches/:branch` and drop `branch` from `GET /v1/contributions/:id/anchor` (now `{contribution_id, thread_id, root_contribution_id}`). Replace `threadOverview`'s six section counts with `{ comment_count, sources_count, corrections_count }` via `countByType`. Keep `subtreeContent` (continue-thread), `visibleRows`, and `GET /v1/threads/:id` (now feeding the redirect resolver + counts). Resolve the WS-T.1.6 type-errors at every call site.

**Acceptance criteria:**
- No route/function references the six `BranchId` values; `pnpm typecheck` clean.
- Overview returns the three derived counts; `subtreeContent`/`visibleRows` unchanged; `/branches/:branch` returns 404 (route gone).

**Testing:** Unit — overview counts on a mixed-type fixture; a route test that `/branches/:branch` is gone; typecheck.

**Dependencies:** WS-T.3.1b.

---

### WS-T.3.4 Resolve comment media for reads
**ID:** WS-T.3.4 | **Ref:** Sections 15.5, 22.1

**Description:** Implement WS-T.1.4's `media` resolution in the read path. Add `commentMediaOf(uploadRecord, mint: MediaUrlMinter, restricted: boolean)` (mirroring `feedMediaOf` in `lib/story-media.ts`): map each cleared `attachment_ids` upload to `{ upload_id, url, content_type, alt_text, animatable }`, using `signedMediaUrlPath` (signed, `MEDIA_URL_TTL_MS`) when the parent story is `room_only` and the bare immutable `/v1/uploads/:id` when public. Skip `pending`/`flagged` uploads. Batch the upload lookups (one `getMany` per page; no N+1). The signed URL is only sound because WS-T.3.2a claims each attachment for the parent story (`ownerStoryId`), so the serving route's story-scoped gate rejects a bare-URL fetch of `room_only` comment media — this card depends on that ownership link.

**Acceptance criteria:**
- Public-parent media → bare URL; `room_only`-parent media → signed URL; flagged/pending omitted; `animatable` true only for `image/gif`.
- `room_only` comment media is NOT fetchable via the bare `/v1/uploads/:id` URL (the WS-T.3.2a ownership claim + the existing story-scoped serving gate enforce it).
- Order matches `attachment_ids`; one batched upload read per page.

**Testing:** Unit — resolution over visibility × scan-state × type; batch-read (no N+1) assertion.

**Dependencies:** WS-T.1.4, WS-T.3.1a.

---

### WS-T.3.5 Update the deepening trigger's evidence-bearing set
**ID:** WS-T.3.5 | **Ref:** Section 15.4

**Description:** In `apps/api/src/forum/transitions.ts` `maybeDeepenConversation`, **keep** the evidence-bearing count set as `{evidence, correction, counterexample}` — counterexample is retired only as a NEW WRITE option (the composer no longer offers it), but it must still COUNT toward deepening exactly as today's `EVIDENCE_BEARING_TYPES` does, or historical threads' deepening behavior changes silently. Since new writes are `comment|evidence|correction`, no new counterexamples accrue, but existing rows keep counting. The structural `active → deepening` thresholds (reply depth, published count, evidence-bearing count) and the audited `thread.state.changed` event/reason shape are otherwise unchanged. (`comment` is NOT evidence-bearing — it doesn't deepen by itself.)

**Acceptance criteria:**
- The evidence-bearing count set still includes `counterexample`; historical threads' deepening is unchanged; deepening fires on evidence/correction/counterexample accumulation; a plain `comment` does not count as evidence-bearing.
- Reason-string shape unchanged.

**Testing:** Unit — deepening fires/doesn't across {evidence, correction, comment-only}; reason-string snapshot.

**Dependencies:** WS-T.3.2a.

---

### WS-T.3.6 Thread → story redirect resolver
**ID:** WS-T.3.6 | **Ref:** Sections 6.4, 23.2

**Description:** Old deep links must keep working. Reuse `GET /v1/threads/:id` (which already returns the owning `story_id`, gated by the read bar) as the resolution source for the client redirect (WS-T.8.2a) — preferred over a new endpoint. Confirm the overview still carries `story_id` after WS-T.3.3 (add it if the count-only refactor dropped it).

**Acceptance criteria:**
- A valid thread resolves to its `story_id` for a permitted reader; returns 404 to a reader failing the room read bar.
- No new endpoint added unless the overview cannot serve `story_id` (documented).

**Testing:** Unit — resolve + read-bar 404; redirect-target correctness.

**Dependencies:** WS-T.3.3.

---

## WS-T.4 GIF upload pipeline

### WS-T.4.1a GIF magic + block-stream parser
**ID:** WS-T.4.1a | **Ref:** Sections 15.5, 25.2

**Description:** In `apps/api/src/forum/exif.ts` add the GIF magic case to `matchesMagic` (`ascii(0,'GIF8') && (ascii(4,'7a') || ascii(4,'9a'))`) and a pure structural parser `parseGifBlocks(bytes)` that tiles a GIF without interpreting pixels: Header (6) + Logical Screen Descriptor (7; bit 7 of the packed byte = Global Color Table flag, bits 0-2 = GCT size → `3 * 2**(size+1)` bytes) + optional GCT, then a block sequence until the trailer `0x3B`:
- `0x2C` Image Descriptor (10 bytes incl. left/top/width/height u16-LE + packed byte; bit 7 = Local Color Table flag/size) → optional LCT → 1 byte LZW min-code-size → image-data **sub-blocks** (length-prefixed, terminated by `0x00`).
- `0x21` Extension: a label byte then sub-blocks. Labels: `0xF9` Graphics Control, `0xFE` Comment, `0x01` Plain Text, `0xFF` Application (first sub-block = 11-byte app identifier, e.g. `NETSCAPE2.0`, `XMP DataXMP`).
Return a typed list of `{kind, label?, appId?, start, end}` spans (or a typed failure on truncation/over-read). Reuse the existing byte helpers; add a `readU16LE`.

**Acceptance criteria:**
- Parses static and animated GIFs (any GCT/LCT size) into correctly-bounded spans; sub-block chains walked by length prefixes to the `0x00` terminator.
- A truncated/over-reading GIF returns the typed failure, never an out-of-bounds read.
- No fixed-offset assumptions (GCT presence/size respected).

**Testing:** Unit/property — span boundaries re-tile the file exactly; fuzz truncations reject cleanly; an animated fixture yields the expected GCE/Application/Image spans.

**Dependencies:** WS-T.1.3.

---

### WS-T.4.1b `stripGif` transform + dispatch wiring
**ID:** WS-T.4.1b | **Ref:** Sections 15.5, 25.2

**Description:** Add `stripGif(bytes): StripOutcome` over `parseGifBlocks`: **drop** the Comment Extension (`0x21 0xFE`) and the XMP Application Extension (`0x21 0xFF` with app identifier `XMP DataXMP`); **preserve** everything that controls rendering/animation — the Graphics Control Extensions (`0x21 0xF9`, per-frame timing/disposal), the NETSCAPE2.0 Application Extension (`0x21 0xFF` `NETSCAPE2.0`, the loop count — dropping it breaks looping), Plain Text extensions, all Image Descriptors + Local Color Tables + image data, the header/LSD/GCT, and the trailer. Rebuild via `concat` of the kept spans; set `stripped` when ≥1 comment/XMP block was removed; on a parse failure return `{ ok:false, reason:'malformed' }`. Add `case 'image/gif': return stripGif(bytes);` to `stripUploadMetadata`.

**Acceptance criteria:**
- An animated, looping GIF with Comment + XMP blocks: both removed, output re-parses as a valid looping animation (NETSCAPE + every GCE + all frames intact, identical frame count).
- A clean GIF passes through with `stripped=false`; a malformed GIF returns the typed failure (the route maps to 415, like AVIF's `metadata_strip_unsupported`).
- Byte-level, no re-encode; pixels/frames untouched.

**Testing:** Unit/property — round-trip re-parse asserting preserved vs. dropped spans; loop-count + frame-count preserved; a metadata-bearing fixture loses exactly the comment/XMP bytes.

**Dependencies:** WS-T.4.1a.

---

### WS-T.4.2 Admit `image/gif` to `POST /v1/uploads`
**ID:** WS-T.4.2 | **Ref:** Sections 14.1, 15.5, 25.2

**Description:** In `apps/api/src/routes/forum.ts` admit `image/gif`: route through `stripUploadMetadata` (now GIF-aware), enforce `MAX_GIF_BYTES`, require `alt_text` (image group), set `metadata_stripped`, run `uploadScanner.scan` (flagged → rejected at creation, never served). Serving (`GET /v1/uploads/:id`) is unchanged (GIF is `img-src 'self'`, inline disposition, WS-Q story-scoped auth). Update the 415 "Allowed:" message to include GIF, and flip the shipped `forum-coverage.test.ts:146` assertion (currently asserts GIF → 415) to assert acceptance.

**Acceptance criteria:**
- A valid GIF uploads, is metadata-stripped + scan-cleared, serves inline same-origin with `alt_text`.
- Over-`MAX_GIF_BYTES` → 413/415; missing alt → 422; malformed → 415; flagged → held.
- The legacy 415 test is updated to acceptance.

**Testing:** Route tests — accept valid GIF; reject oversize/missing-alt/malformed; scan-gate hold; updated legacy assertion.

**Dependencies:** WS-T.4.1b.

---

## WS-T.5 Live comments (same-origin SSE)

### WS-T.5.1a `CommentBroadcaster` port + in-memory adapter + publish-on-create
**ID:** WS-T.5.1a | **Ref:** Sections 23.5, 25.4

**Description:** Add a `CommentBroadcaster` port in `apps/api/src/forum/` — `publish(threadId, frame): void` and `subscribe(threadId, handler): () => void` — and an in-process `EventTarget`-based adapter (dev, `e2e-server`, single instance). Wire it into the injectable forum service container. In the create flow (WS-T.3.2a), **after a successful published insert**, publish a frame carrying the same `ContributionPublic` projection the REST read returns (incl. resolved `media`) + an event id (the contribution id) for `Last-Event-ID`. Held/removed contributions publish nothing.

**Acceptance criteria:**
- A published comment fans out to every subscriber of its thread; held/removed ones do not.
- Frames carry only the public projection (no scores/raw-attention/private fields) — an introspection test asserts the shape.
- Subscribe returns an unsubscribe that fully detaches; no leak across threads.

**Testing:** Unit — publish/subscribe/unsubscribe; held-comment suppression; projection-shape assertion.

**Dependencies:** WS-T.3.2a, WS-T.3.4.

---

### WS-T.5.1b Redis pub/sub adapter (gated)
**ID:** WS-T.5.1b | **Ref:** Sections 23.5, 25.4

**Description:** Add a Redis `CommentBroadcaster` adapter (channel `licio:comments:{threadId}`) reusing the `ioredis` client + the gated `*-redis-*-stores.ts` selection pattern (one publisher connection, one subscriber connection per process, JSON frames). Fall back to the in-process adapter when Redis is unconfigured (correct for a single instance). Serialize/parse frames through the shared comment schema at the boundary.

**Acceptance criteria:**
- With Redis configured, a comment published on instance A reaches a subscriber on instance B; without Redis, the in-process adapter is used.
- Gated like the other prod adapters; frames validate against the shared schema on receive.

**Testing:** Gated integration — two-process fan-out over Redis; selection test (Redis vs. in-process).

**Dependencies:** WS-T.5.1a.

---

### WS-T.5.2a SSE endpoint — stream, heartbeat, visibility-at-connect
**ID:** WS-T.5.2a | **Ref:** Sections 16.2, 23.5

**Description:** Add `GET /v1/stories/:storyId/comments/stream` (Hono streaming, soft session, `Content-Type: text/event-stream`). Resolve story → thread, **enforce the WS-Q room read bar once at connect** (404 to outsiders), `subscribe` via `CommentBroadcaster`, and write `event: comment\ndata: <json>\nid: <contribution_id>\n\n` per frame. Emit `: heartbeat\n\n` comments every ~25 s (proxy keep-alive). Clean up the subscription on `close`/abort. Same-origin → `connect-src 'self'` (no CSP change).

**Acceptance criteria:**
- A connected `EventSource` receives new public comments live; an outsider to a private room gets 404 at connect and no stream.
- Heartbeats keep the stream open; the subscription is removed on disconnect (no leak).

**Testing:** Integration — connect + receive a published comment; read-bar 404; heartbeat cadence; cleanup on disconnect.

**Dependencies:** WS-T.5.1a.

---

### WS-T.5.2b `Last-Event-ID` resume / replay
**ID:** WS-T.5.2b | **Ref:** Sections 23.5

**Description:** Honor the `Last-Event-ID` request header (and `?since=`) on (re)connect: before subscribing, replay published comments created after that id from the store (bounded catch-up window, e.g. ≤ 200 or ≤ 5 min), each with its `id:`, then attach the live subscription — no gap, no duplicate. Use the `(created_at,id)` keyset to locate the resume point.

**Acceptance criteria:**
- Reconnect with `Last-Event-ID` replays exactly the missed comments then resumes live; no duplicates across the seam; bounded replay window.
- A first connect (no `Last-Event-ID`) attaches live with no replay.

**Testing:** Integration — drop + reconnect mid-stream; assert exact gap replay + no dupes; window bound respected.

**Dependencies:** WS-T.5.2a.

---

### WS-T.5.2c Connection budget + per-frame block/mute filter
**ID:** WS-T.5.2c | **Ref:** Sections 19.1, 25.5

**Description:** Apply a global per-endpoint connection budget (identity-free, the §19.1 fixed-window pattern — never the client address) so the stream cannot be used to exhaust connections. **Revalidate access before every frame, not just at connect** (P1 privacy): re-check the WS-Q room read bar per frame (or on a short interval) against the reader's CURRENT membership AND the story's CURRENT visibility, and **force-close** the connection the moment the reader loses access — a reader removed from a private room, or a story narrowed to `room_only`, must stop receiving frames on an already-open stream (a `room.visibility.changed`/membership-change signal, or the cheap per-frame bar check, drives the revocation). Also filter each frame for the connecting user via the `ViewerRelationshipReader.setsFor` hide set (blocked/muted authors' comments are not delivered); resolve the hide set at connect and refresh opportunistically.

**Acceptance criteria:**
- Over-budget connections get 429 + Retry-After; the budget keys on no client address (the `no-client-address` test stays green).
- Losing room access mid-stream (membership removal OR the story narrowed to `room_only`) stops further frames and closes the connection; no private comment is delivered after revocation.
- A blocked/muted author's live comment is not delivered to the connecting user.

**Testing:** Integration — budget rejection; block/mute frame suppression; no-client-address static test.

**Dependencies:** WS-T.5.2a.

---

### WS-T.5.3a Client `useCommentStream` transport
**ID:** WS-T.5.3a | **Ref:** Sections 23.5, 25.2

**Description:** Add `useCommentStream(storyId)` in `apps/web/src/lib/`: open an `EventSource` to the WS-T.5.2 endpoint, parse each `comment` frame, and **validate it through the shared `contributionPublicSchema` before use** (the WS-C boundary rule). Reconnect with exponential backoff; the browser's native `Last-Event-ID` resume is used automatically. Expose `{ status, newComments, drain() }`. Tear down on unmount/`storyId` change.

**Acceptance criteria:**
- Valid frames are surfaced; a malformed frame is rejected (never enters state); reconnect backs off and resumes with `Last-Event-ID`.
- No EventSource leak across navigations.

**Testing:** Unit/jsdom — mock `EventSource`: frame validate/reject; reconnect/backoff; teardown.

**Dependencies:** WS-T.5.2a.

---

### WS-T.5.3b Cache merge + "N new" affordance + polling fallback
**ID:** WS-T.5.3b | **Ref:** Sections 6.4, 11.6, 23.5

**Description:** Merge streamed comments into the TanStack Query cache for the comment list. Comments from OTHERS surface as a non-disruptive **"N new comments"** affordance (no scroll yank); the reader's OWN just-posted comment reconciles optimistically (dedup by `client_draft_id`). When `EventSource` is unavailable or fails repeatedly, fall back to SWR refetch-on-focus + a bounded interval poll. Pause the "new" nudge when the tab is hidden.

**Acceptance criteria:**
- Others' comments appear via "N new" without scroll disruption; the reader's own isn't double-rendered (idempotent by `client_draft_id`).
- Clean fallback to polling where `EventSource` is absent (older WebViews); no console errors.

**Testing:** Unit/jsdom — merge + dedup + "N new" gating; visibility pause; fallback path.

**Dependencies:** WS-T.5.3a, WS-T.7.1a.

---

## WS-T.6 Reply notifications

### WS-T.6.1a Reply notification item schema + `reply_notifications` preference
**ID:** WS-T.6.1a | **Ref:** Sections 6.7, 19.1, 21.3

**Description:** `packages/shared/src/schemas/notifications.ts` today carries only push subscription + preferences (no notification-item schema, no per-category control — verified). Add: (1) `replyNotificationSchema` = `{ notification_id, kind: z.literal('reply'), story_id, thread_id, comment_id, parent_comment_id, actor_handle, created_at, read_at: nullable }` (ids/handles only — no body text, no scores); (2) a `reply_notifications: z.boolean()` field on `notificationPreferencesSchema` (default `true` in `DEFAULT_NOTIFICATION_PREFERENCES`) so the user can turn reply alerts off without touching the global budget.

**Acceptance criteria:**
- `replyNotificationSchema` parses an item; carries no body/score field (shape test).
- `notificationPreferencesSchema` gains `reply_notifications` with a `true` default; existing preference tests updated.

**Testing:** Unit — item parse + no-PII shape; preference default + parse.

**Dependencies:** WS-T.1.1b.

---

### WS-T.6.1b Reply trigger in the create flow
**ID:** WS-T.6.1b | **Ref:** Sections 18.4, 19.1, 21.3

**Description:** In the create flow (WS-T.3.2a), when a **published** comment has a `parent_contribution_id`, resolve the parent's author and enqueue exactly one `reply` notification for that author when ALL hold: parent author ≠ new author; the pair is not block/mute-related (`RelationshipReader.interactionBlocked`); the comment was not held; **and the recipient still passes the WS-Q room read bar for the story** (a user who authored an old parent but later left/was removed from a private room — or whose story was narrowed to `room_only` — must NOT receive the actor/story/comment ids or a deep link to content they can no longer read). Enqueue is detached/best-effort (never blocks the create response) and idempotent on `comment_id` (an edit does not re-notify). Add a `NotificationStore` port (in-memory + gated Drizzle later) with `enqueue`/`listForUser`/`markRead`.

**Acceptance criteria:**
- A published reply to A's comment enqueues one item for A; top-level/self-reply/blocked/muted/held → none; payload carries no body/scores.
- A recipient who no longer passes the story read bar gets no enqueue and no deep link, even for a reply to their own old comment.
- Editing the reply does not re-notify.

**Testing:** Unit — trigger matrix (reply/self/top-level/blocked/muted/held); idempotency; payload shape.

**Dependencies:** WS-T.6.1a, WS-T.3.2a.

---

### WS-T.6.2a User-scoped push send path
**ID:** WS-T.6.2a | **Ref:** Sections 19.4, 25.3

**Description:** `apps/api/src/lib/push-service.ts` is **session-scoped** today (`registerSubscription(sub, sessionId)`, `getSubscriptions()` returns all, `suppressionReason`) with no "send to a user" path, and `/v1/push/subscriptions` stores only a `sessionId` with no stable user id (verified). Add the missing user-scoping: (1) **bind subscriptions to the authenticated user** — record `userId` on `StoredSubscription` at registration (from the auth session) and CLEAR it on logout/session end, so existing/ new subscriptions map to a stable user (otherwise reply delivery finds no devices or sends through a stale session); (2) add `subscriptionsForUser(userId): StoredSubscription[]`; (3) keep the existing **bodyless VAPID wake-up** as the send primitive — `sendWebPush(subscription)` posts a `Content-Length: 0` wake (reusing `lib/vapid.ts`); Licio does NOT add RFC 8291 encrypted payloads (no new crypto/dependency), so the deep link + actor metadata are NOT in the push body but fetched by the service worker on wake (WS-T.6.2b).

**Acceptance criteria:**
- Subscriptions are bound to the authenticated `userId` at registration and cleared on logout; retrievable by `userId`.
- The bodyless VAPID wake delivers to a user's subscriptions (no encrypted payload, no new dependency); no client address read; existing session-scoped register/remove behavior preserved.

**Testing:** Unit — user lookup; send (mocked web-push); session-scope regression.

**Dependencies:** none (push layer); pairs with WS-T.6.1b.

---

### WS-T.6.2b Deliver reply notifications via push + budget
**ID:** WS-T.6.2b | **Ref:** Sections 6.7, 11.6, 19.4

**Description:** Delivery is split between what the SERVER can decide and what only the CLIENT/service worker knows (the `notification-meter` budget + quiet-topic state live in browser/SW IndexedDB and are incremented only after display, so the API enqueue path cannot consult them). **Server (on `enqueue`):** send a bodyless VAPID wake via `subscriptionsForUser` + `sendWebPush` (WS-T.6.2a) ONLY when the recipient has `reply_notifications` enabled (WS-T.6.1a) AND still passes the story read bar (re-checked here — access can change between enqueue and send). **Service worker (on wake):** fetch the unread items from `GET /v1/notifications` (WS-T.6.3), then apply the client-only gates — the per-day `notification-meter` budget, quiet hours (`isWithinQuietHours`), and the WS-H.6.1c quiet-topic policy (`isTopicQuiet`) — and either show a notification deep-linking to `/stories/:storyId#comment-:commentId` (incrementing the meter) or stay silent. The in-app item (WS-T.6.3) is recorded regardless, so a budget/quiet suppression never loses the reply.

**Acceptance criteria:**
- The server wake fires only for opted-in recipients who still pass the read bar; the SW applies budget/quiet-hours/quiet-topic before display and deep-links to the comment.
- A budget/quiet-suppressed push still leaves the in-app item; no client address is read; no encrypted push payload is sent.

**Testing:** Unit — server send-decision (reply_notifications + read bar) and SW gate matrix (budget/quiet-hours/quiet-topic) with the in-app item always recorded; deep-link correctness.

**Dependencies:** WS-T.6.1b, WS-T.6.2a.

---

### WS-T.6.3 In-app reply indicator + notifications list
**ID:** WS-T.6.3 | **Ref:** Sections 6.5, 11.6

**Description:** No in-app inbox exists today (verified). Add a `GET /v1/notifications` (+ `POST /v1/notifications/:id/read`) over the `NotificationStore`, a `useNotificationsQuery`/`useMarkNotificationReadMutation` (zod-validated), an unread indicator (Profile tab / app-shell affordance), and a notifications list (actor handle, story title, relative time) deep-linking to the comment. Mark-read on view. This is the always-available channel when push is off/unsupported.

**Acceptance criteria:**
- New replies raise the indicator; opening + viewing clears it; each item deep-links to the comment; works with push disabled.
- No applause surface (replies, never counts/reactions) — `check:no-applause` covers the new components; axe-clean; no app-shell layout shift.

**Testing:** Unit/jsdom — indicator state machine; deep-link nav; axe; no-applause scan; route + query zod validation.

**Dependencies:** WS-T.6.1b.

---

## WS-T.7 Web client: the comment section

### WS-T.7.1a Comment data layer (api client + query hooks + offline snapshot)
**ID:** WS-T.7.1a | **Ref:** Sections 23.3, 25.2

**Description:** In `apps/web/src/lib/api.ts` add `fetchStoryComments(storyId, { cursor?, order?, filter?, root? })` and `createComment(request)` (both via the CSRF-serialized `apiFetch` + `parseResponse(…, schema)` — reuse the existing client plumbing). In `lib/queries.ts` add `useStoryCommentsQuery(storyId, opts)` (`useInfiniteQuery`, `getNextPageParam: p => p.next_cursor`) and `useCreateCommentMutation` (optimistic insert + `client_draft_id` dedup). Extend the offline read-through: add `cacheCommentSnapshot`/`readCommentSnapshot` (story title + summary + first page of comments) alongside the existing `cacheThreadSnapshot`, keyed by story id.

**Acceptance criteria:**
- Comment list + create flow round-trip through the typed client; every response zod-validated before cache (the WS-C boundary).
- Infinite pagination via `next_cursor`; create mutation is optimistic + idempotent.
- An offline snapshot is written on success and read on network failure.

**Testing:** Unit/jsdom — query/mutation hooks (mocked client); optimistic + dedup; snapshot write/read; schema-reject of a malformed response.

**Dependencies:** WS-T.3.1b, WS-T.3.2a.

---

### WS-T.7.1b `CommentSection` container
**ID:** WS-T.7.1b | **Ref:** Sections 6.4, 15.3, 23.3

**Description:** Add `apps/web/src/components/comments/CommentSection/` and mount it in `apps/web/src/routes/-pages/stories.tsx`, **replacing** the "View the conversation" `Link` with the inline section below the story body (using `StoryDetail.thread_id`). It composes: the §24.3 summary slot (Overview), the top-level `CommentComposer` (WS-T.7.3a), the `CommentList` (WS-T.7.2c), the optional filter chips (WS-T.7.5), "load more" pagination, and (later) the live wiring (WS-T.7.6). Carries `id="comments"` (the redirect/notification anchor). The story stays the active signal item (no separate active-item churn). Falls back to the offline snapshot on network failure (like the old thread page).

**Acceptance criteria:**
- Opening a story shows the conversation inline (no navigation); the old link is gone; `#comments` anchor scrolls to the section.
- Skeleton → list → load-more; empty state; offline snapshot fallback; the summary renders in the Overview slot when present.

**Testing:** Unit/jsdom — render with seeded comments; load-more; empty; offline fallback; anchor scroll; axe.

**Dependencies:** WS-T.7.1a.

---

### WS-T.7.2a `CommentItem` render
**ID:** WS-T.7.2a | **Ref:** Sections 15.5, 18.4

**Description:** Add `CommentItem` rendering one comment: author handle/display name, relative time (`time.ts`), the UGC-rendered body (`UgcBody`/`renderUGC`), the `edited`/`under_review` badges, and the honest tombstone state (removed/hidden with visible descendants → "removed; replies preserved"). Inline `CommentMedia` (WS-T.7.4a) for `media`. Pure presentational; actions are WS-T.7.2b.

**Acceptance criteria:**
- Renders body + media + badges; tombstone preserves replies; legacy-typed contributions render as comments (no crash on `question`/`synthesis`/…).
- DOM order == visual order; axe-clean.

**Testing:** Unit/jsdom — body/media/badges/tombstone; a legacy-type fixture; axe.

**Dependencies:** WS-T.7.4a.

---

### WS-T.7.2b Per-comment actions (reply / report / block-mute / edit / delete)
**ID:** WS-T.7.2b | **Ref:** Sections 15.5, 18.4

**Description:** Add the action row to `CommentItem`: **Reply** (opens the inline composer, WS-T.7.6), **Report** (the WS-J `ReportButton` with `targetType` per the report contract for a contribution + `contentKind` inferred from media — this is where `moderation_concern` went; closes a WS-J residual of mounting report on every contribution row), **block/mute** (the WS-J controls), and author-only **Edit**/**Delete** (reuse the existing `PATCH`/`DELETE /v1/contributions/:id` mutations + edit-history/tombstone semantics). Gate by permission (author vs. other; authenticated vs. not).

**Acceptance criteria:**
- Correct action set per permission; Report opens the two-tap sheet bound to the comment; Edit/Delete reuse the existing mutations (no new server work).
- Block/mute affordances present; `check:no-applause` covers the row.

**Testing:** Unit/jsdom — author vs. non-author vs. logged-out action sets; report sheet open; edit/delete mutation calls; no-applause.

**Dependencies:** WS-T.7.2a.

---

### WS-T.7.2c `CommentList` (lightly nested + collapse + continue-thread)
**ID:** WS-T.7.2c | **Ref:** Sections 6.4, 15.5

**Description:** Add `CommentList`: top-level `CommentItem`s with their bounded reply preview and a collapsible "N replies"/"continue thread" control that loads deeper replies via `fetchStoryComments(..., { root })` (WS-T.3.1c). One visible nesting level; deeper indentation is capped and replaced by "continue thread" (loads the subtree page). Manage focus on expand/collapse (WS-C a11y).

**Acceptance criteria:**
- Lightly-nested layout: top-level + one collapsible reply level + "continue thread"; indentation never runs past the cap.
- "continue thread" loads deeper replies (keyset "show more"); focus moves predictably.

**Testing:** Unit/jsdom — nesting + collapse; subtree expand; depth-cap "continue thread"; focus assertions; axe.

**Dependencies:** WS-T.7.2b, WS-T.3.1c.

---

### WS-T.7.2d Evidence / correction badge + citation card
**ID:** WS-T.7.2d | **Ref:** Sections 15.1, 15.6, 24.3

**Description:** When a comment's `type` is `evidence` or `correction`, render a small, non-scored badge ("Source"/"Correction") and its citation card (reuse the WS-G evidence-card render + the `citations` list). Legacy typed contributions surface the same way where applicable (e.g. a stored `evidence` row). No score/count.

**Acceptance criteria:**
- `evidence`/`correction` show the badge + citation card; plain comments show neither; the badge is never a tally/score.
- Reuses the existing evidence-card component (no new card UI).

**Testing:** Unit/jsdom — badge + citation render for evidence/correction; absent for comment; axe; no-applause.

**Dependencies:** WS-T.7.2a.

---

### WS-T.7.3a Base `CommentComposer` (text + post + optimistic)
**ID:** WS-T.7.3a | **Ref:** Sections 6.6, 15.5, 25.2

**Description:** Add `apps/web/src/components/comments/CommentComposer/` — the inline composer replacing `ParticipationComposer`. Base state: a Markdown-lite textarea (reuse `VoiceDictation`) + **Post**. Build the `comment` payload (default `type:'comment'`), enforce body-or-media client-side (mirror WS-T.1.2a), submit via `useCreateCommentMutation` (optimistic insert into the list, reconciled by `client_draft_id`). Port the no-applause composer test to this component.

**Acceptance criteria:**
- Posting text works; empty-and-medialess is blocked with a clear message; optimistic insert reconciles with the server/stream echo.
- No mode chooser, no eleven-mode UI; `check:no-applause` + the ported test pass.

**Testing:** Unit/jsdom — submit text; body-or-media gating; optimistic + dedup; axe; no-applause.

**Dependencies:** WS-T.7.1a.

---

### WS-T.7.3b Media attach + preview (image/GIF)
**ID:** WS-T.7.3b | **Ref:** Sections 15.5, 25.2

**Description:** Add the media affordance to `CommentComposer`: reuse `Attachment` with `accept="image/jpeg,image/png,image/webp,image/avif,image/gif"` (single file), a local preview via `blob-url.ts` (`mintObjectUrl`/`sanitizeBlobUrl`), a **required alt-text** field, and a client-side size check (`MAX_GIF_BYTES`/`MAX_IMAGE_BYTES`). Upload via `POST /v1/uploads` first (reuse the upload client), then attach the returned `upload_id` to the comment. Surface upload errors (415/422/scan-pending) inline.

**Acceptance criteria:**
- A GIF/image can be attached, previewed locally, alt-texted, and posted; oversize/missing-alt/flagged surface a clear inline error.
- Object URLs are sanitized + revoked; the privacy warning (from `Attachment`) is shown.

**Testing:** Unit/jsdom — attach + preview + alt-required; size-reject; upload-error surface; object-URL revoke.

**Dependencies:** WS-T.7.3a, WS-T.4.2.

---

### WS-T.7.3c Enrichment toggles (source → evidence, correction)
**ID:** WS-T.7.3c | **Ref:** Sections 15.1, 15.6

**Description:** Add two progressive toggles to `CommentComposer`. **Add a source** reveals `CitationCapture` + a claim reference and switches the submitted `type` to `evidence` (relevance note = body, ≥1 citation, claim required — the existing server rules). **Mark a correction** reveals citation + claim and switches to `correction` (≥1 citation, claim, optional target excerpt). With neither toggle, `type` stays `comment`. Also add an optional, collapsed **viewpoint (lens)** select that sets `lens_id` (keeps SCOI fed). Reuse the shared evidence/correction create schemas for client validation (identical to the server).

**Acceptance criteria:**
- Toggling source/correction submits the correct `type` with citations/claim; default is `comment`; the optional lens sets `lens_id`.
- Client validation matches the server (shared schema); a missing required citation/claim blocks submit with the schema's message.

**Testing:** Unit/jsdom — submit as comment/evidence/correction; required-field gating from the shared schema; lens set.

**Dependencies:** WS-T.7.3a.

---

### WS-T.7.3d Offline encrypted draft + comment draft schema
**ID:** WS-T.7.3d | **Ref:** Sections 6.9, 25.2, 22.1

**Description:** Wire encrypted offline drafts into `CommentComposer` (reuse `encryptDraftValues`/`saveDraft`, 800 ms debounced autosave, recovery on mount, `client_draft_id` = `draft-${crypto.randomUUID()}`, clear on success). Update the offline draft schema in `apps/web/src/offline/schemas.ts`: `draftContributionRecordSchema` currently has `branch: branchIdSchema.nullable()` (broken by WS-T.1.6) and `contributionType: contributionTypeSchema` — **drop `branch`** (and `DraftInput.branch`) and allow `comment` in `contributionType`. Bump `RECORD_SCHEMA_VERSION` (this also evicts the stale §22.1 `branch_depth_bucket` aggregates per WS-T.1.7) so stale drafts/snapshots are evicted, never mis-parsed.

**Acceptance criteria:**
- Comment drafts encrypt at rest, autosave (debounced), recover after reload, and dedup via `client_draft_id`; the draft schema has no `branch` and accepts `comment`.
- `RECORD_SCHEMA_VERSION` bumped; a stale `branch`-bearing draft fails parse and is evicted.

**Testing:** Unit/jsdom — draft encrypt/recover/dedup; schema migration (stale-record eviction); `branch` absent.

**Dependencies:** WS-T.1.6, WS-T.7.3a.

---

### WS-T.7.4a `CommentMedia` static render
**ID:** WS-T.7.4a | **Ref:** Sections 15.5, 6.4

**Description:** Add `apps/web/src/components/comments/CommentMedia/` rendering a comment's resolved `media`: a same-origin `<img>` (`img-src 'self'`) with required `alt`, intrinsic width/height to avoid layout shift, and `loading="lazy"`. Non-animatable images render directly. (Animatable GIF handling is WS-T.7.4b.)

**Acceptance criteria:**
- Image renders inline, same-origin, with `alt`, no CLS, lazy-loaded.
- No external origin; no new dependency.

**Testing:** Unit/jsdom — render + alt + lazy; intrinsic sizing; axe.

**Dependencies:** WS-T.1.4.

---

### WS-T.7.4b Animated-GIF reduced-motion poster + play/pause
**ID:** WS-T.7.4b | **Ref:** Sections 15.5; WS-B motion doctrine

**Description:** For `animatable` GIFs, respect reduced motion (OS `prefers-reduced-motion` AND the in-app `useUIStore(s => s.reducedMotion)` → `data-motion`): when reduced, draw frame 1 to a `<canvas>` once and show it as a static **poster** with a visible **Play** control that swaps in the animated `<img>` on activation; when motion is allowed, render the animated `<img>` with a **Pause** affordance (swap to the canvas poster). No third-party image library (canvas first-frame only).

**Acceptance criteria:**
- Under reduced-motion, GIFs do not animate until Play; otherwise they animate with a Pause control.
- The poster is a faithful first frame; toggling never reloads from network (object/blob reused).

**Testing:** Unit/jsdom — reduced-motion poster vs. animated path (mock `prefers-reduced-motion` + `data-motion`); play/pause toggle; axe.

**Dependencies:** WS-T.7.4a.

---

### WS-T.7.5 Sources / Corrections filter chips
**ID:** WS-T.7.5 | **Ref:** Sections 6.4, 15.3

**Description:** A light, de-emphasized chip row (**All** · **Sources (N)** · **Corrections (N)**) over the single stream, driving the `?filter=` param (WS-T.3.1d); counts from the overview (WS-T.3.3). Default All; URL-shareable (`filter` search param); keyboard-operable (roving tabindex / `aria-pressed`).

**Acceptance criteria:**
- Selecting Sources/Corrections narrows the stream; All restores it; counts match the overview; state round-trips via the URL.

**Testing:** Unit/jsdom — filter switch + counts; URL round-trip; axe.

**Dependencies:** WS-T.7.1b.

---

### WS-T.7.6 Inline reply composer + live wiring
**ID:** WS-T.7.6 | **Ref:** Sections 6.4, 11.6, 23.5

**Description:** Reply opens an inline `CommentComposer` pre-bound to `parent_contribution_id` (reuse WS-T.7.3a wholesale; focus moves into the textarea on open, returns to the new comment on post). Connect `useCommentStream` (WS-T.5.3) into `CommentSection`: render the "N new comments" affordance, reconcile the reader's own optimistic posts, and surface the in-app reply indicator (WS-T.6.3) contextually for a reply to the reader in the open thread. Pause the stream when the tab is hidden/section offscreen; resume on focus; degrade to poll-only with the existing offline toasts.

**Acceptance criteria:**
- Replying nests under the parent (depth-capped), appears optimistically, and returns focus correctly.
- New comments from others surface via "N new" without scroll disruption; the reader's own aren't duplicated; pause/resume on visibility; poll-only fallback is silent.

**Testing:** Unit/jsdom — reply submit + nesting + focus; stream merge into the live section; visibility pause/resume; fallback.

**Dependencies:** WS-T.7.3a, WS-T.5.3b, WS-T.6.3.

---

## WS-T.8 Navigation and route retirement

### WS-T.8.1 Remove the Threads tab (5 → 4 tabs)
**ID:** WS-T.8.1 | **Ref:** Sections 6.4; WS-B.1.5 nav

**Description:** Drop the `threads` item from `defaultNavItems` in `BottomNav.tsx` (now Front Page · Rooms · Submit · Profile, Submit staying the prominent center entry); remove the `/threads` branch from `activeTabId` in `__root.tsx`. Re-balance the bar for four items (thumb-zone spacing + side rail). Update nav i18n keys/tests.

**Acceptance criteria:**
- The Threads tab is gone; four tabs evenly laid out; active state correct for `/`, `/rooms`, `/submit`, `/profile`; no dangling `nav.threads`.

**Testing:** Unit/jsdom — nav renders four; active-tab mapping; axe.

**Dependencies:** WS-T.7.1b (conversation reachable inline before the tab goes).

---

### WS-T.8.2a Thread → story redirect route
**ID:** WS-T.8.2a | **Ref:** Sections 6.4, 23.2

**Description:** Replace `threads_.$threadId.tsx` with a redirect route: resolve the thread's `story_id` (WS-T.3.6) and `navigate`/redirect to `/stories/$storyId#comments`, preserving any contribution anchor as the comment `#id`. On 404/unreadable, render the existing not-found/`ErrorState`. Keep this thin route so old `/threads/:id` links and shared anchors keep working.

**Acceptance criteria:**
- `/threads/$threadId` (and old anchors) redirect to the owning story's comment section; unreadable/unknown → not-found.

**Testing:** Unit/jsdom + E2E — redirect target + anchor; 404 path.

**Dependencies:** WS-T.3.6, WS-T.7.1b.

---

### WS-T.8.2b Delete the thread/branch routes + `ThreadBranchNav`
**ID:** WS-T.8.2b | **Ref:** Sections 6.4

**Description:** Delete `apps/web/src/routes/threads.tsx` (directory), `threads_.$threadId_.branches.$branchId.tsx` (branch), the `-pages/threads.tsx` page components, `ThreadBranchNav` (+ tests), and the thread/branch query hooks (`useThreadBranchQuery`, `fetchThreadBranch`) once unused. Remove the retired routes from `routeTree.gen.ts` (regenerated) and the `threadSearchSchema` from `routing/search.ts`. Retire/replace the WS-G.3.3 thread-discovery E2E with the WS-T.9.2 comment-flow E2E.

**Acceptance criteria:**
- The directory/branch routes and `ThreadBranchNav` no longer exist; `pnpm typecheck` + route generation clean; no `BranchId`/`ThreadBranchNav` reference remains in the web app.

**Testing:** Unit/jsdom — route-tree snapshot; grep proof the retired symbols are gone.

**Dependencies:** WS-T.8.2a.

---

### WS-T.8.3a `/submit` reverts to story submission only
**ID:** WS-T.8.3a | **Ref:** Sections 6.6, 14.1

**Description:** In `apps/web/src/routes/-pages/submit.tsx` + `routing/search.ts` remove the contribution-composer mode (the `?threadId`/`?branch` branch that hosted `ParticipationComposer`); `SubmitPage` renders only `StoryComposer`. Simplify `submitSearchSchema` (drop `threadId`/`branch`).

**Acceptance criteria:**
- `/submit` shows only the story composer; `threadId`/`branch` search params are no longer valid; story submission unaffected.

**Testing:** Unit/jsdom — `/submit` renders the story composer; the dropped params are rejected/ignored.

**Dependencies:** WS-T.7.3a (comment composer exists before the submit path changes).

---

### WS-T.8.3b Delete `ParticipationComposer` + modes/payload
**ID:** WS-T.8.3b | **Ref:** Sections 6.6, 6.12.12 (dep budget)

**Description:** Delete `apps/web/src/components/composer/ParticipationComposer/` (`ParticipationComposer.tsx`, `modes.ts`, `payload.ts`, indexes, tests). Keep the shared affordances still used by `CommentComposer` (`Attachment`, `CitationCapture`, `VoiceDictation`, `PrivacyWarning`, `ContextWarning`); delete any affordance left orphaned (used only by the old composer). Confirm the bundle-size gate (initial JS < 200 KB gz) — the bundle should shrink.

**Acceptance criteria:**
- `ParticipationComposer`/`modes.ts`/`payload.ts` deleted; no import survives; shared affordances still used by `CommentComposer` remain.
- `pnpm typecheck`/`lint`/the bundle-size gate pass (bundle shrinks).

**Testing:** Unit/jsdom — grep proof the files are gone; bundle-size check.

**Dependencies:** WS-T.8.3a.

---

### WS-T.8.4 Signals: drop branch visits, source the reply-depth bucket
**ID:** WS-T.8.4 | **Ref:** Sections 22.1, 19.1

**Description:** Remove `recordBranchVisit` (the retired thread page was its only caller) and repoint `TraversalTracker` to record **distinct reply-depth levels read** in the comment section, feeding `replyDepthBucket` (WS-T.1.7). Rename the tracker method/field; have `CommentList`/`CommentItem` report the deepest reply level the reader expands (coarse, in-browser only). `buildAggregate` consumes the renamed input. The story-as-active-item dwell behavior is unchanged. **Sequence the client cutover AFTER the WS-T.2.5 server dual-accept is deployed**, so an upgraded client emitting `reply_depth_bucket` is never rejected by an old ingest (the migration table's deploy ordering).

**Acceptance criteria:**
- No `recordBranchVisit`/branch traversal remains; the aggregate carries `reply_depth_bucket` from comment expansion; `check:no-raw-egress`/`assertNoRawEgress` pass.
- The client emits `reply_depth_bucket` only once the server accepts both field names (WS-T.2.5); no aggregate upload is rejected during rollout.
- Dwell/return tracking for the story unchanged.

**Testing:** Unit — tracker records reply depth → bucket; no-raw-egress; aggregate build with the renamed field.

**Dependencies:** WS-T.1.7, WS-T.2.5, WS-T.7.2c.

---

## WS-T.9 Tests, gates, and documentation

### WS-T.9.1 Extend the static doctrine gates to the comment surfaces
**ID:** WS-T.9.1 | **Ref:** Sections 13, 22.1, 30.6

**Description:** Bring the new surfaces under the existing CI gates: confirm `check:no-applause` covers `components/comments/**` + the story-page section + the notifications list (add an allow-rationale where the scanner might false-positive on "media"); re-run `check:no-raw-egress` after the `reply_depth_bucket` rename; add an introspection test asserting SSE frames + `reply` notification payloads contain no score/raw-attention/financial field (the §30.6 firewall + no-applause posture on the live channels); add a one-line assertion to the `check:neutrality` suite that the comment remodel touches no ranking input (ranking consumes story/thread aggregates, not comment shape).

**Acceptance criteria:**
- `pnpm check:no-applause`, `pnpm check:no-raw-egress`, `pnpm check:neutrality` pass on the remodeled tree.
- The SSE/notification introspection test fails if a score/raw field is ever added.

**Testing:** the gate scripts + the new introspection unit.

**Dependencies:** WS-T.5.2a, WS-T.6.1b, WS-T.7.x.

---

### WS-T.9.2 BFF-in-the-loop E2E for the comment flow
**ID:** WS-T.9.2 | **Ref:** Sections 6.4, 15.5, 23.5; WS-P E2E harness

**Description:** Add a `*.bff.spec.ts` authenticated E2E (the in-memory `e2e-server` + gated test-login + proxied preview, wired with the in-process `CommentBroadcaster` + GIF upload) driving the full flow on Chromium/Firefox/WebKit: open a story → see the inline section → post a text comment → reply → attach + post a GIF (assert inline, motion-safe render) → a second session's comment arrives live via SSE → report a comment (WS-J sheet). axe-core on the story page with the section open.

**Acceptance criteria:**
- Posts/replies/attaches/streams/reports against a real BFF over one same-origin host; passes on all three engines in CI; GIF renders inline; the live comment appears without reload; axe clean.

**Testing:** the E2E spec (CI E2E job).

**Dependencies:** WS-T.7.x, WS-T.4.2, WS-T.5.2a.

---

### WS-T.9.3 Documentation sync
**ID:** WS-T.9.3 | **Ref:** Section 30; CLAUDE.md documentation rules

**Description:** Update, in the same workstream: `docs/forum/README.md` (the comment model, the surviving evidence/correction enrichments, retired sections/types, GIF media, SSE, reply notifications, back-compat read posture); `docs/pwa-client/README.md` (routing — Threads tab/routes retired, `/submit` story-only; the comment-section signals/`reply_depth_bucket`; SSE + reply push + the in-app inbox); `README.md` (status/quickstart if surfaced); `CLAUDE.md` **and** `AGENTS.md` byte-identical (source layout: `components/comments/**`, `forum/comments.ts`, the retired composer/threads files; the WS-T status line; GIF/SSE notes); `DEVELOPMENT.md` (the seeded demo shows inline comments incl. a GIF); `docs/planning/00-index.md` (WS-T row, totals, revision entry, dependency-graph line). SPEC edits are WS-T.1.1a/b.

**Acceptance criteria:**
- Every listed doc reflects shipped behavior; `CLAUDE.md`/`AGENTS.md` byte-identical; the index totals/graph include WS-T; no doc claims a retired surface still exists.
- `pnpm check:policy` passes.

**Testing:** doc/policy check; the `CLAUDE.md`/`AGENTS.md` identity check.

**Dependencies:** all prior WS-T cards (documents the shipped end state).

---

### WS-T.9.4 Migration-validation + back-compat read harness (gated)
**ID:** WS-T.9.4 | **Ref:** Sections 15.1, 22.1, 30.8

**Description:** A gated (Postgres) harness applying `0029`–`0032` over a DB seeded with all eleven legacy contribution types + legacy summaries (`cited_branch_ids`), asserting: every legacy contribution reads back through `GET /v1/stories/:storyId/comments` as a comment (evidence/correction enrichment surfaced; the rest as plain comments); media-only comments insert; summaries expose `cited_contribution_ids`; GIF uploads strip + serve. Property: no historical row becomes unreadable or changes visibility from the remodel.

**Acceptance criteria:**
- The chain is green in CI's Postgres container; all legacy types render; no visibility/readability regression; the harness fails if any legacy row is dropped/mistyped/hidden.

**Testing:** the gated integration harness (CI Test & Coverage job).

**Dependencies:** WS-T.2.x, WS-T.3.1b, WS-T.4.2.

---

## Dependency graph (within WS-T)

```
WS-T.1.1a / WS-T.1.1b (SPEC amendments)
 ├── WS-T.1.2a (comment type + body-or-media) ── WS-T.1.2b (write union; deprecate nine) ── WS-T.1.6 (retire BranchId)
 ├── WS-T.1.3 (GIF contracts) ─┬── WS-T.2.3 (gif CHECK 0031)
 │                             └── WS-T.4.1a (gif parser) ── WS-T.4.1b (stripGif) ── WS-T.4.2 (uploads accept GIF)
 ├── WS-T.1.4 (read media projection) ── WS-T.3.4 (resolve media)
 ├── WS-T.1.5 (summary rename) ── WS-T.2.4 (summary col 0032)
 ├── WS-T.1.7 (reply-depth rename) ── WS-T.2.5 (durable aggregate 0033 + dual-accept) ── WS-T.8.4 (web signal source)
 └── WS-T.2.1 (enum 0029) ── WS-T.2.2 (body CHECK 0030)

WS-T.3.1a (comment read service) ── WS-T.3.1b (route) ─┬── WS-T.3.1c (continue-thread) 
                                                       ├── WS-T.3.1d (filter)
                                                       └── WS-T.3.3 (retire sections) ── WS-T.3.6 (thread→story resolver)
WS-T.3.2a (create accepts comment) ─┬── WS-T.3.2b (event map) ── (firewall)
                                    ├── WS-T.3.2c (Hodge kind)
                                    ├── WS-T.3.5 (deepening set)
                                    ├── WS-T.5.1a (broadcaster) ── WS-T.5.1b (Redis) ; WS-T.5.2a (SSE) ── WS-T.5.2b (resume) / WS-T.5.2c (budget+filter)
                                    └── WS-T.6.1b (reply trigger) ─┬── WS-T.6.2a (user push send) ── WS-T.6.2b (deliver)
                                                                   └── WS-T.6.3 (in-app inbox)
WS-T.6.1a (notif schema+pref) ── WS-T.6.1b
WS-T.5.2a ── WS-T.5.3a (client transport) ── WS-T.5.3b (merge/fallback)

WS-T.7.1a (data layer) ── WS-T.7.1b (CommentSection) ─┬── WS-T.7.2a (item) ── WS-T.7.2b (actions) ── WS-T.7.2c (list/nesting)
                                                      ├── WS-T.7.2d (evidence/correction badge)
                                                      ├── WS-T.7.3a (composer) ─┬── WS-T.7.3b (media) / WS-T.7.3c (enrichments) / WS-T.7.3d (drafts)
                                                      ├── WS-T.7.4a (media render) ── WS-T.7.4b (gif motion)
                                                      ├── WS-T.7.5 (filter chips)
                                                      └── WS-T.7.6 (reply + live wiring)
WS-T.8.1 (nav) ; WS-T.8.2a (redirect) ── WS-T.8.2b (delete routes) ; WS-T.8.3a (submit) ── WS-T.8.3b (delete composer)
WS-T.9.1/9.2/9.3/9.4 (gates, E2E, docs, migration harness) depend on the relevant feature cards.
```

**Suggested execution order (waves within WS-T):**

1. **Doctrine + schemas:** T.1.1a/b → T.1.2a/b, T.1.3, T.1.4, T.1.5, T.1.6, T.1.7.
2. **Storage:** T.2.1 → T.2.2; T.2.3; T.2.4 (parallel); T.2.5 (after T.1.7; deploy its dual-accept ingest before the T.8.4 client cutover).
3. **GIF pipeline:** T.4.1a → T.4.1b → T.4.2 (parallel with storage).
4. **Backend reads/writes:** T.3.2a → T.3.2b/c, T.3.5; T.3.1a → T.3.1b → T.3.1c/d → T.3.3 → T.3.6; T.3.4.
5. **Live + notifications:** T.5.1a → T.5.1b; T.5.2a → T.5.2b/c; T.6.1a → T.6.1b → T.6.2a → T.6.2b, T.6.3.
6. **Client UX:** T.7.1a → T.7.1b → T.7.2a → T.7.2b → T.7.2c, T.7.2d; T.7.3a → T.7.3b/c/d; T.7.4a → T.7.4b; T.7.5; then T.5.3a → T.5.3b → T.7.6.
7. **Nav + retirement:** T.8.1; T.8.2a → T.8.2b; T.8.3a → T.8.3b; T.8.4.
8. **Gates, E2E, docs, harness:** T.9.1, T.9.2, T.9.4, then T.9.3 last (documents the shipped end state).

**Forward-compat notes.** WS-R (LCAP offline ingress) reconciles records into the same `contributions` rows; comments are LCAP-carriable unchanged. WS-S (E2EE P2P rooms) keeps its server-non-storage contract — the `CommentBroadcaster`/SSE and reply notifications MUST exclude `private_p2p` rooms (no server-side comment storage to stream), tracked as a WS-S gate, not a WS-T card. WS-K (AI governance) owns the automated-draft summary; the §24.3 rename (`cited_contribution_ids`) is the only field it must follow. The `media` projection's `kind` enum and `commentMediaOf` are extensible to a future `video` comment attachment without a schema break.

## Milestone gate additions

| Gate | Cards | Requirement |
|---|---|---|
| Inline conversation | T.7.1b, T.8.1, T.8.2b | The conversation reads and posts inline on the story page; the `/threads` tab + thread/branch routes + the eleven-mode `/submit` composer mode are retired (a story-redirect shim covers old deep links). |
| Comment back-compat | T.1.2b, T.3.1a, T.9.4 | Every legacy contribution type reads back as a comment; no historical row is dropped, mistyped, or made unreadable (proven by the gated harness). |
| Enrichments preserved | T.3.2a, T.3.2c, T.7.3c | `evidence`/`correction` keep their citation/claim rules and feed MERI/reputation/Hodge; the lens still feeds SCOI; `KIND_BY_TYPE` and `FORUM_TO_EVENT_TYPE` keep every legacy key. |
| Firewall-safe events | T.3.2b, T.9.1 | `comment` maps to the public `explanation`/`low_info_reply` event type; `contribution.created` egresses no body text; the pay-to-rank firewall test stays green. |
| GIF safety | T.4.1b, T.4.2 | GIFs are metadata-stripped (Comment/XMP dropped, animation/loop preserved), scan-gated, alt-texted, and served same-origin (no CSP change). |
| Live + notify privacy | T.5.2c, T.6.1a, T.6.2b, T.9.1 | SSE/notification payloads carry only the public projection; connection/reply budgets are identity-free; reply notifications honor block/mute + quiet hours + budget + the `reply_notifications` opt-out. |
| No-applause + no-raw-egress | T.8.4, T.9.1 | No reaction/score/count affordance appears on any comment surface; the §22.1 aggregate stays bucketed (`reply_depth_bucket`, never a raw value). |
| Docs byte-identical | T.9.3 | CLAUDE.md ≡ AGENTS.md; SPEC §3.4/§6.4/§6.5/§6.6/§15.1/§15.3/§15.5/§24.3 amended; index + READMEs updated; PATCH version bumped. |

## Definition of done (workstream)

- The conversation is a lightly-nested comment section embedded in the story page; **comment** is the core unit (Markdown-lite text and/or an image/GIF); the `/threads` tab/routes and the eleven-mode participation composer are retired (story-redirect shim; `/submit` reverted to story submission).
- `evidence` and `correction` survive as optional typed enrichments (citation/claim rules unchanged; MERI/reputation/Hodge inputs intact); the interpretation lens stays in the model for SCOI; the other nine types are retired for new writes, but every legacy row reads back as a comment (back-compat harness green).
- The six structured sections are replaced by the default chronological stream + optional Sources/Corrections filters; the §24.3 summary is the Overview; summaries cite `cited_contribution_ids` (old `cited_branch_ids` retained as an alias).
- GIFs are first-class comment media through the same-origin pipeline (GIF-aware stripper that drops Comment/XMP yet preserves animation/looping, `MAX_GIF_BYTES`, scan gate, required alt text); animated GIFs respect `prefers-reduced-motion`/`ui.reducedMotion` (static poster + Play).
- Comments stream live over same-origin SSE (no CSP change; `Last-Event-ID` resume; identity-free connection budget; block/mute-filtered frames); replies notify through the existing push + per-day budget (user-scoped send path + `reply_notifications` opt-out) plus a new in-app indicator + list.
- The storage change is additive and online-safe (migrations `0029`–`0032`: `ADD VALUE`, `CHECK NOT VALID`+`VALIDATE`, additive column + backfill), each with an idempotent down path; offline caches are `RECORD_SCHEMA_VERSION`-bumped so stale branch drafts/snapshots and renamed aggregates are evicted, never mis-parsed.
- The doctrine gates pass: `check:no-applause` on every comment surface, `check:no-raw-egress` over the renamed aggregate, `check:neutrality` (ranking consumes no comment shape), and the firewall/no-body-egress event assertions; SSE + notification payloads carry no score/raw/financial field.
- All client states pass WCAG 2.2 AA (axe on the comment section + composer + media + inbox); the BFF-in-the-loop E2E drives post/reply/GIF/live/report across Chromium/Firefox/WebKit.
- `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm lint:security`, `pnpm check:deps`, `pnpm check:workspace-deps`, `pnpm check:no-applause`, `pnpm check:no-raw-egress`, `pnpm check:neutrality`, `pnpm check:sw` (post-build), and `pnpm check:policy` all pass; SPEC + READMEs + CLAUDE.md/AGENTS.md + DEVELOPMENT.md + the planning index are updated in the same change set and the PATCH version is bumped.


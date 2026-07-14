# Forum, conversation, rooms, and lenses — implementation reference (WS-G)

| | |
|---|---|
| **Document** | `docs/forum/README.md` |
| **Producer** | WS-G (forum, conversation, rooms, and lenses) |
| **Status** | Complete (residuals tracked below) |
| **SPEC** | §6.4/§6.6 (thread layout, composer), §15 (forum design), §16 (rooms/lenses), §18.4–18.5 (UGC duties, drainer links), §22.1 (entities), §23.2 (endpoints), §24.3 (summaries), §25.2 (UGC security) |
| **Plan** | `docs/planning/08-forum-and-conversation.md` (38 atomic tasks) |
| **Primary consumers** | WS-H (SCOI/MERI inputs), WS-I (ranking reads), WS-J (review queue, moderation states), WS-K (classifier seams) |

The forum is where participation happens: each story now hosts an inline comment
section that shows exactly **one nested reply layer** (deeper nesting would eat
the story's reading area), with a dedicated comment-centric page
(`/stories/$storyId/comments`) for reading the full conversation — two nested
layers, re-rootable at any comment via `?root=`, with a persistent return to the
story.  New writes use the comment-first WS-T contract
(`comment` plus typed `evidence`/`correction` enrichments), while historical
contribution types remain readable for backward compatibility.  Rooms scope
topics and communities, lenses are interpretation contexts for SCOI, and
reputation exists **without applause**.  All UGC renders through one
defense-in-depth pipeline; the server stores raw Markdown-lite only.

## Architecture

| Location | Contents |
|---|---|
| `packages/shared/src/schemas/contribution.ts` | The contribution create union (comment + correction live writes; legacy read types), citation schema, update/public projections, anchors |
| `packages/shared/src/schemas/thread.ts` | Conversation/safety state machines + thread wire contracts |
| `packages/shared/src/schemas/room.ts`, `forum-api.ts` | Room/lens/steward/subscription + endpoint wire contracts |
| `packages/shared/src/constants/moderation.ts` | The 51 ratified WS-A.1.2 reason codes (pinned by test) |
| `packages/shared/src/ugc/` | The WS-G.4 pipeline: Markdown-lite parser → serializer → DOMPurify (`licio-ugc`) → `renderUGC`; drainer-link detection |
| `packages/db/src/schema/` | `contribution.ts`, `room.ts`, `upload.ts`, the WS-G-owned `thread.ts` |
| `packages/db/drizzle/0008_ws_g_forum.sql` | The WS-G migration (validated against live Postgres 16) |
| `apps/api/src/forum/` | Stores (in-memory + interfaces), services container, contribution guard chain, story comment reads, live broadcaster, compatibility thread reads, rooms, transitions, safety seam, GIF/EXIF stripping, config, Drizzle adapters |
| `apps/api/src/routes/forum.ts`, `routes/rooms.ts` | The §23.2 endpoint surface |
| `apps/web/src/components/comments/` | Inline one-layer comment section + the shared recursive `CommentNode` (depth-capped per view, "continue"/"show more" links onward) and `CommentParts` (header/media/composer), reused by the dedicated comment page (`routes/-pages/story-comments.tsx`, route `stories.$storyId_.comments.tsx`). Compact density: a single-line meta header (`Author · 3h`, compact relative time from `lib/time.ts` with the full timestamp on the `<time>` title), top-level comments as `neu-raised-sm` tiles, nested replies as flat left-rail threads (no card-in-card), and inline text-link actions (`commentActionClass`) instead of touch-height buttons |
| `apps/web/src/components/ugc/` | `UgcBody` (THE sanctioned render sink) + the drainer interstitial |
| `apps/web/src/lib/link-safety.ts` | Runtime blocklist cache + shared detection |
| `packages/invariants/src/pwatt/low-info-reply.ts` | Conservative low-info classifier (closes the WS-E residual) |

## WS-G.1 Thread and contribution model

**Threads** (WS-G.1.1).  Created as shells in the same transaction as their
story (WS-F.1.4d); WS-G owns the full model.  `(story_id, branch_index)` is
unique (multiple branches per story supported at the schema level).  Two
orthogonal state dimensions, both with table-driven legal graphs in
`@licio/shared` and a transition service that audits every change (actor,
reason, timestamp) and emits `thread.state.changed`:

```
conversation_state: active → {deepening, tense, under_review, resolved}
                    tense ⇄ under_review
                    under_review → {active, resolved}
                    any non-archived → archived (terminal)

safety_state:       normal ⇄ elevated; either → under_review | restricted
                    under_review → {normal, elevated, restricted}
                    restricted → under_review ONLY (de-escalation passes review)
```

**Documented deviation.**  The WS-G.1.1 transition text lists `restricted` as
an `under_review` outcome, but `restricted` is not a member of the six-value
conversation enum — it is a SAFETY state.  A review that ends in restriction
transitions `safety_state → restricted`; the conversation dimension returns
to `active`/`resolved`/`archived`.  The migration retired the WS-F shell
vocabulary by enum recreation (`empty`/`emerging`→`active`,
`dormant`→`archived`, `caution`→`elevated`), so the final enums hold exactly
the canon.

**Organic (system) transitions.**  Two principled drivers ride the same
audited path as the steward surface, with actor `system` and a
machine-readable reason:

* *Structural deepening* — `active → deepening` evaluates at contribution
  creation (detached; the response never waits) and fires only when ALL of
  volume (published contributions ≥ `forum.deepeningMinContributions`,
  default 12), sourcing (sourced comments + corrections —
  ≥ `forum.deepeningMinEvidence`, default 2), and a LIVE
  multi-level exchange (the new contribution's depth ≥
  `forum.deepeningMinDepth`, default 2) hold.  Deterministic given store
  state; never fires from a non-active state.
* *Integrity escalation* — the WS-E harassment-cascade detection (a
  validated, base-rate-conditioned signal — never a fresh lexical
  heuristic) drives `safety normal → elevated` and `conversation active →
  tense` through the durable `forum-thread-posture` router consumer
  (restricted classification, non-scoring; idempotent under at-least-once
  redelivery; burst signals deliberately ignored).  Per the ratified graph,
  `deepening` has no tense edge — an escalated deepening thread elevates
  its SAFETY posture and keeps its conversation state.

Everything else (de-escalation, review, resolution) stays HUMAN: recovery
routes through `under_review`, which is steward judgment (WS-J).

**Contributions** (WS-G.1.2a–d, re-scoped by WS-T).  Two types — `comment`
(sourcing rides its citations) and `correction` (a sourced challenge; ≥ 1
citation, targets exactly one comment or the story).  The WS-G-era nine
(question/answer/synthesis/counterexample/explanation/local_context/
direct_experience/moderation_concern/meta_discussion) were REMOVED outright
(migration `0076` maps stray dev rows onto comments; moderation concerns
live in the WS-J report flow).  The type never changes after creation
(structurally absent from the update contract).  Bodies are raw
Markdown-lite stored VERBATIM — sanitization is exclusively render-time
(WS-G.4) — bounded with per-type caps (comment 5000, correction 2000).
Metadata is the STRICT allowlisted object (target refs, debate arena,
attachments, lens); citations are validated objects (http/https/`doi:`
only).

The tree: `parent_contribution_id` with a **materialized JSONB ancestor
path** (`path`, root-first; `depth = jsonb_array_length(path)` ≤ 10,
CHECK-enforced).  Subtree reads use the GIN containment index
(`path ⊇ [rootId]`) — no recursive CTE on the hot path; parity with a
reference recursive walk is tested, and the 500-contribution read meets the
< 50 ms bound.  Reparenting is disallowed (paths never rewrite).
`(user_id, client_draft_id)` is partially unique — the WS-G.3.1 idempotent
create.  Edit history is append-only snapshots (§15.5); author deletion
tombstones `user_id` (SET NULL) while bodies persist (§22.4).

**Evidence cards** (WS-G.1.3).  Cards now carry BOTH dimensions:
`evidence_type` (MATERIAL: `primary_source`, `dataset`, `transcript`,
`legal_text`, `report`, `expert_reference`, `fact_check`) and
`relationship_type` (the WS-F-era claim relationship, renamed at rest;
pre-WS-G rows backfilled `report`/unchanged).  `claim_id` cascades on claim
deletion; `submitted_by` tombstones; `contribution_id` links the introducing
contribution (the SQL FK avoids a TS module cycle).  Verification-state
changes are audited (`evidence_verification_change`).

**Summaries** — *removed.*  The §24.3 layered thread-summary / conversation
"Overview" feature was withdrawn end to end: the `summaries` table, the
`thread.current_summary_id` pointer, the `POST /v1/threads/:id/summaries`
endpoint, the `SummaryStore`, the demo seed, and the reader-facing Overview UI
are all gone (migration `0057`).  The WS-K AI summarization pipeline is retained
only as an eval/audit substrate (it still generates a draft, runs the §24.3
quality + grounding checks, and records an AIOutputRecord) but no longer
publishes a thread Overview.

## WS-G.2 Rooms and lenses

Six room types, three visibilities, §17.4 governance modes with `ordinary`
ALWAYS the default (mode transitions are WS-L/M, not exposed here).  Steward
assignment is the normalized `room_stewards` join on the five WS-A.2.2 roles.
Room creation: public rooms for any verified account; restricted/expert_led
require an elevated platform role; `steward` rooms require staff; duplicate
names are race-safe 409s (case-insensitive unique index).  The creator
auto-becomes community steward with an ACTIVE subscription.

Listing (WS-G.2.3a): type/joined/recommended/q filters, cursor pagination
(default 20, max 50).  The **recommendation reads exactly two inputs** —
`activityRecencyMs` and `createdAtMs` (timestamps) — never member counts or
any SIG-PROH-* signal; the input keys are asserted against the denylist in
tests.  `member_count` and `thread_count` are display-only.

Subscriptions (WS-G.2.3d): public joins are immediate and idempotent;
restricted joins create a pending request (stable `request_id`) decided by
room stewards; leaving removes the subscription (one row; the never-read
per-room notification preferences were dropped in migration `0076`).  Visibility is two-tier: a pending
applicant can see the room EXISTS (listings, their join status) but reads
none of its content — threads, lenses, and detail all require an ACTIVE
membership or a steward role (`roomContentVisibleToUser`, the same bar
`threadVisibleToUser` enforces).  A subscription also carries the member's
chosen **posting lens** (`room_subscriptions.lens_id`, nullable, migration
`0058`): the interpretation a top-level comment they write in the room joins.
`NULL` is the default **"Undecided"** state present in every room; it is set
when the member joins (`POST /join` `{ lens_id }`) and changed ONLY through
`PUT /v1/rooms/:id/lens` (`setMembershipLens` — validated lens∈room, `null`
returns to Undecided) — never a side effect of the reading/filter lens.  Room
detail projects it as `my_lens_id`.

Lenses (WS-G.2.2/2.4): `(room_id, lens_type)` unique over the seven §16.2
types; a top-level comment carries `metadata.lens_id` (the author's membership
posting lens, validated against the thread's room).  `GET /v1/stories/:id/lenses`
groups lens-tagged contributions per lens — never framed as factions or
scoreboards — and the SCOI divergence summary is absent gracefully until WS-H.4
produces it.

Lens authoring is DECOUPLED into READING and POSTING (client, WS-G.2.2/WS-T),
so a member can never accidentally post as a lens they were only viewing:

* **Create** — a steward manages a room's lenses inside the steward-only
  `RoomSettingsForm` (`apps/web/src/components/rooms/LensManager/`), which
  calls the existing `POST /v1/rooms/:id/lenses` (server enforces the steward
  role); the read is `GET /v1/rooms/:id/lenses`.
* **Read (sort + filter)** — the conversation has ONE "view" control, a button
  labelled by the active view that opens a modal `Sheet`
  (`components/comments/CommentViewSelector`; a modal, not a chip row, so it scales
  to any number of lenses).  *Newest*/*Oldest* map to the endpoint's `order` param
  (whole-thread, server-ordered); *Highest participation* client-sorts the loaded
  page by the WS-E.2.1c content-participation weight (`comment-participation.ts`: a
  sourced comment outweighs an unsourced one; a debate-loser sinks) — a content
  weight, NEVER attention or applause.  A **lens** view is a reading FILTER ONLY —
  it scopes which comments are shown and never the lens a comment posts as.
* **Post (membership lens)** — the lens a top-level comment JOINS is the author's
  chosen **membership posting lens** (`my_lens_id`, null = Undecided), NOT the view
  filter.  It is picked when they join a room with lenses (a lens modal defaulting
  to Undecided) and changed ONLY via the room page's **lens button**
  (`components/rooms/RoomLensControl/`: `RoomLensButton` → `RoomLensDialog` →
  `RoomLensSelector`), placed BETWEEN the sign-in/join button and the governance
  button.  The story-page composer shows a read-only "Posting as: X" note and sends
  `metadata.lens_id = my_lens_id`; replies stay untagged; the authoritative tag is
  server-validated (lens∈room).
* **Read divergence** — the "Where interpretations differ" drawer (WS-H) renders
  right after the composer with a plain-language divergence band per lens pair.  A
  lens is an interpretation context, never a vote — the `check:no-applause` gate
  covers these surfaces.

## WS-G/WS-T API surface and comment composer

| Endpoint | Notes |
|---|---|
| `POST /v1/contributions` | The guard chain: per-account sliding-window rate limit (10/min default, 429 + exact Retry-After, keyed by non-reversible account ref — never an IP) → thread existence/visibility (hidden story → 404; restricted-room thread → 404 to non-members; archived → 409; safety-restricted → 403) → `client_draft_id` dedup (existing row returns, 200) → per-type cross-record validation (422 with specific messages) → safety pre-checks (flag → `under_review` + review queue) → insert → durable `contribution.created` emission — EXCEPT for safety-held rows, which emit nothing and bump no room activity (scoring/lifecycle/freshness must not count invisible content; emission on release is the WS-J approval seam) |
| `GET /v1/stories/:id/comments` | Story-owned comment section: keyset-paginated roots with bounded reply previews, optional `sources`/`corrections` filters, and a `depth` (1 = inline section's single nested layer; 2 = the dedicated comment page's two layers) materialized server-side from REPLY_PREVIEW-bounded fetches. A focused read (`?root=<id>`) returns that comment as `anchor` with its direct replies as the paginated comment list (404 if the anchor is missing/invisible) — the dedicated page's re-rootable drill-down. This is the primary read surface embedded on `/stories/$storyId`; the old global `/threads` directory is retired on the client. |
| `GET /v1/threads/:id` | Back-compat overview/resolution surface. The web client uses it only to redirect old `/threads/$threadId` deep links to the owning story comment section. |
| `GET /v1/stories/:id/comments/stream` | Same-origin SSE stream for new visible comments; frames carry only the public contribution projection, are revalidated by the read bar, and are covered by score/raw/financial-field introspection tests. |
| `GET /v1/contributions/:id/anchor` | Semantic deep-link anchor (`thread_id` + subtree root) for legacy/shared contribution links. |
| `PATCH/DELETE /v1/contributions/:id` | Author-only edit (history snapshot; citation floors survive edits; the safety classifier RE-RUNS on the edited content and a flag holds it for review) and tombstone removal; 404-over-403 |
| `GET/PATCH /v1/feed/preferences` | The §23.2 canonical veneer over the WS-D settings stores (single source of truth; clamped/audited); the five §13 modes |
| `POST /v1/uploads`, `GET /v1/uploads/:id` | See uploads below |
| `GET /v1/security/link-blocklist` | Drainer blocklist, steward-tunable, content-hash version for cache busting |
| `GET/POST… /v1/rooms*` | Listing/creation/detail/threads/join (`POST /join` carries the joiner's `{ lens_id }`, WS-G.2.2)/join-requests/lenses + `PUT /v1/rooms/:id/lens` (the SOLE posting-lens change path — validated lens∈room, `null` = Undecided, member-only); the directory walks the store keyset until a full visible page (no fetch-prefix cap), `joined` enumerates the requester's own memberships, and `thread_count` counts VISIBLE threads only (hidden stories excluded — no oracle) |
| `GET /v1/notifications`, `PATCH /v1/notifications/:id/read` | Bodyless reply-notification inbox; push wakes are user-scoped and honor `reply_notifications`, quiet hours, budgets, and block/mute relationships. |
| `PATCH /v1/threads/:id/state` | Steward transitions (audited, reasoned) |
| `/v1/forum/admin/*` | Steward+TOTP: validated config writes (422 on bad values), metrics |

**Client integrity token.**  SPEC §23.3 lists `client_integrity_token` on the
create request.  In this stack the per-session single-use CSRF nonce
(serialized client-side, `timingSafeEqual` server-side) IS that token; a
second bespoke token would duplicate the same proof against the same threat
model, so none is added.  `client_draft_id` provides the idempotency half.

**Scoring mapping** (the WS-E emission boundary; pinned by test):
`comment→explanation`, `correction→correction`.  The conservative
`classifyLowInfoReplyV0` (@licio/invariants) re-classifies unmistakable bare
acknowledgments ("+1"/"lol"/"this", < 16 chars, uncited) on comment bodies to
`low_info_reply` (weight 0 — volume, never negative); the WS-K classifier
replaces it behind the same signature.  (The `evidence` contribution type,
its EvidenceCard co-creation, and the `evidence.added` topic were removed —
sourcing is comment-centric citations, counted by the store's `sourced`
predicate.)

**Composer** (WS-G.3.4–3.6, re-scoped by WS-T).  The inline comment composer:
a comment (text and/or image/GIF) with two progressive enrichments — *Cite a
source* (a structured citation ⇒ a sourced comment) and *Mark a correction*
(the sourced challenge).  The payload builds through the SHARED
two-branch create schema — client and server rules are the same module.
Per-type char caps with live counters, voice
dictation rides the Web Speech API (graceful absence), and drafts autosave
encrypted to IndexedDB through a trailing 800 ms debounce (one
encrypt+write per pause — never one per keystroke) with backgrounding and
unmount flushes, a per-draft resume-or-discard prompt (the most recent
three), and a 30-day expiry sweep at app start.  Share target (WS-G.3.7a):
the manifest registers a POST `/share-target`; the service worker
303-redirects the shared payload into `/submit` search params
(length-bounded, schema-validated), where it becomes a STRUCTURED citation
(`url` + shared `title` + `accessed_at`) shown as a preview chip with a
link-safety caution when the heuristics flag it.  The citations textarea is
seeded with the URL and stays the source of truth: at payload build the
seed only ENRICHES a surviving matching line (deleting the line — or
dismissing the chip — drops it).

**Uploads** (WS-G.3.7b).  JPEG/PNG/WebP/AVIF/GIF images, MP4/WebM video, and
VTT captions with magic-byte validation (polyglots rejected; the clientless
PDF document path was removed).  Image metadata is stripped
BEFORE storage by pure byte-level container surgery (no re-encode): JPEG
drops APP1–APP15 + COM; PNG drops tEXt/zTXt/iTXt/eXIf/tIME; WebP drops
EXIF/XMP chunks, clears the VP8X flag bits, and recomputes the RIFF size.
AVIF metadata removal would require rewriting ISO-BMFF `iloc` offsets, so an
AVIF carrying Exif/XMP is REJECTED (fail closed — the privacy promise is
never silently broken) and metadata-free AVIF passes.  Alt text is required
for images.  Bytes live in
S3-compatible storage when the `S3_*` group is configured, else in-memory
with a production warning (the WS-D DSAR-archive posture).

**Scan gate** (the WS-J.2.6b seam, explicit).  After the inline local
checks pass, the route consults the injectable `UploadScanner`
(`forum/safety.ts`): `clear` serves immediately, `pending` stores the
record but blocks BOTH attachment and serving until a later
`setScanState('clear')`, and `flagged` rejects the upload outright (422,
nothing stored).  The default `LocalChecksUploadScanner` clears — the local
checks ARE the scan until WS-J's shared malware intelligence swaps in
behind the same interface — and the gate itself is exercised with fake
scanners at the route level, so the seam swap needs no route changes.
`scan_state` rides the wire (`uploadPublicSchema`) so clients can show a
pending hold.

**Restricted-media serving gate** (WS-Q.5.2c).  Authorization for media bytes
is enforced at the serving route, not the object ACL.  An upload linked to a
story carries that story's id in `owner_story_id`: set at submission for story
media (main media, caption track, poster) AND at contribution creation for
attachments (a thread inherits its story's visibility, §14.5.6), so evidence/
attachment bytes are gated exactly like story media.  `GET /v1/uploads/:id`
resolves the owning story and gates on it: a PUBLIC story's media keeps a
stable, shareable bare URL; a `room_only` story's media is served ONLY through a
short-lived (2 h), HMAC-signed URL (`?e=…&t=…`) minted AFTER the read-bar check
(`lib/media-urls`) OR to its **authenticated owner** (so a user can always
retrieve their own upload — e.g. a DSAR export link — without a signed URL),
while an outsider who guesses the upload id is refused (404).  The owning
story's takedown/safety-hidden state is re-checked at fetch time, so
moderation/legal removal revokes media immediately (for everyone, owner
included); rotating `SESSION_SECRET` invalidates every outstanding token.  An
upload with no owning story (not yet linked) serves unrestricted.  Honest limit
(§14.5.7): a member already holding a valid URL can fetch until it expires —
in-room visibility bounds distribution, it is not a secrecy guarantee.  The feed
wire carries server-minted read URLs (`feedMediaSchema.url`/`captions_url`/
`poster_url`), validated as same-origin `/v1/uploads/` paths so no off-origin or
script URL can reach an `<img>`/`<video>` `src`.

## WS-G.4 UGC safety (defense in depth)

```
raw text → Markdown-lite AST → constrained HTML → DOMPurify (licio-ugc)
        → TrustedHTML → React (UgcBody, the ONLY dangerouslySetInnerHTML)
```

* The parser has NO raw-HTML node kind — tag passthrough is impossible by
  construction; `javascript:`/`data:`/`vbscript:`/`file:` destinations are
  dropped (labels survive as text); protocol-relative URLs normalize to
  https; inline scanning is O(n) sticky-regex, bounded at 50 KB.
* The serializer emits only the WS-G.4.2a allow-list with `href` as the sole
  attribute (escaped).
* One centralized DOMPurify instance: explicit ALLOWED/FORBID lists,
  `RETURN_TRUSTED_TYPE: true`, the named `licio-ugc` policy (CSP:
  `trusted-types default dompurify licio-ugc`), and the link hook adds
  `rel="noopener noreferrer"` + `target="_blank"`.  Without a DOM, DOMPurify
  exposes NO sanitize function — `renderUGC` degrades to fully-escaped plain
  text (formatting lost, safety kept), never to unverified markup.
* The Biome `noDangerouslySetInnerHtml` rule is suppressed exactly once
  (UgcBody); any other suppression is the violation the rule exists to catch.
* The OWASP XSS suite (61 sourced vectors across 9 families, plus
  idempotence and stored-XSS-shaped re-renders) structurally audits the DOM
  output and is a CI gate; the API test proves hostile bodies persist
  verbatim and the same stored value renders safely.

**Wallet-drainer interstitial** (WS-G.4.2c).  Detection is shared pure logic:
blocklist (exact/subdomain), contract-interaction path/query patterns
(`approve`, `setApprovalForAll`, `permit`, `transferFrom` — the
`/permits-and-zoning` substring false positive is a documented, proportionate
cost), and dApp mimicry (brand labels outside the real domain;
edit-distance-1 typosquats).  The runtime blocklist is steward-config
(`forum.drainerBlocklist`), served with a content-hash version and cached
client-side for 5 minutes.  Clicks on rendered UGC anchors are intercepted
by native event delegation; suspicious destinations show the full URL with
continue/back, and the choice is never logged against the user (anonymous
counter only).

The click path **never awaits the network**: verdicts read the cached
blocklist synchronously (`cachedBlocklist` — bootstrap warms it via
`warmLinkSafety`, and a stale/cold cache triggers a background refresh
while that one click degrades to the local heuristics), so transient user
activation always survives to `window.open`.  Openings sever the opener on
the returned proxy rather than passing the `noopener` feature string —
per spec that string makes `window.open` return null even on SUCCESS,
which would make popup blocking undetectable; with the proxy approach an
actual block falls back to the interstitial, whose Continue button is a
fresh user gesture.

## Privacy and WS-D hooks (closed)

* `anonymizeContributions` (the WS-D.2.4 residual) is REAL: account purge
  tombstones contribution/upload authorship and REMOVES room
  subscriptions and steward rows (membership is personal data).
* `exportContributions` now composes stories + every forum contribution
  (keyset-paginated to exhaustion), room subscriptions, AND
  the user's upload records (content type, size, alt text, scan state, and
  the same-origin retrieval URL — the bytes stay in the upload store, which
  serves them publicly once scan-cleared) — the DSAR export is complete
  (§19.3 / GDPR Art. 15).
* No IP, no location, anywhere (§19.1): rate limits key on non-reversible
  account refs; logs and metrics carry ids and counts, never body text.

## Testing

~190 WS-G tests across the suites: shared schema/table-driven state machines
(54), the UGC pipeline + XSS gate (132), api routes/units/organic-transition
suites (80+), invariants classifier (22), and the web
composer/UGC/drafts/dictation/payload/link-safety suites.  The 0008
migration was applied against live Postgres 16 over the real chain with
legacy-vocabulary seed rows: enum mappings, CHECK constraints, the dedup
index, FK actions, and the anonymize path verified.

**Gated integration** (`apps/api/src/__tests__/forum-integration.test.ts`)
proves all five Drizzle forum adapters against the real migration chain:
drizzle-wrapped unique-violation mapping (the 23505 code lives down the
error `cause` chain), transactional evidence co-create rollback, GIN
path-containment subtree reads WITH keyset continuation, storage-layer
CHECK enforcement (depth cap, path/parent consistency,
content-type allow-list), draft-key dedup + tombstone semantics, DSAR
`listByOwner`, descending `listThreadsByRoom` pagination, exact
keyset-cursor walks (the adapters write millisecond-precision timestamps so
`(created_at, id)` cursors round-trip through ISO strings without
microsecond drift), and the S3 byte path end-to-end against a fake bucket
(SigV4 `Authorization` + exact payload hash, round-trip, 404 degradation).
**These run in CI**: the Test & Coverage job provisions
`pgvector/pgvector:pg16` + `redis:7` service containers, so the gated
suites are no longer skip-only.

**Real-browser E2E** (`apps/web/e2e/ugc-safety.spec.ts`, `composer.spec.ts`, `comments.bff.spec.ts`;
Chromium + Firefox + WebKit against the preview's enforcing CSP): the
`licio-ugc` Trusted Types policy creates TrustedHTML under
`require-trusted-types-for 'script'` in real engines, the attack fixtures
come out inert (no script/handlers/javascript: remnants, execution flag
never set), the interstitial intercepts a heuristic-suspicious link and
Back closes without navigating, a safe link opens a popup under intact
user activation, story submission renders with shared-schema validation, and the BFF-in-the-loop comment spec opens the inline comment section, verifies the legacy thread redirect, opens the dedicated comment-centric page (and its return-to-story control), and runs axe on both conversation surfaces.

## Residuals (tracked elsewhere)

* **WS-H**: SCOI divergence for the lens read (the endpoint degrades
  gracefully); MERI independence-group assignment beyond inheritance;
  bridge-comment SCOI conditioning.
* **WS-I**: room/thread read models in the front page (feed-mode
  consumption is CLOSED — the §11.6 sort modes are served by the real
  ranking service, and preferences persist).
* **WS-J**: queue ownership (forum intake lands in the shared review inbox
  as `contribution_safety_hold`), steward
  moderation actions on contributions beyond author tombstones, appeals;
  the shared malware intelligence behind the `UploadScanner` seam.
* **WS-K**: governed classifiers behind the `ContributionSafetyClassifier`
  and `classifyLowInfoReplyV0` seams; automated draft summaries.
* **WS-L/M**: governance-mode transitions (read-only `ordinary` here).
* **WS-P**: BFF-in-the-loop browser E2E for authenticated thread/submit
  flows (the composer + UGC sink are real-browser covered via the
  workbench; the composer < 300 ms budget is instrumented via perf marks
  and its lab measurement joins WS-P).
* Citation TITLE extraction for PASTED urls (og:title) needs a server-side
  fetch proxy — cross-origin pages are not client-readable; shares carry
  their own title through the share-target intake, and the domain fallback
  covers the rest.
* Migration 0008's enum recreation takes table-rewrite locks — fine for a
  pre-production database; a live deployment would need a staged
  (add-value/backfill/swap) variant.

## WS-Q deltas — room ownership and binary visibility

WS-Q remodels the room layer to the SPEC v0.7 ownership tree (rooms own
content, content owns conversation).  This supersedes the WS-G.2 line above
("six room types, three visibilities"): the room type/topic stays
descriptive, but visibility is now **binary** and join/posting are
**orthogonal** axes.

- **Binary room visibility (`public | private`).** The room tier governs
  *existence*: a public room and its membership roster are discoverable by
  anyone; a private room's content is members-only, but the room still
  appears in listings (`roomVisibleToUser` is unconditionally true — the
  pre-WS-Q "restricted/expert_led can't be seen" rule is gone, so the
  directory no longer leaks a membership oracle through omission).  The
  legacy three-value enum (`public`/`restricted`/`expert_led`) maps forward
  via `mapLegacyRoomVisibility` (public→{public, open, all_members};
  restricted→{private, request_approval, all_members};
  expert_led→{private, request_approval, experts_and_stewards}) — the
  migration backfill that preserves every shipped room's behavior.
- **Orthogonal axes.** `join_model ∈ {open, request_approval, invite}`
  decides how members are admitted; `posting_policy ∈ {all_members,
  experts_and_stewards}` decides who may open top-level content.
  `resolveRoomCreateAxes` fills defaults and enforces coherence: a
  **public** room admits only the `open` join model, and only staff may
  create a room at all in the steward/governance posture.  Reserved slugs
  (incl. `commons`) are rejected at create.
- **The Commons.** A single seeded default room (`COMMONS_ROOM_ID`, slug
  `commons`, public/open/all_members) owns all content that predates an
  explicit room choice; the in-memory store self-seeds it (and re-seeds on
  `clear()`), the Drizzle path seeds it idempotently in migration 0015
  (`INSERT … ON CONFLICT DO NOTHING`), and `ensureCommonsRoom` is the
  boot-time guarantee.
- **Two-tier read bar.** `storyReadableByUser` is the authoritative content
  gate: a `public` story in a `public` room is world-readable; a `room_only`
  story (or any story in a `private` room) requires an ACTIVE membership or a
  steward role.  Unknown rooms fail closed.  Every reader path (story
  detail, thread, claims/evidence, lenses) routes through it, and absence is
  always **404-over-403** — never a 403 that would confirm a resource exists.
- **Top-level posting guard.** `userMayPostTopLevel` enforces `posting_policy`
  for new content (a member who is neither an expert nor a steward in an
  `experts_and_stewards` room is `403 posting_restricted`); `joinRoom` admits
  per `join_model` (open → immediate ACTIVE; request_approval → pending;
  invite → pending, no self-serve).
- **Governance writes (steward+TOTP).** `PATCH /v1/rooms/:id/settings`
  (`updateRoomGovernanceSettings`) changes `join_model`/`posting_policy`
  freely and audits `forum_config_change`, but **rejects a visibility change
  with 422** (`visibility_not_settable`) and points at the cascade endpoint —
  visibility is not a plain settings write.
- **The visibility cascade.** `POST /v1/rooms/:id/visibility`
  (`changeRoomVisibility`) is the audited public⇄private transition.
  *public → private* forces every public story `room_only` through an
  idempotent, resumable per-story sweep (each emits
  `content.visibility.changed` with `trigger=room_visibility_change`), flips
  the room, and collapses an `open` join model to `request_approval` (active
  memberships are retained); *private → public* makes the room world-readable
  and publishes NO content (each story stays `room_only` until its author
  widens it).  One summary `room_visibility_change` audit record carries the
  converted count.
- **Native video admission (`forum/video.ts`).** Uploaded `video/mp4` /
  `video/webm` ride a validate-only probe: byte-level MP4-box / WebM-EBML
  sniffing (a spoofed extension/MIME is caught by content), duration extraction
  for the `ingestion.video_max_seconds` cap, and OFFSET-PRESERVING metadata
  neutralization (MP4 `udta`→`free`, WebM `Tags`→`Void`) so sample-offset
  tables / cue points stay valid with no re-encode.  The gated upload-serving
  path advertises `Accept-Ranges` and honors single byte-range requests (206)
  for native `<video>` seeking.
- **Data-rights across both tiers (`forum/data-rights.ts`, WS-Q.3.5).**
  `exportUserContent` returns the user's own stories/contributions regardless of
  visibility (room_only included), each tagged `room_ref`+`visibility`, plus
  private-room subscriptions; `anonymizeUserContent` tombstones contributions
  across tiers and strips private-room memberships/steward rows.

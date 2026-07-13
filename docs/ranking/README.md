# WS-I: Ranking and Distribution — implementation reference

This document describes the implemented WS-I surface: the eight-stage feed
pipeline (candidate generation, invariant feature join, safety filter,
constrained PWAtt scoring, diversification, decision logging, explanation
generation, feed response), the ranking-neutrality test suite, the kill
switch and safe fallback, and the steward audit surface. The design
specification is SPEC §5.4–§5.5, §13, §21.2, §22.4, §23.3, §24.4, and
§30.5–§30.6; the task plan is `docs/planning/10-ranking-and-distribution.md`.

Three constraints govern everything here:

1. **No pay-to-rank, structurally.** Candidate retrieval, the feature
   store, scoring, and explanations are incapable of reading wallet,
   payment, treasury, donor, follower-count, or membership data: the stage
   schemas are strict-closed with no financial field, the WS-I.2.1b
   denylist (the SAME shared WS-A.1.1 term list the WS-F/WS-G table checks
   use — `@licio/shared` `isFinancialFieldName`) rejects any denied field at
   the feature-store write boundary with a typed
   `DeniedFinancialFieldError`, the candidate source-type enum has no
   `sponsored` member, the module import graph contains no financial module
   (statically tested), the db-level checks extend to the two WS-I tables,
   and the ten-test neutrality suite (WS-I.3) proves output equivalence in
   CI on every PR (`pnpm check:neutrality` is an explicit named gate).
2. **The §30.5 lift, bounded and reversible.** WS-I performs the documented
   PWAtt shadow lift: `PWATT_V0_SHADOW_MODE` in `@licio/invariants` is now
   `false` (a CODE change, reviewed like any other — never a configuration
   flip), so PWAtt serves as a BOUNDED ranking input — saturated components
   in [0, 1], §5.5-guardrailed convex weights summing to exactly 100,
   penalties as separate nonnegative coefficients, the non-overridable
   safety filter, and the runtime kill switch. The feature pipeline accepts
   PWAtt components only from rows stored `shadow_mode: false` (pre-lift
   rows stay powerless) and only while the code-level constant holds.
   Reverting the constant — or engaging the kill switch — restores the
   pre-lift posture: the safe fallback ranker is provably score-blind (the
   WS-E fallback-invariance tests pin ordering with, without, and with
   mutated PWAtt scores).
3. **The eleven invariants remain promotion-gated (WS-H.1.2e).** Every
   invariant-derived penalty (pM/pH/pT/pR) and constraint (MFCI exclusion,
   SCOI reduction/pause, PHI diversification, GWEI deployment gate, MERI
   effects) applies only when `effectsEnabled(invariantType)` — otherwise it
   is computed and RECORDED in the decision log with `enforced: false`
   (observable, never a hidden sanction). The SCOI divergence flag
   (`scoi_context_card`) is the one deliberate exception: it is informational
   (a needs-context state never means false), so it attaches regardless of
   promotion state — feeding the context-gate observability counter; the
   lens-map detail lives on the story read surface.

## Architecture

| Layer | Location | Contents |
|---|---|---|
| Pure domain logic | `packages/ranking/src/` | Deterministic, I/O-free stage functions: the §5.4 scoring arithmetic, penalties, constraints, matroid dedup, balancing, explanation templates (locale-ready), the pipeline core, the replay diff — plus the strict stage-boundary zod schemas and the denylist with its versioned artifact (`denylist.config.json`) |
| Services | `apps/api/src/ranking/` | Stores (+ Drizzle adapters), the eight organic retrievers + the room-surface scoper, quotas, the candidate orchestrator, the feature population pipeline, the safety filter (WS-J seam), the feed service + replay, the kill switch, fail-closed config, the lease-guarded scheduler |
| Routes | `apps/api/src/routes/ranking-admin.ts`, the feed handlers in `routes/v1.ts` | Steward audit/replay/kill-switch/config/feature-snapshot surface; `GET /v1/feed` (front page + `?topic=`), `GET /v1/rooms/:roomId/feed` |
| Tables | `packages/db/src/schema/ranking.ts` (migrations 0012/0013) | `ranking_feature_vectors` (append-only revisions), `ranking_decision_logs` (one per request, §22.4 retention) |
| Neutrality suite | `apps/api/src/__tests__/ranking-neutrality.test.ts` | The ten WS-I.3 tests (`pnpm check:neutrality`) |

Workspace boundary: `@licio/ranking` depends on `@licio/shared` and
`@licio/invariants` only — NEVER `@licio/db` (the ranking math has no
database access by construction; `pnpm check:workspace-deps` enforces it).

## The eight stages (SPEC §13.3)

```
serveFeed(services, { userId, surface, surfaceRoomId, surfaceTopicId, mode })
  1. candidate generation   assembleCandidatePool: every registered
                            retriever via Promise.allSettled (a failing
                            retriever is skipped + gap-logged with its
                            duration, never fatal), merge/dedup by item id
                            (origins merged, max retrieval score kept),
                            diversity quotas, budget, zod boundary; then
                            SURFACE SCOPING (room feeds keep the room's
                            items, topic feeds the topic's) and profile
                            selection (logged `ranking.profile.selected`;
                            topic surfaces derive sensitivity from the
                            requested topic)
  2. feature join           featureStore.getLatestMany (ONE DISTINCT ON
                            query) + cold-start write-through (every scored
                            revision is stored, so every decision replays)
                            + per-REQUEST topic relevance resolved from the
                            user's own configured interests
  3. safety filter          applySafetyFilter (authoritative, BEFORE
                            scoring): the BATCHED ModerationStateProvider
                            (three bulk reads per request, fail-closed on
                            unknown items) covers removals, integrity
                            removals, thread restriction, author shadow
                            (WS-J.2.3 `author_shadow` — zero organic reach
                            while the item stays directly readable; injected
                            as a function dep so the ranking import closure
                            stays moderation-free, neutrality-gated), age
                            gating, the jurisdiction seam; scoring has no
                            re-admission path (asserted)
  4. constrained scoring    rankFeasibleSet: baseline + §5.4 positive
                            combination − promotion-gated penalties;
                            per-item constraints (MFCI/SCOI) evaluated once
  5. diversification        MERI cluster cap (default 2/page, demoted items
                            become the representatives' "more on this
                            story" expansion), source ≤ 15% / topic ≤ 25%
                            caps with graceful degradation, lens
                            representation over REAL per-item lens
                            assignments on room surfaces, PHI tightening
  6. decision logging       EXACTLY one RankingDecisionLog per served
                            request (ranked and fallback alike) + one
                            `ranking.decision.logged` event per selected
                            item (built as one batch, persisted with ONE
                            insertMany); a failed write is a loudly-counted
                            auditability incident, never a serving failure
  7. explanations           highest-priority template from the item's REAL
                            signal profile; constraint/safety slowing
                            reasons outrank positive ones; prohibited
                            phrasings are structurally impossible; the
                            renderer is locale-ready (served in `en`)
  8. feed response          §23.3 FeedItem mapping with BATCHED reads (bulk
                            stories/threads/safety states, one lens listing
                            per distinct room) + `request_id`,
                            `more_on_this_story`, and `context_card` on the
                            wire (`feedResponseSchema`)
```

Surfaces: `GET /v1/feed` serves the front page; `GET /v1/feed?topic=…`
serves the TOPIC surface (pool scoped to the topic; profile sensitivity
derived from it — a sensitive topic always selects the conservative
profile); `GET /v1/rooms/:roomId/feed` serves the ROOM surface, gated by
the WS-G content-visibility bar (`roomContentVisibleToUser`) BEFORE the
service runs — restricted/expert-led rooms read 404 (never 403) for
signed-out users and pending applicants. The same bar also holds on the
DISTRIBUTION side: every pool is filtered through
`roomContentVisibleToUser` per distinct room (batched; unknown rooms fail
closed), so restricted-room content never leaks into public front-page or
topic feeds either. The pipeline serves whenever any real story exists;
with an EMPTY store (fresh dev boot, contract tests) the legacy WS-C demo
fixture serves unchanged — clearly fixture data, outside the pipeline, no
decision log. Feeds are public; a valid session personalizes them
(optional session resolution degrades to anonymous on any failure, never
to an error).

**Pagination (seen-aware re-rank).** Every feed surface paginates with
`?cursor=<previous page's request_id>`: the next page re-runs the FULL
pipeline excluding everything that page chain already served (each
decision log links its `parent_request_id`; the walk is bounded at 20
pages). Each page is its own replayable decision; `nextCursor` is the
current request id while unserved feasible items remain, null when the
feed is exhausted. Ordering may shift between pages as live signals
update — honest, since ranking is live. Unknown or retention-swept
cursors serve the first page (clients recover, never an error), and the
chronological fallback paginates with the same semantics, so deep scroll
keeps working while ranking is paused.

## Candidate generation (WS-I.1)

The eight retrievers (`apps/api/src/ranking/retrievers.ts`) implement
`CandidateRetriever` over the read-only `CandidateDataPorts` seam:

| Origin | Source type | Strategy |
|---|---|---|
| `subscribed_rooms_v1` | subscribed_room | Recent threads of the user's ACTIVE room subscriptions |
| `local_news_v1` | local_news | Country-scoped stories matching the user's own configured locale region (never device location) |
| `global_pwatt_v1` | global | PWAtt component threshold (never engagement counts); fresh uncovered stories enter at a LOWER cold-start score |
| `emerging_discussions_v1` | emerging_discussion | CONSTRUCTIVE velocity (correction/bridge counts in the latest 24h window), never raw volume |
| `independent_additions_v1` | independent_source_addition | Previously-seen stories (the user's OWN attention rows) that gained sourced comments since last seen |
| `cross_community_bridges_v1` | cross_community_bridge | SCOI split/obstructed stories, carrying `bridge_context` metadata |
| `expert_explanations_v1` | expert_explanation | Expert-led-room threads (public rooms with the experts_and_stewards posting policy) |
| `chronological_catch_up_v1` | chronological_catch_up | Recent unseen items in time order, respecting the per-room last-seen mark |
| `room_surface_v1` | subscribed_room | Room-surface scoper: the requested room's recent threads (inert outside room feeds — the eight ORGANIC front-page sources remain exactly SPEC §13.2's) |

Hidden (takedown/safety) and archived stories never retrieve. Quotas
(WS-I.1.1b) reserve `ceil(pct × budget)` slots per class — fresh ≥ 15%,
independent ≥ 20% (not a confirmed syndication copy), local ≥ 10% when a
local signal exists — by swapping in the best class members for the
lowest-ranked EVICTABLE selected items. Protection is JOINT: an item is
evictable only when removing it breaks no class's reservation, so filling
one class can never re-create a shortfall in a class satisfied earlier.
Shortfalls degrade gracefully and are logged per quota with the request id;
quota outcomes always report the target with an `applicable` flag (a
non-binding local quota is observably distinct from a real shortfall).

## Feature store (WS-I.2.1)

`ranking_feature_vectors` is APPEND-ONLY revision history per item:
`(item_id, revision)` is the primary key, optimistic concurrency rejects
stale writers (the in-memory adapter by comparison, the Drizzle adapter by
PK collision), and the decision log pins the exact revision each feasible
item was scored at — replay reads the snapshot byte-for-byte. The strict
WS-I.2.1a schema (closed field set; every invariant field OPTIONAL — a
degraded output is an ABSENT feature, never a fabricated zero) and the
WS-I.2.1b denylist run inside `upsert` on BOTH adapters; there is no
privileged write path.

Population (WS-I.2.1d): the durable `ranking-feature-store` router consumer
refreshes a story's vector on every story/thread-target
`invariant.run.completed` AND on `integrity.signal.detected` (the MFCI
INTAKE path writes risk states directly without a run event — the "<5s for
MFCI state changes" freshness target holds only if those transitions
refresh features too; the consumer is non-scoring and reads only target
ids); the hourly batch path covers recent stories and the stalest stored
vectors, and logs the invariant-version distribution
(`ranking.feature.invariant_versions`) plus the oldest-unrefreshed
staleness needle (`ranking.feature.staleness`). Field provenance is
documented in `packages/ranking/src/schemas/feature-vector.ts`; the
`invariant_versions` map (version string, computation timestamp, config
hash) makes every contributing invariant auditable (WS-I.2.1c), and the
steward surface exposes `GET /v1/ranking/admin/features/:itemId[?at=ISO]`
(latest or by-timestamp snapshot via `featureStore.getAt`).
`topic_relevance` is the ONE per-request field: it is resolved from the
requesting user's own interests at serve time and never persisted in the
shared store.

Two derived fields deserve their formulas:

- **`duplicate_cluster_id`** is the minimum story id over the
  near-duplicate CONNECTED COMPONENT containing the story, discovered by a
  bounded breadth-first expansion over MinHash hits (hits-of-hits included,
  capped at 32 nodes / 16 hits per node / Jaccard ≥ 0.7) — chains A↔B↔C
  share ONE key even when A and C are not mutual hits (min-over-direct-hits
  split such chains and under-capped them). Exact matroid classes remain
  MERI's concern; this key only feeds the per-page cluster cap.
- **`source_reliability`** uses exactly the aggregates the WS-F §14.3
  source profile carries: `clamp01(0.5 · 1/(1+corrections/10) ·
  1/(1+notes/8))` — gentle dampening for correction FREQUENCY (the §14.3
  record has no acknowledgment field; corrections are partly a transparency
  virtue) and community notes.  (The former evidence-type-diversity and
  summary-citation bonuses were removed as never-fed inputs.)  No history ⇒
  exactly the neutral 0.5.

## Scoring (WS-I.2.3)

The §5.4 formula, exactly:

```
PWAtt = B + (wA·A + wP·P + wE·E + wS·S + wC·C) / 100
          − pM·coordination − pT·harmful_tension − pR·redundancy
```

There is no per-item `pH·holonomy` penalty: PHI (holonomy) is a per-**user**
signal, not a per-item property, so it enters ranking only as the per-user
`holonomy_limits` diversification constraint (see PHI diversification below),
never a per-item penalty. (The earlier per-item `pH` term read a `phi_risk`
feature the assembler never populated — it was structurally always 0 — and was
removed. **PHI-v1 residual:** if a genuine per-item holonomy contribution is
ever wanted, define a per-`(user, item)` signal and reintroduce the term; until
then PHI's ranking effect is diversification only.)

- **Profiles (WS-I.2.3f).** `breaking_news` (wA at its 30% cap, 6h breaking
  half-life) and `evergreen` (wP at its 40% cap — the conservative default
  for everything else, including all sensitive topics, room feeds, elevated
  risk, and minors). Weights validate through the SAME §5.5 guardrail code
  WS-E uses (`validateRankingProfile` — integer percents, in-range, summing
  to exactly 100); the loader refuses the WHOLE set on any invalid profile;
  profiles are versioned and snapshot-tested; runtime additions go through
  the validated `ranking.profiles` config key (422 at write time).
- **Baseline (WS-I.2.3d).** A convex combination of exponential half-life
  freshness, Licio-internal source reliability (the formula above — never
  external popularity, never a truth score), and topic relevance (the
  user's own interests; EXCLUDED with weights renormalized when
  personalization is off). The part weights are PROFILE-CONFIGURED
  (`baseline_weights`, integer percents summing to exactly 100, validated
  like the §5.5 weights): evergreen keeps the historical 50/30/20,
  breaking_news weights timeliness at 60/25/15. The field is schema-
  DEFAULTED to 50/30/20 so decision-log profile snapshots written before it
  existed still parse — and replay with identical arithmetic. A brand-new
  item has a nonzero baseline.
- **Penalties (WS-I.2.3b).** pM = max(MFCI risk ladder normal 0 → severe 1,
  tropical synchronized fraction) — max, never sum, the same evidence must
  not double-count; enforcement follows the DOMINATING evidence source,
  with inclusive comparison so an exact tie enforces when EITHER tied
  source is promoted; pH = PHI magnitude over the profile threshold, with
  the threshold SHRUNK by `phi_sensitive_factor` on sensitive topics; pT
  reads ONLY the Hodge `harmful_tension_risk` field, which is zero by
  construction absent a hostility signal — sustained legitimate
  disagreement can never be penalized; pR = the MERI redundancy hook. All
  four are nonnegative; enforced penalties can drive a total below zero.
- **Constraints (WS-I.2.3c).** MFCI at/above the profile state excludes
  cross-community distribution + flags review; SCOI medium attaches the
  divergence flag (always — it feeds the context-gate counter), high
  reduces cross-community distribution by the
  profile multiplier, very-high pauses pending review (room-internal reads
  stay feasible); PHI above threshold diversifies the REQUESTING USER's
  feed (topic caps halve) — the per-user input is the MAX holonomy over the
  user's recent session buckets (7-day window, ≤ 8 buckets; a single-latest
  read missed older high-holonomy sessions); the GWEI deployment gate
  blocks a profile whose recent cohort disparity exceeds its threshold
  (serving falls back, logged `gwei_gate`). The gate input is a targeted
  recency-windowed read (`ranking.scalars.gwei_gate_window_hours`, default
  168h; never a table scan), SKIPS k-anonymity-suppressed rows (withheld ≠
  zero ≠ infinite), and is TTL-cached for 60s (non-null results only —
  caching the negative would delay the gate's first engagement; reload
  clears it). A tripped gate can keep ranked serving ONLY under the
  documented-owner override (`ranking.gwei_override`: owner, reason,
  expiry — SPEC §9.5), which logs loudly and counts
  (`ranking.gwei_gate.overridden`) on every affected request and stops at
  expiry. The optimizer operates only within the feasible set.

Determinism is load-bearing: `rankFeasibleSet` reads no clock and no
randomness, ties break on (score, feature-pinned freshness, item id), and
serving + replay execute the same function — identical inputs give
byte-identical output.

## Decision logs and replay (WS-I.2.5)

One `RankingDecisionLog` per served request: `request_id` (+
`parent_request_id` linking the pagination chain — null on first pages,
defaulted so pre-pagination logs parse), the anonymized
`user_privacy_bucket` (a 256-cohort keyed hash, shaped `bucket:<2 hex>` or
`anonymous`; the zod refinement AND a db CHECK reject identifier-shaped
values), candidate/selected ids, full per-selected-item score and penalty
breakdowns, feature revisions for every FEASIBLE item, the invariant
version map, every constraint application with its `enforced` flag, safety
exclusions with policy reasons, quota outcomes (target always reported,
with the `applicable` flag), explanation template ids, experiment ids, the
profile id/version, and `replay_inputs` (the exact profile snapshot, the
promotion-enforcement flags in force, per-item resolved topic relevance —
the user's interest LIST is never persisted — the user PHI input, any
feed-mode balancing override, and the per-item LENS assignments room
surfaces ranked with: each item's lens is the most frequent `lens_id`
among its thread's lens-tagged contributions, ties lexicographic, so lens
balancing is deterministic and replayable). Retention is 180–365 days
(§22.4), clamped, enforced by the hourly sweep AND the `retain_until`
column. Decision-log queries paginate by TRUE SQL keyset — the cursor
row's `(timestamp, request_id)` keys a composite-row comparison with a
LIMIT, so a page costs the same at any table depth (measured by the
RUN_PERF benchmark).

`replayDecision(services, requestId)` re-executes the pure core at the
recorded feature revisions, profile snapshot, enforcement flags, and the
logged timestamp, and returns a structured diff (`item_id`,
`expected_position`, `actual_position`, `score_diff`). Fallback decisions
verify structural invariants (selection ⊆ pool − exclusions, no
duplicates). The scheduler replays a configurable sample each tick and
counts mismatches (`ranking.replay.regression_mismatch`) — the
post-deploy regression detector.

The steward surface (`/v1/ranking/admin/*`, steward + per-session MFA):
decision queries on all six audit dimensions (time, privacy bucket, item,
invariant name/version, constraint, experiment; keyset-paginated), decision
detail, replay, the kill switch, validated config writes (422), profiles,
and health. Every decision-log read is itself audited
(`ranking_decision_query` — the WS-I.2.5c meta-audit), as are replays,
kill-switch changes, and config writes.

## Explanations and the client surface (WS-I.2.6)

Every served item carries a `distribution_reason` rendered from a
registered, parameterized template (free-form strings cannot reach the
wire); the FEED CARD (`StoryCard`) renders it. The story DETAIL page
deliberately omits the per-item reason and the source/provenance line —
readers inspect their OWN Signal Ledger from their profile
(`/profile/signal-ledger`); §13.5 explanations remain inspectable, never
vague. Room counts are only claimed when genuinely
multi-room (the single-room evidence variant makes no count claim). The
renderer is LOCALIZATION-READY: `renderTemplate(id, params, locale)`
guards prohibited language on the canonical English rendering (the
§13.6/§30.6 vocabulary is English doctrine), then localizes — the
`x-pseudo` pseudo-locale is the standard two-language readiness proof
(every template renders distinctly in both locales with parameters
intact), and real translation catalogs slot into `LOCALE_CATALOGS`
without touching any template. Serving currently fixes `en`.

Two §23.3 wire fields carry the diversification/context outputs:

- **`more_on_this_story`** — the demoted same-cluster sibling ids on the
  cluster representative (WS-I.2.4a; the "+N more on this story" chip),
  bounded at 12.
- **`context_card`** — the compact SCOI card (WS-I.2.4c) on items flagged
  `scoi_context_card`: the SCOI level, lens count from the stored row,
  open bridge attempts, and the "Where interpretations differ" pointer.
  Cards are built from STORED rows only — never computed on request.
- **`sources_count` + `corrections`** — the §5.6 story-card signals,
  derived by the single shared `storyCardSignals`
  (`apps/api/src/forum/card-signals.ts`, also used by the story-detail read
  so the surfaces agree by construction): the published sourced-comment
  count (comments with ≥1 citation — the same count as the comment
  section's "Sources" view) and the WS-T corrections tally for the comment
  section (`active` live comment arenas / `validated` / `incorrect` tagged
  rows, published-only). The story's OWN posture rides `dispute_status`
  separately, so one debate is never double-reported. The serve path batches
  the counts per page (one grouped contribution-tally read + one grouped
  live-arena read through `cardSignalCounts` / `countActiveCommentArenas`) —
  never per-item round trips; the WS-I.4.1b fallback serves the same honest
  signals. (These replaced the former §5.6 `rating_label` prose cascade —
  removed with the story-card signal redesign; the earlier `well-sourced`
  label had already been removed with the EvidenceCard entity. The served
  SCOI divergence volume still increments the `ranking.context_gate.card`
  counter via `recordInterpretationDivergence`.)
- **`safety_state`** — the §22.1 reader-facing safety posture, derived by the
  single shared `deriveStorySafetyState` (feed + story-detail), strongest
  first: a thread under an active §18.3 RESTRICTION is `restricted`
  (access-limited content, not merely flagged); a frozen item or high/severe
  MFCI risk is `under-review`; an elevated MFCI/thread signal is `caution`;
  otherwise `ok`. Descriptive, never a sanction. The thread §15.4 safety
  machine's terminal `restricted` state reaches the wire `restricted` posture
  (it never silently collapses to `ok`); the card renders any review/restricted
  posture as the descriptive "Under review" chip.

## Kill switch and fallback (WS-I.4)

The kill switch is a RUNTIME control in the shared config store
(`ranking.killswitch`): graduated scopes (global / per-surface /
per-profile), §30.8 release-card fields (owner, trigger condition, rollback
path, review date) required on engage, audited engage/release, effective on
the next request with no deployment. An UNREADABLE stored state fails
closed to the fallback. The safe fallback ranker serves strictly
chronological order over the SAFETY-FILTERED set (the filter is never
bypassed), applies no PWAtt and no personalization, attaches the honest
"Shown in time order while ranking is paused." explanation (the
user-chosen chronological mode gets "as your feed mode requests"), and
still writes a `fallback: true` decision log. Neutrality test 1 runs
against the fallback too.

## The neutrality suite (WS-I.3)

`apps/api/src/__tests__/ranking-neutrality.test.ts`; `pnpm
check:neutrality` runs it as a named CI step on every PR. WS-L/WS-M do not
exist yet, so financial state is synthesized through the same stores and
event log the real modules will use (wallet credentials via the WS-D store;
`wallet.linked` / `payment.receipt.indexed` rows in the durable event log
with the crypto flag ON) — this suite is the harness the §30.6 staging
events plug into before any real-funds pilot.

| # | Test | Mechanism |
|---|---|---|
| 1 | Wallet-link feed equivalence | Two identical users, one wallet-linked with payment events: byte-identical items, scores, and reasons on the front-page, topic, AND room surfaces (a shared public room with content), and under the fallback; candidate sets identical |
| 2 | Payment amount absent from schemas | Deep field walk (`collectZodFieldNames`) over candidate/feature/scored/profile/decision-log schemas against the shared denylist |
| 3 | Donor identity absent from joins | The TRANSITIVE import closure of the whole ranking layer (every file under `src/ranking` is a root; relative imports walked to a fixpoint) contains no financial module by file path or specifier + identical feature vectors for items whose only difference is the submitter's wallet state |
| 4 | Treasury balance neutral | A side-channel treasury map flips between items: identical signatures (no read path exists; the db BFS isolation + table denylist close the schema layer) |
| 5 | Votes cannot relabel claims | A governance-outcome event in the durable log changes no claim status — AND a schema-valid `governance.proposal.executed` published through the LIVE router (crypto flag on, ranking consumers registered) reaches no claim and no feature vector; the steward path still works |
| 6 | Paid status bypasses nothing | Identical rate-limit decisions, identical safety filtering, for wallet-linked vs not; no membership read in any safety/ranking path |
| 7 | ML feature audit | Adding `wallet_balance_usd` to the feature field set fails the audit naming the field + pattern; the write boundary rejects the same vector |
| 8 | Sponsored content excluded | The organic source-type enum is closed (no `sponsored`); forged candidates fail the stage boundary; served origins come from the closed registry (eight organic + the room scoper), none financial |
| 9 | Payments never framed as endorsements | The shared prohibited-language artifact (also enforced at template render) scans every template and the web i18n catalog's payment-adjacent lines |
| 10 | Dashboard separation | Every product-health metric name (events + ingestion registries) passes the financial-name check, and the ACTUAL admin health payload is fetched and deep-walked — a financial dimension added to it fails without updating any hard-coded list |

Complementary structural controls: `ranking_feature_vectors` and
`ranking_decision_logs` are in the WS-F.2.5b table denylist
(`packages/db/src/content-schema-check.ts`) and are BFS targets of the
wallet↔ranking isolation proof (`packages/db/src/isolation.ts`).

## Configuration (fail-closed)

`ranking.scalars` (decision-log retention 180–365d, replay sample size,
feature batch limit/staleness, the GWEI-gate recency window
`gwei_gate_window_hours`), `ranking.profiles` (a FULL validated profile
set — all-or-none), and `ranking.gwei_override` (the documented-owner gate
override: `until` expiry, `owner`, `reason`; an unreadable stored override
does NOT override — fail closed) live in the shared runtime-config store.
Invalid stored values are logged and the reviewed defaults kept; the
steward write endpoint rejects invalid values with 422 before they land.
The kill-switch state lives under `ranking.killswitch` (see above).

## Scheduler

`startRankingScheduler` ticks hourly under the `ranking_hourly` Postgres
job lease (at most one executor per window; crashed holders self-heal):
config reload, feature-store batch refresh, the §22.4 decision-log sweep,
the replay-regression sample (which also verifies every logged explanation
template id still exists in the registry — a removed/renamed template
would silently orphan served reasons), and the feature-staleness needle
(the oldest unrefreshed vector's age). Task failures are isolated per
task.

## Observability

`candidate.retrieval.completed` / `candidate.retrieval.gap` (both carrying
per-retriever `duration_ms`) / `candidate.quota.evaluated` /
`candidate.pool.assembled` (privacy bucket, never a user id),
`ranking.profile.selected` (which profile/version served each request),
`feature.store.updated` / `feature.store.batch.completed` /
`ranking.feature.invariant_versions` (the version distribution populating
production vectors — a stalled rollout shows as a version that never gains
share) / `ranking.feature.staleness`, `ranking.safety_filter.applied`,
`ranking.decision.logged` (+ the §21.3 event per selected item),
`ranking.fallback.served`, `ranking.killswitch.changed` /
`ranking.killswitch.unreadable`, `ranking.replay.completed` /
`ranking.replay.regression`, `ranking.config.rejected` /
`ranking.config.changed`, `ranking.gwei_gate.overridden`, the
`ranking.context_gate.card` / `.reduced` / `.paused` counters (the volume
feeding the bridge/expert-queue dashboard), the
`ranking.explanation.unknown_template` counter, and the
`ranking.decision_log.write_failed` incident counter.

## Testing

| Suite | Location | Covers |
|---|---|---|
| Pure domain (7 files, 124 tests) | `packages/ranking/src/__tests__/` | Denylist patterns (nested/camel/case) + the versioned-artifact pinning, strict schemas + field-name snapshot, §5.5 guardrail property fuzzing + baseline-weight validation + legacy-snapshot defaults, §5.4 exact arithmetic + configurable baseline weights, penalty derivations (tension-without-hostility ≡ 0, sensitive strictness, negative totals, shadow non-application, inclusive-tie enforcement), constraint ladders, dedup/balancing properties, template rendering + prohibited-language structural block + the x-pseudo localization proof, pipeline determinism, replay diff |
| Candidates | `apps/api/src/__tests__/ranking-candidates.test.ts` | All eight organic retrievers against seeded stores, quota reservation/degradation + JOINT class protection, orchestrator merge/failure-isolation/budget, the closed 9-origin registry |
| Pipeline | `apps/api/src/__tests__/ranking-pipeline.test.ts` | Feature store semantics, assembly provenance (incl. pre-lift shadow rows staying powerless), the real-time consumer, the non-overridable safety filter, end-to-end serving (ranked + every fallback reason), replay exactness/pinning/diffs, config, the admin surface, the scheduler |
| Surfaces | `apps/api/src/__tests__/ranking-surfaces.test.ts` | The room feed route (WS-G visibility 404s, room-scoped pool, REAL lens balancing pinned + replayed), the distribution-side room-visibility bar (restricted content never on public feeds), seen-aware pagination (chain coverage/no-duplicates/replay, unknown-cursor recovery, fallback + room-route paging), the topic surface (scoping + sensitivity-driven profile), the wire fields (context_card, more_on_this_story), GWEI gate semantics (window, suppression, TTL cache, owner override), the MFCI intake-path refresh at the 100-target bound, audit-write outage resilience, near-duplicate CHAIN clustering (exact hand-crafted signatures), replay backward-compatibility for pre-baseline_weights logs, /v1/feed stability under the kill switch |
| Branch edges | `apps/api/src/__tests__/ranking-branches.test.ts` | Audit-dimension queries, per-key config, MERI/tropical/cluster joins, PHI/GWEI helpers, lease behavior, mapping variants, fail-closed paths |
| Neutrality | `apps/api/src/__tests__/ranking-neutrality.test.ts` | The ten WS-I.3 tests |
| Gated integration | `apps/api/src/__tests__/ranking-integration.test.ts` | Drizzle adapters against the REAL migration chain (PK-collision concurrency, jsonb audit-dimension queries, retention sweep, the privacy-bucket CHECK, DISTINCT ON `getLatestMany`, by-timestamp `getAt`, TRUE keyset pagination with same-timestamp tie-breaks, `listByTypeSince`, bulk safety/story/thread reads); runs in CI's service containers |
| Performance (RUN_PERF) | `apps/api/src/__tests__/ranking-performance.test.ts` | The pure core at a 10 000-candidate stress pool (p99 budget + byte-identical determinism across runs) and decision-log point/keyset latency at depth against live Postgres — measured operating points recorded, never run in CI |
| Client | `apps/web/src/routes/-pages/stories.test.tsx` | The story page embeds the WS-G.3.3 inline comment section when the story carries a thread and omits it otherwise, inside a real (memory-history) router (the per-item distribution reason, the source line, and the inspect-signals link were removed from the DETAIL page — signals are inspected from the profile) |

## Residuals (tracked elsewhere)

- **WS-J** replaces the default `ModerationStateProvider` behind the same
  interface (moderation cases, steward holds, the hostility signal Hodge's
  pT consumes) and owns coordinated-reporting detection.
- **WS-N** supplies the jurisdiction engine behind the existing
  `legallyRestrictedIn`/selector seams (defaults: no legal restrictions).
- **WS-K** supplies governed topic classification (topic balancing
  currently uses WS-F story topic ids) and learned relevance.
- **WS-L/WS-M** plug real staging wallet/payment/treasury/membership events
  into the neutrality harness (§30.6 requires the suite green with real
  payment events in staging before any real-funds pilot); sponsored
  surfaces and their labeling land there, quarantined from organic
  retrieval by the closed enum.
- **WS-P** wires experiment ids into decision logs (the field exists),
  owns the GWEI gate's experiment-framework integration, and the
  BFF-in-the-loop browser E2E for the ranked feed.
- A first-class user location preference (WS-D) can replace the coarse
  locale-region matching in the local-news retriever behind the same port.

## WS-Q deltas — two-tier visibility containment

WS-Q makes content visibility a first-class ranking input — as a NON-SCORING
eligibility field, never a score:

- **`Candidate.visibility` / `FeatureVector.visibility`** carry the item's
  `public | room_only` tier. The scoring stage ignores it (a property test
  proves flipping it changes neither order nor scores); legacy feature
  snapshots and decision logs default to `public` so pre-WS-Q decisions replay
  unchanged.
- **Visibility-scoped retrievers.** The eight organic retrievers apply the
  two-condition global predicate `story.visibility = 'public' AND room.visibility
  = 'public'` (`globallyRetrievable`), so a `room_only` item — or a
  transiently-mislabeled public item in a private room — appears in NONE of
  them, and even a user's own subscribed private-room content stays off the
  public front page. `RoomSurfaceRetriever` serves the room's full pool.
- **`filterByVisibility`** (renamed from `filterByRoomVisibility`) is the
  authoritative ALWAYS-ON distribution gate, applied to the surface pool BEFORE
  the ranked/fallback split so both inherit identical containment. On
  `front_page`/`topic` it drops anything not public-from-a-public-room; on
  `room` it keeps the room's pool behind the content bar and drops foreign-room
  `room_only`. An unknown room fails closed. Drops are reason-coded
  (`item_visibility` / `room_private_on_global` / `room_bar`) and the count
  rides the `RankingDecisionLog.visibility_excluded_count`.
- **`check:neutrality` containment leg** (tests 11–13): in-room content never
  reaches a global surface (ranked OR fallback), private-room content is absent
  from a non-member's every surface, widen/narrow flips eligibility, visibility
  is not a ranking signal, and every global retrieval path routes through the
  gate. The financial denylist + wallet↔ranking BFS isolation stay green on the
  new `visibility` columns.

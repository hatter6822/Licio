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
   (observable, never a hidden sanction). The SCOI context card is the one
   deliberate exception: it is informational ("Needs Context" never means
   false), so it attaches regardless of promotion state.

## Architecture

| Layer | Location | Contents |
|---|---|---|
| Pure domain logic | `packages/ranking/src/` | Deterministic, I/O-free stage functions: the §5.4 scoring arithmetic, penalties, constraints, matroid dedup, balancing, explanation templates, the pipeline core, the replay diff — plus the strict stage-boundary zod schemas and the denylist |
| Services | `apps/api/src/ranking/` | Stores (+ Drizzle adapters), the eight retrievers, quotas, the candidate orchestrator, the feature population pipeline, the safety filter (WS-J seam), the feed service + replay, the kill switch, fail-closed config, the lease-guarded scheduler |
| Routes | `apps/api/src/routes/ranking-admin.ts`, the feed handler in `routes/v1.ts` | Steward audit/replay/kill-switch/config surface; `GET /v1/feed` |
| Tables | `packages/db/src/schema/ranking.ts` (migrations 0012/0013) | `ranking_feature_vectors` (append-only revisions), `ranking_decision_logs` (one per request, §22.4 retention) |
| Neutrality suite | `apps/api/src/__tests__/ranking-neutrality.test.ts` | The ten WS-I.3 tests (`pnpm check:neutrality`) |

Workspace boundary: `@licio/ranking` depends on `@licio/shared` and
`@licio/invariants` only — NEVER `@licio/db` (the ranking math has no
database access by construction; `pnpm check:workspace-deps` enforces it).

## The eight stages (SPEC §13.3)

```
serveFeed(services, { userId, surface, surfaceRoomId, mode })
  1. candidate generation   assembleCandidatePool: all eight retrievers via
                            Promise.allSettled (a failing retriever is
                            skipped + gap-logged, never fatal), merge/dedup
                            by item id (origins merged, max retrieval score
                            kept), diversity quotas, budget, zod boundary
  2. feature join           featureStore.getLatestMany + cold-start
                            write-through (every scored revision is stored,
                            so every decision replays) + per-REQUEST topic
                            relevance resolved from the user's own
                            configured interests
  3. safety filter          applySafetyFilter (authoritative, BEFORE
                            scoring): removals, integrity removals, thread
                            restriction, age gating, jurisdiction seam;
                            scoring has no re-admission path (asserted)
  4. constrained scoring    rankFeasibleSet: baseline + §5.4 positive
                            combination − promotion-gated penalties;
                            per-item constraints (MFCI/SCOI) evaluated once
  5. diversification        MERI cluster cap (default 2/page, demoted items
                            stay available for expansion), source ≤ 15% /
                            topic ≤ 25% caps with graceful degradation,
                            lens representation, PHI tightening
  6. decision logging       EXACTLY one RankingDecisionLog per served
                            request (ranked and fallback alike) + one
                            `ranking.decision.logged` event per selected
                            item; a failed write is a loudly-counted
                            auditability incident, never a serving failure
  7. explanations           highest-priority template from the item's REAL
                            signal profile; constraint/safety slowing
                            reasons outrank positive ones; prohibited
                            phrasings are structurally impossible
  8. feed response          §23.3 FeedItem mapping + `request_id` on the
                            wire (`feedResponseSchema`)
```

`GET /v1/feed` serves the pipeline whenever any real story exists; with an
EMPTY store (fresh dev boot, contract tests) the legacy WS-C demo fixture
serves unchanged — clearly fixture data, outside the pipeline, no decision
log. The feed is public; a valid session personalizes it (optional session
resolution degrades to anonymous on any failure, never to an error).

## Candidate generation (WS-I.1)

The eight retrievers (`apps/api/src/ranking/retrievers.ts`) implement
`CandidateRetriever` over the read-only `CandidateDataPorts` seam:

| Origin | Source type | Strategy |
|---|---|---|
| `subscribed_rooms_v1` | subscribed_room | Recent threads of the user's ACTIVE room subscriptions |
| `local_news_v1` | local_news | Country-scoped stories matching the user's own configured locale region (never device location) |
| `global_pwatt_v1` | global | PWAtt component threshold (never engagement counts); fresh uncovered stories enter at a LOWER cold-start score |
| `emerging_discussions_v1` | emerging_discussion | CONSTRUCTIVE velocity (evidence/correction/synthesis/bridge counts in the latest 24h window), never raw volume |
| `independent_additions_v1` | independent_source_addition | Previously-seen stories (the user's OWN attention rows) that gained evidence since last seen |
| `cross_community_bridges_v1` | cross_community_bridge | SCOI split/obstructed stories, carrying `bridge_context` metadata |
| `expert_explanations_v1` | expert_explanation | Expert-led-room threads + threads with a human summary layer |
| `chronological_catch_up_v1` | chronological_catch_up | Recent unseen items in time order, respecting the per-room last-seen mark |

Hidden (takedown/safety) and archived stories never retrieve. Quotas
(WS-I.1.1b) reserve `ceil(pct × budget)` slots per class — fresh ≥ 15%,
independent ≥ 20% (not a confirmed syndication copy), local ≥ 10% when a
local signal exists — by swapping in the best class members for the
lowest-ranked non-members; shortfalls degrade gracefully and are logged per
quota with the request id.

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
`invariant.run.completed`; the hourly batch path covers recent stories and
the stalest stored vectors. Field provenance is documented in
`packages/ranking/src/schemas/feature-vector.ts`; the `invariant_versions`
map (version string, computation timestamp, config hash) makes every
contributing invariant auditable (WS-I.2.1c). `topic_relevance` is the ONE
per-request field: it is resolved from the requesting user's own interests
at serve time and never persisted in the shared store.

## Scoring (WS-I.2.3)

The §5.4 formula, exactly:

```
PWAtt = B + (wA·A + wP·P + wE·E + wS·S + wC·C) / 100
          − pM·coordination − pH·holonomy − pT·harmful_tension − pR·redundancy
```

- **Profiles (WS-I.2.3f).** `breaking_news` (wA at its 30% cap, 6h breaking
  half-life) and `evergreen` (wP at its 40% cap — the conservative default
  for everything else, including all sensitive topics, room feeds, elevated
  risk, and minors). Weights validate through the SAME §5.5 guardrail code
  WS-E uses (`validateRankingProfile` — integer percents, in-range, summing
  to exactly 100); the loader refuses the WHOLE set on any invalid profile;
  profiles are versioned and snapshot-tested; runtime additions go through
  the validated `ranking.profiles` config key (422 at write time).
- **Baseline (WS-I.2.3d).** A convex combination (0.5/0.3/0.2) of
  exponential half-life freshness, Licio-internal source reliability
  (correction acknowledgment, evidence diversity, community-note dampening
  — never external popularity, never a truth score), and topic relevance
  (the user's own interests; EXCLUDED with weights renormalized when
  personalization is off). A brand-new item has a nonzero baseline.
- **Penalties (WS-I.2.3b).** pM = max(MFCI risk ladder normal 0 → severe 1,
  tropical synchronized fraction) — max, never sum, the same evidence must
  not double-count; pH = PHI magnitude over the profile threshold, with the
  threshold SHRUNK by `phi_sensitive_factor` on sensitive topics; pT reads
  ONLY the Hodge `harmful_tension_risk` field, which is zero by
  construction absent a hostility signal — sustained legitimate
  disagreement can never be penalized; pR = the MERI redundancy hook. All
  four are nonnegative; enforced penalties can drive a total below zero.
- **Constraints (WS-I.2.3c).** MFCI at/above the profile state excludes
  cross-community distribution + flags review; SCOI medium attaches the
  context card (always), high reduces cross-community distribution by the
  profile multiplier, very-high pauses pending review (room-internal reads
  stay feasible); PHI above threshold diversifies the REQUESTING USER's
  feed (topic caps halve); the GWEI deployment gate blocks a profile whose
  latest cohort disparity exceeds its threshold (serving falls back,
  logged `gwei_gate`). The optimizer operates only within the feasible set.

Determinism is load-bearing: `rankFeasibleSet` reads no clock and no
randomness, ties break on (score, feature-pinned freshness, item id), and
serving + replay execute the same function — identical inputs give
byte-identical output.

## Decision logs and replay (WS-I.2.5)

One `RankingDecisionLog` per served request: `request_id`, the anonymized
`user_privacy_bucket` (a 256-cohort keyed hash, shaped `bucket:<2 hex>` or
`anonymous`; the zod refinement AND a db CHECK reject identifier-shaped
values), candidate/selected ids, full per-selected-item score and penalty
breakdowns, feature revisions for every FEASIBLE item, the invariant
version map, every constraint application with its `enforced` flag, safety
exclusions with policy reasons, quota outcomes, explanation template ids,
experiment ids, the profile id/version, and `replay_inputs` (the exact
profile snapshot, the promotion-enforcement flags in force, per-item
resolved topic relevance — the user's interest LIST is never persisted —
the user PHI input, and any feed-mode balancing override). Retention is
180–365 days (§22.4), clamped, enforced by the hourly sweep AND the
`retain_until` column.

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
| 1 | Wallet-link feed equivalence | Two identical users, one wallet-linked with payment events: byte-identical items, scores, and reasons on every surface AND under the fallback; candidate sets identical |
| 2 | Payment amount absent from schemas | Deep field walk (`collectZodFieldNames`) over candidate/feature/scored/profile/decision-log schemas against the shared denylist |
| 3 | Donor identity absent from joins | Import-graph scan of every ranking module (no financial module import) + identical feature vectors for items whose only difference is the submitter's wallet state |
| 4 | Treasury balance neutral | A side-channel treasury map flips between items: identical signatures (no read path exists; the db BFS isolation + table denylist close the schema layer) |
| 5 | Votes cannot relabel claims | A governance-outcome event in the log changes no claim status; the steward path does |
| 6 | Paid status bypasses nothing | Identical rate-limit decisions, identical safety filtering, for wallet-linked vs not; no membership read in any safety/ranking path |
| 7 | ML feature audit | Adding `wallet_balance_usd` to the feature field set fails the audit naming the field + pattern; the write boundary rejects the same vector |
| 8 | Sponsored content excluded | The organic source-type enum is closed (no `sponsored`); forged candidates fail the stage boundary; served origins come from the eight-member registry |
| 9 | Payments never framed as endorsements | The shared prohibited-language artifact (also enforced at template render) scans every template and the web i18n catalog's payment-adjacent lines |
| 10 | Dashboard separation | Every product-health metric name (events + ingestion registries, the admin health fields) passes the financial-name check |

Complementary structural controls: `ranking_feature_vectors` and
`ranking_decision_logs` are in the WS-F.2.5b table denylist
(`packages/db/src/content-schema-check.ts`) and are BFS targets of the
wallet↔ranking isolation proof (`packages/db/src/isolation.ts`).

## Configuration (fail-closed)

`ranking.scalars` (decision-log retention 180–365d, replay sample size,
feature batch limit/staleness) and `ranking.profiles` (a FULL validated
profile set — all-or-none) live in the shared runtime-config store.
Invalid stored values are logged and the reviewed defaults kept; the
steward write endpoint rejects invalid values with 422 before they land.
The kill-switch state lives under `ranking.killswitch` (see above).

## Scheduler

`startRankingScheduler` ticks hourly under the `ranking_hourly` Postgres
job lease (at most one executor per window; crashed holders self-heal):
config reload, feature-store batch refresh, the §22.4 decision-log sweep,
and the replay-regression sample. Task failures are isolated per task.

## Observability

`candidate.retrieval.completed` / `candidate.retrieval.gap` /
`candidate.quota.evaluated` / `candidate.pool.assembled` (privacy bucket,
never a user id), `feature.store.updated` / `feature.store.batch.completed`,
`ranking.safety_filter.applied`, `ranking.decision.logged` (+ the §21.3
event per selected item), `ranking.fallback.served`,
`ranking.killswitch.changed` / `ranking.killswitch.unreadable`,
`ranking.replay.completed` / `ranking.replay.regression`,
`ranking.config.rejected` / `ranking.config.changed`, and the
`ranking.decision_log.write_failed` incident counter.

## Testing

| Suite | Location | Covers |
|---|---|---|
| Pure domain (7 files, 114 tests) | `packages/ranking/src/__tests__/` | Denylist patterns (nested/camel/case), strict schemas + field-name snapshot, §5.5 guardrail property fuzzing, §5.4 exact arithmetic, penalty derivations (tension-without-hostility ≡ 0, sensitive strictness, negative totals, shadow non-application), constraint ladders, dedup/balancing properties, template rendering + prohibited-language structural block, pipeline determinism, replay diff |
| Candidates | `apps/api/src/__tests__/ranking-candidates.test.ts` | All eight retrievers against seeded stores, quota reservation/degradation, orchestrator merge/failure-isolation/budget |
| Pipeline | `apps/api/src/__tests__/ranking-pipeline.test.ts` | Feature store semantics, assembly provenance (incl. pre-lift shadow rows staying powerless), the real-time consumer, the non-overridable safety filter, end-to-end serving (ranked + every fallback reason), replay exactness/pinning/diffs, config, the admin surface, the scheduler |
| Branch edges | `apps/api/src/__tests__/ranking-branches.test.ts` | Audit-dimension queries, per-key config, MERI/tropical/cluster joins, PHI/GWEI helpers, lease behavior, mapping variants, fail-closed paths |
| Neutrality | `apps/api/src/__tests__/ranking-neutrality.test.ts` | The ten WS-I.3 tests |
| Gated integration | `apps/api/src/__tests__/ranking-integration.test.ts` | Drizzle adapters against the REAL migration chain (PK-collision concurrency, jsonb audit-dimension queries, retention sweep, the privacy-bucket CHECK); runs in CI's service containers |

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

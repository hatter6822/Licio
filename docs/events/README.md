# WS-E: Event Pipeline and PWAtt — implementation reference

This document describes the implemented WS-E surface: the event schemas and
topic registry, the hardened attention-ingestion boundary, durable storage and
real-time aggregation, retention enforcement, the consumer router with the
pay-to-rank firewall, and the PWAtt scoring engine (v0 + v1
saturation/weights/penalties — a BOUNDED ranking input since the WS-I
§30.5 lift). The design specification is SPEC §5, §19,
§21.3, §22, §25.5, and §30.5; the task plan is
`docs/planning/06-event-pipeline-and-pwatt.md`.

Two constraints govern everything here (SPEC §19.2, §30.5):

1. **Raw scroll/touch traces never leave the browser.** Every attention metric
   on the wire is a closed enum bucket; schemas are strict (unknown keys
   rejected); a dedicated test asserts the schema cannot be widened to accept
   a numeric dwell.
2. **PWAtt is a BOUNDED input, reversibly.** The §30.5 shadow stage was
   lifted by WS-I (`PWATT_V0_SHADOW_MODE = false` in `@licio/invariants` — a
   reviewed CODE change, never configuration): outputs are stored
   `shadow_mode: false` and feed the WS-I feature store under §5.5 weight
   guardrails, promotion-gated penalties, the non-overridable safety filter,
   and the runtime kill switch. The SAFE FALLBACK boundary
   (`selectRankingInputs`) still rejects every PWAtt row regardless of its
   flag, and the CI-gated equivalence tests now prove the FALLBACK ordering
   is identical with, without, and with mutated scores — so reverting the
   constant or engaging the kill switch restores the pre-lift posture
   instantly. Pre-lift rows (stored `shadow_mode: true`) stay powerless.

## Architecture

| Layer | Location | Contents |
|---|---|---|
| Schemas | `packages/shared/src/schemas/events/` | Envelope, retention tiers, 14 core topics, 18 Knomosis topics (bounded context), topic registry + discriminated union |
| Pure math | `packages/invariants/src/pwatt/` | ActiveAttention, ConstructiveParticipation, saturation curves, ranking profiles, penalties, safety-state machine, accusation classifier, ledger summaries |
| Pipeline | `apps/api/src/events/` | Stores (in-memory + Drizzle + Redis), ingestion pipeline, replay guard, sliding-window rate limiter, privacy gate, consumer router, real-time aggregation (HLL), retention sweeps, metrics |
| Scoring | `apps/api/src/pwatt/` | Window aggregation, anti-signal detectors, runtime config, the scoring job, the score-blind fallback boundary, freshness ordering v0 (the WS-I safe fallback), lease-guarded scheduler |
| Routes | `apps/api/src/routes/events.ts` + `v1.ts` | `POST /v1/events/attention`, the hardened `POST /v1/attention/aggregates` batch wire, the real owner-only `GET /v1/signal-ledger`, `contribution.created` emission |
| Tables | `packages/db/src/schema/events.ts` | `events` (LIST-partitioned by retention tier), `attention_aggregates` (§22.1 field-exact), `aggregation_windows`, `invariant_outputs` (+ shadow flag), `signal_ledger_entries`, `item_safety_states`, `pwatt_config`, `event_dead_letters`, `consumer_checkpoints` |

## Event schemas and topic registry (WS-E.1.1, WS-E.1.2)

Every topic extends one envelope (`event_id`, `event_type`, `timestamp`,
`schema_version`, `privacy_classification`, `retention_tier`) and is strict.
The registry (`TOPIC_REGISTRY`) is the single source of truth mapping all 32
topics (14 core + 18 Knomosis, exactly the SPEC §21.3 lists — drift-tested
against hardcoded copies) to schema, classification, tier, and the `knomosis`
flag. `parseEvent` (and the `licioEventSchema` discriminated union) rejects
unknown `event_type`s at the boundary.

Canonical §22.1 field-name mapping (unit-asserted): the envelope
`privacy_classification` is the ACCESS class; the persisted row's
`privacy_level` is the COLLECTION granularity (`standard`/`reduced`/`minimum`,
WS-C.4.1d); event `user_id` persists as `user_id_or_privacy_bucket` — the
coarse privacy bucket when the level is `minimum` (pseudonymized rows). For
minimum-privacy events the stored payload's `user_id` is REWRITTEN to a
constant placeholder and `owner_user_id` is null: at-rest de-linkage, which is
strictly stronger than deletion-on-request.

Knomosis topics live in a separate bounded context
(`schemas/events/knomosis/`), are NOT re-exported from the shared barrel,
carry no attention/reading/report-history field (unit-asserted), use integer
minor-unit amount strings (never floats), and never reach the client bundle
(`sideEffects: false` + a build check that wallet vocabulary is absent from
`apps/web/dist`).

Claim-status transitions are validated in-schema: nothing returns to
`unverified`, `retracted` is terminal.

## Ingestion (WS-E.1.3a-e)

Both ingestion surfaces flow through ONE pipeline
(`apps/api/src/events/ingest.ts`) with identical guards:

- `POST /v1/events/attention` — canonical single-event endpoint
  (`attention.aggregate` | `source.opened.aggregate` as a discriminated
  variant). ONLINE acceptance window: 5 minutes past / 30 seconds future.
  Responses: 202 + receipt id, 204 (privacy discard), 400 (schema/timestamp),
  401, 403 (ownership), 409 (replay), 429 + `Retry-After`.
- `POST /v1/attention/aggregates` — the WS-C client batch wire. Each §22.1
  aggregate converts into a canonical single-item event (`aggregate_id`
  becomes both event id and nonce). OFFLINE acceptance window: 7 days (the
  background-sync queue replays batches when connectivity returns, SPEC §6.9;
  7d = the `attention_raw` ceiling and the longest aggregation window). A
  replayed batch acks `accepted: 0` — idempotent retry semantics for the sync
  queue, never double-counting.

Guard order per event: session auth → per-user sliding-window rate limit
(BEFORE body validation, on both surfaces — malformed requests consume the
same budget as valid ones, so the JSON/schema path cannot be hammered for
free) → schema validation → ownership (`user_id` must equal the session
user) → timestamp window → replay nonce → server-side privacy gate → durable
insert → publish.

**Replay protection** is two-layer: a single-use nonce set (Redis `SET NX PX`,
10-minute TTL, keys carry a non-reversible account ref) plus the event store's
event-id uniqueness — the durable backstop that rejects a replayed event
forever, even after the nonce TTL (idempotency is on the event id GLOBALLY,
never per retention tier, and a replayed event's §22.1 aggregate rows are
dropped with it, never re-inserted).

**Rate limiting** (SPEC §19.1-compliant: no addresses, no raw user ids) uses
true sliding windows (timestamped ZSET entries; default 30/min + 600/h via
`EVENTS_RATE_PER_MINUTE`/`EVENTS_RATE_PER_HOUR`) with exact Retry-After math,
and FAILS CLOSED: a Redis outage degrades to an in-memory fallback at 50% of
the configured limits — never an open gate. The budget sits ABOVE the client's
30 s batched upload cadence (2/min, 120/h in steady state, WS-C.4.4) with
headroom for the page-hide replay, the post-submit drain, and concurrent
tabs/devices — the limit is per-ACCOUNT, so a budget set at exactly the cadence
spuriously 429'd legitimate readers. The client coalesces each batch and honours
`Retry-After`, so it never bursts against the gate.

**Privacy enforcement** (WS-E.1.3d) reads the user's durable WS-D settings on
every request (a mid-session change applies to the next event):
`personalization_enabled: false` ⇒ silent discard (204);
`attention_retention_preference: 'none'` ⇒ real-time only (the event row gets
a ranking-window purge deadline; no durable §22.1 row); `'minimal'` ⇒ the
90-day tier minimum; default ⇒ the 180-day maximum. The user's durable
`attention_privacy_level` is the IDENTIFICATION FLOOR (§19.2): every accepted
event is stored at the more private of the floor and the upload's claimed
level, so a buggy or compromised client claiming `standard` can never
re-identify a user who chose `minimum` (the claim can only ever strengthen
pseudonymization). EVERY enforcement decision is compliance-logged — discards
and the `none`/`minimal` retention modes alike (user id + action, never
payloads). On the client, collection itself requires an authenticated session
(the policy tracks login/logout live): signed-out readers generate no
attention data at all, so nothing is ever queued toward a 401.

Logs and metrics carry event ids, the user id, and counts ONLY — a
log-redaction test asserts no dwell/bucket/per-item field ever appears.

## Storage (WS-E.3.1)

`events` is the durable log of record, LIST-partitioned by `retention_tier`
(hand-tuned DDL in `packages/db/drizzle/0003_ws_e_events.sql`; one partition
per tier + a DEFAULT) so retention sweeps prune partitions and a partition
drop is provably complete deletion. Classification and tier are NOT NULL
enums — storage-layer defense in depth. Indexes serve the four access
patterns: deletion/export by owner, replay by (topic, timestamp), purge by
deadline, sweeps by (tier, timestamp). `attention_aggregates` matches the
SPEC §22.1 entity field-for-field. The gated integration suite recreates a
dedicated database through the real migration chain and asserts partition
routing live.

## Real-time aggregation (WS-E.3.2)

A rebuildable acceleration layer for the 1-hour window: per-item signal
counters plus HyperLogLog unique-actor estimates (own implementation in
`events/hll.ts`, m=2^14, bias-corrected with linear-counting small-range
correction, documented standard error 1.04/√m ≈ 0.81%; the Redis adapter uses
native PFADD/PFCOUNT). Every key expires after 2× the window — Redis can never
become a long-term attention store, which also closes the `none`-preference
loophole. Hourly reconciliation compares estimates against the durable
PostgreSQL aggregation within ~3σ of the HLL bound and logs discrepancies.
The layer holds no unique state: startup recovery rebuilds the live + previous
windows exactly from the durable log, and its volume counter drives the
production early-scoring trigger..

## Consumer router and the pay-to-rank firewall (WS-E.1.5, WS-E.1.2)

Events are stored first, then routed in-process to named consumers. Two
invariants are enforced at BOTH subscription and delivery time:

1. **Pay-to-rank firewall** — a Knomosis topic can never be delivered to a
   `scoring` consumer, and a scoring consumer may hold only `public` +
   `aggregated` access (so `restricted` reporter/wallet data is structurally
   out of reach of any scoring input). A security test publishes social and
   financial events and asserts no wallet/payment/amount/treasury field
   appears in anything a scoring consumer received.
2. **Classification-based delivery** — a topic is deliverable only to
   consumers holding its privacy classification.

A THIRD invariant gates the crypto plane: while the fail-closed
`cryptoEnabled` flag is off (SPEC §17.1), Knomosis topics are withheld from
EVERY consumer, however authorized (withheld deliveries are metered).

Delivery is at-least-once with consumer-side idempotency (per-consumer
event-id LRU), bounded retries, dead-lettering for poisoned events
(`event_dead_letters`, at most ONE letter per consumer+event with accumulating
attempts), and per-consumer lag/health metrics. The router reads its
dead-letter/checkpoint stores and the crypto flag THROUGH the service
container, so the production adapter swap (and a live flag flip) is honored
without rebuilding the router. DURABLE consumers checkpoint the newest
delivered event time; `recoverEventPipeline` (run at boot, and exposed to
stewards) replays them from the durable log across the
crash-between-store-and-publish window — INCLUSIVE at the checkpoint, so an
undelivered event sharing the checkpointed timestamp is never dropped (the
already-delivered one may re-deliver once; downstream intakes dedup by event
id) — and rebuilds the real-time layer exactly from the log, clearing stale
counters even when the log holds nothing. `redriveDeadLetters` retries
poisoned events after the cause is fixed and clears the queue on success. Default consumers:
`realtime-aggregation` (scoring; counters + the volume-threshold trigger,
wired in production boot to score a hot item's current 1h window early) and
`integrity-intake` (restricted-authorized, non-scoring, durable; forwards
integrity signals to the MFCI/review-queue hooks).  WS-F registers the
ingestion consumers and WS-G registers `forum-thread-posture`
(restricted-authorized, non-scoring, durable; a harassment-cascade
detection elevates the target thread's safety posture and marks the
conversation tense — `docs/forum/README.md`).

## Retention and anonymization (WS-E.1.4)

Hourly sweeps (idempotent, batched, lease-guarded):

| Sweep | Action |
|---|---|
| `attention_raw` | Delete rows past 7 days (backstop) |
| `attention_aggregated` | Delete events past 180 days (or jurisdiction override); per-owner aggregate rows ANONYMIZE (identity → privacy bucket) at the CURRENT preference's window, DELETE at the hard cap (365d) |
| `honor_preference` | Delete purge-due rows (`none` ⇒ ranking window) + expired ledger entries |
| `ranking_log` | Delete events/invariant outputs/windows past 365 days |
| `moderation review` | FLAG `moderation_legal` rows older than a year for annual human review — never auto-delete |

Jurisdiction overrides (the WS-N hook) only ever SHORTEN windows. Per-owner
settings are read in batches (`getUsersByIds`), every sweep emits a
counts-only audit record (`retention_sweep`), and
`retentionComplianceReport` is the audit query proving zero over-retained
rows — including rows past their per-user `purge_after` deadline, so a failed
preference purge is visible even inside the tier window — a WS-P.2
transparency artifact. The WS-D hooks are real: `purgeAttention` deletes
attention-TIER events + aggregates + ledger (an attention reset never touches
the user's non-attention rows: public contributions, privacy-request
records), and in account-deletion mode additionally DE-LINKS the remaining
owned rows (owner cleared, payload `user_id` pseudonymized);
`exportAttention` returns the user's COMPLETE attention data — every §22.1
aggregate row, every ledger entry (paginated, never truncated), and the owned
attention events including source-open reports; `onPrivacyChange` tightens
(never extends) existing purge deadlines when the preference changes.

## PWAtt scoring (WS-E.2)

**Aggregation (WS-E.2.1a)** folds the window's events into one deduplicated
`ActorItemSummary` per (actor, item) — buckets join by maximum, booleans by
OR — so repeated attention from one user never inflates counts (the
refresh-loop defense). Window sizes: 1h/6h/24h/7d; rows upsert into
`aggregation_windows` on the composite key; the fold is deterministic, so
re-runs converge (10k events aggregate in well under the 30s budget).
Pseudonymous actors share the single privacy-bucket actor: they can only ever
under-count.

**v0 scoring** (`@licio/invariants`, pure and total — no clock, no
randomness):

- ActiveAttention: per-actor `0.5·dwell + 0.3·source + 0.2·context` where
  dwell maps monotone bucket weights capped at 1, a bounce-only source open
  earns exactly 0 (§5.3 clickbait guardrail), and idle (`none`) earns 0; the
  item score is the saturating sum S/(S+8) ∈ [0,1).
- ConstructiveParticipation: per-actor `0.4·returns + 0.1·save + 0.5·contrib`
  with diminishing return-bucket weights, uniform v0 weights for constructive
  types and ZERO for `low_info_reply`/`flag`, the source-free-accusation
  downweight (uncited accusations keep 25% of unit weight), and
  rapid-repetition dampening (>5 contributions/window ⇒ ×0.3); item score
  T/(T+5).
- v0 score = (A+P)/2; confidence saturates with distinct actors. Property
  tests (deterministic seeded harness) pin the §30.5 invariants: scores always
  in [0,1], genuine attention never decreases a score, bounces and
  anti-signals never increase one.

**Anti-signals (WS-E.2.2)**:

- *Coordinated burst* (a): volume > multiplier × the item's own trailing-mean
  base rate (an active community has a high base rate and is never flagged for
  volume alone — SPEC §8 fairness), with a minimum-distinct-actors guard and a
  volume floor; emits `integrity.signal.detected` with monotone confidence,
  forwards to the MFCI + review-queue hooks, and applies only the v0
  placeholder participation dampening (shadow). **Account-age weighting
  (WS-O.4.5):** the detection threshold is scaled by the LOW QUANTILE (25th
  percentile) of the window actors' account-age TRUST weights (`trustWeights`, a
  bounded monotone curve, never zero — `new:0.5 … established:1.0`), so a brigade
  of disposable fresh accounts is flagged at lower volume (raising its cost)
  while an aged community is unaffected. The low quantile (not the mean) resists
  SALTING: a minority of aged accounts mixed in cannot lift the factor; evading
  needs a MAJORITY of expensive aged accounts. The factor is a coarse,
  non-financial signal (the `check:neutrality` gate stays green); anonymity is
  never penalized (the privacy-bucket actor is treated as established) and the
  weight never zeroes a legitimate new user's participation. Two honest caveats:
  (1) the *reach* reduction flows through the burst → participation-dampening
  path, which is itself the **shadow** v0 placeholder until promoted — today the
  weighting earns "flagged for review sooner", not yet live reach loss; and
  (2) a genuinely viral item drawing a MAJORITY of new users can trip the
  lowered threshold and be flagged — an accepted trade-off, since flags are
  shadow and the exact MFCI fiber test + human review clear organic virality.
- *Source-free accusation* (b): the conservative lexical classifier
  (`classifyAccusationV0`) runs where the body text exists (the contribution
  route) and only its boolean travels on the event; hedges, questions,
  opinions, and reported speech are never classified (the WS-K AI classifier
  replaces the function behind the same seam). Downweight affects scoring
  only — never visibility — and the ledger explains it so the author can
  remedy it with evidence.
- *Harassment cascade* (c): several distinct actors + a contribution mix
  dominated by low-info replies/flags + volume above base rate ⇒ a
  `restricted` integrity signal, a high-priority safety case
  (`MOD_HARASS_002`, source `integrity_review`, reporter null), the
  safety-queue hook, and a FREEZE via the shared WS-E.2.3e mechanism.
  Detection side effects are deterministic per (item, window, signal) — a
  window re-run converges instead of re-opening cases or overriding a
  moderation clearance; a NEW window's cascade freezes again.

**System-event producers (WS-E.1.1e)**: the scoring job emits
`invariant.run.completed` once per item/window (deterministic name-based
UUIDv8 over SHA-256 ⇒ idempotent re-runs never duplicate it; carries the
score vector, confidence, and computation time); every safety-state transition — cascade freezes and
steward resolutions alike — emits the §21.3 `thread.state.changed`
safety-dimension event; and the WS-D privacy routes emit
`privacy.request.created` for export requests, deletion requests and
cancellations, and attention resets. `notification.sent` remains schema-only:
no in-repo code dispatches notifications yet (the WS-C push surface stores
subscriptions; sending arrives with its owning workstream).

**Safety state (WS-E.2.3e)**: `normal → frozen → (normal | removed)`,
`removed` terminal (reinstatement is WS-J appeal scope). Frozen pins the
stored score at its freeze-time value while raw scores and Signal Ledger
entries keep recording (transparency without distribution); removed scores 0.
All transitions are audit-logged (`safety_state_change`).
`resolveItemSafetyState` is the WS-J moderation-resolution hook.

**v1 (WS-E.2.3a-d)** — INTEGRATED into the live scoring job and stored (a
bounded ranking input since the WS-I §30.5 lift). `computePwattV1Components` is the
pipeline stage: each actor's per-type contribution counts pass through a
per-user diminishing-returns curve at the contribution hierarchy's weights
(correction > explanation > low_info_reply=0, where `explanation` is the
comment-grade weight the live `comment` type maps to; bridge comments strong,
steward actions thread-health; the
source-free downweight applies at the accusing type's own weight), then item
dimensions compose through `applySaturation` — configurable curves
(logarithmic with an exact cap, and tanh — both total, monotone, concave;
property-tested), integer-percent weights with the 50% dominance cap and an
exact sum-to-100 check. Ranking profiles are validated against the §5.5
guardrails (defaults `breaking_news` 30/25/15/15/15 and `evergreen_science`
20/40/15/15/10; the selection context carries no payment/wallet field — a
type-level firewall); penalties are separate nonnegative coefficients OUTSIDE
the convex combination — they can drive the total below zero; pM uses the
burst detector's confidence, pR the MERI redundancy hook (0 until WS-H.2),
pH/pT pinned-zero placeholders (WS-H.6/H.7). EVERYTHING is runtime-tunable
through the `pwatt_config` store — the v0 component weights, the full v1
stage (`v0`/`v1` keys), detector thresholds, penalty coefficients, profiles,
and the trigger threshold — read each tick, validated key-by-key, FAILING
CLOSED to reviewed defaults, and writable only through the steward admin
endpoint, which REJECTS invalid values at configuration time (422) and
audit-logs the actor.

**Signal Ledger (WS-E.2.1d)**: strictly owner-only (`GET /v1/signal-ledger`,
authenticated; the endpoint takes no user parameter, so another user's ledger
is unreachable), populated from the 1-HOUR window ONLY — one canonical entry
per (owner, item, hour); the larger windows' scores live in
`invariant_outputs`, their actual audience — with the bucketed signal
breakdown, applied anti-signals, the PWAtt score, and a deterministic
plain-language summary ("You read this for a moderate duration, opened the
source, and returned to it. Your question was counted as constructive
participation."). Cap status is honestly OMITTED from server-generated
entries (it is knowable only on the client: the §22.1 wire carries buckets,
whose ceilings are the cap expression — `cap_reached` is optional on the wire
schema for a future client-emitted canonical event). Entries carry purge
deadlines coupled to the owner's retention preference; pseudonymous actors
get no ledger rows (nothing to link to). The web profile page renders the
summary verbatim — qualitative wording only, never a number.

**Behavioral authenticity (bot-prevention layer 2)**: the 1h window run also
persists per-ACTOR behavior snapshots (`foldActorBehaviorWindows`,
`pwatt/behavior.ts` — the SAME deduplicated fold, projected per actor:
per-item MAX buckets counted into histograms; identifiable actors only, the
privacy-bucket actor is NEVER profiled). The hourly job
(`runBehaviorAuthenticityJob`, a `behavior` scheduler task after scoring)
assesses every actor active in the 7-day lookback with the pure
`@licio/invariants` behavior math — dwell-bucket variety, interaction
breadth, temporal rhythm, all evidence-gated and floored — and clusters
cross-account near-duplicate behavior streams (frozen MinHash family over
`behaviorStreamText`, LSH candidates verified against the Jaccard threshold,
deterministic cluster ids; k clones collapse to ~one account of influence).
The effective multiplier upserts into `actor_authenticity_scores` and
COMPOUNDS with the WS-O.4.5 account-age trust in `runPwattWindow`'s
per-actor factor (floored at `behavior.overallFloor` — reduced, never
silenced; unassessed actors are exactly neutral), so a low-authenticity
fleet both trips burst detection sooner AND earns less served distribution
power. Thresholds are runtime-tunable under the `behavior` pwatt_config key
(validated, fail-closed to defaults). Snapshots prune past 14 days in the
job; `purgeUserAttention` removes BOTH planes on attention reset/deletion
(behavior state never outlives the attention data it derives from). The
population view ships as the WS-H `behavioral_authenticity` invariant
(docs/invariants/README.md#bai-inputs).

## Scheduler

`startEventPipelineScheduler` mirrors the WS-D privacy scheduler: hourly
ticks on every instance, a Postgres job lease (`events_hourly`) grants at most
one executor per window, a crashed holder self-heals via lease expiry, and a
lease-store outage skips the tick (fail closed — idempotent re-runs catch up).
Each tick computes ONLY the windows that need it (`windowsNeedingCompute`):
a completed window is due when any event in its range was RECEIVED after the
window's last computedAt — so a fresh window computes once, a late
offline-sync arrival re-opens its windows, and unchanged windows are skipped
(no hourly full recomputes of the 7-day window). The freshness lookback per
size (~26h/36h/8d/14d) means deep lates beyond a size's lookback fold into the
larger sizes only. Each tick also runs the retention sweeps and reconciles the
real-time layer. The volume-threshold trigger (wired in production boot)
scores a hot item's current 1h window early, debounced per item-window.

## Steward operations (`/v1/events/admin`)

The operational surface for the pipeline, gated by `requireSteward`
(authenticated steward with per-session TOTP, WS-D.1.5b):

| Endpoint | Purpose |
|---|---|
| `POST /safety-state` | Clear/remove an item (WS-E.2.3e resolution; actor-attributed audit + `thread.state.changed`) |
| `PUT /pwatt-config` | Validated runtime-config writes — invalid values rejected with 422 at configuration time, never stored; `pwatt_config_change` audit |
| `GET /dead-letters` | DLQ visibility (per consumer) |
| `POST /dead-letters/redrive` | Retry poisoned events after a fix |
| `POST /recover` | Manual checkpoint replay + real-time rebuild (automatic at boot) |

## Production bindings

Mirroring WS-D: in-memory adapters for dev/tests, swapped at boot
(`apps/api/src/index.ts`):

- **Postgres (Drizzle)** — all nine durable stores
  (`events/drizzle-event-stores.ts`), parameterized queries only, batched
  keyed-subselect deletes.
- **Redis** — replay nonces (`SET NX PX`), sliding-window ZSETs, real-time
  counters with native HLL, every key TTL'd (`events/redis-event-stores.ts`).

Both are covered by gated integration tests (`DATABASE_URL` / `REDIS_URL`)
that run the real migration chain; CI (no services) skips them:

```bash
docker compose up -d postgres redis
DATABASE_URL=postgres://licio:licio_dev@localhost:5432/licio_dev \
REDIS_URL=redis://localhost:6379 pnpm test
```

## Deferred / interface-level (wired to follow-up workstreams)

- **`contribution.created.story_id` — the CONTRACT step is outstanding.**  The
  field is present on every emitted payload (enforced at the type level in
  `forum/contributions.ts` and pinned by `forum-contributions.test.ts`), the
  stored payloads written before it existed are backfilled from
  `threads.story_id` by migration 0111, and the participation fold resolves
  thread → story for anything the backfill could not reach.  It remains
  **optional on the wire**, because that is an expand/migrate/**contract**
  sequence and the contract step cannot ship in the same release as the
  migrate: during a rolling upgrade an instance running the previous code is
  still emitting payloads without the field, so requiring it would reject LIVE
  traffic, not just old rows.  Close it in a release after 0111 has run
  everywhere — make `story_id` required, then delete the fold's resolution
  fallback and the `pwatt.contribution.unresolved_story` metric with it.
  Closure target: the release after the one carrying migration 0111.
- **WS-F (CLOSED)** — `content.submitted`/`content.normalized` are emitted
  by the real story-submission pipeline (`apps/api/src/ingestion/`,
  `docs/ingestion/README.md`), and ledger story titles resolve from the real
  story store (write-through cache; demo fixtures as fallback).
- **WS-G (CLOSED)** — forum contributions emit `contribution.created`
  with real correlation ids (`docs/forum/README.md`), so
  the accusation downweight and the lifecycle activity triggers run on real
  conversation data; moderation concerns reach stewards through the WS-J
  report flow.
- **WS-H** — MERI/SCOI/PHI/Hodge feed the served §5.4 composite through the
  WS-I feature store (the wE/wS/wC terms + the pM/pH/pT/pR penalties), NOT the
  batch engine: the engine persists only the two CONTENT components it can
  legitimately compute (`active_attention`, `participation`), and `@licio/ranking`
  composes the full §5.4 at decision time (the baseline `B` is a per-request
  quantity the batch cannot know). `hooks.redundancy` still supplies the MERI
  redundancy input to that composition; MFCI consumes the burst signals flowing
  through `hooks.mfci`. There is exactly ONE served §5.4 implementation — no
  partial duplicate is stored (`invariant_outputs` PWAtt_v0/v1 rows are
  strict-schema-pinned to the content components).
- **PWAtt anti-abuse (bound to the SERVED path).** A window's own anti-signals
  and account-age trust are consequential for ranking, not merely logged: a
  detected coordinated burst / harassment cascade ATTENUATES the served
  `active_attention`/`participation` (`antiSignalAttenuation`), a harassment
  freeze PINS those components at their pre-cascade level (`item_safety_states`
  `frozen_active_attention`/`frozen_participation`), each actor's contribution
  is scaled by a coarse account-age trust weight (fresh/throwaway accounts count
  less; the coarse privacy bucket is always full-trust so anonymity is never
  penalized), and the ingestion boundary neutralizes the one provably-impossible
  client-aggregate combination (reply traversal with zero active dwell, §25.5).
- **WS-I** — CLOSED: the ranking pipeline consumes PWAtt components from
  post-lift rows in its feature store (`docs/ranking/README.md`) through the
  SAME §30.5 gate at BOTH the feature-join AND the retrieval-eligibility read
  (`pwattRowForRanking`), the §30.5 lift shipped (`PWATT_V0_SHADOW_MODE =
  false`), the freshness baseline B is computed at decision time, and
  `selectRankingInputs` is the SAFE FALLBACK's score-blind boundary.
- **WS-J** — review/safety queues behind `hooks.reviewQueue`/`hooks.safetyQueue`;
  moderation resolution drives `resolveItemSafetyState`.
- **WS-K** — a reviewed AI classifier behind the `classifyAccusationV0` seam.
- **WS-N** — jurisdiction retention overrides via
  `EventPipelineServices.retention.overrides` (shorten-only).
- **Client `source.opened.aggregate` emission** — the server path (schema,
  guards, brief/bounce zero-weighting in scoring) is complete; the client
  signal processor still reports source opens through the per-item aggregate
  booleans, and a dedicated client emitter with dwell-bucket/bounce
  measurement can land without server changes. The same applies to a
  client-emitted `cap_reached` on canonical events (optional on the wire).
- **`low_info_reply` classification (CLOSED by WS-G)** — the conservative
  heuristic `classifyLowInfoReplyV0` (`@licio/invariants`) classifies
  replies at creation time and the classification rides
  `contribution.created`; the reviewed AI classifier (WS-K) can replace the
  heuristic behind the same seam.
- **Burst-conditioning covariates** — base rates condition on the item's own
  trailing windows; time-of-day/topic/community covariates consume the
  WS-F/WS-G metadata (now present) and land with WS-H's MFCI.
- **§5.3 "Save for later" signal (CLOSED).** The `content.saved` core topic
  (15 core topics) is a discrete, deduped, privacy-leveled save signal that
  rides the SAME attention-ingestion pipeline (`POST /v1/events/attention`):
  ownership, replay nonce, the privacy gate (a personalization-off user's save
  is DISCARDED), and minimum-privacy pseudonymization. The client emits it
  best-effort after a local save (`emitContentSaved`, gated on an authenticated
  session); the user's saved COLLECTION stays client-local (IndexedDB) and never
  reaches the server. The window fold folds it into `savedForLater` (deduped
  per actor), and the `saves` participation dimension carries the §5.3 LOW rank
  weight (10%) while `contributions` stays dominant.
- **Cross-instance streaming** — the router is in-process over the durable
  Postgres log, with real per-consumer checkpoints and startup replay; a
  Redis Streams/broker binding can replace delivery behind the same
  `EventRouter` surface when WS-O scales out (with multiple instances the
  real-time layer is advisory and hourly-reconciled; the durable aggregation
  stays authoritative).

# WS-E: Event Pipeline and PWAtt — implementation reference

This document describes the implemented WS-E surface: the event schemas and
topic registry, the hardened attention-ingestion boundary, durable storage and
real-time aggregation, retention enforcement, the consumer router with the
pay-to-rank firewall, and the PWAtt scoring engine (v0 shadow + v1
saturation/weights/penalties). The design specification is SPEC §5, §19,
§21.3, §22, §25.5, and §30.5; the task plan is
`docs/planning/06-event-pipeline-and-pwatt.md`.

Two constraints govern everything here (SPEC §19.2, §30.5):

1. **Raw scroll/touch traces never leave the browser.** Every attention metric
   on the wire is a closed enum bucket; schemas are strict (unknown keys
   rejected); a dedicated test asserts the schema cannot be widened to accept
   a numeric dwell.
2. **PWAtt has zero distribution power while in shadow.** Every PWAtt output
   is stored `shadow_mode: true`, the ranking boundary rejects PWAtt rows even
   if the flag were mislabeled, and a CI-gated equivalence test proves ranking
   output is identical with and without scores. Lifting shadow mode requires
   editing `PWATT_V0_SHADOW_MODE` in `@licio/invariants` — a reviewed code
   change, never configuration (SPEC §30.5 safety review, with WS-I).

## Architecture

| Layer | Location | Contents |
|---|---|---|
| Schemas | `packages/shared/src/schemas/events/` | Envelope, retention tiers, 14 core topics, 18 Knomosis topics (bounded context), topic registry + discriminated union |
| Pure math | `packages/invariants/src/pwatt/` | ActiveAttention, ConstructiveParticipation, saturation curves, ranking profiles, penalties, safety-state machine, accusation classifier, ledger summaries |
| Pipeline | `apps/api/src/events/` | Stores (in-memory + Drizzle + Redis), ingestion pipeline, replay guard, sliding-window rate limiter, privacy gate, consumer router, real-time aggregation (HLL), retention sweeps, metrics |
| Scoring | `apps/api/src/pwatt/` | Window aggregation, anti-signal detectors, runtime config, the scoring job, shadow boundary, freshness ranking v0, lease-guarded scheduler |
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

Guard order per event: session auth → per-user sliding-window rate limit →
schema validation → ownership (`user_id` must equal the session user) →
timestamp window → replay nonce → server-side privacy gate → durable insert →
publish.

**Replay protection** is two-layer: a single-use nonce set (Redis `SET NX PX`,
10-minute TTL, keys carry a non-reversible account ref) plus the event store's
event-id uniqueness — the durable backstop that rejects a replayed event
forever, even after the nonce TTL.

**Rate limiting** (SPEC §19.1-compliant: no addresses, no raw user ids) uses
true sliding windows (timestamped ZSET entries; default 10/min + 120/h via
`EVENTS_RATE_PER_MINUTE`/`EVENTS_RATE_PER_HOUR`) with exact Retry-After math,
and FAILS CLOSED: a Redis outage degrades to an in-memory fallback at 50% of
the configured limits — never an open gate.

**Privacy enforcement** (WS-E.1.3d) reads the user's durable WS-D settings on
every request (a mid-session change applies to the next event):
`personalization_enabled: false` ⇒ silent discard (204);
`attention_retention_preference: 'none'` ⇒ real-time only (the event row gets
a ranking-window purge deadline; no durable §22.1 row); `'minimal'` ⇒ the
90-day tier minimum; default ⇒ the 180-day maximum. Enforcement decisions are
compliance-logged (user id + action, never payloads).

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
A rebuild-from-store function proves the layer holds no unique state.

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

Delivery is at-least-once with consumer-side idempotency (per-consumer
event-id LRU; durable consumers checkpoint), bounded retries, dead-lettering
for poisoned events (`event_dead_letters`), and per-consumer lag/health
metrics. Default consumers: `realtime-aggregation` (scoring; counters + the
volume-threshold trigger for early aggregation) and `integrity-intake`
(restricted-authorized, non-scoring; forwards integrity signals to the
MFCI/review-queue hooks).

## Retention and anonymization (WS-E.1.4)

Hourly sweeps (idempotent, batched, lease-guarded):

| Sweep | Action |
|---|---|
| `attention_raw` | Delete rows past 7 days (backstop) |
| `attention_aggregated` | Delete events past 180 days (or jurisdiction override); per-owner aggregate rows ANONYMIZE (identity → privacy bucket) at the CURRENT preference's window, DELETE at the hard cap (365d) |
| `honor_preference` | Delete purge-due rows (`none` ⇒ ranking window) + expired ledger entries |
| `ranking_log` | Delete events/invariant outputs/windows past 365 days |
| `moderation review` | FLAG `moderation_legal` rows older than a year for annual human review — never auto-delete |

Jurisdiction overrides (the WS-N hook) only ever SHORTEN windows. Every sweep
emits a counts-only audit record (`retention_sweep`), and
`retentionComplianceReport` is the audit query proving zero over-retained
rows — a WS-P.2 transparency artifact. The WS-D hooks are now real:
`purgeAttention` deletes events + aggregates + ledger, `exportAttention`
returns the user's own rows for DSAR export, and `onPrivacyChange` tightens
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
  placeholder participation dampening (shadow).
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

**Safety state (WS-E.2.3e)**: `normal → frozen → (normal | removed)`,
`removed` terminal (reinstatement is WS-J appeal scope). Frozen pins the
stored score at its freeze-time value while raw scores and Signal Ledger
entries keep recording (transparency without distribution); removed scores 0.
All transitions are audit-logged (`safety_state_change`).
`resolveItemSafetyState` is the WS-J moderation-resolution hook.

**v1 (WS-E.2.3a-d)** — implemented and stored (still shadow until the §30.5
review with WS-I): configurable saturation curves (logarithmic with an exact
cap, and tanh — both total, monotone, concave; properties tested), integer-
percent dimension weights with the 50% dominance cap and an exact sum-to-100
check; ranking profiles validated against the §5.5 guardrails (defaults
`breaking_news` 30/25/15/15/15 and `evergreen_science` 20/40/15/15/10; the
selection context carries no payment/wallet field — a type-level firewall);
the contribution hierarchy (evidence > correction > synthesis > question >
counterexample > explanation > low_info_reply=0, bridge comments strong,
steward actions thread-health); and penalties as separate nonnegative
coefficients OUTSIDE the convex combination — they can drive the total below
zero; pM uses the burst detector's confidence, pR the MERI redundancy hook
(0 until WS-H.2), pH/pT pinned-zero placeholders (WS-H.6/H.7). All thresholds,
weights, and coefficients are tunable through the `pwatt_config` store, read
each tick, validated key-by-key, FAILING CLOSED to reviewed defaults.

**Signal Ledger (WS-E.2.1d)**: strictly owner-only (`GET /v1/signal-ledger`,
authenticated; the endpoint takes no user parameter, so another user's ledger
is unreachable), populated per (owner, item, window) with the bucketed signal
breakdown, applied anti-signals, the shadow score, and a deterministic
plain-language summary ("You read this for a moderate duration, opened the
source, and returned to it. Your question was counted as constructive
participation."). Entries carry purge deadlines coupled to the owner's
retention preference; pseudonymous actors get no ledger rows (nothing to link
to). The web profile page renders the summary verbatim — qualitative wording
only, never a number.

## Scheduler

`startEventPipelineScheduler` mirrors the WS-D privacy scheduler: hourly
ticks on every instance, a Postgres job lease (`events_hourly`) grants at most
one executor per window, a crashed holder self-heals via lease expiry, and a
lease-store outage skips the tick (fail closed — idempotent re-runs catch up).
Each tick scores the completed windows (recomputing the larger windows also
folds in late offline-sync events), runs the retention sweeps, and reconciles
the real-time layer. The volume-threshold trigger requests early aggregation
for hot items (debounced per item-window).

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

- **WS-F/WS-G** — `content.submitted`/`content.normalized` emission from a
  real story-submission pipeline; `evidence.added` correlation for the
  accusation downweight; real story titles for ledger entries (an injected
  resolver, demo-backed today); report-intake mapping onto the WS-A reason
  codes for user-filed `moderation.case.created` events (the schema, storage,
  routing, and the integrity-emitted path are live).
- **WS-H** — MERI/SCOI/PHI/Hodge providers behind the existing hooks
  (`hooks.redundancy`, the wE/wS/wC component inputs, pH/pT penalty inputs);
  MFCI consumes the burst signals already flowing through `hooks.mfci`.
- **WS-I** — the ranking service consumes `selectRankingInputs` at its
  boundary; lifting shadow mode is the §30.5 code change + safety review. The
  freshness baseline B is supplied at decision time.
- **WS-J** — review/safety queues behind `hooks.reviewQueue`/`hooks.safetyQueue`;
  moderation resolution drives `resolveItemSafetyState`.
- **WS-K** — a reviewed AI classifier behind the `classifyAccusationV0` seam.
- **WS-N** — jurisdiction retention overrides via
  `EventPipelineServices.retention.overrides` (shorten-only).
- **Client `source.opened.aggregate` emission** — the server path (schema,
  guards, scoring bounce handling) is complete; the client signal processor
  still reports source opens through the per-item aggregate booleans, and a
  dedicated client emitter with dwell-bucket/bounce measurement can land
  without server changes.
- **Cross-instance streaming** — the router is in-process over the durable
  Postgres log (replayable by topic+timestamp with consumer checkpoints); a
  Redis Streams/broker binding can replace delivery behind the same
  `EventRouter` surface when WS-O scales out.

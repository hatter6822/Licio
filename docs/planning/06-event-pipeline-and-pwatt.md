# WS-E: Event Pipeline and PWAtt

**Milestone:** M1-M2
**Priority:** P1
**Dependencies:** WS-D.1 (accounts and authentication), WS-C.4 (client signal processor)
**Wave:** 4-5
**Estimated duration:** 4-5 weeks

---

## Overview

The event pipeline ingests aggregated attention signals and feeds the PWAtt scoring engine. PWAtt is the core rating primitive -- there are no likes, no upvotes, no hearts, no reactions, and no public karma. Distribution is determined solely by privacy-preserving measures of genuine attention and constructive participation (Section 5.1). The pipeline enforces privacy classification on every event, assigns retention tiers per Section 22.4, and treats client-submitted aggregates as hints rather than sole truth (Section 25.5). PWAtt v0 runs in shadow mode (scores computed and logged but never affecting ranking or distribution), graduating to bounded ranking input only after safety review (Section 30.5).

This workstream is the privacy and integrity backbone of the entire product. Two design constraints govern every task: (1) raw scroll/touch traces are processed in-browser and discarded after feature extraction -- they are NEVER uploaded (Section 19.2); and (2) PWAtt can never be increased by passive autoplay, background time, bot loops, refresh loops, paid interactions, or wallet actions (Section 30.5). Every schema, endpoint, job, and scoring step below exists to make those two constraints structurally enforced rather than merely promised.

### Privacy classification model

Every event topic carries a `privacy_classification` that drives access control, logging, retention, and export behavior. The four levels are:

| Classification | Meaning | Example topics | Access rule |
|---|---|---|---|
| `public` | Content the author intends others to see. | `content.submitted`, `contribution.created`, `evidence.added` | Readable in public APIs and search. |
| `aggregated` | Privacy-preserving, bucketed signals derived from behavior; never raw, never per-event-precise. | `source.opened.aggregate`, `attention.aggregate` | Readable only by the owning user (Signal Ledger) and internal scoring; never in public APIs. |
| `sensitive` | Internal scoring and ranking artifacts; not user content but reveals system behavior. | `invariant.run.completed`, `ranking.decision.logged`, `privacy.request.created` | Internal + audited; user-facing only as derived explanations. |
| `restricted` | Safety, moderation, and reporter-identity data with the strongest controls. | `moderation.case.created`, `integrity.signal.detected` | Restricted access roles only; reporter identity never exposed in any public or peer-visible API. |

### Retention tier model

Every event topic carries a `retention_tier` mapped to a configured retention window (Section 22.4). Tiers and their default windows:

| Tier | Window | Policy basis |
|---|---|---|
| `attention_raw` | <= 7 days | Raw client attention events; preferably not uploaded at all. |
| `attention_aggregated` | 90-180 days, then anonymize | Aggregated attention features. |
| `public_contribution` | Until deleted/removed/archived | Public contributions. |
| `ranking_log` | 180-365 days with access controls | Ranking decision logs, invariant outputs. |
| `moderation_legal` | Longer per policy/legal need, reviewed annually | Moderation logs. |
| `account_active` | While active + legal retention | Account-linked operational records. |
| `security_log` | Per risk and legal requirements | Security and integrity events. |

These are defaults; jurisdiction-specific overrides are owned by WS-N and applied at retention-job time.

### Field-naming conventions

The SPEC `AttentionAggregate` entity (Section 22.1) uses `privacy_level` and `user_id_or_privacy_bucket`. To keep event topics internally consistent while staying faithful to the entity, WS-E.1.1g defines the canonical mapping: event topics use `privacy_classification` + `retention_tier` on the event envelope, and the persisted `AttentionAggregate` row carries `privacy_level` (mapped 1:1 from `privacy_classification`) and `user_id_or_privacy_bucket` (the user id or, for pseudonymized rows, a privacy bucket). All schemas reference this mapping so the names never drift.

---

## WS-E.1 Event schema and ingestion

### WS-E.1.1a Content event schemas
**ID:** WS-E.1.1a
**Ref:** Section 21.3

**Description:**
Define zod schemas in `packages/shared/src/schemas/events/content.ts` for content lifecycle events. `content.submitted`: emitted when a user submits a story via `POST /v1/stories`; fields include `event_id` (UUID), `event_type` (literal `content.submitted`), `timestamp` (ISO 8601), `story_id` (UUID), `submitted_by` (UUID, user_id), `submission_type` (enum per Section 14.1: link, original_brief, question, evidence_card, local_update, live_thread), `canonical_url` (nullable, for link stories), `topic_ids` (string array), `privacy_classification` (literal `public`), `retention_tier` (literal `public_contribution`). `content.normalized`: emitted after ingestion pipeline processing; adds `source_id`, `language`, `sensitivity_labels`, `duplicate_group_id` (nullable), `claim_ids` (extracted claims), `embedding_ref` (nullable). Both schemas use strict zod parsing (no unknown keys).

**Acceptance criteria:**
- Both schemas compile under TypeScript strict mode and are exported from `packages/shared`.
- `content.submitted` validates all required fields and rejects unknown keys.
- `content.normalized` includes all fields from `content.submitted` plus processing outputs.
- `privacy_classification` and `retention_tier` are present and correctly set.
- Schema changes are versioned (a `schema_version` field or constant).

**Testing:**
- Unit: Parse valid events. Reject events with missing fields, wrong types, or unknown keys. Verify enum values are exhaustive for `submission_type`.

**Dependencies:** WS-E.1.1g (event envelope base schema), WS-F.1 (story schema for `story_id`/`source_id` shape).

**Security/Privacy:** Content events are `public` by design; they carry no behavioral signal. Strict parsing prevents a malicious or buggy client from smuggling extra fields (e.g., raw URLs of off-app browsing) into a public topic.

---

### WS-E.1.1b Attention event schemas
**ID:** WS-E.1.1b
**Ref:** Sections 5.3, 19.2, 21.3, 22.4

**Description:**
Define zod schemas for attention events. `source.opened.aggregate`: emitted when the client reports a source-open event; fields include `event_id`, `event_type`, `timestamp`, `user_id`, `story_id`, `source_id`, `dwell_bucket` (enum: brief, moderate, extended -- bucketed to preserve privacy), `bounce` (boolean: user returned immediately), `privacy_classification` (literal `aggregated`), `retention_tier` (literal `attention_aggregated`). `attention.aggregate`: emitted by the client signal processor (WS-C.4) as a periodic aggregated summary; fields include `event_id`, `timestamp`, `user_id`, `session_bucket` (anonymized session identifier), `items` (array of per-item attention summaries: `story_id`, `active_dwell_bucket`, `source_opened` boolean, `context_opened` boolean, `branch_depth_bucket`, `return_visit_count_bucket`), `privacy_classification` (literal `aggregated`), `retention_tier` (literal `attention_aggregated`). All attention values are bucketed (not raw), capped per item (Section 5.3), and idle-filtered before upload. The schema enforces that no raw scroll/touch events are included (Section 19.2). Field names match the `AttentionAggregate` entity (Section 22.1): `active_dwell_bucket`, `source_opened`, `context_opened`, `branch_depth_bucket`, `return_visit_count_bucket`.

**Acceptance criteria:**
- Schemas enforce bucketed values (enums, not raw numbers) for all attention metrics.
- `privacy_classification` is `aggregated` for all attention events.
- `retention_tier` is `attention_aggregated` (raw <= 7 days, aggregated 90-180 days).
- No field captures raw scroll positions, touch coordinates, or precise timing.
- Per-item dwell is capped (enforced by the enum bucket, not by trusting raw numbers).
- Bounce detection is a boolean, not a duration.
- Per-item summary field names match the `AttentionAggregate` entity exactly.

**Testing:**
- Unit: Parse valid attention events. Reject events with raw (non-bucketed) dwell values. Reject events with extra fields that could carry raw data. Verify privacy classification. Fuzz: random extra keys are always rejected.

**Dependencies:** WS-E.1.1g (event envelope base schema), WS-C.4 (client signal processor emits these), WS-E.1.1f (retention tier enum).

**Security/Privacy:** This is the single most privacy-critical schema in the system. The "no raw fields" guarantee is enforced structurally: only bucketed enums are accepted, the schema rejects unknown keys, and a dedicated test asserts the schema cannot be widened to accept a numeric dwell. Raw scroll/touch never leaves the browser (Section 19.2). Bucketing prevents fingerprinting via precise dwell timing.

---

### WS-E.1.1c Contribution event schemas
**ID:** WS-E.1.1c
**Ref:** Sections 5.3, 15.1, 21.3

**Description:**
Define zod schemas for contribution events. `contribution.created`: emitted when a user submits a contribution; fields include `event_id`, `event_type`, `timestamp`, `contribution_id` (UUID), `thread_id`, `user_id`, `contribution_type` (enum: question, evidence, correction, synthesis, counterexample, explanation, experience, bridge_comment, steward_action, flag, low_info_reply), `target_claim_id` (nullable), `parent_contribution_id` (nullable), `has_citation` (boolean), `privacy_classification` (literal `public`), `retention_tier` (literal `public_contribution`). `evidence.added`: emitted when an evidence card is submitted; adds `evidence_id`, `claim_id`, `evidence_type`, `source_id`. `claim.updated`: emitted when a claim's status changes; includes `claim_id`, `story_id`, `old_status`, `new_status` (unverified, supported, challenged, corrected, retracted), `updated_by` (user_id or system).

**Acceptance criteria:**
- All contribution types from Section 15.1 are represented in the enum.
- `low_info_reply` is explicitly included as a contribution type (for anti-signal tracking).
- Evidence events include claim references and source references.
- Claim status transitions are validated (only legal transitions accepted).
- Privacy classification is `public` for all contribution events.

**Testing:**
- Unit: Parse valid contribution events for each type. Verify claim status transition validation. Reject invalid transitions (e.g., `retracted` -> `unverified`).

**Dependencies:** WS-E.1.1g (event envelope base schema), WS-G.1 (thread/contribution/evidence schemas for id shapes).

**Security/Privacy:** Contribution events are `public`. The contribution-type enum (especially `bridge_comment`, `steward_action`, `low_info_reply`) is the bridge between the conversation model (WS-G) and PWAtt participation scoring; an exhaustive enum prevents an unweighted type from silently entering scoring.

---

### WS-E.1.1d Moderation event schemas
**ID:** WS-E.1.1d
**Ref:** Sections 18.2, 21.3

**Description:**
Define zod schemas for moderation events. `moderation.case.created`: emitted when a report or automated detection creates a moderation case; fields include `event_id`, `event_type`, `timestamp`, `case_id` (UUID), `target_type` (enum: contribution, story, user, room), `target_id`, `reporter_id` (nullable -- null for automated detection), `reason_code` (enum per Section 18.1 policy categories), `severity` (enum: low, medium, high, critical), `source` (enum: user_report, automated, steward, integrity_review), `privacy_classification` (literal `restricted`), `retention_tier` (literal `moderation_legal`). `integrity.signal.detected`: emitted by integrity systems (MFCI, cascade detection); includes `signal_type` (enum: coordinated_burst, rage_loop, source_free_accusation, brigading, harassment_cascade), `target_ids`, `confidence`, `evidence_summary`.

**Acceptance criteria:**
- Moderation events have `restricted` privacy classification.
- Retention tier is `moderation_legal` (retained per legal need, Section 22.4).
- Reporter identity is present but classified as restricted (never exposed in public APIs).
- All policy categories from Section 18.1 are represented in `reason_code`.
- Integrity signals include a confidence score.

**Testing:**
- Unit: Parse valid moderation events. Verify privacy classification is `restricted`. Verify all policy reason codes are present. Verify integrity signal types match Section 5.3 anti-signals.

**Dependencies:** WS-E.1.1g (event envelope base schema), WS-J.1 (report reason taxonomy), WS-A (moderation taxonomy / policy categories).

**Security/Privacy:** `reporter_id` is the highest-sensitivity field in the pipeline. It is `restricted` and must never appear in any public, peer-visible, or aggregated output; export and access tests assert this explicitly (Section 19.5 forbids reporter identity in linkable contexts). `integrity.signal.detected` topics are inputs to safety freezes and must be protected so adversaries cannot learn detection thresholds.

---

### WS-E.1.1e System event schemas
**ID:** WS-E.1.1e
**Ref:** Section 21.3

**Description:**
Define zod schemas for system and operational events. `invariant.run.completed`: emitted after an invariant computation completes; fields include `event_id`, `timestamp`, `invariant_type` (enum: MERI, MFCI, SCOI, GWEI, PHI, PWAtt), `target_type`, `target_id`, `time_window`, `version`, `score_vector`, `confidence`, `computation_time_ms`, `privacy_classification` (literal `sensitive`), `retention_tier` (literal `ranking_log`, 180-365 days). `ranking.decision.logged`: emitted for each ranking decision; includes `decision_id`, `story_id`, `context` (feed, room, search), `score`, `position`, `signals_used` (array of signal types), `explanation_summary`. `notification.sent`: emitted when a notification is dispatched; includes `notification_id`, `user_id`, `notification_type`, `channel` (push, email, in_app). `privacy.request.created`: emitted when a privacy action is requested (export, deletion, attention reset); includes `request_type`, `user_id`, `status`. `thread.state.changed`: emitted when a thread's conversation_state or safety_state changes; includes `thread_id`, `story_id`, `old_state`, `new_state`, `state_dimension` (conversation, safety), `changed_by`.

**Acceptance criteria:**
- Invariant run events include version and confidence for reproducibility.
- Ranking decision events include enough detail for decision replay (Section 30.6).
- Notification events do not include the notification content (only type and channel).
- Privacy request events are classified as `sensitive`.
- `thread.state.changed` (a core topic in Section 21.3) is defined and emitted on safety/conversation transitions.
- All event schemas follow a consistent base shape (event_id, event_type, timestamp, privacy_classification, retention_tier).

**Testing:**
- Unit: Parse valid events for each type. Verify consistent base shape across all schemas. Verify retention tiers match Section 22.4.

**Dependencies:** WS-E.1.1g (event envelope base schema), WS-H (invariant types), WS-I (ranking decision fields).

**Security/Privacy:** System events are `sensitive`: they describe how the system makes decisions, not user content, but they can reveal manipulation defenses. `signals_used` and `score_vector` are internal-only; user-facing surfaces receive only `explanation_summary` (Section 5.4 simplified explanation). Notification events deliberately exclude content to avoid persisting message bodies.

---

### WS-E.1.1f Retention tier assignment
**ID:** WS-E.1.1f
**Ref:** Section 22.4

**Description:**
Define a retention tier enum and assignment logic in `packages/shared/`. Tiers: `attention_raw` (raw attention events if uploaded, <= 7 days), `attention_aggregated` (aggregated attention features, 90-180 days), `public_contribution` (public contributions, until deleted/removed/archived by policy), `ranking_log` (ranking decision logs, 180-365 days), `moderation_legal` (moderation logs, retained per legal/policy need, reviewed annually), `account_active` (account data, while active + legal retention), `security_log` (security events, per risk and legal requirements). Each event schema references its tier. Create a utility function `getRetentionDays(tier: RetentionTier): { min: number; max: number; policy: string }` that returns the configured retention window. Document that these are defaults overridable by jurisdiction-specific requirements (WS-N).

**Acceptance criteria:**
- Every event schema defined in WS-E.1.1a-e references a valid retention tier.
- The `getRetentionDays` utility returns correct windows for each tier.
- Tier assignment is compile-time checked (TypeScript enum, not magic strings).
- The utility documents that jurisdictional overrides may apply.

**Testing:**
- Unit: Verify all event schemas have a retention tier. Verify `getRetentionDays` returns valid ranges for each tier. Verify the enum is exhaustive (no tier without a configured window).

**Dependencies:** WS-E.1.1g (envelope references the tier enum). Consumed by WS-E.1.4 (retention jobs).

**Security/Privacy:** Retention tiers are the enforcement surface for data minimization (Section 22.4). Making them a compile-time enum ensures no event can be persisted without an explicit, reviewable retention decision. Sensitive-topic interest gets the shortest applicable tier (Section 19.2).

---

### WS-E.1.1g Event envelope base schema and topic registry
**ID:** WS-E.1.1g
**Ref:** Sections 21.3, 22.1

**Description:**
Define the shared event envelope and a single topic registry. The envelope (`packages/shared/src/schemas/events/envelope.ts`) is the base shape extended by every topic: `event_id` (UUID), `event_type` (string literal, discriminator), `timestamp` (ISO 8601), `schema_version` (string), `privacy_classification` (enum: public, aggregated, sensitive, restricted), `retention_tier` (RetentionTier enum). Build a discriminated-union `EventSchema` keyed on `event_type` over all core topics from Section 21.3, plus a `TopicRegistry` map from topic name to `{ schema, privacy_classification, retention_tier, knomosis: boolean, since_version }`. Document the canonical field-name mapping to the `AttentionAggregate` entity (`privacy_classification` -> `privacy_level`, `user_id` -> `user_id_or_privacy_bucket`). The registry is the single source of truth consumed by ingestion, storage, retention jobs, and the consumer router.

**Acceptance criteria:**
- All core topics from Section 21.3 are registered: `content.submitted`, `content.normalized`, `source.opened.aggregate`, `attention.aggregate`, `contribution.created`, `evidence.added`, `claim.updated`, `thread.state.changed`, `moderation.case.created`, `integrity.signal.detected`, `invariant.run.completed`, `ranking.decision.logged`, `notification.sent`, `privacy.request.created`.
- The discriminated union parses any valid event and rejects unknown `event_type` values.
- Each registry entry carries privacy classification, retention tier, and a `knomosis` flag (false for all core topics).
- The `AttentionAggregate` field-name mapping is documented and unit-asserted.
- A test enumerates Section 21.3 core topics and fails if any is missing from the registry.

**Testing:**
- Unit: Round-trip parse one valid event per topic through the union. Reject unknown `event_type`. Assert registry completeness against a hardcoded Section 21.3 topic list. Assert every registered topic has a non-null privacy classification and retention tier.

**Dependencies:** WS-E.1.1f (retention tier enum). Foundation for WS-E.1.1a-e and WS-E.1.2.

**Security/Privacy:** A single registry prevents drift between schema, classification, and retention. The discriminated union ensures unknown/forged `event_type` values are rejected at the boundary rather than silently routed. The documented entity mapping closes the `privacy_level` vs `privacy_classification` inconsistency.

---

### WS-E.1.2 Knomosis event schemas (flagged)
**ID:** WS-E.1.2
**Ref:** Sections 21.3, 21.5, 17.1

**Description:**
Define zod schemas for the Knomosis event topics from Section 21.3, all behind the crypto feature flag and registered with `knomosis: true` in the topic registry (WS-E.1.1g). Topics: `wallet.link.requested`, `wallet.linked`, `payment.intent.created`, `payment.intent.failed`, `payment.receipt.indexed`, `room.governance.mode.changed`, `governance.proposal.created`, `governance.signature.recorded`, `governance.proposal.executed`, `governance.proposal.challenged`, `treasury.deposit.indexed`, `treasury.grant.approved`, `treasury.payout.executed`, `knomosis.action.preflighted`, `knomosis.action.submitted`, `knomosis.event.indexed`, `compliance.financial.case.created`, `jurisdiction.feature.disabled`. These schemas live in a separate bounded context (`packages/shared/src/schemas/events/knomosis/`) per Section 21.5 and carry `privacy_classification` of `restricted` (wallet/payment/compliance) or `sensitive` (governance/indexing) as appropriate. Critically, NONE of these topics may be consumed by the feed ranking or PWAtt scoring path: the consumer router (WS-E.1.5) must refuse to route Knomosis topics to scoring consumers, enforcing the pay-to-rank firewall at the event layer.

**Acceptance criteria:**
- All 18 Knomosis topics from Section 21.3 are defined and registered with `knomosis: true`.
- Schemas compile only when imported; they are gated behind the crypto feature flag and disabled by default (Section 17.1).
- Knomosis topics live in a separate package/bounded context from social-analytics topics (Section 21.5).
- Wallet/payment/compliance topics carry no attention/reading/report history fields (Section 19.5).
- The consumer router rejects any subscription that would route a Knomosis topic to a PWAtt/ranking consumer.
- A test asserts no Knomosis topic appears in the set of topics consumed by scoring.

**Testing:**
- Unit: Parse valid Knomosis events. Verify `knomosis: true` registry flag. Verify classification (restricted/sensitive).
- Integration: Attempt to subscribe a scoring consumer to a Knomosis topic -- verify rejection (pay-to-rank firewall).
- Security: Assert no wallet address, payment amount, or treasury field is reachable from any PWAtt input path.

**Dependencies:** WS-E.1.1g (registry), WS-D.3 (wallet identity schema isolation), WS-L (Knomosis consumers).

**Security/Privacy:** This task implements the event-layer half of the pay-to-rank firewall (the other halves are WS-A.1.1 signal denylist, WS-I.2.1 feature-store denylist, WS-D.3.1 schema isolation). Keeping these schemas flagged and in a separate bounded context, and proving at the router that they cannot reach scoring, is a Critical-severity mitigation for pay-to-rank leakage. On-chain-adjacent data is `restricted` and excluded from analytics that combine wallet and civic activity (Section 19.5).

---

### WS-E.1.3a POST /v1/events/attention endpoint
**ID:** WS-E.1.3a
**Ref:** Section 21.3, Section 23.2

**Description:**
Implement the `POST /v1/events/attention` Hono route. The endpoint receives aggregated attention features from the client signal processor (WS-C.4). Request body is validated against the `attention.aggregate` zod schema (WS-E.1.1b). The endpoint authenticates the user (session cookie via WS-D.1.6 middleware), verifies the `user_id` in the event matches the authenticated user, and stores the event in PostgreSQL (structured event table) and publishes to the event stream. Response: 202 Accepted with an event receipt ID. Structured pino logging for each accepted event (event_id, user_id, item count -- no attention values in logs).

**Acceptance criteria:**
- Authenticated users can submit attention events.
- Unauthenticated requests are rejected with 401.
- Events with a `user_id` not matching the authenticated user are rejected with 403.
- Valid events are stored in PostgreSQL and published to the event stream.
- Invalid events (schema validation failure) return 400 with field-level error details.
- Response is 202 Accepted (async processing).
- Logs include event_id and user_id but no attention signal values.

**Testing:**
- Integration: Submit valid attention event, verify stored. Submit invalid event, verify rejection. Submit as wrong user, verify 403. Submit unauthenticated, verify 401.
- Load: Verify endpoint handles expected volume without degradation.

**Dependencies:** WS-E.1.1b (schema), WS-E.1.1g (envelope/registry), WS-D.1.6 (auth middleware), WS-E.3.1 (event store), WS-E.1.5 (publisher).

**Security/Privacy:** The endpoint is the trust boundary where "client aggregates are hints, never sole truth" (Section 25.5) is enforced. Logs must never include attention values; a log-redaction test asserts no `dwell`, `bucket`, or per-item field appears in emitted log lines. Ownership check (event `user_id` == session user) prevents one user attributing attention to another.

**Observability:** Emit counters for accepted/rejected events by reason (auth, schema, ownership), and a histogram of request latency. No attention values in any metric label.

---

### WS-E.1.3b Replay protection
**ID:** WS-E.1.3b
**Ref:** Section 25.5

**Description:**
Implement replay protection for the attention ingestion endpoint. Each event includes a `nonce` (UUID, generated by the client) and a `timestamp` (ISO 8601, generated by the client). The server rejects events where: (1) the nonce has been seen before (checked against a Redis set with TTL matching the event acceptance window), (2) the timestamp is more than 5 minutes in the past or more than 30 seconds in the future (clock skew tolerance). Duplicate nonces are tracked per user in Redis with a 10-minute TTL (events older than 10 minutes are expired anyway). Response for duplicate: 409 Conflict.

**Acceptance criteria:**
- An event with a unique nonce and valid timestamp is accepted.
- An event with a previously-seen nonce is rejected with 409.
- An event with a timestamp more than 5 minutes old is rejected with 400.
- An event with a future timestamp (> 30 seconds) is rejected with 400.
- Nonce tracking expires after 10 minutes (Redis TTL).
- Replay protection does not add significant latency (< 5ms for nonce check).

**Testing:**
- Integration: Submit event, then re-submit same nonce -- verify 409. Submit with old timestamp -- verify rejection. Submit with future timestamp -- verify rejection. Wait for nonce TTL expiry, re-submit -- verify acceptance.

**Dependencies:** WS-E.1.3a (endpoint), Redis (infra), WS-E.1.1b (nonce/timestamp fields).

**Security/Privacy:** Replay protection is a named mitigation against "forged attention events" (Section 25.5). Without it, an attacker could re-submit a captured legitimate event many times to inflate an item's attention. Nonce keys are namespaced per user and expire, so the Redis set does not become an attention-history store. Edge cases: clock-skew clients near the boundary are given a 30s future tolerance; nonce collisions across users are impossible because keys are user-scoped.

---

### WS-E.1.3c Rate limiting per user
**ID:** WS-E.1.3c
**Ref:** Section 25.5

**Description:**
Implement per-user rate limiting on the attention ingestion endpoint. Configurable limits: maximum events per minute per user (default: 10), maximum events per hour per user (default: 120). Rate limiting uses a sliding window counter in Redis. When a user exceeds the limit, respond with 429 Too Many Requests and a `Retry-After` header indicating when the next request will be accepted. Graceful degradation: if Redis is unavailable, fall back to in-memory rate limiting with conservative limits (50% of configured limits). Rate limit counters are not logged as attention data (they are operational metrics only).

**Acceptance criteria:**
- Users within the rate limit can submit events normally.
- Users exceeding the per-minute limit receive 429 with Retry-After.
- Users exceeding the per-hour limit receive 429 with Retry-After.
- Rate limiting uses sliding windows, not fixed windows (prevents burst-at-boundary abuse).
- Redis unavailability triggers in-memory fallback, not an open gate.
- Rate limit configuration is environment-variable driven and changeable without redeploy.

**Testing:**
- Integration: Submit events up to and beyond the per-minute limit. Verify 429 response with Retry-After. Verify in-memory fallback when Redis is unavailable.
- Unit: Sliding window counter logic with mocked Redis.

**Dependencies:** WS-E.1.3a (endpoint), Redis (infra).

**Security/Privacy:** Rate limits are a named mitigation against forged attention events and bot loops (Sections 25.5, 30.5). The fail-closed fallback (conservative in-memory limits when Redis is down) ensures an outage cannot open a flood gate. Counters are operational metrics; they must not be persisted to the attention store or logged with item identity.

---

### WS-E.1.3d Privacy-level enforcement
**ID:** WS-E.1.3d
**Ref:** Sections 19.2, 19.3

**Description:**
Before storing an attention event, check the submitting user's privacy settings (from WS-D.1.1b). If `personalization_enabled` is false, reject the event with a 204 No Content response (silently discard -- the client should not be sending events, but the server enforces the boundary regardless). If `attention_retention_preference` is `none`, accept the event for real-time aggregation but mark it for immediate deletion after the current ranking window (do not persist to long-term storage). If `attention_retention_preference` is `minimal`, apply the shortest retention tier. Log the privacy enforcement decision (without the event data) for compliance audit.

**Acceptance criteria:**
- Events from users with `personalization_enabled: false` are discarded with 204.
- Events from users with `attention_retention_preference: none` are processed but not persisted long-term.
- Events from users with `attention_retention_preference: minimal` use the shortest retention window.
- Events from users with default settings are stored normally.
- Privacy enforcement is logged for compliance (user_id, enforcement_action, no event data).
- The server enforces privacy settings even if the client fails to respect them.

**Testing:**
- Integration: Submit events with each privacy setting combination. Verify storage/discard behavior. Verify compliance logs.

**Dependencies:** WS-E.1.3a (endpoint), WS-D.1.1b (privacy settings), WS-D.2 (privacy controls), WS-E.3.1 (store with per-row retention).

**Security/Privacy:** This is the server-side enforcement of user privacy controls (Section 19.3): the boundary holds even against a misbehaving or compromised client. Enforcing `personalization_enabled: false` server-side is a defense-in-depth control against attention surveillance. The compliance log records the decision but never the event payload, so the audit trail itself does not become a behavioral record. Edge case: a setting change mid-session must take effect on the next event without restart.

---

### WS-E.1.3e Privacy-level enforcement for source-open events
**ID:** WS-E.1.3e
**Ref:** Sections 19.2, 19.3, 21.3

**Description:**
Provide ingestion for `source.opened.aggregate` events. These may arrive on the same `POST /v1/events/attention` endpoint as a discriminated variant, or on a sibling route, but they MUST pass the identical authentication, ownership check, replay protection (WS-E.1.3b), rate limiting (WS-E.1.3c), and privacy-level enforcement (WS-E.1.3d) as `attention.aggregate`. Source-open events carry `source_id` and a `bounce` flag; enforce that no full off-app browsing history is implied (Section 19.2: "no full browsing history outside the app") -- the event references an in-app `story_id`/`source_id` pair only, never an arbitrary external URL beyond the already-public canonical source.

**Acceptance criteria:**
- `source.opened.aggregate` events are validated, authenticated, ownership-checked, replay-protected, rate-limited, and privacy-enforced identically to `attention.aggregate`.
- The event references only in-app `story_id`/`source_id`; arbitrary external URLs are rejected.
- `bounce: true` source-opens are accepted but flagged so scoring can apply the clickbait guardrail (Section 5.3).
- Privacy enforcement (personalization off, retention preference) applies identically.

**Testing:**
- Integration: Submit source-open events through every guard (auth, replay, rate limit, privacy). Verify external-URL rejection. Verify bounce flag is preserved end to end.

**Dependencies:** WS-E.1.1b (schema), WS-E.1.3a-d (shared ingestion guards).

**Security/Privacy:** Source-open events are the closest the system comes to "browsing history"; this task ensures they reference only in-app, already-public source identifiers and never reconstruct an external browsing trail (Section 19.2). All forged-event mitigations apply.

---

### WS-E.1.4 Scheduled retention and anonymization jobs
**ID:** WS-E.1.4
**Ref:** Section 22.4, Sections 19.2, 19.3

**Description:**
Implement scheduled jobs that enforce the retention tiers from WS-E.1.1f against the event store and aggregation tables. Jobs: (1) `retention.sweep.attention_raw` -- delete any raw attention rows older than 7 days (raw rows should rarely exist; this is a backstop); (2) `retention.sweep.attention_aggregated` -- for aggregated attention features older than the configured window (90-180d), either delete or anonymize (strip `user_id_or_privacy_bucket` to a privacy bucket) per policy, retaining anonymized features only where needed for audit; (3) `retention.sweep.ranking_log` -- delete ranking/invariant logs older than 180-365d; (4) `retention.sweep.honor_preference` -- delete rows marked for `attention_retention_preference: none` after their ranking window; (5) `retention.review.moderation` -- flag moderation rows for annual human review rather than auto-deleting (legal-need based). Each job is idempotent, batched, observable, and emits a `privacy.request.created`-style audit record summarizing counts deleted/anonymized (no payloads). Jurisdictional overrides are read from WS-N configuration.

**Acceptance criteria:**
- Each retention tier has a scheduled sweep that respects its configured window.
- Aggregated attention is anonymized or deleted past its window; anonymization strips direct user identity to a privacy bucket.
- Rows marked for immediate deletion (`attention_retention_preference: none`) are removed after the ranking window.
- Moderation rows are flagged for annual review, not auto-deleted, honoring legal-need retention.
- Jobs are idempotent and batched (a partial run can be safely re-run).
- An audit query can verify retention compliance (no rows exceed their tier window).
- Jurisdiction-specific overrides from WS-N are applied at job time.

**Testing:**
- Integration: Seed rows older than each tier window, run sweeps, verify deletion/anonymization. Verify idempotency (re-run produces no change). Verify moderation rows are flagged not deleted. Verify the compliance audit query returns zero over-retained rows.
- Unit: Window-boundary math for each tier; jurisdiction override resolution.

**Dependencies:** WS-E.1.1f (tiers), WS-E.3.1 (event store), WS-E.2.1d (Signal Ledger retention coupling), WS-N (jurisdiction overrides), WS-D.2 (privacy request flows).

**Security/Privacy:** Retention jobs are the mechanism that makes Section 22.4 real rather than aspirational. Anonymization (not just deletion) of aggregated features balances audit needs against data minimization. The audit query is itself a compliance artifact for transparency reporting (WS-P.2). Deleting attention data on user request (Section 19.3) is enforced here as well as at WS-D.2. Edge case: a deletion request that arrives mid-sweep must not be lost; sweeps and on-demand deletions share the same delete path.

---

### WS-E.1.5 Event publisher and consumer router
**ID:** WS-E.1.5
**Ref:** Sections 21.3, 21.5

**Description:**
Implement the event publishing and consumer-routing layer. After an event is validated and stored (WS-E.3.1), publish it to the event stream (Redis Streams or equivalent) keyed by topic. Implement a consumer router that subscribes named consumers to topic sets from the registry (WS-E.1.1g). Enforce two routing invariants at the router boundary: (1) the pay-to-rank firewall -- Knomosis topics (WS-E.1.2) can never be delivered to PWAtt/ranking consumers; (2) classification-based delivery -- `restricted` topics are deliverable only to consumers holding the corresponding access role. Provide at-least-once delivery with consumer-side idempotency (events carry `event_id`), dead-letter handling for repeatedly failing consumers, and per-consumer lag metrics.

**Acceptance criteria:**
- Validated events are published to the stream keyed by topic.
- Named consumers subscribe to topic sets defined in the registry.
- Knomosis topics are never routed to PWAtt/ranking consumers (firewall enforced and tested).
- `restricted` topics are routed only to authorized consumers.
- Delivery is at-least-once with `event_id`-based idempotency on consumers.
- Repeatedly failing events go to a dead-letter queue, not an infinite retry loop.
- Per-consumer lag is observable.

**Testing:**
- Integration: Publish events, verify named consumers receive their topics. Attempt to route a Knomosis topic to a scoring consumer -- verify rejection. Verify `restricted` topic routing requires a role. Verify dead-letter after N failures. Verify idempotent re-delivery does not double-count.
- Unit: Router subscription validation against the registry.

**Dependencies:** WS-E.1.1g (registry), WS-E.1.2 (Knomosis flag), WS-E.3.1 (store), WS-E.2.1a (aggregation consumer is a subscriber).

**Security/Privacy:** The router is where the pay-to-rank firewall and classification-based access become operational at runtime. At-least-once + idempotency prevents an attacker from amplifying attention via duplicate delivery. Dead-lettering prevents a poisoned event from stalling the scoring pipeline.

---

## WS-E.3 Event storage and real-time aggregation

### WS-E.3.1 Structured event store (PostgreSQL)
**ID:** WS-E.3.1
**Ref:** Sections 21.3, 22.1, 22.4

**Description:**
Implement the durable, structured event store in PostgreSQL using Drizzle ORM. Define an `events` table partitioned by retention tier (or by topic family) so retention sweeps can drop partitions efficiently: columns include `event_id` (PK), `event_type`, `topic`, `timestamp`, `privacy_classification`, `retention_tier`, `payload` (validated JSON conforming to the topic schema), `owner_user_id` (nullable; set for owned events, used for deletion-on-request), `created_at`, and `purge_after` (computed from tier + jurisdiction override). Define the `AttentionAggregate` table per Section 22.1 with exact field names (`aggregate_id`, `user_id_or_privacy_bucket`, `story_id`, `session_bucket`, `active_dwell_bucket`, `source_opened`, `context_opened`, `branch_depth_bucket`, `return_visit_count_bucket`, `privacy_level`, `created_at`). Index for the access patterns: by `owner_user_id` (deletion/export), by `(topic, timestamp)` (replay), by `purge_after` (retention sweeps).

**Acceptance criteria:**
- The `events` table stores validated payloads with classification, tier, and `purge_after`.
- The `AttentionAggregate` table matches the Section 22.1 entity field-for-field.
- Partitioning enables efficient retention drops (sweeps do not full-scan).
- Indexes support deletion-by-user, export-by-user, replay-by-topic, and purge-by-time.
- Writing an event with a missing classification or tier is rejected at the storage layer (defense in depth over schema validation).
- Owned events record `owner_user_id` so privacy deletion can find them.

**Testing:**
- Integration: Insert one event per topic, query by each access pattern, verify performance on indexed paths. Verify `AttentionAggregate` field parity with the SPEC entity. Verify a tier-less write is rejected.
- Migration: Forward and rollback migrations apply cleanly.

**Dependencies:** WS-E.1.1f/g (tiers, registry), WS-0 (Drizzle, Postgres infra), WS-D.1.1 (user table for FK on `owner_user_id`).

**Security/Privacy:** The store is the system of record for all events; partition-by-retention makes deletion provably complete and efficient (a partition drop leaves no orphaned rows). `owner_user_id` indexing makes Section 19.3 deletion/export tractable. The storage-layer classification check is defense in depth: even a code path that bypassed schema validation cannot persist an unclassified event.

---

### WS-E.3.2 Real-time aggregation (Redis)
**ID:** WS-E.3.2
**Ref:** Sections 5.4, 21.3

**Description:**
Implement the Redis real-time aggregation layer that maintains low-latency, per-item rolling counters consumed by the 1-hour PWAtt window. As attention/contribution events are published (WS-E.1.5), increment per-item, per-signal-type counters in Redis (e.g., HyperLogLog for unique-user counts to bound memory, sorted sets for recency). Counters are short-lived (TTL aligned to the real-time window) and are reconciled against the authoritative PostgreSQL aggregation (WS-E.2.1a) on each scheduled window. Real-time counters never persist attention beyond the window and are excluded from long-term storage. Provide a clean handoff: the durable aggregation (WS-E.2.1a) is the source of truth; Redis is an acceleration layer that can be rebuilt from the event store.

**Acceptance criteria:**
- Per-item, per-signal counters update in near-real-time as events arrive.
- Unique-user counts use a bounded-memory structure (e.g., HyperLogLog) with documented error bounds.
- Counters have TTLs aligned to the real-time window and do not persist attention long-term.
- Redis counters are reconciled with the durable PostgreSQL aggregation each window.
- The acceleration layer is fully rebuildable from the event store (no unique state in Redis).
- Counters honor `attention_retention_preference: none` (such events feed real-time but leave no durable trace).

**Testing:**
- Integration: Publish events, verify Redis counters update. Verify TTL expiry. Verify reconciliation matches PostgreSQL aggregation within HLL error bounds. Verify rebuild-from-store reproduces counters.
- Unit: Counter update and unique-count estimation logic.

**Dependencies:** WS-E.1.5 (publisher), WS-E.2.1a (durable aggregation reconciliation), Redis (infra).

**Security/Privacy:** Redis holds only short-lived, bucketed, per-item aggregates -- never raw signals and never long-term attention. Making it rebuildable-and-disposable ensures it is not a shadow attention database. HLL bounds memory and incidentally adds noise to unique counts, which is privacy-favorable. Honoring `none` retention preference here closes the loophole where a real-time cache could outlive the user's chosen retention.

---

## WS-E.2 PWAtt scoring

### WS-E.2.1a Event aggregation per item/window
**ID:** WS-E.2.1a
**Ref:** Section 5.4

**Description:**
Implement the event aggregation layer that feeds PWAtt scoring. For each item (story/thread), aggregate attention and contribution events into time-bucketed windows. Configurable window sizes: 1 hour (real-time), 6 hours, 24 hours, 7 days. Each window produces: total unique users with active attention, total source opens, total context opens, total return visits, contribution counts by type, and anti-signal event counts. Aggregation runs as a scheduled job (per window size) and as a triggered computation when event volume exceeds a threshold. Results are stored in a dedicated `AggregationWindow` table with a composite key of (item_id, window_start, window_size). Deduplication: a user's attention in the same window for the same item is counted once (per signal type).

**Acceptance criteria:**
- Aggregation produces correct counts for each signal type within each window.
- User deduplication within a window is enforced (one user's repeated attention does not inflate counts).
- All configured window sizes produce results.
- Aggregation is idempotent (re-running produces the same results).
- Results are stored in `AggregationWindow` with correct composite keys.
- Aggregation performance: 1-hour window completes within 30 seconds for up to 10,000 events.

**Testing:**
- Integration: Insert known events, run aggregation, verify counts. Test deduplication with repeated events from the same user. Test idempotency by running twice. Verify window boundaries.
- Unit: Aggregation logic with mock event data.

**Dependencies:** WS-E.3.1 (event store), WS-E.3.2 (real-time reconciliation), WS-E.1.5 (consumer subscription).

**Security/Privacy:** Per-user-per-window deduplication is the first structural defense against single-user inflation and refresh loops (Section 30.5 forbids refresh-loop amplification). Aggregation reads only bucketed events; no raw attention is reconstructable from `AggregationWindow`.

---

### WS-E.2.1b Active attention scoring
**ID:** WS-E.2.1b
**Ref:** Sections 5.3, 5.4

**Description:**
Implement the ActiveAttention component of the PWAtt formula (Section 5.4). For each item in a window, compute: active dwell score (from bucketed dwell values, with per-item caps -- no single item can accumulate unlimited dwell), idle-filtered (events with `bounce: true` or `dwell_bucket: brief` receive zero or minimal weight), source-open weighting (opening the original source is weighted higher than headline-only reading -- but do not reward clickbait if the user immediately returns, per Section 5.3), context-open weighting (opening context cards, source history, or claim timeline counts once per meaningful session). The score is bounded: per-user/item contribution is capped (a single user cannot inflate an item's attention score), and total attention score is normalized to a 0-1 range within the window.

**Acceptance criteria:**
- Active dwell is computed from bucketed values with per-item caps.
- Idle time and screen-on inactivity (bounce) are filtered out.
- Source opens are weighted higher than headline-only reading.
- Source opens with immediate bounce (clickbait indicator) receive zero weight.
- Context opens are counted once per session.
- Per-user/item contribution is capped.
- Output score is in the 0-1 range.
- The scoring function is pure (same inputs produce same outputs) for reproducibility.

**Testing:**
- Unit: Compute scores for known input combinations. Verify caps are enforced. Verify bounce filtering. Verify source-open/bounce interaction. Verify output is 0-1.
- Property-based: Random valid inputs always produce scores in 0-1. Increasing genuine attention does not decrease score. Adding bounce events does not increase score.

**Dependencies:** WS-E.2.1a (aggregation), WS-E.1.1b (bucketed inputs).

**Security/Privacy:** The bounce/clickbait guardrail and dwell caps implement Section 5.3 anti-gaming rules directly. Purity of the function is required for reproducibility (Section 30.6) and for the shadow-mode equivalence test (WS-E.2.1e). Passive/idle time contributes nothing, honoring Section 30.5's prohibition on background-time amplification.

---

### WS-E.2.1c Participation scoring
**ID:** WS-E.2.1c
**Ref:** Sections 5.3, 5.4

**Description:**
Implement the ConstructiveParticipation component of the PWAtt formula. For each item in a window, compute: return-visit weighting (returning after time away indicates sustained interest, but obsessive loops are not rewarded -- per Section 5.3), save-for-later weighting (private saves receive low rank weight), contribution type weighting (initial v0 uses uniform weights for constructive types, with `low_info_reply` receiving zero constructive weight). Anti-signals from Section 5.3 are applied: rapid repetitive commenting dampens participation weight, coordinated bursts apply MFCI penalty placeholder (flagged for review), rage-loop behavior does not convert to positive attention. Output is a 0-1 score, bounded per user per item per window.

**Acceptance criteria:**
- Return visits are weighted positively with diminishing returns for obsessive patterns.
- Save-for-later contributes low weight.
- Contribution types receive weights (v0: uniform for constructive types, zero for low_info_reply).
- Anti-signals dampen scores: rapid commenting, coordinated bursts, rage loops.
- Per-user/item/window caps prevent single-user inflation.
- Output is 0-1.
- Anti-signal application is logged for transparency (signal type, dampening applied).

**Testing:**
- Unit: Score computation with known inputs. Verify return-visit diminishing returns. Verify save-for-later low weight. Verify anti-signal dampening. Verify low_info_reply receives zero constructive weight.
- Property-based: Constructive contributions always increase score (up to cap). Anti-signals never increase score.

**Dependencies:** WS-E.2.1a (aggregation), WS-E.1.1c (contribution types).

**Security/Privacy:** Save-for-later is private by default and gets low/no rank weight (Section 19.2). The "anti-signals never increase score" property is a hard invariant tested via property-based tests; it is the line that prevents outrage and rage-loops from being laundered into distribution. Anti-signal logging feeds the Signal Ledger (WS-E.2.1d) so dampening is transparent to the affected user.

---

### WS-E.2.1d Signal Ledger population
**ID:** WS-E.2.1d
**Ref:** Sections 5.3, 19.3

**Description:**
Populate the private Signal Ledger for each user. After PWAtt v0 scores are computed, write a per-item signal breakdown to the user's private ledger: which attention signals were counted (active dwell bucket, source open, context open, return visits), which participation signals were counted (contribution types), which anti-signals were applied, and the resulting PWAtt v0 score. The ledger is visible only to the user through `GET /v1/profile/signal-ledger` (Section 6.2 -- Profile tab). It shows a plain-language summary for each item (e.g., "You read this for a moderate duration, opened the source, and returned once. Your question was counted as constructive participation."). No other user can see another user's ledger. The ledger respects the user's `attention_retention_preference`.

**Acceptance criteria:**
- Each user's Signal Ledger shows their per-item signal breakdown.
- The ledger includes attention signals, participation signals, and anti-signals applied.
- Plain-language summaries are generated for each item.
- `GET /v1/profile/signal-ledger` returns only the authenticated user's ledger.
- Attempting to access another user's ledger returns 403.
- Ledger entries respect the user's retention preference (deleted when attention data expires).
- Ledger data is excluded from public API responses and search indexes.

**Testing:**
- Integration: Compute PWAtt for a user's activity. Verify Signal Ledger contains correct breakdown. Verify API returns only the user's own ledger. Verify retention-preference enforcement.
- E2E: View Signal Ledger in the profile UI.

**Dependencies:** WS-E.2.1a-c (scores and signals), WS-E.1.4 (retention coupling), WS-D.2 (privacy preferences), WS-B.2 (profile UI surface).

**Security/Privacy:** The Signal Ledger is the user's transparency window into the otherwise-opaque scoring (Section 19.3). It is `aggregated` data, strictly owner-only; the 403-on-other-user test and the search-index-exclusion test are mandatory. Retention coupling ensures the ledger does not become a longer-lived attention archive than the user chose. It also shows anti-signal dampening so users understand (and can appeal) why participation was downweighted.

---

### WS-E.2.1e Shadow mode verification
**ID:** WS-E.2.1e
**Ref:** Section 30.5

**Description:**
Verify that PWAtt v0 scores are computed and logged but never affect ranking or distribution. Implement a shadow-mode guard: the PWAtt v0 output is stored in the `InvariantOutput` table with `invariant_type: PWAtt_v0` and a `shadow_mode: true` flag. The ranking service (WS-I) must reject any attempt to read PWAtt v0 scores as ranking inputs. Create an automated test that: (1) computes PWAtt v0 scores for test items, (2) runs the ranking pipeline, (3) verifies that the ranking output is identical regardless of PWAtt v0 scores (ranking uses only freshness/baseline in v0). The shadow-mode flag is checked at the ranking service boundary, not trusted from the PWAtt output.

**Acceptance criteria:**
- PWAtt v0 scores are stored in `InvariantOutput` with `shadow_mode: true`.
- The ranking service rejects PWAtt v0 scores as inputs (returns an error or ignores them).
- An automated test proves ranking output is identical with and without PWAtt v0 scores.
- Removing the shadow-mode flag requires a code change (not a configuration change) to prevent accidental promotion.
- PWAtt v0 scores are visible in the Signal Ledger but do not affect what users see in feeds.

**Testing:**
- Integration: Compute scores, run ranking, verify ranking is unaffected. Modify scores, re-run ranking, verify ranking is still identical.
- CI: Shadow-mode verification test runs on every PR.

**Dependencies:** WS-E.2.1a-d (v0 scores), WS-I (ranking boundary), WS-H.1 (`InvariantOutput` table).

**Security/Privacy:** Shadow-mode verification is the structural guarantee behind the "PWAtt v0 has zero distribution power" mandate (Section 30.5) and a named mitigation for invariant cold-start risk. Requiring a code change (not config) to lift shadow mode prevents accidental or unreviewed promotion. The CI gate makes regressions impossible to merge silently.

---

### WS-E.2.2a Coordinated-burst detection (anti-signal -> MFCI)
**ID:** WS-E.2.2a
**Ref:** Sections 5.3, 8, 25.5

**Description:**
Implement PWAtt v0 anti-signal handling for coordinated bursts. When event aggregation (WS-E.2.1a) observes a burst of attention/participation on an item that exceeds normal base rates, emit an `integrity.signal.detected` event with `signal_type: coordinated_burst` and a confidence score, and route it to MFCI (WS-H.3) for base-rate-conditioned evaluation. In v0 (shadow), the detection produces a flagged review item and a Signal Ledger annotation but applies only a placeholder participation dampening (no ranking power, consistent with shadow mode). The detector conditions on normal base rates (time of day, topic popularity, community activity) so that an active community is not punished merely for being active (Section 8). Provide a tunable burst threshold and a minimum-distinct-actors guard to avoid single-user false positives.

**Acceptance criteria:**
- Bursts exceeding base-rate thresholds emit `integrity.signal.detected` (`coordinated_burst`) with confidence.
- Detection conditions on base rates (active communities are not flagged for activity alone).
- A minimum-distinct-actors guard prevents single-user false positives.
- In v0, detection annotates the Signal Ledger and review queue but does not affect ranking (shadow).
- Burst thresholds are configurable without code change.
- Detected bursts are forwarded to MFCI for conditioned evaluation (WS-H.3).

**Testing:**
- Unit: Synthetic burst exceeding base rate triggers detection; an equivalently active but organic pattern does not. Verify distinct-actor guard.
- Integration: Burst events produce an `integrity.signal.detected` event and a review-queue item; verify no ranking effect in v0.

**Dependencies:** WS-E.2.1a (aggregation), WS-E.1.1d (integrity signal schema), WS-H.3 (MFCI), WS-J.2 (review queue).

**Security/Privacy:** Coordinated-burst detection is a named defense against coordinated brigading and forged attention (Section 25.5). Base-rate conditioning is the key fairness control (Section 8) -- it is also a named mitigation for false-coordination positives. Keeping v0 in shadow ensures detection is validated before it gains enforcement power.

---

### WS-E.2.2b Source-free-accusation downweight (anti-signal)
**ID:** WS-E.2.2b
**Ref:** Section 5.3

**Description:**
Implement the source-free-accusation anti-signal. When a contribution is classified as an accusation (a claim of wrongdoing or a serious factual assertion about a person/entity) but carries no citation (`has_citation: false` and no linked `evidence.added`), downweight its participation contribution and annotate it in the Signal Ledger as "downweighted: requires supporting evidence." This does not remove or hide the contribution (that is moderation's job, WS-J); it only prevents an unsupported serious accusation from accumulating constructive-participation weight (Section 5.3: "Source-free accusation -- requires evidence or is downweighted"). The accusation classification can begin with a conservative heuristic/lexical signal in v0, with the AI classifier (WS-K) integrated later; v0 must err toward NOT downweighting ordinary opinion or routine disagreement.

**Acceptance criteria:**
- Accusatory contributions without citations receive downweighted participation contribution.
- The downweight is annotated in the Signal Ledger transparently.
- Ordinary opinion and routine disagreement are NOT downweighted (conservative v0 heuristic).
- Downweighting affects scoring only, not visibility or moderation status.
- A later AI-classifier integration point (WS-K) is documented.

**Testing:**
- Unit: Accusation-without-citation is downweighted; the same accusation with an evidence card is not. Ordinary opinion is not downweighted. Verify Signal Ledger annotation.
- Integration: Full participation scoring with mixed cited/uncited accusations.

**Dependencies:** WS-E.2.1c (participation scoring), WS-E.1.1c (`has_citation`), WS-E.2.1d (ledger), WS-K (later classifier).

**Security/Privacy:** This anti-signal protects targets from unsupported serious accusations gaining algorithmic reach, while explicitly preserving speech (it downweights ranking, not visibility). The conservative v0 bias toward not-downweighting avoids chilling legitimate criticism. Transparency via the ledger lets contributors understand and remedy the downweight by adding evidence.

---

### WS-E.2.2c Harassment-cascade freeze and safety review (anti-signal)
**ID:** WS-E.2.2c
**Ref:** Sections 5.3, 18.2, 30.5

**Description:**
Implement the harassment-cascade anti-signal. When integrity/safety systems detect a cascade of hostile attention directed at a target (e.g., a rapid influx of hostile returns, pile-on replies, or a `harassment_cascade` integrity signal), immediately freeze ranking growth for the implicated content and route a high-priority safety-review case (Section 5.3: "Harassment cascade -- freeze ranking growth, apply safety review, protect targets"). The freeze is the same mechanism formalized in WS-E.2.3e (safety-state growth freeze): new attention/participation events continue to populate the Signal Ledger for transparency but do not increase ranking score. Target-protection actions (escalation to WS-J safety queues, optional visibility limits on the implicated content) are triggered. In v0 (shadow, no ranking power), the "freeze" is a no-op on ranking but still creates the safety case and records the would-be freeze, so the workflow is validated before v1.

**Acceptance criteria:**
- A detected harassment cascade emits `integrity.signal.detected` (`harassment_cascade`) and opens a high-priority safety case.
- Ranking growth for implicated content is frozen (v1) / recorded-as-would-freeze (v0 shadow).
- Attention events continue to populate the Signal Ledger during a freeze.
- Target-protection escalation to WS-J safety queues is triggered.
- Freeze/case transitions are logged for audit.

**Testing:**
- Unit: Cascade pattern triggers detection and a safety case; isolated criticism does not.
- Integration: Cascade freezes ranking growth (v1) while Signal Ledger still records events; verify safety case creation and escalation.

**Dependencies:** WS-E.1.1d (integrity signal), WS-E.2.3e (freeze mechanism), WS-J.1/WS-J.2 (safety queues), WS-E.2.1d (ledger).

**Security/Privacy:** Harassment-cascade handling is a named mitigation for harassment raids (Section 25.5) and directly implements the Section 5.3 target-protection rule. Validating the freeze workflow in v0 shadow (case created, would-freeze recorded) ensures target protection is exercised before it carries ranking consequences. Continuing ledger population during a freeze preserves transparency without granting the cascade distribution.

---

### WS-E.2.3a Saturation curves
**ID:** WS-E.2.3a
**Ref:** Section 30.5, Section 5.5

**Description:**
Implement per-user/item/window saturation curves for PWAtt v1. Each signal dimension (active attention, participation, source opens, etc.) follows a diminishing-returns curve: the marginal contribution of the Nth signal of the same type from the same user for the same item decreases. No single signal can dominate the total score. The saturation function is configurable (logarithmic or sigmoid) with per-dimension parameters. Parameters are stored in a configuration table and are tunable without code changes. The saturation curve applies after raw aggregation and before weight application.

**Acceptance criteria:**
- The first instance of a signal contributes more than the second, which contributes more than the third, etc.
- No single signal dimension can exceed 50% of the total positive score regardless of volume.
- Saturation curves are per-user/item/window (a user's signal for item A does not saturate item B).
- Curve parameters are configurable (stored in database, not hardcoded).
- Changing parameters does not require a code deployment.
- Saturation is applied consistently across all signal types.

**Testing:**
- Unit: Feed increasing volumes of a single signal type -- verify diminishing marginal contribution. Verify no dimension exceeds 50% of total. Test with logarithmic and sigmoid curves.
- Property-based: Adding more of any signal never decreases the total score. No dimension exceeds its configured cap regardless of input volume.

**Dependencies:** WS-E.2.1a (aggregation), WS-E.2.1b/c (per-dimension inputs).

**Security/Privacy:** Saturation curves are the v1 structural defense against volume-based gaming and single-dimension domination (Sections 5.5, 30.5). Per-user/item/window scoping ensures one prolific actor cannot saturate the score for everyone. Tunable-without-deploy parameters allow rapid response to emerging gaming patterns.

---

### WS-E.2.3b Contribution type weighting hierarchy
**ID:** WS-E.2.3b
**Ref:** Sections 5.3, 15.1

**Description:**
Implement the contribution type weighting hierarchy for PWAtt v1. Types are weighted in descending order: evidence (highest -- adding primary sources, datasets, citations), correction (identifying errors with supporting evidence), synthesis (fair summary of multiple branches), question (clarifying questions that elicit useful answers), counterexample (relevant exceptions broadening the evidence base), explanation (domain context that is nonredundant and useful), low_info_reply (lowest -- counts as volume but not constructive participation). Bridge comments receive strong positive weight when SCOI decreases. Steward actions receive positive weight for thread health. Weights are relative multipliers applied to the participation score.

**Acceptance criteria:**
- Evidence contributions receive the highest weight.
- Low-information replies receive zero or near-zero constructive weight.
- The weight ordering matches the hierarchy: evidence > correction > synthesis > question > counterexample > explanation > low_info_reply.
- Weights are configurable (stored in configuration, not hardcoded).
- Bridge comments are weighted based on SCOI reduction (placeholder in v1, full integration in v2).
- Steward actions contribute to thread health, not personal ranking.

**Testing:**
- Unit: Compute participation scores with one contribution of each type -- verify ordering. Verify low_info_reply produces near-zero contribution. Verify evidence produces the highest contribution.
- Integration: Full PWAtt computation with mixed contribution types -- verify hierarchy affects output.

**Dependencies:** WS-E.2.1c (participation scoring), WS-E.1.1c (contribution types), WS-H.4 (SCOI for bridge weighting placeholder).

**Security/Privacy:** The hierarchy operationalizes Section 5.3's participation table: it rewards substantiation and bridge work over volume. `low_info_reply` getting near-zero weight prevents reply-spam from earning distribution. Bridge weighting tied to SCOI reduction (placeholder in v1) avoids rewarding performative "bridging" that does not actually reduce cross-community obstruction.

---

### WS-E.2.3c Weight normalization
**ID:** WS-E.2.3c
**Ref:** Section 5.5

**Description:**
Implement weight normalization for the five positive PWAtt components. Per Section 5.5, the positive weights (wA, wP, wE, wS, wC) must sum to exactly 100% for each ranking profile. Guardrail ranges: wA (Active attention) 20-30%, wP (Constructive participation) 25-40%, wE (Exposure independence) 10-20%, wS (Evidence/source completeness) 5-15%, wC (Context coherence gain) 5-15%. A ranking profile is a named weight configuration (e.g., "breaking_news": wA=30, wP=25, wE=15, wS=15, wC=15; "evergreen_science": wA=20, wP=40, wE=15, wS=15, wC=10). Validation: reject any profile where weights do not sum to 100% or any weight is outside its guardrail range. Profiles are stored in a configuration table and selected based on surface, topic sensitivity, freshness, and risk state.

**Acceptance criteria:**
- Weights for any profile sum to exactly 100%.
- Each weight is within its guardrail range (wA 20-30%, wP 25-40%, wE 10-20%, wS 5-15%, wC 5-15%).
- Profile selection is based on context (surface, topic, freshness, risk).
- Invalid profiles (sum != 100%, weights outside range) are rejected at configuration time.
- At least two default profiles are defined (breaking news, evergreen discussion).
- Profile changes are logged for audit.

**Testing:**
- Unit: Validate profiles that sum to 100% (accepted). Validate profiles that do not sum to 100% (rejected). Validate profiles with out-of-range weights (rejected). Verify all guardrail combinations are jointly satisfiable.
- Integration: Compute PWAtt with different profiles -- verify weight application.

**Dependencies:** WS-E.2.1b/c (component scores), WS-E.2.3a (saturated inputs), WS-I (surface/profile selection context).

**Security/Privacy:** The sum-to-100% convex-combination invariant (Section 5.5) is what keeps positive weights bounded and interpretable, and it is structurally separate from penalties (WS-E.2.3d). Config-time rejection of invalid profiles prevents a misconfiguration from silently rebalancing distribution. Profile-change audit logging supports transparency reporting (WS-P.2). Profiles vary by surface/topic/freshness/risk but never by payment or wallet state (pay-to-rank firewall).

---

### WS-E.2.3d Penalty integration
**ID:** WS-E.2.3d
**Ref:** Section 5.4

**Description:**
Integrate the four penalty terms into the PWAtt formula. Penalties are separate nonnegative coefficients on risk terms -- they are not part of the convex combination of positive weights (Section 5.5). Terms: `pM * CoordinationPenalty` (derived from MFCI -- coordinated burst detection, Section 8), `pH * HolonomyRisk` (derived from PHI -- path-dependent steering risk), `pT * HarmfulTensionRisk` (derived from Hodge tension combined with safety classifiers), `pR * RedundancyPenalty` (derived from MERI -- duplicate content dampening). Each penalty coefficient is configurable and nonnegative. Penalties can drive the total score below zero (a high-risk item's penalties can dominate any positive contribution). In v1, MFCI and MERI provide initial penalty values; PHI and Hodge provide placeholder values pending their v0 implementations in WS-H.

> **Note (v0.7.3):** this WS-E `packages/invariants/pwatt` penalty structure (the shadow scorer's placeholder set, with `pH`/`pT` pinned to 0) is separate from the **served §5.4 composite**, which is composed per-request by `@licio/ranking`. The served composite now carries only **three** penalty terms — the per-item `pH * HolonomyRisk` was removed, because holonomy is a per-user signal realized as the per-user diversification constraint, not a per-item penalty (see SPEC §5.4 and `docs/ranking/README.md`). This WS-E placeholder set is unchanged.

**Acceptance criteria:**
- Penalty terms are subtracted from the positive score, not included in the 100% weight normalization.
- Each penalty coefficient is nonnegative and configurable.
- Penalties can drive the total score below zero.
- In v1, pM (coordination) and pR (redundancy) use real values from MFCI/MERI.
- In v1, pH (holonomy) and pT (tension) use placeholder zero values.
- Penalty application is logged (which penalties applied, values, resulting score change).

**Testing:**
- Unit: Compute PWAtt with penalties -- verify subtraction from positive score. Verify penalties can drive score below zero. Verify placeholder penalties have no effect. Verify penalty coefficients are nonnegative.
- Integration: Compute scores with MFCI/MERI penalty values from test data.

**Dependencies:** WS-E.2.3c (positive score), WS-H.2 (MERI -> pR), WS-H.3 (MFCI -> pM), WS-H.6 (PHI -> pH placeholder), WS-H.7 (Hodge -> pT placeholder).

**Security/Privacy:** Keeping penalties as separate nonnegative terms outside the convex combination (Section 5.5) is what lets safety/manipulation risk dominate and drive a score below any positive contribution -- the core mechanism by which manipulated or harmful content is denied distribution. Nonnegativity is asserted so a penalty can never accidentally become a reward. Penalty logging supports audit and the user-facing "Under Review" label (Section 5.6).

---

### WS-E.2.3e Safety-state constraints
**ID:** WS-E.2.3e
**Ref:** Sections 5.3, 30.5

**Description:**
Implement safety-state constraints for PWAtt v1. When content is flagged by moderation (safety_state != normal), freeze the item's PWAtt growth: new attention and participation events are still counted (for Signal Ledger transparency) but do not increase the item's ranking score. Flagged content maintains its current score until the moderation case is resolved. Integrate MERI v1 redundancy dampening: if an item is identified as a near-duplicate by MERI, apply the redundancy penalty from WS-E.2.3d to prevent duplicate content from accumulating distribution power. When a moderation case is resolved (content cleared), unfreeze growth and allow normal score accumulation. When content is removed by moderation, set the PWAtt score to zero.

**Acceptance criteria:**
- Flagged content's PWAtt score does not increase while flagged.
- New attention events for flagged content are recorded in Signal Ledger but do not affect ranking score.
- Cleared content resumes normal score growth.
- Removed content has its PWAtt score set to zero.
- MERI v1 redundancy dampening applies the redundancy penalty.
- Freeze/unfreeze transitions are logged for audit.

**Testing:**
- Integration: Flag content, submit attention events, verify score does not increase. Clear content, submit events, verify score resumes growth. Remove content, verify score is zero. Apply MERI redundancy penalty, verify dampening.
- Regression: Verify freeze does not prevent Signal Ledger population.

**Dependencies:** WS-E.2.3d (redundancy penalty / MERI), WS-E.1.1e (`thread.state.changed` safety_state), WS-E.2.2c (harassment-cascade freeze uses this mechanism), WS-J.2 (moderation case lifecycle).

**Security/Privacy:** Safety-state freeze is the v1 enforcement of "freeze ranking growth, apply safety review" (Section 5.3) and the shared mechanism used by harassment-cascade handling (WS-E.2.2c). Continuing Signal Ledger population during a freeze preserves transparency without granting distribution. Zeroing removed content ensures moderation decisions fully propagate to ranking. MERI redundancy dampening prevents duplicate amplification (Section 25.5).

---

## Task dependency summary

| Task | Depends on | Blocks |
|---|---|---|
| WS-E.1.1f Retention tier enum | WS-0 | WS-E.1.1g, WS-E.1.4, WS-E.3.1 |
| WS-E.1.1g Event envelope + registry | WS-E.1.1f | WS-E.1.1a-e, WS-E.1.2, WS-E.1.5 |
| WS-E.1.1a Content schemas | WS-E.1.1g, WS-F.1 | WS-E.1.5 |
| WS-E.1.1b Attention schemas | WS-E.1.1g, WS-C.4 | WS-E.1.3a/e, WS-E.2.1b |
| WS-E.1.1c Contribution schemas | WS-E.1.1g, WS-G.1 | WS-E.2.1c, WS-E.2.2b |
| WS-E.1.1d Moderation schemas | WS-E.1.1g, WS-J.1, WS-A | WS-E.2.2a/c |
| WS-E.1.1e System schemas | WS-E.1.1g, WS-H, WS-I | WS-E.2.1e, WS-E.2.3e |
| WS-E.1.2 Knomosis schemas (flagged) | WS-E.1.1g, WS-D.3 | WS-E.1.5 (firewall), WS-L |
| WS-E.3.1 Event store (PostgreSQL) | WS-E.1.1f/g, WS-0, WS-D.1.1 | WS-E.1.3a, WS-E.1.4, WS-E.2.1a |
| WS-E.3.2 Real-time aggregation (Redis) | WS-E.1.5, WS-E.2.1a | WS-E.2.1a (1h window) |
| WS-E.1.3a POST /v1/events/attention | WS-E.1.1b/g, WS-D.1.6, WS-E.3.1, WS-E.1.5 | WS-E.1.3b-e |
| WS-E.1.3b Replay protection | WS-E.1.3a, Redis | WS-E.1.3e |
| WS-E.1.3c Rate limiting | WS-E.1.3a, Redis | WS-E.1.3e |
| WS-E.1.3d Privacy-level enforcement | WS-E.1.3a, WS-D.1.1b, WS-D.2 | WS-E.1.3e |
| WS-E.1.3e Source-open ingestion | WS-E.1.1b, WS-E.1.3a-d | WS-E.2.1a |
| WS-E.1.4 Retention/anonymization jobs | WS-E.1.1f, WS-E.3.1, WS-N, WS-D.2 | DoD (retention) |
| WS-E.1.5 Publisher + consumer router | WS-E.1.1g, WS-E.1.2, WS-E.3.1 | WS-E.2.1a, WS-E.3.2 |
| WS-E.2.1a Aggregation per item/window | WS-E.3.1, WS-E.3.2, WS-E.1.5 | WS-E.2.1b-e, WS-E.2.2a, WS-E.2.3a |
| WS-E.2.1b Active attention scoring | WS-E.2.1a, WS-E.1.1b | WS-E.2.1d/e, WS-E.2.3c |
| WS-E.2.1c Participation scoring | WS-E.2.1a, WS-E.1.1c | WS-E.2.1d/e, WS-E.2.2b, WS-E.2.3b/c |
| WS-E.2.1d Signal Ledger population | WS-E.2.1a-c, WS-E.1.4, WS-D.2 | DoD (transparency) |
| WS-E.2.1e Shadow mode verification | WS-E.2.1a-d, WS-I, WS-H.1 | M1 gate (PWAtt shadow) |
| WS-E.2.2a Coordinated-burst detection | WS-E.2.1a, WS-E.1.1d, WS-H.3 | WS-E.2.3d (pM) |
| WS-E.2.2b Source-free-accusation downweight | WS-E.2.1c, WS-E.1.1c, WS-K | PWAtt v1 |
| WS-E.2.2c Harassment-cascade freeze | WS-E.1.1d, WS-E.2.3e, WS-J | PWAtt v1 |
| WS-E.2.3a Saturation curves | WS-E.2.1a-c | WS-E.2.3c |
| WS-E.2.3b Contribution type hierarchy | WS-E.2.1c, WS-H.4 | PWAtt v1 |
| WS-E.2.3c Weight normalization | WS-E.2.3a, WS-E.2.1b/c | M3 gate (PWAtt bounded) |
| WS-E.2.3d Penalty integration | WS-E.2.3c, WS-H.2/H.3/H.6/H.7 | WS-E.2.3e |
| WS-E.2.3e Safety-state constraints | WS-E.2.3d, WS-E.1.1e, WS-J.2 | DoD (safety-state) |

---

## Workstream definition of done

WS-E is complete when ALL of the following conditions hold:

1. **Event schemas and registry:** All core event topics from Section 21.3 are defined with a shared envelope, field-level privacy classification (public, aggregated, sensitive, restricted), and retention tier, and are registered in a single topic registry. Knomosis topics are defined behind the crypto feature flag in a separate bounded context. Schema validation rejects events with missing fields, unknown keys, unknown `event_type`, or misclassification. The `AttentionAggregate` field-name mapping is documented and asserted.

2. **Ingestion hardening:** The `POST /v1/events/attention` endpoint (and the `source.opened.aggregate` ingestion path) authenticate the user, verify event ownership, apply replay protection (nonce + timestamp window), per-user sliding-window rate limiting with fail-closed fallback, and server-side privacy-level enforcement. Logs and metrics never contain attention values.

3. **Event storage and real-time aggregation:** Events persist in PostgreSQL partitioned by retention tier with indexes for deletion/export/replay/purge; the `AttentionAggregate` table matches the SPEC entity. A Redis acceleration layer maintains short-lived, rebuildable, per-item real-time counters that never persist attention long-term.

4. **Pay-to-rank firewall:** The consumer router structurally prevents Knomosis (wallet/payment/treasury/governance) topics from reaching any PWAtt or ranking consumer, and a test proves no payment/wallet field is reachable from a scoring input path.

5. **Retention enforcement:** Scheduled retention/anonymization jobs run on schedule and enforce per-tier retention limits; aggregated attention is anonymized or deleted past its window; user `attention_retention_preference` (including `none`/`minimal`) is honored; moderation rows are flagged for annual review per legal need; retention compliance is verifiable via audit query; jurisdictional overrides from WS-N apply.

6. **PWAtt v0 shadow mode:** PWAtt v0 aggregates events per item/window with per-user deduplication, computes ActiveAttention and ConstructiveParticipation with dwell caps, idle/bounce filtering, source/context-open and return-visit weighting, populates the private owner-only Signal Ledger with plain-language explanations, and is proven (by a CI-gated equivalence test) to have zero effect on ranking. Lifting shadow mode requires a code change, not a config change.

7. **PWAtt v0 anti-signals:** Coordinated-burst detection emits base-rate-conditioned integrity signals to MFCI with a distinct-actor guard; source-free accusations are downweighted (ranking only, conservatively) with ledger transparency; harassment cascades open safety cases and exercise the freeze workflow. In v0 these annotate/queue without ranking effect.

8. **PWAtt v1 saturation and weights:** PWAtt v1 implements per-user/item/window saturation (diminishing-returns) curves preventing any single dimension from exceeding its cap; positive weights (wA, wP, wE, wS, wC) are validated to sum to exactly 100% within guardrail ranges per named ranking profile; the contribution-type hierarchy (evidence > correction > synthesis > question > counterexample > explanation > low_info_reply) is applied.

9. **PWAtt v1 penalties (separate, nonnegative):** Penalty terms (pM, pH, pT, pR) are subtracted separately from the positive score, are nonnegative and configurable, and can drive scores below zero; in v1 pM/pR use real MFCI/MERI values while pH/pT are placeholders.

10. **Safety-state constraints:** Flagged content has its PWAtt growth frozen (events recorded in the Signal Ledger but score unchanged); cleared content resumes growth; removed content has its score set to zero; MERI v1 redundancy dampening is applied. All freeze/unfreeze transitions are audit-logged.

# WS-E: Event Pipeline and PWAtt

**Milestone:** M1-M2
**Priority:** P1
**Dependencies:** WS-D.1 (accounts and authentication), WS-C.4 (client signal processor)
**Wave:** 4-5
**Estimated duration:** 4-5 weeks

---

## Overview

The event pipeline ingests aggregated attention signals and feeds the PWAtt scoring engine. PWAtt is the core rating primitive -- there are no likes, no upvotes, no hearts, no reactions, and no public karma. Distribution is determined solely by privacy-preserving measures of genuine attention and constructive participation (Section 5.1). The pipeline enforces privacy classification on every event, assigns retention tiers per Section 22.4, and treats client-submitted aggregates as hints rather than sole truth (Section 25.5). PWAtt v0 runs in shadow mode (scores computed and logged but never affecting ranking or distribution), graduating to bounded ranking input only after safety review (Section 30.5).

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

---

### WS-E.1.1b Attention event schemas
**ID:** WS-E.1.1b
**Ref:** Sections 5.3, 19.2, 21.3, 22.4

**Description:**
Define zod schemas for attention events. `source.opened.aggregate`: emitted when the client reports a source-open event; fields include `event_id`, `event_type`, `timestamp`, `user_id`, `story_id`, `source_id`, `dwell_bucket` (enum: brief, moderate, extended -- bucketed to preserve privacy), `bounce` (boolean: user returned immediately), `privacy_classification` (literal `aggregated`), `retention_tier` (literal `attention_short`, max 7 days for raw, 90-180 days for aggregated). `attention.aggregate`: emitted by the client signal processor (WS-C.4) as a periodic aggregated summary; fields include `event_id`, `timestamp`, `user_id`, `session_bucket` (anonymized session identifier), `items` (array of per-item attention summaries: `story_id`, `active_dwell_bucket`, `source_opened` boolean, `context_opened` boolean, `branch_depth_bucket`, `return_visit_count_bucket`), `privacy_classification` (literal `aggregated`), `retention_tier` (literal `attention_short`). All attention values are bucketed (not raw), capped per item (Section 5.3), and idle-filtered before upload. The schema enforces that no raw scroll/touch events are included (Section 19.2).

**Acceptance criteria:**
- Schemas enforce bucketed values (enums, not raw numbers) for all attention metrics.
- `privacy_classification` is `aggregated` for all attention events.
- `retention_tier` is `attention_short` (raw <= 7 days, aggregated 90-180 days).
- No field captures raw scroll positions, touch coordinates, or precise timing.
- Per-item dwell is capped (enforced by the enum bucket, not by trusting raw numbers).
- Bounce detection is a boolean, not a duration.

**Testing:**
- Unit: Parse valid attention events. Reject events with raw (non-bucketed) dwell values. Reject events with extra fields that could carry raw data. Verify privacy classification.

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

---

### WS-E.1.1e System event schemas
**ID:** WS-E.1.1e
**Ref:** Section 21.3

**Description:**
Define zod schemas for system and operational events. `invariant.run.completed`: emitted after an invariant computation completes; fields include `event_id`, `timestamp`, `invariant_type` (enum: MERI, MFCI, SCOI, GWEI, PHI, PWAtt), `target_type`, `target_id`, `time_window`, `version`, `score_vector`, `confidence`, `computation_time_ms`, `privacy_classification` (literal `sensitive`), `retention_tier` (literal `ranking_log`, 180-365 days). `ranking.decision.logged`: emitted for each ranking decision; includes `decision_id`, `story_id`, `context` (feed, room, search), `score`, `position`, `signals_used` (array of signal types), `explanation_summary`. `notification.sent`: emitted when a notification is dispatched; includes `notification_id`, `user_id`, `notification_type`, `channel` (push, email, in_app). `privacy.request.created`: emitted when a privacy action is requested (export, deletion, attention reset); includes `request_type`, `user_id`, `status`.

**Acceptance criteria:**
- Invariant run events include version and confidence for reproducibility.
- Ranking decision events include enough detail for decision replay (Section 30.6).
- Notification events do not include the notification content (only type and channel).
- Privacy request events are classified as `sensitive`.
- All event schemas follow a consistent base shape (event_id, event_type, timestamp, privacy_classification, retention_tier).

**Testing:**
- Unit: Parse valid events for each type. Verify consistent base shape across all schemas. Verify retention tiers match Section 22.4.

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

---

### WS-E.2.3d Penalty integration
**ID:** WS-E.2.3d
**Ref:** Section 5.4

**Description:**
Integrate the four penalty terms into the PWAtt formula. Penalties are separate nonnegative coefficients on risk terms -- they are not part of the convex combination of positive weights (Section 5.5). Terms: `pM * CoordinationPenalty` (derived from MFCI -- coordinated burst detection, Section 7), `pH * HolonomyRisk` (derived from PHI -- path-dependent steering risk), `pT * HarmfulTensionRisk` (derived from Hodge tension combined with safety classifiers), `pR * RedundancyPenalty` (derived from MERI -- duplicate content dampening). Each penalty coefficient is configurable and nonnegative. Penalties can drive the total score below zero (a high-risk item's penalties can dominate any positive contribution). In v1, MFCI and MERI provide initial penalty values; PHI and Hodge provide placeholder values pending their v0 implementations in WS-H.

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

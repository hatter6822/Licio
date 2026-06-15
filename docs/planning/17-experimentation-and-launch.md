# WS-P: Experimentation, Metrics, and Launch Operations

**Milestone:** M3-M6
**Priority:** P3
**Dependencies:** WS-I (ranking and distribution), WS-H (invariant services), WS-J (trust and safety)
**Wave:** 6
**Estimated duration:** 3-4 weeks

---

## Overview

Product-health metrics measure what matters: constructive participation, invariant stability, safety responsiveness, and performance. Anti-metrics -- signals that must NEVER be optimized -- are monitored and enforced as experiment-blocking guardrails. Every experiment carries harm, fairness, and wellbeing guardrails alongside its success criteria. Transparency reports are generated from live data without manual reconstruction. No likes, upvotes, public reactions, or follower leaderboards are permitted -- even experimentally. Experiment success is never measured by engagement alone.

This workstream is governed by four invariants of its own that every task below must respect:

1. **Anti-metrics are never optimization targets.** Total dwell time, outrage engagement, compulsive session length, speculation activity, vanity status, total value locked (TVL), token trading volume, wallet-connect growth, speculative price, and treasury size may only ever appear as *guardrails* (things that must not get worse) and as *transparency-report line items*. They may never appear on a growth/product dashboard, never be set as an experiment success criterion, and never be a launch goal. This is enforced structurally (schema constraints) and not merely by policy (Sections 28.2, 28.3, 13.6).
2. **Prohibited signals can never be introduced -- even experimentally.** No experiment, metric, dashboard, or report may introduce or simulate likes, upvotes, thumbs-up, hearts, emoji reactions, public reaction counts, follower leaderboards, karma scores, or public reputation rankings. The prohibited-type check (WS-P.1.3d) is a hard, double-checked block at both creation and start (Sections 28.2, 13.6).
3. **Revenue and treasury metrics are separated from product health.** Knomosis governance and payment metrics (§28.3) and any monetization figures live in the transparency layer and finance reporting only; they are excluded from product-health dashboards and from experiment success criteria (Sections 28.3, 27).
4. **Privacy by aggregation.** Every metric, report, and experiment readout is privacy-preserving: aggregate counts only, small-cell suppression on any human-identifying breakdown, no individual user attribution, and no surveillance metric (no per-user dwell profiles, no per-user attention ledgers in dashboards) (Sections 19, 28).
5. **Private content is structurally unmeasurable -- by design, not by gap.** Per WS-S (`docs/planning/20-private-p2p-rooms.md`), `private_p2p` rooms ("Private P2P room") are member-device-hosted and end-to-end encrypted; the platform cannot read their content and therefore emits **no** server-side metrics, experiments, A/B assignments, telemetry, or transparency content-statistics for them. Every metric, experiment population, and transparency content-aggregation in this workstream is scoped to **server-hosted content** (`rooms.storage_mode = 'server'` -- the `public_server` and `restricted_server` classes). This is an honest property consistent with the E2EE guarantee, never a coverage deficiency to be "filled." Separately, **WS-R / LCAP** (`docs/planning/19-offline-content-availability.md`) introduces an **availability/liveness** metric family (verified availability per cost, sync success, "C0 control not starved") that is explicitly **not** engagement/attention/dwell, carries no attention traces or client IP/location (`check:no-raw-egress` / `check:lcap-schema-egress`), and is bound by the same no-applause doctrine -- it appears, if at all, as an availability panel, never as a growth target.

The workstream proceeds in two parts. **WS-P.1 (metrics and experimentation infrastructure)** builds metric collection, the anti-metric registry and enforcement, the Knomosis transparency-only metric set, and the experiment framework. **WS-P.2 (transparency pipeline and internationalization)** builds the report aggregation/generation/review pipeline on a published cadence, the i18n pipeline, RTL support, translation disclosure, and region-sensitive policy. WS-P.3 covers launch operations: the phase success-metric gates (§28.4) and the go/no-go review board.

---

## WS-P.1 Metrics infrastructure

### WS-P.1.1a Participation metrics
**ID:** WS-P.1.1a
**Ref:** Section 28.1

**Description:**
Implement collection and aggregation for the four core participation metrics: constructive-participation rate (ratio of contributions that add evidence, context, or structured disagreement vs. low-information replies), source-open rate (proportion of users who open the original source before or after contributing), evidence-addition rate (contributions that include citations or linked evidence), and question-resolution rate (threads where open questions receive substantive answers). Each metric is computed per story, per room, and globally over configurable time windows. Aggregation uses privacy-preserving counts -- no individual user behavior is exposed in dashboards. Metrics are stored in a time-series format suitable for historical trending and export to the transparency pipeline (WS-P.2).

**Metric definitions (exact computation).** Each metric is a ratio of two counts over the aggregation window, computed from the event pipeline (WS-E.1), forum contributions (WS-G), and the source model (WS-F):

- **Constructive-participation rate** = `constructive_contributions / total_contributions`. A contribution is *constructive* if its contribution type is one of {evidence, context-repair/bridge, structured-disagreement, synthesis, correction, question-with-scope} (per the WS-G contribution taxonomy) AND it passes the AI low-information classifier (WS-K) below the low-information threshold. Low-information replies (bare agreement/disagreement, restated claim, off-topic) are the denominator's complement.
- **Source-open rate** = `distinct_users_who_opened_source / distinct_users_who_viewed_story`, computed per story from `source.opened` and `story.viewed` events (WS-E.1). A source-open counts whether it occurs before OR after a contribution by that user. Bucketed to k-anonymity (suppress stories with fewer than the small-cell threshold of viewers).
- **Evidence-addition rate** = `contributions_with_citation_or_linked_evidence / total_contributions`. Evidence presence is read from the structured contribution record (citation field non-empty, or linked-evidence card attached), not inferred from free text.
- **Question-resolution rate** = `threads_with_resolved_open_questions / threads_with_open_questions`. An open question is a contribution of type question-with-scope; it is *resolved* when a subsequent contribution in the same branch is marked (by steward or by the resolution heuristic) as a substantive answer and the question is not re-opened within the window.

All four are stored as `(metric_id, scope, scope_id, window_start, window_end, numerator, denominator, value)` rows so that ratios can be re-aggregated across windows without recomputation and so denominators are auditable. Counts are computed from de-identified, privacy-bucketed events; no row references an individual user.

**Acceptance criteria:**
- All four participation metrics are computed and stored: constructive-participation rate, source-open rate, evidence-addition rate, question-resolution rate.
- Metrics are aggregated per story, per room, and globally.
- Time windows are configurable (hourly, daily, weekly).
- No individual user behavior is identifiable in aggregated output.
- Metrics are queryable by the dashboard (WS-P.1.1e) and transparency pipeline (WS-P.2).
- Each stored metric retains numerator and denominator (not only the ratio) so values can be re-aggregated and audited.
- Stories/rooms with fewer than the small-cell threshold of distinct contributors in a window are suppressed (not zero-filled) in any human-identifying breakdown.

**Testing:**
- Unit: Verify each metric computation against known input datasets. Verify aggregation at each scope level.
- Integration: Ingest a sequence of contributions and source-open events. Query metrics. Verify values match expected computations.
- Unit: Verify a contribution classified low-information is excluded from the constructive numerator but counted in the denominator.
- Privacy: Verify a story with contributors below the small-cell threshold is suppressed in per-story output.

**Dependencies:** WS-G (forum contributions and contribution taxonomy), WS-F.2 (source model for source-open attribution), WS-E.1 (event pipeline for `source.opened`/`story.viewed`/`contribution.created` events), WS-K (low-information classifier for constructive-participation), WS-G (question/answer resolution state). No dependency on any WS-L/WS-M financial module.

**Observability:** Emit `metric.participation.computed` per `(metric_id, scope)` with numerator, denominator, value, coverage, and suppression count. A data-quality alert fires if denominator coverage (events ingested vs. expected) drops below a configurable floor, indicating an upstream event-pipeline gap rather than a real metric change.

**Security/privacy:** Inputs are privacy-bucketed events; the metric store contains no per-user rows and no attention history. Source-open is a quality signal at population scale, never a per-user surveillance metric, and is never exported to ranking (the financial and attention bounded contexts are not reachable from this module).

---

### WS-P.1.1b Invariant health metrics
**ID:** WS-P.1.1b
**Ref:** Section 28.1

**Description:**
Implement collection and aggregation for invariant health metrics: MERI distribution (histogram of redundancy scores across active stories showing whether deduplication is effective), SCOI reduction after bridge/synthesis (change in obstruction energy after context-repair contributions are added), MFCI incidents by severity (count of coordination incidents grouped by severity level and outcome), GWEI cohort disparity (structural experience gap across demographic/interest cohorts, reported as the normalized transport distance), and PHI steering-risk distribution (histogram of path-holonomy risk scores showing how many users are in high-risk attention loops). Each metric includes confidence intervals and coverage percentages. Metrics are computed on a scheduled basis (at least daily) and on-demand after significant events (e.g., after a major coordination incident resolves).

**Metric definitions (exact computation).** Each is derived from the `InvariantOutput` records produced by WS-H (each carries a value, a confidence, a coverage flag, a fallback flag, and an invariant version), never recomputed independently:

- **MERI distribution** = histogram (configurable bins over `[0,1]`) of the per-story MERI redundancy score across all *active* stories in the window, plus summary statistics (median, p90). Effectiveness is read as the share of active stories below the redundancy concern threshold.
- **SCOI reduction after bridge/synthesis** = for each story that received an accepted bridge/synthesis/context-patch contribution in the window, `SCOI_before - SCOI_after` measured over a fixed lookback/look-ahead around the patch event; reported as the mean reduction with a confidence interval and the count of qualifying repair events. Stories with no repair event are excluded from this metric (and that exclusion is reported as coverage).
- **MFCI incidents by severity** = count of coordination incidents grouped by severity (informational, elevated, high, critical) and outcome (true-positive confirmed, false-positive cleared, under review), sourced from the integrity case records (WS-H.3 + WS-J integrity cases). Account counts within an incident are suppressed below the small-cell threshold.
- **GWEI cohort disparity** = the normalized optimal-transport distance between the structural-experience distributions of eligible cohorts (interest/locale cohorts, never inferred sensitive attributes), reported with a confidence interval. Cohorts below the small-cell threshold are merged or suppressed before the distance is computed.
- **PHI steering-risk distribution** = histogram of path-holonomy risk scores across the active population, plus the share of users in the high-risk band. This is a population distribution; it is never drilled down to an individual user in any dashboard.

Confidence intervals use the invariant's reported confidence and the sample coverage; coverage percentage = proportion of the relevant population (stories/users/rooms/cohorts) for which the invariant produced a non-fallback output.

**Acceptance criteria:**
- All five invariant health metrics are computed: MERI distribution, SCOI reduction, MFCI incidents by severity, GWEI cohort disparity, PHI steering-risk distribution.
- Each metric includes confidence intervals and coverage percentages.
- Scheduled computation runs at least daily.
- On-demand recomputation is triggered after significant invariant events.
- Metrics are available to the dashboard (WS-P.1.1e) and transparency pipeline (WS-P.2).
- Every metric records the invariant version(s) it was derived from so a value can be tied to a specific invariant release.
- Cohort and incident breakdowns apply small-cell suppression before any distance or count is published.

**Testing:**
- Unit: Verify each invariant health metric computation with synthetic data. Verify confidence interval calculations.
- Integration: Run invariant services on test data. Trigger metric computation. Verify values and confidence intervals are within expected ranges.
- Unit: Verify SCOI-reduction excludes stories with no repair event and reports them as reduced coverage rather than zero reduction.
- Integration: Resolve a synthetic MFCI incident and verify on-demand recomputation fires and updates the incidents-by-severity counts.

**Dependencies:** WS-H.1 (`InvariantOutput` schema, versioning, and `invariant.run.completed` events), WS-H.2 (MERI), WS-H.3 (MFCI incidents), WS-H.4 (SCOI before/after), WS-H.5 (GWEI cohorts), WS-H.6 (PHI), WS-J (integrity case outcomes for MFCI true/false-positive labels).

**Observability:** Emit `metric.invariant_health.computed` per invariant with value summary, confidence, coverage, and fallback share. A "low coverage" alert fires when any invariant's coverage drops below its floor (signals cold-start or an upstream invariant outage rather than a genuine health change).

**Security/privacy:** All five are population-level distributions or incident counts; no per-user or per-account drill-down is exposed. GWEI cohorts use only non-sensitive interest/locale attributes (Section 19) and inherit GWEI's small-cohort protection. PHI is reported only as a distribution, consistent with the no-surveillance principle.

---

### WS-P.1.1c Safety metrics
**ID:** WS-P.1.1c
**Ref:** Section 28.1

**Description:**
Implement collection and aggregation for safety metrics: harassment-protection latency (time from a harassment report being filed to the first moderation action taken, measured at p50, p90, and p99), appeal-overturn rate (proportion of moderation actions overturned on appeal, broken down by action type and severity), and accessibility-defect rate (count of accessibility defects found per release, categorized by WCAG criterion and severity). Harassment-protection latency is measured from the timestamp of report submission to the timestamp of the first moderation action (review, restriction, or escalation). Appeal-overturn rate is computed monthly with a 30-day lookback. Accessibility-defect rate is computed per release using automated (axe-core) and manual audit findings.

**Metric definitions (exact computation).** Sourced from the moderation action log, appeal records, and the accessibility audit pipeline:

- **Harassment-protection latency** = distribution of `first_action_timestamp - report_submitted_timestamp` over all harassment-category reports closed in the window, reported at p50, p90, p99. The clock STARTS at report submission, not at triage/assignment (this is a deliberate accountability choice: queue delay counts against the metric). `first_action` is the first of {review opened with a decision, content removal, account restriction, escalation}. Reports auto-closed as duplicates inherit the action time of their canonical report.
- **Appeal-overturn rate** = `overturned_appeals / decided_appeals` over a 30-day lookback, broken down by original action type (warning, removal, restriction, suspension, escalation) and severity. An appeal is *overturned* when the reviewing steward/board reverses or materially reduces the original action.
- **Accessibility-defect rate** = count of accessibility defects per release, categorized by WCAG 2.2 criterion and severity (blocker/serious/moderate/minor), combining automated axe-core findings (WS-B / CI) and manual audit findings. Reported as defects-per-release and as open-defect backlog by severity.

**Acceptance criteria:**
- Harassment-protection latency is measured at p50, p90, and p99.
- Appeal-overturn rate is computed monthly, broken down by action type and severity.
- Accessibility-defect rate is computed per release with WCAG criterion categorization.
- All safety metrics are available to the dashboard and transparency pipeline.
- Latency measurement starts at report submission, not report assignment.
- Latency breakdowns by category suppress any bucket below the small-cell threshold of reports.

**Testing:**
- Unit: Verify latency computation with known report-to-action timestamps. Verify overturn rate computation with known appeal outcomes.
- Integration: Create reports, apply moderation actions at known times. Query harassment-protection latency. Verify correctness.
- Unit: Verify the latency clock starts at submission (not assignment) using a report whose assignment is deliberately delayed.
- Unit: Verify accessibility-defect rate merges axe-core and manual findings without double-counting the same defect.

**Dependencies:** WS-J.1 (report submission timestamps and report categories), WS-J.2 (moderation action log, action types/severities, appeal decisions), WS-B / WS-0.4 (axe-core CI findings), WS-B (manual accessibility audit records).

**Observability:** Emit `metric.safety.computed` with latency percentiles, overturn rates by action type, and per-release defect counts. A safety-SLA alert fires when harassment-protection latency p90 exceeds the target (feeding both the dashboard and the experiment guardrail in WS-P.1.3c-2). Appeal-overturn spikes alert the policy lead (possible over-enforcement regression).

**Security/privacy:** Built only from action/appeal *metadata* (timestamps, types, outcomes) -- never report content, accuser identity, or accused identity. Per-category latency breakdowns are small-cell-suppressed so a rare report category cannot identify the individuals involved.

---

### WS-P.1.1d Performance metrics
**ID:** WS-P.1.1d
**Ref:** Sections 28.1, 32.3

**Description:**
Implement collection and monitoring of Core Web Vitals at the 75th percentile: Largest Contentful Paint (LCP) target of 2.5 seconds or less, Interaction to Next Paint (INP) target of 200 milliseconds or less, and Cumulative Layout Shift (CLS) target of 0.1 or less. Metrics are collected from real user monitoring (RUM) in the PWA client using the `web-vitals` library. Data is aggregated by device class (low-end, mid-range, high-end), connection type (3G, 4G, WiFi), and route/page. Historical trends are stored for regression detection. Alerts fire when any metric regresses beyond the target at p75 over a rolling 24-hour window.

**Metric definitions (exact computation).** The `web-vitals` library reports field LCP, INP, and CLS per session/navigation. The collector buckets each reading by device class, connection type, and route, then aggregates to p75 over the rolling window. Device class is derived from coarse, privacy-safe hints (device-memory bucket, hardware-concurrency bucket) -- never a precise device fingerprint. Connection type comes from the Network Information API where available, else "unknown." Targets are the spec thresholds: LCP p75 ≤ 2.5 s, INP p75 ≤ 200 ms, CLS p75 ≤ 0.1.

**Acceptance criteria:**
- LCP, INP, and CLS are collected from real users via the `web-vitals` library.
- Metrics are aggregated at p75 by device class, connection type, and route.
- Historical trends are stored with at least 90 days of retention.
- Alerts fire when any metric exceeds the target at p75 over a rolling 24-hour window.
- Targets: LCP ≤ 2.5s, INP ≤ 200ms, CLS ≤ 0.1.
- Device-class derivation uses only coarse hints (no precise fingerprinting) and readings carry no user identifier.

**Testing:**
- Unit: Verify aggregation logic computes p75 correctly from sample distributions.
- Integration: Emit synthetic Web Vitals events. Verify aggregation, storage, and alert triggering when thresholds are exceeded.
- Unit: Verify per-route and per-device-class bucketing places readings in the correct bucket and that "unknown" connection is handled.

**Dependencies:** WS-C.2 / WS-C.1 (PWA client and `web-vitals` integration), WS-E.1 (RUM beacon transport into the event pipeline), WS-B (route inventory for per-route attribution).

**Observability:** Emit `metric.web_vitals.aggregated` per `(metric, device_class, connection, route)` at p75. A regression alert fires per metric over the rolling 24-hour window; the alert payload identifies the worst-regressing route and device class to direct remediation. This metric directly backs the M3 and M6 Core Web Vitals milestone gates.

**Security/privacy:** RUM readings are anonymous performance samples with no user identifier and no attention/behavioral content. Device class is a coarse bucket; precise device or network fingerprinting is prohibited.

---

### WS-P.1.1e Metrics dashboard
**ID:** WS-P.1.1e
**Ref:** Section 28.1

**Description:**
Build a real-time metrics dashboard that displays all product-health metrics (WS-P.1.1a through WS-P.1.1d) with historical trends. The dashboard includes: participation metrics panel (four charts with per-room and global views), invariant health panel (five charts with confidence bands), safety metrics panel (latency distributions, overturn rates, defect counts), and performance panel (Core Web Vitals with device/connection breakdowns). Each panel supports configurable time ranges (last 24h, 7d, 30d, 90d). The dashboard auto-refreshes at a configurable interval (default: 5 minutes). Historical trend lines show rolling averages with anomaly highlighting. The dashboard is accessible only to authorized staff roles and logged via the staff audit trail (WS-D).

**Anti-metric exclusion (structural).** The dashboard data layer queries ONLY the product-health metric store. It has no read path to the anti-metric store (WS-P.1.2) or the Knomosis governance/payment metric store (WS-P.1.4); those stores are physically separate and are surfaced only in transparency reports. Any attempt to add an anti-metric series or a revenue/treasury series to this dashboard fails at the query layer (the same constraint enforced in WS-P.1.2d). The dashboard never displays, and cannot display, any prohibited signal (likes/upvotes/reactions/leaderboards) because no such metric exists in the store.

**Acceptance criteria:**
- Dashboard displays all metrics from WS-P.1.1a through WS-P.1.1d.
- Historical trends are visible with configurable time ranges.
- Auto-refresh at a configurable interval (default 5 minutes).
- Anomaly highlighting on trend lines.
- Access restricted to authorized staff roles with audit logging.
- Dashboard loads within 3 seconds on a standard connection.
- The dashboard data layer has no query path to the anti-metric store or the Knomosis/finance metric store (verified by a binding test).

**Testing:**
- Unit: Verify chart data transformations produce correct series from stored metrics.
- E2E: Load the dashboard with test data. Verify all panels render. Change time range. Verify data updates. Verify access is denied for unauthorized users.
- Binding test: Attempt to register an anti-metric or revenue metric as a dashboard series; verify it is rejected at the query/config layer with an explicit error.

**Dependencies:** WS-P.1.1a, WS-P.1.1b, WS-P.1.1c, WS-P.1.1d (all product-health metrics), WS-D.1 (staff role authorization), WS-D (staff audit trail), WS-B (chart/visualization components).

**Observability:** Dashboard access events are written to the staff audit trail with role, time range viewed, and panels accessed. Emit `dashboard.metrics.viewed`; an anomaly on access patterns (e.g., bulk export attempts) alerts security.

**Security/privacy:** Staff-only with role gating and full audit logging. The dashboard shows aggregates only; no panel can drill to an individual user. Anti-metrics and revenue figures are structurally absent, preserving the separation between product health, anti-metrics, and finance.

---

### WS-P.1.2a Anti-metric definitions
**ID:** WS-P.1.2a
**Ref:** Section 28.2

**Description:**
Define and implement the anti-metric schema -- signals that must never be optimized and must never appear as success criteria for experiments or launches. Social anti-metrics: total dwell time (aggregate time spent in app, which incentivizes addictive loops), outrage engagement (interactions driven by anger/fear/moral outrage rather than understanding), compulsive session length (sessions exceeding healthy engagement thresholds without breaks), speculation activity (posts, threads, or contributions centered on rumor/unverified claims without evidence), and vanity status (follower growth rate, karma accumulation, badge collection, leaderboard position). Each anti-metric has a formal definition, a measurement method, a baseline, and a deterioration threshold. The anti-metric schema is versioned and stored alongside the product-health metric definitions.

**Anti-metric registry schema.** Each anti-metric is a versioned record with: `anti_metric_id`, `name`, `category` (social | crypto), `definition` (prose), `measurement_method` (how it is computed or externally observed), `direction` (always "lower is better"; an *increase* is deterioration), `baseline` (reference value and how it was established), `deterioration_threshold` (absolute or relative-to-baseline/control), `severity_on_breach`, and `enforcement_hooks` (which experiment guardrails consume it). The registry is append-versioned (definitions are never silently edited; a new version supersedes). A hard flag `is_optimization_target = false` is immutable on every record and is read by the schema constraints in WS-P.1.2d and the experiment-success validator in WS-P.1.3d-2.

Measurement notes for the social set: total dwell time and compulsive session length are computed as population aggregates only (never per-user profiles) and are *deliberately* monitored as things to keep flat or reduce; outrage engagement uses the affect/hostility signal (WS-J / WS-K) at population scale; speculation activity reads the unverified-claim share from contribution classification (WS-K); vanity status is a structural anti-metric -- because likes/karma/followers/leaderboards do not exist in the product, its "value" is asserted as zero and any nonzero reading means a prohibited signal has leaked and triggers a critical alert.

**Acceptance criteria:**
- All five social anti-metrics are formally defined: total dwell time, outrage engagement, compulsive session length, speculation activity, vanity status.
- Each definition includes measurement method, baseline computation, and deterioration threshold.
- Anti-metric schema is versioned.
- Anti-metrics are clearly separated from product-health metrics in the data model.
- No anti-metric can be added to a growth dashboard or used as an experiment success criterion (enforced by schema constraints in WS-P.1.2d and WS-P.1.3d).
- Every anti-metric record carries an immutable `is_optimization_target = false` flag and a "lower is better" direction.
- The vanity-status anti-metric is defined such that any nonzero reading raises a critical "prohibited signal leaked" alert.

**Testing:**
- Unit: Verify each anti-metric computation produces expected values from known inputs.
- Review: Anti-metric definitions are reviewed for completeness and alignment with Sections 28.1 and 28.2.
- Unit: Verify the registry rejects any attempt to set `is_optimization_target = true`.
- Unit: Verify a synthetic nonzero vanity-status reading raises the critical leak alert.

**Dependencies:** WS-P.1.1a (participation metrics for baseline comparison and shared time-series store), WS-J (hostility/affect signal for outrage), WS-K (unverified-claim and low-information classification for speculation), WS-E.1 (session/dwell aggregation at population scale).

**Observability:** Emit `anti_metric.defined` and `anti_metric.versioned` on registry changes. The registry exposes a read-only inventory used by the transparency pipeline (WS-P.1.2d) and the experiment validators (WS-P.1.3c, WS-P.1.3d).

**Security/privacy:** Dwell and session-length anti-metrics are aggregate-only and exist specifically to *resist* the surveillance/optimization pattern; they are never stored or surfaced as per-user behavior. The registry is the authoritative "do-not-optimize" list and is itself an integrity control.

---

### WS-P.1.2b Crypto anti-metrics
**ID:** WS-P.1.2b
**Ref:** Sections 28.2, 28.3

**Description:**
Define and implement crypto-specific anti-metrics that must never be optimized: total value locked (TVL -- aggregate funds held in room treasuries, which incentivizes speculation and lock-in), token trading volume (volume of token trades if any token exists, which incentivizes speculation), wallet-connect growth rate (rate of new wallet connections, which incentivizes crypto-first rather than civic-first engagement), and speculative price (price of any token or asset associated with the platform). Each crypto anti-metric has a formal definition, a measurement method where applicable (TVL and wallet-connect growth are measurable; token volume and speculative price may be externally observed), and a deterioration threshold. These anti-metrics are monitored alongside social anti-metrics and share the same enforcement infrastructure.

**Crypto anti-metric definitions.** Stored in the same registry (WS-P.1.2a) with `category = crypto` and the same immutable `is_optimization_target = false` flag:

- **TVL** = aggregate value held across room treasuries, read from the treasury ledger (WS-M.2). Monitored as a *do-not-optimize* figure; a deliberate increase pursued as a goal is a policy violation. Also note: §28.3 explicitly says "do not optimize for treasury size," so **treasury size** is registered as a crypto anti-metric alongside TVL.
- **Token trading volume** = volume of trades of any platform-associated token, externally observed (the platform does not run a market). If no token exists, the value is "n/a" and the registry records that the platform intentionally has no token.
- **Wallet-connect growth rate** = rate of new wallet connections per period, read from wallet-link records (WS-L.2). Monitored as a do-not-grow figure: civic participation, not wallet adoption, is the goal.
- **Speculative price** = price of any platform-associated asset/token, externally observed where applicable; "n/a" if none.

These are explicitly distinct from the *measured-and-required-flat* governance/payment metrics in §28.3 (WS-P.1.4), which are reported for transparency and risk; the crypto anti-metrics here are the do-not-optimize set, enforced as guardrails.

**Acceptance criteria:**
- All four crypto anti-metrics are formally defined: TVL, token volume, wallet-connect growth, speculative price.
- Each definition includes measurement method (or external observation method) and deterioration threshold.
- Crypto anti-metrics share the same schema and enforcement infrastructure as social anti-metrics.
- TVL and wallet-connect growth are measured from internal data; token volume and speculative price use external observation where applicable.
- No crypto anti-metric appears in growth dashboards or experiment success criteria.
- Treasury size is registered as a do-not-optimize crypto anti-metric per §28.3.

**Testing:**
- Unit: Verify TVL and wallet-connect growth rate computations from synthetic treasury and wallet-link data.
- Review: Crypto anti-metric definitions reviewed for alignment with Section 28.3.
- Unit: Verify token-volume and speculative-price records accept an explicit "n/a / no token exists" state without breaking enforcement.

**Dependencies:** WS-P.1.2a (anti-metric registry/schema), WS-L.2 (wallet-link records for wallet-connect growth), WS-M.2 (treasury ledger for TVL/treasury size). All crypto inputs are read behind crypto feature flags and fail closed when crypto is disabled (the anti-metrics then read "n/a / feature disabled", never blocking the core product).

**Observability:** Emit `anti_metric.crypto.computed` for TVL, treasury size, and wallet-connect growth; externally observed series (token volume, price) are recorded with their observation source and timestamp. Trends feed transparency reporting and the experiment crypto guardrail.

**Security/privacy:** Crypto anti-metrics are aggregate treasury/wallet figures with no individual wallet attribution. They are deliberately framed as risks to monitor, not growth to chase, reinforcing the civic-first, crypto-non-blocking posture (Section 17).

---

### WS-P.1.2c Anti-metric monitoring
**ID:** WS-P.1.2c
**Ref:** Section 28.2

**Description:**
Implement monitoring and alerting for all anti-metrics (social and crypto). The monitoring system continuously computes anti-metric values and compares them against baselines and deterioration thresholds. When any anti-metric increases beyond its deterioration threshold, an alert is raised to the metrics dashboard and the experiment registry. Active experiments are automatically flagged for review if any anti-metric deteriorates during the experiment period. The monitoring system also provides an API that the experiment framework (WS-P.1.3) queries before approving experiment launches and during experiment evaluation. Anti-metric trends are computed over rolling 7-day and 30-day windows.

The monitoring service exposes `evaluate(anti_metric_id, scope, window)` returning `{ value, baseline, threshold, breached, severity }` and a bulk `status(experiment_id)` that returns the breach state of all anti-metrics for an experiment's population vs. its control/baseline. This is the single source of truth consumed by the pre-launch check (WS-P.1.3b), the continuous guardrail (WS-P.1.3c-2), and transparency reporting (WS-P.1.2d).

**Acceptance criteria:**
- All anti-metrics (social and crypto) are monitored continuously.
- Alerts fire when any anti-metric exceeds its deterioration threshold.
- Active experiments are flagged when anti-metrics deteriorate during the experiment period.
- The monitoring system exposes an API for the experiment framework to query anti-metric status.
- Trends are computed over rolling 7-day and 30-day windows.
- Alert history is retained for audit and transparency reporting.
- The `status(experiment_id)` API compares the experiment population against its control/baseline, not only against the global trend.

**Testing:**
- Unit: Verify threshold comparison logic. Verify alert generation when thresholds are exceeded.
- Integration: Run an experiment simulation. Inject anti-metric deterioration. Verify the experiment is flagged. Verify alerts appear on the dashboard.
- Unit: Verify rolling 7-day and 30-day windows are computed correctly across a window boundary.
- Integration: Verify `status(experiment_id)` returns breach when the treatment arm deteriorates even if the global trend is flat.

**Dependencies:** WS-P.1.2a, WS-P.1.2b (anti-metric definitions and registry), WS-P.1.3a (experiment assignment, to map population to experiment arms for the per-experiment status API).

**Observability:** Emit `anti_metric.evaluated` and `anti_metric.breach` with anti-metric id, scope, value, threshold, and severity. Breach events route to the metrics dashboard alert panel and to the experiment registry; all breaches are persisted for the audit/transparency trail.

**Security/privacy:** Evaluations are aggregate; per-experiment status compares cohort aggregates, never individuals. Alert history retained for transparency contains thresholds and values, not user data.

---

### WS-P.1.2d Anti-metric reporting
**ID:** WS-P.1.2d
**Ref:** Section 28.2

**Description:**
Ensure anti-metrics appear in transparency reports (WS-P.2) and never in growth dashboards. The reporting pipeline includes anti-metric trends, deterioration events, and experiment blocking events in every transparency report. The growth/product dashboard explicitly excludes anti-metrics from any optimization or goal-setting view. A schema-level constraint prevents anti-metrics from being added to growth dashboard queries. Anti-metric reporting in transparency reports uses the same privacy-preserving aggregation as other metrics (small-cell suppression, no individual user attribution).

**Schema-level enforcement.** Implement a query-binding allow-list: dashboard query definitions may only reference metric ids whose store is the product-health store. Anti-metric ids (and Knomosis/finance ids) live in a separate namespace and are rejected by a validator that runs at dashboard-config load and in CI. The rejection message names the offending metric id and the rule. The transparency exporter, by contrast, is explicitly allow-listed to read the anti-metric registry and the monitoring breach history.

**Acceptance criteria:**
- Anti-metrics are included in every transparency report generated by WS-P.2.
- Anti-metrics are excluded from growth dashboards at the schema/query level.
- Deterioration events and experiment blocking events are documented in transparency reports.
- Privacy-preserving aggregation (small-cell suppression) applies to anti-metric reporting.
- Attempting to add an anti-metric to a growth dashboard query fails with an explicit error.
- The exclusion validator runs in CI so a prohibited dashboard reference cannot be merged.

**Testing:**
- Unit: Verify schema constraint rejects anti-metrics in growth dashboard queries.
- Integration: Generate a transparency report. Verify anti-metrics are present with trends and deterioration events. Attempt to add an anti-metric to a growth dashboard query. Verify rejection.
- CI: Verify a PR that adds an anti-metric id to a dashboard config fails the exclusion check.

**Dependencies:** WS-P.1.2c (anti-metric monitoring trends and breach history), WS-P.2.1d (report generator that embeds the anti-metric section), WS-0.4 (CI to run the exclusion validator).

**Observability:** Emit `anti_metric.report_section.built` per report and `dashboard.exclusion.violation` (CI/runtime) on any attempted prohibited reference. The latter is a high-priority signal: it means someone tried to optimize an anti-metric.

**Security/privacy:** Anti-metric report sections use the same small-cell suppression as all metrics; crypto anti-metrics are aggregate-only. The CI exclusion check is a structural guarantee that the no-optimization invariant cannot be violated by a dashboard change.

---

### WS-P.1.3a Feature-flag experiment assignment
**ID:** WS-P.1.3a
**Ref:** Section 28.2

**Description:**
Implement the experiment assignment system built on the feature-flag infrastructure (WS-C.1.3). The system supports: random assignment (users are randomly assigned to treatment or control groups using a deterministic hash of user ID and experiment ID for reproducibility), cohort-based assignment (users are grouped by room, region, account age, or other non-sensitive attributes and assigned by cohort), and holdout groups (a configurable percentage of users are permanently excluded from all experiments to serve as a long-term baseline). Assignment is stable -- a user's assignment does not change for the duration of an experiment. The assignment system logs every assignment decision with the experiment ID, user ID (hashed), variant, and timestamp for audit.

**Acceptance criteria:**
- Random assignment produces a uniform distribution across variants (verified statistically).
- Assignment is deterministic: the same user ID and experiment ID always produce the same variant.
- Cohort-based assignment groups users by room, region, or account age.
- Holdout groups exclude a configurable percentage from all experiments.
- Assignments are stable for the duration of an experiment.
- Every assignment is logged with experiment ID, hashed user ID, variant, and timestamp.
- Cohort attributes are restricted to non-sensitive fields (no inferred sensitive attributes); attempting to assign on a sensitive attribute is rejected.

**Testing:**
- Unit: Verify uniform distribution across 10,000 synthetic user IDs. Verify determinism (same input produces same output). Verify holdout exclusion.
- Integration: Create an experiment with two variants. Assign 1,000 test users. Verify distribution is within expected bounds. Verify assignment stability across repeated queries.
- Unit: Verify a sensitive cohort attribute is rejected by the assignment configuration.

**Dependencies:** WS-C.1.3 (feature-flag infrastructure), WS-D.1 (account age / non-sensitive attributes), WS-G.2 (room membership for room cohorts). The assignment service has no read path to wallet/payment data; crypto state can never be an assignment attribute.

**Observability:** Emit `experiment.assignment.made` with experiment id, hashed user id, variant, cohort, and timestamp. A distribution monitor flags an assignment skew beyond tolerance (signals a hashing or config bug).

**Security/privacy:** User ids are hashed in assignment logs. Cohorting uses only non-sensitive attributes (Section 19); sensitive-attribute and financial-state cohorting are structurally impossible. The holdout group provides a long-term, un-experimented baseline that protects users from continuous experimentation.

---

### WS-P.1.3b Experiment registry
**ID:** WS-P.1.3b
**Ref:** Section 28.2

**Description:**
Implement the experiment registry -- a structured database of all experiments with mandatory fields: name (unique identifier), hypothesis (what the experiment is expected to show), primary metrics (the product-health metrics used to evaluate success), secondary metrics (additional metrics monitored but not used for launch decisions), guardrails (safety, anti-metric, and invariant health thresholds that trigger auto-rollback), owner (the person responsible for the experiment), start/end dates, variant descriptions, assignment method, target population, and invariant versions active during the experiment. The registry enforces that every experiment has at least one product-health metric (not just engagement), at least one guardrail, and an owner. Experiments cannot be started without passing the prohibited-type check (WS-P.1.3d). The registry provides a read-only view for transparency reporting.

**Pre-launch guardrail check.** At experiment start, the registry queries the anti-metric monitoring API (WS-P.1.2c) for the current baseline and confirms every required guardrail (safety, each relevant anti-metric, each relevant invariant health metric) is wired to a live threshold. Ranking experiments are *required* to include safety, MERI, MFCI, GWEI, SCOI, and PHI metrics (§28.2); the registry rejects a ranking-tagged experiment that omits any of these. Experiments touching minors or sensitive topics are tagged for stricter review and cannot start without the elevated approval (§28.2).

**Acceptance criteria:**
- All mandatory fields are enforced: name, hypothesis, primary metrics, guardrails, owner, dates, variants, assignment method.
- Every experiment has at least one product-health metric as a primary metric.
- Every experiment has at least one guardrail.
- Experiments cannot start without passing the prohibited-type check (WS-P.1.3d).
- Invariant versions are recorded at experiment start.
- A read-only view is available for transparency reporting.
- Ranking-tagged experiments are required to include safety, MERI, MFCI, GWEI, SCOI, and PHI metrics, and are rejected if any is missing.
- Experiments tagged as touching minors or sensitive topics require elevated approval before they can start.

**Testing:**
- Unit: Attempt to create an experiment missing each mandatory field. Verify rejection for each.
- Integration: Create a complete experiment. Start it. Verify it appears in the registry with all fields. Verify the read-only view returns correct data. Attempt to start a prohibited experiment type. Verify rejection.
- Unit: Create a ranking-tagged experiment missing MFCI; verify rejection naming the missing invariant metric.
- Unit: Attempt to start a minors/sensitive-tagged experiment without elevated approval; verify rejection.

**Dependencies:** WS-P.1.3a (assignment), WS-P.1.3d (prohibited-type check, implemented first), WS-P.1.2c (anti-metric baselines for guardrail wiring), WS-P.1.1b (invariant health metrics for ranking-experiment requirements), WS-A (sensitive-topic / minors policy definitions).

**Observability:** Emit `experiment.created`, `experiment.started`, and `experiment.start_rejected` (with the rejection reason). A registry dashboard shows all running experiments, their guardrail wiring, and their invariant-version snapshot.

**Security/privacy:** The registry stores experiment metadata only. The transparency read-only view excludes any internal investigative detail and is the source for the experiment section of public reports. Invariant-version logging makes every experiment reproducible against the exact invariant releases in effect.

---

### WS-P.1.3c Experiment guardrails
**ID:** WS-P.1.3c
**Ref:** Section 28.2

**Description:**
Implement automatic guardrail enforcement for running experiments. Guardrails are evaluated continuously during an experiment and trigger auto-rollback when thresholds are breached. Three guardrail categories: safety degradation (harassment-protection latency increases beyond the threshold, appeal-overturn rate spikes, moderation SLA is missed), anti-metric worsening (any anti-metric from WS-P.1.2a or WS-P.1.2b deteriorates beyond its threshold during the experiment period relative to the control group or pre-experiment baseline), and invariant health drop (MERI, MFCI, SCOI, GWEI, or PHI confidence or coverage drops below the configured threshold for the experiment population). When a guardrail trips, the experiment is automatically rolled back to the control variant for all affected users. The rollback is logged with the guardrail that triggered it, the metric value that breached the threshold, and the timestamp. The experiment owner is notified.

This task is split into the guardrail evaluation engine (WS-P.1.3c-1) and the wellbeing/fairness guardrail set required by §28.2 for attention-affecting experiments (WS-P.1.3c-2), so each is independently testable and reversible.

**Acceptance criteria:**
- Guardrails are evaluated continuously (at least every hour during active experiments).
- Auto-rollback triggers within 1 hour of a guardrail breach.
- All three guardrail categories are enforced: safety, anti-metric, invariant health.
- Rollback returns all affected users to the control variant.
- Rollback events are logged with the triggering guardrail, metric value, and timestamp.
- The experiment owner is notified on rollback.

**Testing:**
- Unit: Verify guardrail evaluation logic for each category with synthetic metric values at, below, and above thresholds.
- Integration: Start an experiment. Inject metric values that breach a safety guardrail. Verify auto-rollback occurs. Verify the rollback is logged. Verify the experiment status is updated to "rolled back."

**Dependencies:** WS-P.1.3b (registry and guardrail wiring), WS-P.1.2c (anti-metric status API), WS-P.1.1b (invariant health for the experiment population), WS-P.1.1c (safety metrics), WS-P.1.3e (shares the rollback mechanism).

**Observability:** Emit `experiment.guardrail.evaluated` and `experiment.guardrail.breach` (with category, metric, value, threshold) and `experiment.auto_rollback` (with cause). A guardrail dashboard shows, per running experiment, the live margin to each threshold.

**Security/privacy:** Guardrails compare cohort aggregates (treatment vs. control/baseline); no per-user data is exposed. Auto-rollback is a user-protection mechanism: it reverses harm faster than a human could.

---

#### WS-P.1.3c-1 Guardrail evaluation engine and auto-rollback
**ID:** WS-P.1.3c-1
**Ref:** Section 28.2

**Description:**
Implement the continuous evaluation loop that, for every running experiment, pulls the experiment's wired guardrails (safety, anti-metric, invariant health), evaluates each against its threshold comparing the treatment arm to the control/pre-experiment baseline, and triggers auto-rollback (via the shared rollback mechanism with WS-P.1.3e) when any threshold is breached. The loop runs at least hourly and on-demand when a relevant alert fires from WS-P.1.1c or WS-P.1.2c. Each evaluation result is persisted (margin to threshold per guardrail) so the time-to-breach is auditable. A breach records the triggering guardrail, the breaching value, the comparison baseline, and the timestamp; the experiment status moves to "auto rolled back"; and the owner plus the metrics on-call are notified.

**Acceptance criteria:**
- The engine evaluates every running experiment's wired guardrails at least hourly and on relevant alerts.
- Auto-rollback fires within 1 hour of a breach and returns all affected users to control.
- Each evaluation persists per-guardrail margin to threshold for audit.
- A breach records guardrail, value, baseline, and timestamp and sets status to "auto rolled back."
- Owner and metrics on-call are notified on rollback.
- Treatment-vs-control comparison is used (not only the global trend).

**Testing:**
- Unit: For each category, evaluate synthetic values at, below, and above threshold; verify breach classification.
- Integration: Start an experiment, breach a safety guardrail, verify auto-rollback within the window, the log entry, and the status change.
- Integration: Verify on-demand evaluation triggers when an upstream safety/anti-metric alert fires.

**Dependencies:** WS-P.1.3b (wiring), WS-P.1.2c (anti-metric status), WS-P.1.1b (invariant health), WS-P.1.1c (safety), WS-P.1.3e (rollback mechanism).

**Observability:** Emit `experiment.guardrail.evaluated`, `experiment.guardrail.breach`, and `experiment.auto_rollback`. The guardrail dashboard shows live margins and recent auto-rollbacks.

**Security/privacy:** Cohort-aggregate comparisons only; no per-user exposure. Persisted margins contain thresholds and values, not user data.

---

#### WS-P.1.3c-2 Wellbeing and fairness guardrails for attention-affecting experiments
**ID:** WS-P.1.3c-2
**Ref:** Section 28.2

**Description:**
Implement the additional guardrail set that §28.2 requires for any experiment that could affect attention: experiments "optimizing attention must also monitor wellbeing and participation quality." For experiments tagged as attention-affecting (e.g., feed ordering, notification cadence, surfacing changes), the registry forces inclusion of wellbeing guardrails (compulsive-session-length and total-dwell anti-metrics must not deteriorate; PHI steering-risk distribution must not worsen) and participation-quality guardrails (constructive-participation rate and source-open rate must not drop). A fairness guardrail (GWEI cohort disparity must not widen for the experiment population) is also enforced. These guardrails feed the same auto-rollback engine (WS-P.1.3c-1). An attention-affecting experiment cannot be started if any of these guardrails is unwired.

**Acceptance criteria:**
- Attention-affecting experiments are required to wire wellbeing (compulsive-session, dwell, PHI), participation-quality (constructive-participation, source-open), and fairness (GWEI) guardrails.
- The registry rejects the start of an attention-affecting experiment with any of these guardrails unwired.
- Breach of any wellbeing/fairness guardrail triggers the same auto-rollback path.
- Wellbeing guardrails treat an *increase* in dwell/compulsive-session as deterioration (consistent with anti-metric direction).

**Testing:**
- Unit: Tag an experiment attention-affecting and omit the PHI guardrail; verify start rejection.
- Integration: Breach the compulsive-session guardrail in an attention-affecting experiment; verify auto-rollback.
- Unit: Verify GWEI-widening for the treatment cohort is detected as a fairness breach.

**Dependencies:** WS-P.1.3c-1 (auto-rollback engine), WS-P.1.2a/b (dwell, compulsive-session, vanity anti-metrics), WS-P.1.1b (PHI, GWEI), WS-P.1.1a (constructive-participation, source-open), WS-P.1.3b (tagging and start gate).

**Observability:** Emit `experiment.wellbeing_guardrail.breach` and `experiment.fairness_guardrail.breach`. The guardrail dashboard separates wellbeing/fairness margins so attention experiments are visibly held to the higher bar.

**Security/privacy:** All wellbeing/fairness signals are population aggregates; no per-user wellbeing profiling. This task operationalizes the spec's rule that attention cannot be optimized without protecting wellbeing and participation quality.

---

### WS-P.1.3d Prohibited experiment types
**ID:** WS-P.1.3d
**Ref:** Section 28.2

**Description:**
Implement a hard block on prohibited experiment types. The experiment registry (WS-P.1.3b) rejects any experiment that matches a prohibited pattern. Prohibited patterns: (1) experiments that introduce likes, upvotes, thumbs-up, hearts, or any public approval signal; (2) experiments that introduce public reaction counts or emoji reactions on content; (3) experiments that introduce follower leaderboards, karma scores, or public reputation rankings; (4) experiments that use engagement-only success criteria (no experiment may define success solely in terms of time spent, sessions, or clicks without a product-health or safety metric). The prohibited-type check uses keyword matching on the experiment description and variant descriptions, plus a mandatory human attestation field where the owner confirms the experiment does not introduce prohibited patterns. The check runs at experiment creation and at experiment start.

This task is split into the prohibited-signal pattern block (WS-P.1.3d-1) and the engagement-only success-criteria validator (WS-P.1.3d-2).

**Acceptance criteria:**
- Experiments introducing likes, upvotes, reactions, or leaderboards are rejected at creation time.
- Experiments with engagement-only success criteria are rejected (at least one product-health or safety metric is required).
- Keyword matching scans experiment name, hypothesis, and variant descriptions for prohibited terms.
- A mandatory attestation field requires the owner to confirm no prohibited patterns.
- The check runs at both creation and start time (catching edits between creation and start).
- Rejection includes a specific message identifying which prohibited pattern was detected.

**Testing:**
- Unit: Attempt to create experiments with prohibited keywords ("like button," "upvote," "follower leaderboard," "reaction count"). Verify rejection with specific messages. Create an experiment with only engagement metrics. Verify rejection.
- Integration: Create a valid experiment. Edit it to add a prohibited variant description. Attempt to start. Verify rejection.

**Dependencies:** None (schema-level constraint, implemented first; gates WS-P.1.3b). Draws its prohibited-term list from the WS-A signal denylist doctrine so the experiment block and the product-wide ban share one source of truth.

**Observability:** Emit `experiment.prohibited_type.rejected` with the matched pattern and stage (creation/start). A nonzero rate is a signal worth reviewing (someone is attempting a prohibited experiment) and is included in transparency reporting.

**Security/privacy:** This task is itself a product-integrity control enforcing the permanent no-applause rule. The attestation creates accountability; the keyword + structural checks make accidental introduction detectable before launch.

---

#### WS-P.1.3d-1 Prohibited-signal pattern block and attestation
**ID:** WS-P.1.3d-1
**Ref:** Sections 28.2, 13.6

**Description:**
Implement the keyword/pattern matcher and attestation gate for prohibited *signals*. The matcher scans experiment name, hypothesis, and all variant descriptions for terms in the shared denylist (likes, upvote, thumbs-up, heart, reaction count, emoji reaction on content, follower leaderboard, karma, public reputation ranking, and their common variants/synonyms). A match rejects with a message naming the matched pattern. A mandatory attestation field requires the owner to affirm the experiment introduces no prohibited approval/reaction/leaderboard signal; submission without attestation is rejected. The check runs at both creation and start (so an edit after creation is re-checked).

**Acceptance criteria:**
- Name, hypothesis, and variant descriptions are scanned against the shared denylist at creation and start.
- A match rejects with a specific message identifying the matched pattern and field.
- The attestation field is mandatory; missing attestation blocks creation/start.
- The denylist is sourced from the WS-A doctrine (single source of truth), not duplicated ad hoc.

**Testing:**
- Unit: Each denylist term (and a synonym) in each scanned field triggers rejection with the correct message.
- Integration: Create valid, then edit to add "reaction count" to a variant; verify start-time rejection.
- Unit: Submit without attestation; verify rejection.

**Dependencies:** WS-A.1.1 (canonical denied-signal list), WS-P.1.3b (registry hook points).

**Observability:** Emit `experiment.prohibited_signal.rejected` with matched term, field, and stage.

**Security/privacy:** Enforces the permanent prohibited-signal ban at the experiment boundary; shares the denylist with ranking (WS-I) and product (WS-B) so the ban cannot drift between subsystems.

---

#### WS-P.1.3d-2 Engagement-only success-criteria validator
**ID:** WS-P.1.3d-2
**Ref:** Section 28.2

**Description:**
Implement the validator that rejects any experiment whose success criteria are engagement-only. The validator inspects the experiment's primary metrics: at least one must be a product-health metric (participation, invariant health, safety, or performance) or a safety metric; an experiment whose primary metrics are drawn solely from {time spent, sessions, clicks, dwell, session length} is rejected. It also cross-checks against the anti-metric registry: no anti-metric may be listed as a primary (success) metric at all -- an anti-metric in the primary-metric slot is rejected with an explicit message. This enforces "no launch uses engagement alone as a success criterion" (§28.2) and the no-optimization rule for anti-metrics. Runs at creation and start.

**Acceptance criteria:**
- An experiment with only engagement metrics as primary is rejected.
- At least one primary metric must be a product-health or safety metric.
- Any anti-metric listed as a primary/success metric is rejected with an explicit message.
- The check runs at creation and at start.

**Testing:**
- Unit: Primary metrics = {sessions, clicks} only → rejected.
- Unit: Primary metrics include constructive-participation rate → accepted.
- Unit: Primary metrics include an anti-metric (e.g., total dwell) → rejected naming the anti-metric.

**Dependencies:** WS-P.1.2a/b (anti-metric registry for the success-metric cross-check), WS-P.1.1a-d (product-health metric catalog), WS-P.1.3b (registry hook points).

**Observability:** Emit `experiment.engagement_only.rejected` and `experiment.anti_metric_as_success.rejected` (the latter is a high-priority integrity signal).

**Security/privacy:** Structurally guarantees that engagement and anti-metrics can never become launch goals, directly implementing the spec's success-criteria rule.

---

### WS-P.1.3e Experiment rollback switches
**ID:** WS-P.1.3e
**Ref:** Section 28.2

**Description:**
Implement manual rollback switches for every active experiment, complementing the automatic guardrail rollback (WS-P.1.3c). The rollback switch is accessible from the experiment registry dashboard and via an API. Rolling back an experiment: (1) sets all users in the experiment to the control variant immediately; (2) logs the rollback with the reason (manual), the operator, and the timestamp; (3) updates the experiment status to "manually rolled back"; (4) preserves all experiment data for analysis (no data is deleted on rollback). Emergency rollback is available to any authorized staff member. Non-emergency rollback requires the experiment owner or a metrics lead. The rollback switch is tested before each experiment starts as part of the experiment launch checklist.

**Acceptance criteria:**
- Every active experiment has a manual rollback switch accessible from the dashboard and API.
- Rollback sets all users to the control variant immediately.
- Rollback is logged with reason, operator, and timestamp.
- Experiment data is preserved after rollback.
- Emergency rollback is available to any authorized staff member.
- Non-emergency rollback requires experiment owner or metrics lead authorization.
- Rollback switch is tested before each experiment launch.

**Testing:**
- Integration: Start an experiment. Trigger the manual rollback switch. Verify all users are moved to the control variant. Verify the rollback is logged. Verify experiment data is preserved. Attempt rollback as an unauthorized user. Verify rejection.

**Dependencies:** WS-P.1.3a (experiment assignment, to flip all users to control), WS-P.1.3c-1 (shares the rollback mechanism), WS-D.1 (staff roles for emergency vs. owner/metrics-lead authorization), WS-C.1.3 (feature-flag toggle to control variant).

**Observability:** Emit `experiment.manual_rollback` with operator, reason, and whether it was emergency. The launch checklist records a `rollback.tested` event before each experiment start; a launch is blocked if this is absent.

**Security/privacy:** Authorization is role-gated and audited (WS-D). Data preservation on rollback ensures the experiment can still be analyzed for the harm it may have caused before rollback, supporting accountability.

---

## WS-P.1.4 Knomosis governance and payment metrics (transparency-only)

### WS-P.1.4a Knomosis metric definitions and isolation
**ID:** WS-P.1.4a
**Ref:** Section 28.3

**Description:**
Implement the eight Knomosis governance and payment metrics from §28.3 in a metric store that is *physically separate* from the product-health store and is consumed ONLY by the transparency pipeline and finance reporting -- never by a growth/product dashboard and never as an experiment success criterion. The metrics and their exact definitions:

- **Public-value grant completion** = `funded_grants_with_accepted_evidence_or_context_outputs / funded_grants` (guards against treasury waste). Sourced from grant/proposal outcomes (WS-M.4) and accepted-evidence/context records (WS-G/WS-F).
- **Transaction comprehension** = user-test success rate on transaction-preview meaning (guards against blind signing). Sourced from transaction-preview comprehension test results (WS-L.2 / usability testing).
- **Treasury-transparency completeness** = share of treasury actions with a clear proposal, recipient, amount, and outcome all present (guards against dark-money governance). Sourced from the treasury ledger and proposal records (WS-M.2, WS-M.4).
- **Governance diversity** = participation breadth across eligible *civic* accounts (explicitly NOT weighted by wallet wealth) (guards against capture). Sourced from proposal/vote participation (WS-M.4) joined to eligible-account counts.
- **Proposal-dispute rate** = `proposals_challenged_for_conflict_fraud_or_policy / proposals` (guards against unaccountable execution). Sourced from proposal-dispute records (WS-M.4).
- **Financial-incident rate** = confirmed scams/fraud/mistaken transfers/compromise per active wallet (guards against unsafe expansion). Sourced from financial incident cases (WS-N.2 / WS-L) over active-wallet counts (WS-L.2).
- **Pay-to-rank leakage** = measured correlation between payments and ranking *after controls* (guards against wealth-driven visibility). Sourced from the ranking-neutrality test suite (WS-I.3); the target is no detectable correlation.
- **Treasury-reconciliation gap** = divergence between the app ledger, Knomosis receipts, and L1 state; *must be zero or explained before expansion* (guards against hidden divergence). Sourced from the reconciliation worker (WS-L.3 / WS-M.2).

The store enforces, by namespace and by the WS-P.1.2d exclusion validator, that none of these ids can be referenced by a product-health dashboard query or by an experiment success-criteria field. Governance diversity is computed on civic-account breadth and is structurally prevented from being weighted by wallet balance.

**Acceptance criteria:**
- All eight §28.3 metrics are defined and computed with the definitions above, each annotated with the risk it guards against.
- The metrics live in a store separate from the product-health store and are surfaced only via the transparency pipeline and finance reporting.
- None of the eight can be added to a growth/product dashboard or used as an experiment success criterion (enforced by the WS-P.1.2d validator and a binding test).
- Governance diversity is computed on civic-account breadth, never weighted by wallet wealth.
- Pay-to-rank leakage is sourced from the WS-I.3 neutrality suite and reports "no detectable correlation" as the healthy state.
- Treasury-reconciliation gap reports zero-or-explained and flags any unexplained divergence as a pre-expansion blocker.

**Testing:**
- Unit: Verify each metric computation from synthetic governance/treasury/incident inputs.
- Unit: Verify governance diversity is unchanged when wallet balances are scaled (wealth has no effect on the metric).
- Binding test: Attempt to add a §28.3 metric id to a product-health dashboard or an experiment primary-metric slot; verify rejection.
- Integration: Inject a reconciliation divergence; verify treasury-reconciliation gap flags it and marks the expansion blocker.

**Dependencies:** WS-M.4 (proposals, votes, disputes, grants), WS-M.2 (treasury ledger and actions), WS-L.2 (wallet counts and transaction-preview comprehension tests), WS-L.3 (reconciliation worker / receipts), WS-N.2 (financial incident cases), WS-I.3 (pay-to-rank leakage from the neutrality suite). All inputs read behind crypto feature flags and fail closed (metrics read "n/a / feature disabled") when crypto is off, so the core product is never blocked.

**Observability:** Emit `knomosis_metric.computed` per metric with value and the guarded-risk tag; emit `knomosis_metric.reconciliation_gap.nonzero` as a high-priority pre-expansion blocker. These flow only to the transparency report and finance dashboards.

**Security/privacy:** These are governance/financial integrity figures, separated from product health per §28.3 and the revenue-separation invariant. Per-wallet and per-account data are aggregated; financial-incident rate is reported per active wallet at population scale, never naming an account. Pay-to-rank leakage being publishable is the strongest possible signal that money does not buy distribution.

---

## WS-P.2 Transparency pipeline

### WS-P.2.1a Moderation action aggregation
**ID:** WS-P.2.1a
**Ref:** Section 29

**Description:**
Implement aggregation of moderation actions for inclusion in transparency reports. The aggregation groups moderation actions by: category (harassment, spam, misinformation, illegal content, policy violation, coordinated abuse), severity (warning, content removal, account restriction, account suspension, escalation to law enforcement), and time period (weekly, monthly, quarterly). Aggregation applies small-cell suppression: any cell with fewer than the configured threshold (default: 5) of actions is suppressed or merged with an adjacent category to prevent identification of individuals involved in rare moderation events. The aggregation outputs a structured dataset suitable for the report generator (WS-P.2.1d).

**Acceptance criteria:**
- Moderation actions are aggregated by category, severity, and time period.
- Small-cell suppression is applied: cells with fewer than the threshold are suppressed or merged.
- The suppression threshold is configurable (default: 5).
- Aggregated data cannot identify individual users or individual moderation events.
- Output format is compatible with the report generator (WS-P.2.1d).

**Testing:**
- Unit: Verify aggregation produces correct counts from known moderation action data. Verify small-cell suppression suppresses cells below threshold. Verify merged cells are labeled.
- Integration: Ingest a set of moderation actions. Run aggregation. Verify output counts. Inject a rare category with 2 actions. Verify it is suppressed.

**Dependencies:** WS-J.2 (moderation action log: categories, severities, timestamps), WS-A (moderation taxonomy for category definitions). Reuses the shared small-cell suppression utility (defined here and consumed by WS-P.2.1b/c).

**Observability:** Emit `transparency.moderation.aggregated` with per-period totals and a suppression count (how many cells were suppressed/merged), so reviewers can see suppression is active without seeing the suppressed values.

**Security/privacy:** Aggregation is metadata-only (no content, no identities). Small-cell suppression prevents re-identification of individuals in rare moderation events; merged cells are labeled so suppression is transparent rather than hidden.

---

### WS-P.2.1b Integrity incident aggregation
**ID:** WS-P.2.1b
**Ref:** Section 29

**Description:**
Implement aggregation of integrity incidents for transparency reports. Integrity incidents include MFCI coordination detections, tropical cascade events, and governance-capture signals. The aggregation groups incidents by: type (coordination, cascade, capture), severity, outcome (true positive confirmed, false positive cleared, under review), and time period. MFCI coordination incidents include the number of accounts involved (suppressed if below threshold), the number of content items affected, and the duration from detection to resolution. Escalation outcomes (referral to law enforcement, platform-level restriction) are counted separately. Small-cell suppression applies to all aggregations.

**Acceptance criteria:**
- Integrity incidents are aggregated by type, severity, outcome, and time period.
- MFCI coordination incidents include account count (suppressed if below threshold), content items affected, and detection-to-resolution duration.
- Escalation outcomes are counted separately.
- Small-cell suppression applies to all aggregations.
- Output format is compatible with the report generator (WS-P.2.1d).

**Testing:**
- Unit: Verify aggregation from known integrity incident data. Verify small-cell suppression. Verify escalation outcome counting.
- Integration: Ingest integrity incidents of various types and severities. Run aggregation. Verify output matches expected structure and counts.

**Dependencies:** WS-H.3 (MFCI coordination incidents), WS-H.7 (tropical cascade events), WS-M.4 (governance-capture signals), WS-J (integrity case outcomes and escalations). Reuses the WS-P.2.1a small-cell suppression utility.

**Observability:** Emit `transparency.integrity.aggregated` with per-type counts and suppression count. False-positive-cleared counts are reported alongside true positives so the report shows detection quality, not just detection volume.

**Security/privacy:** Account counts within incidents are suppressed below threshold; no investigative method or specific account is exposed. Reporting false positives cleared is itself an accountability commitment (the platform shows when it was wrong).

---

### WS-P.2.1c Invariant health summary
**ID:** WS-P.2.1c
**Ref:** Section 29

**Description:**
Implement a per-invariant health summary for transparency reports. For each invariant (MERI, MFCI, SCOI, GWEI, PHI), the summary includes: current confidence level (high/medium/low with numeric score), coverage percentage (proportion of content/users/rooms the invariant actively monitors), failure rate (proportion of computations that fell back to default behavior due to insufficient data or errors), version identifier, and notable changes during the reporting period. The summary is computed from the invariant health metrics (WS-P.1.1b) and is designed for a non-technical audience -- each invariant has a plain-language description of what it monitors and why.

**Acceptance criteria:**
- Summary is produced for each of the five invariants: MERI, MFCI, SCOI, GWEI, PHI.
- Each summary includes confidence, coverage, failure rate, version, and notable changes.
- Plain-language descriptions are included for each invariant.
- Summaries are derived from WS-P.1.1b metrics.
- Output format is compatible with the report generator (WS-P.2.1d).

**Testing:**
- Unit: Verify summary computation from known invariant health metric data. Verify plain-language descriptions are present and non-empty.
- Integration: Run invariant health metric computation. Generate summaries. Verify all five invariants are represented with complete fields.

**Dependencies:** WS-P.1.1b (invariant health metrics, confidence, coverage, fallback, version), WS-H.1 (invariant version identifiers and fallback semantics), WS-A (plain-language transparency dictionary for invariant descriptions).

**Observability:** Emit `transparency.invariant_summary.built` per invariant with confidence, coverage, and failure rate. A high failure (fallback) rate surfaced here also feeds the invariant teams as a quality signal.

**Security/privacy:** Summaries are aggregate health figures with plain-language explanations; they reveal that an invariant exists and how well it is working without revealing the manipulation defenses it implements (addressing Open Question 4 / Section 28). No per-user or per-incident detail appears.

---

### WS-P.2.1d Report generation
**ID:** WS-P.2.1d
**Ref:** Section 29

**Description:**
Implement the transparency report generator that combines moderation action aggregation (WS-P.2.1a), integrity incident aggregation (WS-P.2.1b), invariant health summaries (WS-P.2.1c), anti-metric trends (WS-P.1.2d), and experiment summaries (from WS-P.1.3b) into a publishable report. The report is generated in a structured format (JSON for programmatic access, HTML for human reading) that can be published without manual reconstruction. The generator runs on a configurable schedule (default: monthly) and can be triggered on demand. Each report includes a generation timestamp, the reporting period, a data completeness indicator (percentage of expected data sources that contributed), and a version identifier. Reports are immutable once generated -- corrections are published as amendments referencing the original.

The generator also includes a **Knomosis transparency section** sourced from WS-P.1.4 (the eight §28.3 governance/payment metrics, including pay-to-rank leakage and the treasury-reconciliation gap) so financial-integrity figures appear in transparency reports but not in product dashboards. The report explicitly lists prohibited-experiment rejections and experiment blocking/rollback events so readers can see the no-applause and guardrail rules being enforced. The report also carries an explicit **scope/limitations statement**: its content, moderation/integrity, and experiment figures cover **server-hosted content only**; `private_p2p` rooms (WS-S) are E2EE and member-hosted, so the platform structurally cannot read, measure, or report their content, and legal-request statistics reflect this structural inability to produce private content (overlaps the WS-N lawful-access posture, WS-N.2.3d). Where WS-R / LCAP is active, an availability-transport section reports availability-shaped stats (verified availability per cost, sync success), explicitly not engagement.

**Acceptance criteria:**
- Reports combine data from WS-P.2.1a, WS-P.2.1b, WS-P.2.1c, WS-P.1.2d, and WS-P.1.3b.
- Reports are generated in JSON and HTML formats.
- No manual data entry or reconstruction is required.
- Generation runs on a configurable schedule (default: monthly) and on demand.
- Each report includes timestamp, period, data completeness indicator, and version.
- Reports are immutable; corrections are published as amendments.
- Reports include a Knomosis transparency section (WS-P.1.4) and an experiment-enforcement section (prohibited rejections, guardrail rollbacks).
- The report carries an explicit scope/limitations statement (content/moderation/experiment figures cover server-hosted content only; `private_p2p` content is unmeasurable by design; legal-request stats reflect the structural inability to produce private content).

**Testing:**
- Unit: Verify report assembly logic combines all data sources correctly. Verify JSON and HTML output formats are valid.
- Integration: Populate all data sources with test data. Trigger report generation. Verify the report includes all sections. Verify the HTML renders correctly. Verify immutability -- attempt to modify a generated report and verify rejection.
- Integration: Verify the Knomosis section appears with §28.3 metrics and the experiment-enforcement section lists rejections/rollbacks.

**Dependencies:** WS-P.2.1a, WS-P.2.1b, WS-P.2.1c (aggregations/summaries), WS-P.1.2d (anti-metric section), WS-P.1.3b (experiment summaries and enforcement events), WS-P.1.4a (Knomosis transparency section).

**Observability:** Emit `transparency.report.generated` with period, version, data-completeness percentage, and which sources contributed. A low data-completeness value blocks auto-publication and routes to human review (WS-P.2.1e) with the gap noted.

**Security/privacy:** The generator only consumes pre-aggregated, suppressed inputs; it adds no new data exposure. Immutability + amendment-by-reference creates an auditable public record. The Knomosis section keeps financial-integrity reporting in transparency only, honoring the revenue-separation invariant.

---

### WS-P.2.1e Report review workflow
**ID:** WS-P.2.1e
**Ref:** Section 29

**Description:**
Implement a human review workflow for transparency reports before publication. After the report generator (WS-P.2.1d) produces a draft report, it enters a review state. Authorized reviewers (policy lead, legal, communications) can: preview the report, flag sections for revision (e.g., if small-cell suppression is insufficient or a section could inadvertently reveal investigative methods), approve the report for publication, or reject it with comments. The report is published only after all required reviewers approve. The review workflow logs all reviewer actions (preview, flag, approve, reject) with timestamps and reviewer identity for audit. A report that is not approved within the configured window (default: 7 days) triggers an escalation alert.

**Acceptance criteria:**
- Generated reports enter a review state before publication.
- Authorized reviewers can preview, flag, approve, or reject.
- Publication requires approval from all required reviewers.
- All reviewer actions are logged with timestamps and identity.
- Reports not approved within the configured window trigger escalation.
- Rejected reports include comments explaining the rejection.

**Testing:**
- Unit: Verify state transitions: draft -> in review -> approved -> published. Verify rejection returns to draft.
- Integration: Generate a report. Assign reviewers. Approve from all reviewers. Verify publication. Generate another report. Reject from one reviewer. Verify the report is not published. Verify escalation fires after the approval window expires.

**Dependencies:** WS-P.2.1d (draft reports), WS-D.1 (reviewer roles: policy lead, legal, communications), WS-D (staff audit trail for reviewer actions).

**Observability:** Emit `transparency.report.reviewed` (per reviewer action) and `transparency.report.review_overdue` (escalation). A review dashboard shows pending reports and time-to-deadline.

**Security/privacy:** Human review is the final safeguard against accidental disclosure (insufficient suppression, leaked investigative method) before a report becomes public. All reviewer actions are audited, creating accountability for what is and is not published.

---

### WS-P.2.1f Transparency publication and cadence
**ID:** WS-P.2.1f
**Ref:** Sections 29, 28.4

**Description:**
Implement publication of approved transparency reports on a committed, DSA-style periodic cadence and maintain a public, immutable archive. After all required reviewers approve (WS-P.2.1e), the report is published to the public transparency endpoint in both JSON (programmatic) and HTML (human) forms, with a stable, versioned URL and a published-at timestamp. A cadence scheduler enforces the commitment: reports are published at least on the configured period (default monthly summary plus a periodic comprehensive report), and a missed-cadence alert fires if an approved report is not published within the committed window. The archive lists every published report and every amendment (corrections reference the original; originals are never silently replaced), so the public can audit the full history. Publication is locale-aware (the HTML report is internationalized via WS-P.2.2a and renders correctly in RTL via WS-P.2.2b).

**Acceptance criteria:**
- Approved reports are published in JSON and HTML at a stable, versioned URL with a published-at timestamp.
- A cadence scheduler enforces the committed publication period and raises a missed-cadence alert if a report is overdue.
- A public, immutable archive lists all reports and amendments; amendments reference the original.
- The published HTML report is internationalized and renders correctly in LTR and RTL.
- Publication occurs only after WS-P.2.1e approval (no unreviewed report is ever published).

**Testing:**
- Integration: Approve a report; verify it publishes to the endpoint in both formats with a stable URL and timestamp, and appears in the archive.
- Integration: Let the cadence window lapse without an approved report; verify the missed-cadence alert fires.
- Integration: Publish an amendment; verify it references the original and the original remains unchanged.
- E2E/A11y: Render the published HTML report in an RTL locale; verify layout and that disclosure/links are accessible.

**Dependencies:** WS-P.2.1e (approval gate), WS-P.2.1d (immutable reports/amendments), WS-P.2.2a (i18n of report copy), WS-P.2.2b (RTL rendering), WS-N.1 (any jurisdiction-specific publication requirements).

**Observability:** Emit `transparency.report.published` (with URL, version, locale availability) and `transparency.cadence.missed`. A public-facing "last updated / next expected" indicator is driven by these events.

**Security/privacy:** Only reviewed, suppressed reports are published. The immutable archive and amendment-by-reference model make the platform's transparency record itself auditable and tamper-evident, supporting the GA gate "transparency reports generate from live data" (§28.4).

---

### WS-P.2.2a i18n pipeline setup
**ID:** WS-P.2.2a
**Ref:** Section 26.4

**Description:**
Set up the internationalization pipeline for UI strings. Integrate a localization library (e.g., `react-intl` or `i18next`) into the React application. Implement string extraction tooling that scans all component files and extracts translatable strings into a structured translation file format (JSON or ICU MessageFormat). The pipeline supports: pluralization rules per locale, date/time/number formatting per locale, and interpolation of dynamic values. A default locale (English) is the source of truth. Translation files for additional locales are structured as key-value pairs matching the default locale keys. Missing translations fall back to the default locale with a console warning in development. The extraction tool runs as a CI check to detect untranslated strings. The pipeline must also accommodate the mandatory disclosure-copy surfaces the extension workstreams introduce as locale-ready strings: WS-S (`docs/planning/20-private-p2p-rooms.md` WS-S.0.3) room-class creation/removal acknowledgments, the privacy-matrix copy, the three room-class names ("Public room" / "Members-only server room" / "Private P2P room"), and the honest Tier-1 limitation copy; and WS-R (`docs/planning/19-offline-content-availability.md` §34) trust/liveness label copy (provisional/stale/conflict/revoked/rejected). Beyond untranslated-string detection, this copy must pass a **prohibited-language scan** (no false "secure"/"trusted"/"delivered"/"deleted everywhere") — the doctrine constraint owned by WS-S/WS-R; the extraction/coverage check is aware these surfaces exist even before WS-R/WS-S land.

**Acceptance criteria:**
- A localization library is integrated into the React application.
- All UI strings in existing components are extracted to translation files.
- Pluralization, date/time/number formatting, and interpolation are supported per locale.
- Missing translations fall back to the default locale.
- A CI check detects new untranslated strings.
- Translation file format is documented for translators.
- The pipeline accommodates and prohibited-language-scans the WS-S disclosure copy (room-class names, creation/removal acknowledgments, privacy matrix, Tier-1 limitation) and WS-R trust/liveness labels as locale-ready surfaces.

**Testing:**
- Unit: Verify string rendering with the default locale. Switch locale to a test locale. Verify strings render from the test translation file. Verify missing keys fall back to default.
- CI: Run the extraction tool. Verify all strings in components have corresponding keys in the default translation file.

**Dependencies:** WS-C.1 (React app and routing for locale context/provider), WS-B (design-system components must consume strings via the i18n API, not hardcoded text), WS-0.4 (CI to run the extraction/coverage check).

**Observability:** The CI extraction check emits an untranslated-string count per locale; a development-mode console warning fires on each missing-key fallback so gaps surface during build, not in production.

**Security/privacy:** Translation files contain UI copy only (no user data). The pipeline is a precondition for serving language communities responsibly (Section 26.4), which the spec ties to local moderator/steward capacity before launch.

---

### WS-P.2.2b RTL layout support
**ID:** WS-P.2.2b
**Ref:** Section 26.4

**Description:**
Implement right-to-left (RTL) layout support across the application. All layout CSS uses logical properties (`margin-inline-start` instead of `margin-left`, `padding-inline-end` instead of `padding-right`, `inset-inline-start` instead of `left`, etc.) so that the layout automatically mirrors for RTL locales. The `dir` attribute is set on the root element based on the active locale. Bidirectional text rendering is handled correctly: mixed LTR/RTL content within a single element uses the Unicode Bidirectional Algorithm, and explicit `dir` attributes are set on user-generated content blocks based on text direction detection. Icons that have directional meaning (arrows, navigation indicators) are mirrored for RTL. The design system components (WS-B) are verified to render correctly in RTL.

**Acceptance criteria:**
- All layout CSS uses logical properties (no physical `left`/`right`/`margin-left`/`padding-right`).
- The `dir` attribute is set on the root element based on locale.
- Bidirectional text in UGC is handled with direction detection.
- Directional icons are mirrored for RTL locales.
- All design system components render correctly in both LTR and RTL.
- No visual regressions in LTR when RTL support is added.

**Testing:**
- E2E: Render the application in an RTL locale (e.g., Arabic). Screenshot major pages. Verify layout is mirrored. Verify bidirectional text renders correctly. Verify icons are mirrored.
- Unit: Verify CSS logical property usage (lint rule rejects physical directional properties in new code).
- Visual regression: Compare LTR screenshots before and after RTL support to verify no LTR regressions.

**Dependencies:** WS-P.2.2a (locale/`dir` context), WS-B (design-system components and the Biome/lint rule banning physical directional properties), WS-G (UGC blocks for per-block direction detection).

**Observability:** The logical-property lint rule runs in CI and reports any physical directional property in new code. A visual-regression suite tracks RTL/LTR parity per component over time.

**Security/privacy:** Direction detection on UGC operates on user-visible text only and introduces no new data exposure; bidi handling prevents spoofing/obscuring of text via mixed-direction tricks.

---

### WS-P.2.2c Translation disclosure
**ID:** WS-P.2.2c
**Ref:** Section 26.4

**Description:**
Implement translation disclosure so that users can access the original text when content is shown in translation. When a contribution, context card, or AI-generated summary is displayed in a translated form, the UI shows a disclosure indicator ("Translated from [language]") and provides a toggle to view the original text. The original text is always preserved alongside the translation. Translations are attributed to their source (machine translation, community translation, or official translation). Machine translations carry a specific disclosure label. Users can report translation errors, which routes to the moderation/steward queue. The disclosure indicator is accessible (screen-reader-announced) and does not increase layout shift.

**Acceptance criteria:**
- Translated content shows a "Translated from [language]" disclosure indicator.
- Users can toggle between translated and original text.
- Original text is always preserved; translations never replace the original.
- Translation source is attributed (machine, community, official).
- Machine translations carry a specific disclosure label.
- Translation errors can be reported via the standard report flow.
- The disclosure indicator is screen-reader-accessible and does not cause layout shift.

**Testing:**
- Unit: Verify disclosure indicator renders for translated content. Verify toggle switches between translated and original text. Verify translation source attribution.
- E2E: Display a translated contribution. Verify the disclosure indicator is visible. Toggle to original text. Verify the original is displayed. Report a translation error. Verify the report is routed to the moderation queue.
- Accessibility: Verify screen reader announces the disclosure indicator.

**Dependencies:** WS-P.2.2a (i18n pipeline), WS-G (contributions and context cards as translatable content sources), WS-K (AI-generated summaries and their machine-translation labeling), WS-J.1 (report flow for translation-error reports), WS-B (accessible disclosure/toggle component with no layout shift).

**Observability:** Emit `translation.disclosure.shown` and `translation.original.viewed` (aggregate counts only) and `translation.error.reported`. A high translation-error-report rate for a language flags translation quality to stewards.

**Security/privacy:** Original text is always preserved and one tap away, so translation never silently alters meaning -- a transparency guarantee. Machine-translation labeling sets correct user expectations. Disclosure interactions are counted in aggregate only, never as per-user behavioral tracking.

---

### WS-P.2.2d Region-sensitive policy
**ID:** WS-P.2.2d
**Ref:** Section 26.4

**Description:**
Implement region-sensitive policy handling in the client and server. Locale-aware formatting applies to all user-facing numbers, dates, times, and currencies using the `Intl` API with the user's locale. Region-specific policies are loaded from the jurisdiction engine (WS-N.1) and affect: content availability (some content may be restricted in specific regions), feature availability (some features may be disabled in specific regions per WS-N.1), legal notices (privacy policy, terms of service, required disclosures vary by region), and consent flows (GDPR, CCPA, and other regional consent requirements). The client detects the user's region from their locale settings and account configuration (not from IP geolocation alone). Region-specific policy overrides are applied at the server level and cannot be bypassed by client-side locale changes.

**Acceptance criteria:**
- Numbers, dates, times, and currencies are formatted per the user's locale using the `Intl` API.
- Region-specific content and feature restrictions are enforced from the jurisdiction engine.
- Legal notices and consent flows vary by region.
- Region is determined from locale settings and account configuration, not IP geolocation alone.
- Region-specific policies are enforced server-side and cannot be bypassed by client-side changes.
- Policy changes per region are logged for audit.

**Testing:**
- Unit: Verify locale-aware formatting for numbers, dates, and currencies across multiple locales. Verify region-specific policy loading.
- Integration: Set a test account to a specific region. Verify region-specific content restrictions are applied. Change the region. Verify restrictions update. Attempt to bypass region restrictions via client-side locale change. Verify server-side enforcement blocks the bypass.

**Dependencies:** WS-P.2.2a (locale/formatting context), WS-N.1 (jurisdiction engine for region policies, legal notices, feature availability), WS-D.1/WS-D.2 (account region configuration and consent records). Region-based feature gating must respect crypto feature flags (crypto stays fail-closed where unavailable).

**Observability:** Emit `region.policy.applied` (region, policy version, affected features) and `region.policy.changed`. A mismatch between client-detected region and server-enforced region is logged so attempted client-side bypasses are visible.

**Security/privacy:** Region is derived from locale and explicit account configuration, not IP alone, reducing covert geolocation. Server-side enforcement is authoritative so a client cannot evade jurisdiction rules. Policy changes are audited, and consent flows honor regional privacy law (GDPR/CCPA).

---

## WS-P.3 Launch operations

### WS-P.3.1a Phase success-metric gates
**ID:** WS-P.3.1a
**Ref:** Section 28.4

**Description:**
Encode the §28.4 success-metrics-by-phase as machine-checkable launch gates that read live metrics from WS-P.1 and WS-P.2 and produce a per-phase readiness report. The gates map the spec's phase criteria to concrete checks:

- **Alpha:** users understand why content is shown (explanation-quality metric, WS-P.3.2a, above target); the structured composer does not block participation (constructive-participation rate stable/not depressed vs. a pre-composer baseline); MERI dedup improves perceived feed quality (MERI distribution healthy + qualitative signal); source-opening and evidence-addition are measurable (WS-P.1.1a producing non-trivial values); moderation tools handle early abuse (harassment-protection latency within target, WS-P.1.1c).
- **Beta:** PWAtt outperforms chronological on user-rated usefulness (experiment readout via WS-P.1.3, not engagement-based); coordinated activity detected without high false positives (MFCI incidents-by-severity with acceptable false-positive-cleared share, WS-P.1.1b); context cards reduce cross-community misunderstanding (SCOI reduction after bridge positive, WS-P.1.1b); Core Web Vitals targets met (WS-P.1.1d); accessibility audits pass core flows (accessibility-defect rate within threshold).
- **GA:** transparency reports generate from live data (WS-P.2 publishing on cadence); invariant dashboards stable (WS-P.1.1b coverage/failure within bounds); appeals operational (appeal-overturn rate computed and within sane range); ranking experiments have release gates (WS-P.1.3 + WS-I.3 wired); security and accessibility reviews pass (WS-O, WS-B gates green).

Each gate is green/amber/red with the underlying metric values and is consumed by the milestone gate checklists in `00-index.md` and by the go/no-go board (WS-P.3.3a). These phase gates evaluate **core-product** (server-hosted) health; **WS-R** and **WS-S** are post-M3 P3 **extension** rollouts with their own launch gates (WS-R: `docs/OFFLINE_SPEC.md` §36 acceptance suite; WS-S: `docs/PRIVATE_SPEC.md` §29 launch checklist) and their own fail-closed kill switches/feature flags, and are **not launch-blocking** for the core social product — their gate status is a separate input to the board, never folded into the Alpha/Beta/GA criteria here.

**Acceptance criteria:**
- Alpha, Beta, and GA success criteria from §28.4 are each encoded as concrete, machine-checkable gates reading live WS-P metrics.
- Each gate reports green/amber/red with the underlying metric values and the source metric id.
- No gate uses engagement alone; PWAtt-vs-chronological is evaluated on user-rated usefulness via an experiment readout, not dwell.
- The readiness report is consumable by the go/no-go board (WS-P.3.3a) and aligns with the milestone gates in `00-index.md`.

**Testing:**
- Unit: For each phase gate, feed passing and failing metric fixtures; verify correct green/amber/red classification.
- Integration: Run the readiness report against seeded live-style metrics; verify each phase section is populated with values and sources.
- Unit: Verify a gate cannot be satisfied by an engagement-only proxy (the PWAtt-usefulness gate requires the usefulness experiment readout).

**Dependencies:** WS-P.1.1a-d (all product-health metrics), WS-P.1.1b (invariant health), WS-P.1.3 (experiment readouts for PWAtt-vs-chronological and release gates), WS-P.2.1f (transparency cadence for GA), WS-P.3.2a (explanation-quality metric for Alpha), WS-I.3 (neutrality release gates), WS-O / WS-B (security/accessibility gate status).

**Observability:** Emit `launch.phase_gate.evaluated` per phase with each sub-gate's status and value. The readiness report is the canonical artifact reviewed at milestone gates and at the go/no-go board.

**Security/privacy:** Gates read aggregate metrics only. Encoding §28.4 as machine checks prevents a launch from proceeding on vibes; every phase advance is backed by auditable, privacy-preserving metric values.

---

### WS-P.3.2a Explanation-quality metric
**ID:** WS-P.3.2a
**Ref:** Sections 28.4, 13.5

**Description:**
Implement a metric for "users understand why content is shown" (an explicit Alpha success criterion in §28.4), grounded in the explanation examples of §13.5 ("Shown because readers in three rooms opened the source and added independent evidence," "Shown with context because communities are interpreting the quote differently," etc.). The metric combines: explanation coverage = share of ranked items that carry a user-facing distribution explanation (every item should; this should be ~100% and any gap is a defect), and explanation comprehension = success rate on periodic user-tests asking participants to interpret a real explanation string's meaning. The metric explicitly avoids any engagement proxy. It is exposed to the dashboard, the transparency pipeline, and the Alpha phase gate (WS-P.3.1a).

**Acceptance criteria:**
- Explanation coverage is computed as the share of ranked items carrying a user-facing explanation, with any uncovered item flagged as a defect.
- Explanation comprehension is computed from periodic user-test results interpreting real §13.5-style explanation strings.
- The metric uses no engagement proxy (not clicks, not dwell).
- The metric is available to the dashboard, transparency reports, and the Alpha gate (WS-P.3.1a).

**Testing:**
- Unit: Verify coverage computation flags an item lacking an explanation.
- Unit: Verify comprehension computation from labeled user-test results.
- Integration: Feed ranked items (some without explanations) and a user-test set; verify both sub-metrics and that the Alpha gate consumes them.

**Dependencies:** WS-I.2.6 (user-facing distribution explanations / explanation generation), WS-I.2.5 (decision logs that back explanations), WS-K (any AI-generated explanation phrasing), usability-testing inputs for comprehension. No engagement data is consumed.

**Observability:** Emit `metric.explanation.coverage` and `metric.explanation.comprehension`. An uncovered-item alert fires if explanation coverage drops below ~100% (every distributed item must be explainable, per §13.6's ban on hiding behind "the algorithm").

**Security/privacy:** The metric measures whether the platform is honest about *why* content is shown, directly supporting the transparency mandate. Comprehension testing uses aggregate test results, not user surveillance.

---

### WS-P.3.3a Launch go/no-go review board
**ID:** WS-P.3.3a
**Ref:** Sections 28.4, 30.10

**Description:**
Implement the go/no-go review board workflow referenced by the M5 ("Review board — weekly go/no-go") and M6 milestone gates in `00-index.md`. The board convenes on a defined cadence (weekly during the capped real-funds pilot) and renders a recorded go/no-go decision for the current phase. Each session ingests: the phase readiness report (WS-P.3.1a), current anti-metric breach status (WS-P.1.2c), open safety incidents and SLA status (WS-J / WS-P.1.1c), invariant stability (WS-P.1.1b), security review status (WS-O), the Knomosis governance/payment metrics including the treasury-reconciliation gap and pay-to-rank leakage (WS-P.1.4), and any active experiment guardrail breaches/rollbacks (WS-P.1.3). A decision is one of {go, conditional-go with named conditions, no-go} and is recorded with attendees, the evidence snapshot, conditions, and owner. A no-go or conditional-go automatically tracks its conditions to closure before the next phase advance. The board cannot record "go" while a hard blocker is red (e.g., unexplained treasury-reconciliation gap, an unresolved high-severity security issue, or an active anti-metric breach), and "go" is never permitted on engagement grounds alone.

**Acceptance criteria:**
- The board renders a recorded decision {go | conditional-go | no-go} per session with attendees, evidence snapshot, conditions, and owner.
- Sessions ingest the readiness report, anti-metric status, safety/SLA, invariant stability, security status, Knomosis metrics, and experiment guardrail status.
- A "go" decision is blocked while any hard blocker is red (unexplained reconciliation gap, unresolved high-severity security issue, active anti-metric breach).
- Conditional-go conditions are tracked to closure before the next phase advance.
- No decision can be justified by engagement metrics alone (the workflow rejects an engagement-only rationale).
- Decisions are auditable and feed the milestone gate checklists.

**Testing:**
- Integration: Convene a session with all inputs green; verify a "go" can be recorded with the evidence snapshot.
- Integration: Set the treasury-reconciliation gap to unexplained-nonzero; verify "go" is blocked and only no-go/conditional-go are possible.
- Unit: Verify a conditional-go records and tracks named conditions and blocks phase advance until closed.
- Unit: Verify an engagement-only rationale is rejected.

**Dependencies:** WS-P.3.1a (readiness report), WS-P.1.2c (anti-metric status), WS-P.1.1b (invariant stability), WS-P.1.1c / WS-J (safety/SLA), WS-O (security status), WS-P.1.4a (Knomosis metrics: reconciliation gap, pay-to-rank leakage), WS-P.1.3 (experiment guardrail/rollback status), WS-D (board roles and audit trail).

**Observability:** Emit `launch.review_board.decision` with decision, conditions, and the evidence snapshot reference, and `launch.review_board.condition_closed`. A dashboard shows open conditions and the current hard-blocker status feeding the next session.

**Security/privacy:** The board reviews aggregate metrics and incident status, not user data. Recording decisions with their evidence snapshot creates accountability for every phase advance, and the hard-blocker rule (reconciliation gap, security, anti-metric breach) operationalizes the spec's "must be zero or explained before expansion" and no-engagement-only-launch rules.

---

## Task dependency summary

| Task | Depends on |
|---|---|
| WS-P.1.1a (Participation metrics) | WS-G (forum contributions), WS-F (source model), WS-E (event pipeline), WS-K (low-information classifier) |
| WS-P.1.1b (Invariant health metrics) | WS-H (all invariant services), WS-J (integrity case outcomes) |
| WS-P.1.1c (Safety metrics) | WS-J (trust and safety -- moderation actions, appeals), WS-B/WS-0.4 (accessibility findings) |
| WS-P.1.1d (Performance metrics) | WS-C (PWA client -- web-vitals integration), WS-E.1 (RUM transport) |
| WS-P.1.1e (Metrics dashboard) | WS-P.1.1a through WS-P.1.1d, WS-D (staff roles/audit), WS-B (charts) |
| WS-P.1.2a (Anti-metric definitions) | WS-P.1.1a (participation baseline + shared store), WS-J (outrage signal), WS-K (speculation), WS-E.1 (dwell/session aggregation) |
| WS-P.1.2b (Crypto anti-metrics) | WS-P.1.2a (registry), WS-L (Knomosis -- wallet data), WS-M (treasury data) |
| WS-P.1.2c (Anti-metric monitoring) | WS-P.1.2a, WS-P.1.2b, WS-P.1.3a (experiment-arm mapping) |
| WS-P.1.2d (Anti-metric reporting) | WS-P.1.2c, WS-P.2.1d (report generator), WS-0.4 (CI exclusion check) |
| WS-P.1.3a (Experiment assignment) | WS-C.1.3 (feature flags), WS-D.1 (account age), WS-G.2 (room cohorts) |
| WS-P.1.3b (Experiment registry) | WS-P.1.3a, WS-P.1.3d (prohibited types), WS-P.1.2c (baselines), WS-P.1.1b (invariant metrics for ranking experiments), WS-A (sensitive/minors policy) |
| WS-P.1.3c (Experiment guardrails) | WS-P.1.3b, WS-P.1.2c (anti-metric monitoring), WS-P.1.1b (invariant health), WS-P.1.1c (safety metrics), WS-P.1.3e (rollback mechanism) |
| WS-P.1.3c-1 (Guardrail evaluation engine and auto-rollback) | WS-P.1.3b, WS-P.1.2c, WS-P.1.1b, WS-P.1.1c, WS-P.1.3e |
| WS-P.1.3c-2 (Wellbeing/fairness guardrails) | WS-P.1.3c-1, WS-P.1.2a/b, WS-P.1.1b, WS-P.1.1a, WS-P.1.3b |
| WS-P.1.3d (Prohibited experiment types) | None (schema-level constraint, implemented first); WS-A.1.1 (denylist source) |
| WS-P.1.3d-1 (Prohibited-signal pattern block + attestation) | WS-A.1.1 (denied-signal list), WS-P.1.3b (registry hooks) |
| WS-P.1.3d-2 (Engagement-only success-criteria validator) | WS-P.1.2a/b (anti-metric registry), WS-P.1.1a-d (metric catalog), WS-P.1.3b (registry hooks) |
| WS-P.1.3e (Experiment rollback switches) | WS-P.1.3a (assignment), WS-P.1.3c-1 (rollback mechanism), WS-D.1 (roles), WS-C.1.3 (flags) |
| WS-P.1.4a (Knomosis governance/payment metrics) | WS-M.4 (proposals/votes/disputes/grants), WS-M.2 (treasury ledger), WS-L.2 (wallet counts, comprehension tests), WS-L.3 (reconciliation/receipts), WS-N.2 (financial incidents), WS-I.3 (pay-to-rank leakage) |
| WS-P.2.1a (Moderation action aggregation) | WS-J (moderation action logs), WS-A (taxonomy) |
| WS-P.2.1b (Integrity incident aggregation) | WS-H.3 (MFCI), WS-H.7 (tropical cascade), WS-M.4 (capture signals), WS-J (integrity cases) |
| WS-P.2.1c (Invariant health summary) | WS-P.1.1b (invariant health metrics), WS-H.1 (versions/fallback), WS-A (transparency dictionary) |
| WS-P.2.1d (Report generation) | WS-P.2.1a, WS-P.2.1b, WS-P.2.1c, WS-P.1.2d, WS-P.1.3b, WS-P.1.4a |
| WS-P.2.1e (Report review workflow) | WS-P.2.1d (report generation), WS-D (reviewer roles/audit) |
| WS-P.2.1f (Transparency publication and cadence) | WS-P.2.1e (approval), WS-P.2.1d (immutable reports), WS-P.2.2a (i18n), WS-P.2.2b (RTL), WS-N.1 (jurisdiction publication rules) |
| WS-P.2.2a (i18n pipeline setup) | WS-C (PWA client), WS-B (design system components), WS-0.4 (CI) |
| WS-P.2.2b (RTL layout support) | WS-P.2.2a, WS-B (design system -- CSS logical properties + lint rule), WS-G (UGC direction detection) |
| WS-P.2.2c (Translation disclosure) | WS-P.2.2a, WS-G (contributions), WS-K (AI summaries), WS-J.1 (report flow), WS-B (disclosure component) |
| WS-P.2.2d (Region-sensitive policy) | WS-P.2.2a, WS-N.1 (jurisdiction engine), WS-D.1/WS-D.2 (region config/consent) |
| WS-P.3.1a (Phase success-metric gates) | WS-P.1.1a-d, WS-P.1.1b, WS-P.1.3, WS-P.2.1f, WS-P.3.2a, WS-I.3, WS-O, WS-B |
| WS-P.3.2a (Explanation-quality metric) | WS-I.2.6 (explanations), WS-I.2.5 (decision logs), WS-K (AI phrasing) |
| WS-P.3.3a (Launch go/no-go review board) | WS-P.3.1a, WS-P.1.2c, WS-P.1.1b, WS-P.1.1c/WS-J, WS-O, WS-P.1.4a, WS-P.1.3, WS-D |

**Extension note:** WS-R (`docs/planning/19-offline-content-availability.md`) and WS-S (`docs/planning/20-private-p2p-rooms.md`) are downstream, non-blocking consumers of the WS-P.2.2a i18n framework (their mandatory locale-ready disclosure/label copy) and are structurally excluded from WS-P metrics/experiments/transparency-content scope; they are not WS-P dependencies.

---

## Workstream definition of done

All of the following must be satisfied before WS-P is considered complete:

1. **Product-health metrics operational.** All four metric categories (participation, invariant health, safety, performance) are collected, aggregated with auditable numerators/denominators, and displayed on the metrics dashboard with historical trends. Each metric definition matches the §28.1 computation and applies small-cell suppression to human-identifying breakdowns.
2. **Anti-metrics enforced.** All social and crypto anti-metrics (including treasury size per §28.3) are defined with an immutable do-not-optimize flag, monitored continuously, and enforce experiment-blocking guardrails. Anti-metrics appear in transparency reports and never in growth dashboards (CI-enforced exclusion).
3. **Knomosis metrics transparency-only.** All eight §28.3 governance/payment metrics are computed in a separated store, surfaced only in transparency and finance reporting, and are structurally barred from product dashboards and experiment success criteria. Governance diversity is wealth-independent; the treasury-reconciliation gap is reported zero-or-explained as a pre-expansion blocker.
4. **Experimentation framework complete.** Experiments can be created, assigned (with a long-term holdout), monitored, guardrail-checked, and rolled back (automatically and manually). Prohibited experiment types (likes, upvotes, reactions, leaderboards, engagement-only criteria) are rejected at creation and start time, and attention-affecting experiments are forced to wire wellbeing/fairness guardrails. Every experiment logs its invariant versions for reproducibility.
5. **Transparency reports generated from live data on cadence.** Reports combine moderation, integrity, invariant health, anti-metric, Knomosis, and experiment-enforcement data without manual reconstruction, pass human review before publication, and are published on a committed DSA-style cadence into an immutable, amendment-tracked archive.
6. **i18n infrastructure ready.** All UI strings are extractable and translatable (CI-checked). RTL layout renders correctly via logical properties with a lint guard. Translation disclosure provides one-tap access to original text with source attribution. Region-sensitive policies are enforced server-side and cannot be bypassed client-side.
7. **Core Web Vitals targets met.** LCP ≤ 2.5s, INP ≤ 200ms, CLS ≤ 0.1 at p75, verified from real user monitoring data with per-route/per-device regression alerting.
8. **Phase gates and go/no-go operational.** §28.4 Alpha/Beta/GA success criteria are encoded as machine-checkable gates (including an explanation-quality metric for "users understand why content is shown"), and the weekly go/no-go review board renders auditable decisions that cannot return "go" while a hard blocker (reconciliation gap, high-severity security issue, anti-metric breach) is red or on engagement grounds alone.
9. **No prohibited signals.** No experiment, metric, dashboard, or report introduces likes, upvotes, public reactions, follower leaderboards, or engagement-only success criteria. The prohibited-signal denylist is shared with WS-A/WS-B/WS-I so the ban cannot drift between subsystems.
10. **Extension-aware scope (server-hosted; private unmeasurable).** All metrics, experiments, and transparency content-aggregations cover server-hosted content only; `private_p2p` content (WS-S) is structurally unmeasurable and excluded by design, and transparency reports + legal-request stats state that the platform cannot read or produce private content. The i18n pipeline accommodates and prohibited-language-scans the WS-S disclosure copy (room-class names, creation/removal acknowledgments, privacy matrix, Tier-1 limitation) and WS-R trust/liveness labels. WS-R and WS-S are post-M3 P3 extension rollouts with their own launch gates (OFFLINE_SPEC §36; PRIVATE_SPEC §29) and fail-closed kill switches, not launch-blocking for the core social product.

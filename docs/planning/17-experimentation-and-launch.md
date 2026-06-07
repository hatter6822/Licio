# WS-P: Experimentation, Metrics, and Launch Operations

**Milestone:** M3-M6
**Priority:** P3
**Dependencies:** WS-I (ranking and distribution), WS-H (invariant services), WS-J (trust and safety)
**Wave:** 6
**Estimated duration:** 3-4 weeks

---

## Overview

Product-health metrics measure what matters: constructive participation, invariant stability, safety responsiveness, and performance. Anti-metrics -- signals that must NEVER be optimized -- are monitored and enforced as experiment-blocking guardrails. Every experiment carries harm, fairness, and wellbeing guardrails alongside its success criteria. Transparency reports are generated from live data without manual reconstruction. No likes, upvotes, public reactions, or follower leaderboards are permitted -- even experimentally. Experiment success is never measured by engagement alone.

---

## WS-P.1 Metrics infrastructure

### WS-P.1.1a Participation metrics
**ID:** WS-P.1.1a
**Ref:** Section 28.1

**Description:**
Implement collection and aggregation for the four core participation metrics: constructive-participation rate (ratio of contributions that add evidence, context, or structured disagreement vs. low-information replies), source-open rate (proportion of users who open the original source before or after contributing), evidence-addition rate (contributions that include citations or linked evidence), and question-resolution rate (threads where open questions receive substantive answers). Each metric is computed per story, per room, and globally over configurable time windows. Aggregation uses privacy-preserving counts -- no individual user behavior is exposed in dashboards. Metrics are stored in a time-series format suitable for historical trending and export to the transparency pipeline (WS-P.2).

**Acceptance criteria:**
- All four participation metrics are computed and stored: constructive-participation rate, source-open rate, evidence-addition rate, question-resolution rate.
- Metrics are aggregated per story, per room, and globally.
- Time windows are configurable (hourly, daily, weekly).
- No individual user behavior is identifiable in aggregated output.
- Metrics are queryable by the dashboard (WS-P.1.1e) and transparency pipeline (WS-P.2).

**Testing:**
- Unit: Verify each metric computation against known input datasets. Verify aggregation at each scope level.
- Integration: Ingest a sequence of contributions and source-open events. Query metrics. Verify values match expected computations.

---

### WS-P.1.1b Invariant health metrics
**ID:** WS-P.1.1b
**Ref:** Section 28.1

**Description:**
Implement collection and aggregation for invariant health metrics: MERI distribution (histogram of redundancy scores across active stories showing whether deduplication is effective), SCOI reduction after bridge/synthesis (change in obstruction energy after context-repair contributions are added), MFCI incidents by severity (count of coordination incidents grouped by severity level and outcome), GWEI cohort disparity (structural experience gap across demographic/interest cohorts, reported as the normalized transport distance), and PHI steering-risk distribution (histogram of path-holonomy risk scores showing how many users are in high-risk attention loops). Each metric includes confidence intervals and coverage percentages. Metrics are computed on a scheduled basis (at least daily) and on-demand after significant events (e.g., after a major coordination incident resolves).

**Acceptance criteria:**
- All five invariant health metrics are computed: MERI distribution, SCOI reduction, MFCI incidents by severity, GWEI cohort disparity, PHI steering-risk distribution.
- Each metric includes confidence intervals and coverage percentages.
- Scheduled computation runs at least daily.
- On-demand recomputation is triggered after significant invariant events.
- Metrics are available to the dashboard (WS-P.1.1e) and transparency pipeline (WS-P.2).

**Testing:**
- Unit: Verify each invariant health metric computation with synthetic data. Verify confidence interval calculations.
- Integration: Run invariant services on test data. Trigger metric computation. Verify values and confidence intervals are within expected ranges.

---

### WS-P.1.1c Safety metrics
**ID:** WS-P.1.1c
**Ref:** Section 28.1

**Description:**
Implement collection and aggregation for safety metrics: harassment-protection latency (time from a harassment report being filed to the first moderation action taken, measured at p50, p90, and p99), appeal-overturn rate (proportion of moderation actions overturned on appeal, broken down by action type and severity), and accessibility-defect rate (count of accessibility defects found per release, categorized by WCAG criterion and severity). Harassment-protection latency is measured from the timestamp of report submission to the timestamp of the first moderation action (review, restriction, or escalation). Appeal-overturn rate is computed monthly with a 30-day lookback. Accessibility-defect rate is computed per release using automated (axe-core) and manual audit findings.

**Acceptance criteria:**
- Harassment-protection latency is measured at p50, p90, and p99.
- Appeal-overturn rate is computed monthly, broken down by action type and severity.
- Accessibility-defect rate is computed per release with WCAG criterion categorization.
- All safety metrics are available to the dashboard and transparency pipeline.
- Latency measurement starts at report submission, not report assignment.

**Testing:**
- Unit: Verify latency computation with known report-to-action timestamps. Verify overturn rate computation with known appeal outcomes.
- Integration: Create reports, apply moderation actions at known times. Query harassment-protection latency. Verify correctness.

---

### WS-P.1.1d Performance metrics
**ID:** WS-P.1.1d
**Ref:** Sections 28.1, 32.3

**Description:**
Implement collection and monitoring of Core Web Vitals at the 75th percentile: Largest Contentful Paint (LCP) target of 2.5 seconds or less, Interaction to Next Paint (INP) target of 200 milliseconds or less, and Cumulative Layout Shift (CLS) target of 0.1 or less. Metrics are collected from real user monitoring (RUM) in the PWA client using the `web-vitals` library. Data is aggregated by device class (low-end, mid-range, high-end), connection type (3G, 4G, WiFi), and route/page. Historical trends are stored for regression detection. Alerts fire when any metric regresses beyond the target at p75 over a rolling 24-hour window.

**Acceptance criteria:**
- LCP, INP, and CLS are collected from real users via the `web-vitals` library.
- Metrics are aggregated at p75 by device class, connection type, and route.
- Historical trends are stored with at least 90 days of retention.
- Alerts fire when any metric exceeds the target at p75 over a rolling 24-hour window.
- Targets: LCP ≤ 2.5s, INP ≤ 200ms, CLS ≤ 0.1.

**Testing:**
- Unit: Verify aggregation logic computes p75 correctly from sample distributions.
- Integration: Emit synthetic Web Vitals events. Verify aggregation, storage, and alert triggering when thresholds are exceeded.

---

### WS-P.1.1e Metrics dashboard
**ID:** WS-P.1.1e
**Ref:** Section 28.1

**Description:**
Build a real-time metrics dashboard that displays all product-health metrics (WS-P.1.1a through WS-P.1.1d) with historical trends. The dashboard includes: participation metrics panel (four charts with per-room and global views), invariant health panel (five charts with confidence bands), safety metrics panel (latency distributions, overturn rates, defect counts), and performance panel (Core Web Vitals with device/connection breakdowns). Each panel supports configurable time ranges (last 24h, 7d, 30d, 90d). The dashboard auto-refreshes at a configurable interval (default: 5 minutes). Historical trend lines show rolling averages with anomaly highlighting. The dashboard is accessible only to authorized staff roles and logged via the staff audit trail (WS-D).

**Acceptance criteria:**
- Dashboard displays all metrics from WS-P.1.1a through WS-P.1.1d.
- Historical trends are visible with configurable time ranges.
- Auto-refresh at a configurable interval (default 5 minutes).
- Anomaly highlighting on trend lines.
- Access restricted to authorized staff roles with audit logging.
- Dashboard loads within 3 seconds on a standard connection.

**Testing:**
- Unit: Verify chart data transformations produce correct series from stored metrics.
- E2E: Load the dashboard with test data. Verify all panels render. Change time range. Verify data updates. Verify access is denied for unauthorized users.

---

### WS-P.1.2a Anti-metric definitions
**ID:** WS-P.1.2a
**Ref:** Section 28.2

**Description:**
Define and implement the anti-metric schema -- signals that must never be optimized and must never appear as success criteria for experiments or launches. Social anti-metrics: total dwell time (aggregate time spent in app, which incentivizes addictive loops), outrage engagement (interactions driven by anger/fear/moral outrage rather than understanding), compulsive session length (sessions exceeding healthy engagement thresholds without breaks), speculation activity (posts, threads, or contributions centered on rumor/unverified claims without evidence), and vanity status (follower growth rate, karma accumulation, badge collection, leaderboard position). Each anti-metric has a formal definition, a measurement method, a baseline, and a deterioration threshold. The anti-metric schema is versioned and stored alongside the product-health metric definitions.

**Acceptance criteria:**
- All five social anti-metrics are formally defined: total dwell time, outrage engagement, compulsive session length, speculation activity, vanity status.
- Each definition includes measurement method, baseline computation, and deterioration threshold.
- Anti-metric schema is versioned.
- Anti-metrics are clearly separated from product-health metrics in the data model.
- No anti-metric can be added to a growth dashboard or used as an experiment success criterion (enforced by schema constraints in WS-P.1.2d and WS-P.1.3d).

**Testing:**
- Unit: Verify each anti-metric computation produces expected values from known inputs.
- Review: Anti-metric definitions are reviewed for completeness and alignment with Sections 28.1 and 28.2.

---

### WS-P.1.2b Crypto anti-metrics
**ID:** WS-P.1.2b
**Ref:** Sections 28.2, 28.3

**Description:**
Define and implement crypto-specific anti-metrics that must never be optimized: total value locked (TVL -- aggregate funds held in room treasuries, which incentivizes speculation and lock-in), token trading volume (volume of token trades if any token exists, which incentivizes speculation), wallet-connect growth rate (rate of new wallet connections, which incentivizes crypto-first rather than civic-first engagement), and speculative price (price of any token or asset associated with the platform). Each crypto anti-metric has a formal definition, a measurement method where applicable (TVL and wallet-connect growth are measurable; token volume and speculative price may be externally observed), and a deterioration threshold. These anti-metrics are monitored alongside social anti-metrics and share the same enforcement infrastructure.

**Acceptance criteria:**
- All four crypto anti-metrics are formally defined: TVL, token volume, wallet-connect growth, speculative price.
- Each definition includes measurement method (or external observation method) and deterioration threshold.
- Crypto anti-metrics share the same schema and enforcement infrastructure as social anti-metrics.
- TVL and wallet-connect growth are measured from internal data; token volume and speculative price use external observation where applicable.
- No crypto anti-metric appears in growth dashboards or experiment success criteria.

**Testing:**
- Unit: Verify TVL and wallet-connect growth rate computations from synthetic treasury and wallet-link data.
- Review: Crypto anti-metric definitions reviewed for alignment with Section 28.3.

---

### WS-P.1.2c Anti-metric monitoring
**ID:** WS-P.1.2c
**Ref:** Section 28.2

**Description:**
Implement monitoring and alerting for all anti-metrics (social and crypto). The monitoring system continuously computes anti-metric values and compares them against baselines and deterioration thresholds. When any anti-metric increases beyond its deterioration threshold, an alert is raised to the metrics dashboard and the experiment registry. Active experiments are automatically flagged for review if any anti-metric deteriorates during the experiment period. The monitoring system also provides an API that the experiment framework (WS-P.1.3) queries before approving experiment launches and during experiment evaluation. Anti-metric trends are computed over rolling 7-day and 30-day windows.

**Acceptance criteria:**
- All anti-metrics (social and crypto) are monitored continuously.
- Alerts fire when any anti-metric exceeds its deterioration threshold.
- Active experiments are flagged when anti-metrics deteriorate during the experiment period.
- The monitoring system exposes an API for the experiment framework to query anti-metric status.
- Trends are computed over rolling 7-day and 30-day windows.
- Alert history is retained for audit and transparency reporting.

**Testing:**
- Unit: Verify threshold comparison logic. Verify alert generation when thresholds are exceeded.
- Integration: Run an experiment simulation. Inject anti-metric deterioration. Verify the experiment is flagged. Verify alerts appear on the dashboard.

---

### WS-P.1.2d Anti-metric reporting
**ID:** WS-P.1.2d
**Ref:** Section 28.2

**Description:**
Ensure anti-metrics appear in transparency reports (WS-P.2) and never in growth dashboards. The reporting pipeline includes anti-metric trends, deterioration events, and experiment blocking events in every transparency report. The growth/product dashboard explicitly excludes anti-metrics from any optimization or goal-setting view. A schema-level constraint prevents anti-metrics from being added to growth dashboard queries. Anti-metric reporting in transparency reports uses the same privacy-preserving aggregation as other metrics (small-cell suppression, no individual user attribution).

**Acceptance criteria:**
- Anti-metrics are included in every transparency report generated by WS-P.2.
- Anti-metrics are excluded from growth dashboards at the schema/query level.
- Deterioration events and experiment blocking events are documented in transparency reports.
- Privacy-preserving aggregation (small-cell suppression) applies to anti-metric reporting.
- Attempting to add an anti-metric to a growth dashboard query fails with an explicit error.

**Testing:**
- Unit: Verify schema constraint rejects anti-metrics in growth dashboard queries.
- Integration: Generate a transparency report. Verify anti-metrics are present with trends and deterioration events. Attempt to add an anti-metric to a growth dashboard query. Verify rejection.

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

**Testing:**
- Unit: Verify uniform distribution across 10,000 synthetic user IDs. Verify determinism (same input produces same output). Verify holdout exclusion.
- Integration: Create an experiment with two variants. Assign 1,000 test users. Verify distribution is within expected bounds. Verify assignment stability across repeated queries.

---

### WS-P.1.3b Experiment registry
**ID:** WS-P.1.3b
**Ref:** Section 28.2

**Description:**
Implement the experiment registry -- a structured database of all experiments with mandatory fields: name (unique identifier), hypothesis (what the experiment is expected to show), primary metrics (the product-health metrics used to evaluate success), secondary metrics (additional metrics monitored but not used for launch decisions), guardrails (safety, anti-metric, and invariant health thresholds that trigger auto-rollback), owner (the person responsible for the experiment), start/end dates, variant descriptions, assignment method, target population, and invariant versions active during the experiment. The registry enforces that every experiment has at least one product-health metric (not just engagement), at least one guardrail, and an owner. Experiments cannot be started without passing the prohibited-type check (WS-P.1.3d). The registry provides a read-only view for transparency reporting.

**Acceptance criteria:**
- All mandatory fields are enforced: name, hypothesis, primary metrics, guardrails, owner, dates, variants, assignment method.
- Every experiment has at least one product-health metric as a primary metric.
- Every experiment has at least one guardrail.
- Experiments cannot start without passing the prohibited-type check (WS-P.1.3d).
- Invariant versions are recorded at experiment start.
- A read-only view is available for transparency reporting.

**Testing:**
- Unit: Attempt to create an experiment missing each mandatory field. Verify rejection for each.
- Integration: Create a complete experiment. Start it. Verify it appears in the registry with all fields. Verify the read-only view returns correct data. Attempt to start a prohibited experiment type. Verify rejection.

---

### WS-P.1.3c Experiment guardrails
**ID:** WS-P.1.3c
**Ref:** Section 28.2

**Description:**
Implement automatic guardrail enforcement for running experiments. Guardrails are evaluated continuously during an experiment and trigger auto-rollback when thresholds are breached. Three guardrail categories: safety degradation (harassment-protection latency increases beyond the threshold, appeal-overturn rate spikes, moderation SLA is missed), anti-metric worsening (any anti-metric from WS-P.1.2a or WS-P.1.2b deteriorates beyond its threshold during the experiment period relative to the control group or pre-experiment baseline), and invariant health drop (MERI, MFCI, SCOI, GWEI, or PHI confidence or coverage drops below the configured threshold for the experiment population). When a guardrail trips, the experiment is automatically rolled back to the control variant for all affected users. The rollback is logged with the guardrail that triggered it, the metric value that breached the threshold, and the timestamp. The experiment owner is notified.

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

---

### WS-P.1.3d Prohibited experiment types
**ID:** WS-P.1.3d
**Ref:** Section 28.2

**Description:**
Implement a hard block on prohibited experiment types. The experiment registry (WS-P.1.3b) rejects any experiment that matches a prohibited pattern. Prohibited patterns: (1) experiments that introduce likes, upvotes, thumbs-up, hearts, or any public approval signal; (2) experiments that introduce public reaction counts or emoji reactions on content; (3) experiments that introduce follower leaderboards, karma scores, or public reputation rankings; (4) experiments that use engagement-only success criteria (no experiment may define success solely in terms of time spent, sessions, or clicks without a product-health or safety metric). The prohibited-type check uses keyword matching on the experiment description and variant descriptions, plus a mandatory human attestation field where the owner confirms the experiment does not introduce prohibited patterns. The check runs at experiment creation and at experiment start.

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

---

### WS-P.2.1d Report generation
**ID:** WS-P.2.1d
**Ref:** Section 29

**Description:**
Implement the transparency report generator that combines moderation action aggregation (WS-P.2.1a), integrity incident aggregation (WS-P.2.1b), invariant health summaries (WS-P.2.1c), anti-metric trends (WS-P.1.2d), and experiment summaries (from WS-P.1.3b) into a publishable report. The report is generated in a structured format (JSON for programmatic access, HTML for human reading) that can be published without manual reconstruction. The generator runs on a configurable schedule (default: monthly) and can be triggered on demand. Each report includes a generation timestamp, the reporting period, a data completeness indicator (percentage of expected data sources that contributed), and a version identifier. Reports are immutable once generated -- corrections are published as amendments referencing the original.

**Acceptance criteria:**
- Reports combine data from WS-P.2.1a, WS-P.2.1b, WS-P.2.1c, WS-P.1.2d, and WS-P.1.3b.
- Reports are generated in JSON and HTML formats.
- No manual data entry or reconstruction is required.
- Generation runs on a configurable schedule (default: monthly) and on demand.
- Each report includes timestamp, period, data completeness indicator, and version.
- Reports are immutable; corrections are published as amendments.

**Testing:**
- Unit: Verify report assembly logic combines all data sources correctly. Verify JSON and HTML output formats are valid.
- Integration: Populate all data sources with test data. Trigger report generation. Verify the report includes all sections. Verify the HTML renders correctly. Verify immutability -- attempt to modify a generated report and verify rejection.

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

---

### WS-P.2.2a i18n pipeline setup
**ID:** WS-P.2.2a
**Ref:** Section 26.4

**Description:**
Set up the internationalization pipeline for UI strings. Integrate a localization library (e.g., `react-intl` or `i18next`) into the React application. Implement string extraction tooling that scans all component files and extracts translatable strings into a structured translation file format (JSON or ICU MessageFormat). The pipeline supports: pluralization rules per locale, date/time/number formatting per locale, and interpolation of dynamic values. A default locale (English) is the source of truth. Translation files for additional locales are structured as key-value pairs matching the default locale keys. Missing translations fall back to the default locale with a console warning in development. The extraction tool runs as a CI check to detect untranslated strings.

**Acceptance criteria:**
- A localization library is integrated into the React application.
- All UI strings in existing components are extracted to translation files.
- Pluralization, date/time/number formatting, and interpolation are supported per locale.
- Missing translations fall back to the default locale.
- A CI check detects new untranslated strings.
- Translation file format is documented for translators.

**Testing:**
- Unit: Verify string rendering with the default locale. Switch locale to a test locale. Verify strings render from the test translation file. Verify missing keys fall back to default.
- CI: Run the extraction tool. Verify all strings in components have corresponding keys in the default translation file.

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

---

## Dependency Summary

| Task | Depends on |
|---|---|
| WS-P.1.1a (Participation metrics) | WS-G (forum contributions), WS-F (source model), WS-E (event pipeline) |
| WS-P.1.1b (Invariant health metrics) | WS-H (all invariant services) |
| WS-P.1.1c (Safety metrics) | WS-J (trust and safety -- moderation actions, appeals) |
| WS-P.1.1d (Performance metrics) | WS-C (PWA client -- web-vitals integration) |
| WS-P.1.1e (Metrics dashboard) | WS-P.1.1a through WS-P.1.1d |
| WS-P.1.2a (Anti-metric definitions) | WS-P.1.1a (participation metrics for baseline comparison) |
| WS-P.1.2b (Crypto anti-metrics) | WS-L (Knomosis -- wallet data), WS-M (treasury data) |
| WS-P.1.2c (Anti-metric monitoring) | WS-P.1.2a, WS-P.1.2b |
| WS-P.1.2d (Anti-metric reporting) | WS-P.1.2c, WS-P.2.1d (report generator) |
| WS-P.1.3a (Experiment assignment) | WS-C.1.3 (feature flags) |
| WS-P.1.3b (Experiment registry) | WS-P.1.3a, WS-P.1.3d (prohibited types) |
| WS-P.1.3c (Experiment guardrails) | WS-P.1.3b, WS-P.1.2c (anti-metric monitoring), WS-P.1.1b (invariant health), WS-P.1.1c (safety metrics) |
| WS-P.1.3d (Prohibited experiment types) | None (schema-level constraint, implemented first) |
| WS-P.1.3e (Experiment rollback switches) | WS-P.1.3a (experiment assignment) |
| WS-P.2.1a (Moderation action aggregation) | WS-J (moderation action logs) |
| WS-P.2.1b (Integrity incident aggregation) | WS-H.3 (MFCI), WS-J (integrity cases) |
| WS-P.2.1c (Invariant health summary) | WS-P.1.1b (invariant health metrics) |
| WS-P.2.1d (Report generation) | WS-P.2.1a, WS-P.2.1b, WS-P.2.1c, WS-P.1.2d, WS-P.1.3b |
| WS-P.2.1e (Report review workflow) | WS-P.2.1d (report generation) |
| WS-P.2.2a (i18n pipeline setup) | WS-C (PWA client), WS-B (design system components) |
| WS-P.2.2b (RTL layout support) | WS-P.2.2a, WS-B (design system -- CSS logical properties) |
| WS-P.2.2c (Translation disclosure) | WS-P.2.2a, WS-G (contributions), WS-K (AI summaries) |
| WS-P.2.2d (Region-sensitive policy) | WS-P.2.2a, WS-N.1 (jurisdiction engine) |

---

## Workstream Definition of Done

All of the following must be satisfied before WS-P is considered complete:

1. **Product-health metrics operational.** All four metric categories (participation, invariant health, safety, performance) are collected, aggregated, and displayed on the metrics dashboard with historical trends.
2. **Anti-metrics enforced.** All social and crypto anti-metrics are defined, monitored, and enforce experiment-blocking guardrails. Anti-metrics appear in transparency reports and never in growth dashboards.
3. **Experimentation framework complete.** Experiments can be created, assigned, monitored, guardrail-checked, and rolled back (automatically and manually). Prohibited experiment types (likes, upvotes, reactions, leaderboards, engagement-only criteria) are rejected at creation and start time.
4. **Transparency reports generated from live data.** Reports combine moderation, integrity, invariant health, anti-metric, and experiment data without manual reconstruction. Reports pass human review before publication.
5. **i18n infrastructure ready.** All UI strings are extractable and translatable. RTL layout renders correctly. Translation disclosure provides access to original text. Region-sensitive policies are enforced server-side.
6. **Core Web Vitals targets met.** LCP ≤ 2.5s, INP ≤ 200ms, CLS ≤ 0.1 at p75, verified from real user monitoring data.
7. **No prohibited signals.** No experiment, metric, dashboard, or report introduces likes, upvotes, public reactions, follower leaderboards, or engagement-only success criteria.

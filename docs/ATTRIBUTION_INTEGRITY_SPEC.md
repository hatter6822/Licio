# Licio Attribution Integrity Specification

**Feature name:** Attribution Integrity  
**Short name:** AI-LAI (Licio Attribution Integrity)  
**Target repository:** `hatter6822/Licio`  
**Proposed location:** `docs/attribution-integrity/SPEC.md`  
**Status:** Draft v0.1  
**Date:** 2026-06-20  
**Primary goal:** Add a privacy-preserving, mathematically calibrated, long-horizon attribution system that estimates whether an account behaves like a genuine human participant, a human using substantial AI assistance, an automation pipeline, or a coordinated synthetic actor.

---

## 1. Executive Summary

Licio should add **Attribution Integrity**, a private audit-service layer that becomes more informative as a user contributes more content and interaction history. The system does **not** try to prove that a user is human. It estimates, with calibrated uncertainty, whether an account's observed behavior is more consistent with human participation, mixed human-AI authorship, high-assistance authorship, automation, or coordinated synthetic operation.

This feature aligns with Licio's existing doctrine:

- No likes, votes, karma, or public reputation counters.
- No pay-to-rank or wallet-derived visibility advantage.
- Raw engagement traces stay client-side and are reduced to privacy-preserving aggregates.
- PWAtt and invariant outputs are audit services and safety constraints, not opaque automatic punishment.
- AI governance exists as a first-class platform concern.

Attribution Integrity should therefore be implemented as a **bounded, private, explainable, reviewable signal**. It may influence ranking confidence, moderation review priority, provenance prompts, and abuse investigation. It must never be a public shame label, a standalone ban trigger, or a generalized identity-verification mechanism.

The core mathematical claim is straightforward:

If human-operated accounts and AI-assisted or automated accounts generate observably different distributions over contribution sequences, then a properly calibrated likelihood-ratio process can accumulate evidence over time. As the effective number of nonredundant contributions grows, attribution confidence can improve. If the observable distributions converge, output-only attribution becomes impossible. The system must explicitly model both facts.

---

## 2. Product Objective

### 2.1 North-Star Statement

Attribution Integrity helps Licio protect meaningful human participation without creating a surveillance product, a public social-credit score, or an unreliable AI-detector badge.

### 2.2 User-Facing Principle

Users should experience the feature as:

> Licio may ask for more provenance, context, or review when an account's long-term behavior looks unusually automated or coordinated.

Users should **not** experience it as:

> Licio secretly labels people as AI and punishes them automatically.

### 2.3 Platform Goals

1. Increase confidence in genuine participation as users contribute over time.
2. Detect high-volume synthetic or automated accounts earlier than ordinary moderation alone.
3. Distinguish content quality from authorship attribution.
4. Preserve Licio's privacy doctrine by avoiding raw keystrokes, raw mouse traces, IP/location use, or invasive biometric inference.
5. Provide explainable evidence classes to stewards and users when the system affects product behavior.
6. Support shadow-mode evaluation before any ranking or moderation integration.

### 2.4 Non-Goals

Attribution Integrity is not:

- A perfect AI detector.
- A proof of personhood system.
- A biometric identity system.
- A public reputation score.
- A replacement for moderation, reports, appeals, or steward judgment.
- A tool for penalizing disclosed, allowed AI assistance.
- A reason to ban accounts without human review.

---

## 3. Compatibility With Licio Architecture

### 3.1 Existing Licio Constraints

The feature must preserve these repository-level design constraints:

- **Strict TypeScript:** `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, and zod-validated trust boundaries.
- **PWA-first architecture:** browser-side aggregation where privacy demands it.
- **Typed event pipeline:** all attribution events must use registered topics and versioned envelopes.
- **Private Signal Ledger:** user-readable and reviewer-readable explanations should be added to existing signal-ledger concepts.
- **PWAtt shadow discipline:** Attribution Integrity must launch in shadow mode.
- **No raw engagement egress:** raw cursor, scroll, keystroke, viewport, or edit traces must not leave the browser.
- **No IP/location:** the attribution model must not depend on client address, precise location, device fingerprinting, or third-party tracking identifiers.
- **No applause or pay-to-rank leakage:** attribution signals must not create public status, karma, badges, or purchasable visibility.

### 3.2 Proposed Workspace Placement

```text
packages/shared/src/attribution-integrity/
  schemas.ts              # zod wire schemas, enums, redaction-safe DTOs
  constants.ts            # thresholds, version IDs, policy IDs
  types.ts                # branded IDs and shared types

packages/invariants/src/attribution-integrity/
  math.ts                 # likelihood ratio, calibration, ESS, decay
  features.ts             # pure feature transforms
  calibration.ts          # reliability, Brier/ECE helpers
  decisions.ts            # bounded action mapping
  proofs.md               # informal math proof notes; future Lean candidate

apps/web/src/attribution-integrity/
  composer-probes.ts      # optional active micro-probes
  client-aggregates.ts    # privacy-preserving local aggregation
  consent-ui.tsx          # disclosure and settings surfaces

apps/api/src/attribution-integrity/
  service.ts              # ingestion + scorer orchestration
  stores.ts               # port interfaces
  in-memory-store.ts      # test/demo implementation
  postgres-store.ts       # durable implementation
  calibration-jobs.ts     # offline recalibration jobs
  routes.ts               # private user/reviewer explanation endpoints

docs/attribution-integrity/
  SPEC.md
  MODEL_CARD.md
  PRIVACY_REVIEW.md
  RED_TEAM_PLAN.md
  EVALUATION.md
```

### 3.3 Dependency Rule

`packages/invariants` may depend on `packages/shared`, but not on `apps/api`, `apps/web`, or `packages/db`. The attribution math must remain pure and testable.

---

## 4. Threat Model

### 4.1 Actor Classes

Attribution Integrity should reason over account behavior classes, not metaphysical identity.

```ts
type AttributionClass =
  | "human_operated"
  | "human_ai_assisted"
  | "high_ai_assistance"
  | "automation_pipeline"
  | "coordinated_synthetic";
```

These classes are probabilistic hypotheses, not ground-truth labels for enforcement.

### 4.2 Primary Abuse Cases

1. **Synthetic flood account:** posts high-volume plausible comments to shape conversation.
2. **AI-assisted astroturfing:** many accounts produce semantically varied but centrally generated content.
3. **Thread-saturation bot:** replies quickly and uniformly across many rooms.
4. **Source-laundering account:** cites sources without real source-opening behavior or contextual integration.
5. **Persona simulator:** attempts to imitate local human memory, uncertainty, and fatigue.
6. **Coordinated report/comment hybrid:** combines synthetic commenting with abuse of reporting flows.

### 4.3 Honest Use Cases To Protect

1. Users with disabilities relying on assistive writing tools.
2. Non-native speakers using translation or grammar assistance.
3. Neurodivergent users with unusual writing cadence.
4. Users who write professionally polished content.
5. Users in shared households or rotating devices.
6. Users using privacy tools, VPNs, Tor, or hardened browsers.
7. Rooms that explicitly allow AI-assisted participation.

### 4.4 Adversarial Boundary

The feature can detect distributional mismatch. It cannot detect essence.

If a synthetic actor samples from the same observable distribution as genuine users under the same privacy constraints, then no output-only or aggregate-only detector can reliably distinguish the two. The system must surface this impossibility in documentation, model cards, and reviewer UI.

---

## 5. Mathematical Foundation

### 5.1 Observations

Let an account generate a sequence of contribution events:

\[
x_{1:n} = (x_1, x_2, \dots, x_n)
\]

Each event includes content and allowed metadata:

\[
x_i = (c_i, a_i, t_i, r_i, q_i)
\]

where:

- \(c_i\): redacted content-derived features.
- \(a_i\): coarse action type, e.g. post, comment, edit, correction, evidence addition.
- \(t_i\): coarse timing/session bucket, never raw trace.
- \(r_i\): room/thread context.
- \(q_i\): quality and participation signals already permitted by Licio's doctrine.

Let \(h_i\) denote available history and context before event \(i\):

\[
h_i = (x_{1:i-1}, \text{room}, \text{thread}, \text{policy}, \text{feature flags})
\]

### 5.2 Hypotheses

The primary hypotheses are:

\[
H = \text{human-operated participation}
\]

\[
A = \text{AI-assisted, automated, or synthetic participation}
\]

For operational use, \(A\) should be decomposed into subclasses:

\[
A \in \{A_1, A_2, \dots, A_k\}
\]

where subclasses correspond to allowed AI assistance, high AI assistance, automation, and coordination.

### 5.3 Bayesian Log-Odds Update

Maintain a private account score in log-odds space:

\[
L_n = \log \frac{P(H \mid x_{1:n})}{P(A \mid x_{1:n})}
\]

The recursive update is:

\[
L_n = \lambda L_{n-1} + w_n \ell_n
\]

where:

\[
\ell_n = \log \frac{P(x_n \mid H, h_n)}{P(x_n \mid A, h_n)}
\]

- \(\lambda \in (0,1]\) is the time-decay parameter.
- \(w_n \in [0,1]\) is the effective-independence weight.
- \(\ell_n\) is the event log-likelihood ratio.

The posterior is:

\[
P(H \mid x_{1:n}) = \sigma(L_n) = \frac{1}{1 + e^{-L_n}}
\]

### 5.4 Multi-Class Mixture Model

Instead of one AI alternative, use a mixture:

\[
P_A(x_i \mid h_i) = \sum_{j=1}^{k} \pi_j P(A_j \mid h_i) P(x_i \mid A_j, h_i)
\]

Then:

\[
\ell_i = \log P(x_i \mid H,h_i) - \log P_A(x_i \mid h_i)
\]

This avoids overfitting to a single model or bot family.

### 5.5 Effective Sample Size

Raw post count must not equal evidential count. Define redundancy between events \(i\) and \(j\):

\[
\rho(i,j) \in [0,1]
\]

based on semantic similarity, same-session grouping, same-room duplication, same-template structure, and repeated source/context.

Define per-event independence weight:

\[
w_i = \max\left(w_{\min}, 1 - \max_{j<i} \rho(i,j)\right)
\]

or, for a smoother variant:

\[
w_i = \frac{1}{1 + \sum_{j<i} \rho(i,j)}
\]

The effective sample size is:

\[
n_{eff} = \sum_{i=1}^{n} w_i
\]

Product rule: no account should receive high-confidence attribution unless \(n_{eff}\) exceeds a minimum threshold for the relevant context.

### 5.6 Confidence Growth

If the true process is human and the model is well specified:

\[
\mathbb{E}_{x \sim P_H}\left[\log\frac{P_H(x)}{P_A(x)}\right] = D_{KL}(P_H \Vert P_A) > 0
\]

Thus expected evidence grows with \(n_{eff}\):

\[
\mathbb{E}[L_n] \approx L_0 + n_{eff}D_{KL}(P_H \Vert P_A)
\]

If \(P_H = P_A\) over permitted observations, then:

\[
D_{KL}(P_H \Vert P_A) = 0
\]

and output-only attribution cannot reliably improve beyond priors.

### 5.7 Calibration Requirement

Raw model probabilities are not trusted. All outputs must be calibrated using held-out validation data.

Required metrics:

- Brier score.
- Expected calibration error.
- Reliability diagrams.
- False-positive rate by cohort and room type.
- False-negative rate against known synthetic test accounts.
- Reviewer-overturn rate.
- Drift over time.

A score may not affect ranking or moderation until calibration is documented and approved.

---

## 6. Evidence Channels

Attribution Integrity should combine multiple weak signals. No single signal is decisive.

### 6.1 Content Distribution Features

Allowed features:

- Lexical entropy.
- Type-token ratio over windows.
- Function-word distribution.
- Punctuation and formatting stability.
- Sentence length distribution.
- Semantic specificity.
- Genericness score.
- Local context dependence.
- Claim density.
- Evidence integration quality.
- Correction and uncertainty language.
- Repeated phrasing across unrelated rooms.

Forbidden features:

- Sensitive trait inference.
- Protected-class inference.
- Political/religious identity inference.
- Health, sexuality, or precise-location inference.
- Cross-site tracking.

### 6.2 Sequence Features

Measure account behavior across time:

- Topic recurrence.
- Thread-return behavior.
- Correction after challenge.
- Stance refinement.
- Fatigue-like variance.
- Session burstiness using coarse buckets.
- Cross-room breadth relative to history.
- Abrupt style discontinuities.
- Near-duplicate participation patterns.

### 6.3 Participation Features

These should reuse Licio-compatible concepts:

- Source opening before claims.
- Evidence addition.
- Clarifying questions.
- Constructive replies.
- Useful summaries.
- Bridge-building across interpretations.
- Corrections after new information.
- Nonredundant contribution value.

These features must not create public karma or follower-like status.

### 6.4 Timing Features

Timing features must be coarse and privacy-preserving.

Allowed:

- Session bucket count.
- Coarse inter-event bucket, e.g. `<1m`, `1-5m`, `5-30m`, `30m-6h`, `>6h`.
- Burst windows.
- Account-local rhythm stability.

Forbidden:

- Raw keystroke timing.
- Raw mouse movement.
- Raw scroll traces.
- Precise geolocation or IP-derived timezone.
- Device fingerprinting.
- Behavioral biometrics.

### 6.5 Active Micro-Probes

Active probes are optional, sparse, and product-native. They should appear as composer affordances, not as CAPTCHA-like suspicion prompts.

Examples:

- "What are you adding to this thread?"  
  Options: evidence, correction, question, synthesis, experience, context, other.

- "How confident are you?"  
  Options: low, medium, high, source-backed.

- "What changed your mind?"  
  Free-text, only after correction/edit flows.

- "Which source supports the key claim?"  
  Only when the post contains factual claim density above threshold.

Active-probe responses are evidence only when voluntarily provided or required by neutral product policy, not because the account is secretly suspected.

---

## 7. Feature Extraction Pipeline

### 7.1 Event Flow

```text
User contribution or interaction
  ↓
Client-side minimization where applicable
  ↓
Typed event envelope
  ↓
API ingestion boundary: zod parse, auth, replay guard, privacy guard
  ↓
Attribution feature extraction
  ↓
Pure invariant scorer
  ↓
Private Attribution Ledger append
  ↓
Shadow decision output
  ↓
Optional bounded integration: PWAtt confidence, review queue, provenance prompt
```

### 7.2 Event Types

```ts
type AttributionEventKind =
  | "content_created"
  | "comment_created"
  | "content_edited"
  | "correction_added"
  | "evidence_added"
  | "source_opened_aggregate"
  | "thread_returned_aggregate"
  | "composer_probe_answered"
  | "moderation_reported"
  | "appeal_submitted";
```

### 7.3 Minimal Event Envelope

```ts
export const AttributionEventEnvelope = z.object({
  schemaVersion: z.literal("attribution.integrity.event.v1"),
  eventId: EventIdSchema,
  accountId: AccountIdSchema,
  roomId: RoomIdSchema.optional(),
  threadId: ThreadIdSchema.optional(),
  contentId: ContentIdSchema.optional(),
  kind: AttributionEventKindSchema,
  occurredAtBucket: TimeBucketSchema,
  features: AttributionFeatureVectorSchema,
  privacyTier: z.enum(["local_aggregate", "server_derived", "review_restricted"]),
  retentionTier: z.enum(["ephemeral", "rolling_30d", "rolling_180d", "audit_limited"]),
  policyVersion: z.string(),
});
```

### 7.4 Feature Vector Requirements

Feature vectors must be:

- Versioned.
- Sparse-friendly.
- Redaction-safe.
- Interpretable enough for reviewer explanation.
- Free of raw text unless explicitly needed for moderation review under existing content retention policy.
- Recomputable from retained content when legally and technically permitted.

### 7.5 Content Embeddings

If embeddings are used:

- Use local or governed providers under Licio AI governance.
- Store only task-specific projections or hashed cluster IDs unless full embeddings pass privacy review.
- Do not use embeddings to infer sensitive traits.
- Version the embedding model.
- Recompute or invalidate scores on model upgrades.

---

## 8. Scoring Model

### 8.1 Score Outputs

```ts
type AttributionOutput = {
  accountId: AccountId;
  window: AttributionWindow;
  posterior: {
    humanOperated: number;
    humanAiAssisted: number;
    highAiAssistance: number;
    automationPipeline: number;
    coordinatedSynthetic: number;
  };
  confidence: "insufficient_evidence" | "low" | "moderate" | "high";
  effectiveSampleSize: number;
  calibrationVersion: string;
  topEvidenceClasses: AttributionEvidenceClass[];
  allowedActions: AttributionBoundedAction[];
};
```

### 8.2 Evidence Classes

Reviewer/user explanations should use coarse classes, not raw model internals:

```ts
type AttributionEvidenceClass =
  | "high_redundancy"
  | "unusual_cross_room_uniformity"
  | "low_context_dependence"
  | "source_behavior_mismatch"
  | "automation_like_timing"
  | "coordinated_similarity"
  | "human_like_correction_pattern"
  | "human_like_thread_return_pattern"
  | "insufficient_independent_history";
```

### 8.3 Bounded Action Classes

```ts
type AttributionBoundedAction =
  | "no_action"
  | "shadow_log_only"
  | "reduce_pwatt_confidence_only"
  | "request_optional_provenance"
  | "require_source_basis_for_high_reach_claim"
  | "queue_for_steward_review"
  | "rate_limit_pending_review";
```

### 8.4 Decision Constraints

The system must satisfy:

1. `insufficient_evidence` implies `no_action` or `shadow_log_only`.
2. No action may be based on a single event unless the event independently violates existing safety policy.
3. No irreversible enforcement action may be taken without human review.
4. Ranking effects must be bounded and monotone non-amplifying: attribution uncertainty may reduce confidence but never boost reach.
5. Disclosed allowed AI assistance must not be punished by default.
6. Appeals and reviewer corrections must feed calibration analysis.

---

## 9. PWAtt Integration

### 9.1 Principle

Attribution Integrity should not become a ranking score. It should become a **confidence modifier** on participation-derived signals.

### 9.2 Formula

Let \(PWAtt_0\) be the existing participation-weighted score. Define attribution confidence dampener:

\[
d_A \in [d_{min}, 1]
\]

where \(d_A = 1\) means no dampening.

Then:

\[
PWAtt_{effective} = PWAtt_0 \cdot d_A
\]

Constraints:

- \(d_A\) cannot exceed 1.
- \(d_A\) cannot be affected by payment, wallet status, token balance, room treasury, or governance vote.
- \(d_A\) must be zero-ranking-power in shadow mode.
- \(d_A\) must be explainable in private signal ledgers.

### 9.3 Suggested Dampener Function

Let \(p_{auto}\) be calibrated probability of automation-like or coordinated-synthetic behavior:

\[
p_{auto} = P(automation\_pipeline) + P(coordinated\_synthetic)
\]

Let \(g(n_{eff})\) be an evidence sufficiency gate:

\[
g(n_{eff}) = \min\left(1, \frac{n_{eff}}{N_{min}}\right)
\]

Then:

\[
d_A = 1 - \beta \cdot g(n_{eff}) \cdot \max(0, p_{auto} - \tau)
\]

with:

- \(\beta\) bounded by policy.
- \(\tau\) calibrated per room/content class.
- \(d_A \ge d_{min}\).

Initial recommendation:

- Shadow mode: compute only, no effect.
- Limited beta after review: \(\beta \le 0.25\).
- Never dampen below \(d_{min}=0.5\) without steward review.

---

## 10. Moderation and Review Integration

### 10.1 Review Queue Triggering

Attribution Integrity may queue an account or event for review when:

- Confidence is at least moderate.
- Effective sample size is sufficient.
- Evidence is recent and not entirely redundant.
- At least two independent evidence channels agree.
- The account's behavior affects reach, reports, governance, or room safety.

### 10.2 Reviewer UI

The reviewer UI must show:

- Attribution class probabilities.
- Confidence level.
- Effective sample size.
- Evidence classes.
- Examples of representative public/user-retained content when policy permits.
- Calibration version.
- Known caveats.
- User disclosures of AI assistance.
- Prior appeals and reviewer outcomes.

It must not show:

- Sensitive inferred attributes.
- Raw client traces.
- IP or location.
- Device fingerprints.
- Hidden psychological labels.

### 10.3 User Explanation

If the system causes a user-visible effect, provide a plain explanation:

> Some recent activity from this account appears unusually automated or repetitive across independent posts. Licio is asking for source basis or steward review before increasing distribution. This is not a claim that you are a bot. You may appeal or clarify your use of assistive tools.

---

## 11. Privacy and Data Protection

### 11.1 Data Minimization

Only collect features necessary for attribution. Prefer:

- Local aggregation.
- Coarse buckets.
- Rolling windows.
- Feature vectors over raw traces.
- Short retention for low-risk events.

### 11.2 Prohibited Data

The feature must not collect or use:

- Raw keystroke dynamics.
- Raw cursor/mouse/touch traces.
- Raw viewport timelines.
- IP address.
- Precise location.
- Device fingerprint.
- Browser fingerprint.
- Third-party tracker IDs.
- Sensitive trait inference.

### 11.3 Retention

Recommended retention tiers:

| Data | Retention | Notes |
|---|---:|---|
| Shadow aggregate scores | 180 days | No enforcement effect. |
| Event feature vectors | 180 days | Redaction-safe only. |
| Reviewer decision records | Policy/audit retention | Subject to DSAR/deletion design. |
| Raw content | Existing content policy | Not extended solely for attribution. |
| Client raw traces | 0 days | Must not egress. |

### 11.4 DSAR and Deletion

DSAR export should include:

- Current attribution state.
- Evidence classes.
- Calibration version.
- User-visible effects caused by attribution.
- Review decisions and appeals.

Account deletion must purge attribution features unless retained for legally justified audit records already covered by Licio policy.

---

## 12. AI Assistance Policy

### 12.1 Disclosed Assistance

Licio should support voluntary disclosure:

```ts
type AiAssistanceDisclosure =
  | "none"
  | "grammar_or_translation"
  | "summarization_assist"
  | "drafting_assist"
  | "substantial_generation"
  | "automation_or_agent";
```

Disclosure should affect interpretation, not automatically suppress reach.

### 12.2 Allowed Assistance

Examples generally allowed unless room policy says otherwise:

- Grammar correction.
- Translation.
- Accessibility support.
- Summarizing a source for personal comprehension.
- Draft refinement where the user remains substantively responsible.

### 12.3 Higher-Risk Assistance

Examples requiring provenance or constraints:

- Fully generated comments at scale.
- Autonomous posting agents.
- AI-generated evidence cards without source inspection.
- Coordinated multi-account messaging.
- Room-governance manipulation.

---

## 13. Calibration and Evaluation

### 13.1 Dataset Design

Create evaluation sets:

1. Genuine human historical contributions, consented or internally generated.
2. Human writing with disclosed grammar/translation assistance.
3. Human writing with substantial drafting assistance.
4. Model-generated posts across multiple model families.
5. Agentic automation simulations.
6. Coordinated synthetic campaigns.
7. Accessibility-tool usage simulations.
8. Non-native speaker corpora.
9. Professional/polished human writers.
10. Low-volume accounts.

### 13.2 Validation Requirements

Before non-shadow deployment:

- False-positive rate below policy threshold for protected user scenarios.
- Calibration error below threshold.
- No single feature family dominates decisions.
- Reviewer explanations are comprehensible.
- Appeals process tested.
- Red-team synthetic campaigns evaluated.
- Privacy review complete.
- Security review complete.
- Rollback path tested.

### 13.3 Metrics

Required metrics:

| Metric | Purpose |
|---|---|
| AUROC | Global separability. |
| AUPRC | Detection under low base-rate abuse. |
| Brier score | Probability quality. |
| ECE | Calibration quality. |
| FPR@review-threshold | User harm control. |
| TPR@review-threshold | Abuse capture. |
| Reviewer overturn rate | Real-world reliability. |
| Appeal success rate | User harm signal. |
| Cohort parity checks | Fairness and accessibility. |
| Drift score | Model aging detection. |

### 13.4 Shadow-Mode Success Criteria

Attribution Integrity may leave pure shadow mode only if:

1. At least 30 days of shadow data have been collected.
2. Calibration is documented.
3. False-positive analysis is reviewed.
4. User-facing explanation copy is approved.
5. Reviewer workflow is live.
6. Rollback flag exists and is tested.
7. CI includes static gates for prohibited data.
8. Product owner explicitly changes code to enable bounded effects.

---

## 14. Security Requirements

### 14.1 Abuse of the Detector

Potential attacks:

- Adversarial human mimicry by bots.
- Poisoning calibration data.
- Generating content to manipulate PWAtt dampeners against opponents.
- Reporting accounts to trigger attribution scrutiny.
- Prompt-injection into source/evidence extraction.
- Room governance attempts to disable platform-level attribution safeguards.

Mitigations:

- Keep model thresholds server-side.
- Use multiple evidence channels.
- Ignore reports as direct attribution evidence; use them only as review context.
- Sign and version calibration artifacts.
- Maintain immutable audit records for model changes.
- Require platform-level legal/safety floor above room governance.
- Red-team before enabling effects.

### 14.2 CI Gates

Add static gates:

```text
check:no-attribution-raw-traces
check:no-attribution-ip-location
check:attribution-shadow-equivalence
check:attribution-thresholds-versioned
check:attribution-explanations-present
```

### 14.3 Runtime Guards

Runtime must reject attribution events containing prohibited fields:

- `ip`
- `clientAddress`
- `latitude`
- `longitude`
- `timezoneFromIp`
- `deviceFingerprint`
- `rawKeystrokes`
- `rawMousePath`
- `rawScrollTrace`

---

## 15. Database Model

Suggested tables:

```sql
CREATE TABLE attribution_events (
  id uuid PRIMARY KEY,
  account_id uuid NOT NULL,
  room_id uuid NULL,
  thread_id uuid NULL,
  content_id uuid NULL,
  kind text NOT NULL,
  occurred_at_bucket timestamptz NOT NULL,
  feature_version text NOT NULL,
  feature_vector jsonb NOT NULL,
  privacy_tier text NOT NULL,
  retention_tier text NOT NULL,
  policy_version text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE attribution_account_state (
  account_id uuid PRIMARY KEY,
  score_version text NOT NULL,
  calibration_version text NOT NULL,
  log_odds_human numeric NOT NULL,
  posterior jsonb NOT NULL,
  effective_sample_size numeric NOT NULL,
  confidence text NOT NULL,
  top_evidence_classes jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE attribution_decisions (
  id uuid PRIMARY KEY,
  account_id uuid NOT NULL,
  decision_kind text NOT NULL,
  action text NOT NULL,
  reason_classes jsonb NOT NULL,
  score_snapshot jsonb NOT NULL,
  reviewer_id uuid NULL,
  user_visible boolean NOT NULL DEFAULT false,
  appeal_status text NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE attribution_calibration_versions (
  id text PRIMARY KEY,
  model_version text NOT NULL,
  feature_version text NOT NULL,
  dataset_hash text NOT NULL,
  metrics jsonb NOT NULL,
  approved_by uuid NULL,
  approved_at timestamptz NULL,
  active boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
```

Indexes:

```sql
CREATE INDEX attribution_events_account_created_idx
  ON attribution_events (account_id, created_at DESC);

CREATE INDEX attribution_events_retention_idx
  ON attribution_events (retention_tier, created_at);

CREATE INDEX attribution_decisions_account_created_idx
  ON attribution_decisions (account_id, created_at DESC);
```

---

## 16. API Surface

### 16.1 Internal Ingestion

```http
POST /internal/attribution-integrity/events
```

Server-only route. Accepts typed event envelopes from trusted Licio services.

### 16.2 User Explanation

```http
GET /v1/me/attribution-integrity
```

Returns only user-safe explanation fields:

```ts
type UserAttributionView = {
  status: "no_effect" | "limited_distribution_confidence" | "provenance_requested" | "under_review";
  confidence: "insufficient_evidence" | "low" | "moderate" | "high";
  explanationClasses: AttributionEvidenceClass[];
  aiAssistanceDisclosure?: AiAssistanceDisclosure;
  appealAvailable: boolean;
};
```

### 16.3 Reviewer View

```http
GET /v1/steward/attribution-integrity/accounts/:accountId
```

Requires steward permissions and object-level authorization.

### 16.4 Disclosure Update

```http
PUT /v1/me/ai-assistance-disclosure
```

Allows user to disclose ordinary assistive AI usage.

---

## 17. User Interface Requirements

### 17.1 Settings

Add a settings section:

- "AI and writing assistance disclosure."
- "How Licio uses attribution integrity signals."
- "Download my attribution data."
- "Appeal an attribution-related restriction."

### 17.2 Composer

Add neutral optional context controls:

- Contribution type.
- Confidence level.
- Source basis.
- AI assistance disclosure when relevant.

Avoid accusatory copy.

### 17.3 Steward Console

Add a review panel:

- Account attribution timeline.
- Evidence classes.
- Representative examples.
- Prior moderation context.
- Appeal history.
- Decision buttons.
- Required rationale field.

---

## 18. Rollout Plan

### Stage 0: Spec and Privacy Review

Deliverables:

- This spec.
- Model card template.
- Privacy review.
- Red-team plan.
- Static gate design.

### Stage 1: Pure Math and Schemas

Deliverables:

- `@licio/shared` schemas.
- `@licio/invariants` likelihood, ESS, decay, calibration helpers.
- Unit tests for math properties.

### Stage 2: Shadow Event Pipeline

Deliverables:

- Event topics.
- In-memory and Postgres stores.
- No ranking effect.
- Shadow-equivalence tests.

### Stage 3: Evaluation Harness

Deliverables:

- Synthetic model-generated corpora.
- Human-assistance corpora.
- Calibration metrics.
- Red-team simulations.

### Stage 4: Reviewer UI

Deliverables:

- Steward console panel.
- User-safe explanation endpoint.
- Appeal path.

### Stage 5: Bounded Product Effects

Deliverables:

- Optional provenance request.
- Limited PWAtt confidence dampener.
- Manual review queue.
- Explicit code change to leave shadow mode.

### Stage 6: Ongoing Monitoring

Deliverables:

- Drift dashboard.
- Calibration refresh jobs.
- Transparency report aggregates.
- Quarterly fairness review.

---

## 19. Testing Plan

### 19.1 Unit Tests

- Log-odds update monotonicity.
- ESS bounds.
- Redundancy downweighting.
- Decay behavior.
- Posterior normalization.
- Multi-class mixture stability.
- Dampener never boosts reach.
- Insufficient evidence never triggers enforcement.

### 19.2 Property Tests

Properties:

1. \(n_{eff} \le n\).
2. \(0 \le w_i \le 1\).
3. \(0 \le P(C_k) \le 1\) and probabilities sum to 1.
4. \(d_A \in [d_{min},1]\).
5. Adding a fully redundant event changes score by at most configured epsilon.
6. Shadow mode produces identical ranking output to control ranking.

### 19.3 Integration Tests

- Event ingestion rejects prohibited fields.
- Missing calibration version fails closed.
- Reviewer route requires steward authorization.
- User endpoint redacts reviewer-only fields.
- DSAR export includes attribution records.
- Deletion purges eligible attribution data.

### 19.4 E2E Tests

- User posts normally; no attribution UI appears.
- User discloses grammar assistance; no penalty occurs.
- Synthetic burst account enters review queue in shadow mode.
- Steward reviews and records rationale.
- User appeals a provenance request.
- Feature flag rollback removes all product effects.

---

## 20. Formal Invariants

These invariants should be enforced by tests initially and later considered for Lean-style formalization if Licio's invariant package evolves in that direction.

### 20.1 No Boost Invariant

Attribution Integrity cannot increase distribution.

\[
PWAtt_{effective} \le PWAtt_0
\]

### 20.2 Shadow Equivalence Invariant

When shadow mode is enabled:

\[
Rank_{with\_AI\text{-}LAI}(F) = Rank_{without\_AI\text{-}LAI}(F)
\]

for every feed candidate set \(F\).

### 20.3 Evidence Sufficiency Invariant

If \(n_{eff} < N_{min}\), then:

\[
Action \in \{no\_action, shadow\_log\_only\}
\]

### 20.4 Human Review Invariant

For any irreversible or account-limiting action \(a\):

\[
a \Rightarrow reviewer\_decision \land appeal\_available
\]

### 20.5 Privacy Boundary Invariant

No attribution event may contain prohibited raw trace or location fields.

### 20.6 Payment Isolation Invariant

No attribution score may use wallet, treasury, payment, token, or DAO contribution data.

---

## 21. Risks and Mitigations

| Risk | Mitigation |
|---|---|
| False positives against polished writers | Calibration cohorts, review requirement, appeals. |
| Harm to assistive-tech users | Explicit assistance disclosure and protected evaluation sets. |
| Detector becomes social credit | Private-only score, no public labels, no positive ranking boost. |
| Adversarial adaptation | Multi-channel evidence, drift monitoring, red-team refresh. |
| Privacy creep | Static gates, runtime guards, privacy reviews, no raw traces. |
| Room governance abuse | Platform legal/safety floor cannot be overridden. |
| Model overconfidence | Calibration, confidence buckets, ESS gates. |
| Dataset bias | Cohort testing and reviewer-overturn monitoring. |
| Reviewer misuse | Access controls, audit logs, rationale requirements. |

---

## 22. Acceptance Criteria

The feature is implementation-ready when:

1. All schemas are versioned and zod-validated.
2. Pure math lives in `packages/invariants`.
3. Shadow mode has zero ranking effect proven by tests.
4. Prohibited data fields are blocked by static and runtime gates.
5. Calibration metrics are documented.
6. Reviewer UI explains evidence classes without exposing sensitive data.
7. User-facing explanations and appeals exist before any user-visible effect.
8. DSAR and deletion paths include attribution data.
9. Bounded dampening cannot increase ranking.
10. Human review is required for serious restrictions.
11. AI assistance disclosure is supported and not automatically punitive.
12. Rollback is one explicit feature flag or code gate.

---

## 23. Recommended Initial Configuration

```ts
export const AttributionIntegrityDefaults = {
  shadowMode: true,
  minEffectiveSamplesForReview: 25,
  minEffectiveSamplesForDampening: 50,
  decayLambda: 0.985,
  maxPwattDampeningBeta: 0.25,
  minPwattDampener: 0.5,
  automationReviewThreshold: 0.8,
  coordinatedSyntheticReviewThreshold: 0.7,
  userVisibleEffectRequiresReview: true,
  activeProbesEnabled: false,
  aiAssistanceDisclosureEnabled: true,
} as const;
```

Rationale:

- Start conservative.
- Learn in shadow mode.
- Separate review triggers from ranking effects.
- Avoid active probes until passive calibration is understood.

---

## 24. Final Design Doctrine

Attribution Integrity should make Licio more resistant to synthetic participation while preserving the dignity and privacy of real users.

The correct mental model is not:

> Detect AI and punish it.

The correct model is:

> Maintain calibrated confidence about whether an account behaves like a genuine participant in Licio's knowledge process, and use that confidence carefully, privately, reversibly, and explainably.

The system becomes more effective as a user posts more because independent evidence accumulates. It remains mathematically honest because it uses effective sample size, calibrated likelihood ratios, uncertainty thresholds, and explicit impossibility boundaries.

If built this way, Attribution Integrity becomes a natural extension of Licio's existing philosophy: no applause, no pay-to-rank, privacy by construction, constructive participation, and mathematical invariants as safety constraints rather than hidden punishments.

---

## 25. Source-Grounding Notes

This specification was designed around Licio's current public repository doctrine as of 2026-06-20:

- Licio is a privacy-first social news/forum PWA where distribution is earned by genuine attention and constructive participation, not applause or payment.
- The repository uses React/Vite PWA, Hono BFF, PostgreSQL/Redis, strict TypeScript, zod trust boundaries, and CI/runtime gates.
- Raw attention is processed in-browser and only coarse aggregates egress.
- PWAtt rewards source-opening, evidence, corrections, synthesis, and bridge-building; shadow scores carry zero ranking power until explicitly enabled.
- Licio has passwordless identity, append-only audit logs, privacy-by-construction constraints, and existing AI/model-governance workstreams.
- The SPEC frames mathematical invariants as audit services and safety constraints, not opaque automatic punishment.

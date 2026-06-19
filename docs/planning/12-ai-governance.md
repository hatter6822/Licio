# WS-K. AI and Model Governance

**Milestone:** M3 | **Priority:** 3 | **Dependencies:** WS-G (forum/threads/evidence for summarization + claim graph), WS-H (invariant platform conventions for model/invariant cards), WS-F (ingestion for topic classification + claim extraction), WS-J.2 (steward review queue) | **Wave:** 5 | **Estimated duration:** 3 weeks

> **Status: COMPLETE.**  Implemented as the browser-safe `@licio/ai-governance`
> domain package (schemas + deterministic governance math) + the
> `apps/api/src/ai-governance` services, the `packages/db` schema + migration
> `0034`, the `/v1/ai/*` routes, and the `apps/web` `AiLabel` provenance badge.
> All twelve definition-of-done conditions hold; the governed models are
> deterministic providers (the value is the GOVERNANCE, not ML inference) so a
> real backend swaps in behind the unchanged registry/evaluation/guard surface.
> The implementation reference (architecture, per-section status, testing,
> production wiring, and the tracked residuals — gated Drizzle adapters, deeper
> client render-path integration, WS-M proposal-data wiring, a real model
> backend, the WS-P experiment-log consumer) is `docs/ai-governance/README.md`.

## Overview

Every AI model used in Licio has a model card, undergoes bias/safety evaluation, and has documented prohibited uses. AI outputs are labeled as machine-generated and are user/steward-editable. No autonomous treasury execution, no investment advice, no manipulative voting recommendations.

This workstream operationalizes SPEC Section 24 (AI/ML), Section 24.5 (AI around Knomosis governance), Section 15.4 (three-layer summaries), and Section 28.2 (experimentation rules for AI-bearing experiments). It aligns the AI inventory and risk assessments to the NIST AI RMF and ISO/IEC 42001 (Section 24.2). The governance posture is layered:

```
AI inventory + risk assessment (NIST/ISO)
  → model registry (model cards, versions, deployment gate)
    → evaluation harness (bias/subgroup, hallucination, safety/privacy, red-team)
      → prohibited-use enforcement (policy interception)
        → application pipelines (classification, extraction, summarization, translation)
          → human-in-the-loop correction + data lineage + version logging
```

Per Section 24.1, AI is never the sole authority for high-impact moderation (except a narrowly defined emergency class) and AI never autonomously spends funds, approves proposals, or issues final sanctions. Per Section 24.2, the platform maintains model cards (ranking, safety, summarization, invariant models), data lineage for training/evaluation, bias/subgroup audits, human review for appeals and ambiguous cases, AI-generated labeling, preserved source citations, user reporting of bad outputs, no unsupported factual claims, logged model version and prompt/configuration for audit-sensitive outputs, and red-team testing before launch.

### Shared conventions

- **Model card** — the documentation record defined in WS-K.1.1a, stored in the registry (WS-K.1.1b). It mirrors the `InvariantCard` conventions from WS-H so AI models and invariants share an audit vocabulary (owner, version, input/output schema, known failure modes).
- **AI output labels** — every AI-produced artifact carries a persistent, visible provenance label: `machine-generated` (summaries), `AI-classified` (topics), `AI-draft` (claims), `AI-translated` (translations). Human revision upgrades the label to `user-edited`, `steward-confirmed`, or `steward-corrected`. Labels live in both UI and metadata.
- **Audit-sensitive output record** — for any output that can influence moderation, ranking, governance, or user trust, the system logs `model_name`, `model_version`, `prompt/config hash`, `input refs`, `output`, and `timestamp` (Section 24.2 "log model version and prompt/configuration").
- **Data lineage record** — every training/evaluation dataset has a lineage entry (source, consent basis, transformations, version) per Section 24.2.
- **Content scope (server-hosted only)** — every AI capability in this workstream (classification, claim extraction, summarization, embeddings, translation, content labeling, model-driven triage) operates exclusively on **server-hosted content**: the `public_server` ("Public room") and `restricted_server` ("Members-only server room") classes (WS-Q / WS-S §20.1). `private_p2p` ("Private P2P room", WS-S) content is end-to-end encrypted and the platform never sees its plaintext (PRIVATE_SPEC §8 server non-storage contract), so server-side AI structurally cannot and does not run on it — no classification, summarization, embeddings, or model-driven labeling/moderation; any in-room AI assistance would have to be fully client-side/local and is out of scope here. This is an honest, by-design boundary, not a capability gap. Content arriving via the WS-R / LCAP alternate ingress (`docs/OFFLINE_SPEC.md`) reconciles into the **same** canonical server state and is classified/summarized/embedded normally **after** reconciliation — it is ordinary server-hosted content needing no special handling.

All schemas are zod-defined and co-located with their TypeScript types in `packages/ai-governance/src/schemas/`.

---

## WS-K.1 AI infrastructure

### WS-K.1.1a Model card schema
**ID:** WS-K.1.1a
**Ref:** Section 24.2

**Description:**
Define the model card schema for documenting every AI model used in Licio. The schema captures the information required for responsible AI governance, audit, and transparency. Fields:

- **name:** human-readable model name.
- **version:** semantic version string.
- **owner:** team or individual responsible for the model.
- **purpose:** what the model does in the product (e.g., "topic classification for story ingestion").
- **training_data_summary:** description of training data sources, size, temporal range, and any known gaps or biases in the training data. No raw training data is stored in the model card.
- **data_lineage_refs:** references to the data lineage records (WS-K.1.1e) for the training/evaluation datasets used.
- **input_schema:** the structure and types of inputs the model accepts.
- **output_schema:** the structure and types of outputs the model produces.
- **prohibited_uses:** the prohibited uses applicable to this model (linked to WS-K.1.1d), so prohibitions are documented on the card itself.
- **known_biases:** documented biases identified through evaluation (e.g., "lower accuracy for under-represented languages," "overclassifies political satire as misinformation").
- **limitations:** documented limitations (e.g., "not trained on code-switching text," "accuracy drops below 80% for texts under 50 characters").
- **evaluation_results:** structured results from bias audits, accuracy benchmarks, safety tests, and red-team testing, with links to evaluation reports.
- **risk_assessment_ref:** link to the NIST AI RMF / ISO 42001 risk assessment for this model's use case (WS-K.1.1c).
- **update_history:** changelog of model version updates with dates, descriptions of changes, and evaluation results for each version.

The schema is defined as a zod schema. Model cards are stored in the model registry and are queryable.

**Acceptance criteria:**
- Model card schema is defined with all listed fields.
- zod schema validates model cards at write time.
- All fields are required except `known_biases` and `limitations` (which default to "not yet evaluated" for new models pending evaluation).
- `prohibited_uses`, `data_lineage_refs`, and `risk_assessment_ref` are present and resolve to existing records.
- `update_history` is append-only -- previous entries cannot be modified.
- Model cards are queryable by name, version, purpose, and owner.

**Testing:**
- Unit test: a valid model card passes schema validation.
- Unit test: a model card with missing required fields is rejected.
- Unit test: `update_history` entries cannot be deleted or modified.
- Unit test: a card with a dangling `data_lineage_ref` or `risk_assessment_ref` is rejected.
- Integration test: a model card is persisted and retrievable by name and version.
- Snapshot test: schema changes are detected and require explicit review.

**Dependencies:** WS-H.1.2b (invariant card schema, for shared card conventions), WS-K.1.1c (risk assessment refs), WS-K.1.1d (prohibited-use refs), WS-K.1.1e (data lineage refs).

**Observability:** Emit `model.card.written` and `model.card.updated`; a registry dashboard shows cards with incomplete evaluation (`known_biases`/`limitations` still "not yet evaluated") so no such model reaches production unnoticed.

**Security/privacy:** No raw training data is stored on the card — only summaries and lineage references. This keeps potentially sensitive training content out of the broadly readable registry.

---

### WS-K.1.1b Model registry service
**ID:** WS-K.1.1b
**Ref:** Section 24.2

**Description:**
Implement the model registry service for managing AI model lifecycle. The registry supports:

- **Register:** add a new model with its model card. Registration requires a complete model card (WS-K.1.1a) and at least one evaluation result.
- **Version:** publish a new version of an existing model. Versioning requires updated evaluation results and a changelog entry. Old versions are preserved, not overwritten.
- **Lookup:** query models by name, version, purpose, or status. Returns the model card and current deployment status.
- **Deprecate:** mark a model version as deprecated with a deprecation reason and a recommended replacement version. Deprecated models emit warnings when queried, but remain queryable for audit.

The registry enforces that no model can be deployed to production without a model card AND passing evaluation results AND a resolved risk assessment. The registry API is access-controlled -- only AI team members can register/version/deprecate; all authenticated users can look up model cards. The deployment gate is the single chokepoint that the evaluation harness (WS-K.1.2e) and the ML feature audit (WS-I.3.1g) hook into.

**Acceptance criteria:**
- Models can be registered, versioned, looked up, and deprecated.
- Registration requires a complete model card and at least one evaluation result.
- Versioning preserves old versions and requires updated evaluations.
- Deprecated models emit warnings but remain queryable.
- No model can be deployed without a model card in the registry, passing evaluations, and a resolved risk assessment.
- Access control: register/version/deprecate restricted to the AI team; lookup open to all authenticated users.

**Testing:**
- Unit test: register a new model with a valid card and evaluation results.
- Unit test: register without evaluation results is rejected.
- Unit test: version a model, verify the old version is preserved.
- Unit test: deprecate a model, verify a warning on lookup.
- Integration test: the deploy pipeline checks the registry (card + evals + risk assessment) before deployment.
- Security test: a non-AI-team user cannot register or deprecate models.

**Dependencies:** WS-K.1.1a (model card), WS-K.1.1c (risk assessment), WS-K.1.2e (evaluation harness gate), WS-D.1.6 (auth/roles).

**Observability:** Emit `model.registered`, `model.versioned`, `model.deprecated`, and `model.deploy.gated` (with the gating reason on rejection). A dashboard shows the current production version per use case and any deprecated-but-still-deployed models.

**Security/privacy:** The registry is the deployment chokepoint; bypassing it is impossible because the deploy pipeline queries it. Role separation prevents unreviewed model promotion.

---

### WS-K.1.1c AI inventory and NIST/ISO risk assessment
**ID:** WS-K.1.1c
**Ref:** Sections 24.1, 24.2

**Description:**
Document the complete inventory of AI use cases in Licio with risk assessments aligned to the NIST AI RMF and ISO/IEC 42001 (Section 24.2). Each use case has:

- **use_case_id:** unique identifier.
- **name:** human-readable name.
- **description:** what the AI does for this use case.
- **model_name:** which model(s) serve this use case (linked to the model registry).
- **risk_level:** low, medium, high, critical -- based on the potential impact of errors (per NIST AI RMF GOVERN/MAP/MEASURE/MANAGE functions).
- **risk_assessment:** structured assessment covering identified harms, affected populations, likelihood/impact, mitigations, residual risk, and the responsible owner — mapped to NIST AI RMF and ISO/IEC 42001 controls.
- **human_oversight:** level of human oversight required (none for low-risk, review for medium, approval for high, prohibited for critical).

Use cases:
| Use case | Risk level | Human oversight |
|---|---|---|
| Topic classification | Medium | Steward review queue |
| Duplicate detection | Low | None (MERI handles dedup) |
| Claim extraction | Medium | Steward review, user editable |
| Toxicity/safety triage | High | Always human review for enforcement |
| Summarization | Medium | User reportable, steward correctable |
| Translation | Medium | Original text always accessible |
| Embedding generation | Low | None (used for similarity/search) |
| AI around governance (proposal summary, COI flags) | High | Steward editable/contestable; never autonomous |

**Acceptance criteria:**
- All use cases are documented with risk levels, risk assessments, and oversight requirements.
- Each use case links to the model(s) serving it in the registry.
- Risk levels and assessments are aligned with NIST AI RMF and ISO/IEC 42001.
- Human oversight requirements are enforced by the system (e.g., toxicity triage cannot auto-enforce without human review).
- The inventory is version-controlled and updated when new AI use cases are added.
- The AI-around-governance use case is present and marked never-autonomous (Section 24.5).

**Testing:**
- Unit test: each use case is present in the inventory with all required fields including the risk assessment.
- Integration test: use case links resolve to valid models in the registry.
- Enforcement test: toxicity triage produces flags but does not auto-enforce without human review.
- Audit test: inventory version history is maintained.

**Dependencies:** WS-A.1 (policy taxonomy), WS-K.1.1b (registry link target), WS-K.1.1d (oversight enforcement for prohibited/critical).

**Observability:** Emit `ai.inventory.updated`; a governance dashboard lists every AI use case with its risk level and current oversight posture, supporting the NIST AI RMF GOVERN function.

**Security/privacy:** The risk assessment explicitly records affected populations and residual risk, satisfying the responsible-AI documentation requirement and feeding the bias-audit subgroup selection (WS-K.1.2a).

---

### WS-K.1.1d Prohibited-use enforcement
**ID:** WS-K.1.1d
**Ref:** Sections 24.1, 24.5

**Description:**
Implement enforcement of prohibited AI uses. The system blocks AI from being used for:

- **Autonomous treasury execution:** AI cannot approve, execute, or initiate treasury transactions. All treasury actions require human approval with defined signing authority.
- **Investment advice:** AI cannot generate personalized financial recommendations, predict returns, or suggest specific financial actions.
- **Manipulative voting recommendations:** AI cannot recommend how users should vote on governance proposals, frame proposals to favor specific outcomes, or predict vote outcomes to influence participation.
- **Wealth-based profiling:** AI cannot use wallet balance, payment history, or treasury contributions to profile users, personalize content, or segment audiences (also barred from feeds by the ranking denylist, WS-I.2.1b).
- **Risk-identity hiding:** AI cannot be used to obscure, mask, or rewrite content to hide the identity of a risk actor (sanctions target, fraud suspect) from safety/compliance review.

Enforcement is implemented as a policy layer (`ProhibitedUseGuard`) that intercepts every AI model invocation and blocks requests matching prohibited-use patterns BEFORE the model runs. Blocked requests are logged with the prohibition that was triggered. The guard also encodes the Section 24.5 permitted/prohibited split for AI-around-governance (see WS-K.1.5a), so the same mechanism serves both general and governance-specific prohibitions.

**Acceptance criteria:**
- All five prohibited uses are defined and enforced.
- AI model invocations matching prohibited patterns are blocked before execution.
- Blocked invocations are logged with the prohibition reason.
- Treasury-related AI actions (summary, comparison) that are NOT autonomous execution are permitted.
- Governance summaries that inform without recommending are permitted.
- Prohibited-use definitions are version-controlled and require AI team + legal review to modify.

**Testing:**
- Unit test: an attempt to invoke AI for autonomous treasury approval is blocked.
- Unit test: an attempt to invoke AI for investment advice is blocked.
- Unit test: an attempt to invoke AI for voting recommendations is blocked.
- Unit test: an attempt to invoke AI for wallet-based profiling is blocked.
- Unit test: an attempt to invoke AI to hide risk identity is blocked.
- Positive test: AI invoked for a governance proposal summary (permitted use) succeeds.
- Positive test: AI invoked for a treasury action explanation (permitted use) succeeds.
- Audit test: blocked invocations are logged with the correct prohibition reason.

**Dependencies:** WS-K.1.1c (use-case oversight levels), WS-K.1.5a (governance permitted/prohibited matrix), WS-M (treasury/governance surfaces the guard protects), WS-N (legal-review process for changes).

**Observability:** Emit `ai.invocation.blocked` with `{ prohibition, model_name, caller, context_ref }`. A security dashboard tracks blocked-invocation rate by prohibition; a nonzero rate on autonomous-treasury or risk-identity-hiding is a high-priority alert.

**Security/privacy:** The guard intercepts before execution, so a prohibited request never reaches the model. Wealth-based profiling is blocked here AND structurally impossible in ranking (WS-I.2.1b), giving defense in depth. Changes require dual AI + legal review.

---

### WS-K.1.1e Data lineage tracking
**ID:** WS-K.1.1e
**Ref:** Section 24.2

**Description:**
Implement data lineage tracking for AI training and evaluation datasets, satisfying the Section 24.2 requirement to "maintain data lineage for training/evaluation." Each lineage record captures:

- **dataset_id / version:** identity and version of the dataset.
- **source:** where the data came from (e.g., "steward-corrected claim extractions," "public licensed corpus X").
- **consent_basis / license:** the legal/consent basis for using the data, including whether it contains user-derived content and under what governance approval.
- **transformations:** the ordered list of transformations applied (cleaning, de-identification, sampling, labeling) with the responsible actor and timestamp.
- **privacy_review_ref:** reference to the privacy review that cleared the dataset for use, where user-derived data is involved.
- **used_by:** the models/versions trained or evaluated on this dataset (back-reference to model cards).

Lineage records are immutable and append-only; a new dataset version creates a new record linked to its predecessor. Feedback data collected from steward corrections (WS-K.1.3c) flows into lineage as a tracked source with provenance and privacy review.

**Acceptance criteria:**
- Every training/evaluation dataset used by a registered model has a lineage record.
- Lineage records include source, consent/license basis, transformations, and privacy review reference.
- Lineage records are immutable; new versions link to predecessors.
- User-derived datasets carry a privacy review reference; without it they cannot be marked usable.
- Model cards reference their datasets' lineage records (WS-K.1.1a `data_lineage_refs`).
- Steward-correction feedback data is registered as a lineage source with provenance.

**Testing:**
- Unit test: a lineage record passes schema validation with all required fields.
- Unit test: a user-derived dataset without a privacy review reference cannot be marked usable.
- Unit test: lineage records are append-only; modification of a historical record fails.
- Integration test: registering a model with `data_lineage_refs` resolves to existing lineage records.
- Privacy test: feedback data from steward corrections appears in lineage with provenance and a privacy review reference.

**Dependencies:** WS-D.2 (privacy-review workflow), WS-K.1.3c (steward-correction feedback as a source), WS-K.1.1a (model card back-reference).

**Observability:** Emit `data.lineage.recorded`; a dashboard shows, for any model, the full upstream dataset lineage and whether each dataset cleared privacy review.

**Security/privacy:** Lineage makes the provenance and consent basis of every dataset auditable, and prevents user-derived data from entering training without an explicit privacy review reference — a hard precondition for the WS-K.1.3c fine-tuning path.

---

### WS-K.1.1f Audit-sensitive output and version logging
**ID:** WS-K.1.1f
**Ref:** Sections 24.2, 28.2

**Description:**
Implement structured logging of `model_version` and `prompt/configuration` for audit-sensitive AI outputs (Section 24.2). An output is audit-sensitive if it can influence moderation, ranking, governance, user trust, or a label shown to users (classifications, claim drafts, summaries, translations, toxicity-triage flags, governance summaries). For each such output the system records an immutable `AIOutputRecord`: `{ output_id, model_name, model_version, prompt_template_id, config_hash, input_refs[], output_ref, use_case_id, timestamp }`. Per Section 28.2, experiment logs include invariant/model versions; this record is the source for that requirement on the AI side. The record links to the data lineage of the producing model and to any downstream human correction (WS-K.1.3c, WS-K.1.4c).

**Acceptance criteria:**
- Every audit-sensitive AI output produces an `AIOutputRecord` with model name, version, prompt template id, and config hash.
- Records are immutable and queryable by `output_id`, `model_name`/`version`, `use_case_id`, and time range.
- The record links input refs and the output ref without storing private payloads inappropriately.
- Records are retained per the applicable retention policy and access-controlled.
- Experiment runs surface the model versions from these records (Section 28.2).

**Testing:**
- Unit test: producing a summary writes an `AIOutputRecord` with all required fields.
- Unit test: the record is immutable; modification fails.
- Integration test: query records by model version returns all outputs from that version.
- Integration test: a steward correction links back to the originating `AIOutputRecord`.
- Privacy test: records reference inputs/outputs without exposing data beyond authorized roles.

**Dependencies:** WS-K.1.1b (model versions), WS-K.1.1e (lineage link), WS-K.1.3c / WS-K.1.4c (correction links), WS-P (experiment logging consumer).

**Observability:** The record store IS an observability substrate; additionally emit `ai.output.recorded` counters by use case and version so the production version mix is visible and a stalled rollout is detectable.

**Security/privacy:** Records are access-controlled and reference rather than duplicate sensitive payloads. They provide the audit trail required for any AI output that affects user trust or enforcement.

---

### WS-K.1.2a Bias and subgroup audit framework
**ID:** WS-K.1.2a
**Ref:** Section 24.2

**Description:**
Implement a bias audit framework for evaluating AI model performance across demographic and content subgroups (Section 24.2 "conduct bias and subgroup audits"). The framework tests model outputs for disparate performance across:

- **Language:** accuracy/quality across languages supported by the platform.
- **Region:** performance differences between content from different geographic regions.
- **Topic sensitivity:** performance on sensitive topics (politics, religion, health, race, gender) versus neutral topics.
- **Content length:** performance differences between short and long content.
- **Source type:** performance across different source types (professional journalism, blogs, social posts, academic papers).

For each model and subgroup combination, the framework computes:
- Accuracy/precision/recall (for classification models).
- Quality scores (for generation models, using automated metrics and human evaluation).
- Error rate disparities between subgroups.
- Statistical significance of any disparities.

Results are stored in the model card's `evaluation_results` field. Models with disparities above a configurable threshold cannot be deployed until the disparity is addressed or explicitly accepted with documentation. Subgroup selection is informed by the affected-populations field of the risk assessment (WS-K.1.1c).

**Acceptance criteria:**
- The bias audit runs across all defined subgroup dimensions (language, region, topic, length, source type).
- Per-subgroup accuracy/quality metrics are computed and stored.
- Disparities above threshold block deployment (enforced via the registry gate, WS-K.1.1b).
- Accepted disparities are documented in the model card with justification.
- Audit results are linked to the model card's `evaluation_results`.
- The framework supports both automated metrics and human evaluation scores.

**Testing:**
- Unit test: the audit correctly computes per-subgroup metrics from fixture data.
- Unit test: a disparity above threshold produces a deployment-blocking result.
- Unit test: an accepted disparity with documentation allows deployment.
- Integration test: audit results are persisted in the model card.
- Regression test: a model version upgrade triggers a new bias audit.

**Dependencies:** WS-K.1.1a (card storage of results), WS-K.1.1c (affected-population-driven subgroup selection), WS-K.1.2e (harness orchestration), WS-K.1.1b (deployment-blocking gate).

**Observability:** Emit `model.bias_audit.completed` with per-subgroup disparity summaries; a fairness dashboard tracks disparity trends across model versions to detect regressions.

**Security/privacy:** Subgroup evaluation uses aggregate/labeled evaluation data, not individual user profiling. Protected small subgroups are handled carefully (consistent with GWEI's small-cohort protection) to avoid exposing individuals.

---

### WS-K.1.2b Hallucination detection
**ID:** WS-K.1.2b
**Ref:** Sections 24.2, 24.3

**Description:**
Implement hallucination detection for AI models that generate text (summarization, claim extraction, translation). The detector compares AI outputs against source material and flags unsupported claims, supporting the Section 24.2 requirement to "avoid unsupported factual claims."

Detection methods:
- **Source grounding:** for each claim or statement in the AI output, verify it can be traced to specific content in the source material. Ungrounded statements are flagged.
- **Factual consistency:** check that the AI output does not contradict the source material.
- **Attribution verification:** verify that citations in AI-generated summaries reference actual source branches and evidence cards.

The hallucination detector runs:
- As part of the evaluation harness before model deployment.
- At runtime on a sample of AI outputs for ongoing monitoring.
- On demand when a user reports a bad summary or extraction.

Flagged hallucinations are logged and routed to the steward review queue.

**Acceptance criteria:**
- The source grounding check identifies statements not supported by source material.
- The factual consistency check identifies contradictions with source material.
- Attribution verification confirms cited sources exist and are relevant.
- The hallucination rate is computed per model and tracked over time.
- Flagged hallucinations are routed to steward review.
- The runtime sampling rate is configurable (default: 10% of AI outputs).

**Testing:**
- Unit test: an AI output with an unsupported claim is flagged.
- Unit test: an AI output consistent with source material passes.
- Unit test: an AI output with a fake citation is flagged.
- Integration test: a flagged hallucination appears in the steward review queue.
- Benchmark test: the hallucination rate on a reference corpus is below the acceptable threshold.

**Dependencies:** WS-G (source branches/evidence cards for grounding), WS-K.1.3c (steward review queue), WS-K.1.2e (harness integration), WS-K.1.2f (runtime monitoring sampling).

**Observability:** Emit `ai.hallucination.flagged` and per-model hallucination-rate gauges; a dashboard tracks the rate over time and by use case, alerting on regressions after a model version change.

**Security/privacy:** Grounding/attribution checks operate over content the user can already see (source branches, evidence cards); they do not introduce new data exposure.

---

### WS-K.1.2c Safety/privacy test suite
**ID:** WS-K.1.2c
**Ref:** Sections 24.2, 19

**Description:**
Implement a safety and privacy test suite for AI models. The suite tests that AI models:

- **Do not expose private data:** AI outputs do not include private user data (email, phone, location, wallet address, moderation history) that was present in the input context but not appropriate for the output.
- **Do not generate harmful content:** AI outputs do not generate harassment, threats, hate speech, CSAM descriptions, self-harm instructions, or other policy-violating content when given adversarial inputs.
- **Respect data minimization:** AI models use only the data necessary for their task and do not retain or memorize user-specific data across invocations.
- **Handle sensitive topics safely:** AI models handling sensitive topics (medical, self-harm, extremism) produce appropriate safety disclaimers and do not amplify harmful narratives.

The test suite includes both automated tests (run in CI before deployment) and periodic manual evaluations.

**Acceptance criteria:**
- Private data exposure tests pass for all AI models that process user data.
- Harmful content generation tests pass for all generative AI models.
- Data minimization is verified (no cross-invocation data leakage).
- Sensitive topic handling includes appropriate disclaimers.
- The test suite runs automatically before any model deployment.
- Test failures block deployment.

**Testing:**
- Unit test: an AI model given input with email/phone does not include it in output.
- Unit test: an AI model given an adversarial prompt does not generate harmful content.
- Unit test: an AI model does not recall information from a previous invocation for a different user.
- Integration test: a sensitive topic input produces output with a safety disclaimer.
- CI gate: the test suite runs and passes before model deployment proceeds.

**Dependencies:** WS-D.2 (definition of private data classes), WS-J (harmful-content policy taxonomy), WS-K.1.2e (harness/CI integration), WS-K.1.1b (deployment gate).

**Observability:** Emit `model.safety_suite.completed` with pass/fail per category; failures block deployment via the registry gate and page the AI owner.

**Security/privacy:** This task is itself a privacy control: it asserts no private input leaks into outputs and that models do not memorize cross-user data, directly supporting Section 19.

---

### WS-K.1.2d Red-team testing protocol
**ID:** WS-K.1.2d
**Ref:** Section 24.2

**Description:**
Define and implement a red-team testing protocol for AI models before launch (Section 24.2 "apply red-team testing before launch"). The protocol covers:

- **Adversarial prompts:** test the model's response to inputs designed to produce prohibited outputs (jailbreaks, prompt injections, role-playing attacks).
- **Jailbreak attempts:** systematically test known jailbreak techniques against the model's safety guardrails.
- **Bias probing:** test the model with inputs designed to reveal biased behavior (e.g., changing only the demographic context of an input and comparing outputs).
- **Edge cases:** test with unusual, malformed, or boundary-condition inputs (empty input, very long input, mixed languages, code-switching, Unicode edge cases).

Red-team testing is required before:
- Initial deployment of any new model.
- Major version upgrades of existing models.
- Changes to model safety guardrails or filters.

Results are documented in the model card with findings, mitigations, and any accepted risks. Reproducible adversarial inputs that surface defects are promoted into the automated safety suite (WS-K.1.2c) as regression cases.

**Acceptance criteria:**
- The red-team protocol defines test categories: adversarial prompts, jailbreaks, bias probing, edge cases.
- Red-team testing is required before initial deployment and major version upgrades.
- Results are documented in the model card.
- Critical findings (model produces prohibited content) block deployment.
- Accepted risks are documented with justification.
- A minimum number of test cases per category is defined (configurable, default: 50 per category).

**Testing:**
- Process test: red-team testing is a required step in the model deployment pipeline.
- Documentation test: the model card includes a red-team results section after testing.
- Regression test: previously identified adversarial inputs are added to the automated test suite.
- Coverage test: the minimum test case count per category is met.

**Dependencies:** WS-K.1.2c (regression-case sink), WS-K.1.1a (card results), WS-K.1.1d (prohibited-use definitions as test oracles), WS-K.1.2e (harness gate).

**Observability:** Emit `model.redteam.completed` with per-category coverage and critical-finding counts; a launch-readiness dashboard shows whether each model has current red-team coverage.

**Security/privacy:** Red-team findings that surface data-exposure or harmful-generation paths feed directly back into the privacy/safety suite, hardening the model before launch.

---

### WS-K.1.2e Evaluation harness orchestrator and deployment gate
**ID:** WS-K.1.2e
**Ref:** Sections 24.2, 30.9

**Description:**
Implement the evaluation harness that orchestrates the bias audit (WS-K.1.2a), hallucination detection (WS-K.1.2b), safety/privacy suite (WS-K.1.2c), and red-team protocol (WS-K.1.2d) into a single pre-deployment evaluation run, and wire it to the registry deployment gate (WS-K.1.1b). For a candidate model version, the harness runs all applicable evaluations (selected by the use case's modality and risk level), aggregates results into the model card's `evaluation_results`, and returns a deploy/block decision. A model version cannot be deployed unless the harness produced a passing (or documented-and-accepted) result for every required evaluation. This realizes the Section 30.9 "AI" cross-functional gate (source-grounded, logged, evaluated, correctable) as an automated chokepoint.

**Acceptance criteria:**
- The harness runs all applicable evaluations for a candidate model version based on modality and risk level.
- Results are aggregated into the model card and an overall deploy/block decision is produced.
- A model version with any failing required evaluation is blocked at the registry gate.
- High/critical-risk use cases require the full evaluation set (including red-team) before deployment.
- The harness run is reproducible and logged with the evaluation dataset versions used.
- Accepted-with-documentation results are honored by the gate.

**Testing:**
- Unit test: the harness selects the correct evaluation set for a given use case modality/risk.
- Unit test: a failing required evaluation yields a block decision.
- Integration test: the registry refuses to deploy a model that the harness blocked.
- Integration test: a passing harness run records results on the model card and permits deployment.
- Reproducibility test: re-running the harness on the same model and dataset versions yields the same decision.

**Dependencies:** WS-K.1.2a, WS-K.1.2b, WS-K.1.2c, WS-K.1.2d, WS-K.1.1b (gate), WS-K.1.1e (dataset versions), WS-K.1.1c (risk-level-driven selection).

**Observability:** Emit `model.evaluation.run.completed` with `{ model_name, version, decision, per_eval_results, dataset_versions }`. A dashboard shows every candidate model's evaluation status and the reason for any block.

**Security/privacy:** Centralizing the gate guarantees no model reaches production without bias, safety, privacy, and red-team coverage. The harness records dataset versions for reproducibility, tying evaluations to data lineage.

---

### WS-K.1.2f Runtime AI monitoring
**ID:** WS-K.1.2f
**Ref:** Sections 24.2, 28.2

**Description:**
Implement ongoing runtime monitoring of deployed AI models, complementing pre-deployment evaluation. The monitor samples production outputs (configurable rate, default 10%) and runs lightweight checks: hallucination sampling (WS-K.1.2b), output-distribution drift, label-rate drift (e.g., a sudden change in the fraction of content classified as a sensitive topic), and user-report rate per model/version. When a metric crosses a threshold, the monitor alerts the model owner and can recommend rollback to the prior registry version. This satisfies the operational half of responsible-AI governance and provides the production signal that feeds the human-in-the-loop correction loop (WS-K.1.3c).

**Acceptance criteria:**
- A configurable sample of production AI outputs is evaluated at runtime.
- Drift in output distribution, label rates, hallucination rate, and user-report rate is tracked per model/version.
- Threshold crossings alert the model owner.
- The monitor can recommend (not autonomously execute) rollback to the prior registry version.
- Monitoring data references `AIOutputRecord`s (WS-K.1.1f) for traceability.

**Testing:**
- Unit test: sampling selects the configured fraction of outputs.
- Unit test: a simulated label-rate drift crosses the threshold and emits an alert.
- Integration test: a spike in user-reported bad summaries raises the user-report-rate alert for the responsible model.
- Integration test: a rollback recommendation references a valid prior registry version.

**Dependencies:** WS-K.1.1f (output records), WS-K.1.2b (hallucination sampling), WS-K.1.1b (prior versions for rollback), WS-K.1.4c / WS-K.1.3c (user-report inputs).

**Observability:** This task is primarily observability. Emit `ai.runtime.metric` time series per model/version and `ai.runtime.alert` on threshold crossings; a live dashboard shows model health by use case.

**Security/privacy:** Runtime sampling uses the same access-controlled `AIOutputRecord` substrate; it does not create a new uncontrolled copy of user data. Rollback is human-approved, never autonomous (Section 24.1).

---

### WS-K.1.3a Topic classification pipeline
**ID:** WS-K.1.3a
**Ref:** Section 24.1

**Description:**
Implement the topic classification pipeline for assigning topic labels to stories and content. The pipeline:

- **Multi-label assignment:** each story can have multiple topic labels (e.g., "climate," "policy," "local news"). Labels are assigned with confidence scores.
- **Confidence thresholds:** labels below the confidence threshold (configurable, default 0.7) are not applied automatically but may be suggested for user/steward review.
- **AI-classified label:** all automatically assigned topic labels carry a visible "AI-classified" marker in the UI and metadata. The marker distinguishes AI-assigned topics from user-selected or steward-confirmed topics.
- **Topic taxonomy:** the pipeline uses the platform's topic taxonomy (defined in WS-A), mapping model outputs to canonical topic IDs.

The pipeline runs during story ingestion (WS-F) and produces topic assignments that feed into candidate retrieval (WS-I.1) and feature computation (WS-I.2.1). Each classification writes an `AIOutputRecord` (WS-K.1.1f) for audit.

**Acceptance criteria:**
- Stories receive multi-label topic assignments with confidence scores.
- Labels below the confidence threshold are suggested, not applied.
- All AI-assigned labels carry the "AI-classified" marker.
- Model outputs map to canonical topic taxonomy IDs.
- Classification runs during ingestion and completes within the ingestion latency budget.
- The model version is logged with each classification for audit (`AIOutputRecord`).

**Testing:**
- Unit test: a story with clear topic signals receives correct labels above the confidence threshold.
- Unit test: a story with ambiguous topics receives labels below threshold as suggestions.
- Unit test: all AI-assigned labels carry the "AI-classified" marker.
- Integration test: classified topics feed into candidate retrieval correctly.
- Accuracy test: classification accuracy on a held-out test set meets the minimum threshold (configurable, default: 85% precision).
- Latency test: classification completes within the ingestion latency budget.

**Dependencies:** WS-F.1 (ingestion), WS-A.1 (topic taxonomy), WS-K.1.1b (registered classifier model), WS-K.1.1f (output record), WS-K.1.3c (review queue for sub-threshold labels).

**Observability:** Emit `topic.classification.completed` with confidence distribution and sub-threshold-suggestion rate; the label-rate feeds the runtime drift monitor (WS-K.1.2f).

**Security/privacy:** Classification operates on submitted content, not user profiles; it never reads financial or wealth data (consistent with the WS-I denylist and Section 24.5 wealth-profiling prohibition).

---

### WS-K.1.3b Claim extraction pipeline
**ID:** WS-K.1.3b
**Ref:** Section 24.1

**Description:**
Implement the claim extraction pipeline for extracting discrete propositions from story text. The pipeline:

- **Proposition extraction:** identify and extract individual claims, assertions, and propositions from story text. Each extracted claim is a standalone statement that can be independently verified, challenged, or supported with evidence.
- **AI-draft label:** all extracted claims carry an "AI-draft" label visible in the UI and metadata. The label indicates that the claim was extracted by AI and has not been reviewed by a human.
- **Editability:** extracted claims are fully editable by users and stewards. Users can correct, split, merge, or delete AI-extracted claims. Stewards can confirm, reject, or modify claims.
- **Source reference:** each extracted claim links back to the specific text passage it was derived from in the source story.

The pipeline runs during story ingestion and produces claim objects that feed into the evidence system (WS-G) and the claim-evidence graph. Each extraction writes an `AIOutputRecord` (WS-K.1.1f).

**Acceptance criteria:**
- Claims are extracted as discrete, standalone propositions.
- Each claim carries the "AI-draft" label.
- Claims are editable by users and stewards.
- Each claim links to the specific source text passage.
- Extraction runs during ingestion and completes within the latency budget.
- The model version is logged with each extraction for audit.
- Over-extraction (splitting one claim into too many fragments) is controlled by a granularity parameter.

**Testing:**
- Unit test: story text with clear claims produces correct extractions.
- Unit test: all extractions carry the "AI-draft" label.
- Unit test: extractions link to the correct source text passages.
- E2E test: a user edits an AI-extracted claim, verify the edit persists and the label changes to user-edited.
- E2E test: a steward confirms a claim, verify the label changes to steward-confirmed.
- Accuracy test: extraction quality on a labeled test set meets the minimum threshold.

**Dependencies:** WS-F.1 (ingestion/claims), WS-G (evidence/claim graph), WS-K.1.1b (registered extractor model), WS-K.1.1f (output record), WS-K.1.3c (review queue).

**Observability:** Emit `claim.extraction.completed` with claims-per-story distribution (to monitor over-extraction) and edit/confirm rates from downstream human action.

**Security/privacy:** Extraction operates on submitted story text and links to passages; it introduces no private data. Label transitions (AI-draft → user-edited → steward-confirmed) preserve provenance.

---

### WS-K.1.3c Human-in-the-loop correction and feedback loop
**ID:** WS-K.1.3c
**Ref:** Sections 24.1, 24.2

**Description:**
Implement the steward review queue for AI classifications and extractions, with a feedback loop to improve model quality. The system:

- **Review queue:** AI-classified topics and AI-extracted claims that fall below a confidence threshold, or that have been reported by users, enter a steward review queue.
- **Correction workflow:** stewards can confirm, reject, or modify AI outputs. Corrections are persisted and the original AI output is preserved in version history (and linked to its `AIOutputRecord`).
- **Feedback loop:** confirmed and corrected outputs are collected as training/evaluation data for model improvement. The feedback data is:
  - Stored with provenance (which steward, when, what was changed).
  - Registered as a data lineage source (WS-K.1.1e) with a privacy review reference.
  - Used for periodic model evaluation (measuring improvement over time).
  - Optionally used for model fine-tuning (with appropriate data governance and privacy review).
- **Metrics:** the system tracks AI accuracy over time using steward corrections as ground truth, producing: correction rate, agreement rate, accuracy trend, and per-category performance.

**Acceptance criteria:**
- Low-confidence and user-reported AI outputs enter the steward review queue.
- Stewards can confirm, reject, or modify AI outputs.
- The original AI output is preserved in version history after correction.
- Corrections are collected as feedback data with provenance.
- Feedback data is registered in data lineage with a privacy review reference before any training use.
- Accuracy metrics (correction rate, agreement rate) are computed and dashboarded.
- The feedback loop respects privacy (no user-identifying data in training sets without review).

**Testing:**
- Unit test: a low-confidence classification enters the review queue.
- Unit test: a steward correction persists and preserves the original.
- Unit test: correction data includes provenance (steward, timestamp, change).
- Integration test: the correction rate metric is computed from accumulated corrections.
- Privacy test: feedback data does not include user-identifying information without explicit governance approval, and carries a lineage privacy review reference.
- Trend test: accuracy metrics trend upward after model updates using feedback data.

**Dependencies:** WS-J.2 (steward console/queue), WS-K.1.3a/K.1.3b (sources of AI outputs), WS-K.1.1e (lineage registration of feedback), WS-K.1.1f (link to output records), WS-D.2 (privacy review).

**Observability:** Emit `ai.correction.recorded` and `ai.accuracy.metric` time series (correction rate, agreement rate, per-category accuracy); a quality dashboard tracks the trend across model versions and is consumed by the runtime monitor (WS-K.1.2f).

**Security/privacy:** Feedback data cannot enter training without a data-lineage privacy review reference (WS-K.1.1e), enforcing the Section 24.2 lineage requirement and preventing unreviewed user data from reaching fine-tuning.

---

### WS-K.1.4a Summary generation
**ID:** WS-K.1.4a
**Ref:** Sections 15.4, 24.3

**Description:**
Implement automated draft summary generation for threads. The summary pipeline:

- **Automated draft:** generates a summary from the thread's branches, contributions, evidence cards, and context. The draft is the first layer of the three-layer summary system (automated draft, community synthesis, steward summary) defined in Section 15.4; the automated draft is "never final."
- **Machine-generated label:** every automated summary is labeled "machine-generated" in the UI and metadata. The label is persistent and visible to all readers.
- **Source citations:** the summary cites specific source branches and evidence cards. Each citation links to the referenced content. Citations are verifiable -- a reader can click through to the source.
- **Branch coverage:** the summary covers the main branches of the thread, including dissenting branches and minority viewpoints, not just the dominant discussion line.

Each summary writes an `AIOutputRecord` (WS-K.1.1f) and is subject to hallucination/attribution checks (WS-K.1.2b) before publication.

**Acceptance criteria:**
- Automated summaries are generated for threads meeting a minimum activity threshold.
- All summaries carry the "machine-generated" label.
- Summaries cite source branches and evidence cards with links.
- Citations are verifiable (links resolve to existing content).
- Summaries cover multiple branches, not just the dominant line.
- Summary generation runs asynchronously and does not block thread rendering.
- The model version is logged with each summary for audit.

**Testing:**
- Unit test: summary generation produces output with citations from a fixture thread.
- Unit test: the summary carries the "machine-generated" label.
- Unit test: citations link to existing branches and evidence cards.
- Integration test: a summary for a multi-branch thread covers at least 2 distinct branches.
- Latency test: summary generation completes within the configured time limit.
- E2E test: a reader can click a citation and navigate to the referenced content.

**Dependencies:** WS-G.1 (thread/branch/evidence schema), WS-K.1.1b (registered summarizer), WS-K.1.1f (output record), WS-K.1.2b (grounding/attribution gate), WS-K.1.4b (quality constraints).

**Observability:** Emit `summary.generated` with branch-coverage count and citation count; the attribution-failure rate feeds the hallucination dashboard (WS-K.1.2b).

**Security/privacy:** Summaries cite content already visible in the thread; they never surface private user data. The machine-generated label is persistent so readers always know the provenance.

---

### WS-K.1.4b Summarization quality constraints
**ID:** WS-K.1.4b
**Ref:** Sections 15.4, 24.3

**Description:**
Implement quality constraints for AI-generated summaries to ensure responsible representation of thread content (Section 24.3). Constraints:

- **Distinguish facts/claims/interpretations:** the summary must linguistically distinguish between established facts, disputed claims, and interpretations. Facts use declarative language; claims use attribution ("User X argues that..."); interpretations are labeled as such.
- **Preserve uncertainty:** the summary must preserve uncertainty and unresolved questions. Open questions are listed explicitly ("Unresolved: whether X is caused by Y"). The summary does not synthesize resolution where the thread has not reached one.
- **Include minority views:** the summary includes relevant minority viewpoints that add substantive information, even when the majority of thread participants hold a different view. Minority views are presented fairly, not dismissively (Section 15.4 "relevant minority views").
- **Avoid majority-as-truth:** the summary does not present the majority view as truth merely because it is common. Prevalence of a view is not evidence of its correctness.
- **Avoid synthesizing harassment/slurs:** the summary does not reproduce or synthesize harassment or slurs unnecessarily when representing hostile content (Section 24.3).

**Acceptance criteria:**
- Summaries distinguish facts, claims, and interpretations with different linguistic framing.
- Unresolved questions are listed explicitly in the summary.
- Minority views with substantive content are included.
- Majority views are not presented as truth solely due to prevalence.
- Summaries do not synthesize harassment or slurs unnecessarily.
- Quality constraints are tested against a labeled evaluation set.
- Summaries failing quality constraints are flagged for revision.

**Testing:**
- Unit test: a summary of a thread with a disputed claim uses attribution language, not declarative.
- Unit test: a summary of a thread with open questions lists them as unresolved.
- Unit test: a summary of a thread with a minority dissent includes the dissenting view.
- Unit test: a summary does not use language implying the majority view is correct.
- Unit test: a summary of hostile content does not reproduce slurs unnecessarily.
- Evaluation test: quality metrics on a labeled test set meet minimum thresholds.
- Integration test: a summary failing quality constraints is flagged in the review queue.

**Dependencies:** WS-K.1.4a (summary pipeline), WS-K.1.2b (consistency checks), WS-K.1.4c (revision/flag routing), WS-G (thread structure for branch/minority detection).

**Observability:** Emit `summary.quality.evaluated` with per-constraint pass/fail; a dashboard tracks the rate of summaries flagged for each constraint to detect model regressions in nuance handling.

**Security/privacy:** The no-slur-synthesis constraint prevents the summarizer from amplifying harassment; the minority-view and uncertainty constraints protect against majority-as-truth distortion, supporting epistemic safety.

---

### WS-K.1.4c Summary correction workflow
**ID:** WS-K.1.4c
**Ref:** Sections 24.3, 24.2

**Description:**
Implement the correction workflow for AI-generated summaries. The workflow enables users and stewards to report, correct, and improve summaries:

- **User reporting:** any user can report a summary as inaccurate, biased, or missing context. The report includes a reason (from a predefined list: factual error, missing context, bias, harmful content, missing minority view, fake citation) and optional correction text.
- **Steward correction:** stewards can directly edit the summary. Edits produce a new version; the original AI-generated version is preserved in version history. The steward-corrected version carries a "steward-corrected" label instead of "machine-generated."
- **Version history:** all summary versions (AI-generated, user-reported, steward-corrected) are preserved in an immutable version history with timestamps and editor identity.
- **Feedback loop:** reported and corrected summaries feed into the model improvement pipeline (WS-K.1.3c) and link back to the originating `AIOutputRecord` (WS-K.1.1f).

**Acceptance criteria:**
- Users can report summaries with a reason and optional correction text.
- Stewards can edit summaries, producing a new version.
- The original AI-generated version is preserved in version history.
- Steward-corrected summaries carry the "steward-corrected" label.
- Version history is immutable and includes timestamps and editor identity.
- Reported summaries enter the steward review queue.
- Corrections feed into the model improvement pipeline.

**Testing:**
- Unit test: a user report creates a report record with reason and optional correction.
- Unit test: a steward edit produces a new version and preserves the original.
- Unit test: version history includes all versions with correct metadata.
- E2E test: a user reports a summary, a steward reviews and corrects it, verify labels update.
- Integration test: a corrected summary feeds into the model improvement pipeline.
- Immutability test: an attempt to modify a historical version fails.

**Dependencies:** WS-K.1.4a (summaries), WS-J.2 (steward queue/permissions), WS-K.1.3c (feedback pipeline), WS-K.1.1f (output-record linkage), WS-G (summary attachment to threads).

**Observability:** Emit `summary.reported` and `summary.corrected` with reasons; a dashboard tracks report reasons (e.g., a spike in "fake citation") to prioritize model fixes.

**Security/privacy:** Version history is immutable and records editor identity for stewards; user reports do not expose the reporter's identity to other users. Corrections enter training only via the WS-K.1.3c privacy-reviewed lineage path.

---

## WS-K.2 Translation and AI around governance

### WS-K.2.1a Translation pipeline
**ID:** WS-K.2.1a
**Ref:** Sections 24.1, 15.5

**Description:**
Implement the translation pipeline for stories, contributions, and governance summaries. The pipeline produces translations carrying a persistent "AI-translated" label and always preserves access to the original text (Section 15.5 "translation with original text accessible"; Section 24.1 lists translation as a permitted AI use). Translations are subject to hallucination/consistency checks (WS-K.1.2b) so a translation does not introduce content absent from the source, and write an `AIOutputRecord` (WS-K.1.1f). The original text is always one tap away and is the canonical content; the translation never replaces or hides it.

**Acceptance criteria:**
- Translations carry a persistent, visible "AI-translated" label in UI and metadata.
- The original (source) text is always accessible from the translated view.
- The translation does not add content absent from the source (consistency-checked).
- The model version is logged with each translation (`AIOutputRecord`).
- Users can report a bad translation (routes to the correction workflow).
- The translation pipeline respects the bias audit's per-language results (low-quality language pairs are flagged).

**Testing:**
- Unit test: a translated item carries the "AI-translated" label and a link to the original.
- Unit test: a translation that introduces unsupported content is flagged by the consistency check.
- E2E test: a reader toggles between translation and original text.
- Integration test: reporting a bad translation creates a report in the correction workflow.
- Bias test: per-language quality from the bias audit is surfaced for the translation model.

**Dependencies:** WS-K.1.1b (registered translation model), WS-K.1.1f (output record), WS-K.1.2b (consistency check), WS-K.1.2a (per-language bias results), WS-K.1.4c (report/correction reuse), WS-G/WS-F (content to translate).

**Observability:** Emit `translation.generated` per language pair and `translation.reported` on user reports; a dashboard tracks per-language-pair volume and report rate, linked to the bias audit.

**Security/privacy:** The original text remains canonical and accessible, so a mistranslation cannot silently misrepresent a user's words. Translations of governance summaries are permitted (Section 24.5) but inherit the same labeling and original-access guarantees.

---

### WS-K.2.2a AI-around-governance permitted/prohibited enforcement
**ID:** WS-K.2.2a
**Ref:** Section 24.5

**Description:**
Implement the Section 24.5 permitted/prohibited matrix for AI around Knomosis governance as a concrete capability set wired into the prohibited-use guard (WS-K.1.1d). Permitted capabilities: summarize proposals in plain language; identify missing budget fields, citations, or unclear recipients; compare a proposal against the charter and law-pack template; highlight possible conflicts of interest for steward review; translate governance summaries; generate accessible explanations of treasury actions; detect scam-associated language patterns. Prohibited capabilities (blocked before execution): autonomous treasury execution; investment or personalized financial advice; manipulative voting recommendations; predictive profiling of user wealth or financial vulnerability; rewriting proposals to hide risk or recipient identity; using wallet wealth to personalize feeds. Every AI proposal summary shows citations to proposal fields, flags material uncertainty, and is editable/contestable by stewards.

**Acceptance criteria:**
- The seven permitted governance capabilities are implemented and available to stewards.
- The six prohibited governance capabilities are blocked by the prohibited-use guard before execution.
- Every AI proposal summary cites the specific proposal fields it draws from.
- AI proposal summaries flag material uncertainty explicitly.
- AI proposal summaries are editable and contestable by stewards (never final/autonomous).
- COI highlights and scam-pattern detection are advisory to stewards, never enforcement.

**Testing:**
- Unit test: a proposal summary cites proposal fields and flags uncertainty.
- Unit test: each permitted capability (missing-field detection, charter comparison, COI highlight, scam-pattern detection, governance-summary translation, treasury-action explanation) produces advisory output.
- Unit test: each prohibited capability (autonomous execution, investment advice, voting recommendation, wealth profiling, risk-identity rewrite, wealth-based feed personalization) is blocked.
- E2E test: a steward edits/contests an AI proposal summary; the edit is recorded and the summary is non-final.
- Audit test: a blocked governance capability is logged with the prohibition reason.

**Dependencies:** WS-K.1.1d (prohibited-use guard), WS-M.4 (proposals/charter/law-pack template), WS-M.1.3 (law-pack registry for charter comparison), WS-K.1.4c (steward edit/contest reuse), WS-K.2.1a (governance-summary translation).

**Observability:** Emit `governance.ai.summary.generated` (with cited-field count and uncertainty-flag presence) and `governance.ai.capability.blocked` (prohibited attempts); a governance dashboard tracks advisory output volume and any blocked-capability attempts.

**Security/privacy:** This task is the AI-side counterpart to the ranking pay-to-rank controls: it bars wealth profiling and wealth-based feed personalization, and bars rewriting proposals to hide risk/recipient identity from compliance — using the same pre-execution guard that cannot be bypassed. All governance AI output is advisory and contestable, never autonomous (Section 24.1, 24.5).

---

## Task dependency summary

| Task | Title | Depends on | Blocks |
|---|---|---|---|
| WS-K.1.1a | Model card schema | WS-H.1.2b, WS-K.1.1c/d/e | WS-K.1.1b, evaluation tasks |
| WS-K.1.1b | Model registry service | WS-K.1.1a, WS-K.1.1c, WS-K.1.2e, WS-D.1.6 | All deployments; WS-I.3.1g |
| WS-K.1.1c | AI inventory + NIST/ISO risk assessment | WS-A.1, WS-K.1.1b, WS-K.1.1d | WS-K.1.1a, WS-K.1.2a/e |
| WS-K.1.1d | Prohibited-use enforcement | WS-K.1.1c, WS-K.2.2a, WS-M, WS-N | WS-K.2.2a; all AI invocations |
| WS-K.1.1e | Data lineage tracking | WS-D.2, WS-K.1.3c, WS-K.1.1a | WS-K.1.2e, WS-K.1.3c (training) |
| WS-K.1.1f | Audit-sensitive output + version logging | WS-K.1.1b, WS-K.1.1e | WS-K.1.3*, WS-K.1.4*, WS-K.2.*, WS-P |
| WS-K.1.2a | Bias and subgroup audit | WS-K.1.1a/c, WS-K.1.2e, WS-K.1.1b | Deployment gate; WS-K.2.1a |
| WS-K.1.2b | Hallucination detection | WS-G, WS-K.1.3c, WS-K.1.2e, WS-K.1.2f | WS-K.1.4a, WS-K.2.1a |
| WS-K.1.2c | Safety/privacy test suite | WS-D.2, WS-J, WS-K.1.2e, WS-K.1.1b | Deployment gate |
| WS-K.1.2d | Red-team testing protocol | WS-K.1.2c, WS-K.1.1a/d, WS-K.1.2e | Deployment gate |
| WS-K.1.2e | Evaluation harness + deployment gate | WS-K.1.2a/b/c/d, WS-K.1.1b/c/e | All model deployments |
| WS-K.1.2f | Runtime AI monitoring | WS-K.1.1f, WS-K.1.2b, WS-K.1.1b, WS-K.1.3c | Rollback recommendations |
| WS-K.1.3a | Topic classification pipeline | WS-F.1, WS-A.1, WS-K.1.1b/f, WS-K.1.3c | WS-I.1, WS-I.2.4b |
| WS-K.1.3b | Claim extraction pipeline | WS-F.1, WS-G, WS-K.1.1b/f, WS-K.1.3c | Claim-evidence graph |
| WS-K.1.3c | Human-in-the-loop correction + feedback | WS-J.2, WS-K.1.3a/b, WS-K.1.1e/f, WS-D.2 | Model improvement; WS-K.1.2f |
| WS-K.1.4a | Summary generation | WS-G.1, WS-K.1.1b/f, WS-K.1.2b, WS-K.1.4b | WS-K.1.4c |
| WS-K.1.4b | Summarization quality constraints | WS-K.1.4a, WS-K.1.2b, WS-K.1.4c, WS-G | WS-K.1.4a publication |
| WS-K.1.4c | Summary correction workflow | WS-K.1.4a, WS-J.2, WS-K.1.3c, WS-K.1.1f, WS-G | Model improvement |
| WS-K.2.1a | Translation pipeline | WS-K.1.1b/f, WS-K.1.2a/b, WS-K.1.4c, WS-G/WS-F | Localized content; gov-summary translation |
| WS-K.2.2a | AI-around-governance enforcement | WS-K.1.1d, WS-M.4, WS-M.1.3, WS-K.1.4c, WS-K.2.1a | Governance AI features |

---

## Workstream definition of done

WS-K (AI) is complete when ALL of the following conditions hold:

1. **AI inventory and risk assessment:** A complete AI use-case inventory exists with NIST AI RMF / ISO 42001-aligned risk assessments and enforced human-oversight levels, including the AI-around-governance use case marked never-autonomous.

2. **Model cards:** Every AI model used in the platform has a complete model card documenting its purpose, training-data summary, data-lineage references, input/output schema, prohibited uses, known limitations, bias/safety/red-team evaluation results, risk-assessment reference, and owner. The model registry is the deployment chokepoint and preserves all versions.

3. **Evaluation before deployment:** A single evaluation harness orchestrates bias/subgroup audits, hallucination detection, safety/privacy tests, and red-team testing, and gates the registry so no model version deploys without passing (or documented-and-accepted) results. High/critical-risk use cases require the full evaluation set.

4. **Prohibited uses enforced:** Prohibited AI uses (autonomous treasury execution, investment/financial advice, manipulative voting recommendations, wealth-based profiling, risk-identity hiding) are blocked at the application layer by a pre-execution guard, with tests verifying enforcement. The Section 24.5 governance permitted/prohibited matrix is enforced by the same guard.

5. **Machine-generated labeling:** All AI-generated outputs (summaries, classifications, claim drafts, translations, suggestions) carry persistent, visible provenance labels in UI and metadata. Human revision upgrades labels (`user-edited`, `steward-confirmed`, `steward-corrected`); steward-corrected versions are distinct from machine-generated.

6. **Source citation, uncertainty, and minority views:** AI-generated summaries cite their source branches and evidence cards (verifiable links), distinguish facts/claims/interpretations, preserve uncertainty and unresolved questions, include relevant minority views, never present the majority view as truth by prevalence, and avoid synthesizing harassment or slurs unnecessarily.

7. **Data lineage and version logging:** Training/evaluation datasets have immutable lineage records (source, consent/license, transformations, privacy review); audit-sensitive outputs record model name, version, prompt template, and config hash via immutable `AIOutputRecord`s consumed by experiment logging and audits. User-derived feedback enters training only via a privacy-reviewed lineage path.

8. **Human-in-the-loop correction:** Low-confidence and user-reported AI outputs route to a steward review queue; corrections preserve the original, carry provenance, feed a privacy-reviewed model-improvement loop, and drive accuracy metrics (correction rate, agreement rate, per-category accuracy).

9. **Translation safety:** AI translations are labeled, keep the original text canonical and accessible, are consistency-checked against the source, are user-reportable, and surface per-language bias results.

10. **Runtime monitoring:** Deployed models are monitored at runtime (hallucination sampling, output/label drift, user-report rate) with owner alerts and human-approved rollback recommendations — never autonomous rollback.

11. **Observability:** Every pipeline and control emits structured telemetry (registry/deploy gating, evaluation runs, blocked invocations, classification/extraction/summary/translation rates, correction and report reasons, runtime drift, and governance AI advisory volume), feeding governance and quality dashboards.

12. **Server-hosted content scope (honest boundary):** All AI capabilities operate on server-hosted content only (`public_server`, `restricted_server`). `private_p2p` ("Private P2P room", WS-S) content is structurally out of reach for server-side AI — no classification, summarization, embeddings, or model-driven labeling — by the WS-S server non-storage contract (PRIVATE_SPEC §8); this is documented as a by-design property, not a gap. WS-R / LCAP-reconciled content is treated as canonical server content and processed normally after reconciliation. The reproducible-build / transparency-log trust plane that WS-S's private bundle depends on is owned by **WS-O** (WS-S.10; WS-O.3.2b/3.2e), not WS-K — distinct from this workstream's model-provenance logging.

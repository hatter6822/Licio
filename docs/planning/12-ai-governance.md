# WS-K. AI and Model Governance

**Milestone:** M3 | **Priority:** 3 | **Dependencies:** WS-G, WS-H | **Wave:** 5 | **Estimated duration:** 3 weeks

## Overview

Every AI model used in Licio has a model card, undergoes bias/safety evaluation, and has documented prohibited uses. AI outputs are labeled as machine-generated and are user/steward-editable. No autonomous treasury execution, no investment advice, no manipulative voting recommendations.

---

## WS-K.1 AI infrastructure

### WS-K.1.1a Model card schema
**ID:** WS-K.1.1a
**Ref:** Section 24.2

Define the model card schema for documenting every AI model used in Licio. The schema captures the information required for responsible AI governance, audit, and transparency. Fields:

- **name:** human-readable model name.
- **version:** semantic version string.
- **owner:** team or individual responsible for the model.
- **purpose:** what the model does in the product (e.g., "topic classification for story ingestion").
- **training_data_summary:** description of training data sources, size, temporal range, and any known gaps or biases in the training data. No raw training data is stored in the model card.
- **input_schema:** the structure and types of inputs the model accepts.
- **output_schema:** the structure and types of outputs the model produces.
- **known_biases:** documented biases identified through evaluation (e.g., "lower accuracy for under-represented languages," "overclassifies political satire as misinformation").
- **limitations:** documented limitations (e.g., "not trained on code-switching text," "accuracy drops below 80% for texts under 50 characters").
- **evaluation_results:** structured results from bias audits, accuracy benchmarks, safety tests, and red-team testing, with links to evaluation reports.
- **update_history:** changelog of model version updates with dates, descriptions of changes, and evaluation results for each version.

The schema is defined as a zod schema. Model cards are stored in the model registry and are queryable.

**Acceptance criteria:**
- Model card schema is defined with all listed fields.
- zod schema validates model cards at write time.
- All fields are required except known_biases and limitations (which default to "not yet evaluated" for new models pending evaluation).
- update_history is append-only -- previous entries cannot be modified.
- Model cards are queryable by name, version, purpose, and owner.

**Testing:**
- Unit test: valid model card passes schema validation.
- Unit test: model card with missing required fields is rejected.
- Unit test: update_history entries cannot be deleted or modified.
- Integration test: model card is persisted and retrievable by name and version.
- Snapshot test: schema changes are detected and require explicit review.

---

### WS-K.1.1b Model registry service
**ID:** WS-K.1.1b
**Ref:** Section 24.2

Implement the model registry service for managing AI model lifecycle. The registry supports:

- **Register:** add a new model with its model card. Registration requires a complete model card (WS-K.1.1a) and at least one evaluation result.
- **Version:** publish a new version of an existing model. Versioning requires updated evaluation results and a changelog entry. Old versions are preserved, not overwritten.
- **Lookup:** query models by name, version, purpose, or status. Returns the model card and current deployment status.
- **Deprecate:** mark a model version as deprecated with a deprecation reason and a recommended replacement version. Deprecated models emit warnings when queried, but remain queryable for audit.

The registry enforces that no model can be deployed to production without a model card and passing evaluation results. The registry API is access-controlled -- only AI team members can register/version/deprecate; all authenticated users can look up model cards.

**Acceptance criteria:**
- Models can be registered, versioned, looked up, and deprecated.
- Registration requires a complete model card and at least one evaluation result.
- Versioning preserves old versions and requires updated evaluations.
- Deprecated models emit warnings but remain queryable.
- No model can be deployed without a model card in the registry.
- Access control: register/version/deprecate restricted to AI team; lookup open to all authenticated users.

**Testing:**
- Unit test: register a new model with a valid card and evaluation results.
- Unit test: register without evaluation results is rejected.
- Unit test: version a model, verify old version is preserved.
- Unit test: deprecate a model, verify warning on lookup.
- Integration test: deploy pipeline checks the registry before deployment.
- Security test: non-AI-team user cannot register or deprecate models.

---

### WS-K.1.1c Use-case inventory
**ID:** WS-K.1.1c
**Ref:** Sections 24.1, 24.2

Document the complete inventory of AI use cases in Licio. Each use case has:

- **use_case_id:** unique identifier.
- **name:** human-readable name.
- **description:** what the AI does for this use case.
- **model_name:** which model(s) serve this use case (linked to the model registry).
- **risk_level:** low, medium, high, critical -- based on the potential impact of errors (per NIST AI RMF).
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

**Acceptance criteria:**
- All seven use cases are documented with risk levels and oversight requirements.
- Each use case links to the model(s) serving it in the registry.
- Risk levels are aligned with NIST AI RMF categories.
- Human oversight requirements are enforced by the system (e.g., toxicity triage cannot auto-enforce without human review).
- The inventory is version-controlled and updated when new AI use cases are added.

**Testing:**
- Unit test: each use case is present in the inventory with all required fields.
- Integration test: use case links resolve to valid models in the registry.
- Enforcement test: toxicity triage produces flags but does not auto-enforce without human review.
- Audit test: inventory version history is maintained.

---

### WS-K.1.1d Prohibited-use enforcement
**ID:** WS-K.1.1d
**Ref:** Section 24.5

Implement enforcement of prohibited AI uses. The system blocks AI from being used for:

- **Autonomous treasury execution:** AI cannot approve, execute, or initiate treasury transactions. All treasury actions require human approval with defined signing authority.
- **Investment advice:** AI cannot generate personalized financial recommendations, predict returns, or suggest specific financial actions.
- **Manipulative voting recommendations:** AI cannot recommend how users should vote on governance proposals, frame proposals to favor specific outcomes, or predict vote outcomes to influence participation.
- **Wealth-based profiling:** AI cannot use wallet balance, payment history, or treasury contributions to profile users, personalize content, or segment audiences.
- **Risk-identity hiding:** AI cannot be used to obscure, mask, or rewrite content to hide the identity of a risk actor (sanctions target, fraud suspect) from safety/compliance review.

Enforcement is implemented as a policy layer that intercepts AI model invocations and blocks requests matching prohibited-use patterns. Blocked requests are logged with the prohibition that was triggered.

**Acceptance criteria:**
- All five prohibited uses are defined and enforced.
- AI model invocations matching prohibited patterns are blocked before execution.
- Blocked invocations are logged with the prohibition reason.
- Treasury-related AI actions (summary, comparison) that are NOT autonomous execution are permitted.
- Governance summaries that inform without recommending are permitted.
- Prohibited-use definitions are version-controlled and require AI team + legal review to modify.

**Testing:**
- Unit test: attempt to invoke AI for autonomous treasury approval is blocked.
- Unit test: attempt to invoke AI for investment advice is blocked.
- Unit test: attempt to invoke AI for voting recommendations is blocked.
- Unit test: attempt to invoke AI for wallet-based profiling is blocked.
- Unit test: attempt to invoke AI to hide risk identity is blocked.
- Positive test: AI invoked for governance proposal summary (permitted use) succeeds.
- Positive test: AI invoked for treasury action explanation (permitted use) succeeds.
- Audit test: blocked invocations are logged with the correct prohibition reason.

---

### WS-K.1.2a Bias audit framework
**ID:** WS-K.1.2a
**Ref:** Section 24.2

Implement a bias audit framework for evaluating AI model performance across demographic subgroups. The framework tests model outputs for disparate performance across:

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

Results are stored in the model card's evaluation_results field. Models with disparities above a configurable threshold cannot be deployed until the disparity is addressed or explicitly accepted with documentation.

**Acceptance criteria:**
- Bias audit runs across all defined subgroup dimensions (language, region, topic, length, source type).
- Per-subgroup accuracy/quality metrics are computed and stored.
- Disparities above threshold block deployment.
- Accepted disparities are documented in the model card with justification.
- Audit results are linked to the model card's evaluation_results.
- The framework supports both automated metrics and human evaluation scores.

**Testing:**
- Unit test: audit correctly computes per-subgroup metrics from fixture data.
- Unit test: disparity above threshold produces a deployment-blocking result.
- Unit test: accepted disparity with documentation allows deployment.
- Integration test: audit results are persisted in the model card.
- Regression test: model version upgrade triggers a new bias audit.

---

### WS-K.1.2b Hallucination detection
**ID:** WS-K.1.2b
**Ref:** Sections 24.2, 24.3

Implement hallucination detection for AI models that generate text (summarization, claim extraction, translation). The detector compares AI outputs against source material and flags unsupported claims.

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
- Source grounding check identifies statements not supported by source material.
- Factual consistency check identifies contradictions with source material.
- Attribution verification confirms cited sources exist and are relevant.
- Hallucination rate is computed per model and tracked over time.
- Flagged hallucinations are routed to steward review.
- Runtime sampling rate is configurable (default: 10% of AI outputs).

**Testing:**
- Unit test: AI output with an unsupported claim is flagged.
- Unit test: AI output consistent with source material passes.
- Unit test: AI output with a fake citation is flagged.
- Integration test: flagged hallucination appears in steward review queue.
- Benchmark test: hallucination rate on a reference corpus is below the acceptable threshold.

---

### WS-K.1.2c Safety/privacy test suite
**ID:** WS-K.1.2c
**Ref:** Sections 24.2, 19

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
- Test suite runs automatically before any model deployment.
- Test failures block deployment.

**Testing:**
- Unit test: AI model given input with email/phone does not include it in output.
- Unit test: AI model given adversarial prompt does not generate harmful content.
- Unit test: AI model does not recall information from a previous invocation for a different user.
- Integration test: sensitive topic input produces output with safety disclaimer.
- CI gate: test suite runs and passes before model deployment proceeds.

---

### WS-K.1.2d Red-team testing protocol
**ID:** WS-K.1.2d
**Ref:** Section 24.2

Define and implement a red-team testing protocol for AI models before launch. The protocol covers:

- **Adversarial prompts:** test the model's response to inputs designed to produce prohibited outputs (jailbreaks, prompt injections, role-playing attacks).
- **Jailbreak attempts:** systematically test known jailbreak techniques against the model's safety guardrails.
- **Bias probing:** test the model with inputs designed to reveal biased behavior (e.g., changing only the demographic context of an input and comparing outputs).
- **Edge cases:** test with unusual, malformed, or boundary-condition inputs (empty input, very long input, mixed languages, code-switching, Unicode edge cases).

Red-team testing is required before:
- Initial deployment of any new model.
- Major version upgrades of existing models.
- Changes to model safety guardrails or filters.

Results are documented in the model card with findings, mitigations, and any accepted risks.

**Acceptance criteria:**
- Red-team protocol defines test categories: adversarial prompts, jailbreaks, bias probing, edge cases.
- Red-team testing is required before initial deployment and major version upgrades.
- Results are documented in the model card.
- Critical findings (model produces prohibited content) block deployment.
- Accepted risks are documented with justification.
- A minimum number of test cases per category is defined (configurable, default: 50 per category).

**Testing:**
- Process test: red-team testing is a required step in the model deployment pipeline.
- Documentation test: model card includes red-team results section after testing.
- Regression test: previously identified adversarial inputs are added to the automated test suite.
- Coverage test: minimum test case count per category is met.

---

### WS-K.1.3a Topic classification pipeline
**ID:** WS-K.1.3a
**Ref:** Section 24.1

Implement the topic classification pipeline for assigning topic labels to stories and content. The pipeline:

- **Multi-label assignment:** each story can have multiple topic labels (e.g., "climate," "policy," "local news"). Labels are assigned with confidence scores.
- **Confidence thresholds:** labels below the confidence threshold (configurable, default 0.7) are not applied automatically but may be suggested for user/steward review.
- **AI-classified label:** all automatically assigned topic labels carry a visible "AI-classified" marker in the UI and metadata. The marker distinguishes AI-assigned topics from user-selected or steward-confirmed topics.
- **Topic taxonomy:** the pipeline uses the platform's topic taxonomy (defined in WS-A), mapping model outputs to canonical topic IDs.

The pipeline runs during story ingestion (WS-F) and produces topic assignments that feed into candidate retrieval (WS-I.1) and feature computation (WS-I.2.1).

**Acceptance criteria:**
- Stories receive multi-label topic assignments with confidence scores.
- Labels below the confidence threshold are suggested, not applied.
- All AI-assigned labels carry the "AI-classified" marker.
- Model outputs map to canonical topic taxonomy IDs.
- Classification runs during ingestion and completes within the ingestion latency budget.
- Model version is logged with each classification for audit.

**Testing:**
- Unit test: story with clear topic signals receives correct labels above confidence threshold.
- Unit test: story with ambiguous topics receives labels below threshold as suggestions.
- Unit test: all AI-assigned labels carry the "AI-classified" marker.
- Integration test: classified topics feed into candidate retrieval correctly.
- Accuracy test: classification accuracy on a held-out test set meets the minimum threshold (configurable, default: 85% precision).
- Latency test: classification completes within the ingestion latency budget.

---

### WS-K.1.3b Claim extraction pipeline
**ID:** WS-K.1.3b
**Ref:** Section 24.1

Implement the claim extraction pipeline for extracting discrete propositions from story text. The pipeline:

- **Proposition extraction:** identify and extract individual claims, assertions, and propositions from story text. Each extracted claim is a standalone statement that can be independently verified, challenged, or supported with evidence.
- **AI-draft label:** all extracted claims carry an "AI-draft" label visible in the UI and metadata. The label indicates that the claim was extracted by AI and has not been reviewed by a human.
- **Editability:** extracted claims are fully editable by users and stewards. Users can correct, split, merge, or delete AI-extracted claims. Stewards can confirm, reject, or modify claims.
- **Source reference:** each extracted claim links back to the specific text passage it was derived from in the source story.

The pipeline runs during story ingestion and produces claim objects that feed into the evidence system (WS-G) and the claim-evidence graph.

**Acceptance criteria:**
- Claims are extracted as discrete, standalone propositions.
- Each claim carries the "AI-draft" label.
- Claims are editable by users and stewards.
- Each claim links to the specific source text passage.
- Extraction runs during ingestion and completes within the latency budget.
- Model version is logged with each extraction for audit.
- Over-extraction (splitting one claim into too many fragments) is controlled by a granularity parameter.

**Testing:**
- Unit test: story text with clear claims produces correct extractions.
- Unit test: all extractions carry the "AI-draft" label.
- Unit test: extractions link to the correct source text passages.
- E2E test: user edits an AI-extracted claim, verify edit persists and label changes to user-edited.
- E2E test: steward confirms a claim, verify label changes to steward-confirmed.
- Accuracy test: extraction quality on a labeled test set meets the minimum threshold.

---

### WS-K.1.3c Human-in-the-loop correction
**ID:** WS-K.1.3c
**Ref:** Sections 24.1, 24.2

Implement the steward review queue for AI classifications and extractions, with a feedback loop to improve model quality. The system:

- **Review queue:** AI-classified topics and AI-extracted claims that fall below a confidence threshold, or that have been reported by users, enter a steward review queue.
- **Correction workflow:** stewards can confirm, reject, or modify AI outputs. Corrections are persisted and the original AI output is preserved in version history.
- **Feedback loop:** confirmed and corrected outputs are collected as training/evaluation data for model improvement. The feedback data is:
  - Stored with provenance (which steward, when, what was changed).
  - Used for periodic model evaluation (measuring improvement over time).
  - Optionally used for model fine-tuning (with appropriate data governance and privacy review).
- **Metrics:** the system tracks AI accuracy over time using steward corrections as ground truth, producing: correction rate, agreement rate, accuracy trend, and per-category performance.

**Acceptance criteria:**
- Low-confidence and user-reported AI outputs enter the steward review queue.
- Stewards can confirm, reject, or modify AI outputs.
- Original AI output is preserved in version history after correction.
- Corrections are collected as feedback data with provenance.
- Feedback data is available for model evaluation.
- Accuracy metrics (correction rate, agreement rate) are computed and dashboarded.
- Feedback loop respects privacy (no user-identifying data in training sets without review).

**Testing:**
- Unit test: low-confidence classification enters the review queue.
- Unit test: steward correction persists and preserves the original.
- Unit test: correction data includes provenance (steward, timestamp, change).
- Integration test: correction rate metric is computed from accumulated corrections.
- Privacy test: feedback data does not include user-identifying information without explicit governance approval.
- Trend test: accuracy metrics trend upward after model updates using feedback data.

---

### WS-K.1.4a Summary generation
**ID:** WS-K.1.4a
**Ref:** Sections 15.4, 24.3

Implement automated draft summary generation for threads. The summary pipeline:

- **Automated draft:** generates a summary from the thread's branches, contributions, evidence cards, and context. The draft is the first layer of the three-layer summary system (automated draft, community synthesis, steward summary).
- **Machine-generated label:** every automated summary is labeled "machine-generated" in the UI and metadata. The label is persistent and visible to all readers.
- **Source citations:** the summary cites specific source branches and evidence cards. Each citation links to the referenced content. Citations are verifiable -- a reader can click through to the source.
- **Branch coverage:** the summary covers the main branches of the thread, including dissenting branches and minority viewpoints, not just the dominant discussion line.

**Acceptance criteria:**
- Automated summaries are generated for threads meeting a minimum activity threshold.
- All summaries carry the "machine-generated" label.
- Summaries cite source branches and evidence cards with links.
- Citations are verifiable (links resolve to existing content).
- Summaries cover multiple branches, not just the dominant line.
- Summary generation runs asynchronously and does not block thread rendering.
- Model version is logged with each summary for audit.

**Testing:**
- Unit test: summary generation produces output with citations from a fixture thread.
- Unit test: summary carries the "machine-generated" label.
- Unit test: citations link to existing branches and evidence cards.
- Integration test: summary for a multi-branch thread covers at least 2 distinct branches.
- Latency test: summary generation completes within the configured time limit.
- E2E test: reader can click a citation and navigate to the referenced content.

---

### WS-K.1.4b Quality constraints
**ID:** WS-K.1.4b
**Ref:** Section 24.3

Implement quality constraints for AI-generated summaries to ensure responsible representation of thread content. Constraints:

- **Distinguish facts/claims/interpretations:** the summary must linguistically distinguish between established facts, disputed claims, and interpretations. Facts use declarative language; claims use attribution ("User X argues that..."); interpretations are labeled as such.
- **Preserve uncertainty:** the summary must preserve uncertainty and unresolved questions. Open questions are listed explicitly ("Unresolved: whether X is caused by Y"). The summary does not synthesize resolution where the thread has not reached one.
- **Include minority views:** the summary includes relevant minority viewpoints that add substantive information, even when the majority of thread participants hold a different view. Minority views are presented fairly, not dismissively.
- **Avoid majority-as-truth:** the summary does not present the majority view as truth merely because it is common. Prevalence of a view is not evidence of its correctness.

**Acceptance criteria:**
- Summaries distinguish facts, claims, and interpretations with different linguistic framing.
- Unresolved questions are listed explicitly in the summary.
- Minority views with substantive content are included.
- Majority views are not presented as truth solely due to prevalence.
- Quality constraints are tested against a labeled evaluation set.
- Summaries failing quality constraints are flagged for revision.

**Testing:**
- Unit test: summary of a thread with a disputed claim uses attribution language, not declarative.
- Unit test: summary of a thread with open questions lists them as unresolved.
- Unit test: summary of a thread with a minority dissent includes the dissenting view.
- Unit test: summary does not use language implying the majority view is correct.
- Evaluation test: quality metrics on a labeled test set meet minimum thresholds.
- Integration test: summary failing quality constraints is flagged in the review queue.

---

### WS-K.1.4c Correction workflow
**ID:** WS-K.1.4c
**Ref:** Sections 24.3, 24.2

Implement the correction workflow for AI-generated summaries. The workflow enables users and stewards to report, correct, and improve summaries:

- **User reporting:** any user can report a summary as inaccurate, biased, or missing context. The report includes a reason (from a predefined list: factual error, missing context, bias, harmful content, missing minority view, fake citation) and optional correction text.
- **Steward correction:** stewards can directly edit the summary. Edits produce a new version; the original AI-generated version is preserved in version history. The steward-corrected version carries a "steward-corrected" label instead of "machine-generated."
- **Version history:** all summary versions (AI-generated, user-reported, steward-corrected) are preserved in an immutable version history with timestamps and editor identity.
- **Feedback loop:** reported and corrected summaries feed into the model improvement pipeline (WS-K.1.3c).

**Acceptance criteria:**
- Users can report summaries with a reason and optional correction text.
- Stewards can edit summaries, producing a new version.
- Original AI-generated version is preserved in version history.
- Steward-corrected summaries carry the "steward-corrected" label.
- Version history is immutable and includes timestamps and editor identity.
- Reported summaries enter the steward review queue.
- Corrections feed into the model improvement pipeline.

**Testing:**
- Unit test: user report creates a report record with reason and optional correction.
- Unit test: steward edit produces a new version and preserves the original.
- Unit test: version history includes all versions with correct metadata.
- E2E test: user reports a summary, steward reviews and corrects it, verify labels update.
- Integration test: corrected summary feeds into the model improvement pipeline.
- Immutability test: attempt to modify a historical version fails.

---

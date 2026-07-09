# AI and Model Governance — implementation reference (WS-K)

This is the implementation reference for **WS-K (AI and Model
Governance)**.  The design specification is SPEC Section 24 (AI/ML),
Section 24.3 (three-layer summaries), Section 24.5 (AI around Knomosis
governance), and Section 28.2 (experiment logging); the planning
document is `docs/planning/12-ai-governance.md`.

WS-K operationalises responsible-AI governance aligned to the **NIST AI
RMF** and **ISO/IEC 42001**: every AI model used in Licio has a model
card, undergoes bias/safety/red-team evaluation before deployment, has
documented prohibited uses enforced *before* execution, and produces
labelled, audit-logged, human-correctable output.  **At the platform
layer**, AI is never the sole authority for high-impact moderation and
never autonomously spends funds, approves proposals, or recommends votes
(Section 24.1/24.5).

> **Re-scoped by the AI-governed-rooms redesign (SPEC §24.6;
> `docs/planning/22-ai-governed-rooms.md`, WS-U).**  The platform-layer
> non-autonomy above is now **one layer** of a three-layer model.  WS-K
> becomes the platform-side **evaluation / transparency / prohibited-use
> substrate** that every *community-uploaded* room model must clear before
> a room may adopt it by member vote; the approved **in-room** agent is then
> *bounded*-autonomous (it may moderate, manage the room treasury, and
> facilitate lawmaking) **within community-voted, kernel-enforced limits,
> holding no keys, beneath the non-overridable platform legal floor.**  No
> shipped WS-K capability is removed; see WS-U for the runtime that consumes
> this substrate.

## Governance-over-models philosophy

Following the project's self-hosted/deterministic-provider posture (the
WS-F heuristic claim extractor, the WS-F deterministic embedding
providers), the **value of WS-K is the governance, not ML inference**.
The models WS-K governs are deterministic providers that carry full
governance identity (name, version, prompt-template id, config hash) and
pass through the same registry / evaluation / prohibited-use machinery a
real model backend would.  A production model backend swaps in behind the
identical governance surface without touching any governance code.  This
keeps the dependency budget intact (no ML libraries) and makes the whole
workstream deterministic and exhaustively testable.

## Architecture

```
AI inventory + NIST/ISO risk assessment (WS-K.1.1c)
  → model registry + model cards (WS-K.1.1a/b)
    → evaluation harness + deployment GATE (WS-K.1.2a-e)
      → prohibited-use guard (pre-execution) (WS-K.1.1d + WS-K.2.2a)
        → application pipelines (classify, extract, summarize, translate, govern)
          → human-in-the-loop correction + data lineage + AIOutputRecord logging
            → runtime monitoring (drift / report-rate / rollback recommendation)
```

### Package: `@licio/ai-governance`

Pure, browser-safe schemas + deterministic governance logic, no I/O — the
WS-K counterpart of `@licio/ranking` (it never imports `@licio/db`).
Consumed by both `apps/api` (the services) and `apps/web` (the provenance
labels).  Contents:

- **schemas** (`src/schemas/`, all zod + co-located types): model card,
  registry record, NIST/ISO risk assessment, AI inventory, prohibited-use
  vocabulary, data lineage, audit-sensitive output record, the four
  evaluation result types + the harness decision, the content-pipeline
  outputs, the structured summary draft + quality constraints, translation,
  correction/accuracy, the §24.5 governance matrix, and the provenance
  labels.
- **domain logic** (`src/`): the prohibited-use guard core
  (`evaluateInvocation` + the capability matrix), the bias/subgroup audit
  (two-proportion z-test, GWEI-style small-cohort protection), source-grounded
  hallucination detection, the safety/privacy suite, the red-team gate, the
  evaluation-harness selection/aggregation/decision, the §24.3 summary-quality
  constraints, the summary renderer, the label transition machine, the
  canonical inventory + risk assessments, accuracy metrics, and the
  canonical-JSON serializer used for config hashing.

### API: `apps/api/src/ai-governance/`

The injectable service container (the WS-E/F/G/H/I house pattern): in-memory
stores by default, a fail-closed `ai.*` runtime config, the prohibited-use
guard, the governed models, and a module singleton for routes.

- `stores.ts` — the store interfaces + in-memory adapters (registry, risk
  assessments, inventory, data lineage, output records, evaluations,
  corrections, blocked-invocation audit, AI review queue, summaries +
  reports, translations + reports, governance summaries, runtime
  metrics/alerts).  Append-only where the doctrine requires it.
- `registry.ts` — the model registry + the **deployment chokepoint**.
- `guard.ts` — the `ProhibitedUseGuard` (pre-execution; audits every block).
- `harness.ts` — the evaluation-harness orchestrator (persists the gate decision).
- `output-records.ts` — the immutable `AIOutputRecord` writer (server-side
  SHA-256 config hashing over the canonical serializer).
- `lineage.ts` — the data-lineage service (privacy-review precondition).
- `models.ts` — the governed deterministic models + the topic classifier +
  the translation-provider seam.
- `llm/` — the REAL model backends (WS-U ADR-9), both behind the unchanged
  registry/guard/output-record surface: `config.ts` (fail-closed enablement:
  explicit opt-in + per-backend requirements; off by default, honoured in
  every environment; the shadow-moderation on/off flag), `provider.ts` (the
  governed lawmaking summariser: guard → completion → zod → quality gate →
  `AIOutputRecord`, under a per-room budget + circuit breaker; the Anthropic
  SDK completion + the reusable budget/breaker/completion plumbing),
  `advisor.ts` (the slice-2 SCORE-BLIND shadow moderation advisor — a
  `toxicity_safety_triage` classifier that runs alongside the authoritative
  DSL to measure agreement, with no authority; guard → completion → zod →
  `AIOutputRecord` + a divergence row), `local.ts` (the loopback-only
  OpenAI-compatible local-runtime completion — llama.cpp server/Ollama/vLLM/LM
  Studio over plain fetch), `quality.ts` (the deterministic §24.5 summary
  acceptance gate), `registration.ts` (register + deploy both models through
  the REAL gate, one identity per backend per surface). The shadow divergence
  log is the in-memory `ShadowModerationStore` (`stores.ts`), read by the AI
  team at `GET /v1/ai/admin/governance/shadow-moderation/:roomId`.
- `seed.ts` — registers **and deploys** every governed model through the real
  gate; seeds risk assessments, lineage, and the inventory.
- `pipelines.ts` — topic classification + claim extraction (WS-K.1.3a/b).
- `summaries.ts` — AI summary generation + the §24.3 quality/grounding gate +
  reports (WS-K.1.4a/b/c).
- `translation.ts` — the translation pipeline (WS-K.2.1a).
- `correction.ts` — human-in-the-loop correction + accuracy metrics (WS-K.1.3c).
- `governance-ai.ts` — the §24.5 governance summaries + advisories (WS-K.2.2a).
- `runtime-monitor.ts` — runtime drift/report-rate alerts + rollback
  recommendation (WS-K.1.2f).
- `config.ts` / `metrics.ts` / `scheduler.ts` / `services.ts` / `wiring.ts` —
  the fail-closed config, the counters, the lease-guarded hourly tick, the
  container + singleton, and the deps-builders + the durable
  `content.normalized` classification consumer.

### Database: `packages/db/src/schema/ai-governance.ts` (migration `0034`)

Fifteen tables: model cards/registry, risk assessments, version-controlled
inventory, immutable append-only data lineage (with the §24.2 privacy-review
CHECK), audit-sensitive output records (SHA-256 config-hash CHECK), harness
evaluation decisions, corrections, the prohibited-use block audit, AI summary
drafts + reports, translations + reports, governance summaries, and runtime
metrics/alerts.  No foreign keys cross into the wallet context.

### Web: `apps/web/src/components/ai/AiLabel.tsx`

The reusable provenance badge that renders every AI artifact's persistent,
visible label (machine-generated, AI-classified, AI-draft, AI-translated, and
the human-revision upgrades), sourcing the vocabulary from
`@licio/ai-governance`.

## WS-K.1.1 AI infrastructure

- **Model card** (WS-K.1.1a) mirrors the WS-H `InvariantCard` conventions
  (owner, version, input/output schema, known failure modes).  No raw
  training data is stored on the card.  `known_biases`/`limitations` default
  to "not yet evaluated"; `update_history` is append-only (enforced at the
  registry boundary).
- **Registry** (WS-K.1.1b) is the deployment chokepoint: no model reaches
  `deployed` without a complete card, a passing harness decision, and a
  resolved risk assessment whose lineage refs resolve.  Old versions are
  preserved; register/version/deprecate/deploy are AI-team gated
  (`ai.model.manage` + MFA), lookup is open to all authenticated users.
- **AI inventory + risk assessment** (WS-K.1.1c): the eight §24.1 use cases,
  each with its risk level, enforced human-oversight posture, identified
  harms, affected populations (which drive bias-audit subgroup selection),
  and NIST/ISO control mappings.  Governance assistance is marked
  never-autonomous.
- **Prohibited-use enforcement** (WS-K.1.1d): the pre-execution guard blocks
  the five platform prohibitions — autonomous treasury execution, investment
  advice, manipulative voting recommendations, wealth-based profiling,
  risk-identity hiding — plus the §24.5 governance prohibitions, by capability
  classification AND structural defense-in-depth (autonomous effect, wealth
  signals, risk-identity masking).  Every block is audited.
- **Data lineage** (WS-K.1.1e): immutable append-only records; a usable
  user-derived dataset structurally requires a `privacy_review_ref` (schema
  refine + DB CHECK), the hard precondition for the fine-tuning path.
- **Audit-sensitive output logging** (WS-K.1.1f): every audit-sensitive output
  writes an immutable `AIOutputRecord` (model name/version, prompt-template id,
  SHA-256 config hash, input/output refs, use case, timestamp); the substrate
  Section 28.2 experiment logging consumes and the runtime monitor samples.

## WS-K.1.2 Evaluation + deployment gate

- **Bias/subgroup audit** (WS-K.1.2a): per-(dimension, subgroup) metrics with
  a two-proportion z-test; a disparity above threshold AND significant AND not
  documented-accepted blocks deployment.  Small subgroups are excluded
  (small-cohort protection).
- **Hallucination detection** (WS-K.1.2b): source grounding (content-token
  containment), factual consistency (numeric + negation-polarity
  contradiction), and attribution verification (citations must resolve).
- **Safety/privacy suite** (WS-K.1.2c): PII non-exposure, harmful-content,
  data-minimization (no cross-invocation leakage), sensitive-topic disclaimer.
  Failures always block (no acceptance override).
- **Red-team protocol** (WS-K.1.2d): four categories with a minimum case count;
  a critical finding always blocks; documented non-critical risks do not.
- **Harness + gate** (WS-K.1.2e): selects the required evaluation set by
  modality and risk (high/critical require the full set; an initial deploy /
  major upgrade forces red-team), aggregates, and produces a reproducible
  deploy/block decision the registry gate reads.
- **Runtime monitoring** (WS-K.1.2f): output-distribution/label-rate drift and
  user-report-rate alerts with a **human-approved** rollback recommendation —
  never autonomous rollback.

## WS-K.1.3 / 1.4 Pipelines

- **Topic classification / VALIDATION** (WS-K.1.3a, SPEC §24.1): the topic
  classifier is the trust gate for a story's topics. The author's picks arrive
  as UNTRUSTED `proposed_topic_ids`; `classifyStoryTopics` confirms each against
  the story's actual content (confidence ≥ threshold) — supported picks become
  the trusted `topic_ids`, unsupported picks are rejected to the review queue
  (flagged `rejected_author_proposal`), and the classifier's own high-confidence
  detections are added. Topic ids are canonical catalog UUIDs
  (`@licio/shared` `constants/topics.ts`, the classifier's keyword evidence
  SSOT); when nothing validates, the story carries the `UNCLASSIFIED` sentinel.
  Multi-label with confidence; AI-classified label; `AIOutputRecord`.
- **Claim extraction** (WS-K.1.3b): AI-draft propositions linked to their
  source passage.
- **Human-in-the-loop correction** (WS-K.1.3c): a steward confirm/reject/modify
  preserves the original, links the `AIOutputRecord`, and accumulates as
  feedback; accuracy metrics (correction/agreement rate, per-category) use
  stewards as ground truth; feedback enters training only via the
  privacy-reviewed lineage path.
- **Summarization** (WS-K.1.4a/b/c): a STRUCTURED draft
  (facts/claims/interpretations, explicit unresolved questions and minority
  views) gated by the §24.3 quality constraints AND source grounding — only a
  draft that passes both is published as the WS-G `automated_draft`
  (machine-generated, never final); a failing draft is withheld and routed to
  review.  Users can report a published summary.

## WS-K.2 Translation + AI around governance

- **Translation** (WS-K.2.1a): AI-translated label; the original (source_ref)
  stays canonical and accessible; a number-invariant consistency check (a
  translation may not invent a number absent from the source); idempotent;
  reportable.
- **AI around governance** (WS-K.2.2a): the seven §24.5 permitted capabilities
  (proposal summary citing fields + flagging uncertainty, missing-field
  detection, charter comparison, COI highlight, scam-pattern detection,
  governance-summary translation, treasury-action explanation), all advisory
  and steward-contestable; the six prohibited capabilities blocked by the same
  pre-execution guard.  Proposal DATA is supplied by the WS-M seam; the
  governance machinery is independent of WS-M's data model.

## Correctness & accountability invariants (enforced)

- **No model deploys without the gate.**  `deployModel` requires a card, a
  resolved risk assessment + lineage, and a `deploy` harness decision; the
  seed proves all five governed models pass it end to end.
- **A prohibited request never reaches a model.**  The guard runs before every
  invocation; `enforce` throws; every block is audited and counted.
- **Provenance only moves up.**  `applyLabelRevision` upgrades along the ladder
  (origin → user-edited → steward decision) and refuses to let a user edit
  downgrade a steward decision.
- **Append-only where it matters.**  Output records and data lineage never
  overwrite; the model card's `update_history` must extend the previous
  version's; the privacy-review precondition is a schema refine AND a DB CHECK.
- **A summary that fails quality or grounding is never published** — it is
  withheld and routed to steward review.
- **Rollback is recommended, never executed** (Section 24.1).

## Testing

- **`@licio/ai-governance`** (~13 suites): the prohibited-use guard (every
  prohibition blocked, permitted allowed, structural flags), the label ladder,
  the canonical inventory, the bias-audit math (normal CDF, two-proportion
  p-value, disparity gating, small-cohort), hallucination, the safety suite,
  red-team, the harness selection/decision/reproducibility, the §24.3 quality
  constraints, the summary renderer, accuracy, canonical JSON, and the schema
  refinements.
- **`apps/api`**: the governance backbone end-to-end (the seed deploys all
  five models through the real gate; registry gate rejections; the guard
  audit; output records + lineage), the application pipelines
  (classify/extract/summarize incl. publish + withhold-on-slur/translate/
  correct/govern/monitor), the route surface + auth gating, and the
  store/scheduler/runtime/wiring coverage seams.
- **`apps/web`**: the `AiLabel` provenance badge (every label, machine-vs-steward
  distinctness, assistive-tech description, axe).

## Production wiring (shipped)

- The container is constructed at boot (`index.ts`, `e2e-server.ts`) with the
  ingestion + forum seams injected; the config is reloaded; the governed models
  are registered and deployed through the gate; the singleton is set; the
  durable `content.normalized` classification consumer is registered; and the
  lease-guarded hourly scheduler runs (config reload, runtime monitor, accuracy
  recompute).
- The `ai.model.manage` RBAC capability (the AI team) + the `requireAiTeam`
  guard gate the model-lifecycle routes; the AI review queue is steward-gated.
- The DB schema + migration `0034` are in place.

## Residuals (tracked)

- **Gated Drizzle adapters for the WS-K stores.**  The schema + migration ship;
  the production Postgres adapters (mirroring the other workstreams'
  `drizzle-*-stores.ts`) are a mechanical follow-up.  Until they land, the
  in-memory stores serve every environment (the governance data is off the
  hot read path).  Closure target: WS-K production-binding pass.
- **Deeper client render-path integration.**  The `AiLabel` badge + the
  summary-report / translation request+report routes ship; wiring the badge and
  the report affordance onto the live summary/topic/claim/translation render
  surfaces (analogous to the WS-J "mount report/block on every contribution
  row" residual) is tracked here.  Closure target: WS-K.5 client pass.
- **WS-M proposal-data integration.**  The §24.5 governance machinery (guard,
  summaries, advisories) ships against a clean WS-M seam (the caller supplies
  proposal fields).  Wiring it to the real WS-M proposal/charter/law-pack model
  lands with WS-M.
- **A real model backend.**  **First one landed** (WS-U ADR-9, 2026-07): the
  LLM-backed governance summariser (`llm/`) swapped in behind the unchanged
  registry/evaluation/guard/output-record surface — hosted Anthropic API or a
  loopback-only local OpenAI-compatible runtime, advisory-only, fail-closed to
  the deterministic summariser, OFF by default behind an explicit operator
  opt-in (every environment, production included).  Remaining: the other
  governed surfaces (classification, thread summarisation, translation, triage)
  still run the deterministic providers, the admission harness still consumes
  the synthetic fixture set (the recorded-fixture LLM eval corpus is the WS-U
  slice-3 follow-up), and the LLM identities are not yet folded into the seed's
  `buildInventory` use-case map (the registry lists them; the inventory sweep
  is a mechanical follow-up).
- **WS-P experiment-log consumer.**  The `AIOutputRecord` substrate is the
  Section 28.2 source; the WS-P experiment-logging consumer reads it when WS-P
  lands.

## Server-hosted content scope (honest boundary)

Every WS-K capability operates on **server-hosted content only**
(`public_server`, `restricted_server`).  `private_p2p` (WS-S) content is
end-to-end encrypted and structurally out of reach of server-side AI (no
classification, summarization, embeddings, or model-driven labelling) by the
WS-S server non-storage contract (PRIVATE_SPEC §8) — a by-design property, not
a gap.  WS-R / LCAP-reconciled content is ordinary server content after
reconciliation and is processed normally.

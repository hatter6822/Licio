# Licio Transparency Dictionary

> Defines what Licio publishes, how it is privacy-protected, and what must **never** be
> optimized for. It keeps transparency reporting consistent, privacy-preserving, and
> aligned with the no-applause doctrine.

| Field | Value |
|---|---|
| **Document ID** | `TRANSPARENCY_DICTIONARY` |
| **Produced by** | WS-A.1.3a (product/safety), WS-A.1.3b (Knomosis), WS-A.1.3c (anti-metrics) |
| **Version** | 1.0.0 |
| **Owner** | Licio Maintainers — Doctrine & Policy Working Group |
| **Effective date** | 2026-06-08 |
| **Status** | Ratified (M0 doctrine gate) |
| **SPEC references** | §19.1, §28.1, §28.2, §28.3, §28.4, §17.12 |
| **Primary consumers** | WS-P (metrics, anti-metrics, transparency reports), WS-I (explanations) |

**Small-cell suppression (stated once, applied to every metric).** Any reported cell
whose underlying count is below the metric's privacy threshold is **suppressed** (not
published, not approximated). Metrics marked "aggregate only" never publish per-user
values. Reviewer and reporter identities are **never** published.

**Metric-ID convention.**

| Prefix | Class | Section |
|---|---|---|
| `TM-*` | Product-health / safety metric | WS-A.1.3a |
| `KM-*` | Knomosis governance/payment metric | WS-A.1.3b |
| `AM-*` | Anti-metric (never an optimization target) | WS-A.1.3c |

The canonical machine-readable enumeration at the end is the source of truth.

---

## WS-A.1.3a — Product-health and safety metrics (SPEC §28.1, §28.4, §19.1)

| Metric ID | Metric | Definition | Data source (responsible WS) | Privacy threshold |
|---|---|---|---|---|
| `TM-CPR` | Constructive-participation rate | Fraction of contributions classified constructive (evidence, correction, synthesis, bridge, question) | Contribution classifier (WS-K) | Min 100 contributions/period |
| `TM-SOR` | Source-open rate | Fraction of story views where the user opened the original source | Attention event pipeline (WS-E) | Min 1000 views/period |
| `TM-EAR` | Evidence-addition rate | Rate of evidence cards added per active thread | Evidence submissions (WS-F) | Min 50 threads/period |
| `TM-QRR` | Question-resolution rate | Fraction of clarifying questions receiving a substantive answer | Thread state tracker (WS-G) | Min 50 questions/period |
| `TM-MERI` | MERI distribution | Distribution of nonredundancy scores across feeds and topics | MERI service (WS-H.2) | Aggregate only; no per-user scores |
| `TM-SCOI` | SCOI reduction after bridge/synthesis | Change in obstruction score after bridge/synthesis contributions | SCOI service (WS-H.4) | Min 20 bridge events/period |
| `TM-MFCI` | MFCI incidents by severity | Count and severity distribution of coordination incidents | MFCI service (WS-H.3) | Aggregate only; no individual cases |
| `TM-GWEI` | GWEI cohort disparity | Structural experience parity across defined cohorts | GWEI service (WS-H.5) | Min 5 cohorts; none < 100 users |
| `TM-PHI` | PHI steering-risk distribution | Distribution of path-dependency risk scores | PHI service (WS-H.6) | Aggregate only; no per-user scores |
| `TM-HPL` | Harassment-protection latency | Time from harassment report to target protection | Safety queue logs (WS-J) | Aggregate; no individual case timing |
| `TM-AOR` | Appeal-overturn rate | Fraction of appeals resulting in reversal | Appeals system (WS-J.1.3) | Min 20 appeals/period |
| `TM-ADR` | Accessibility-defect rate | Accessibility regression defects per release | QA tracking (WS-B/WS-0) | Per release |
| `TM-CWV` | Core Web Vitals (LCP, INP, CLS) | Performance at p75 across real users | RUM / field data (WS-P) | Min 1000 page loads/period |

**Safety and moderation transparency breakdowns.**
- Moderation actions by category and severity, using the reason-code namespaces from
  `MODERATION_TAXONOMY.md` (WS-A.1.2a), aggregated; no individual cases below threshold.
- Appeal outcomes (overturn/uphold/modify) aggregated; **reviewer identities never published**.
- Coordinated-report incidents (count, share resolved as false positives) aggregated;
  **reporter identities never published** (privacy invariant; SPEC §25.5).

**Report cadence.** Product-health metrics: **monthly**. Safety and moderation metrics:
**monthly** (weekly internal review). Core Web Vitals: continuous monitoring, **monthly**
report.

---

## WS-A.1.3b — Knomosis governance and payment metrics (SPEC §28.3, §17.12)

These metrics measure **public value, not asset volume**, and each names the abuse it
guards against. They are published **only when Knomosis is enabled** (gated by the
`CRYPTO_FEATURE_MATRIX.md` tier posture); cadence **monthly**.

| Metric ID | Metric | Definition | Guards against |
|---|---|---|---|
| `KM-GRANT` | Public-value grant completion | Funded grants producing accepted evidence/context outputs | Treasury waste |
| `KM-TXCOMP` | Transaction comprehension | User-test success on transaction-preview meaning | Blind signing |
| `KM-TREASTRANS` | Treasury-transparency completeness | Treasury actions with clear proposal/recipient/amount/outcome | Dark-money governance |
| `KM-GOVDIV` | Governance diversity | Participation breadth across eligible civic accounts (not wallet wealth) | Capture |
| `KM-PROPDISP` | Proposal-dispute rate | Proposals challenged for conflict/fraud/policy | Unaccountable execution |
| `KM-FININC` | Financial-incident rate | Confirmed scams/fraud/mistaken transfers/compromise per active wallet | Unsafe expansion |
| `KM-P2RLEAK` | Pay-to-rank leakage | Measured correlation between payments and ranking after controls | Wealth-driven visibility |
| `KM-RECONGAP` | Treasury-reconciliation gap | Divergence between app ledger, Knomosis receipts, and L1 state | Must be zero or explained before expansion |

**Expansion-blocking semantics.**
- `KM-P2RLEAK` is the **published-metric counterpart of the neutrality suite** (WS-I.3):
  it measures residual correlation after controls and must trend to zero. A nonzero,
  unexplained value is an **expansion blocker**.
- `KM-RECONGAP` must be **zero or explained before any tier expansion** (SPEC §28.3;
  §17.11 production gates). A nonzero, unexplained reconciliation gap blocks promotion to
  the next crypto tier (`CRYPTO_FEATURE_MATRIX.md`).

---

## WS-A.1.3c — Anti-metrics and experimentation rules (SPEC §28.2, §28.3)

**Anti-metrics must never be used** as success criteria, growth KPIs, or optimization
targets. They encode the engagement-trap and speculation-drift patterns Licio rejects.

| Anti-metric ID | Anti-metric | Why prohibited |
|---|---|---|
| `AM-OUTRAGE` | Outrage engagement | Optimizing for emotional reactions rewards divisive over informative content |
| `AM-COMPULSION` | Compulsion metrics | Session length / return frequency / notification CTR as growth drivers create addiction |
| `AM-SPECULATION` | Speculation metrics | Token price / trading volume / speculative activity as health indicators |
| `AM-VANITY` | Vanity engagement | Follower / like / reaction counts / public karma as success metrics |
| `AM-TVL` | Total value locked | Treating TVL as success incentivizes accumulation over public value |
| `AM-TOKVOL` | Tokens traded | Trading volume is speculation, not public value |
| `AM-WALLETKPI` | Wallet connects as growth KPI | Wallet connections measure crypto adoption, not social value |
| `AM-PRICE` | Speculative price | Token/asset price as a health indicator incentivizes hype |
| `AM-TREASSTATUS` | Treasury size as status | Large treasuries are not inherently better; public-value output matters |
| `AM-VOTEVOL` | Vote volume without outcome quality | Raw governance participation without decision-quality measurement |
| `AM-ENGAGEONLY` | Engagement alone as success criterion | No launch may use engagement as the sole success metric |

**Experimentation rules (SPEC §28.2).**
- No experiment may introduce **likes, upvotes, public reaction counts, or follower
  leaderboards**.
- **Ranking experiments must include the full invariant-metric set** alongside any
  engagement metric: safety, **MERI** (`TM-MERI`), **MFCI** (`TM-MFCI`), **GWEI**
  (`TM-GWEI`), **SCOI** (`TM-SCOI`), and **PHI** (`TM-PHI`).
- Experiments optimizing attention must also monitor **wellbeing and participation
  quality**.
- Experiments on **minors or sensitive topics** require stricter review.
- All experiments have **rollback switches**.
- Major user-facing changes require **user notice**.
- Experiment logs **include invariant versions**.
- **No launch uses engagement alone as a success criterion** (`AM-ENGAGEONLY`).

**Enforcement and cadence.**
- Anti-metrics are reviewed **quarterly** to confirm none is being used as an optimization
  target; the review is **logged**.
- A change that would make any anti-metric a KPI requires **explicit maintainer rejection**
  and is recorded as a **doctrine violation**.

---

## Canonical machine-readable enumeration

> Validated by `scripts/check-policy.ts`: counts (13 `TM-*`, 8 `KM-*`, 11 `AM-*`), ID
> uniqueness and naming, privacy thresholds present, and expansion-blocking flags.

```json
{
  "document": "TRANSPARENCY_DICTIONARY",
  "version": "1.0.0",
  "product_health_metrics": [
    { "metric_id": "TM-CPR", "privacy_threshold": "Min 100 contributions/period", "cadence": "monthly", "responsible_ws": "WS-K" },
    { "metric_id": "TM-SOR", "privacy_threshold": "Min 1000 views/period", "cadence": "monthly", "responsible_ws": "WS-E" },
    { "metric_id": "TM-EAR", "privacy_threshold": "Min 50 threads/period", "cadence": "monthly", "responsible_ws": "WS-F" },
    { "metric_id": "TM-QRR", "privacy_threshold": "Min 50 questions/period", "cadence": "monthly", "responsible_ws": "WS-G" },
    { "metric_id": "TM-MERI", "privacy_threshold": "Aggregate only; no per-user scores", "cadence": "monthly", "responsible_ws": "WS-H.2" },
    { "metric_id": "TM-SCOI", "privacy_threshold": "Min 20 bridge events/period", "cadence": "monthly", "responsible_ws": "WS-H.4" },
    { "metric_id": "TM-MFCI", "privacy_threshold": "Aggregate only; no individual cases", "cadence": "monthly", "responsible_ws": "WS-H.3" },
    { "metric_id": "TM-GWEI", "privacy_threshold": "Min 5 cohorts; none < 100 users", "cadence": "monthly", "responsible_ws": "WS-H.5" },
    { "metric_id": "TM-PHI", "privacy_threshold": "Aggregate only; no per-user scores", "cadence": "monthly", "responsible_ws": "WS-H.6" },
    { "metric_id": "TM-HPL", "privacy_threshold": "Aggregate; no individual case timing", "cadence": "monthly", "responsible_ws": "WS-J" },
    { "metric_id": "TM-AOR", "privacy_threshold": "Min 20 appeals/period", "cadence": "monthly", "responsible_ws": "WS-J.1.3" },
    { "metric_id": "TM-ADR", "privacy_threshold": "Per release", "cadence": "per-release", "responsible_ws": "WS-B" },
    { "metric_id": "TM-CWV", "privacy_threshold": "Min 1000 page loads/period", "cadence": "monthly", "responsible_ws": "WS-P" }
  ],
  "knomosis_metrics": [
    { "metric_id": "KM-GRANT", "guards_against": "Treasury waste", "expansion_blocking": false },
    { "metric_id": "KM-TXCOMP", "guards_against": "Blind signing", "expansion_blocking": false },
    { "metric_id": "KM-TREASTRANS", "guards_against": "Dark-money governance", "expansion_blocking": false },
    { "metric_id": "KM-GOVDIV", "guards_against": "Capture", "expansion_blocking": false },
    { "metric_id": "KM-PROPDISP", "guards_against": "Unaccountable execution", "expansion_blocking": false },
    { "metric_id": "KM-FININC", "guards_against": "Unsafe expansion", "expansion_blocking": false },
    { "metric_id": "KM-P2RLEAK", "guards_against": "Wealth-driven visibility", "expansion_blocking": true },
    { "metric_id": "KM-RECONGAP", "guards_against": "Reconciliation divergence", "expansion_blocking": true }
  ],
  "anti_metrics": [
    { "anti_metric_id": "AM-OUTRAGE" },
    { "anti_metric_id": "AM-COMPULSION" },
    { "anti_metric_id": "AM-SPECULATION" },
    { "anti_metric_id": "AM-VANITY" },
    { "anti_metric_id": "AM-TVL" },
    { "anti_metric_id": "AM-TOKVOL" },
    { "anti_metric_id": "AM-WALLETKPI" },
    { "anti_metric_id": "AM-PRICE" },
    { "anti_metric_id": "AM-TREASSTATUS" },
    { "anti_metric_id": "AM-VOTEVOL" },
    { "anti_metric_id": "AM-ENGAGEONLY" }
  ]
}
```

---

## Changelog

| Version | Date | Author | Change | Sign-off |
|---|---|---|---|---|
| 1.0.0 | 2026-06-08 | Doctrine & Policy WG | Initial ratified dictionary: 13 product-health/safety metrics with privacy thresholds (WS-A.1.3a), 8 Knomosis metrics with expansion-blocking semantics for `KM-P2RLEAK`/`KM-RECONGAP` (WS-A.1.3b), 11 anti-metrics plus experimentation rules and quarterly enforcement (WS-A.1.3c). Small-cell suppression applied uniformly. | Reviewed and approved by Licio maintainer (M0 doctrine gate) |

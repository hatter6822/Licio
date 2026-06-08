# Licio Jurisdiction-Feature Matrix (Template)

> Template for mapping features, asset types, and capabilities to jurisdictions. It is
> the operational input for the jurisdiction policy engine (SPEC §17.10) that controls
> feature availability by region. The **default posture is crypto features disabled and
> fail-closed**: any jurisdiction not explicitly approved has crypto features turned off.
> Specific jurisdiction rows are populated by legal review (WS-N) and **require legal
> sign-off**; this document provides the canonical structure and exemplar rows.

| Field | Value |
|---|---|
| **Document ID** | `JURISDICTION_MATRIX` |
| **Produced by** | WS-A.2.1 |
| **Version** | 1.0.0 |
| **Owner** | Licio Maintainers — Doctrine & Policy Working Group |
| **Effective date** | 2026-06-08 |
| **Status** | Template ratified by maintainer (hatter6822) — 2026-06-08; populated rows require legal review |
| **SPEC references** | §17.10, §30.3-N |
| **Primary consumers** | WS-N (jurisdiction engine), WS-L/WS-M (feature gating), WS-D.1.7 (age gating) |

The cell vocabulary is **closed** so the jurisdiction engine consumes the matrix
deterministically. It must contain every default state used by
`CRYPTO_FEATURE_MATRIX.md` (WS-A.2.4). The canonical machine-readable enumeration at the
end is the source of truth.

---

## Columns — feature categories and sub-features

| Feature category | Sub-features |
|---|---|
| Core social | Story submission, reading, discussion, reporting, blocking, moderation |
| PWAtt ranking | Attention signals, participation signals, invariant services |
| Wallet connection | Link/unlink, address display, identity separation |
| Testnet transactions | Simulated proposals, fake-asset governance, preview signing |
| Production payments | Real-asset deposits, withdrawals, transfers |
| Treasury operations | Room treasuries, grants, bounties, payouts |
| Governance | Proposals, voting, delegation, law-pack migration |
| Age-gated features | Features requiring age verification (crypto, sensitive content) |

(8 feature categories.)

---

## Rows — jurisdiction fields

Each jurisdiction row carries these fields:

| Field | Description |
|---|---|
| `region_code` | ISO 3166-1 alpha-2; sub-national code where a state/province regime applies (e.g. `US-CA`) |
| `regulatory_framework` | Framework references (e.g. EU MiCA, US state-level MSB, Singapore PSA) |
| `legal_review_status` | One of `pending` \| `in-progress` \| `approved` \| `blocked` |
| `legal_review_date` | Date of legal review |
| `legal_reviewer` | Reviewer identity |
| `kyc_aml_triggers` | KYC/AML trigger conditions applicable in the region |
| `sanctions_posture` | Screening required? Restricted parties? |
| `age_assurance_requirement` | Age-assurance requirement |
| `tax_disclosure_requirement` | Tax-disclosure requirement |
| `consumer_risk_disclosure_requirement` | Consumer-risk-disclosure requirement |
| `disabled_region_fallback_ux_ref` | Reference to disabled-region fallback UX |
| `notes` | Notes and conditions |

---

## Cell values — closed vocabulary

Each cell is exactly one of the following, with an optional condition reference:

| Value | Meaning |
|---|---|
| `enabled` | Feature available in the region |
| `disabled` | Feature turned off (default for crypto features) |
| `simulated` | Off-chain, educational simulation only |
| `testnet` | Test assets only |
| `pending-legal` | Awaiting legal review before any enablement |
| `blocked` | Explicitly prohibited (compliance/sanctions) |

---

## Default posture per feature category

| Feature category | Default | Notes |
|---|---|---|
| Core social | `enabled` (globally) | Subject to content law |
| PWAtt ranking | `enabled` (globally) | |
| Wallet connection | `disabled` | Enabled per approved jurisdiction |
| Testnet transactions | `testnet` (approved test jurisdictions) / `disabled` elsewhere | |
| Production payments | `disabled` | Enabled only after legal approval |
| Treasury operations | `disabled` | Enabled only after legal approval |
| Governance | `disabled` (financial) / `enabled` (non-financial room governance) | |
| Age-gated features | `pending-legal` until age verification available | |

---

## Exemplar rows (illustrative — require legal review before activation)

| region_code | Core social | Wallet connection | Testnet transactions | Production payments | legal_review_status |
|---|---|---|---|---|---|
| `US-CA` | `enabled` | `pending-legal` | `disabled` | `pending-legal` | `pending` |
| `EU` (MiCA) | `enabled` | `pending-legal` | `testnet` | `pending-legal` | `in-progress` |
| `XX` (unknown) | `enabled` | `disabled` | `disabled` | `disabled` | `pending` |

The unknown/unapproved jurisdiction (`XX`) demonstrates the **fail-closed default**: core
social `enabled`, all crypto features `disabled`. No exemplar cell enables a feature that
`CRYPTO_FEATURE_MATRIX.md` gates behind an unmet requirement.

---

## Canonical machine-readable enumeration

> Validated by `scripts/check-policy.ts`: closed cell vocabulary, 8 feature categories,
> all required jurisdiction-row fields present, and that the vocabulary is a superset of
> the crypto-tier default states.

```json
{
  "document": "JURISDICTION_MATRIX",
  "version": "1.0.0",
  "cell_vocabulary": ["enabled", "disabled", "simulated", "testnet", "pending-legal", "blocked"],
  "legal_review_states": ["pending", "in-progress", "approved", "blocked"],
  "feature_categories": [
    { "id": "core-social", "name": "Core social" },
    { "id": "pwatt-ranking", "name": "PWAtt ranking" },
    { "id": "wallet-connection", "name": "Wallet connection" },
    { "id": "testnet-transactions", "name": "Testnet transactions" },
    { "id": "production-payments", "name": "Production payments" },
    { "id": "treasury-operations", "name": "Treasury operations" },
    { "id": "governance", "name": "Governance" },
    { "id": "age-gated-features", "name": "Age-gated features" }
  ],
  "jurisdiction_row_fields": [
    "region_code",
    "regulatory_framework",
    "legal_review_status",
    "legal_review_date",
    "legal_reviewer",
    "kyc_aml_triggers",
    "sanctions_posture",
    "age_assurance_requirement",
    "tax_disclosure_requirement",
    "consumer_risk_disclosure_requirement",
    "disabled_region_fallback_ux_ref",
    "notes"
  ],
  "crypto_feature_cells": [
    "wallet_connection",
    "testnet_transactions",
    "production_payments",
    "treasury_operations",
    "governance"
  ],
  "exemplar_rows": [
    {
      "region_code": "US-CA",
      "legal_review_status": "pending",
      "cells": {
        "core_social": "enabled",
        "wallet_connection": "pending-legal",
        "testnet_transactions": "disabled",
        "production_payments": "pending-legal",
        "treasury_operations": "disabled",
        "governance": "disabled"
      }
    },
    {
      "region_code": "EU",
      "legal_review_status": "in-progress",
      "cells": {
        "core_social": "enabled",
        "wallet_connection": "pending-legal",
        "testnet_transactions": "testnet",
        "production_payments": "pending-legal",
        "treasury_operations": "disabled",
        "governance": "disabled"
      }
    },
    {
      "region_code": "XX",
      "legal_review_status": "pending",
      "cells": {
        "core_social": "enabled",
        "wallet_connection": "disabled",
        "testnet_transactions": "disabled",
        "production_payments": "disabled",
        "treasury_operations": "disabled",
        "governance": "disabled"
      }
    }
  ]
}
```

---

## Changelog

| Version | Date | Author | Change | Sign-off |
|---|---|---|---|---|
| 1.0.0 | 2026-06-08 | Doctrine & Policy WG | Initial ratified template: 8 feature-category columns, 12 jurisdiction-row fields, closed 6-value cell vocabulary, crypto-disabled fail-closed default, and machine-readable exemplar rows whose composition is validated against the crypto-tier gates (no crypto cell `enabled` without `approved` legal review; core social always `enabled`). Composes without contradiction with `CRYPTO_FEATURE_MATRIX.md`. **Populated jurisdiction rows require legal-counsel review before activation.** | Template ratified by hatter6822 (maintainer), 2026-06-08; populated rows pending legal-counsel review |

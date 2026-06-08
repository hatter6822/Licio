# Licio Crypto Feature Availability Matrix

> The detailed, tier-by-tier view of the crypto columns in `JURISDICTION_MATRIX.md`. It
> encodes the MVP-to-production gating from SPEC §17.11 so **no tier is enabled before its
> gates are met**, and it is the operational expression of the **fail-closed crypto**
> invariant: the core social product never depends on crypto availability.

| Field | Value |
|---|---|
| **Document ID** | `CRYPTO_FEATURE_MATRIX` |
| **Produced by** | WS-A.2.4 |
| **Version** | 1.0.0 |
| **Owner** | Licio Maintainers — Doctrine & Policy Working Group |
| **Effective date** | 2026-06-08 |
| **Status** | Ratified by maintainer (hatter6822) — 2026-06-08 (M0 doctrine gate) |
| **SPEC references** | §17.10, §17.11, §25.6, §30.3-N |
| **Primary consumers** | WS-L/WS-M (Knomosis), WS-N (jurisdiction engine), WS-C.1.3 (default-off flags) |

**Tier-ID convention.** `CRYPTO_T0`–`CRYPTO_T4`. Default states use the closed cell
vocabulary defined in `JURISDICTION_MATRIX.md` so the jurisdiction engine consumes both
documents deterministically. The canonical machine-readable enumeration at the end is the
source of truth.

---

## Feature tiers (SPEC §17.10/§17.11 — distribution posture)

| Tier | Tier ID | Features | Default state | Enablement requirement |
|---|---|---|---|---|
| Tier 0: Education | `CRYPTO_T0` | Read-only Knomosis education, governance explainers | `enabled` (globally) | None |
| Tier 1: Simulation | `CRYPTO_T1` | Simulated governance, fake-asset proposals, preview signing | `disabled` | Product approval; no legal barrier |
| Tier 2: Testnet | `CRYPTO_T2` | Wallet link (nonce/signature), testnet proposals, testnet treasury | `disabled` | Product + security approval; test jurisdiction |
| Tier 3: Capped production | `CRYPTO_T3` | Real-asset deposits, capped grants, limited room governance | `disabled` | Legal approval, compliance controls, external audit, limited jurisdictions |
| Tier 4: Mature production | `CRYPTO_T4` | Expanded governance, delegation, law-pack migration, fork/exit | `disabled` | All Tier 3 plus operational track record, expanded legal review |

Only `CRYPTO_T0` is enabled by default; **`CRYPTO_T1`–`CRYPTO_T4` are disabled by default
(fail-closed)** and require explicit, gated enablement.

---

## Per-jurisdiction requirements for each tier

| Requirement | Tier 1 | Tier 2 | Tier 3 | Tier 4 |
|---|---|---|---|---|
| Legal review | Not required | Recommended | Required | Required |
| KYC/AML | Not required | Not required | Required where applicable | Required |
| Sanctions screening | Not required | Not required | Required | Required |
| Age verification | Not required | Required (18+) | Required (18+) | Required (18+) |
| Custody model approval | Not required | Not required | Required | Required |
| External security audit | Not required | Not required | Required | Required |
| Tax reporting setup | Not required | Not required | Required where applicable | Required |
| Consumer risk disclosures | Not required | Recommended | Required | Required |
| Transaction monitoring | Not required | Not required | Required | Required |
| Incident response plan | Not required | Recommended | Required | Required |

(10 per-tier requirements; all four crypto tiers ≥ Tier 1 represented.)

---

## Production real-funds gate checklist (SPEC §17.11 — all required before Tier 3)

A tier cannot be promoted while any gate is unmet. Represented as a per-tier checklist so
an environment cannot be promoted with an unmet gate:

1. Legal sign-off per jurisdiction
2. Custody model and partner contracts
3. AML/fraud/sanctions controls
4. Tax/accounting plan
5. External audit of contracts and deployment config
6. External audit of wallet flows and backend gateways
7. CI validation of Knomosis Lean/Solidity/Rust cross-stack fixtures
8. Reorg and reconciliation tests (cross-reference `KM-RECONGAP` must be zero or explained)
9. Disaster-recovery test
10. Bug bounty live
11. Tested incident runbook
12. Trained financial-support and T&S teams
13. Public risk disclosures
14. Tested rollback/freeze controls
15. Configured treasury limits
16. Verified region/age feature flags
17. Live monitoring dashboards
18. Approved pilot-room charters

Tier 4 additionally requires an **operational track record** and **expanded legal review**.

---

## Fail-closed behavior

- Jurisdiction status **unknown or pending** → crypto features `disabled`.
- Compliance check **fails** → crypto features `disabled` with user-facing explanation.
- Sanctions screening **unavailable** → crypto features `disabled`.
- Age verification **unavailable** → crypto features `disabled` for that user.
- Any **kill switch** engaged (wallet connect, payment-intent, action submit, treasury
  execution, governance voting; SPEC §25.6) → corresponding feature `disabled`.
- **Core social product** (reading, posting, discussing, reporting, blocking) **always
  remains available** regardless of crypto feature state (cross-cutting invariant 8; M6
  non-crypto-usability gate).

Every enumerated failure path resolves to `disabled`, and core social remains `enabled` in
all of them.

---

## Canonical machine-readable enumeration

> Validated by `scripts/check-policy.ts`: 5 tiers, `CRYPTO_T0`–`T4` naming, fail-closed
> default states (`CRYPTO_T0` enabled; `T1`–`T4` disabled), 10 per-tier requirements, and
> that every default state is a member of the `JURISDICTION_MATRIX.md` cell vocabulary.

```json
{
  "document": "CRYPTO_FEATURE_MATRIX",
  "version": "1.0.0",
  "tiers": [
    { "tier_id": "CRYPTO_T0", "name": "Education", "default_state": "enabled" },
    { "tier_id": "CRYPTO_T1", "name": "Simulation", "default_state": "disabled" },
    { "tier_id": "CRYPTO_T2", "name": "Testnet", "default_state": "disabled" },
    { "tier_id": "CRYPTO_T3", "name": "Capped production", "default_state": "disabled" },
    { "tier_id": "CRYPTO_T4", "name": "Mature production", "default_state": "disabled" }
  ],
  "per_tier_requirements": [
    "Legal review",
    "KYC/AML",
    "Sanctions screening",
    "Age verification",
    "Custody model approval",
    "External security audit",
    "Tax reporting setup",
    "Consumer risk disclosures",
    "Transaction monitoring",
    "Incident response plan"
  ],
  "core_social_independent": true
}
```

---

## Changelog

| Version | Date | Author | Change | Sign-off |
|---|---|---|---|---|
| 1.0.0 | 2026-06-08 | Doctrine & Policy WG | Initial ratified matrix: 5 tiers (`CRYPTO_T0`–`T4`) with fail-closed defaults, 10 per-tier requirements, SPEC §17.11 production-gate checklist blocking unmet promotions, and fail-closed behavior including kill-switch engagement with core-social independence. Default states drawn from the `JURISDICTION_MATRIX.md` cell vocabulary; tiers anchored to SPEC §17.11. | Reviewed and ratified by hatter6822 (maintainer), 2026-06-08 |

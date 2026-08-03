# Licio Privacy Regulation Mapping

> Maps privacy-regulation requirements to Licio's data-handling practices by jurisdiction.
> It ensures the platform's privacy controls (attention-signal handling, data retention,
> user rights, children's protections) comply with applicable regulations, and it is
> consistent with the attention-signal handling table (SPEC §19.2) and the on-chain
> minimization rules (SPEC §19.5).

| Field | Value |
|---|---|
| **Document ID** | `PRIVACY_REGULATION_MAP` |
| **Produced by** | WS-A.2.3 |
| **Version** | 1.0.0 |
| **Owner** | Licio Maintainers — Doctrine & Policy Working Group |
| **Effective date** | 2026-06-08 |
| **Status** | Ratified by maintainer (hatter6822) — 2026-06-08; **pending legal-counsel review** |
| **SPEC references** | §17.10, §19.1, §19.2, §19.3, §19.4, §19.5 |
| **Primary consumers** | WS-D.2 (privacy controls), WS-E.1 (event retention), WS-N (compliance) |

**Universal posture.** Licio **never sells attention data and never uses it for
behavioral advertising** — for any user, in any jurisdiction (SPEC §19.1). The canonical
machine-readable enumeration at the end is the source of truth for the data-handling
matrix and user-rights mapping.

---

## Regulation coverage

### GDPR (EU/EEA)

- **Legal basis:** legitimate interest for core social features; **consent** for
  personalized recommendations and attention-derived ranking.
- **Data-subject rights:** access, rectification, erasure, portability, restriction,
  objection.
- **Data minimization:** in-browser aggregation of attention signals; minimal raw event
  upload (SPEC §19.1, §19.2).
- **Retention limits:** documented retention tiers per data category; shortest feasible
  for raw event logs.
- **DPIA:** required for attention-signal processing and invariant services.
- **Right to explanation:** users can request meaningful information about ranking
  decisions (pairs with the Signal Ledger, WS-I.2.6).
- **Cross-border transfers:** data-localization requirements and transfer mechanisms.
- **DPO designation:** required if processing at scale.
- **Breach notification:** 72-hour supervisory-authority notification.
- **Children:** GDPR Article 8 age thresholds (13–16 by member state).

### CCPA/CPRA (California)

- **Consumer rights:** know, delete, opt-out of sale/sharing, correct, limit
  sensitive-personal-information use.
- **Sensitive personal information:** attention-derived inferences may qualify; purpose
  limitation applies.
- **Service-provider obligations:** contractual restrictions on data use.
- **Financial-incentive disclosure:** any feature differentiation based on data use must
  be disclosed. *(Note: Licio does not differentiate ranking by payment; this concerns
  data-use, not pay-to-rank.)*
- **Children:** COPPA for under-13; CCPA opt-in consent for 13–16.

### COPPA (US — children under 13)

- **Verifiable parental consent** before collecting personal information.
- **Data minimization** for children's data.
- **Retention limits:** delete when no longer needed for purpose.
- **No behavioral advertising to children** (Licio never does behavioral advertising for
  any user; SPEC §19.1).
- **Parental access and deletion rights.**
- **Posture:** the default product is **not directed to children under 13** (SPEC §19.4);
  any jurisdiction supporting younger users requires compliant parental consent; **minors
  are excluded from wallet/payment/treasury/governance features** (SPEC §19.4).

---

## Attention-signal handling (SPEC §19.2)

The default handling for each raw attention-signal type. This table reproduces SPEC §19.2
verbatim so the privacy controls (WS-D.2) and event-retention jobs (WS-E.1) implement
exactly the documented minimization posture. It is **consistent with** — and more granular
than — the per-jurisdiction matrix below, whose "Attention signals" row aggregates these.

| Data | Default handling |
|---|---|
| Raw scroll/touch events | Process in the browser; discard after feature extraction |
| Active dwell estimate | Upload aggregated per item/session with caps |
| Source opens | Upload event with item/source ID; no full browsing history outside the app |
| Context opens | Upload aggregate; used for ranking and UI improvement |
| Draft text | Stored locally (IndexedDB); synced encrypted if the user enables sync |
| Private saves | Private; low/no ranking effect unless the user opts into an aggregate signal |
| Sensitive-topic interest | Protected; shorter retention and stricter use limits |

## Per-jurisdiction data-handling matrix

| Data category | GDPR handling | CCPA/CPRA handling | COPPA handling |
|---|---|---|---|
| Attention signals (dwell, scroll) | In-browser processing; aggregate upload; consent for personalization | Right to know and delete; opt-out of sharing | Not collected for children |
| Participation signals (contributions) | Legitimate interest; retention per policy | Right to know and delete | Parental consent required |
| Account data (email, credentials) | Contract performance; access/portability/erasure | Right to know, delete, correct | Verifiable parental consent |
| Wallet data (addresses, transactions) | Consent; purpose limitation; separate from social identity | Right to know and delete; sensitive PI | Not applicable (minors excluded) |
| Moderation data (reports, actions) | Legitimate interest; limited retention; access with restrictions | Right to know with restrictions | Protective defaults apply |
| Minor-specific data | Article 8 age thresholds; protective defaults | CCPA opt-in for 13–16 | Full COPPA compliance |

(6 data categories — every category in SPEC §19.2 represented.)

---

## User-rights operationalization (SPEC §19.3, mapped to endpoints)

| User right | Endpoint / control |
|---|---|
| View Signal Ledger | `GET /v1/signal-ledger` (WS-D/WS-I) |
| Export account data | `POST /v1/privacy/export` |
| Delete attention history | `POST /v1/privacy/attention/delete` |
| Disable personalization / reset topic history / local vs server personalization / quiet hours / disable cross-device sync | `PATCH /v1/feed/preferences` and privacy settings (WS-D.2) |
| Request moderation data related to one's account (where legally feasible) | Support/privacy workflow |

---

## On-chain minimization (SPEC §19.5) cross-reference

The following are **never** placed on-chain: attention/reading/report history, private
moderation data, reporter identities, minors' data, sensitive inferences, device IDs, IPs,
private messages, and account-security events. Off-chain records with **on-chain hash
commitments** are used where auditability is needed; wallet addresses are treated as
personal data where applicable. Off-chain records can be deleted/anonymized, but public
chain records cannot be erased by Licio. This pairs with the **DAO-reveal override**
(`MOD_CRYPTO_DAOREVEAL` in `MODERATION_TAXONOMY.md`): no governance vote can compel
disclosure of reporter identities, private moderation data, or minors' data.

**Data-retention tiers** are referenced here and detailed in a separate counsel-approved
retention schedule; raw event logs use the shortest feasible tier.

---

## Canonical machine-readable enumeration

> Validated by `scripts/check-policy.ts`: 3 regulations, 6 data categories, user-rights
> endpoints present, and that the data-handling matrix covers each SPEC §19.2 category.

```json
{
  "document": "PRIVACY_REGULATION_MAP",
  "version": "1.0.0",
  "legal_review_status": "pending",
  "regulations": ["GDPR", "CCPA/CPRA", "COPPA"],
  "attention_signal_handling": [
    { "data": "Raw scroll/touch events", "default_handling": "Process in the browser; discard after feature extraction" },
    { "data": "Active dwell estimate", "default_handling": "Upload aggregated per item/session with caps" },
    { "data": "Source opens", "default_handling": "Upload event with item/source ID; no full browsing history outside the app" },
    { "data": "Context opens", "default_handling": "Upload aggregate; used for ranking and UI improvement" },
    { "data": "Draft text", "default_handling": "Stored locally (IndexedDB); synced encrypted if the user enables sync" },
    { "data": "Private saves", "default_handling": "Private; low/no ranking effect unless the user opts into an aggregate signal" },
    { "data": "Sensitive-topic interest", "default_handling": "Protected; shorter retention and stricter use limits" }
  ],
  "data_categories": [
    { "category": "Attention signals (dwell, scroll)" },
    { "category": "Participation signals (contributions)" },
    { "category": "Account data (email, credentials)" },
    { "category": "Wallet data (addresses, transactions)" },
    { "category": "Moderation data (reports, actions)" },
    { "category": "Minor-specific data" }
  ],
  "user_rights_endpoints": [
    { "right": "View Signal Ledger", "endpoint": "GET /v1/signal-ledger" },
    { "right": "Export account data", "endpoint": "POST /v1/privacy/export" },
    { "right": "Delete attention history", "endpoint": "POST /v1/privacy/attention/delete" },
    { "right": "Feed/privacy preferences", "endpoint": "PATCH /v1/feed/preferences" }
  ],
  "minors_excluded_from_financial_features": true,
  "never_sells_attention_data": true,
  "behavioral_advertising": false
}
```

---

## Changelog

| Version | Date | Author | Change | Sign-off |
|---|---|---|---|---|
| 1.0.0 | 2026-06-08 | Doctrine & Policy WG | Initial version: GDPR, CCPA/CPRA, COPPA mapped to 6 data categories; SPEC §19.2 attention-signal handling table (7 rows) reproduced and cross-validated; per-jurisdiction data-handling matrix; legal basis per activity; minor exclusion from financial features; user rights mapped to endpoints cross-validated against SPEC §23.2; SPEC §19.5 on-chain minimization restated and cross-referenced to the DAO-reveal override. | Ratified by hatter6822 (maintainer), 2026-06-08; **pending legal-counsel review** (per WS-A.2.3 acceptance criteria) |

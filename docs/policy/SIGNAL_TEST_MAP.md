# Licio Signal-to-Test Map

> The executable-contract layer between policy and engineering. For every prohibited
> signal in `SIGNAL_MATRIX.md` (WS-A.1.1b) there is a precise ranking-neutrality test
> specification **and** a mapping to the canonical engineering test ID in the
> verification suite (`WS-I.3.1*`). Reconciling the policy-side `RNT-NNN` identifiers
> with the engineering-side suite identifiers prevents the documentation and the tests
> from silently diverging.

| Field | Value |
|---|---|
| **Document ID** | `SIGNAL_TEST_MAP` |
| **Produced by** | WS-A.1.4 |
| **Version** | 1.0.0 |
| **Owner** | Licio Maintainers — Doctrine & Policy Working Group |
| **Effective date** | 2026-06-08 |
| **Status** | Ratified (M0 doctrine gate) |
| **SPEC references** | §13.6, §30.6 |
| **Primary consumer** | WS-I.3 (ranking-neutrality verification suite) |

The policy↔suite mapping is **bijective over the 14 prohibited signals**: each signal has
exactly one `RNT-NNN`, and each `RNT-NNN` maps to exactly one prohibited signal and one
canonical `WS-I.3.1*` suite test. The `(RNT, signal, suite)` triples here must match
`SIGNAL_MATRIX.md` exactly; `scripts/check-policy.ts` enforces this bidirectionally.

---

## Signal-level neutrality tests (one per prohibited signal — SPEC §13.6)

| Test ID | Suite test | Signal ID | Prohibited signal | Test method | Assertion |
|---|---|---|---|---|---|
| `RNT-001` | `WS-I.3.1a` | `SIG-PROH-LIKES` | Likes | Feed replay | Replay with/without a hypothetical like field yields identical ranking order |
| `RNT-002` | `WS-I.3.1a` | `SIG-PROH-UPVOTES` | Upvotes | Feed replay | Replay with/without a hypothetical upvote field yields identical ranking order |
| `RNT-003` | `WS-I.3.1b` | `SIG-PROH-REACT` | Hearts / reactions | Schema audit | No reaction-counter field exists in any ranking feature schema |
| `RNT-004` | `WS-I.3.1c` | `SIG-PROH-KARMA` | Public karma | Schema audit + feature inspection | No karma field readable by ranking; karma absent from PWAtt inputs |
| `RNT-005` | `WS-I.3.1c` | `SIG-PROH-FOLLOW` | Follower counts | Feature inspection | Follower count absent from PWAtt and all invariant joins |
| `RNT-006` | `WS-I.3.1c` | `SIG-PROH-DONOR` | Donor badges | Feature inspection | Donor status/badge absent from all organic feature schemas |
| `RNT-007` | `WS-I.3.1b` | `SIG-PROH-TOKBAL` | Token balances | Feature inspection | Token balance absent from PWAtt feature inputs |
| `RNT-008` | `WS-I.3.1b` | `SIG-PROH-PAYAMT` | Payment amounts | Feature inspection | Payment amount absent from all organic ranking features |
| `RNT-009` | `WS-I.3.1d` | `SIG-PROH-TREAS` | Treasury contributions | Integration test | Treasury contribution does not change story rank except via the manually approved public-interest prompt on a dedicated surface |
| `RNT-010` | `WS-I.3.1e` | `SIG-PROH-DAOVOTE` | DAO votes | Integration test | Governance vote outcomes do not change claim labels without evidence/steward process |
| `RNT-011` | `WS-I.3.1a` | `SIG-PROH-WALLET` | Wallet connection status | Feed replay | Replay for wallet-linked vs non-linked users yields identical ranking except user-selected treasury surfaces |
| `RNT-012` | `WS-I.3.1f` | `SIG-PROH-PAIDMEM` | Paid membership | Integration test | Paid membership does not bypass safety, rate limits, or moderation |
| `RNT-013` | `WS-I.3.1b` | `SIG-PROH-NFT` | NFT ownership | Feature inspection | NFT ownership absent from all ranking and recommendation feature schemas |
| `RNT-014` | `WS-I.3.1e` | `SIG-PROH-GOVOUT` | Governance vote outcomes | Integration test | Governance outcomes require evidence/steward review before any ranking effect |

### Per-test detail

Each test specifies **setup**, **assertion**, **frequency**, and **failure action**.
Test methods are one of: *feed replay*, *schema audit*, *feature inspection*, or
*integration test*.

- **`RNT-001` / `RNT-002` (feed replay, CI).** *Setup:* a fixed feed fixture and a
  recorded ranking decision log; inject a synthetic `likes`/`upvotes` field with varied
  values. *Assertion:* the ranked order is byte-identical to the control run. *Failure
  action:* **block merge.**
- **`RNT-003` (schema audit, CI).** *Setup:* enumerate every ranking feature schema.
  *Assertion:* no field semantically representing a reaction/heart counter exists.
  *Failure action:* **block merge.**
- **`RNT-004`/`RNT-005`/`RNT-006`/`RNT-007`/`RNT-008`/`RNT-013` (feature inspection,
  CI).** *Setup:* load the materialized PWAtt feature vector and the feature-store
  denylist (WS-I.2.1). *Assertion:* none of karma, follower count, donor badge, token
  balance, payment amount, or NFT ownership — **nor any feature derived from them** —
  is present or readable. *Failure action:* **block merge.**
- **`RNT-009` (integration test, pre-release).** *Setup:* stage treasury contributions
  against a story and run the ranker. *Assertion:* story rank is unchanged except through
  the opted-in, labeled public-interest prompt on the dedicated treasury surface (verified
  with `WS-I.3.1h`). *Failure action:* **block release gate.**
- **`RNT-010`/`RNT-014` (integration test, pre-release).** *Setup:* simulate DAO votes /
  governance outcomes. *Assertion:* no claim label or ranking effect occurs absent the
  evidence/steward process. *Failure action:* **block release gate.**
- **`RNT-011` (feed replay, CI).** *Setup:* identical users differing only by wallet-link
  status. *Assertion:* identical ranking except user-selected treasury surfaces. *Failure
  action:* **block merge.**
- **`RNT-012` (integration test, pre-release).** *Setup:* paid vs non-paid accounts hitting
  safety, rate-limit, and moderation paths. *Assertion:* paid membership grants no bypass.
  *Failure action:* **block release gate.**

---

## Suite-level tests (SPEC §30.6)

| Suite test | Name | Purpose | Frequency | Failure action |
|---|---|---|---|---|
| `WS-I.3.1g` | ML feature audit | Fails if wallet/token/payment/treasury fields are added to organic rankers without explicit approval | CI + post-release | Block merge; post-release page on-call (Critical incident) |
| `WS-I.3.1h` | Sponsored-content labeling | Sponsored/treasury-funded content is labeled and does not enter unpaid ranking | Pre-release | Block release gate |
| `WS-I.3.1i` | Public-explanation audit | Explanations state that payments are support/governance actions, not endorsements (shared prohibited-language denylist with UI copy) | Pre-release | Block release gate |
| `WS-I.3.1j` | Dashboard separation | Revenue/treasury metrics are separated from product-health metrics | Pre-release | Block release gate |

---

## Failure-action policy (stated once, applied per test)

- **CI-frequency** tests **block merge** on failure.
- **Pre-release** tests **block the release gate** on failure.
- **Post-release** tests **page the on-call owner and open an incident**; a confirmed
  financial-feature leak is a **Critical** incident (Risk Matrix: "Pay-to-rank leakage").

---

## Canonical machine-readable enumeration

> Validated by `scripts/check-policy.ts`: 14 signal-level tests + 4 suite-level tests;
> bijective `(rnt, signal, suite)` reconciliation against `SIGNAL_MATRIX.md`; every test
> names a frequency and a failure action.

```json
{
  "document": "SIGNAL_TEST_MAP",
  "version": "1.0.0",
  "signal_tests": [
    { "rnt_id": "RNT-001", "signal_id": "SIG-PROH-LIKES", "suite_test": "WS-I.3.1a", "method": "feed-replay", "frequency": "CI", "failure_action": "block-merge" },
    { "rnt_id": "RNT-002", "signal_id": "SIG-PROH-UPVOTES", "suite_test": "WS-I.3.1a", "method": "feed-replay", "frequency": "CI", "failure_action": "block-merge" },
    { "rnt_id": "RNT-003", "signal_id": "SIG-PROH-REACT", "suite_test": "WS-I.3.1b", "method": "schema-audit", "frequency": "CI", "failure_action": "block-merge" },
    { "rnt_id": "RNT-004", "signal_id": "SIG-PROH-KARMA", "suite_test": "WS-I.3.1c", "method": "feature-inspection", "frequency": "CI", "failure_action": "block-merge" },
    { "rnt_id": "RNT-005", "signal_id": "SIG-PROH-FOLLOW", "suite_test": "WS-I.3.1c", "method": "feature-inspection", "frequency": "CI", "failure_action": "block-merge" },
    { "rnt_id": "RNT-006", "signal_id": "SIG-PROH-DONOR", "suite_test": "WS-I.3.1c", "method": "feature-inspection", "frequency": "CI", "failure_action": "block-merge" },
    { "rnt_id": "RNT-007", "signal_id": "SIG-PROH-TOKBAL", "suite_test": "WS-I.3.1b", "method": "feature-inspection", "frequency": "CI", "failure_action": "block-merge" },
    { "rnt_id": "RNT-008", "signal_id": "SIG-PROH-PAYAMT", "suite_test": "WS-I.3.1b", "method": "feature-inspection", "frequency": "CI", "failure_action": "block-merge" },
    { "rnt_id": "RNT-009", "signal_id": "SIG-PROH-TREAS", "suite_test": "WS-I.3.1d", "method": "integration", "frequency": "pre-release", "failure_action": "block-release" },
    { "rnt_id": "RNT-010", "signal_id": "SIG-PROH-DAOVOTE", "suite_test": "WS-I.3.1e", "method": "integration", "frequency": "pre-release", "failure_action": "block-release" },
    { "rnt_id": "RNT-011", "signal_id": "SIG-PROH-WALLET", "suite_test": "WS-I.3.1a", "method": "feed-replay", "frequency": "CI", "failure_action": "block-merge" },
    { "rnt_id": "RNT-012", "signal_id": "SIG-PROH-PAIDMEM", "suite_test": "WS-I.3.1f", "method": "integration", "frequency": "pre-release", "failure_action": "block-release" },
    { "rnt_id": "RNT-013", "signal_id": "SIG-PROH-NFT", "suite_test": "WS-I.3.1b", "method": "feature-inspection", "frequency": "CI", "failure_action": "block-merge" },
    { "rnt_id": "RNT-014", "signal_id": "SIG-PROH-GOVOUT", "suite_test": "WS-I.3.1e", "method": "integration", "frequency": "pre-release", "failure_action": "block-release" }
  ],
  "suite_tests": [
    { "suite_test": "WS-I.3.1g", "name": "ML feature audit", "frequency": "CI+post-release", "failure_action": "block-merge+incident" },
    { "suite_test": "WS-I.3.1h", "name": "Sponsored-content labeling", "frequency": "pre-release", "failure_action": "block-release" },
    { "suite_test": "WS-I.3.1i", "name": "Public-explanation audit", "frequency": "pre-release", "failure_action": "block-release" },
    { "suite_test": "WS-I.3.1j", "name": "Dashboard separation", "frequency": "pre-release", "failure_action": "block-release" }
  ]
}
```

---

## Changelog

| Version | Date | Author | Change | Sign-off |
|---|---|---|---|---|
| 1.0.0 | 2026-06-08 | Doctrine & Policy WG | Initial ratified map: 14 signal-level neutrality tests (`RNT-001`–`RNT-014`) bijectively reconciled with `SIGNAL_MATRIX.md` prohibited signals and `WS-I.3.1*` suite tests, plus 4 suite-level tests (`WS-I.3.1g`–`j`). Per-test method/setup/assertion/frequency/failure-action specified. | Reviewed and approved by Licio maintainer (M0 doctrine gate) |

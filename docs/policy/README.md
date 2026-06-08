# Licio Policy & Doctrine Register (WS-A)

This directory holds the **doctrine, policy, and governance configuration** produced by
workstream **WS-A** (`docs/planning/02-doctrine-and-policy.md`). These documents are
**policy artifacts that constrain every subsequent implementation workstream**. No
ranking, moderation, governance, or financial code is written without them. Each document
exposes stable identifiers and a **canonical machine-readable JSON enumeration block** so
downstream workstreams cite signals, reason codes, roles, tiers, and metrics by
identifier rather than by prose.

## Document register

| Document | Produced by | Stable IDs | Primary consumers |
|---|---|---|---|
| [`SIGNAL_MATRIX.md`](./SIGNAL_MATRIX.md) | WS-A.1.1a–c | `SIG-ATT-*`, `SIG-PART-*`, `SIG-PROH-*`, `SIG-ANTI-*` | WS-E.2, WS-H, WS-I.2, WS-I.3 |
| [`MODERATION_TAXONOMY.md`](./MODERATION_TAXONOMY.md) | WS-A.1.2a–d | `MOD_*`, `MOD_CRYPTO_*`, `ROLE_*` (refs) | WS-J, WS-G.4, WS-P, WS-N |
| [`TRANSPARENCY_DICTIONARY.md`](./TRANSPARENCY_DICTIONARY.md) | WS-A.1.3a–c | `TM-*`, `KM-*`, `AM-*` | WS-P, WS-I |
| [`SIGNAL_TEST_MAP.md`](./SIGNAL_TEST_MAP.md) | WS-A.1.4 | `RNT-NNN` ↔ `WS-I.3.1*` | WS-I.3 |
| [`JURISDICTION_MATRIX.md`](./JURISDICTION_MATRIX.md) | WS-A.2.1 | closed cell vocabulary | WS-N, WS-L/WS-M, WS-D.1.7 |
| [`STEWARD_ROLES.md`](./STEWARD_ROLES.md) | WS-A.2.2 | `ROLE_*` | WS-J.2, WS-D.1, WS-O |
| [`PRIVACY_REGULATION_MAP.md`](./PRIVACY_REGULATION_MAP.md) | WS-A.2.3 | data categories, user-rights endpoints | WS-D.2, WS-E.1, WS-N |
| [`CRYPTO_FEATURE_MATRIX.md`](./CRYPTO_FEATURE_MATRIX.md) | WS-A.2.4 | `CRYPTO_T0`–`CRYPTO_T4` | WS-L/WS-M, WS-N, WS-C.1.3 |

## Cross-cutting doctrinal invariants

Every document upholds these non-negotiable invariants (SPEC references in each document):

1. **No applause primitives** — no likes/upvotes/hearts/karma/follower counts affect
   distribution (`SIGNAL_MATRIX.md` WS-A.1.1b).
2. **No pay-to-rank** — no payment/token/treasury/DAO/NFT/stake purchases distribution
   (`SIGNAL_MATRIX.md` denylist + `SIGNAL_TEST_MAP.md`).
3. **Notice and appeal for significant actions** (`MODERATION_TAXONOMY.md` WS-A.1.2c).
4. **Published support contact** reachable without authentication
   (`MODERATION_TAXONOMY.md` WS-A.1.2c notice-and-appeal requirements).
5. **Human review, not auto-removal, for policy-risk** (`MODERATION_TAXONOMY.md` WS-A.1.2b).
6. **MFCI base-rate conditioning** (`SIGNAL_MATRIX.md` anti-signals; MFCI-1/MFCI-2).
7. **Privacy by design** (`PRIVACY_REGULATION_MAP.md`; on-chain minimization).
8. **Fail-closed crypto** (`CRYPTO_FEATURE_MATRIX.md`; `JURISDICTION_MATRIX.md`).

## Validation

These documents are **continuously validated** by `scripts/check-policy.ts` (pure logic
in `scripts/policy/validate.ts`), which enforces the "Testing" assertions from the WS-A
plan at three levels:

1. **Intra-document** — coverage counts, ID disjointness and naming, severity↔SLA
   consistency, reason-code namespacing, the 6 moderation layers, aggregation-method
   presence, and prose↔machine-readable consistency (every ID in the canonical JSON block
   appears in prose, and vice versa).
2. **Cross-document** — the bijective `RNT ↔ signal ↔ suite` mapping between the signal
   matrix and the test map; appeal reviewers and moderation-layer roles resolving to
   defined steward roles; crypto-tier default states drawn from the jurisdiction cell
   vocabulary; jurisdiction exemplar rows respecting the fail-closed crypto gates.
3. **Against `SPEC.md`** — signal names (§5.3), steward roles (§16.3), moderation layers
   (§18.2), Knomosis metrics (§28.3), and attention-signal handling (§19.2) are checked for
   **set-equality** with the authoritative SPEC tables; policy categories (§18.1), crypto
   abuse modes (§18.5), product metrics (§28.1), prohibitions (§13.6), anti-metrics (§28.2/
   §28.3), the neutrality suite (§30.6), and crypto tiers (§17.11) are anchored by keyword;
   and cited API endpoints are verified to exist in §23.2. This pins the documents to their
   source of truth so doc-vs-SPEC drift fails the gate.

```sh
pnpm check:policy   # CLI gate (also runs in CI lint job + lefthook hooks)
pnpm test           # the `policy` Vitest project runs the same checks plus regression tests
```

A change to any document that breaks an invariant or a downstream contract fails the gate.
Amendments require a changelog entry and maintainer sign-off in the affected document.

# Privacy threat model — on-chain linkability and analytics joins

**Task:** WS-L.1.2e
**Status:** reviewed draft
**Date:** 2026-07-06
**Spec references:** SPEC §19.5, §17.1 (boundary 4), §17.3.1, §17.10, §21.5, §22.2, §23.4/§23.5, §25.6, §30.7
**Consumed by:** WS-L.2.5a–d (wallet endpoints, address minimization), WS-L.3.1b (gateway/compliance boundary), WS-N.2.2d (compliance privacy boundary)

## 1. Scope and threat premise

On-chain data can be copied, indexed, clustered, and linked to off-chain
identities by anyone, forever. A single field leaked on-chain cannot be
retracted. This model therefore treats the chain, every chain-analytics
provider, and every public Licio surface (room audit logs, public receipts,
governance tabs) as one adversarial join surface, and asks two questions:

1. Can any §19.5 "never on-chain" data element reach the chain or a
   chain-analytics provider through a WS-L code path?
2. Can an observer re-associate a pseudonymous wallet address with a Licio
   civic account by joining on-chain data against Licio's public or
   compromised surfaces?

The protected asset is the **wallet ↔ civic-account linkage**. Room-level
treasury transparency (which on-chain action belongs to which room) is
public **by design** (§17.3.3 public audit logs); *who* signed it is not.
Civic identity stays separate from wallet identity by default (§17.3.1):
account creation needs no wallet, the UI shows user-defined labels rather
than addresses, and no social surface renders wallet state.

## 2. The never-on-chain list and its WS-L leak surfaces

SPEC §19.5, verbatim: *"never place attention/reading/report history,
private moderation data, reporter identities, minors' data, sensitive
inferences, device IDs, IPs, private messages, or account-security events
on-chain"*.

For each item: the WS-L surface that could plausibly carry it toward the
chain or an analytics provider, and the control that prevents it.

| Never-on-chain item | WS-L surface that could leak it | Preventing control |
|---|---|---|
| Attention/reading history | Compliance/fraud screening calls (`CompliancePort`), gateway submissions, ranking-adjacent joins | `apps/api/src/knomosis/ports.ts`: `screenAddress` takes the address only; `fraudRisk` takes `{userId, actionType, amountMinorUnits}` — no attention/behavioral field exists on the seam (unit-tested field lists). `packages/db/src/isolation.ts` BFS proof: no SQL join path from `knomosis.*`/`wallet.*` to any attention/ranking table. |
| Report history | Fraud-queue context attached to a submission | Same `CompliancePort` shapes; WS-J moderation tables are not in the wallet context and no FK/view path connects them (`isolation.ts`, fail-closed classification via `assertContextsClassified`). |
| Private moderation data | Governance audit log / public receipt payloads | `apps/api/src/knomosis/receipts.ts`: public payload built from the explicit `PUBLIC_RECEIPT_FIELDS` allowlist (`action_type, room_id, asset, amount, tx_ref, state, created_at`) — tested as a key-subset assertion; moderation fields cannot appear. |
| Reporter identities | Challenge-window flags on proposals reaching on-chain state | Challenge/flag handling stays in WS-J stores (`public` schema); the `knomosis` schema has no reporter column and the signed typed-data structs (`packages/shared/src/knomosis/typed-data.ts`) have a closed field registry — an unregistered field fails `messageSchema.parse` in `assembleTransactionPreview` and preflight. |
| Minors' data | Wallet link / signing flows | Minors are excluded from wallet features (SPEC §19.4); wallet routes require an authenticated adult session and the WS-N jurisdiction port answers `unknown` fail-closed (`defaultCompliancePort.jurisdiction`), which real-fund preflight maps to rejection. |
| Sensitive inferences | Risk-state surfaces, analytics exports | `wallet-api.ts` `walletRiskStateResponseSchema` carries a coarse label + plain-language explanation only ("never raw sanctions/fraud internals"); `ports.ts` `walletRisk` returns the same coarse shape across the seam. |
| Device IDs | Signing/session context forwarded to the gateway | The gateway submission payload is the typed-data message + signature only (`knomosis.knomosis_action_record.signed_action`); typed-data structs contain no device field. §19.1 doctrine: no device fingerprinting anywhere in the API. |
| IPs | Compliance screening, rate limiting, region gating | §19.1 identity-free rate limiting: the API never reads the client network address (static test `no-client-address.test.ts`). Region for jurisdiction gating is the self-declared account locale subtag (`ports.ts` `createIdentityRegionResolver`, `localeRegionSubtag`) — never geolocation or IP. |
| Private messages | N/A in WS-L (no messaging surface) | No WS-L schema or store carries message content; `contract-signature` payloads are constrained to the registered typed-data fields. |
| Account-security events | Audit trails paired with on-chain actions | WS-D security events live in the identity audit log (`public` schema), which the isolation BFS proves unreachable from the wallet context except through the `public.users` articulation node (reached, never transited). Wallet-link audit entries carry the truncation only (`apps/api/src/knomosis/wallet.ts`, "The truncation only — never the full address"). |

Each row maps to a test obligation in WS-L.2/WS-L.3 (planning doc
acceptance): the `ports.ts` field-list unit test, the receipts allowlist
subset test, the isolation BFS + classification tests
(`packages/db/src/isolation.ts` consumed by the gated integration suite),
and the wallet-api "no full address / no seed-phrase field" schema test.

## 3. Linkage attacks

### 3.1 Address clustering

*An observer clusters on-chain addresses (common input ownership, funding
graphs, reuse across rooms) and then joins one clustered address to a
civic account via any Licio surface that exposes it.*

- **Likelihood:** high — clustering is commodity tooling.
- **Impact:** high — one successful join deanonymizes the whole cluster's
  Licio activity.
- **Mitigations:**
  - No Licio wire schema exposes a full address for a user wallet.
    `packages/shared/src/schemas/wallet-api.ts` is truncation-only
    (`address_truncated`, first-6+last-4; header invariant, unit-tested);
    `packages/shared/src/schemas/knomosis-api.ts` proposal-signature
    records carry an "opaque actor reference (wallet account id) — never
    an address". The only full addresses in the API contracts are
    platform contract/bridge addresses from the pinned manifest.
  - At rest, the wallet record stores the financial-domain HMAC + the
    truncation, never the full address
    (`apps/api/src/knomosis/stores.ts` `FinancialWalletRecord`;
    `drizzle-knomosis-stores.ts` persists the hash as bytea).
  - Full addresses exist server-side in exactly one place: the
    `signed_action` JSONB of `knomosis.knomosis_action_record`
    (`packages/db/src/schema/knomosis-gateway.ts`, migration
    `0059_ws_l_knomosis_gateway_wallets`) — the financial audit record of
    what the wallet actually signed. That table and
    `knomosis.wallet_actor_mapping` sit inside the knomosis bounded
    context; the `isolation.ts` BFS proof (`WALLET_CONTEXT_TABLES` seeds,
    `RANKING_CONTEXT_TABLES` targets, `public.users` as the sole
    non-transitable articulation node) proves no SQL join path connects
    them to any social/ranking table, so a database-level analytics query
    cannot cluster addresses against civic behavior.
  - Owner-scoped exposure only: the private receipt
    (`receipts.ts` `privatePayload.signed_fields`) carries the signed
    message for the owner's tax/accounting export; the public receipt
    never does.

### 3.2 Deposit/withdrawal timing correlation

*An observer correlates the timestamp of an on-chain treasury deposit or
payout with off-chain observable activity (a user posting in the room
minutes before, a public receipt's `created_at`) to bind a wallet to an
account.*

- **Likelihood:** medium — requires per-target effort but no privileged
  access.
- **Impact:** medium-high — probabilistic linkage, strengthened by
  repetition.
- **Mitigations:**
  - The correlation *base* is deliberately thin: no attention, reading,
    or dwell data is available to join against, on any plane —
    in-browser bucketing (`check:no-raw-egress`), the isolation proof,
    and the `CompliancePort` shapes remove the highest-resolution
    off-chain time series an analytics provider could buy.
  - Public receipts expose `created_at` at action granularity, no signer
    identity and no address (`PUBLIC_RECEIPT_FIELDS`); `tx_ref` is the
    typed-data hash, not an address.
  - Timelocks and challenge windows on material disbursements (§17.6,
    surfaced in the preview `timelock` field,
    `packages/shared/src/knomosis/preview.ts`) decouple approval time
    from execution time as a structural side effect.
  - Users are told before signing that the action is public, durable,
    and linkable (`PUBLIC_VISIBILITY_DISCLOSURE`, §3.4 below), so a user
    who needs unlinkability can use a dedicated wallet — supported by
    multi-wallet linking (§17.3.1).
  - **Tracked residual:** submission-time jitter/batching for treasury
    disbursements is a WS-M treasury-execution design item (WS-M
    planning; not a WS-L gateway control). Until then, timelocked
    execution is the only temporal decoupling.

### 3.3 Label leakage

*A user-defined wallet label ("main savings", a real name, an ENS-like
handle) leaks into a public surface or an on-chain memo and identifies
the person behind the address.*

- **Likelihood:** low-medium — requires a rendering or export mistake.
- **Impact:** high — labels are self-authored identity hints.
- **Mitigations:**
  - Labels are owner-scoped display data only: they live in
    `walletSummarySchema` (`wallet-api.ts`), which is returned solely on
    authenticated owner endpoints (`GET /v1/wallets`, link/label
    routes in `apps/api/src/routes/wallet.ts`).
  - Labels are not a typed-data field (`typed-data.ts` registry), so they
    structurally cannot be signed or submitted on-chain; the preview's
    `signed_fields` disclosure enumerates exactly the registered fields.
  - The public receipt allowlist (`PUBLIC_RECEIPT_FIELDS`) has no label
    field; the governance audit log stores action-typed entries, not
    wallet display metadata.
  - Per §19.5 users may hide labels; the honest limit is disclosed: the
    underlying on-chain activity remains externally observable
    regardless of the label setting.

### 3.4 Chain-analytics-provider enrichment

*A sanctions/fraud screening vendor (WS-N) enriches the addresses Licio
sends it with Licio-originated behavioral context, building a joint
wallet+civic profile outside Licio's control.*

- **Likelihood:** medium — vendors monetize enrichment by default.
- **Impact:** high — the join happens off-platform where Licio cannot
  audit or delete it.
- **Mitigations:**
  - The request shape is the control: `CompliancePort.screenAddress`
    (`apps/api/src/knomosis/ports.ts`) carries
    `{addressLower, deploymentId}` — the address only. `fraudRisk`
    carries `{userId, actionType, amountMinorUnits}` and no address, so
    no single vendor call carries both the civic identifier and the
    wallet address, and neither carries any attention/reading/behavioral
    field. A unit test asserts the field lists stay clean (WS-L.3.1b;
    SPEC §17.10 "risk checks that do not expose private attention
    behavior to chain-analytics providers").
  - Fail-closed defaults (`defaultCompliancePort`) mean an unconfigured
    or degraded vendor path yields `unavailable`/`unknown` → rejection
    for real funds — never a fallback that ships extra context to get a
    verdict.
  - **WS-N contract obligation (consumed checklist item):** the WS-N.2.2d
    vendor integration must (a) contract-prohibit retention/enrichment of
    screened addresses beyond the verdict, and (b) never widen the
    `CompliancePort` shapes. Widening the seam is the attack; the seam is
    the review boundary.

## 4. The off-chain-record-with-on-chain-hash-commitment pattern

Where auditability is needed without on-chain disclosure (§19.5), WS-L
commits a hash and keeps the record off-chain:

- The signed action's `payloadHash`/`typedDataHash`
  (`knomosis.knomosis_action_record`) are the on-chain-facing references;
  the full signed payload stays in the bounded-context JSONB.
- Public receipts reference `tx_ref = typed_data_hash` and pair the
  human-readable summary to the machine payload by hash
  (`pairSummaryToPayload`, defined in `preflight.ts` and applied by
  `receipts.ts`; verified by `verifyReceiptPairing`, §23.5).
- Law packs commit to off-chain documents by hash (§17.3.4
  "hash commitments to off-chain documents").

Rule for new fields: if a field needs on-chain auditability and is
personal data or §19.5-listed, the on-chain artifact is a salted/keyed
hash or a content hash of an off-chain record — never the field. Legal
review approves any exception per §19.5, before implementation.

## 5. Wallet addresses as personal data, and erasability

Wallet addresses are treated as personal data where applicable (§19.5):

- **Off-chain, deletable/anonymizable:** the wallet record holds only the
  financial-domain HMAC + truncation; unlink → cooling-off → finalize
  (`wallet-api.ts` unlink lifecycle) and the WS-D deletion pipeline
  (`apps/api/src/identity/privacy-jobs.ts`) govern off-chain erasure.
  The `signed_action` audit JSONB is retained under the counsel-approved
  financial retention schedule (§17.10) — a tracked WS-N retention item,
  not indefinite by default.
- **On-chain, not erasable:** public chain records cannot be erased by
  Licio. This is disclosed to every user **before signing**, on every
  action preview, as a constant the preview type cannot omit:
  `PUBLIC_VISIBILITY_DISCLOSURE` in
  `packages/shared/src/knomosis/preview.ts` — "This action will be
  recorded in the public audit log and on a public chain; on-chain
  records are durable and cannot be erased by Licio." The
  `TransactionPreview.public_visibility_disclosure` field is typed as
  `typeof PUBLIC_VISIBILITY_DISCLOSURE`, so a preview without the
  disclosure does not compile.

The HMAC domain separation is itself a linkage control: the same address
linked as an auth wallet (WS-D sign-in) and as a financial wallet yields
two non-correlatable hashes — `hashAuthWalletAddress` derives under
`KEY_DOMAINS.authWallet` (`licio:auth-wallet:v1`) and
`hashFinancialWalletAddress` under `KEY_DOMAINS.financialWallet`
(`licio:financial-wallet:v1`) (`apps/api/src/identity/siwe.ts`,
`apps/api/src/identity/crypto.ts`). A database-level join between the
identity and financial contexts on the hash column is therefore
cryptographically empty, over and above the schema isolation. Preflight
re-derives the financial hash to bind the signer to the selected linked
wallet (`apps/api/src/knomosis/preflight.ts`) without ever persisting the
address.

## 6. Small-cohort suppression for combined wallet+civic analytics

§19.5 requires small-cohort suppression on any analytics combining wallet
and civic activity. **Checklist value: n = 10.** Any aggregate, dashboard
cell, export row, or research-API response that joins wallet-context data
(balances, deposits, action counts, standing) with civic-context data
(membership, participation, room activity) must suppress cohorts of fewer
than 10 distinct accounts, with complementary suppression where a
suppressed cell is recoverable by subtraction.

Current state: **no combined wallet+civic analytics surface exists** —
the isolation proof makes the join impossible at the SQL layer, and the
ranking-firewalled standing client
(`apps/api/src/knomosis/standing.ts`) confines standing reads to the
knomosis context with a static import-graph test. The n=10 threshold
binds the future surfaces that will legitimately cross the boundary at
the application layer: the K5 privacy-preserving cross-room health
dashboards and aggregate governance-research API (SPEC §30.7). Tracked
residual: the suppression library + tests land with the first such
surface (WS-N/K5), gated on this checklist.

## 7. Privacy-controls checklist

Consumed by WS-L.2.5 (wallet endpoints), WS-L.3.1b (gateway/compliance
boundary), and WS-N (compliance privacy boundary). Each item is a release
gate for the surface named; "artifact" is the enforcing code or the
tracked residual.

| # | Control | Consumer | Artifact |
|---|---|---|---|
| 1 | No §19.5 never-on-chain field in any typed-data struct, gateway payload, or on-chain write | WS-L.3.1b | `packages/shared/src/knomosis/typed-data.ts` closed registry + strict `messageSchema` |
| 2 | Financial-domain HMAC for wallet addresses at rest; distinct from the auth domain; full address never stored on the wallet record | WS-L.2.5a | `identity/siwe.ts` `hashFinancialWalletAddress`; `identity/crypto.ts` `KEY_DOMAINS`; `knomosis/stores.ts` |
| 3 | Truncation-only wire schemas: no full user-wallet address, no seed-phrase/private-key field in any wallet/knomosis API shape | WS-L.2.5a–c | `schemas/wallet-api.ts` (+ schema unit test); `schemas/knomosis-api.ts` opaque actor refs |
| 4 | Address-bearing records (`signed_action`, `wallet_actor_mapping`) confined to the knomosis bounded context; no join path to ranking/attention/social tables | WS-L.2.5, WS-N | `packages/db/src/isolation.ts` BFS proof + fail-closed classification; migration 0059 soft refs |
| 5 | Compliance/fraud request shapes carry the address xor the user id, and never any attention/behavioral field | WS-L.3.1b, WS-N.2.2d | `knomosis/ports.ts` `CompliancePort` + field-list unit test |
| 6 | Vendor contracts prohibit retention/enrichment of screened addresses; seam widening requires privacy review | WS-N.2.2d | tracked residual — WS-N vendor onboarding gate (this document, §3.4) |
| 7 | Public receipts restricted to the explicit field allowlist; no civic identity, address, or label | WS-L.3.4c | `knomosis/receipts.ts` `PUBLIC_RECEIPT_FIELDS` + subset test |
| 8 | Pre-signing disclosure that the action is public, durable, and not erasable by Licio, on every preview | WS-L.2.6b | `shared/knomosis/preview.ts` `PUBLIC_VISIBILITY_DISCLOSURE` (type-mandatory field) |
| 9 | Wallet labels owner-scoped; never signable, never in public receipts or audit logs | WS-L.2.5c | `wallet-api.ts` owner endpoints; `typed-data.ts` registry; `receipts.ts` allowlist |
| 10 | Region/jurisdiction from self-declared locale only; no IP, no geolocation, no device ID anywhere in WS-L | WS-L.3.1b, WS-N | `knomosis/ports.ts` `createIdentityRegionResolver`; `no-client-address.test.ts` |
| 11 | Off-chain wallet records deletable/anonymizable (unlink lifecycle + WS-D deletion); financial audit retention per counsel schedule | WS-N | `wallet-api.ts` unlink contracts; `identity/privacy-jobs.ts`; tracked residual — WS-N retention schedule |
| 12 | Small-cohort suppression (n = 10, with complementary suppression) on any surface combining wallet and civic activity | WS-N, K5 surfaces | tracked residual — lands with the first combined surface (§6); until then the isolation proof forbids the join |
| 13 | Auditable-but-private fields go on-chain as hash commitments only; §19.5 legal review for any exception | WS-L.3.1b | `knomosis-gateway.ts` `payload_hash`/`typed_data_hash`; `receipts.ts` pairing |

Review: privacy owner + one security engineer (per WS-L.1.2e testing
requirements); re-review on any change to `CompliancePort`,
`PUBLIC_RECEIPT_FIELDS`, the typed-data registry, or the isolation
allowlists.

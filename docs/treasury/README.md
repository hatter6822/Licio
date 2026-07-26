# WS-M — Treasury and Governance: implementation reference

**Status: shipped** (2026-07-14) behind the fail-closed `cryptoEnabled` /
`governanceEnabled` flags.  This is the production application layer over the
shipped WS-L Knomosis gateway (`docs/knomosis/README.md`) and the WS-U
AI-governed-rooms runtime (`docs/governance/README.md`): room governance
lifecycle, charters, law-packs, the real-asset room treasury, payment intents,
production proposals with wallet-signed voting, grants, delegation, action
budgets, freeze/pause controls, treasury reconciliation, the accounting
export, and the hash-chained governance audit log.  The planning document is
`docs/planning/14-treasury-and-governance.md`; the design is SPEC §16.5, §17,
§22.2, §23.4.

Everything composes with — never parallels — the shipped substrate: the same
`knomosis` Postgres bounded context, the same EIP-712 typed-data registry and
verifiers, the same kill switches, the same fail-closed runtime flags, and the
WS-U `executeTreasuryAction` kernel as the ONLY fund-moving executor.

## Source layout

```
apps/api/src/treasury/
├── stores.ts                    -- 11 store interfaces + in-memory adapters that
│                                   emulate every DB unique/CAS (profiles, charters,
│                                   treasuries, reservations, intents, grants,
│                                   budgets, delegations, challenges, snapshots,
│                                   attestations)
├── drizzle-treasury-stores.ts   -- the gated Postgres adapters (23505-as-null on
│                                   the SAME uniques; CAS in WHERE; no in-memory state)
├── services.ts                  -- TreasuryServices container + the REAL port
│                                   builders (membership facts, the WS-U treasury
│                                   executor, forced steward elections) + singleton
├── audit-chain.ts               -- hash-chained audit writer/verifier (WS-M.6.1):
│                                   integrityHash = sha256(prev ‖ type ‖ details ‖
│                                   at ‖ room); fork-proof via partial uniques
├── profile.ts                   -- room governance profile + freeze/pause guards
│                                   (WS-M.2.4a: stewards freeze, platform unfreezes)
├── charter.ts                   -- WS-M.1.2a versioned plain-language charters
│                                   (8 required sections, readability heuristic,
│                                   sha-256 content hash, append-only)
├── law-packs.ts                 -- WS-M.1.3 registration (publish-immutable, fixtures
│                                   must pass), validation report, adoption pinning
├── readiness.ts                 -- WS-M.1.2d/e the 10-item live readiness evaluation
│                                   (requiredFor per target mode) + the FULL WS-M.1.1b
│                                   mode-transition edge table (CAS mode write,
│                                   emergency freeze, rollback + recovery edges) +
│                                   attestations (external audit = platform-only)
├── treasury.ts                  -- WS-M.2.1a real-asset treasury creation (platform-
│                                   address disjointness, per-asset decimals registry)
│                                   + the dashboard (LAST-RECONCILED balances only)
├── reservations.ts              -- WS-M.2.3a-1 category headroom (cap − consumed −
│                                   reserved, exact decimal math) + idempotent
│                                   reserve/consume/release
├── intents.ts                   -- WS-M.3.1 the 13-state payment-intent machine:
│                                   idempotent create vs in-flight-inclusive deposit
│                                   limits, fail-closed WS-N preflight, quote, signed/
│                                   attach, reconcile sweep (receipts at finality),
│                                   expiry, bounded retry
├── treasury-reconciliation.ts   -- WS-M.2.2 three-source reconciliation (intent
│                                   ledger / receipts / indexed events); "explained"
│                                   ONLY via settlement lag inside the grace window;
│                                   persistent gaps ⇒ divergent + freeze + alert
├── proposals.ts                 -- WS-M.4 the production lifecycle: create (mode gate,
│                                   steward-only types, budget charge, headroom +
│                                   sanctions preflight, deterministic idempotent id),
│                                   wallet-signed voting through the REAL WS-L
│                                   verifiers (eligibility → capped weight →
│                                   signature row with weight snapshot), deadline-
│                                   driven settlement + tally, challenges, execution
│                                   through the WS-U kernel executor
├── grants.ts                    -- WS-M.5.1a milestone grants (milestones sum EXACTLY
│                                   to the amount; review-gated; clawback = platform)
├── delegations.ts               -- WS-M.4.2c-3 one-active-delegation-per-scope
├── budgets.ts                   -- WS-M.3.2a whole-period integer refill + CAS charge
├── prohibited-targets.ts        -- fail-closed action-kind classifier (denylist +
│                                   per-type allowlist; unclassifiable ⇒ reject)
├── export.ts                    -- WS-M.5.2b versioned accounting export (settled
│                                   rows only; divergent assets excluded + counted)
└── scheduler.ts                 -- the WS-M sweeps on the lease-guarded knomosis tick

apps/api/src/routes/
├── treasury-governance.ts       -- the WS-M-only surface (~20 endpoints; see below)
└── room-governance.ts           -- the shipped WS-L.4 paths made MODE-AWARE: readiness
                                    (?target_mode + per-item checklist), the full mode
                                    machine, proposal create/list/execute + treasury
                                    read dispatch production vs simulated

packages/governance/src/         -- pure WS-M domain math (no I/O):
├── weight-resolver.ts           -- eligibility (fail-closed unknown facts for spends,
│                                   cooling-off, COI recusal) + capped voting weights
├── proposal-tally.ts            -- deadline-driven tally: quorum ≥ eligible × fraction
│                                   (inclusive), approve STRICTLY > decided × threshold
├── lifecycle.ts                 -- the 13-state payment-intent + 15-edge governance-
│                                   mode transition tables (pure data)
├── law-pack-validate.ts         -- structural + real-asset completeness validation +
│                                   canonical text/hash + fixture execution
├── action-budget.ts             -- whole-period integer refill math
└── decimal.ts                   -- exact decimal compare/add/sum/multiply (no floats)

packages/shared/src/schemas/treasury-governance-api.ts  -- the ~30 strict wire schemas
packages/shared/src/knomosis/assets.ts                  -- KNOMOSIS_ASSET_DECIMALS +
                                                           parseHumanAmountToMinorUnits
                                                           (client + server, one scale)
packages/db/src/schema/treasury-governance.ts           -- 13 enums + 11 tables
packages/db/drizzle/0082_ws_m_treasury_and_governance.sql -- the hand-authored migration

apps/web/src/components/treasury/  -- the member/steward surfaces (governance modal
                                      tabs + the room-header mode badge); see below
apps/web/src/lib/treasury-api.ts   -- one zod-validated client function per endpoint
apps/web/src/lib/wallet-signing.ts -- eth_signTypedData_v4 over the SHARED registry
```

## Route surface

`/v1/rooms/:roomId/…`, all flag-gated fail-closed (`governance` for reads and
governance writes, `crypto` additionally for fund movement), membership/
stewardship via the knomosis room port (404-over-403), platform staff = the
WS-J `restrict` capability:

| Path | What |
|---|---|
| `GET  governance/profile` | mode, law-pack, charter, freeze, pauses |
| `POST/GET governance/charter` | publish (steward) / history |
| `POST governance/law-packs/wsm` + `…/validate` + `…/:id/adopt` + `…/history` | register (publish-immutable) / dry-run / pre-enablement adoption (upgrades go through a `law_pack_upgrade` proposal) / history |
| `POST governance/attestations` | readiness attestations (external audit = platform) |
| `POST governance/freeze` / `pause` | a room's OWN steward freezes it; acting on a room you do NOT steward is the cross-room capability (`ROLE_INTEGRITY`, + counsel co-approval on `treasury` scope); ONLY platform unfreezes; per-operation pauses |
| `POST rooms/:id/treasury` + `GET …/dashboard` | real-asset treasury creation (steward) + reconciled dashboard |
| `POST/GET treasury/payment-intents(+/:id)` + `POST …/advance` | the WS-M.3.1 intent machine (advance: preflight/quote/signed/retry; quote returns the fee) |
| `GET treasury/grants` + review/milestones/clawback | grants (clawback = platform) |
| `POST governance/proposals/:id/sign` | wallet-signed vote/approval through the WS-L verifiers |
| `POST governance/proposals/:id/challenge` + `governance/challenges/:id/resolve` | member challenges; legal/capture resolutions = platform; the proposer never self-judges |
| `POST/GET governance/delegations(+/:id/revoke)` | scoped delegation |
| `GET treasury/export` | steward/platform accounting export (settled only) |
| `GET governance/audit-chain` | on-demand full-chain integrity verification |

Mode-aware extensions on the shipped paths (`room-governance.ts`):
`GET governance/readiness?target_mode=…` (per-item checklist + `required_for`),
`POST governance/mode` (the FULL WS-M.1.1b edge table with live readiness and a
CAS mode write), `POST/GET governance/proposals` and
`POST …/proposals/:id/execute` and `GET governance/treasury` all dispatch to
the production lifecycle in real-asset modes while `simulated` rooms keep the
untouched WS-L.4 practice surface.

## Web surfaces

Inside the existing room-governance modal (three new tabs, all fail-closed on
the `governanceEnabled` feature flag; treasury/proposals additionally require
a non-`ordinary` mode) plus the room header:

- `GovernanceModeBadge` — the server-derived §17.4 mode indicator (exhaustive
  label/tone/description SSOT in `mode-meta.ts`; changes announce via a polite
  live region).
- `GovernanceLifecyclePanel` — mode + description, `ReadinessChecklist` (live
  per-item pass/fail/not-applicable with `required_for`, steward transition
  request whose blocked outcome renders the server's live unmet list), the
  steward emergency freeze, and audit-chain verification.
- `TreasuryPanel` + `DepositFlow` — the mode-aware treasury view; the deposit
  flow walks intent → preflight → quote → the WS-L.2.6 full-disclosure preview
  → EIP-712 signature (`eth_signTypedData_v4` over the shared registry via
  EIP-6963 discovery) → the shipped WS-L action preflight + step-up-gated
  submit → intent attachment.  Amounts are exact decimal strings end to end
  (`parseHumanAmountToMinorUnits` rejects excess precision).
- `ProposalsPanel` — mode-aware list, the production create form (COI required
  for spends), the wallet-signed ballot with preview, challenges, and the
  steward execute trigger.

## Invariants the implementation enforces

1. **Fail-closed flags and compliance.** Every surface requires the live
   `governanceEnabled` flag; fund movement additionally requires
   `cryptoEnabled`.  The WS-N compliance seams answer unknown/unavailable and
   real-fund environments REJECT on those answers (local/testnet record and
   proceed, mirroring WS-L.3.1b).
2. **Exact math only.** Money and tallies are decimal strings through
   `@licio/governance` `decimal.ts` (compare/add/sum/mul) — no IEEE floats
   anywhere in the path, including the client's human-amount entry.
3. **Deadline-driven tallies.** A proposal resolves ONLY at its voting
   deadline: quorum is `distinctVoters ≥ eligibleCount × minFraction`
   (inclusive, exact), passage is `approve > decided × minAffirmativeFraction`
   (STRICT).  Early fraction-resolution is deliberately absent — later votes
   can flip a fraction.
4. **Reservation before execution.** A passed spend reserves headroom
   (`cap − consumed(window) − reserved`, one reservation per proposal by
   partial unique); execution consumes it; failure/upheld-challenge releases
   it.  The treasury dashboard shows last-RECONCILED balances only.
5. **One executor.** Every fund-moving execution routes through the shipped
   WS-U `executeTreasuryAction` kernel (caps/intervals/categories/timelocks/
   COI proof-carrying), closing the WS-U "missing production caller" residual.
   The agent/steward holds no keys; actions are wallet-signed via WS-L.
6. **Concurrency by construction.** CAS transitions (mode, intent states,
   voting state, execution claim/finalize) + partial unique indexes (one vote
   per user per proposal, nonce single-use, audit-chain parent/genesis
   uniqueness) make every race a clean loser, not a double-spend.
7. **Hash-chained audit.** Every governance action appends to the per-room
   chain; `GET governance/audit-chain` recomputes the whole chain (tamper,
   deletion-gap, and fork evidence) on demand — member-visible.
8. **Platform-moderation supremacy.** A room's OWN steward can freeze it — the
   self-protective stop; `ELECTED_ROOM_STEWARD` sits deliberately outside the
   platform `ROLE_*` namespace (STEWARD_ROLES.md).  Freezing a room you do NOT
   steward is the platform CROSS-ROOM capability and carries its full doctrine
   requirements: `ROLE_INTEGRITY` + verified MFA for `room-governance-freeze`,
   and additionally a distinct counsel co-approver (`compliance.counsel.approve`,
   resolved server-side and recorded in the chained audit as an opaque ref) for
   `treasury-freeze` — WS-A.1.2c.  `isPlatformStaff` alone is the WS-J `restrict`
   capability, i.e. ROLE_SAFETY, which is NOT sufficient for either freeze.  Only
   the platform legal floor unfreezes, resolves legal/capture challenges, attests
   external audits, and claws back grants.
9. **No pay-to-rank.** The treasury tables live in the isolated `knomosis`
   schema (soft room refs, `packages/db/src/isolation.ts` allowlist); nothing
   here feeds ranking.

## Operations

- **Sweeps** ride the lease-guarded knomosis scheduler tick behind the live
  governance flag: intent expiry, intent reconciliation (action states →
  intent states; receipts at finality), proposal settlement (deliberation →
  open → terminal tally + reservation; execution-window expiry), and treasury
  reconciliation per treasury.
- **Divergence** (a persistent inter-source linkage gap beyond the grace
  window) freezes the treasury, raises an alert, and excludes the asset from
  the accounting export until resolved.
- **Provisioning** a real-asset treasury is a steward API ceremony
  (`POST /rooms/:id/treasury`) against a pinned deployment; the web UI
  deliberately shows an honest empty state instead of a creation form.

## Testing

- `apps/api/src/__tests__/treasury-governance-{foundation,payments,proposals,routes}.test.ts`
  (69 tests: services + the mounted route surface with real sessions; proposal
  voting uses REAL viem EIP-712 signatures via the knomosis test helpers).
- `apps/api/src/__tests__/treasury-integration.test.ts` — the gated live-
  Postgres contract tests for all eleven Drizzle treasury stores plus the
  evolved chained-audit/casVotingState knomosis methods (CI runs them with
  service containers); `treasury-stores.test.ts` proves the SAME contract
  against the in-memory adapters, and `treasury-services.test.ts` covers the
  container port builders + the runWsmTick sweeps.
- `packages/governance/src/__tests__/` — the pure math (weights, tally,
  lifecycle tables, law-pack validation, budgets, decimals).
- `apps/web/src/components/treasury/*.test.tsx` + the extended
  `RoomGovernanceDialog.test.tsx` (38 tests incl. axe) and
  `packages/shared/src/__tests__/knomosis-assets.test.ts` (exact amount math).
- The migration was additionally validated end-to-end on a scratch Postgres
  with probe statements proving every trigger, CHECK, and partial unique bites.

## Residuals (tracked)

1. **WS-N compliance engine — CLOSED** (2026-07-15;
   `docs/compliance/README.md`).  The jurisdiction/sanctions/fraud seams are
   now the real WS-N engine: the payment-intent preflight gets real fraud
   verdicts (velocity + high-value review → the reserved `flagged` state and
   the compliance fraud queue), intent creation gates on acknowledged risk
   disclosures, and a `flagged`/`blocked` intent cannot transition to
   `quoted`/`signed`/`submitted` until released.  An UNCONFIGURED deployment
   keeps the previous everything-blocked real-funds posture — fail-closed is
   unchanged.  Remaining WS-N residuals (policy population, screening vendor,
   KYC partner) are tracked in `docs/compliance/README.md`.
2. **Delegation + grant-review web UI.** The API paths are live and tested;
   the web surface ships the transparency reads (grants list) but not yet a
   delegation management or grant-review form.  Closure: a WS-M.5 UI slice.
3. **Multisig signing ceremonies.** `proposalSignRequestSchema` accepts
   `purpose: 'multisig'` and the law-pack schema carries `multisigPolicy`;
   the m-of-n orchestration UI (WS-M.2.3b-2) is not yet built.
4. **On-chain execution binding.** Execution routes through the kernel and
   the WS-L submission pipeline; a capped/mature deployment with real value
   requires the WS-L residuals (external audit, cross-stack fixtures) to be
   closed first — those gates are owned by `docs/knomosis/README.md`.

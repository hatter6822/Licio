# WS-N — Compliance: implementation reference

**Status: shipped** (2026-07-15) — fail-closed by construction.  This is the
financial-compliance layer over the shipped WS-L Knomosis gateway
(`docs/knomosis/README.md`) and the WS-M treasury (`docs/treasury/README.md`):
the identity-free jurisdiction engine, sanctions screening, fraud/velocity
detection, the financial-compliance case system, SAR/STR records, the lawful
access process, risk disclosures, and compliance-grade retention.  The
planning document is `docs/planning/15-compliance.md`; the doctrine artefacts
are `docs/policy/JURISDICTION_MATRIX.md`, `docs/policy/PRIVACY_POLICY.md`, and
`docs/policy/CRYPTO_ASSET_POLICY.md`.

The load-bearing constraint is **SPEC §19.1 (identity-free service)**: the
platform never reads, logs, or hashes a client network address, and there is
no geo-IP anywhere (statically enforced by
`apps/api/src/__tests__/no-client-address.test.ts`).  Region is therefore
**declared, never detected** — the resolution ladder is
`verified_declaration → locale_subtag → unknown`, each carrying its `basis`,
and `unknown` fails closed for every real-funds surface.

## What consumes it

WS-N fills the `CompliancePort` seam that WS-L/WS-M shipped fail-closed stubs
for (`apps/api/src/knomosis/ports.ts`).  The shipped consumers were **not
modified** in their verdict semantics:

- `screenAddress` → `'clear' | 'blocked' | 'unavailable'` — WS-L submit
  preflight; `unavailable` rejects only real funds.
- `fraudRisk` → `'normal' | 'elevated' | 'blocked' | 'unavailable'` —
  `elevated` means **review required** and BOTH consumers honour it: a payment
  intent is held in the fraud queue (`payment_compliance_state = 'flagged'`),
  and a direct WS-L fund transfer (which has no intent to hold) is rejected
  pending the same review, at preflight **and** at the submit re-check. The
  review is a loop, not a dead end: the pattern case is idempotent per
  **attempt** (`reviewRef` — the payment-intent id, or the bound typed-data
  hash for a direct action), so once a reviewer resolves it `cleared` that
  attempt's retry returns `normal` and proceeds. The clearance covers only the
  attempt reviewed: a second transfer of the same amount is a different attempt
  with its own review, and a caller naming no attempt never gets the
  cleared-review exit.

  **One transfer, one review — across both legs.** An intent-backed transfer
  (`DepositFlow`) crosses the seam twice with different action types: the WS-M
  intent preflight checks it as `payment_intent:treasury_deposit`, then the
  WS-L action preflight/submit checks it as `treasury_deposit`. Both name the
  same attempt — the **intent** (`payment_intent_id` on the preflight/submit
  wire contracts, defaulting to the typed-data hash when there is no intent) —
  and the case key carries no action type, so the two legs land on ONE review.
  Keyed per leg they would not: a reviewer's release of the held intent would
  run straight into a second review at the WS-L leg that no fraud-queue action
  could clear, leaving released money stuck. Safety comes from the key's other
  parts, both server-derived: the *subject* (below) and the `amount` from the
  signed payload — so a client quoting someone else's cleared intent id lands on
  a different key and gets its own review.

  **`reviewSubject` — who the review is about, which is not always the caller.**
  A disbursement from a room treasury belongs to the **room**, not to whichever
  steward authorized it (the same rule the room-owned payout intent already
  states about itself). Attributed to the actor it would open a separate review
  per steward for ONE payout, and leave that review unfindable from the fraud
  queue — which knows the intent and its room, and never learns the steward.
  `reviewSubjectFor` derives it on the port both legs share, from the §22.2
  feature cell each already computes for its jurisdiction check
  (`ACTION_FEATURE_CELL` / `featureCellFor`): pay-in ⇒ the payer,
  `treasury_operations` ⇒ the room. One definition, so the two legs of one
  transfer cannot classify it differently and split its review in half.
  `userId` stays the **actor**, and the actor's **region** resolves from it (a
  room declares no jurisdiction; the human authorizing the movement does). The
  **velocity window follows the subject**: a room's payout stream is the room's,
  so per-steward buckets would hand each steward a fresh window over the same
  stream — rotate stewards, walk through the limit — and spend the steward's
  personal budget on the room's money besides.

  **A claimed `payment_intent_id` is a claim, not a fact.**  It buys the naming
  action a share of that intent's review, so unverified it is a clearance to
  steal: a member whose high-value intent for amount X was cleared could put
  that id on ANY later signed transfer of X and skip manual review — the case
  key names the same subject and amount, so `createCase` would hand the new
  transfer the old cleared case. Both WS-L legs therefore verify the intent IS
  this transfer: the caller's own (or their room's), this room, this asset, this
  amount, and still inside `PAYMENT_INTENT_TIMED_STATES` (the pre-submission
  window — past it the intent's action already exists, so naming it would
  resurrect a spent clearance) and unexpired. A mismatch is **rejected**, never
  silently dropped: dropping it would quietly split the transfer's review in
  two, the defect the id exists to prevent. The read crosses into WS-M, so it
  lives at the route composition layer, never inside the WS-L domain module.

  **A decision closes the review it decided.** The fraud queue's release/reject
  records the decision on the case chain **and** resolves the case (`cleared` /
  `restricted`) in one unit — it walks the sanctioned `CASE_TRANSITIONS` route
  to `resolved` rather than inventing an open→resolved edge, and never claims
  the counsel (`senior`) capability, because both routes are unguarded. It must
  close it for two reasons: `risk.ts` reads the **case**, not the intent's
  compliance column, so a still-open review would block the released deposit
  again at the WS-L leg; and a decided-but-open case would sit in the queue
  forever. Atomic in both directions — a chain fault leaves the case unmoved
  and the compensator puts the hold back rather than move funds unaudited, and
  a closure the state machine refuses aborts the unit rather than commit an
  entry recording a release that never took effect.
- `jurisdiction` → `'allowed' | 'blocked' | 'unknown'` — takes the
  `featureCell` the caller is about to exercise and the `asset` it would move.
  Every fund/action path passes both: the WS-L preflight, its submit re-check
  (a policy can change during the token TTL — that is what the re-check is
  for), and the WS-M intent preflight. A policy is **per-cell**, so a region
  enabling payments while disabling `governance` answers `blocked` for a
  `proposal_sign` (the region-wide reading would have said `allowed` off the
  payments cells), and demanding *both* real-funds cells would wrongly reject
  a deposit in a deposits-only region. `asset_flags` gates the asset
  **independently**: a barred asset is `blocked` however open its cell is, and
  an asset the region never approved is `unknown`. The region-wide reading
  survives for the one caller that wants it — the `jurisdiction_supported`
  readiness item, which genuinely asks whether a region is production-ready
  overall. `unknown` preserves the shipped testnet behaviour; `allowed`
  additionally requires a **verified** declaration basis.
- `walletRisk` — risk pins + open critical/high cases (wallet addresses are
  stored hashed; plaintext exists only at link time, which is why sanctions
  screening hooks `linkWallet` via `onSanctionedWalletLink`).

Two new gates were added at the consumer edge: the **disclosure-acknowledgment
gate** (`403 disclosure_ack_required` until every current counsel-published
version for the user's region is acknowledged) on BOTH first-financial-action
chokepoints — payment-intent creation and the WS-L `/actions/preflight` route
for fund-transfer actions, since a signed transfer can be minted without ever
passing through an intent, and **again at `/actions/submit`**, since a token
stays valid for its TTL and counsel can publish or bump a disclosure inside that
window (the same reason submit re-checks sanctions, jurisdiction, and fraud
rather than trusting the token) — and the **compliance-hold gate** in
`transitionIntent` (a `flagged`/`blocked` intent cannot reach
`quoted`/`signed`/`submitted` until released).

## Source layout

```
apps/api/src/compliance/
├── stores.ts                    -- store interfaces + InMemory adapters (policies,
│                                   policy/case audit chains, cases, declarations,
│                                   disclosures + acks, wallet pins, SARs, lawful-
│                                   access, velocity counters (BigInt), screening cache)
│                                   PLUS the ComplianceTransactor: the unit of work
│                                   every mutation runs in, so a change and its chain
│                                   entry commit together or not at all (the in-memory
│                                   adapter emulates it by snapshot/restore)
├── drizzle-compliance-stores.ts -- gated Postgres adapters (chain tip via
│                                   hash-NOT-IN-prev_hash, 23505-as-null idempotency,
│                                   the GUC-sanctioned retention delete)
├── redis-compliance-stores.ts   -- multi-instance velocity reserve (atomic Lua with
│                                   exact decimal-string addition — 18-decimal amounts
│                                   exceed 2^53 so Lua doubles are forbidden),
│                                   screening cache, policy-invalidation pub/sub
├── config.ts                    -- fail-closed `compliance.*` runtime config
├── region.ts                    -- WS-N.1.1b resolution ladder (declared, never
│                                   detected; basis-carrying)
├── policy.ts                    -- per-region policy activation + cache; a malformed
│                                   latest version means policy-MISSING for the
│                                   region (never fall back to an older version)
├── engine.ts                    -- WS-N.1.1c cell evaluation + availability +
│                                   the coarse jurisdiction verdict; the real-funds
│                                   cells' verified-basis requirement is hard-coded,
│                                   not configurable
├── screening.ts                 -- WS-N.2.2a HttpSanctionsProvider (full match →
│                                   blocked + critical case; partial → unavailable +
│                                   high case, short-TTL cache)
├── risk.ts                      -- WS-N.2.2b fraud verdicts: velocity reserve
│                                   (overcount-only fail-safe), high-value review
│                                   threshold, malformed-amount = blocked
├── wallet-risk.ts               -- pins + open-case projection → the port's verdict
├── cases.ts                     -- WS-N.2.1 case system: authoritative transition
│                                   table, idempotent creation, guarded actions
│                                   (critical_only / reason_required / senior),
│                                   legal hold
├── audit.ts                     -- hash-chained policy + case audit entries over
│                                   non-reversible actor refs (erasure-safe)
├── sar.ts                       -- WS-N.2.1e SAR/STR records (counsel-only READ —
│                                   anti-tipping-off; case audit shows only a neutral
│                                   legal_hold_applied)
├── lawful-access.ts             -- WS-N.2.3d intake/review/production; a private
│                                   P2P room forces the no-content-held
│                                   determination into the production summary
├── disclosures.ts               -- WS-N.1.2d versioned counsel disclosures +
│                                   audited acknowledgments + the fail-closed gate
├── retention.ts                 -- WS-N.3 retention sweep, erasure scrub (subject
│                                   refs nulled, chains never broken), event-tier
│                                   retention overrides
├── no-key-filter.ts             -- WS-N.2.3e: real BIP-39 wordlist (2048 words,
│                                   vendored as source — no dependency); ≥12
│                                   consecutive wordlist words or a BARE 64-hex
│                                   string blocks the support/report submission
├── bip39-english.ts             -- the wordlist artefact
├── services.ts                  -- container + port builders + availability
│                                   evaluation + DSAR export/purge hooks + singleton
├── scheduler.ts                 -- lease-guarded retention/SLA sweeps
└── __tests__/                   -- foundations, engine, screening, velocity,
                                    cases, fail-closed matrix

apps/api/src/routes/compliance.ts -- /v1/compliance/*: the user surface
                                    (availability, region, declaration, disclosures),
                                    the compliance-role console (cases, fraud queue,
                                    declarations verify, policies, config), and the
                                    counsel surface (SAR, lawful access, disclosure
                                    publishing).  The factory's return type is
                                    INFERRED — annotating it erases the route types
                                    from AppType and breaks the typed web client.
apps/api/src/lib/hash-chain.ts   -- the generic chain engine (append with retry,
                                    verify) extracted from the WS-M treasury chain
                                    (byte-identical hash semantics; the treasury
                                    module now delegates)
apps/api/src/middleware/auth.ts  -- requireCompliance() / requireCounsel()
                                    (role + active step-up MFA)

packages/shared/src/schemas/jurisdiction.ts    -- the ratified six-value cell
                                    vocabulary over the five crypto feature cells,
                                    region codes, policy schema + validatePolicy()
                                    (enabled ⇒ legal_approval_ref), resolution bases,
                                    the seven disable reasons
packages/shared/src/schemas/compliance-api.ts  -- wire contracts (~20 strict schemas)

packages/db/src/schema/compliance.ts           -- the `compliance` Postgres schema:
                                    10 tables with append-only triggers, chain
                                    fork-proof partial uniques, the GUC-gated case-
                                    audit DELETE, publish-immutable disclosures
packages/db/drizzle/0088_ws_n_compliance.sql   -- hand-authored migration

apps/web/src/components/compliance/           -- DisabledFeatureExplanation
                                    (specific, localizable, never "coming soon"),
                                    RegionDeclarationCard, RiskDisclosures,
                                    ComplianceConsole (/compliance-console)
apps/web/src/lib/compliance-api.ts             -- zod-validated typed flows
apps/web/src/i18n/catalogs/de.ts               -- the complete German
                                    disabled-state catalog (the first real locale)
```

## Design decisions that are easy to get wrong

- **Region is self-declared and verification-gated.**  A declaration is
  recorded `pending` and contributes NOTHING until a compliance reviewer
  verifies it; the locale subtag is a weaker basis that never unlocks
  real-funds cells.  There is no detection path to "correct" a declaration —
  that would require reading the network address.
- **A KYC requirement is enforced, or the cell is closed.**  `kyc_policy` and
  the age gate's `assurance` were dead letters — nothing read them, so counsel
  could write "production_payments requires kyc_partner" and real funds would
  flow to an unverified user. The engine now reads both, and since **no KYC
  partner is integrated** (the tracked residual) a cell that demands one stays
  closed with `verification_required`. `services.kycLevel` is the closure that
  partner will fill in — one boot-time swap, no engine change.
- **The port's args are required, not optional.**  `jurisdiction` takes
  `featureCell` and `asset`, and `fraudRisk` takes `reviewRef`, as **required
  properties with nullable values**. As optionals they were forgettable, and a
  caller that forgot one silently got the broader verdict — three review rounds
  found the cell missing from a different caller each time, and the asset gate
  missing from every one. Required-and-nullable makes the compiler ask each call
  site (including the next one anyone writes) what it is exercising, so `null`
  is a decision on the record rather than an omission nobody sees.
- **Fail-closed everywhere, in the right direction.**  Missing policy,
  malformed policy row, screening outage, velocity-counter outage, unknown
  region — each maps to the consumer verdict that DENIES real funds while
  leaving simulated/testnet behaviour intact.  A fraud `unavailable` verdict
  never *improves* an intent's compliance state; verdicts only flag or reject.
- **Velocity counting reserves, never reconciles down.**  Each `fraudRisk`
  call reserves a check (preflight + submit ≈ 2 per action, and the limits
  carry that factor); a rejected action's reservation is deliberately kept.
  Overcounting is fail-safe, undercounting is not.  All arithmetic is exact
  (BigInt in-memory; decimal-string school addition in the Redis Lua).
- **Hash chains survive erasure.**  Chain entries reference actors only by
  non-reversible account refs (HKDF-keyed HMAC), so a right-to-erasure purge
  NULLs subject columns without ever re-hashing or breaking chain
  verification.  The only sanctioned DELETE on `compliance_case_audits` is the
  retention sweep inside a transaction that sets the
  `licio.compliance_retention` GUC (a trigger rejects it otherwise).
- **Anti-tipping-off is structural.**  SAR records demand the counsel
  capability even to READ; the case audit shows a neutral
  `legal_hold_applied`; the SAR→case FK is `RESTRICT` so a case with a filed
  SAR cannot be swept out from under the record.
- **The no-key filter fails closed on both hex forms.**  ≥12 consecutive
  BIP-39 words is a seed phrase; a 64-hex run — bare or `0x`-prefixed — is a
  private-key export.  A `0x`-prefixed 64-hex value is *also* a transaction
  hash and the two are syntactically identical, so this is a choice about
  which error to make: storing a pasted key is catastrophic and irreversible,
  refusing a hash in the free-text fields this guards costs a warning, and real
  references belong in the structured `evidence_urls` array the filter never
  scans.  It guards **both** free-text lanes into the WS-J queue — the report
  `context` blurb and the appeal `user_statement` — because a user pasting a
  seed phrase while appealing an action reaches the same queue and the same
  reviewer views.  (`new_evidence` is URL-schema'd, not free text, so it is not
  scanned.)
- **RBAC separation is deliberate.**  `compliance` and `counsel` are distinct
  roles with distinct capabilities; `steward` and `admin` do NOT inherit them.
  Enabling any cell in a jurisdiction policy takes the **counsel capability**
  *and* a recorded `legal_approval_ref` — a compliance reviewer cannot turn
  real funds on for a region by quoting a reference at themselves. Narrowing
  writes (disabled/testnet/simulated/pending-legal) stay open to the
  compliance role: they can only reduce availability.
- **No change outlives its audit entry — structurally.**  Every compliance
  mutation runs inside a `ComplianceTransactor` unit of work
  (`stores.ts`): the change and its hash-chain entry commit together or leave
  no trace. A case creation, a transition, a legal hold, a policy write, a SAR
  draft (hold + report), and a lawful-access intake (case + hold + request) are
  each ONE unit. A chain fork aborts the unit and `runChainedUnit` replays it
  against the new head — the retry lives outside the transaction because a
  unique violation poisons a Postgres transaction.

  This replaced six hand-written compensators. They could *state* the rule but
  never guarantee it: each was a second failure point (a rollback can fail
  too), each re-derived what "undo" meant, and one forgotten call site
  silently reintroduced the defect — which is how three review rounds each
  found the same class in a new place. The in-memory adapters emulate the
  transaction (snapshot → run → restore) exactly as they emulate every other
  DB protection, so dev and tests get production's semantics. Two deliberate
  exceptions: the case-created **event** is best-effort (the case and its entry
  are already committed and are the record of truth, so a failed notification
  alerts rather than destroying an audited case), and the **fraud-queue
  decision** is compensated across ONE seam only: its compliance-side halves
  (the chain entry and the case's resolution) are a unit, but the intent's
  compliance column belongs to the WS-M treasury's own bounded context, and a
  transaction spanning them would couple two schemas the WS-D.3.2 isolation
  proof deliberately keeps apart. So that one pairing stays compensated, and
  the revert is narrow: a single CAS back to `flagged` — see the note in
  `routes/compliance.ts`.
- **An act and the record of who performed it are one write.**  A published
  disclosure carries `published_by_ref` on the row the publish creates, because
  a publish is IMMUTABLE: an attribution recorded in a second step and lost to a
  failure could never be added — the retry only meets `already_published`, and a
  live legal disclosure would keep no publisher record at all.  The identity
  audit entry is a best-effort mirror (a different bounded context, so it cannot
  join that write); failing it must not 500 a publish that already happened.
- **Counsel acts are attributed on counsel-only rows.**  A SAR's filing —
  the legally consequential step, and often not the approver's doing — is
  recorded as `filed_by_ref` on the report itself, NOT as a case-chain entry:
  compliance reviewers read that chain, and an entry there would announce the
  report's existence (anti-tipping-off). A lawful-access *production* has no
  such constraint, so it does ride the linked case's chain.
- **A hold and the record it exists for are one unit** — literally. A SAR draft
  whose report cannot be stored leaves no hold, no report, and no chain entry;
  a lawful-access intake whose hold fails leaves no case. (The compensators
  these replaced could only undo a hold *after* committing it, so the chain
  carried an applied-then-released pair for an event that never happened — and
  had to reason about whether an *earlier* obligation already held the case.) A
  **denied** request still releases its hold and closes its case explicitly: it
  obliges nothing, and leaving it would keep the subject's records pinned and
  their crypto features disabled on a request counsel rejected.
- **A verdict never claims an investigation that does not exist.**  Every
  answer here that names one — `blocked` on velocity, `elevated` for review,
  `blocked` on a sanctions match — promises operators and the subject a case, a
  chain entry, a queue row. When `createCase` fails (the chain is down), the
  promise is empty and the port answers `unavailable` instead: the real-fund
  paths reject on it exactly as they would on the block, but the claim is honest
  and the retry can still open the case. A sanctions hit whose case was not
  recorded is additionally **never cached** — the full TTL would suppress the
  retries that could still record it.
- **One resolution walk, read off the live state.**  `resolveCaseInTx` is the
  single automated close (the fraud-queue decision and the lawful-access denial
  both use it): it picks its route from where the case actually sits, never a
  fixed one. A reviewer who has already picked the case up would otherwise make
  an `open → assigned` first step return `INVALID_CASE_TRANSITION` and take the
  whole unit down — counsel could not record a denial *because* someone was
  looking at the case. Automated paths never claim `senior`; both routes are
  unguarded, and `escalated` reaches `resolved` via `investigating` precisely so
  the counsel-only edge stays counsel's.
- **Cleanup inside a unit throws; it never returns.**  A returned error reads to
  the transactor as a committed success, so a denial's failed hold-release would
  commit the denial while the route reported failure — the partial state the
  unit exists to prevent.
- **A legal hold is reference-counted, not a flag.**  A SAR and a lawful-access
  request can hold the same case at once, so each names its own hold
  (`legal_hold_refs`) and releases only that one; `legal_hold` is *derived* from
  what remains, and `setLegalHold` is the only writer of either. As a shared
  boolean, a denied lawful-access request cleared the hold an outstanding SAR
  still needed — and account deletion could then scrub the subject while the
  sweep anonymized the case. The refs are **opaque**, because the retention
  policy is reviewer-visible and a readable `sar:<id>` would announce the
  report's existence to the reviewers it must be kept from (anti-tipping-off); a
  count is not a disclosure, since a held case already shows its hold. The chain
  says `released` only when the last obligation lets go — a release that leaves
  the case held is not a release of the case. It is a SET, not a counter: a
  retried apply cannot strand the case at one. The set arithmetic lives in the
  **store**, under a row lock (`applyLegalHold`), not in the caller: a SAR draft
  racing a lawful-access intake would otherwise each derive a next policy from
  the row it read and clobber the other's ref — and the survivor's later release
  would free a case the lost obligation still holds.
- **Decisions CAS on their own premises.**  A reviewer's declaration verdict
  compares the region *and* status *and* `updatedAt` it was made about, not a
  timestamp alone — two changes inside one millisecond share a timestamp, and a
  verified declaration is the real-funds region basis, so resurrecting a revoked
  one (or verifying evidence against a region the member has left) must be
  impossible. The SAR filing CASes on `approved` for the same reason: the loser
  of a race gets a 409 rather than overwriting `filedByRef`.
- **The retention writes re-check the hold themselves.**  `deleteCascade` takes
  a row lock and re-reads it inside its transaction; `anonymize` puts it in the
  `WHERE`. The sweep's `listExpired` read cannot carry that guarantee — a SAR
  draft can land in the gap between choosing a page and acting on it. The
  predicate is `legal_hold = false`, not `IS NOT TRUE`: "not provably unheld"
  must not authorize a destructive act. A hold that wins the race is reported as
  `heldRace` (the guard working), never as an error, and leaves the run
  un-drained so the next tick re-reads the case. The right-to-erasure scrub
  carries the same predicate into its UPDATE, and reports rows by what actually
  moved (`returning`) rather than by what the candidate read guessed.
- **Every path that opens a case announces it.**  `createCase` emits the
  registered topic for its own callers; a path that composes `createCaseInTx`
  into a larger unit (the lawful-access intake) calls `announceCaseCreated` once
  that unit commits — after, never inside, since a chain fork can run the unit
  twice. Without it those high-risk cases would be the only trigger invisible to
  consumers and monitoring.
- **Retention retries and drains.**  The sweep's cadence marker advances only
  on a *drained* run — neither a transient failure nor a >500-case backlog may
  burn the window, or expired cases would stay readable for another full
  interval.  An un-drained run alerts and the next tick resumes.  An
  anonymized case is marked `anonymized_at`: its deletion date is permanently
  in the past, so without the marker the sweep would re-select and re-audit it
  every round and a full page could never drain.
- **Reviews are clearable.**  Anything a human is asked to review must have an
  exit, or "manual review" is just a block: a cleared high-value review lets
  its attempt through, and a cleared **partial** sanctions match returns
  `clear` once the short partial-cache TTL lapses. (A *full* match is never
  review-clearable here.)  Counsel-only surfaces work the same way — the
  retention-schedule config keys take the counsel capability, since they are
  the counsel-approved schedule.
- **Acknowledgments are region-scoped.**  The same `(disclosure_id, version)`
  carries different counsel-authored text per region, so the ack key and the
  gate both include the region — changing regions re-prompts rather than
  silently reusing another region's consent.

## Operational contract

- **Screening provider** (WS-N.2.2a): `COMPLIANCE_SCREENING_URL` +
  `COMPLIANCE_SCREENING_TOKEN_FILE` (all-or-none; the token is file-loaded and
  a broken file is boot-fatal).  Contract: `POST {base}/v1/screen` with
  `{ address, context }` → `{ result: 'clear' | 'partial' | 'full' }`.
  Unconfigured deployments degrade closed (`unavailable` — real funds
  rejected).
- **Runtime config** (`compliance.*`, fail-closed loader): cache TTLs,
  screening timeout, velocity limits + per-region overrides, the high-value
  review threshold, retention days by trigger + anonymize triggers, SLA hours
  by risk, event-tier retention overrides.
- **Dev**: the seeded `compliance@licio.test` account carries both roles
  (see `docs/DEVELOPMENT.md`); policies are unpopulated by default so every
  cell reads `disabled` (`no_policy`) until one is created through the
  console — fail-closed is the demo, not a gap.

## Verification

- `apps/api/src/compliance/__tests__/` — foundations (region ladder, policy
  activation incl. the malformed-latest rule, config), engine (cell + coarse
  verdict truth table), screening (full/partial/outage/cache), velocity
  (exact math, reservation, outage), cases (transition guards, idempotency,
  legal hold), and the fail-closed matrix (every outage/missing/unknown arm).
- `apps/api/src/__tests__/compliance-routes.test.ts` — the mounted surface
  (RBAC + MFA gates, declaration flow, disclosure gate, fraud queue).
- `apps/api/src/__tests__/treasury-compliance-hold.test.ts` — the intent
  preflight arms + the COMPLIANCE_GATED_TARGETS transition guard.
- `apps/api/src/__tests__/no-key-requests.test.ts` — the WS-N.2.3e filter at
  the report/support edge.
- `apps/api/src/__tests__/compliance-integration.test.ts` — the GATED
  live-infrastructure contract (runs in CI's service containers): the Drizzle
  adapters against the real migration (fork-proof chain uniques, append-only
  triggers, the sanctioned retention GUC, the SAR FK RESTRICT, publish-
  immutable disclosures, NULLing-only ack erasure) and the Redis adapters
  (the exact-decimal Lua velocity reserve — proven with a sum float math
  would wrongly admit — cross-instance sharing, cache TTL, and the
  fail-closed invalidation pub/sub).
- `apps/web/src/components/compliance/*.test.tsx` — the (feature × reason)
  exhaustive explanation matrix + the no-vague-language gate + German catalog
  completeness + axe, and the declaration/disclosure/console flows.
- The `no-client-address` static gate and `check:prod-parity` both cover the
  new module (InMemory/Drizzle/Redis adapter parity).

## Residuals (tracked)

1. **Legal sign-off + policy population.**  The engine ships with ZERO
   jurisdiction policies — every region fails closed until counsel authors
   real per-region policies (with `legal_approval_ref`) through the console.
   That is the intended launch posture; populating the matrix is a legal
   deliverable, not an engineering one.  **Closure:** the M4/M5 legal review
   alongside the WS-L external audit.
2. **KYC-partner verification seam.**  Declaration verification is a manual
   compliance-reviewer decision today; `kycPolicySchema` reserves the
   partner-assisted path (documents never touch Licio infrastructure).
   **Closure:** WS-N.1.1f partner integration when a real-funds region
   requires it.
3. **Screening vendor.**  `HttpSanctionsProvider` implements the documented
   contract; pointing it at a production vendor (and mapping that vendor's
   response taxonomy) is deployment configuration.  **Closure:** before the
   capped real-funds pilot (§30.11), together with the WS-L gateway rollout.
4. **SAR filing is record-keeping, not transmission.**  The SAR store holds
   counsel-approved drafts and filing metadata; actual submission to a FIU
   goes through counsel's regulated channel, not an API.  Deliberate.

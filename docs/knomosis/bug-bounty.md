# Knomosis bug bounty — scope and reward structure (WS-L.1.3b)

Status: reviewed draft
Date: 2026-07-06
Spec refs: §17.11, §25.6, §30.7 (K4), §30.11 (capped real-funds gate)
Task: WS-L.1.3b
Companion doc: `docs/knomosis/` external-audit scope (WS-L.1.3a)

This document defines the bug bounty program for Licio's Knomosis financial
and governance stack. It fixes scope, severity tiers, reward structure, and
the disclosure process. Reward *amounts* are placeholders pending budget
sign-off (§30.11 review board); the tiering, scope, and process below are
fixed and reviewed.

The program is a launch-blocking gate: it must be live and have completed at
least one internal triage dry-run before the M5 capped real-funds pilot
(§30.7 K4, §30.11 "bug bounty live"). Until M5 the financial surface ships
disabled or simulated (the crypto flag defaults false and fails closed —
`apps/api/src/knomosis/config.ts`), so the earliest exploitable real-funds
window opens at M5; the bounty must precede it.

## 1. In-scope surfaces

Each surface below maps to the code that implements it, so reports can be
reproduced and triaged against a concrete artifact.

### 1.1 Wallet flows

- SIWE (EIP-4361) nonce issue and link verification, unlink lifecycle,
  labels, risk state — `apps/api/src/knomosis/wallet.ts`,
  `apps/api/src/routes/wallet.ts`.
- EIP-712 typed-data signing, EOA ECDSA `ecrecover`, EIP-1271 / EIP-6492
  contract-wallet verification, low-s malleability enforcement —
  `apps/api/src/knomosis/signatures.ts`.
- The canonical typed-data struct registry and the anti-replay quartet
  (`nonce`, `expiration`, `deploymentId`, `actor`) —
  `packages/shared/src/knomosis/typed-data.ts`.
- Transaction preview / anti-bait-and-switch derivation —
  `packages/shared/src/knomosis/preview.ts`.
- Financial-domain address hashing and civic↔wallet separation —
  `hashFinancialWalletAddress` in `apps/api/src/identity/siwe.ts`.

### 1.2 Gateway

- The `knomosis-gateway` transport seam (preflight verdict, submit, event
  replay by cursor, standing reads) — `apps/api/src/knomosis/gateway.ts`.
- Preflight validation pipeline and the single-use, TTL'd, typed-data-hash-
  bound preflight token — `apps/api/src/knomosis/preflight.ts`.
- Action submission, the §23.5 state machine, and atomic per-(user,
  deployment) nonce consumption — `apps/api/src/knomosis/submission.ts`.
- Route surface (`/knomosis/actions/preflight`, `/submit`, `/{id}`,
  standing, receipts, kill-switch admin) — `apps/api/src/routes/knomosis.ts`.
- Pinned-deployment loader (commit, ABIs, addresses, manifest hashes,
  contract allowlist) — `apps/api/src/knomosis/pin.ts`, `pin.config.json`.

### 1.3 Treasury and governance

- Governance simulation, SIM-asset treasury, voting, timelocked execution,
  comprehension gate, append-only audit log —
  `apps/api/src/knomosis/simulation.ts`,
  `apps/api/src/routes/room-governance.ts`.
- Room-readiness gate for governance-mode transitions —
  `apps/api/src/knomosis/readiness.ts`.
- Treasury-obligation and compliance port seams (fail-closed) —
  `apps/api/src/knomosis/ports.ts`.
- Proof-carrying treasury kernel and law-pack bounds —
  `@licio/governance` (consumed by preflight/simulation).

### 1.4 Indexer and reconciliation

- Gateway event ingestion, idempotency over `(deployment, gateway_seq,
  gateway_index)`, gap (`409 {oldestSeq}`) and unknown-event-type
  fail-closed handling — `apps/api/src/knomosis/ingest.ts`.
- Three-source reconciliation, low-watermark comparison, divergence
  classification, freeze-review trigger —
  `apps/api/src/knomosis/reconciliation.ts`.
- Standing reads (ranking-firewalled) — `apps/api/src/knomosis/standing.ts`.
- Public / private receipt pairing and the public-field allowlist —
  `apps/api/src/knomosis/receipts.ts`.

### 1.5 Contract / L2 interactions

- Correctness of the pinned deployment facts against the on-chain reality
  (address, chain ID, manifest hash, confirmation depth, reversibility
  wording), and any way to make Licio accept, forward, or reconcile an
  action against an unpinned or spoofed contract.
- The L1 bridge, state-root, deposit/withdrawal, dispute, and fault-proof
  behavior of the pinned Knomosis deployment are in scope insofar as a
  finding lets an attacker move Licio-treasury or user funds, or corrupt
  Licio's view of settled state. Vulnerabilities in the upstream Knomosis
  Lean/Solidity/Rust stack itself should be reported to us; we coordinate
  disclosure with the Knomosis maintainers.

### 1.6 PWA bundle (XSS-to-wallet-drain chains, §25.6)

The highest-value web target is any injection that can trigger a malicious
signature or bypass the transaction preview:

- Any XSS, Trusted Types bypass, or CSP bypass that reaches an
  `eth_signTypedData_v4` call or mutates the preview a user sees before
  signing (the §31.2 "XSS → wallet drain" chain).
- Any path that renders a signable payload divergent from the preview
  (`preview.ts` derives strictly from the signed struct — a divergence is a
  reportable defect).
- Service-worker takeover, bundle-provenance / SRI weaknesses, and
  look-alike-domain phishing vectors that specifically enable a signing
  attack.

### 1.7 Isolation and neutrality (pay-to-rank firewall)

- Any SQL join path, view, port leak, or feature-registration that connects
  financial data (wallet, treasury, standing, receipts) to a ranking,
  search, notification, trend, or recommendation feature (§17.1 boundary 1).
  The structural guard is `packages/db/src/isolation.ts` (WS-D.3.2 BFS
  proof) plus the WS-I.2.1b financial denylist; a bypass of either is
  in scope.
- Any on-chain egress of a §19.5 "never on-chain" field (attention,
  reading/report history, reporter identity, minors' data, device IDs, civic
  identity, private messages). The public-receipt allowlist in
  `receipts.ts` is the enforcement point.

## 2. Severity tiers

Financial and privacy impact drive the tier, not raw CVSS. Wallet/fund
exploits are treated as critical regardless of CVSS (SECURITY.md, "Wallet /
Financial Exploits"). A working proof-of-concept raises the tier; a
theoretical-only report may be lowered one tier at triage discretion.

### 2.1 Critical — fund theft, signature bypass, preflight-token forgery

Direct loss or unauthorized movement of user or treasury funds, or a full
break of the signing/authorization chain. Examples:

- Draining a user wallet or a room treasury by any chain.
- Forging or replaying a preflight token, or defeating the typed-data-hash
  binding so a submission executes a payload the user never previewed
  (`preflight.ts` / `submission.ts` anti-TOCTOU).
- Bypassing EIP-712 / EIP-1271 signature verification, or a low-s
  malleability replay that `signatures.ts` should reject.
- An XSS-to-wallet-drain chain (§25.6, §31.2): injection → malicious
  signature or silently mutated preview.
- Executing a treasury action that exceeds a law-pack cap, changes an
  interval, or spends off-category despite the proof-carrying kernel.
- Forging a manifest/pin so Licio forwards to an attacker contract.

### 2.2 High — nonce replay, kill-switch bypass, isolation breach

Serious integrity or authorization failures short of direct theft, or a
defeat of a defense-in-depth control. Examples:

- Same-chain nonce replay: reusing a consumed per-(user, deployment) nonce
  (`submission.ts` `tryConsume` must be atomic and single-use).
- Bypassing or failing to honor an engaged kill switch, or defeating the
  fail-closed / two-person-deactivation logic
  (`apps/api/src/knomosis/killswitch.ts`).
- A pay-to-rank isolation breach: any join/feature path linking financial
  data to ranking (`isolation.ts`, WS-I.2.1b denylist).
- Reconciliation evasion: hiding a material divergence or lost-event gap so
  the freeze-review never fires (`reconciliation.ts`, `ingest.ts`).
- Idempotency break: double-processing a submission or a duplicate gateway
  event corrupting the ledger.
- Cross-deployment or cross-chain replay defeating the EIP-712 domain
  (`chainId` / `verifyingContract`) binding.
- Escalating governance authority (voting/tally manipulation, capturing the
  steward seat to bypass ratification) beyond §17.5 kernel-computed bounds.

### 2.3 Medium — receipt leakage, abuse-limit bypass

Confidentiality or abuse-control failures without fund loss. Examples:

- A §19.5 field leaking into a public receipt or on-chain payload past the
  `receipts.ts` `PUBLIC_RECEIPT_FIELDS` allowlist (e.g. an address or civic
  identity surfacing publicly).
- Returning another user's standing/balance, or a wallet the requester does
  not own, from `standing.ts` (ownership-scoped by design).
- Bypassing wallet abuse limits, unlink cooling-off, velocity limits, or the
  comprehension gate for a first governance action.
- Leaking the existence or content of a private receipt to an unauthorized
  user.
- CSRF on a financial mutation, or a step-up / adult-age-gate bypass on a
  wallet route (`routes/wallet.ts` guard chain).

### 2.4 Low — UX disclosure gaps

Correctness or clarity defects with limited direct impact. Examples:

- A transaction preview omitting or misstating a required §17.8 field
  (fee, reversibility, nonce, expiration, chain ID) without enabling a
  drain.
- Missing or incorrect risk labels, jurisdiction/compliance status, or the
  §19.5 on-chain disclosure banner in the preview.
- Verbose error messages that disclose deployment internals without a
  usable exploit.
- Accessibility defects in transaction previews or governance decisions
  (§26.2) that impede informed consent.

## 3. Reward structure

Ranges are placeholders pending budget sign-off by the §30.11 review board.
The tiering and multipliers are fixed; only the dollar figures are open.

| Tier     | Range (placeholder) | Qualifies |
|----------|---------------------|-----------|
| Critical | $TBD_C_LOW – $TBD_C_HIGH | Fund theft, signature bypass, preflight-token forgery, XSS→drain |
| High     | $TBD_H_LOW – $TBD_H_HIGH | Nonce replay, kill-switch bypass, isolation breach |
| Medium   | $TBD_M_LOW – $TBD_M_HIGH | Receipt leakage, abuse-limit bypass |
| Low      | $TBD_L_LOW – $TBD_L_HIGH | UX / disclosure gaps |

Modifiers (fixed):

- A working, reproducible proof-of-concept is required for the top of a
  tier's range; a credible but unproven report lands at the bottom.
- Report quality (clear repro steps, root-cause analysis, a suggested fix,
  and a failing test or scenario) can raise the award within the band.
- Chained findings are rewarded at the tier of the *combined* impact
  (e.g. a medium XSS that completes a drain chain is paid as critical).
- Reward amounts and any bonus pool are set by the review board before the
  program opens and are published in the live program listing, not here.

## 4. Responsible disclosure

The program runs under Licio's existing private disclosure policy
(`SECURITY.md`).

- Report privately to **security@licio.app** or via GitHub Security
  Advisories ("Report a vulnerability"). Do not open a public issue.
- **Acknowledgment within 48 hours**; initial assessment within 5 business
  days (SECURITY.md).
- Fix SLA: critical patched within 14 days, high within 30 (SECURITY.md).
  Wallet/fund findings follow the escalated financial-exploit
  incident-communications plan (§25.6) and are handled as critical
  regardless of CVSS.
- Include the affected surface (§1), an attack model, and reproduction
  steps. For pay-to-rank / invariant-evasion reports, include a scenario the
  existing adversarial suite does not already cover
  (`apps/api/src/__tests__/`).
- Coordinated disclosure: please give us the SLA window to remediate before
  any public write-up. We credit reporters by name on request once a fix
  ships.
- Findings in the upstream Knomosis contract stack are welcome here; we
  coordinate onward disclosure with the Knomosis maintainers.

## 5. Safe harbor

Good-faith research conducted within this policy is authorized and will not
be pursued as a violation of applicable anti-hacking law or of Licio's
terms. Good faith requires:

- Use only test/simulated assets, testnet deployments, or your own accounts.
  Never test against another user's funds, wallet, or treasury.
- No real-funds exploitation. A finding that *would* drain funds must be
  demonstrated in a controlled way (testnet, local, or a bounded PoC) —
  never by moving real user or treasury assets.
- No privacy violation: do not access, exfiltrate, or retain another user's
  data, attention history, receipts, or any §19.5-protected field beyond the
  minimum needed to demonstrate the issue.
- No service degradation: no volumetric DoS, no spam, no destruction of
  data, and no social-engineering of Licio staff or users.
- Stop and report on encountering real user data or funds; do not pivot.

Acting in good faith under these rules, you will not have your access
terminated for the research itself and we will not initiate legal action.
Testing outside these bounds — especially against real funds or real
users — is out of scope and outside safe harbor.

## 6. Duplicates

The first clear, reproducible report of a distinct root cause receives the
reward. Later reports of the same root cause are duplicates, even if the
surface or symptom differs. If two reports arrive close together, priority
follows the timestamp of the first report containing enough detail to
reproduce. A report that materially extends a known issue into a higher-
impact chain may qualify for an incremental award at triage discretion.
Triage decisions and duplicate determinations are documented in the case
record for auditability.

## 7. Out of scope

- Findings against upstream dependencies with no Licio-exploitable path
  (report upstream; we track via SBOM and `pnpm audit`).
- Missing security headers or best-practice hardening with no demonstrated
  impact (our CSP, HSTS, and Trusted Types posture is enforced by CI gates;
  a *bypass* is in scope, an opinion is not).
- Self-XSS, clickjacking on pages with no state-changing action, and issues
  requiring a fully compromised device, rooted OS, or a malicious browser
  extension.
- Volumetric DoS / rate-limit exhaustion (connection-level flood fairness is
  the edge's concern, §19.1); logical rate-limit *bypasses* are in scope
  (medium).
- Vulnerabilities in third-party wallets, WalletConnect relays, RPC
  providers, or the user's chosen chain, absent a Licio-side amplification.
- Social engineering of Licio staff, physical attacks, and non-security UX
  complaints.
- Anything requiring the crypto feature flag to be force-enabled in an
  environment where it is off by policy (the flag fails closed by design —
  `config.ts`); report the flag-bypass itself instead, which is in scope.
- Reports based solely on automated scanner output with no verified,
  reproducible impact.

## 8. Timeline and launch gate

- The program must be **live before the M5 capped real-funds pilot** (§30.7
  K4, §30.11 capped-real-funds gate lists "bug bounty live" as required).
- Before opening, run the internal triage dry-run required by WS-L.1.3b:
  submit a synthetic report through security@licio.app and confirm the
  end-to-end triage workflow (ack within 48h, assessment, severity
  assignment, reward decision, close) with the WS-O.2.1a-e incident-response
  process.
- The program stays live through GA and beyond; re-scope reviews are
  triggered on the same events as re-audit (WS-L.1.3a): material contract or
  law-pack schema changes, a new chain or deployment, or a custody-model
  change.
- Ownership: security lead runs triage with the §30.11 review board setting
  reward amounts; product and compliance leads sign off on scope changes.

## 9. Tracked residuals

- **Reward amounts unset** — dollar figures in §3 are placeholders pending
  §30.11 review-board budget sign-off. Closure target: before the program
  opens (pre-M5). Tracked here and in `docs/planning/13-knomosis-and-wallets.md`
  (WS-L.1.3b).
- **Platform selection** — whether the program runs self-hosted (via
  security@licio.app + GitHub Security Advisories, already live per
  SECURITY.md) or on a third-party bounty platform is a pre-M5 operational
  decision; scope and tiers above are platform-independent.
- **Upstream Knomosis coordination** — the disclosure handshake with the
  Knomosis contract maintainers (§1.5) must be documented before the pilot;
  coordinate with WS-L.1.3a audit scope.

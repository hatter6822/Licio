# Licio Implementation Plan — Master Index

**Version:** v4.5
**Source specification:** docs/SPEC.md v0.7 (core); docs/OFFLINE_SPEC.md (LCAP v0.2, WS-R); docs/PRIVATE_SPEC.md (WS-S)
**Date:** June 19, 2026

This plan decomposes the Licio specification into 22 workstream documents housed in `docs/planning/`: the 21 dependency-ordered workstreams (WS-0, A-T) plus the cross-cutting **WS-U** AI-governed-rooms redesign (`22-ai-governed-rooms.md`). Each document is independently actionable, dependency-ordered, and composed of **~922 atomic tasks** targeting 0.5-2 engineering days each (WS-U is doctrine-first; its staged-PR atomic cards are decomposed as each stage lands — §U.7). Every task carries a unique ID, a spec reference (`Ref:`), a description, measurable acceptance criteria, testing requirements, and explicit dependencies; data-bearing tasks include Drizzle/zod schemas and API request/response shapes. Tasks are independently reviewable, testable, and reversible per Section 30.8. The plan follows the spec's milestone structure (M0-M6), workstream labels (0, A-U), and the critical-path ordering from Section 30.2. WS-R and WS-S are **extension workstreams**: they derive from the standalone `docs/OFFLINE_SPEC.md` and `docs/PRIVATE_SPEC.md` specifications (not docs/SPEC.md), are post-M3 resilience/privacy extensions, and are not launch-blocking for the core social product.

**Revision history:**
- **v4.5** — Added **WS-U (AI-governed rooms)** as `22-ai-governed-rooms.md`: the maintainer's binding cross-cutting redesign of AI's role. Inverts the SPEC §24.1 "AI never autonomously spends/approves/sanctions" posture into **bounded autonomy** for *in-room* governance while keeping it intact at the *platform* layer. Establishes the **three-layer authority model** (room sovereignty → Knomosis-bounded AI agent → non-overridable platform legal floor), the **elected room steward** (creator first, then a yearly Knomosis election) with **exactly two powers** (propose a community-approved, member-downloadable AI model; propose its prompt — both member-ratified by Knomosis vote), and the **in-room AI agent** (moderation, treasury management within kernel-enforced bounds, unbiased lawmaking facilitation; holds no keys; sandboxed/capability-scoped; transparent). Amends SPEC §16.3/§16.5/§16.6/§17.1/§17.3.3/§17.4/§17.5/§17.6/§24.1/§24.2/§24.5/§24.6 and the `docs/policy/` register (`README.md`, `STEWARD_ROLES.md` 1.1.0, `MODERATION_TAXONOMY.md` 1.1.0). **Re-scopes WS-K** (the shipped AI-model-governance platform becomes the platform-side evaluation/transparency/guard substrate for community models) and amends **WS-J** (the platform legal floor + appeals of last resort), **WS-L** (Lex bounds + a non-key-holding agent submitter), and **WS-M** (elected steward + Knomosis-vote model/prompt approval + AI-executed treasury within bounds). The **pay-to-rank firewall** (crypto flag, consumer-router Knomosis refusal, financial denylist, wallet↔ranking isolation, governance-only standing read) and **fail-closed crypto** are preserved in full. Doctrine-first (Stage 0); runtime code lands in the six staged PRs of §U.7.
- **v4.4** — Added **WS-T (conversation as comments)** as `21-conversation-comments.md` (64 atomic tasks): replaces the six-section structured-thread model (§6.4/§15.3) and the eleven-mode participation composer (§6.6) with a lightly-nested **comment section embedded in the content page**, keeping `evidence`/`correction` as optional typed enrichments (MERI/reputation/Hodge inputs preserved) and retiring the other nine types for new writes (fully back-compatible on read); adds same-origin **GIF uploads** (GIF-aware metadata stripping that preserves animation), **live comments over same-origin SSE** (no CSP change), and **reply notifications** on the existing push + notification-budget stack; retires the `/threads` tab/routes (story-redirect shim) and reverts `/submit` to story submission; repurposes the §22.1 branch-depth signal to reply-depth. Amends SPEC §3.4/§6.4/§6.6/§15.1/§15.3/§15.5/§24.3. The six sections were a read-time projection (no stored `branch` column) and the invariants key on `type`/`lens_id`/evidence/tree-depth, so the model simplification is additive at the storage layer (migrations `0029`–`0033`). Complex tasks (the nested comment read, the GIF parser/stripper, the SSE broadcaster/endpoint/client, the reply-notification path, and the comment-section UX) are decomposed into reviewable sub-cards, then hardened against an automated review pass (12 findings addressed: media-only body normalization, a dedicated comment-item schema, the durable attention-aggregate migration `0033`, root/direct-child store predicates, image-only + story-claimed comment attachments, per-frame SSE read-bar revalidation, and recipient-gated + user-bound + bodyless-wake reply notifications). Net +64 cards (~858 → ~922).
- **v4.3** — Synced the in-flight workstreams (**WS-J–WS-Q**) with the WS-R/WS-S extensions: room-class scope statements (server-hosted `public_server`/`restricted_server` vs E2EE `private_p2p`), the "members-only server room" rename forward-references, LCAP-as-alternate-ingress notes, and the no-server-AI-on-E2EE / no-pay-to-rank / E2EE-and-offline compliance boundaries. Made the WS-S update-channel's reproducible-build/transparency-log dependency concrete by enriching **WS-O.3.2b** (per-chunk attestation) and adding **WS-O.3.2e** (runtime pinning hook), and aligned **WS-L** to the Knomosis project's `knomosis-gateway` v0.4 HTTP/JSON+SSE contract (synchronous-verdict model, eventual-consistency reads, SSE reconciliation, service auth, L1-agnostic/upstream reorg, phased dark launch) with a new firewalled standing-read seam (**WS-L.3.6a**) that preserves no-pay-to-rank. Net +2 cards (WS-O 46→47, WS-L 61→62 → ~858). Project-wide documentation-consistency pass (task counts, tech-stack versions, top-level status/reference docs).
- **v4.2** — Added two **extension workstreams** derived from the standalone offline/private specs (150 atomic tasks total, after a correctness pass that broke the complex cryptographic/protocol cards into reviewable sub-cards and removed two circular dependencies). **WS-R (offline content availability)** as `19-offline-content-availability.md` (88 tasks) for `docs/OFFLINE_SPEC.md` (LCAP v0.2): the delay-tolerant, content-addressed, signed sync protocol — deterministic CBOR/CID/COSE foundations, detached-proof trust plane (device certs, capabilities, revocations, checkpoints, witnesses), the anti-starvation lane scheduler, the pulse/exchange sync protocol, trust/liveness projection, server reconciliation, manual `.licio-bundle`/QR/relay transports, and the network-simulation + acceptance suites. **WS-S (private P2P rooms)** as `20-private-p2p-rooms.md` (62 tasks) for `docs/PRIVATE_SPEC.md`: end-to-end-encrypted, member-hosted rooms as a separate storage/sync/trust/authority plane — the server non-storage contract (column denylist + endpoint guards + retriever/search/event exclusion + seven CI gates), MLS/HPKE/Ed25519 crypto with the labeled-HKDF key schedule, the private Helia/libp2p profile, the deterministic Lamport-ordered op-log reducer, blind rendezvous, the reproducible/transparency-logged update channel, and the migration of restricted server rooms. Both reuse and respect the existing doctrine gates (no-applause, no-raw-egress, identity-free rate limiting, dependency budget) and cross-reference each other (LCAP packs MAY carry WS-S ciphertext as the CAR-equivalent).
- **v4.1** — Added **WS-Q (content–room ownership and visibility)** as `18-content-and-room-model.md` (60 atomic tasks) for the SPEC v0.7 model: rooms own content, content owns conversation, binary public/private room visibility with orthogonal join-model/posting-policy axes, per-item public/in-room visibility with private-room forcing and audited transitions, native image/video posts through the scan-gated media pipeline, tier-scoped duplicate detection, visibility-scoped retrieval/search/distribution, and the behavior-preserving migration of pre-room content into home rooms. Every card is a single deliverable; the storage change is sequenced as eight online-safe expand/contract migrations (`0014`–`0020`). WS-Q remodels shipped WS-F/WS-G/WS-I surfaces and is dependency-ordered after them.
- **v4.0** — Deep audit + expansion of every workstream (≈2x depth; ~22,900 lines; ~646 atomic tasks). Closed spec-coverage gaps surfaced during the audit, including: emergency feature-flag substrate and kill switches (WS-O.2.2), integrity/abuse defense without device attestation (WS-O.4), backend hardening/secrets and reliability/DR (WS-O.5/O.6), Knomosis event schemas behind the pay-to-rank firewall (WS-E.1.2), event storage + retention jobs (WS-E.3), governance action budgets (WS-M.3.2a) and delegation/anti-capture (WS-M.4.2c-*), on-chain privacy (WS-L.1.2e), Knomosis transparency metrics and phase success-gates (WS-P.1.4a/3.1a), Core Web Vitals enforcement (WS-C.5.1), and source/claim/search definitions referenced cross-workstream (WS-F.1.1/1.2/2/3.1). Standardized per-task dependencies and definitions of done across all documents.
- **v3.0** — Split the monolithic `WORKSTREAM_PLAN.md` into 17 dependency-ordered documents.
- **v2.0** — Refined and cross-validated the monolithic plan against SPEC.md v0.6.

---

## Document Map

| File | Workstream | Milestone | Priority | Wave | Tasks | Summary |
|---|---|---|---|---|---|---|
| `01-repository-foundation.md` | WS-0 | M0 | P0 | 1 | 48 | Monorepo, TypeScript strict, CI/CD, security baseline |
| `02-doctrine-and-policy.md` | WS-A | M0 | P0 | 1 | 18 | No-applause doctrine, moderation taxonomy, jurisdiction, steward roles |
| `03-design-system.md` | WS-B | M0-M1 | P0-1 | 2-3 | 35 | Design tokens, WCAG 2.2 AA primitives, app-specific components |
| `04-pwa-client.md` | WS-C | M1 | P0-1 | 2-4 | 28 | Routing, state, service worker, offline, push, signal processing, CWV budgets |
| `05-identity-and-privacy.md` | WS-D | M1 | P0-1 | 2-3 | 37 | WebAuthn-first passwordless auth (email-OTP + wallet/EIP-4361 fallback), MFA, age gating, privacy controls, wallet identity |
| `06-event-pipeline-and-pwatt.md` | WS-E | M1-M2 | P1 | 4-5 | 30 | Event schemas, storage/retention, ingestion, PWAtt v0/v1 scoring |
| `07-ingestion-and-search.md` | WS-F | M1 | P1 | 3-4 | 30 | Story/claim/source schemas, lifecycle, search, embeddings |
| `08-forum-and-conversation.md` | WS-G | M1 | P1 | 4 | 38 | Threads, contributions, rooms, lenses, composer, UGC safety |
| `09-invariant-services.md` | WS-H | M2 | P2 | 5 | 82 | MERI, MFCI, SCOI, GWEI, PHI, 6 supporting invariants |
| `10-ranking-and-distribution.md` | WS-I | M2-M3 | P2-3 | 5-6 | 36 | Candidate gen, ranking pipeline, neutrality tests, kill switch |
| `11-trust-and-safety.md` | WS-J | M1 | P0-1 | 3-4 | 29 | User safety, moderation console, automated pre-checks |
| `12-ai-governance.md` | WS-K | M3 | P3 | 5 | 20 | Model registry, evaluation, classification, summarization, lineage |
| `13-knomosis-and-wallets.md` | WS-L | M4 | P4 | 1+7 | 62 | Due diligence, wallet integration, knomosis-gateway HTTP/JSON+SSE contract (verdict/SSE/eventual-consistency; ranking-firewalled standing reads), simulation |
| `14-treasury-and-governance.md` | WS-M | M4-M5 | P4-5 | 8 | 49 | Room governance, treasury, payments, proposals, action budgets |
| `15-compliance.md` | WS-N | M5 | P4-5 | 8 | 27 | Jurisdiction engine, financial compliance, support |
| `16-security-and-reliability.md` | WS-O | M0-M6 | P0 | 2+6 | 47 | Security testing, integrity defense, incident response, reproducible builds (+ per-chunk attestation & runtime pinning for WS-R/WS-S), reliability/DR |
| `17-experimentation-and-launch.md` | WS-P | M3-M6 | P3 | 6 | 32 | Product metrics, anti-metrics, experiments, transparency, i18n |
| `18-content-and-room-model.md` | WS-Q | M3 | P1 | 9 | 60 | Room-owned content, public/private rooms, public/in-room visibility, image/video posts, visibility-scoped distribution |
| `19-offline-content-availability.md` | WS-R | M3+ ext | P3 | 10 | 88 | LCAP v0.2 delay-tolerant sync: deterministic CBOR/CID/COSE, detached-proof trust plane, lane scheduler, checkpoints/witnesses, liveness, manual bundle/QR/relay transports |
| `20-private-p2p-rooms.md` | WS-S | M3+ ext | P3 | 11 | 62 | E2EE member-hosted private rooms: server non-storage contract, MLS/HPKE/Ed25519, private Helia/libp2p, Lamport-ordered op-log reducer, blind rendezvous, update-channel transparency |
| `21-conversation-comments.md` | WS-T | M3 | P1 | 12 | 64 | Inline comment sections: comment-as-unit, evidence/correction enrichments, GIF uploads, SSE live comments, reply notifications, retire structured branches |
| `22-ai-governed-rooms.md` | WS-U | M3-M5 | P3-5 | 5-8 | staged | **AI-governed rooms (cross-cutting redesign).** Three-layer authority (room sovereignty → Knomosis-bounded AI agent → platform legal floor); elected room steward (2 member-ratified powers: propose model, propose prompt); bounded in-room AI agent (moderation, treasury within kernel-enforced bounds, unbiased lawmaking); re-scopes WS-K; amends WS-J/L/M; pay-to-rank firewall preserved |
| **Total** | | | | | **~922** | Atomic tasks across 21 workstreams (+ WS-U staged) |

---

## Dependency Graph

```
WS-0 (Repository foundation) ── 01-repository-foundation.md
 ├── WS-A (Doctrine) [parallel — documents only] ── 02-doctrine-and-policy.md
 ├── WS-B.1 (Design system primitives) ── 03-design-system.md
 │    └── WS-B.2 (Application components) ── 03-design-system.md
 ├── WS-C.1 (Routing/state) ── 04-pwa-client.md
 │    ├── WS-C.2 (Service worker/PWA/notifications) ── 04-pwa-client.md
 │    ├── WS-C.3 (Hono RPC client) ── 04-pwa-client.md
 │    └── WS-C.4 (Signal processor) → depends on WS-E.1.1 (event schema) ── 04-pwa-client.md
 ├── WS-D.1 (Auth/accounts) ── 05-identity-and-privacy.md
 │    ├── WS-D.1.7 (Age gating) ── 05-identity-and-privacy.md
 │    ├── WS-D.2 (Privacy controls) ── 05-identity-and-privacy.md
 │    ├── WS-D.3 (Wallet identity — isolated) ── 05-identity-and-privacy.md
 │    ├── WS-E (Event pipeline → PWAtt) ── 06-event-pipeline-and-pwatt.md
 │    ├── WS-F (Ingestion/source/search) ── 07-ingestion-and-search.md
 │    │    └── WS-G (Forum/conversation/rooms/lenses) ── 08-forum-and-conversation.md
 │    │         ├── WS-H (Invariants) → depends on WS-E, WS-F.3.2 (embeddings) ── 09-invariant-services.md
 │    │         │    └── WS-I (Ranking) → depends on WS-E.2 ── 10-ranking-and-distribution.md
 │    │         │         └── WS-Q (Content–room ownership/visibility) → remodels WS-F/WS-G/WS-I ── 18-content-and-room-model.md
 │    │         │             └── WS-T (Conversation as comments) → remodels WS-G/WS-Q (+ WS-E/WS-J/WS-C) ── 21-conversation-comments.md
 │    │         ├── WS-K (AI governance) ── 12-ai-governance.md
 │    │         └── WS-L (Knomosis) → depends on WS-D.3, WS-O ── 13-knomosis-and-wallets.md
 │    │              └── WS-M (Treasury/governance) ── 14-treasury-and-governance.md
 │    │                   └── WS-N (Compliance) ── 15-compliance.md
 │    └── WS-J (Trust/safety) [no dependency on WS-G — reports work before forum] ── 11-trust-and-safety.md
 ├── WS-O (Security — continuous) ── 16-security-and-reliability.md
 ├── WS-P (Metrics/experiments — from M3 onward) ── 17-experimentation-and-launch.md
 ├── WS-R (Offline availability / LCAP v0.2) [extension of OFFLINE_SPEC; depends on WS-C/D/E/F/G/Q] ── 19-offline-content-availability.md
 ├── WS-S (Private P2P rooms / E2EE) [extension of PRIVATE_SPEC; depends on WS-C/D/G/Q/O; optional LCAP-pack reuse from WS-R] ── 20-private-p2p-rooms.md
 └── WS-U (AI-governed rooms) [cross-cutting redesign; re-scopes WS-K; amends WS-J/L/M; depends on WS-G/Q (rooms), WS-K (eval substrate), WS-L/M (Knomosis bounds/treasury), WS-H (audits)] ── 22-ai-governed-rooms.md
```

Note: WS-L.1 (due diligence, document-only) starts in Wave 1 alongside WS-A. See `13-knomosis-and-wallets.md`. WS-R and WS-S are post-M3 extension workstreams from the standalone offline/private specifications; they are dependency-ordered after WS-Q and parallelizable with each other (WS-R Wave 10, WS-S Wave 11), with WS-S.1's server non-storage gates landable first. WS-T (conversation as comments, Wave 12) is a further post-WS-Q remodel of the WS-G/WS-Q conversation surfaces; it does not block WS-R/WS-S and may proceed in parallel (WS-S must exclude `private_p2p` rooms from WS-T's server-side SSE broadcast and reply notifications). WS-U (AI-governed rooms) is the maintainer's binding cross-cutting redesign (`22-ai-governed-rooms.md`): it re-scopes WS-K into the platform evaluation/transparency substrate and amends WS-J (platform legal floor + appeals), WS-L (Lex bounds + non-key-holding agent submitter), and WS-M (elected steward + Knomosis-vote model/prompt approval + AI-executed treasury within bounds). It is doctrine-first (Stage 0, landed in the SPEC/policy/plan); its runtime lands in the six staged PRs of §U.7, gated by the fail-closed crypto flag for any treasury power. `private_p2p` (WS-S) rooms have no server treasury and no server-visible plaintext, so the in-room AI agent does not run on them (the server-hosted-content boundary is preserved).

---

## Milestone Gate Checklists

### M0 — Planning
**Ref:** Section 30.10

| Gate | WS | Requirement |
|---|---|---|
| Repository | WS-0 | Monorepo, TS strict, CI, security baseline, all tooling |
| Doctrine | WS-A | Signal matrix, moderation taxonomy, transparency dictionary, jurisdiction template, steward roles |
| No forbidden-signal ambiguity | WS-A.1.1 | Every prohibited signal documented with test requirement |
| Crypto non-blocking | WS-A | Crypto confirmed feature-flagged, fail-closed, non-blocking for alpha |
| Knomosis due diligence started | WS-L.1 | Commit pinned, threat model in progress, ADR drafted |

### M1 — Core social alpha
**Ref:** Sections 30.10, 30.11

| Gate | WS | Requirement |
|---|---|---|
| No-applause UI | WS-B | Zero likes/upvotes/hearts/reactions/karma/follower counts |
| PWA shell | WS-C | Installable, offline-tolerant, service worker, update prompt |
| Accounts | WS-D.1 | Registration, passwordless auth (WebAuthn + email-OTP + wallet), age gating |
| Privacy | WS-D.2 | Export, deletion, attention controls, settings |
| Story submission | WS-F | Link/original submission with dedup |
| Threads | WS-G | Thread reading, structured contributions, composer |
| Rooms | WS-G.2 | Room creation, listing, subscription |
| Reporting/blocking | WS-J.1 | Report, block, mute, appeal, published support contact |
| Moderation | WS-J.2 | Steward console with queue, actions, audit log |
| Event pipeline | WS-E.1 | Events ingested with privacy classification |
| PWAtt shadow | WS-E.2.1 | Computes scores, does not rank |
| UGC safety | WS-G.4 | DOMPurify + Trusted Types + strict CSP |
| Accessibility | WS-B | WCAG 2.2 AA alpha threshold (screen reader, focus, zoom, contrast) |
| Web security | WS-O.1 | No XSS, CSRF, or session vulnerabilities |
| Wallet disabled | WS-C.1.3 | Crypto flags false, fail-closed |
| Reproducible bundle | WS-O.3.1 | Strict CSP, no inline scripts, deterministic output |

### M2 — Invariant shadow

| Gate | WS | Requirement |
|---|---|---|
| MERI v0/v1 | WS-H.2 | Duplicate grouping and multi-dimensional independence |
| MFCI v0 | WS-H.3 | Shadow anomaly reports, no enforcement |
| SCOI v0 | WS-H.4.1 | Lens disagreement labels |
| PHI v0 | WS-H.6.1 | Narrow-loop detection |
| GWEI v0 | WS-H.5.1 | Cohort dashboards |
| Decision logs | WS-I.2.5 | Ranking decisions logged, reproducible |
| Explanations | WS-I.2.6 | User-facing distribution reasons |
| Feature store denylist | WS-I.2.1 | Payment/wallet data excluded at schema level |
| No hidden sanctions | WS-H.1.2 | Invariants report reason codes and fallback |

### M3 — Bounded ranking beta

| Gate | WS | Requirement |
|---|---|---|
| PWAtt bounded | WS-E.2.3 | Saturation curves, weights sum to 100% |
| MERI dampening | WS-H.2.2 | Active in ranking |
| MFCI queue | WS-H.3.4 | Abuse queue operational |
| SCOI context gates | WS-H.4.2 | Context cards on high-obstruction content |
| PHI dampening | WS-H.6.2 | Loop dampening active |
| GWEI audit | WS-H.5.2 | Experiment release gate |
| Ranking reproducible | WS-I.2.5 | From logs |
| Neutrality tests | WS-I.3 | All 10 pass |
| Core Web Vitals | WS-P.1.1 | LCP ≤ 2.5s, INP ≤ 200ms, CLS ≤ 0.1 at p75 |
| Transparency | WS-P.2 | Reports from live data |
| No-pay-to-rank | WS-I.3 | Tests pass even though crypto disabled/simulated |
| Content containment | WS-Q.4.2, WS-Q.4.4 | In-room content never reaches a global surface (ranked or fallback), proven in CI; home room required on every content item |

### M4 — Knomosis sim + testnet

| Gate | WS | Requirement |
|---|---|---|
| Knomosis pinned | WS-L.1 | Commit, deployment, contracts, Lean toolchain |
| Wallet UX | WS-L.2 | Connect/disconnect accessible |
| Governance sim | WS-L.4 | Simulated proposals and treasury |
| Testnet gateway | WS-L.3 | Preflight, submit, receipt, reconciliation |
| Law-pack registry | WS-M.1.3 | MVP template operational |
| Testnet treasury | WS-M.2 | Treasury with test assets |
| Room readiness | WS-M.1.2 | Checklist enforced |
| Security | WS-O | No launch-blocking wallet/gateway issues |
| Emergency holds | WS-L.3.5 | All kill switches operational |
| Lean/Sol/Rust CI | WS-L.1 | Cross-stack fixtures pass |

### M5 — Capped real-funds pilot

| Gate | WS | Requirement |
|---|---|---|
| Legal approval | WS-N | Per jurisdiction |
| External audit | WS-O | Wallet flows, gateway, contracts |
| Treasury caps | WS-M.2 | Caps, timelocks, freeze operational |
| Compliance | WS-N.2 | Financial case management live |
| Neutrality with real payments | WS-I.3 | Tests pass with real payment events in staging |
| Incident drills | WS-O.2 | Treasury incident response tested |
| Review board | WS-P | Weekly go/no-go |
| Risk disclosures | WS-N.1.2 | Published |
| Bug bounty | WS-L.1.3 | Live |

### M6 — Mature launch
**Ref:** Section 30.11

| Gate | WS | Requirement |
|---|---|---|
| Core social value | WS-P.1 | Product-health metrics healthy without crypto |
| Safety metrics | WS-J | Incident rate, appeal quality, SLAs within target |
| Invariant stability | WS-H | All stable and auditable |
| Continuous neutrality | WS-I.3 | Continuously tested |
| Accessibility | WS-B | Production threshold WCAG 2.2 AA |
| Security | WS-O | High-severity resolved |
| Transparency | WS-P.2 | Reports from logs |
| Independent rollback | WS-O.2.2, WS-L.3.5 | Each feature rolls back independently |
| Non-crypto usability | M6 gate | User can use full social product without wallet |
| Moderation override | M6 gate | Platform can moderate harmful content regardless of local governance votes |

---

## Parallel Execution Map

### Wave 1 (Week 1-2): Foundation
**Estimated team:** 2-3 engineers

- WS-0 (all tasks) -- `01-repository-foundation.md`
- WS-A (all tasks -- document-only, parallel with WS-0) -- `02-doctrine-and-policy.md`
- WS-L.1 (due diligence -- document-only, can start immediately) -- `13-knomosis-and-wallets.md`

### Wave 2 (Week 2-4): Core infrastructure
**Estimated team:** 3-4 engineers

- WS-B.1 (design tokens, primitive components, layout, focus management) -- `03-design-system.md`
- WS-C.1 (TanStack Router, Query, Zustand) -- `04-pwa-client.md`
- WS-D.1.1 (User schema) -- `05-identity-and-privacy.md`
- WS-D.1.2-D.1.4 (WebAuthn + passwordless email-OTP/wallet auth) -- `05-identity-and-privacy.md`
- WS-O.1 (security test framework) -- `16-security-and-reliability.md`

### Wave 3 (Week 4-8): Core social product
**Estimated team:** 4-6 engineers

- WS-B.2 (story cards, labels, context cards, states, reader, stopping cues, feed modes) -- `03-design-system.md`
- WS-C.2 (service worker, offline store, background sync, push notifications) -- `04-pwa-client.md`
- WS-C.3 (Hono RPC client) -- `04-pwa-client.md`
- WS-D.1.5-D.1.7 (MFA, auth middleware, age gating) -- `05-identity-and-privacy.md`
- WS-D.2 (privacy controls) -- `05-identity-and-privacy.md`
- WS-F.1 (story schema, claims, URL canon, submission API) -- `07-ingestion-and-search.md`
- WS-J.1 (report, block, mute, appeal) -- `11-trust-and-safety.md`

### Wave 4 (Week 6-10): Content and conversation
**Estimated team:** 5-7 engineers

- WS-E.1 (event schemas and ingestion) -- `06-event-pipeline-and-pwatt.md`
- WS-C.4 (signal processor -- depends on WS-E.1.1) -- `04-pwa-client.md`
- WS-F.2-F.3 (source model, search, embeddings) -- `07-ingestion-and-search.md`
- WS-G.1 (thread/contribution/evidence schemas) -- `08-forum-and-conversation.md`
- WS-G.2 (rooms, lenses) -- `08-forum-and-conversation.md`
- WS-G.3 (composer -- all sub-tasks) -- `08-forum-and-conversation.md`
- WS-G.4 (UGC sanitization) -- `08-forum-and-conversation.md`
- WS-J.2 (moderation console -- all sub-tasks) -- `11-trust-and-safety.md`

### Wave 5 (Week 8-14): Signals and invariants
**Estimated team:** 5-7 engineers

- WS-E.2 (PWAtt v0, anti-signals, v1) -- `06-event-pipeline-and-pwatt.md`
- WS-H.1 (invariant platform) -- `09-invariant-services.md`
- WS-H.2 (MERI v0, v1, UI) -- `09-invariant-services.md`
- WS-H.3 (MFCI v0 cheap stats, contingency tables, v1 fiber test, enforcement) -- `09-invariant-services.md`
- WS-H.4 (SCOI v0, v1, UI) -- `09-invariant-services.md`
- WS-H.5 (GWEI v0, v1) -- `09-invariant-services.md`
- WS-H.6 (PHI v0, v1) -- `09-invariant-services.md`
- WS-H.7 (supporting invariants) -- `09-invariant-services.md`
- WS-K (AI governance) -- `12-ai-governance.md`

### Wave 6 (Week 12-18): Ranking and operations
**Estimated team:** 4-6 engineers

- WS-I (candidate gen, feature store, safety filter, scoring, diversification, logging, explanations, kill switch, neutrality tests) -- `10-ranking-and-distribution.md`
- WS-P (metrics, anti-metrics, experiments, transparency, i18n) -- `17-experimentation-and-launch.md`
- WS-O.2 (incident response playbook, emergency flags) -- `16-security-and-reliability.md`
- WS-O.3 (reproducible builds, provenance, SBOM) -- `16-security-and-reliability.md`

### Wave 9 (post-WS-I): Content–room ownership and visibility

- WS-Q (room-owned content, binary room visibility + join/posting axes, public/in-room content visibility, image/video posts, tier-scoped dedup, visibility-scoped retrieval/search/distribution, behavior-preserving migration) -- `18-content-and-room-model.md`. Remodels shipped WS-F/WS-G/WS-I surfaces; lands before WS-J takes queue ownership.

### Wave 10 (extension; post-WS-Q): Offline content availability (LCAP)

- WS-R (LCAP v0.2: deterministic CBOR/CID/COSE foundations → identity/capabilities/revocations → event/block/pack model → lane scheduler → sync/reconciliation/trust projection → room logs/checkpoints/witnesses → liveness/storage → server ingestion → conflict/privacy/DoS controls → manual bundle/QR/relay transports → client trust labels → simulation/acceptance) -- `19-offline-content-availability.md`. Net-new `packages/lcap` + `apps/{web,api}/src/lcap` + `lcap_*` DB tables; touches the running app only at the SW/IndexedDB/doctrine-gate seams. Foundation sub-area WS-R.0 gates everything.

### Wave 11 (extension; parallel with Wave 10): Private P2P rooms (E2EE)

- WS-S (private P2P rooms: room-class model + server non-storage gates → private schemas/canonical encoding → MLS/HPKE/Ed25519/HKDF crypto → private Helia/libp2p profile → op-log + deterministic reducer → sync/blind-rendezvous → private-room UI → media → migration → update-channel transparency → audit/launch) -- `20-private-p2p-rooms.md`. New `packages/private-p2p` + lazily code-split `apps/web/src/private-p2p` + `private_room_stubs`/`private_rendezvous_records` tables + defensive guards on existing server surfaces. WS-S.1 (server non-storage gates) is landable first, independent of the crypto/P2P stack.

### Extension workstreams: execution order (WS-R / WS-S)

WS-R and WS-S depend only on completed core workstreams (WS-C/D/E/F/G/Q), are **largely independent** (different crypto suites — ES256 vs Ed25519/MLS — and different canonical encoders — LDC vs DAG-CBOR — so no shared crypto code), and couple only softly: WS-S.6.5 MAY reuse the WS-R `.licio-bundle` pack as its CAR (falling back to IPLD CAR), and WS-R.16.1 is a thin carrier that defers all key authority to WS-S. Recommended sequence:

1. **WS-S.1 first, immediately** — the server non-storage gates + seven CI checks. Cheapest, lowest-risk, independent of the whole crypto/P2P stack; landing it early makes it structurally impossible for any later code to leak private content server-side.
2. **In parallel from the start:** WS-R.0 (LCAP foundations) **and** the WS-S long-lead due-diligence — select/audit the MLS/HPKE/curve libraries (§30.1–§30.2), confirm the dependency-budget isolation (S.2.1), and kick off the external cryptography review. Also schedule the **WS-O reproducible-build + transparency-log slice** that S.10 depends on.
3. **WS-R in full** (Wave 10) — the content-addressed availability substrate. Lower risk, WebCrypto-native, no exotic deps, and shortest path to visible value (offline outbox + honest trust labels by Phase 1). Its pack/CAR + lane scheduler + liveness UX then make WS-S cheaper.
4. **WS-S core** (Wave 11) — the E2EE plane. Can overlap Wave 10 once S.1/S.2 and the library selection are done; with two teams it runs concurrently (WS-S is the long pole, ~18–24 wks), with one team it follows WS-R.
5. **Converge at the close:** WS-R.16 (private-room carrier) + WS-S.6.5 (LCAP-bundle CAR) co-land once the WS-S envelope (S.3.3a/b) exists, then the external audits + WS-R §36 / WS-S §29 launch gates.

Hard constraints: **WS-R.0 and WS-S.2 gate everything** within their workstreams (start nothing ahead of them); both intra-workstream graphs are **acyclic** (the two first-cut cycles were removed). **WS-S.10 (update channel) ⟶ WS-O** — if the WS-O reproducible-build/transparency slice is not ready, ship WS-S at **Tier 1** with the documented "no defense against a malicious web update" limitation and backfill Tier 2/3. The MLS/HPKE library audit and the external crypto review **gate the close, not the start** — begin them in Wave 10a. Per-card ordering within each workstream is fixed by the dependency graph at the end of each document.

### Wave 7 (Week 16-22): Knomosis
**Estimated team:** 3-4 engineers

- WS-L.2 (wallet -- provider discovery, WalletConnect, SIWE, verification, API, previews) -- `13-knomosis-and-wallets.md`
- WS-L.3 (gateway -- knomosis-gateway HTTP/JSON+SSE contract: preflight, signed-action submit/verdict, event-stream ingestion, reconciliation, emergency flags, ranking-firewalled standing reads) -- `13-knomosis-and-wallets.md`
- WS-L.4 (governance simulation) -- `13-knomosis-and-wallets.md`

### Wave 8 (Week 20-26): Treasury and compliance
**Estimated team:** 3-5 engineers

- WS-M.1 (governance profiles, readiness checklist, law-pack registry) -- `14-treasury-and-governance.md`
- WS-M.2 (treasury schema, deposits, spend auth, freeze, ledger) -- `14-treasury-and-governance.md`
- WS-M.3 (payment intents) -- `14-treasury-and-governance.md`
- WS-M.4 (proposals -- creation, voting, execution) -- `14-treasury-and-governance.md`
- WS-N (jurisdiction engine, compliance, sanctions, support) -- `15-compliance.md`

---

## Task Sizing Reference

Per Section 30.8:

| Task type | Sizing rule | Example |
|---|---|---|
| Backend | One schema/API/job/dashboard | WS-D.1.1 (User schema) |
| Client | One user-journey state (empty/loading/success/error/offline/safety/a11y) | WS-B.2.5 (state components) |
| Invariant | Input/output/confidence/failure-mode/one consumer | WS-H.2.1 (MERI v0) |
| Moderation | Policy reason/permissions/notice/appealability/audit/rollback | WS-J.2.3 (action palette) |
| Privacy | Data element/purpose/retention/access/export/deletion/legal | WS-D.2.3 (attention deletion) |
| Release | Feature flag/metric guardrail/owner/rollback trigger/review date | WS-L.3.5 (emergency flags) |

Tasks exceeding three days must be split into sub-tasks that are independently reviewable, testable, and reversible.

---

## Risk Mitigation Matrix

| Risk | Severity | Mitigation tasks |
|---|---|---|
| XSS → wallet drain | Critical | WS-0.5.1 (CSP/Trusted Types day 1), WS-G.4 (DOMPurify), WS-O.1.1 (XSS tests), WS-0.4.1 (Biome blocks unsafe DOM) |
| Supply-chain compromise | Critical | WS-0.2.1 (pnpm strict), WS-0.4.4 (lockfile-lint), WS-0.6.2 (dep scanning), WS-O.3.2 (SBOM + provenance) |
| Pay-to-rank leakage | Critical | WS-A.1.1 (signal denylist), WS-I.2.1 (feature store denylist), WS-I.3 (10 neutrality tests), WS-D.3.1 (schema isolation) |
| Attention surveillance | High | WS-C.4 (in-browser processing), WS-D.2 (privacy controls), WS-E.1 (aggregation, retention limits) |
| False coordination positives | High | WS-H.3 (MFCI base-rate conditioning), WS-J.1.3 (appeals), WS-H.3.4 (human review) |
| Invariant cold start | High | WS-H.1.2 (fallback behavior), WS-E.2.1 (shadow mode), WS-I.2.7 (kill switch) |
| iOS storage eviction | Medium | WS-C.2.2 (eviction detection + resync), WS-C.2.3 (background sync queue) |
| Accessibility regression | High | WS-B (accessible from start), WS-0.4.3 (Playwright + axe-core CI gate), WS-B.1.6 (SPA focus management) |
| Cold start | Medium | WS-F.1.4 (freshness baseline), WS-I.1.1 (diversity quotas), WS-G.2 (room seeding) |
| Phishing PWA | High | WS-O.3.2 (signed provenance), WS-L.2.6 (transaction previews), WS-0.5.1 (strict CSP) |
| Governance capture | High | WS-M.4.2 (anti-capture controls), WS-H.3 (MFCI monitoring), WS-M.1.2 (readiness checklist) |
| In-room content leak | High | WS-Q.3.2 (item read bar, fail-closed), WS-Q.4.2 (always-on distribution-side visibility gate), WS-Q.4.4 (containment CI gate), WS-Q.6.1 (monotonic-visibility migration harness) |
| Smart contract bug | Critical | WS-L.1.2 (threat model), WS-L.1.3 (external audit), WS-M.2.4 (freeze), WS-L.3.5 (kill switches) |
| Regulatory noncompliance | High | WS-N.1 (jurisdiction engine), WS-A.2.1 (matrix), WS-N.2 (compliance controls), fail-closed default |
| Offline false certainty / stale revocation | High | WS-R.8 (explicit trust-state projection), WS-R.1.4 + WS-R.7.1 (P0 revocation propagation), WS-R.17.1 (honest trust/liveness labels, no single "verified" badge) |
| Malicious bundle / dependency bomb (LCAP) | High | WS-R.4.2 (streaming parse under caps), WS-R.14.1 (resource caps + malicious-graph detection), WS-R.18.4 (fuzz + bomb suite), WS-R.8.3 (no render before trust projection) |
| Malicious web update exfiltrates room keys | Critical | WS-S.10.1/10.2 (reproducible, signed, transparency-logged private bundle; rooms lock before key unlock), WS-S.10.3 (Tier-3 local key agent), honest Tier-1 limitation copy (WS-S.0.3) |
| Private content/metadata leak to server | Critical | WS-S.1 (server non-storage contract: column denylist + endpoint guards + retriever/search/event exclusion + 7 CI gates), WS-S.11.2 (request-capture E2E), WS-S.6.1 (blind rendezvous), WS-S.4.4 (no public-gateway egress) |
| Removed member retains future access | High | WS-S.3.1 + WS-S.5.1 (MLS remove → epoch rotation → new keys/topics/blind-ids), WS-S.3.7 (removed-member-cannot-decrypt-future-epoch property), honest non-retroactive-deletion disclosure (WS-S.0.3) |

---

## Cross-Workstream Conventions

- **Unique task IDs.** Every task has a unique ID (e.g., WS-0.1.1), a definition of done, and a spec-section reference.
- **Explicit dependencies.** Dependencies are explicit and enforced; no task may begin before its predecessors are merged.
- **Security rationale.** Security rationale is provided where the spec mandates it, traceable to Section 25.
- **Crypto feature flags.** All crypto features are behind feature flags, disabled by default (Section 17.1). No task blocks the core social product on crypto availability.
- **Accessibility gate.** WCAG 2.2 AA is a release gate at every milestone (Section 26).
- **Test coverage.** Unit tests (Vitest), E2E tests (Playwright + axe-core), security tests, and neutrality tests are required per the task's definition of done.

---

## Open Questions
**Ref:** Section 33

1. Minimum viable SCOI without over-relying on language models (Section 10)
2. How much attention aggregation can run in-browser given storage-eviction limits (Sections 5, 6)
3. Source profile editability -- stewards, staff, or both (Section 14)
4. Which transparency metrics are useful without exposing manipulation defenses (Section 28)
5. Pseudonymity balance -- protect vulnerable speakers, limit abuse (Section 19)
6. Local room launch strategy -- avoid empty/captured communities (Section 16)
7. Chronological vs invariant-constrained ranking balance (Section 13)
8. Revenue structure avoiding attention-extraction pressure (Section 27)
9. Which invariant explanations should be public vs internal (Sections 7-12)
10. Exact Knomosis production commit, chain IDs, contract addresses (Section 17)
11. Custody model per jurisdiction -- non-custodial, partner, first-party (Sections 17, 18)
12. Allowed assets and governance weight model for pilot rooms (Section 16)
13. Room fork/exit interaction with treasury assets (Section 16)
14. Bridge/fault-proof/finality assumptions for transaction previews (Section 17)

---

## Tech Stack Summary

| Layer | Technology | Spec Ref |
|---|---|---|
| Language | TypeScript 6.x strict | Section 6 |
| Package manager | pnpm | Section 6 |
| Bundler | Vite 8 (Rolldown) | Section 6 |
| UI framework | React 19 | Section 6 |
| Routing | TanStack Router | Section 6 |
| Data fetching | TanStack Query v5 | Section 6 |
| State management | Zustand | Section 6 |
| PWA | vite-plugin-pwa (Workbox 7) | Section 20 |
| Styling | Tailwind CSS 4 | Section 6 |
| Sanitization | DOMPurify (Trusted Types) | Section 25 |
| Validation | zod | Section 6 |
| BFF | Hono | Section 21 |
| ORM | Drizzle ORM | Section 21 |
| Runtime | Node.js LTS | Section 21 |
| Logging | pino | Section 21 |
| Unit tests | Vitest | Section 30 |
| E2E tests | Playwright + axe-core | Section 30 |
| Linting/formatting | Biome | Section 6 |
| Supply-chain | lockfile-lint | Section 25 |
| License | AGPL-3.0-or-later | Section 0 |

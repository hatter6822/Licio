# Licio Implementation Plan — Master Index

**Version:** v4.0
**Source specification:** docs/SPEC.md v0.6
**Date:** June 7, 2026

This plan decomposes the Licio specification into 17 workstream documents housed in `docs/planning/`. Each document is independently actionable, dependency-ordered, and composed of **~646 atomic tasks** targeting 0.5-2 engineering days each. Every task carries a unique ID, a spec reference (`Ref:`), a description, measurable acceptance criteria, testing requirements, and explicit dependencies; data-bearing tasks include Drizzle/zod schemas and API request/response shapes. Tasks are independently reviewable, testable, and reversible per Section 30.8. The plan follows the spec's milestone structure (M0-M6), workstream labels (0, A-P), and the critical-path ordering from Section 30.2.

**Revision history:**
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
| `13-knomosis-and-wallets.md` | WS-L | M4 | P4 | 1+7 | 61 | Due diligence, wallet integration, gateway, simulation |
| `14-treasury-and-governance.md` | WS-M | M4-M5 | P4-5 | 8 | 49 | Room governance, treasury, payments, proposals, action budgets |
| `15-compliance.md` | WS-N | M5 | P4-5 | 8 | 27 | Jurisdiction engine, financial compliance, support |
| `16-security-and-reliability.md` | WS-O | M0-M6 | P0 | 2+6 | 46 | Security testing, integrity defense, incident response, reproducible builds, reliability/DR |
| `17-experimentation-and-launch.md` | WS-P | M3-M6 | P3 | 6 | 32 | Product metrics, anti-metrics, experiments, transparency, i18n |
| **Total** | | | | | **~646** | Atomic tasks across 17 workstreams (~22,900 lines) |

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
 │    │         ├── WS-K (AI governance) ── 12-ai-governance.md
 │    │         └── WS-L (Knomosis) → depends on WS-D.3, WS-O ── 13-knomosis-and-wallets.md
 │    │              └── WS-M (Treasury/governance) ── 14-treasury-and-governance.md
 │    │                   └── WS-N (Compliance) ── 15-compliance.md
 │    └── WS-J (Trust/safety) [no dependency on WS-G — reports work before forum] ── 11-trust-and-safety.md
 ├── WS-O (Security — continuous) ── 16-security-and-reliability.md
 └── WS-P (Metrics/experiments — from M3 onward) ── 17-experimentation-and-launch.md
```

Note: WS-L.1 (due diligence, document-only) starts in Wave 1 alongside WS-A. See `13-knomosis-and-wallets.md`.

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

### Wave 7 (Week 16-22): Knomosis
**Estimated team:** 3-4 engineers

- WS-L.2 (wallet -- provider discovery, WalletConnect, SIWE, verification, API, previews) -- `13-knomosis-and-wallets.md`
- WS-L.3 (gateway -- preflight, submission, indexer, reconciliation, emergency flags) -- `13-knomosis-and-wallets.md`
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
| Smart contract bug | Critical | WS-L.1.2 (threat model), WS-L.1.3 (external audit), WS-M.2.4 (freeze), WS-L.3.5 (kill switches) |
| Regulatory noncompliance | High | WS-N.1 (jurisdiction engine), WS-A.2.1 (matrix), WS-N.2 (compliance controls), fail-closed default |

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
| Language | TypeScript 5.x strict | Section 6 |
| Package manager | pnpm | Section 6 |
| Bundler | Vite 6 | Section 6 |
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

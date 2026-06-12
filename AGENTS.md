<!--
  Licio — Participation-Weighted Attention PWA
  Copyright (C) 2026  Adam Hall
  This program comes with ABSOLUTELY NO WARRANTY.
  This is free software, and you are welcome to redistribute it
  under certain conditions. See: https://github.com/hatter6822/Temp_Licio/blob/main/LICENSE
-->

<!--
  Adapted from the structure of Knomosis's CLAUDE.md
  (https://github.com/hatter6822/Knomosis/blob/main/CLAUDE.md)
  with project-specific guidance for Licio's TypeScript PWA monorepo.
-->

# CLAUDE.md — Licio project guidance

This file owns engineering conventions and the day-to-day developer /
agent workflow.  The design specification lives in `docs/SPEC.md`; the
planning index lives in `docs/planning/00-index.md`; the top-level
introduction lives in `README.md`.  Where this file disagrees with the
specification, the specification wins.

## What this project is

Licio is a **Progressive Web App** social news and forum platform that
replaces popularity voting with mathematical invariants and
participation-weighted attention.  Licensed under AGPL-3.0-or-later.

The platform implements a privacy-safe attention signal pipeline where
raw user engagement events are processed entirely in-browser, bucketed
into coarse aggregates (Section 22.1 `AttentionAggregate`), and only
those aggregates ever reach the network.  There are no likes, votes,
karma scores, follower counts, or reaction bars — enforced at the
type level, runtime, and CI (the no-applause static gate).

**Current status.**  Workstreams WS-0 (repository foundation), WS-A
(doctrine and policy), WS-B (design system), WS-C (PWA client
application), WS-D (identity, accounts, and privacy), WS-E (event
pipeline and PWAtt), WS-F (ingestion, source model, and search),
WS-G (forum and conversation), WS-H (core invariant services), and
WS-I (ranking and distribution) are **complete**.  WS-D ships the WebAuthn-first/passwordless authentication
foundation, secure server-side sessions, RBAC + audit log, age gating,
user-facing privacy controls (settings, DSAR export with an encrypted
signed-URL archive, and account deletion with a 30-day grace + hard
purge), steward TOTP MFA, and database-level wallet isolation
(`docs/identity/README.md`) — with production bindings (Postgres/Drizzle
identity/audit stores, Redis session/ephemeral/rate-limit stores, a
leased distributed privacy scheduler, an S3-compatible export-archive
store) and the full client surface (passkey-first login/registration,
the `/profile/security` management page, and real data-rights flows with
step-up gating).  Email delivery has a production SES binding (SigV4
over fetch, all-or-none `SES_*` env group) behind the fail-closed
`Mailer` selection.  WS-D residuals tracked elsewhere: browser-level
auth E2E (needs a BFF-in-the-loop harness; WS-P) — the WS-E and WS-G
injected hooks are all closed.
WS-E ships the event pipeline and PWAtt scoring engine
(`docs/events/README.md`): strict event schemas + a single topic registry
(14 core + 18 flagged Knomosis topics in a separate bounded context), the
hardened attention-ingestion boundary (auth, ownership, two-layer replay
protection, fail-closed sliding-window rate limits, server-side privacy
enforcement), a retention-tier-partitioned Postgres event store with
scheduled retention/anonymization sweeps + a compliance audit query, a
rebuildable Redis real-time layer (HyperLogLog uniques), the consumer
router enforcing the pay-to-rank firewall, PWAtt v0 in CI-verified shadow
mode (anti-signals: coordinated bursts, source-free accusations,
harassment-cascade freezes), the real owner-only Signal Ledger, and PWAtt
v1 saturation/weights/penalties (the §30.5 shadow stage was LIFTED by
WS-I: PWAtt now serves as a bounded ranking input — see WS-I below).
WS-F ships ingestion, the source model, and search
(`docs/ingestion/README.md`): `POST /v1/stories` for all six §14.1
submission types behind safety pre-checks (per-account sliding-window rate
limits, account-age gate, spam-title pattern, local malware denylist) and
three-level duplicate detection (canonical-URL 409 through the shared
normalizer, MinHash/LSH near-duplicate flagging, source-aware syndication
auto-link/candidate routing); a transactional thread shell per story; the
§14.4 lifecycle state machine with an append-only audit trail driven by
WS-E events + an hourly lease-guarded sweep; SSRF-hardened, robots.txt-
compliant, copyright-bounded metadata extraction riding the WS-E router as
durable consumers (retry/DLQ/checkpoint replay for free); no-truth-score
source profiles with steward editing + audited syndication edges; heuristic
candidate-claim extraction behind the WS-K seam; Postgres FTS search
(weighted generated tsvectors, visibility-filtered, keyset-paginated) and a
pgvector embedding store (HNSW, versioned vectors, resumable re-embedding
migration) behind self-hosted/deterministic providers; the versioned
freshness baseline for WS-I; the public takedown intake; the WS-F.2.5b
financial-denylist CI assertion; and `content.submitted`/
`content.normalized` emission (closing that WS-E residual).
WS-G ships forum and conversation (`docs/forum/README.md`): the
eleven-type §15.2 contribution taxonomy behind ONE shared
discriminated-union schema (client and server validate identically,
type-specific requirements like evidence citations and the
direct-experience privacy acknowledgment included), branch-aware
threads on a materialized-path tree (depth-capped, GIN-containment
subtree reads) with the §15.4 conversation/safety state machines
(table-driven legal-transition functions, audited transitions emitting
`thread.state.changed`), the WS-G.4 UGC pipeline (strict Markdown-lite
AST with no raw-HTML node → constrained serializer → DOMPurify
`licio-ugc` Trusted Types policy → THE single sanctioned
`dangerouslySetInnerHTML` sink) with the external-link safety
interstitial (drainer blocklist + dApp-mimicry heuristics) and
EXIF-stripped image uploads, dual-dimension evidence cards
(material type × claim relationship) shared with WS-F claims, §24.3
provenance-bearing summaries with uncertainty disclosure, rooms with
§16.2 join models, lenses, steward roles, audited governance settings
+ recommendation-input transparency, moderation-concern intake with
ratified WS-A reason codes routed to the review queue (WS-J seam),
conversation-health metrics, encrypted offline drafts with autosave/
recovery + PWA share-target intake, and the 11-mode structured
composer; it closes the WS-D contribution hooks
(`anonymizeContributions`, forum-composed `exportContributions`) and
the WS-E `low_info_reply` classifier + evidence-correlation residuals.
WS-H ships the eleven invariant services in shadow
(`docs/invariants/README.md`): the computation platform (the WS-H.1.1c
envelope on every `invariant_outputs` row, per-type score-vector zod
validation before insert, eleven validated invariant cards, the
fallback execution wrapper whose degraded outputs ranking treats as
ABSENT — proven with all eleven failing, the append-only WS-H.1.2e
promotion gate with the always-available demotion kill switch, the
lease-guarded hourly batch tier with bounded concurrency, uniform
health metrics, and the CI + nightly regression/drift harness over
deterministic synthetic datasets); MERI (exact partition-matroid rank
over exact-URL/near-dup/lineage/evidence classes, §7.5 gains, the
similarity fallback flagged MATROID_FALLBACK, the WS-E redundancy hook
closed); MFCI (the Markov-basis Metropolis–Hastings fiber test with
the add-one conditional p-value over account-age-bucketed tables,
volume-conditioned cheap statistics with versioned null calibrations,
identifier-free analyst cases whose clearing lifts safety freezes, the
WS-E mfci hook closed); GWEI (entropic-regularized Gromov–Wasserstein
upper bounds with seed/regularization stability intervals, the seven
§9.4 metrics, k-anonymity suppression, the release-gate decision, the
parity-statements-only transparency export); SCOI (sheaf Dirichlet
energy over embedding-captured lens interpretations, context states
where weaponized REQUIRES a safety signal, the H¹ structural
diagnostic); PHI (orthogonal transports from embedding-derived frames,
gauge-invariant holonomy scores with the near-π fallback, the
conjugation verifier + output-boundary scan, privacy-preserving
session sequences — topic-cluster ids + timing only, TTL'd, capped);
the six supporting invariants (Hodge Helmholtz decomposition with
HarmfulTensionRisk ≡ 0 absent hostility, tropical cascade timing,
Burau-bounded braid entropy, Reeb join/split landscapes with fragile
saddles, CID over verified permutation groups, depth-3 path
signatures); the steward/analyst admin surface; the public
interpretation/lineage reads; and the client surfaces (exposure
labels, the independent-sources drawer, "Where interpretations
differ", the composer context warning, the narrow-loop wellbeing
prompt, PHI-4 reset/reduce-personalization controls, the per-topic
repeats preference).
WS-I ships ranking and distribution (`docs/ranking/README.md`): the
eight-stage SPEC §13.3 pipeline behind `GET /v1/feed` (front page +
`?topic=` topic surface) and `GET /v1/rooms/:roomId/feed` (room surface
gated by WS-G content visibility, with REAL lens-tagged balancing) —
eight organic candidate retrievers (+ the room-surface scoper) with
ceil-reserved, jointly-protected diversity quotas, the strict
WS-I.2.1a feature store (append-only revisions, the WS-I.2.1b financial
denylist on the SHARED WS-A.1.1 term list — pinned to a versioned
artifact — at every write, invariant version/config-hash traceability,
real-time router consumer on `invariant.run.completed` AND the MFCI
intake path's `integrity.signal.detected` + hourly batch, by-timestamp
snapshot reads, BFS chain near-dup clustering), the non-overridable
batched safety filter (WS-J seam), deterministic constrained PWAtt
scoring (§5.4 exactly; §5.5-guardrailed versioned profiles with
profile-configured baseline weights; penalties and constraints enforced
ONLY through the WS-H promotion gate — computed and logged otherwise;
the recency-windowed, suppression-aware GWEI gate with the
documented-owner override), MERI cluster dedup (demoted siblings serve
as `more_on_this_story`) + source/topic/lens balancing + SCOI context
gating (wire-borne `context_card`) + PHI per-user diversification (max
over recent session buckets), EXACTLY one replayable
`RankingDecisionLog` per served request (privacy-bucketed, §22.4
retention, replay at recorded feature revisions/profile snapshot/
enforcement flags/lens assignments — backward-compatible with pre-
upgrade snapshots, a scheduled replay-regression sample), per-item
template explanations that structurally cannot emit prohibited
phrasings (locale-ready rendering with the x-pseudo proof; the story
page links each reason to the reader's own Signal Ledger), the runtime
kill switch (global/surface/profile scopes, audited, fail-closed on
unreadable state) over the score-blind chronological fallback, the
steward audit surface (six query dimensions over TRUE SQL keyset
pagination, meta-audited reads, feature snapshots), and the ten-test
ranking-neutrality suite as a named CI gate (`pnpm check:neutrality`;
transitive import-closure walk, router-published financial events,
introspected health payloads, the room-surface leg).  WS-I performs the
documented §30.5 lift: `PWATT_V0_SHADOW_MODE` is now `false` (a code
change; reverting it or engaging the kill switch restores the pre-lift
posture).
Workstreams WS-J through WS-P are planned (planning documents
exist under `docs/planning/`; implementation not yet started).  See
"Implementation roadmap" below for the full status table.

## Build and run

```bash
# Prerequisites: Node 22+ (pinned in .nvmrc), pnpm 9.15.4+.
corepack enable && corepack prepare pnpm@9.15.4 --activate
pnpm install

# Daily commands.
pnpm dev                            # web (5173) + api (3001) concurrently
pnpm build                          # shared → db/invariants → web/api
pnpm test                           # Vitest across all workspaces (80% coverage gate)
pnpm test -- --coverage             # with coverage report
pnpm test:e2e                       # Playwright E2E (Chromium, Firefox, WebKit)
pnpm lint                           # Biome check (format + lint)
pnpm lint:fix                       # auto-fix lint issues
pnpm typecheck                      # TypeScript strict-mode across all workspaces

# Security and static gates.
pnpm lint:security                  # innerHTML, eval, javascript: URL scan
pnpm lint:lockfile                  # lockfile integrity
pnpm check:deps                     # dependency-budget enforcement
pnpm check:workspace-deps           # workspace boundary enforcement (pkg.json + imports)
pnpm check:policy                   # doctrine/policy document validation
pnpm check:neutrality               # the ten WS-I.3 ranking-neutrality tests
pnpm check:no-applause              # no likes/votes/karma/reactions in components
pnpm check:no-raw-egress            # no raw attention traces leaving the browser
pnpm check:sw                       # SW security scan (run after build)

# Supply chain and build validation.
pnpm sbom                           # CycloneDX SBOM (includes transitive deps)
pnpm clean                          # remove build artifacts

# Database (development).
pnpm db:generate                    # generate Drizzle migrations
pnpm db:migrate                     # run Drizzle migrations
pnpm db:push                        # push schema directly (development only)

# Per-workspace.
pnpm --filter web dev               # Vite dev server (port 5173)
pnpm --filter api dev               # Hono BFF dev server (port 3001)
pnpm --filter web build             # production web build
pnpm --filter api build             # production API build
pnpm --filter web gen:tokens        # regenerate design tokens CSS from SSOT
pnpm --filter web test:e2e          # Playwright E2E tests
pnpm --filter @licio/shared build   # build shared package
pnpm --filter @licio/db build       # build database package
pnpm --filter @licio/invariants build  # build invariants package
pnpm --filter @licio/ranking build  # build ranking package
```

`package.json` (root and per-workspace) is the source of truth for
every build command; consult it before adding new scripts.

**Toolchain.**  Node 22 (pinned in `.nvmrc`), pnpm 9.15.4 (pinned
in `package.json` `packageManager`), TypeScript 6.0.3, Vite 8.0.16,
Biome 2.4.16.

## Pre-commit verification (mandatory)

Before committing any source file, run the relevant checks:

```bash
pnpm typecheck                      # strict-mode compilation
pnpm lint                           # Biome format + lint
pnpm test                           # Vitest (80% coverage threshold)
```

After any source change, also run:

* `pnpm lint:security` — catches `innerHTML`, `outerHTML`,
  `document.write()`, `eval()`, `new Function()`, and `javascript:`
  URLs that Biome 2.x cannot block at the AST level.
* `pnpm check:deps` — fails if a workspace exceeds its dependency
  budget (web < 15, api < 20 direct production deps).
* `pnpm check:workspace-deps` — fails if a package imports across
  a forbidden workspace boundary (e.g. web importing `@licio/db`).
* `pnpm check:no-applause` — fails if like/vote/karma/reaction
  affordances appear in `apps/web/src/components/`.
* `pnpm check:no-raw-egress` — fails if raw attention traces
  (scrollX, clientY, dwellMs, etc.) appear in the signals layer or
  if the signals layer imports anything other than the bucketed
  aggregate uploader.

After a production build (`pnpm --filter web build`):

* `pnpm check:sw` — fails if the built service worker contains
  remote `importScripts`, `eval()`, or `new Function()`.

CI (`.github/workflows/ci.yml`) runs all of the above on every PR.

## Source layout

```
licio/
├── package.json                 -- monorepo root (scripts, workspace config)
├── pnpm-workspace.yaml          -- pnpm workspace definition
├── tsconfig.json                -- root TypeScript config
├── tsconfig.base.json           -- base TypeScript config (shared settings)
├── vitest.config.ts             -- Vitest root run + cross-workspace coverage gate
├── vitest.shared.ts             -- per-project test settings SSOT (root + per-workspace)
├── biome.json                   -- Biome linter/formatter (2.4.16)
├── lefthook.yml                 -- Git hooks
├── docker-compose.yml           -- local dev services (pgvector-enabled PostgreSQL, Redis)
├── .nvmrc                       -- Node 22 pin
├── CLAUDE.md                    -- this file
├── README.md                    -- project entry point
├── SECURITY.md                  -- vulnerability disclosure policy
├── CONTRIBUTING.md              -- contribution guidelines
├── CODE_OF_CONDUCT.md           -- community standards
├── apps/
│   ├── web/                     -- React 19 PWA (Vite 8 / Rolldown)
│   │   ├── vite.config.ts       --   build config, PWA manifest, CSP headers
│   │   ├── playwright.config.ts --   E2E config (Chromium, Firefox, WebKit)
│   │   ├── index.html           --   entry HTML (no inline scripts)
│   │   ├── public/
│   │   │   └── sw-push.js       --   push + background-sync + share-target handler
│   │   └── src/
│   │       ├── main.tsx                 -- app entry point
│   │       ├── routeTree.gen.ts         -- auto-generated route tree
│   │       ├── components/
│   │       │   ├── ui/                  -- 32 reusable UI primitives
│   │       │   ├── a11y/                -- RouteAnnouncer, SkipToContent, useSpaFocus
│   │       │   ├── cognitive/           -- DefinedTerm, ProgressiveDisclosure, jargon
│   │       │   ├── composer/            -- 11-mode ParticipationComposer + shared-schema
│   │       │   │                           payload builder, VoiceDictation (WS-G.3)
│   │       │   ├── feed/                -- FeedModeSwitcher, DiminishingReturnsPrompt
│   │       │   ├── story/               -- StoryCard, ContextCard, RatingLabel,
│   │       │   │                           ExposureLabel, IndependentSourcesDrawer,
│   │       │   │                           WhereInterpretationsDiffer (WS-H)
│   │       │   ├── thread/              -- ThreadBranchNav
│   │       │   ├── ugc/                 -- UgcBody (THE sanctioned UGC sink, WS-G.4.2b)
│   │       │   │                           + LinkInterstitial (WS-G.4.2c)
│   │       │   ├── reader/              -- SourceReader + readability worker
│   │       │   ├── profile/             -- SignalLedger
│   │       │   ├── security/            -- StepUpDialog + step-up retry gate
│   │       │   ├── i18n/                -- TranslationDisclosure
│   │       │   └── wellbeing/           -- FocusModeToggle, NotificationBudget,
│   │       │                               NarrowLoopPrompt (WS-H.6.1c)
│   │       ├── stores/                  -- Zustand state (3 stores)
│   │       │   ├── auth.ts              --   session + cross-tab logout
│   │       │   ├── ui.ts                --   theme, motion, feed mode, focus
│   │       │   ├── feature-flags.ts     --   fail-closed feature gates
│   │       │   ├── persist.ts           --   zod-validated localStorage
│   │       │   └── dom-sync.ts          --   DOM synchronization
│   │       ├── lib/                     -- core utilities
│   │       │   ├── api.ts               --   typed RPC client + CSRF serialization
│   │       │   ├── auth-api.ts          --   WS-D auth flows (passkey/email login, signup)
│   │       │   ├── webauthn.ts          --   WebAuthn JSON↔ArrayBuffer plumbing
│   │       │   ├── privacy-api.ts       --   WS-D data-rights flows (export, deletion)
│   │       │   ├── link-safety.ts       --   WS-G external-link verdicts (shared heuristics)
│   │       │   ├── queries.ts           --   TanStack Query hooks
│   │       │   ├── query-keys.ts        --   query-key factory
│   │       │   ├── query-client.ts      --   SWR defaults (30s stale, 5min gc)
│   │       │   ├── bootstrap.ts         --   app initialization
│   │       │   ├── sw-register.ts       --   service-worker registration
│   │       │   ├── telemetry.ts         --   privacy-safe RUM (sendBeacon)
│   │       │   ├── time.ts              --   time utilities
│   │       │   └── cn.ts               --   class-name merger
│   │       ├── offline/                 -- offline-first (IndexedDB)
│   │       │   ├── db.ts                --   5 object stores, versioned migrations
│   │       │   ├── store.ts             --   zod-validated integrity layer
│   │       │   ├── queue.ts             --   pending-operation sync queue
│   │       │   ├── sync.ts              --   sync engine
│   │       │   ├── drafts.ts            --   draft management
│   │       │   ├── draft-crypto.ts      --   AES-256-GCM (non-extractable key)
│   │       │   ├── read-through.ts      --   cache read-through mapping
│   │       │   ├── schemas.ts           --   offline record schemas
│   │       │   ├── notification-meter.ts--   per-day notification budget
│   │       │   └── eviction.ts          --   iOS eviction detection + reconciliation
│   │       ├── signals/                 -- attention signal pipeline
│   │       │   ├── processor.ts         --   main signal processor
│   │       │   ├── aggregate.ts         --   bucketed aggregate builder
│   │       │   ├── privacy.ts           --   assertNoRawEgress guard
│   │       │   ├── dwell.ts             --   active-dwell accumulator
│   │       │   ├── visibility.ts        --   visibility tracking
│   │       │   ├── visibility-cadence.ts--   visibility sampling
│   │       │   ├── cadence.ts           --   signal emission cadence
│   │       │   ├── return-tracker.ts    --   return-visit + rage-loop dampening
│   │       │   ├── return-store.ts      --   LRU return persistence
│   │       │   ├── source-tracker.ts    --   source-open tracking
│   │       │   ├── caps.ts              --   per-item dwell caps
│   │       │   ├── topic-loops.ts       --   PHI v0 session topic-loop tracker (WS-H)
│   │       │   └── runtime.ts           --   runtime signal management
│   │       ├── security/
│   │       │   └── trusted-types.ts     --   TT policies (origin comparison)
│   │       ├── routing/                 -- route guards + search
│   │       ├── routes/                  -- TanStack Router file-based routes
│   │       │   ├── __root.tsx           --   root layout, AppShell, BottomNav
│   │       │   ├── index.tsx            --   front page
│   │       │   ├── stories.$storyId.tsx --   story detail
│   │       │   ├── threads*.tsx         --   thread views + branches
│   │       │   ├── rooms*.tsx           --   room views + governance
│   │       │   ├── profile*.tsx         --   profile, settings, privacy, security, saved
│   │       │   ├── submit.tsx           --   content submission (auth-guarded)
│   │       │   └── -pages/              --   internal page components
│   │       ├── design-system/           -- design-token SSOT
│   │       │   ├── tokens.ts            --   55 color tokens, light/dark palettes
│   │       │   ├── css.ts               --   CSS utility generation
│   │       │   └── contrast.ts          --   WCAG contrast validation
│   │       ├── i18n/                    -- internationalization
│   │       │   ├── catalog.ts           --   translation catalog
│   │       │   ├── message.ts           --   message formatting + pluralization
│   │       │   ├── format.ts            --   number/date formatting
│   │       │   ├── pseudo.ts            --   pseudo-localization (testing)
│   │       │   └── I18nProvider.tsx      --   context provider
│   │       ├── hooks/                   -- reusable React hooks
│   │       ├── perf/                    -- Web Vitals + performance marks
│   │       ├── push/                    -- push subscription + usePushControls
│   │       ├── styles/                  -- app.css + tokens.generated.css
│   │       ├── styleguide/              -- component browser
│   │       ├── test/                    -- test utilities + setup
│   │       └── e2e/                     -- Playwright E2E specs
│   └── api/                     -- Hono BFF server
│       └── src/
│           ├── app.ts                   -- Hono app (middleware stack)
│           ├── index.ts                 -- server entry point
│           ├── routes/
│           │   ├── v1.ts                --   /v1/* API routes
│           │   ├── auth.ts              --   /v1/auth/* (WS-D auth surface)
│           │   ├── privacy.ts           --   /v1/privacy/* (WS-D privacy controls)
│           │   ├── events.ts            --   POST /v1/events/attention (WS-E.1.3)
│           │   ├── stories.ts           --   POST /v1/stories, search, takedowns, reads (WS-F)
│           │   ├── ingestion-admin.ts   --   /v1/ingestion/admin/* steward surface (WS-F)
│           │   ├── invariants-admin.ts  --   /v1/invariants/admin/* analyst surface (WS-H)
│           │   ├── invariants-public.ts --   public SCOI/MERI story reads (WS-H)
│           │   ├── ranking-admin.ts     --   /v1/ranking/admin/* steward surface (WS-I)
│           │   ├── forum.ts             --   /v1/contributions, threads, summaries,
│           │   │                             uploads, flags (WS-G §23.2)
│           │   ├── rooms.ts             --   /v1/rooms/* + lenses + governance (WS-G)
│           │   ├── health.ts            --   /health endpoint
│           │   └── csp-report.ts        --   CSP violation ingest
│           ├── middleware/
│           │   ├── security-headers.ts  --   CSP, HSTS, Permissions-Policy
│           │   ├── csrf.ts              --   single-use nonce + timingSafeEqual
│           │   ├── cors.ts              --   exact-match origin validation
│           │   ├── auth.ts              --   session validation + capability guards (WS-D.1.6a)
│           │   └── logger.ts            --   pino request logging
│           ├── identity/                -- WS-D identity layer (primitives + services)
│           │   ├── crypto.ts            --   HKDF keyed hashing, token hashing, constant-time
│           │   ├── codes.ts             --   Crockford-base32 one-time codes
│           │   ├── totp.ts              --   RFC 6238 TOTP + recovery codes
│           │   ├── auth-methods.ts      --   countAuthMethods last-method guard
│           │   ├── rbac.ts              --   role policy + object-level authz
│           │   ├── audit.ts             --   append-only audit store + redactor
│           │   ├── rate-limit-auth.ts   --   per-account + global limiter (no IP, §19.1)
│           │   ├── sessions.ts          --   session lifecycle, rotation, step-up, cookie
│           │   ├── ephemeral-store.ts   --   TTL'd single-use store (take = get+delete)
│           │   ├── webauthn.ts          --   @simplewebauthn ceremonies
│           │   ├── siwe.ts              --   viem EIP-4361 verification
│           │   ├── email-otp.ts         --   passwordless email login/factor
│           │   ├── security-alerts.ts   --   suspicious-login + multi-channel alerts
│           │   ├── secrets.ts           --   AES-256-GCM SecretBox (encrypt-at-rest)
│           │   ├── object-store.ts      --   encrypted DSAR archive store + signed URL tokens
│           │   ├── privacy-jobs.ts      --   DSAR export assembly + deletion-purge/sweep jobs
│           │   ├── store.ts             --   in-memory identity data store
│           │   ├── services.ts          --   injectable service container + config
│           │   ├── job-lease.ts         --   distributed scheduler window claim
│           │   ├── sigv4.ts             --   AWS SigV4 signer (node:crypto, no SDK)
│           │   ├── object-store-s3.ts   --   S3-compatible export-archive store
│           │   ├── mailer-ses.ts        --   production SES mailer (SigV4 over fetch)
│           │   ├── redis-stores.ts      --   production Redis adapters (gated)
│           │   └── drizzle-store.ts     --   production Postgres identity/audit/lease adapters (gated)
│           ├── events/                  -- WS-E event pipeline
│           │   ├── stores.ts            --   store interfaces + in-memory adapters
│           │   ├── ingest.ts            --   shared attention-ingestion pipeline (both routes)
│           │   ├── privacy-gate.ts      --   server-side privacy enforcement (WS-E.1.3d)
│           │   ├── replay.ts            --   single-use nonce store (WS-E.1.3b)
│           │   ├── ingest-limiter.ts    --   sliding-window rate limiter, fail-closed fallback
│           │   ├── router.ts            --   consumer router + pay-to-rank firewall (WS-E.1.5)
│           │   ├── consumers.ts         --   default consumers (realtime, integrity intake)
│           │   ├── realtime.ts          --   1h real-time aggregation layer (WS-E.3.2)
│           │   ├── hll.ts               --   HyperLogLog (bias-corrected, ~0.81% error)
│           │   ├── retention.ts         --   retention/anonymization sweeps + compliance query
│           │   ├── metrics.ts           --   in-process counters/latency (no attention values)
│           │   ├── services.ts          --   injectable WS-E service container
│           │   ├── redis-event-stores.ts --  production Redis adapters (gated)
│           │   └── drizzle-event-stores.ts -- production Postgres adapters (gated)
│           ├── pwatt/                   -- WS-E PWAtt scoring services
│           │   ├── aggregation.ts       --   per-item/window fold with per-user dedup (WS-E.2.1a)
│           │   ├── anti-signals.ts      --   burst + cascade detectors (WS-E.2.2a/c)
│           │   ├── config.ts            --   tunable runtime config (fail-closed loader)
│           │   ├── scoring.ts           --   window scoring job (v0+v1, ledger, freezes)
│           │   ├── shadow.ts            --   FALLBACK-boundary guard (score-blind, WS-E.2.1e)
│           │   ├── ranking-v0.ts        --   freshness-only ordering (the safe fallback)
│           │   └── scheduler.ts         --   lease-guarded hourly tick
│           ├── invariants/              -- WS-H invariant platform + services
│           │   ├── stores.ts            --   promotions/calibrations/runs/cases/sessions
│           │   ├── config.ts            --   fail-closed invariants.* runtime config
│           │   ├── cards.ts             --   the eleven validated invariant cards
│           │   ├── runner.ts            --   fallback wrapper, tiers, health, persistence
│           │   ├── promotion.ts         --   the WS-H.1.2e shadow-status gate
│           │   ├── data.ts              --   input assembly from WS-D/E/F/G stores
│           │   ├── services-impl.ts     --   the eleven InvariantService implementations
│           │   ├── services.ts          --   container + consumers + WS-E hook closures
│           │   ├── scheduler.ts         --   lease-guarded batch tier + nightly drift
│           │   └── drizzle-invariant-stores.ts -- production Postgres adapters (gated)
│           ├── ranking/                 -- WS-I ranking and distribution
│           │   ├── stores.ts            --   feature store + decision logs (in-memory)
│           │   ├── retrievers.ts        --   the eight organic candidate retrievers
│           │   │                             (WS-I.1.1a) + the room-surface scoper
│           │   ├── quotas.ts            --   diversity quotas (WS-I.1.1b, ceil-reserved)
│           │   ├── orchestrator.ts      --   candidate merge/dedup/budget (WS-I.1.1d)
│           │   ├── features.ts          --   feature assembly + population (WS-I.2.1d)
│           │   ├── safety-filter.ts     --   non-overridable policy filter (WS-J seam)
│           │   ├── service.ts           --   the eight-stage feed service + replay
│           │   ├── killswitch.ts        --   runtime kill switch (WS-I.4.1a, fail-closed)
│           │   ├── config.ts            --   fail-closed ranking.* runtime config
│           │   ├── scheduler.ts         --   lease-guarded hourly maintenance tick
│           │   ├── services.ts          --   injectable container + consumer registration
│           │   └── drizzle-ranking-stores.ts -- production Postgres adapters (gated)
│           ├── ingestion/               -- WS-F ingestion, source model, search
│           │   ├── stores.ts            --   store interfaces + in-memory adapters
│           │   ├── services.ts          --   injectable container + WS-E router consumers
│           │   ├── submission.ts        --   POST /v1/stories orchestration (guard chain)
│           │   ├── pipeline.ts          --   §14.2 extraction worker + content.normalized
│           │   ├── prechecks.ts         --   submission limits, spam patterns, URL safety
│           │   ├── safe-fetch.ts        --   SSRF-hardened fetcher (per-resolution gate)
│           │   ├── robots.ts            --   RFC 9309 parser/matcher + fail-closed cache
│           │   ├── extraction.ts        --   HTML scanning, metadata, language, sensitivity
│           │   ├── dedup.ts             --   MinHash/LSH near-dup + syndication classification
│           │   ├── claims.ts            --   heuristic candidate-claim extractor (WS-K seam)
│           │   ├── embeddings.ts        --   providers, registry record, backfill/cutover
│           │   ├── search.ts            --   SearchIndex interface + in-memory FTS semantics
│           │   ├── lifecycle.ts         --   §14.4 transitions service + audit + sweep
│           │   ├── freshness.ts         --   topic-cadence baseline service (WS-I input)
│           │   ├── config.ts            --   fail-closed runtime config (ingestion.* keys)
│           │   ├── scheduler.ts         --   lease-guarded hourly maintenance tick
│           │   └── drizzle-ingestion-stores.ts -- production Postgres adapters + FTS (gated)
│           ├── forum/                   -- WS-G forum, rooms, lenses, summaries
│           │   ├── stores.ts            --   store interfaces + in-memory adapters
│           │   ├── services.ts          --   injectable container + metrics + boot wiring
│           │   ├── contributions.ts     --   create/edit/remove guard chain + event emission
│           │   ├── threads.ts           --   thread/branch/subtree reads (visibility-aware)
│           │   ├── tree.ts              --   materialized-path math + depth-first ordering
│           │   ├── rooms.ts             --   rooms/lenses/stewards/joins + governance audit
│           │   ├── summaries.ts         --   §24.3 layered summaries (supersede semantics)
│           │   ├── transitions.ts       --   audited §15.4 state machines → thread.state.changed
│           │   ├── safety.ts            --   heuristic contribution pre-screen (WS-J/K seam)
│           │   ├── exif.ts              --   byte-level image metadata stripping (WS-G.4.4)
│           │   ├── config.ts            --   fail-closed runtime config (forum.* keys)
│           │   └── drizzle-forum-stores.ts -- production Postgres adapters (gated)
│           ├── lib/
│           │   ├── rate-limit.ts        --   global fixed-window budget (no client keying)
│           │   ├── push-service.ts      --   VAPID push (session-scoped delete)
│           │   ├── vapid.ts             --   VAPID key management
│           │   ├── logger.ts            --   pino logger setup
│           │   ├── demo-data.ts         --   demo feed fixtures + stable demo ids
│           │   └── demo-seed.ts         --   dev seed through the real forum/ingestion stores
│           └── __tests__/               -- route/middleware/service tests (WS-C – WS-G)
├── packages/
│   ├── shared/                  -- shared schemas, types, constants (leaf)
│   │   └── src/
│   │       ├── schemas/
│   │       │   ├── common.ts            --   UUID, timestamp, httpUrlSchema, cursor
│   │       │   ├── attention.ts         --   AttentionAggregate, bucketing fns
│   │       │   ├── thread.ts            --   ThreadDetail + §15.4 conversation/safety
│   │       │   │                             state machines (WS-G)
│   │       │   ├── room.ts              --   rooms, lenses, stewards, join models,
│   │       │   │                             governance settings (WS-G)
│   │       │   ├── feed.ts              --   FeedItem
│   │       │   ├── profile.ts           --   UserProfile
│   │       │   ├── contribution.ts      --   11-type create union + body limits +
│   │       │   │                             citations + depth cap (WS-G §15.2)
│   │       │   ├── summary.ts           --   §24.3 layered summaries + uncertainty (WS-G)
│   │       │   ├── forum-api.ts         --   forum endpoint wire contracts (WS-G)
│   │       │   ├── signal-ledger.ts     --   SignalLedgerEntry
│   │       │   ├── notifications.ts     --   Notification schemas
│   │       │   ├── telemetry.ts         --   telemetryBatchSchema
│   │       │   ├── feature-flags.ts     --   FeatureFlagSet
│   │       │   ├── user.ts              --   User entity + age-gate (WS-D.1.1/1.7)
│   │       │   ├── privacy-settings.ts  --   PrivacySettings + teen-floor clamp
│   │       │   ├── identity-records.ts  --   session/credential/wallet zod mirrors
│   │       │   ├── auth-api.ts          --   auth endpoint wire contracts
│   │       │   ├── privacy-api.ts       --   privacy endpoint wire contracts
│   │       │   ├── audit.ts             --   audit event taxonomy
│   │       │   └── events/              --   WS-E event schemas (envelope, retention
│   │       │                                 tiers, 14 core topic schemas, topic
│   │       │                                 registry SSOT, knomosis/ bounded context)
│   │       ├── ugc/                     --   WS-G.4 UGC pipeline: Markdown-lite AST
│   │       │                                 (no raw-HTML node), constrained serializer,
│   │       │                                 DOMPurify `licio-ugc` policy, renderUGC,
│   │       │                                 link-safety heuristics
│   │       ├── types/                   --   TypeScript type exports
│   │       ├── enums/                   --   enumeration constants
│   │       ├── constants/               --   shared constants (incl. the 51 ratified
│   │       │                                 WS-A moderation reason codes)
│   │       └── env/                     --   environment variable validation
│   ├── db/                      -- Drizzle ORM schema + migrations
│   │   ├── drizzle/                     --   generated SQL migrations (WS-D – WS-H)
│   │   └── src/
│   │       ├── schema/                  --   PostgreSQL table definitions
│   │       │   ├── user.ts              --     users + JSONB + indexes/CHECK (WS-D.1.1)
│   │       │   ├── session.ts           --     sessions, user_auth (no password), recovery codes
│   │       │   ├── webauthn-credential.ts --   WebAuthn credentials
│   │       │   ├── wallet-auth-credential.ts -- auth-wallet (identity context)
│   │       │   ├── audit-log.ts         --     append-only audit log
│   │       │   ├── privacy.ts           --     export_jobs, deletion_requests
│   │       │   ├── invariants.ts        --     WS-H: promotions (append-only shadow
│   │       │   │                               status), calibrations, run metadata,
│   │       │   │                               mfci_cases (analyst queue)
│   │       │   ├── events.ts            --     WS-E: events (LIST-partitioned by tier),
│   │       │   │                               attention_aggregates (§22.1), windows,
│   │       │   │                               invariant_outputs (+shadow), signal ledger,
│   │       │   │                               safety states, pwatt_config, DLQ, checkpoints
│   │       │   ├── story.ts, source.ts, claim.ts,
│   │       │   │   takedown.ts, embedding.ts,
│   │       │   │   ingestion-review.ts  --     WS-F content tables (stories, sources,
│   │       │   │                               claims + dual-dimension evidence cards,
│   │       │   │                               syndication, takedowns, pgvector, queue)
│   │       │   ├── thread.ts            --     WS-G threads (conversation/safety states,
│   │       │   │                               per-story branch uniqueness)
│   │       │   ├── contribution.ts      --     WS-G contributions (materialized path JSONB,
│   │       │   │                               depth/parent CHECKs, client-draft dedup,
│   │       │   │                               edit history, tombstones)
│   │       │   ├── room.ts              --     WS-G rooms, stewards, subscriptions, lenses
│   │       │   ├── summary.ts           --     WS-G §24.3 summaries (provenance CHECK)
│   │       │   ├── upload.ts            --     WS-G uploads (EXIF-stripped, scan-gated)
│   │       │   ├── ranking.ts           --     WS-I feature-vector revisions + decision
│   │       │   │                               logs (privacy-bucket CHECK, §22.4 retention)
│   │       │   └── wallet/wallet-account.ts -- isolated financial WalletAccount
│   │       ├── isolation.ts             --   wallet↔ranking BFS isolation (WS-D.3.2)
│   │       ├── client.ts                --   database client initialization
│   │       └── drizzle.config.ts        --   Drizzle configuration
│   ├── invariants/              -- invariant computation modules
│   │   └── src/
│   │       ├── types.ts                 --   type-level invariants
│   │       ├── pwatt/                   --   WS-E PWAtt pure math (v0/v1 scoring,
│   │       │                                 saturation curves, ranking profiles,
│   │       │                                 penalties, safety-state machine,
│   │       │                                 accusation + low-info-reply classifiers,
│   │       │                                 ledger summaries)
│   │       ├── text/                    --   WS-F MinHash/LSH (pinned hash family)
│   │       ├── freshness/               --   WS-F freshness baseline math
│   │       └── __tests__/               --   invariant + deterministic property tests
│   └── ranking/                 -- WS-I pure ranking domain logic (no I/O)
│       └── src/
│           ├── denylist.ts              --   WS-I.2.1b financial denylist + typed error
│           ├── denylist.config.json     --   the VERSIONED denylist artifact (pinned to
│           │                                 the shared doctrine list at module load)
│           ├── schemas/                 --   strict stage-boundary zod schemas
│           │                                 (candidate, feature vector, profile,
│           │                                 scored item, decision log)
│           ├── scoring/                 --   §5.4 baseline/positive/penalties/constraints
│           ├── diversify/               --   matroid dedup + source/topic/lens balancing
│           ├── explain/                 --   template registry + generation (prohibited-
│           │                                 language structural block; locale-ready)
│           ├── pipeline.ts              --   the deterministic constrained-optimization
│           │                                 core (serving AND replay execute this)
│           └── __tests__/               --   124 deterministic unit/property tests
├── scripts/                     -- build validation and security gates
│   ├── validate-build.ts        --   post-build orchestrator
│   ├── check-bundle-size.ts     --   initial JS < 200 KB gz (total < 320 KB), CSS < 50 KB gz
│   ├── check-sw-security.ts     --   no remote importScripts/eval/new Function
│   ├── inject-sw-trusted-types.ts --  prepend TT default policy to built sw.js
│   ├── check-no-applause.ts     --   no like/vote/karma/reaction affordances
│   ├── check-no-raw-egress.ts   --   no raw attention traces in signals layer
│   ├── check-dep-budget.ts      --   dependency count enforcement
│   ├── check-workspace-deps.ts  --   workspace boundary enforcement
│   ├── check-lockfile.ts        --   lockfile integrity
│   ├── check-policy.ts          --   doctrine/policy document validation
│   ├── lint-security.ts         --   supplementary security lint
│   ├── generate-sri.ts          --   subresource integrity hashes
│   ├── generate-sbom.ts         --   CycloneDX SBOM generation
│   └── policy/                  --   policy validation utilities + tests
├── docs/
│   ├── SPEC.md                  -- canonical design specification
│   ├── planning/                -- per-workstream planning documents
│   │   ├── 00-index.md          --   master index (~646 atomic tasks)
│   │   ├── 01-repository-foundation.md  -- WS-0
│   │   ├── 02-doctrine-and-policy.md    -- WS-A
│   │   ├── 03-design-system.md          -- WS-B
│   │   ├── 04-pwa-client.md             -- WS-C
│   │   └── 05–17-*.md                   -- WS-D through WS-P
│   ├── design-system/           -- design system documentation
│   ├── pwa-client/              -- PWA implementation documentation
│   ├── identity/                -- WS-D implementation reference
│   ├── events/                  -- WS-E implementation reference
│   ├── ingestion/               -- WS-F implementation reference
│   ├── forum/                   -- WS-G implementation reference
│   ├── invariants/              -- WS-H implementation reference
│   ├── ranking/                 -- WS-I implementation reference
│   └── policy/                  -- 9 policy documents (moderation, signals,
│                                   privacy, crypto, jurisdiction, transparency)
└── .github/
    └── workflows/
        ├── ci.yml               -- main CI (8 jobs: lint, typecheck, lockfile,
        │                           deps, test+coverage, build+size, E2E, security)
        ├── codeql.yml           -- CodeQL security scanning (JS/TS)
        ├── dependabot-auto-merge.yml -- dependency update automation
        └── dependabot.yml       -- Dependabot configuration
```

Per-file purpose lives in each file's leading comment block, not
duplicated here.

## Workspace dependency graph

```
@licio/shared              (leaf; no workspace dependencies)

@licio/db                  (depends on @licio/shared only)
@licio/invariants          (depends on @licio/shared only)
@licio/ranking             (depends on @licio/shared, @licio/invariants;
                            NEVER @licio/db — the ranking math has no
                            database access by construction)

apps/web                   (depends on @licio/shared, @licio/invariants;
                            NEVER @licio/db — enforced by check:workspace-deps)
apps/api                   (depends on @licio/shared, @licio/db,
                            @licio/invariants, @licio/ranking)
```

`pnpm check:workspace-deps` enforces these boundaries by scanning both
`package.json` declarations and source-level imports.  Violations block
CI.

**Dependency budgets (SPEC Section 6.12.12):**

| Workspace    | Budget                     | Enforced by         |
|--------------|----------------------------|---------------------|
| `apps/web`   | < 15 direct production deps | `pnpm check:deps`  |
| `apps/api`   | < 20 direct production deps | `pnpm check:deps`  |
| `workspace:*` | excluded from count        | —                   |

**Dependency-addition checklist.**  Before adding any new production
dependency:

1. Maintainer trust — actively maintained with responsive security?
2. Transitive count — how many transitive deps does it pull in?
3. Install scripts — must be NONE (no postinstall, preinstall, install)
4. License — must be AGPL-3.0-or-later compatible (MIT, ISC, BSD, Apache-2.0)
5. Web-API alternative — can a built-in browser/Node.js API replace it?

## Reading large files

`docs/SPEC.md` and `docs/planning/00-index.md` (~646 tasks) are large.
Read in chunks with `Read(file_path, offset=…, limit=500)` rather than
the whole file.

When editing, read the specific region around the target lines first
(e.g., `offset=2580, limit=80`) so the `old_string` matches exactly.

## Writing and editing files

**Prefer the Edit tool for all changes to existing files**, regardless
of size.  The Write tool replaces an entire file and is error-prone
for files over ~100 lines.

**Rules for large-file changes:**

1. **Never rewrite a large file with Write.**  Use Edit with a
   precise `old_string`/`new_string` pair.
2. **One logical change per Edit call.**
3. **Read before you edit** so the `old_string` matches exactly.
4. **Adding large new sections:** break into multiple sequential Edit
   calls, anchoring each to existing context.
5. **Creating new large files:** use an initial Write (under 100
   lines) followed by Edit appends, or a Bash heredoc.
6. **Post-write verification:** spot-check the modified region and
   the file's last few lines.

## Handling large search and command output

- **Grep**: cap with `head_limit`; use `output_mode:
  "files_with_matches"` first, then drill in.
- **Glob**: scope with `path` instead of searching the whole repo.
- **Bash output**: pipe through `head` / `tail`.  For very large
  output, redirect to a temp file and `Read` in chunks.

**Rule of thumb:** if a command might return more than ~100 lines,
limit it upfront.

## Background-agent file-change protection

Background agents run concurrently and may finish after the
foreground agent has already modified the same files.

1. **Never delegate file writes to a background agent for files you
   may also edit.**
2. **Partition files strictly** across parallel agents.
3. **Use background agents only for read-only or independent-file
   tasks.**
4. **Check background results before acting on shared state.**
5. **When in doubt, run in foreground.**

## Key conventions

- **TypeScript strict mode (ABSOLUTE).**  `noUncheckedIndexedAccess`,
  `exactOptionalPropertyTypes` enabled.  No relaxation.

- **No `any` (ABSOLUTE).**  Use `unknown` and narrow.  Sole
  exception: `packages/shared/src/types/**` (type-export surface).

- **No dangerous DOM APIs (ABSOLUTE).**  `dangerouslySetInnerHTML`,
  `innerHTML`, `outerHTML`, `document.write()`, `eval()`,
  `new Function()` are forbidden.  All UGC must pass through
  DOMPurify.  `pnpm lint:security` is the mechanical check; CI
  blocks the merge on a violation.  The SINGLE sanctioned exception
  is `UgcBody` (`apps/web/src/components/ugc/UgcBody.tsx`, WS-G.4.2b):
  one `dangerouslySetInnerHTML` whose value is always `renderUGC`
  output (Markdown-lite AST → constrained serializer → DOMPurify
  `licio-ugc` → TrustedHTML).  Any other suppression of
  `noDangerouslySetInnerHtml` is a review-blocking violation.

- **No inline styles.**  Use Tailwind CSS utility classes (static
  CSS, zero JS runtime).

- **No secrets in client bundle.**  Only `VITE_`-prefixed env vars
  reach the client.  No wallet seed phrases or private keys in logs
  (pino redaction enforced).

- **SPDX header** for new source files:
  `// SPDX-License-Identifier: AGPL-3.0-or-later`

- **Import discipline:**
  - Workspace packages via aliases: `@licio/shared`, `@licio/db`,
    `@licio/invariants`.
  - Node.js built-ins with `node:` prefix in server/package code.
  - `.js` extension on relative imports (ESM resolution).

- **Naming conventions:**
  - Files and directories: `kebab-case` (`draft-crypto.ts`,
    `return-tracker.ts`).
  - React components: `PascalCase` (`StoryCard.tsx`,
    `FeedModeSwitcher.tsx`).
  - Functions, variables, hooks: `camelCase` (`useAuthStore`,
    `encryptDraftValues`).
  - Zod schemas: `camelCase` with `Schema` suffix
    (`attentionAggregateSchema`, `httpUrlSchema`).
  - Types and interfaces: `PascalCase` (`DraftCipher`,
    `StoredKey`, `ApiError`).
  - Constants: `SCREAMING_SNAKE_CASE` for true constants
    (`KEY_DB`, `RECORD_SCHEMA_VERSION`), `camelCase` for
    schema-derived constants.
  - Test files: `<module>.test.ts` (unit), `<feature>.spec.ts` (E2E).

- **Testing patterns:**
  - Unit tests via Vitest (jsdom for web, node for api/packages).
  - E2E tests via Playwright (Chromium, Firefox, WebKit) with
    axe-core accessibility assertions.
  - 80% coverage threshold on lines, functions, branches, statements.
  - Every TanStack Query response validated through zod before cache.
  - Offline tests use `fake-indexeddb/auto` for IndexedDB simulation.

- **Data fetching (ABSOLUTE).**  All API responses must be validated
  through a zod schema before entering the TanStack Query cache:

  ```typescript
  import { z } from 'zod';
  import { useQuery } from '@tanstack/react-query';

  const responseSchema = z.object({ id: z.string(), name: z.string() });

  useQuery({
    queryKey: ['example'],
    queryFn: async () => {
      const res = await fetch('/api/example');
      const data: unknown = await res.json();
      return responseSchema.parse(data);
    },
  });
  ```

- **Git practices:**  One commit per completed work unit.  All
  commits must pass `pnpm typecheck`, `pnpm lint`, and `pnpm test`.

- **Versioning:**  The root `package.json` version is the project
  version (workspace packages stay private at `0.0.0`).  EVERY pull
  request bumps the PATCH version unless otherwise directed; minor or
  major bumps only when explicitly requested.

- **Commit message convention:**

  ```
  type(scope): description

  Types: feat, fix, refactor, docs, test, chore, security, perf
  Scope: web, api, shared, db, invariants, ci, docs
  ```

## Security architecture

The application implements **defense-in-depth** across seven layers.
Every layer is enforced by both runtime guards and CI static gates.

| Layer | Mechanism | Enforced by | Key file(s) |
|-------|-----------|-------------|-------------|
| Content | Trusted Types + DOMPurify | CSP `require-trusted-types-for 'script'` | `security/trusted-types.ts` |
| Network | Strict CSP, CORS, HSTS | `security-headers.ts` middleware | `middleware/security-headers.ts` |
| Session | HttpOnly `__Host-` cookies, serialized CSRF | `csrf.ts` middleware + `api.ts` client | `middleware/csrf.ts`, `lib/api.ts` |
| Data | AES-256-GCM draft encryption (non-extractable key) | `draft-crypto.ts` + zod on every boundary | `offline/draft-crypto.ts` |
| Privacy | assertNoRawEgress + bucketed aggregates only | `check:no-raw-egress` CI gate | `signals/privacy.ts` |
| Resilience | Eviction detection, quarantine, rage-loop dampening | Unit + E2E tests | `offline/eviction.ts`, `signals/return-tracker.ts` |
| Service worker | Same-origin importScripts, TT policy injection | `check:sw` CI gate | `scripts/inject-sw-trusted-types.ts` |

### Trusted Types

Three named policies (`default`, `dompurify`, `licio-ugc`) plus the
SW-injected default policy.  The client default policy validates
script URLs via **origin comparison** (`new URL(url,
location.origin).origin === location.origin`), not prefix matching —
this prevents subdomain spoofing and protocol-relative bypasses.
`licio-ugc` is the WS-G UGC sanitizer policy: DOMPurify returns
TrustedHTML under it, and its `createScriptURL` throws
unconditionally (UGC can never mint a script URL).

### CSP directives

```
default-src 'self'; script-src 'self'; style-src 'self';
img-src 'self' data:; font-src 'self'; connect-src 'self';
worker-src 'self'; manifest-src 'self'; frame-ancestors 'self';
object-src 'none'; base-uri 'self'; form-action 'self';
trusted-types default dompurify licio-ugc;
require-trusted-types-for 'script';
report-uri /api/security/csp-report; report-to csp-endpoint
```

No `'unsafe-inline'`, no `'unsafe-eval'`.  Violation reports are
ingested at `/api/security/csp-report`.

### CSRF protection

Per-session single-use tokens (256-bit, `crypto.randomBytes(32)`),
1-hour TTL, constant-time comparison (`crypto.timingSafeEqual`).
**Mutations are serialized** through a promise chain on the client —
each mutation fetches its own fresh token immediately before sending,
preventing concurrent nonce sharing.  GETs bypass the chain.

Exempt paths: `/health`, `/api/security/csp-report`, `/v1/telemetry`
(sendBeacon cannot set custom headers).

### Cookie security

```
__Host-session={id}; HttpOnly; Secure; SameSite=Strict; Path=/
```

`__Host-` prefix enforces HTTPS-only, no subdomain sharing, root path.

### Draft encryption

AES-256-GCM with a **non-extractable** `CryptoKey` persisted directly
in IndexedDB (`licio-keys` database, separate from ciphertext).  The
key's raw bytes are never serialized — `crypto.subtle.exportKey()`
rejects, and there is no JWK at rest.  Fresh 96-bit IV per encryption.
Decrypted payloads are zod-validated at the trust boundary.  Fallback
to plaintext when Web Crypto is unavailable (availability >
confidentiality, SPEC Section 6.9).

### Attention signal privacy

Raw engagement events (scroll positions, mouse coordinates, dwell
milliseconds) are **processed entirely in-browser** and discarded.
Only bucketed aggregates (`AttentionAggregate`, Section 22.1) cross
the network boundary.  The `assertNoRawEgress` guard traverses every
aggregate object before upload, throwing on any forbidden key.  The
CI gate `check:no-raw-egress` scans source for forbidden network
primitives and raw-trace field names.

Rage-loop dampening uses **permanent forfeiture**: once a burst is
detected (>= 3 returns within 90 minutes), the `forfeited` counter is
set and never decrements — hostile returns can never resurrect.

### Additional security headers

```
Strict-Transport-Security: max-age=63072000; includeSubDomains; preload
X-Content-Type-Options: nosniff
X-Frame-Options: SAMEORIGIN
Referrer-Policy: strict-origin-when-cross-origin
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Resource-Policy: same-origin
Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=(),
  usb=(), bluetooth=(), accelerometer=(), gyroscope=(), magnetometer=()
```

### Rate limiting (identity-free, SPEC §19.1)

The application never reads the client network address — no per-IP state
of any kind, enforced by a static test (`no-client-address.test.ts`).
Abuse control is layered as: per-account progressive lockouts (keyed by a
non-reversible account ref), per-target cooldowns (one email per mailbox
per window), and global per-endpoint fixed-window budgets
(`/v1/telemetry`, `/api/security/csp-report`, auth minting/signup,
deletion-cancel).  Overload → 429 + Retry-After.  Connection-level flood
fairness is the edge/gateway's concern.

## Linting limitations

Biome 2.x does not support:

- `noConsole` / `noConsoleLog` — console usage is not blocked by the
  linter; use pino for server-side logging.
- `noRestrictedSyntax` — cannot block `innerHTML`, `outerHTML`, or
  `document.write()` at the AST level; these are caught by
  `pnpm lint:security` instead.
- `javascript:` URL blocking — caught by `pnpm lint:security` and
  `scripts/validate-build.ts`.

## TypeScript 6 notes

- TypeScript 6 defaults `types` to `[]` — ambient `@types/*` packages
  must be explicitly listed in each workspace `tsconfig.json` via
  `"types": ["node"]`.
- `esModuleInterop` is always enabled and cannot be set to `false`.
- `moduleResolution: "classic"` has been removed (this project uses
  `"bundler"`).

## Vite 8 notes

- Vite 8 uses Rolldown as the bundler; `rollupOptions.output.manualChunks`
  must be a function (object form is no longer supported).
- Biome v2 config uses `css.parser.tailwindDirectives: true` for
  Tailwind CSS v4 `@utility` / `@import "tailwindcss"` directives.

## Key dependencies

| Package | Workspace | Role |
|---------|-----------|------|
| `react` / `react-dom` 19 | web | UI framework |
| `@tanstack/react-router` ^1.93 | web | file-based routing (auto code-splitting) |
| `@tanstack/react-query` ^5.62 | web | server-state (SWR, zod on every response) |
| `zustand` ^5.0 | web | client-state (3 stores: auth, ui, feature-flags) |
| `zod` ^4.4 | shared, web, api | schema validation at every trust boundary |
| `dompurify` ^3.4 | shared, web | HTML sanitization (Trusted Types integration; the WS-G `licio-ugc` UGC sanitizer lives in `@licio/shared`) |
| `hono` ^4.7 | web, api | typed RPC client (web) / BFF server (api) |
| `tailwindcss` ^4.1 | web (dev) | utility-first CSS (static, zero JS runtime) |
| `drizzle-orm` ^0.45 | db | type-safe SQL (parameterized queries only) |
| `pino` ^10.3 | api | structured logging (redaction-aware) |
| `ioredis` ^5.11 | api | Redis client (CSRF token store, sessions) |
| `@simplewebauthn/server` ^13.3 | api | WebAuthn attestation/assertion verification (WS-D) |
| `viem` ^2.52 | api | EIP-4361 / SIWE signature verification (WS-D wallet sign-in) |

No Lean or Rust toolchains.  This is a pure TypeScript monorepo.

## Implementation roadmap

The specification defines 17 workstreams (WS-0 through WS-P).
Status:

| Workstream | Title | Status |
|------------|-------|--------|
| WS-0 | Repository foundation | Complete |
| WS-A | Doctrine and policy | Complete |
| WS-B | Design system | Complete |
| WS-C | PWA client application | Complete |
| WS-D | Identity and privacy | Complete |
| WS-E | Event pipeline and PWAtt scoring | Complete |
| WS-F | Ingestion, source model, and search | Complete |
| WS-G | Forum and conversation | Complete |
| WS-H | Invariant services (MERI, MFCI, SCOI, GWEI, PHI) | Complete |
| WS-I | Ranking and distribution | Complete |
| WS-J | Trust and safety | Planned |
| WS-K | AI governance | Planned |
| WS-L | Knomosis and wallets | Planned |
| WS-M | Treasury and governance | Planned |
| WS-N | Compliance | Planned |
| WS-O | Security and reliability | Planned |
| WS-P | Experimentation and launch | Planned |

Read the per-workstream planning document under `docs/planning/`
before starting new work.  The master index at
`docs/planning/00-index.md` lists all ~646 atomic tasks.

## Documentation rules

When changing behaviour, schemas, or security posture, update in the
same PR:

1. `docs/SPEC.md` — if the change affects the architecture, the data
   model, the threat model, or the roadmap.
2. `docs/pwa-client/README.md` — if the change affects WS-C
   (routing, offline, push, signals, security, telemetry).
3. `README.md` — if project status, build commands, or quickstart
   change.
4. `CLAUDE.md` (and `AGENTS.md` — keep them byte-identical) — if
   conventions, build commands, or current-status summary change.

Canonical ownership: `docs/SPEC.md` owns the design; this file owns
engineering conventions; `README.md` owns the top-level introduction.

**Don't extend audit narratives in this file.**  Per-audit and
per-workstream completion details belong in commit messages and PR
descriptions.  This file describes the *current state*, not the path
that got us here.

## Pull request authoring policy (ABSOLUTE)

**Forbidden in PR summaries / descriptions / bodies:** session URLs
of the shape `https://claude.ai/code/session_*` (or any equivalent
agent-harness session permalink).

**Why:**  Privacy / opacity (PR readers cannot open it), link rot
(sessions expire), provenance leakage, citation discipline.

**Allowed alternatives:** specification section numbers, file paths,
workstream-plan documents under `docs/`.

**Scope:** PR descriptions / bodies, PR review comments, PR-edit
`body` arguments.  Out of scope: local commit messages.

**Enforcement.**  Before invoking
`mcp__github__create_pull_request` or
`mcp__github__update_pull_request`, scan the prepared `body` for
`https?://(?:www\.)?claude\.ai/code/session_[A-Za-z0-9]+` and strip
every match.

## Current development status

**Vitest configuration.**  Seven test projects: shared (node), db (node),
invariants (node), ranking (node), api (node), web (jsdom), policy
(node).  Their
settings live once in `vitest.shared.ts`; the root `vitest.config.ts`
composes them into the unified `pnpm test` run + the cross-workspace V8
coverage gate, and each workspace has a thin local `vitest.config.ts`
re-using the same settings so `pnpm --filter <ws> test` runs standalone.
Coverage threshold: 80% minimum for lines, functions, branches,
and statements.

**Test counts.**  `pnpm test` is the canonical query.  Approximate
file counts at current state:

| Workspace | Test files | Environment | Canonical query |
|-----------|-----------|-------------|-----------------|
| apps/web | ~113 unit + 6 E2E | jsdom / Playwright | `pnpm --filter web test` |
| apps/api | ~84 (incl. WS-D identity + WS-E pipeline + WS-F ingestion + WS-G forum + WS-H invariants + WS-I ranking/surfaces/neutrality + the RUN_PERF benchmarks) | node | `pnpm --filter api test` |
| packages/shared | ~19 (incl. WS-D–WS-H schemas, URL/lifecycle utils, the UGC pipeline + XSS-vector suite) | node | `pnpm --filter @licio/shared test` |
| packages/db | ~4 (isolation + content denylist + gated integration) | node | via root `pnpm test` (db project) |
| packages/invariants | ~18 (PWAtt/MinHash/freshness + the WS-H invariant mathematics: matroid/fiber/GW/sheaf/holonomy/supporting property suites + the regression harness) | node | `pnpm --filter @licio/invariants test` |
| packages/ranking | ~7 (denylist + versioned-artifact pinning, strict schemas, §5.5 profile fuzzing + baseline weights, §5.4 arithmetic, penalties/constraints incl. tie enforcement, dedup/balancing, templates + x-pseudo localization, pipeline determinism, replay diff) | node | `pnpm --filter @licio/ranking test` |
| scripts | ~4 | node | via root `pnpm test` (policy project) |

WS-D, WS-E, WS-F, WS-G, WS-H, and WS-I add **gated** integration tests
(Postgres + Redis) that run only when `DATABASE_URL` / `REDIS_URL` are set.
CI's Test & Coverage job provisions `pgvector/pgvector:pg16` and `redis:7`
service containers, so the gated suites RUN in CI; without the env vars
(e.g. a bare local `pnpm test`) they skip.  The WS-F chain requires a
pgvector-enabled Postgres (docker-compose ships `pgvector/pgvector:pg16`).
See `docs/identity/README.md`, `docs/events/README.md`,
`docs/ingestion/README.md`, `docs/forum/README.md`,
`docs/invariants/README.md`, and `docs/ranking/README.md`.

Only monotonic growth is enforced — no global gate pins the count.

**E2E configuration.**  Playwright runs against Chromium, Firefox,
and WebKit.  Base URL: `http://localhost:4173` (Vite preview).
Fully parallel in local mode; single worker in CI with 2 retries.
axe-core accessibility assertions on every page load.

**CI pipeline.**  `.github/workflows/ci.yml` runs 8 jobs on every PR:

1. Lint & format (Biome + security lint + policy + no-raw-egress)
2. Type check (strict-mode across all workspaces)
3. Lockfile integrity
4. Dependency budget
5. Test & coverage (Vitest + V8 coverage + JUnit XML; Postgres/pgvector +
   Redis service containers so the gated integration suites run too; plus
   the named `check:neutrality` step — the ten WS-I.3 ranking-neutrality
   tests as an explicit pay-to-rank gate on every PR)
6. Build & size check (production build + bundle-size gate)
7. E2E tests (Playwright, requires build)
8. Security audit (pnpm audit, SBOM, build validation, AGPL headers,
   secret scanning, install-script detection)

CodeQL (`.github/workflows/codeql.yml`) runs `security-extended`
queries on push to main, PRs, and weekly.

## Workstream reference

Each workstream's detailed plan, design rationale, and per-task
breakdown live in the relevant `docs/planning/` document.  This
section is a concise index.

### WS-0: Repository foundation

Plan: `docs/planning/01-repository-foundation.md`

Monorepo scaffold, CI/CD pipeline, security baseline, dependency
management, workspace boundaries.

### WS-A: Doctrine and policy

Plan: `docs/planning/02-doctrine-and-policy.md`

9 policy documents under `docs/policy/`: moderation taxonomy, signal
matrix, privacy regulation map, crypto feature matrix, jurisdiction
matrix, transparency dictionary, steward roles, signal test map.
Validated by `pnpm check:policy` (counts, ID disjointness,
severity-SLA consistency, cross-document references).

### WS-B: Design system

Plan: `docs/planning/03-design-system.md`

55-token design-token SSOT (`design-system/tokens.ts`), light/dark
palettes with WCAG contrast validation, 32 reusable UI primitives
under `components/ui/`, accessibility components (`RouteAnnouncer`,
`SkipToContent`), cognitive-load reduction (`DefinedTerm`,
`ProgressiveDisclosure`).

### WS-C: PWA client application

Plan: `docs/planning/04-pwa-client.md`
Documentation: `docs/pwa-client/README.md`

| Sub-area | Key surface | Status |
|----------|-------------|--------|
| Routing | TanStack Router file-based, 18 route files, auto code-splitting | Complete |
| State | 3 Zustand stores (auth, ui, feature-flags), zod-validated persistence | Complete |
| Offline | IndexedDB integrity layer, read-through cache, draft encryption, eviction detection | Complete |
| Push | VAPID ES256, contextual permission, renew-on-load, per-room mute, notification budget | Complete |
| Signals | Attention pipeline, bucketed aggregates, no-raw-egress, rage-loop dampening | Complete |
| Telemetry | Privacy-safe RUM, closed event enum, sendBeacon + keepalive fallback | Complete |
| Security | Trusted Types, CSP, CSRF serialization, SW TT injection, rate limiting | Complete |
| Performance | initial JS < 200 KB gz (total < 320 KB), CSS < 50 KB gz, Core Web Vitals targets, performance marks | Complete |

### WS-D: Identity, accounts, and privacy

Plan: `docs/planning/05-identity-and-privacy.md`
Documentation: `docs/identity/README.md`

Complete.  WebAuthn-first, **passwordless always** — there is no
password column, hashing, or reset flow anywhere.

| Sub-area | Key surface | Status |
|----------|-------------|--------|
| Schemas | User/privacy/session/credential/wallet zod + Drizzle, migration with partial indexes/CHECK/triggers | Complete |
| Auth | WebAuthn (`@simplewebauthn`), email-OTP, SIWE (viem); sessions, rotation, step-up, rate limiting; account-state gate at the session mint (suspended accounts never get a session) | Complete |
| Authorization | RBAC + object-level (404-over-403), append-only audit log, fail-closed middleware | Complete |
| Age gating | Under-13 block, teen privacy floor (server-clamped), `requireAdult` fail-closed | Complete |
| Privacy controls | Settings get/patch (clamped/audited/propagated), attention delete, DSAR export (assemble → encrypt → expiry-capped signed token → read-time expiry + hourly sweep), account deletion + 30-day grace + hard purge (anonymize/tombstone/revoke; all archives removed) | Complete |
| Steward MFA | TOTP enroll/verify/disable, per-session `mfa_verified`, reduced-assurance-until-MFA steward guard | Complete |
| Wallet isolation | `wallet.wallet_accounts` schema + undirected-BFS isolation test (WS-D.3.2) | Complete |
| Privacy | **No IP and no location are ever recorded — or even read** (SPEC §19.1): no code path reads the client address (statically tested); rate limiting is per-account + per-target-mailbox + global identity-free budgets; new-device alerts and request logs carry a coarse device descriptor only (never the full user-agent) | Complete |
| Durable stores | `DrizzleIdentityStore`/`DrizzleAuditStore` Postgres adapters behind the same interfaces as the in-memory adapters, wired in production alongside the Redis session/ephemeral/rate-limit stores; gated integration tests run the real migration chain | Complete |
| Job scheduler | Durable distributed privacy scheduler: every instance ticks hourly, a Postgres job lease (`job_leases`, atomic insert-or-steal) grants at most one executor per window, crashed holders self-heal via lease expiry, lease outage fails closed (read-time expiry still bounds retention) | Complete |
| Export delivery | S3-compatible `ObjectStore` (AWS/R2/MinIO; SigV4 on `node:crypto`, pinned to the official AWS vectors — no SDK dep): bucket bodies are client-side SecretBox ciphertext, expiry enforced at read time, paginated sweep; all-or-none `S3_*` env group (partial fails boot; absent falls back in-memory with a production warning) | Complete |
| Client auth | Login/registration page: passkey-first sign-in + signup (WebAuthn L3 JSON with manual fallback, no client webauthn dep), email-code fallback, enumeration-safe registration outcome, allowlisted post-login redirect, best-effort server-side sign-out | Complete |
| Client security | `/profile/security`: sessions list/revoke/revoke-others, passkey add/rename/remove, email-factor add/verify/change/disable, wallet unlink, TOTP enroll → recovery codes → disable, owner activity feed; sensitive actions run through the step-up retry gate (challenge → dialog → SAME action retries) and a step-up 401 never expires the session | Complete |
| Client data rights | Privacy page wired to the real `/v1/privacy/*`: export request → poll → step-up-gated archive download, attention-history deletion, account deletion (confirm → step-up → sign-out) with grace-period cancel on the login page (emailed `?cancel_token=` link AND deactivated re-login path) | Complete |
| Email delivery | Production `Mailer` over the SES v2 HTTP API (SigV4 on `node:crypto`, no SDK dep; all-or-none `SES_*` env group, partial fails boot): login/verify code templates and the WS-D.2.4a deletion notice (grace window, `/login?cancel_token=…` link, irreversibility); never logs recipient/code; without SES, production still fails closed unless `ALLOW_INSECURE_NULL_MAILER=true` | Complete |
| Residuals | The WS-E hooks (`purgeAttention`, `exportAttention`, `onPrivacyChange`) AND the WS-G hooks (`anonymizeContributions` tombstones forum contributions on purge; `exportContributions` composes WS-F stories + forum contributions + evidence + room subscriptions) are CLOSED with real implementations; the only remaining residual is browser-level auth E2E scenarios (the Playwright harness serves only the static preview — a BFF-in-the-loop harness lands with WS-P launch testing) | Tracked elsewhere |

Pure crypto is mathematically validated: TOTP against the RFC 6238
Appendix B vectors, real WebAuthn attestation/assertion via a pure-crypto
software authenticator, real SIWE EOA signatures via viem.

### WS-E: Event pipeline and PWAtt

Plan: `docs/planning/06-event-pipeline-and-pwatt.md`
Documentation: `docs/events/README.md`

Complete.  The §30.5 shadow stage was **LIFTED by WS-I**: PWAtt v0/v1
outputs are now stored `shadow_mode: false` and serve the WS-I pipeline as
BOUNDED ranking inputs (`PWATT_V0_SHADOW_MODE = false` in
`@licio/invariants` — still a code-level constant, reviewed like any other
change, never a configuration flip; reverting it, or engaging the WS-I
kill switch, restores the pre-lift posture because the safe fallback
ranker is provably score-blind).  Rows stored before the lift remain
powerless (the feature pipeline accepts components only from
`shadow_mode: false` rows).

| Sub-area | Key surface | Status |
|----------|-------------|--------|
| Schemas + registry | Strict envelope + retention tiers (§22.4); 14 core + 18 Knomosis topics (separate bounded context, never in the client bundle); single `TOPIC_REGISTRY` SSOT; discriminated union rejects unknown topics; §22.1 field-name mapping unit-asserted | Complete |
| Ingestion | `POST /v1/events/attention` (online window) + the WS-C batch wire (offline 7d window) through ONE pipeline: auth, ownership, two-layer replay (nonce + durable event-id), per-user sliding-window limits with fail-closed in-memory fallback, server-side privacy gate (personalization off → 204; retention `none` → real-time only; `minimal` → 90d; the durable `attention_privacy_level` floor clamps every event's identification level); logs/metrics carry ids + counts only (redaction-tested) | Complete |
| Storage | `events` LIST-partitioned by retention tier (partition drop = provable deletion); NOT NULL classification/tier (storage-layer defense); `attention_aggregates` §22.1 field-exact; minimum-privacy rows pseudonymized at rest (owner null, payload user id rewritten) | Complete |
| Real-time | Rebuildable 1h acceleration layer; HyperLogLog uniques (~0.81% error, documented); every key TTL'd; hourly reconciliation vs the durable aggregation within ~3σ | Complete |
| Router + firewall | At-least-once with event-id idempotency, bounded retries → DLQ (one letter per consumer+event, accumulating attempts, steward redrive), durable-consumer checkpoints + startup replay, exact real-time rebuild at boot, lag metrics; Knomosis topics can NEVER reach scoring consumers; scoring consumers hold public+aggregated only; the fail-closed crypto flag withholds Knomosis topics from EVERY consumer; all enforced at subscription AND delivery | Complete |
| Retention | Hourly lease-guarded sweeps per tier with batched settings reads; aggregates anonymize at the CURRENT preference's window, delete at the hard cap; moderation rows flagged for annual review (never auto-deleted); jurisdiction overrides shorten-only (WS-N hook); counts-only audit record + `retentionComplianceReport` (zero over-retained rows); WS-D hooks closed — `purgeAttention`, `onPrivacyChange`, and a COMPLETE `exportAttention` (all aggregates, all ledger pages, owned attention events incl. source-opens) | Complete |
| PWAtt v0 (shadow) | Per-user-per-window dedup fold; ActiveAttention (dwell caps, idle/bounce filtering, source>headline, clickbait zero-weight) + ConstructiveParticipation (diminishing returns, low save weight, uniform v0 type weights, `low_info_reply`=0); pure/total functions; deterministic property tests pin "genuine attention never decreases / anti-signals never increase" | Complete |
| Anti-signals | Coordinated bursts conditioned on the item's own base rate (active communities never flagged for volume alone) + distinct-actor guard → integrity event + MFCI/review hooks; conservative lexical accusation classifier (hedges/questions/opinions never flagged; WS-K seam); harassment cascades → restricted integrity signal + `MOD_HARASS_002` safety case + growth freeze; detection side effects deterministic per (item, window) | Complete |
| Signal Ledger | Owner-only `GET /v1/signal-ledger` (401 unauthenticated; no other-user path); ONE canonical entry per (owner, item, 1h window) — larger windows live in invariant_outputs — with bucketed breakdown, applied anti-signals, shadow score, plain-language summary; cap status honestly omitted server-side (client-known only; optional on the wire); purge deadlines coupled to retention preference; rendered on the profile page | Complete |
| PWAtt v1 | INTEGRATED live stage (`computePwattV1Components`): per-user diminishing curves at the contribution hierarchy's weights (evidence > correction > … > low_info_reply=0; accusation downweight at the accusing type's weight), item dimensions through `applySaturation` (log + tanh curves; total/monotone/concave; 50% dominance cap; exact sum-to-100); §5.5-guardrailed profiles (selection context has no payment/wallet field); penalties as separate nonnegative coefficients that can drive totals below zero (pM real from burst confidence, pR via MERI hook, pH/pT pinned-zero placeholders); v0 weights AND the full v1 stage runtime-tunable via `pwatt_config` (fail-closed loader + steward write endpoint with config-time 422 rejection) | Complete |
| Fallback verification | CI-gated equivalence (retargeted at the §30.5 lift): the SAFE FALLBACK ordering is byte-identical with/without (and with mutated) PWAtt scores; the fallback boundary rejects PWAtt rows even if the flag were mislabeled — engaging the WS-I kill switch provably restores the pre-lift posture; the empty-store demo `/v1/feed` contract stays score-invariant | Complete |
| Scheduler | Hourly tick under a Postgres job lease (`events_hourly`); freshness-aware `windowsNeedingCompute` (a window recomputes only when events ARRIVED after its computedAt — fresh windows compute once, late offline events re-open theirs, unchanged windows skip; lookback ~26h/36h/8d/14d per size), retention sweeps, real-time reconciliation; the volume-threshold trigger is wired in production boot (early 1h scoring for hot items); startup recovery (checkpoint replay + real-time rebuild) runs at boot | Complete |
| Production bindings | Drizzle adapters for all nine durable stores + Redis adapters (nonces `SET NX PX`, ZSET sliding windows, native PFADD/PFCOUNT HLL); gated integration tests run the REAL migration chain (incl. the partitioned DDL) against live Postgres/Redis | Complete |
| System events | `invariant.run.completed` emitted once per item/window (deterministic name-based UUIDv8/SHA-256 ids; idempotent re-runs); `thread.state.changed` (safety dimension) on every freeze/resolution; `privacy.request.created` from the WS-D privacy routes (export/deletion/cancel/attention-reset); steward admin surface at `/v1/events/admin` (safety-state, validated config writes, DLQ list/redrive, manual recovery) | Complete |
| Residuals | story emission is CLOSED (WS-F emits `content.submitted`/`content.normalized`; ledger titles resolve from the real story store); the WS-G residuals are CLOSED (forum contributions emit `contribution.created`/`evidence.added` with real correlation, and `classifyLowInfoReplyV0` in `@licio/invariants` classifies replies at creation); WS-H invariant providers + burst covariates behind existing hooks; the WS-I residuals are CLOSED (the ranking boundary consumes PWAtt as a bounded input and the §30.5 shadow lift shipped); WS-J case lifecycle behind hooks; WS-K classifier seam; `notification.sent` producer (no in-repo dispatch path exists); client-side `source.opened.aggregate` + `cap_reached` emitters (server paths complete); cross-instance stream binding behind the `EventRouter` surface (WS-O) | Tracked elsewhere |

### WS-F: Ingestion, source model, and search

Plan: `docs/planning/07-ingestion-and-search.md`
Documentation: `docs/ingestion/README.md`

Complete.  The source model exposes context and history only — NO truth
score exists anywhere (enforced by schema strictness, shared-schema tests,
and a db column assertion), and no WS-F table can carry a financial column
(WS-F.2.5b denylist + the wallet↔ranking BFS proof).

| Sub-area | Key surface | Status |
|----------|-------------|--------|
| Submission | `POST /v1/stories` (six §14.1 types, discriminated-union validation), pre-checks (rate limit/account age/spam titles/local malware denylist; fail-toward-caution hold), transactional thread shell, `content.submitted` emission with detached publication | Complete |
| URL + dedup | Shared pure normalizer (idempotent; paths keep case per RFC 3986 — documented deviation), exact-URL 409 via partial unique index (race-safe), MinHash(128)/LSH(32×4) near-duplicates with the corrected detection curve (retrieval recall ≈ 0.9998 at J=0.7; estimate makes the decision), source-aware syndication (confirmed edges auto-link; unknown publishers flag) | Complete |
| Lifecycle | Pure shared transition function (exhaustively tested table), append-only `story_lifecycle_audits`, WS-E-event triggers + hourly low-activity sweep + steward endpoint; WS-G's real `contribution.created`/`evidence.added` events now drive the activity triggers; SCOI triggers remain the WS-H seam | Complete |
| Extraction | SSRF-hardened fetcher (per-resolution lookup gate, redirect re-validation, streaming byte cap), RFC 9309 robots compliance (fail-closed unreachable, crawl-delay deferral), quote-aware HTML scanning + JSON-LD, declared-first language detection + conservative sensitivity lexicons (WS-K seams), copyright-bounded excerpt (full body never persisted), non-blocking failures with scheduled retries | Complete |
| Source model | §14.3 profiles (auto-created idempotently, incrementally aggregated), steward editing with per-field audit, append-mostly corrections, canonicalized unique syndication edges | Complete |
| Claims/evidence | Claim + EvidenceCard schemas with shared `independence_group_id` (MERI), heuristic extractor with provenance + confidence floor → review queue, claim↔evidence navigable both directions, evidence-card submissions create real cards | Complete |
| Search | Generated weighted tsvectors (title>excerpt>byline; English/simple per row, OR-matched at query time), GIN-indexed, tokenization-only query building (injection-safe), filters + keyset pagination, server-side visibility (takedown/safety-hidden/retracted excluded) | Complete |
| Embeddings | pgvector `vector(384)` + HNSW (documented IVFFlat trade-off), unique `(type, id, model_version)`, self-hosted HTTP provider (all-or-none `EMBEDDING_*`) with honest deterministic lexical fallback, similarity helpers (stories/claims/interpretations/evidence) on the ANN index, resumable backfill → drift validation → atomic cutover → cleanup | Complete |
| Freshness | Versioned exponential-decay baseline in topic-cadence units (property-tested monotonicity with the exact IEEE-754 statement), recomputed on events + sweep, consumable by WS-I.2.3d | Complete |
| Takedowns | Public structured intake (rate-limited) → steward review → actioning hides the target everywhere + audit + best-effort submitter notice | Complete |
| Admin | `/v1/ingestion/admin/*` (steward + TOTP): review queue, syndication create/confirm, source editing, takedowns, lifecycle triggers, validated config writes (422), backfill controls, metrics | Complete |
| Residuals | the WS-G residuals are CLOSED (threads carry real conversation/safety states and contributions; room visibility gates thread/contribution reads); WS-H similarity consumption (semantic conclusions gated on a self-hosted model); WS-I freshness/ranking consumption; WS-J queue ownership; WS-K governed extractor/classifiers/registry + topic taxonomy behind existing seams; client submission/search UI + BFF-in-the-loop browser E2E (WS-P precedent); full-scale (1M) load validation (latency/recall benchmarks measured + operating point recorded at N=20K, `RUN_PERF`-gated; 1M is WS-P) | Tracked elsewhere |

### WS-G: Forum, conversation, rooms, and lenses

Plan: `docs/planning/08-forum-and-conversation.md`
Documentation: `docs/forum/README.md`

Complete.  Conversation is structured — there is no generic "comment":
every contribution is one of the eleven §15.2 types, validated by ONE
shared discriminated union on both client and server, and rendered
through ONE sanctioned UGC sink.

| Sub-area | Key surface | Status |
|----------|-------------|--------|
| Schemas | 11-type `contributionCreateSchema` discriminated union (per-type body limits, citation bounds, the direct-experience privacy acknowledgment, ratified WS-A reason codes for moderation concerns), §15.4 thread conversation/safety state machines as table-driven legal-transition functions, room/lens/steward/subscription/governance enums, §24.3 summary schemas, forum wire contracts — all in `@licio/shared` (client/server rule identity) | Complete |
| Storage | `contributions` (materialized JSONB ancestor path + GIN containment for subtree reads, depth ≤ 10 CHECK, path/parent consistency CHECK, `(user_id, client_draft_id)` partial unique for idempotent create, append-only edit history, author tombstones), `rooms`/`room_stewards`/`room_subscriptions`/`lenses`, `summaries` (§24.3 uncertainty CHECK), `uploads` (content-type allow-list CHECK, scan gate); migration 0008 recreates the thread enums with USING maps and splits evidence into material × relationship dimensions | Complete |
| Contributions | Guard chain (auth → thread/room visibility → per-account sliding-window rate limit → shared-schema validation → per-type semantic guards → attachment/lens validation → safety pre-screen hold) → transactional insert WITH the evidence card (both-or-neither) → `contribution.created`/`evidence.added` emission — safety-HELD rows emit nothing and bump no room activity (emission on release is the WS-J approval seam); §15.5 edit (snapshot history, type immutable, per-type caps re-enforced, the safety classifier RE-RUNS on edited content and flags hold for review) and author removal (tombstone, idempotent, 404-over-403) | Complete |
| Threads | Branch-aware reads on the §15.3 structured sections (`sectionOfType`), depth-first subtree ordering, visibility-aware row filtering (removed/hidden collapse honestly), keyset pagination for branches AND subtrees (complete over arbitrarily large subtrees; an invisible root gates every page), room-visibility gating on every read | Complete |
| State evolution | Organic system transitions ride the same audited path as the steward surface: structural `active → deepening` at contribution creation (volume + evidence + live multi-level depth, `forum.deepening*` config) and WS-E harassment-cascade escalation (`safety normal → elevated`, `conversation active → tense`) via the durable `forum-thread-posture` router consumer (idempotent under redelivery; bursts ignored; de-escalation stays human through `under_review`) | Complete |
| Rooms + lenses | §16.2 join models per visibility (public auto-active, restricted request → steward approval, expert-led), two-tier visibility (a pending applicant sees a room EXISTS but reads no content until approved), steward roles (WS-A taxonomy), audited governance-settings writes, `RECOMMENDATION_INPUT_KEYS` transparency (what room recommendations may ever consume — no applause, no payment), one lens per `(room, lens_type)`, lens-tagged contribution surfacing, directory listing that walks the store keyset (no fetch-prefix cap) with VISIBLE-only thread counts | Complete |
| Summaries | §24.3 three layers (automated_draft / community_synthesis / steward_summary) with REQUIRED unresolved-uncertainty disclosure for human layers (CHECK + service), supersede semantics (an automated draft can never displace a human summary), provenance validated at write time (cited branches AND evidence must be real, thread-scoped records) | Complete |
| UGC pipeline | WS-G.4: strict Markdown-lite parser → closed AST (no raw-HTML node kind) → constrained serializer → DOMPurify behind the `licio-ugc` Trusted Types policy → TrustedHTML → the SINGLE sanctioned `UgcBody` sink; `normalizeUgcLink` drops javascript/data/vbscript/file schemes at parse time; the XSS-vector suite (script/event-handler/scheme/mXSS payloads) walks the rendered DOM; fail-closed degraded mode (no DOM ⇒ escaped plain text) | Complete |
| Link safety | WS-G.4.2c interstitial on suspicious external links: drainer blocklist, contract-interaction URL patterns, dApp-mimicry edit distance; click interception via native event delegation (sanitized HTML carries no handlers); verdicts NEVER await the network (cached blocklist + bootstrap warm-up + background refresh — transient user activation survives to `window.open`); openers severed on the returned proxy so popup blocking is detectable and falls back to the interstitial; verdicts never tied to identity | Complete |
| Uploads | WS-G.4.4 byte-level EXIF/GPS/XMP stripping for JPEG/PNG/WebP/AVIF BEFORE storage, alt text required for images (WCAG), the injectable `UploadScanner` seam gates attachment AND serving (`clear`/`pending`/`flagged`; default = local checks, WS-J.2.6b swaps in shared intelligence behind the same interface), bytes in S3 when configured (records survive either way) | Complete |
| Composer | 11 modes in 5 groups with type-specific fields, char counters, citation capture, acknowledgment-gates-submit; the payload builder validates through the SHARED schema (drift impossible) with field-level error mapping; encrypted IndexedDB drafts (trailing 800ms debounce — one encrypt+write per pause — plus visibility/unmount flushes, per-draft resume-or-discard recovery, draft id doubles as the server idempotency key); PWA share-target intake builds a STRUCTURED citation (url + title + accessed_at) with a safety-checked preview chip, merged at payload build only while its textarea line survives; VoiceDictation behind feature detection | Complete |
| Safety intake | `moderation_concern` requires a ratified WS-A reason code (fabricated codes 422), routes to the review queue (WS-J seam), never auto-actions; the heuristic contribution pre-screen can only HOLD for review (fail-toward-caution); harassment-cascade and burst anti-signals remain WS-E's | Complete |
| Health metrics | Per-thread conversation-health rollup (question→answer coverage, evidence density, correction uptake, accusation rate) — descriptive, owner/steward-facing, never a ranking input | Complete |
| Events | `contribution.created` (with `low_info_reply` classification via `classifyLowInfoReplyV0` in `@licio/invariants`), `evidence.added` (real correlation ids), `thread.state.changed` (both dimensions, audited transitions); WS-F lifecycle activity triggers now fire from real conversation events | Complete |
| Privacy hooks | WS-D.2.4 closed: `anonymizeContributions` tombstones contributions/evidence/uploads and REMOVES room memberships + steward rows (membership is personal data); `exportContributions` composes stories + contributions + evidence cards + room subscriptions + upload records with retrieval URLs (keyset-complete, §19.3/GDPR Art. 15) | Complete |
| Production bindings | Drizzle adapters for all five forum stores behind the same interfaces; gated integration tests (`forum-integration.test.ts`) prove them against the REAL migration chain — the drizzle-wrapped unique-violation mapping, transactional evidence co-create rollback, GIN subtree reads with keyset continuation, CHECK enforcement at the storage layer, DSAR `listByOwner`, exact keyset-cursor round-trips (adapters write millisecond-precision timestamps so cursors round-trip through ISO strings), and the S3 byte path against a fake bucket (SigV4-verified) — and these now RUN IN CI via the test job's service containers | Complete |
| Real-browser E2E | `ugc-safety.spec.ts` + `composer.spec.ts` against the preview's ENFORCING CSP in Chromium/Firefox/WebKit: the `licio-ugc` policy under real `require-trusted-types-for`, inert attack fixtures, interstitial interception + safe-link popup under intact activation, the 11-mode chooser with shared-schema validation + ack-gating, axe on every state (fixtures live in the styleguide workbench) | Complete |
| Residuals | WS-H Hodge/SCOI consumption of branch structure behind existing hooks; WS-I ranking consumption of health metrics (descriptive until then); WS-J queue ownership + the shared malware intelligence behind the `UploadScanner` seam; WS-K governed summary generation (the automated_draft layer stays heuristic until then); authenticated thread/submit browser E2E with a BFF-in-the-loop harness (WS-P — the composer + UGC sink are already real-browser covered via the workbench); cross-room bridge tooling (WS-I/WS-J) | Tracked elsewhere |

### WS-H: Core invariant services

Plan: `docs/planning/09-invariant-services.md`
Documentation: `docs/invariants/README.md`

Complete.  All eleven invariants run **shadow-only** (SPEC §30.4 / the
M2 "no hidden sanctions" gate): every output is stored observational,
the ranking boundary independently rejects shadow rows, and the ONLY
path to any effect is the WS-H.1.2e promotion gate (append-only
records, checklist-validated one-step promotions, always-available
owner-signed demotion).

| Sub-area | Key surface | Status |
|----------|-------------|--------|
| Platform | `invariant_outputs` envelope (coverage, registry-validated reason codes, fallback flag, version metadata, jsonb time_window + the §22.1/WS-H.1.1a index set and closed type/target CHECK vocabularies), per-type score-vector zod validation before insert, eleven validated invariant cards, the fallback execution wrapper (timeout/error → degraded reason-coded envelope + gap log/metric/run row; ranking proceeds with features OMITTED — proven with all eleven failing), compute tiers under the `invariants_hourly` lease with bounded batch concurrency, uniform health metrics, fail-closed `invariants.*` runtime config (write-time 422), CI + nightly regression/drift over deterministic synthetic datasets with pinned baselines | Complete |
| MERI | Exact partition-matroid rank (exact-URL > near-dup > source-lineage > evidence classes; monotone/submodular property-tested; greedy = brute-force optimum), §7.5 marginal gains + §7.4 dimensions, MinHash/LSH + confirmed-syndication/ownership assembly, similarity fallback flagged `MATROID_FALLBACK`, WS-H.2.4a coverage/confidence, the WS-E `hooks.redundancy` closure, exposure labels + the independent-sources drawer + the per-topic repeats preference | Complete |
| MFCI | Five-axis tables with the account-age bucket as the privacy-preserving group axis, the degree-2 Markov basis (connectivity brute-force-verified) driving the MH fiber sampler (stationary = the generalized hypergeometric; margins/nonnegativity invariant-tested), the add-one p̂ (`MFCI = −log p̂`, always finite), synchrony/target-concentration/phrase-repetition statistics, volume-conditioned cheap statistics + versioned null calibrations (`NULL_CALIBRATION_STALE`), risk states with held downward transitions, identifier-free `mfci_cases` whose clearing lifts the safety freeze (WS-H.3.3d), the WS-E `hooks.mfci` closure, MFCI-4 margin refs + MFCI-5 appeal summaries | Complete |
| GWEI | Locale/tenure cohorts from owned attention aggregates (user-provided metadata only), log-domain Sinkhorn + coupling rounding so every reported GW₂ is an exact-marginal upper bound with a seed/regularization stability interval, the seven §9.4 metrics, k-anonymity suppression (`SUPPRESSED_K_ANONYMITY`, distinguishable from zero) before ANY surface, the release-gate decision (override requires a documented owner), the parity-statements-only transparency export | Complete |
| SCOI | Embedding-captured lens interpretations (unit ball validated), identity restriction maps (v1 configuration, documented), normalized Dirichlet energy ∈ [0, 1] with the attained per-overlap normalizer, PSD Laplacian property-tested, context states (weaponized REQUIRES a safety signal), §10.6 ranking actions as promotion-gated descriptions, the H¹ structural diagnostic + harmonic-representative norm (v2, batch-only), "Where interpretations differ" + the needs-context gate + the composer warning | Complete |
| PHI | Privacy-preserving session sequences (opaque digest keys; topic-cluster ids + timestamps ONLY; TTL'd; capped) fed by the durable attention consumer, v0 narrow-loop/compulsive detection (same pure math client + server), embedding-derived orthonormal frames → exact orthogonal transports → gauge-invariant holonomy scores (spectral extraction; near-π/det = −1 `MATRIX_LOG_FALLBACK`), the conjugation verifier + output-boundary scan (frame-dependent fields throw), fail-closed sensitive/minor strictness, the non-blocking narrow-loop prompt + PHI-4 reset/reduce controls | Complete |
| Supporting | Hodge Helmholtz decomposition (CG on consistent normal equations; exact range orthogonality; `HarmfulTensionRisk ≡ 0` absent hostility — the WS-J seam defaults to 0), tropical min-plus earliest arrival + synchronized-cascade detection (documented arrival-profile rank), braid words from activity rankings with the Burau-at-−1 entropy bound (figure-eight anchor; braid relation verified), Reeb join/split landscapes with fragile-saddle bridge prompts, CID over verified permutation groups (v0 ranking certified attribute-blind; gate blocks above threshold), depth-3 path signatures via Chen (exactness tested) with session-health classification | Complete |
| Surfaces | `/v1/invariants/admin/*` (steward + MFA): health, reason-code-filterable outputs, WS-H.1.1b version comparison, the observational MFCI dashboard + case resolution, GWEI dashboards + transparency export, promotions, validated config writes, on-demand regression; public visibility-gated interpretation/lineage reads (stored shadow outputs only — no compute on page load) | Complete |
| Production bindings | Drizzle adapters for promotions/calibrations/run-metadata/mfci-cases behind the in-memory interfaces; gated integration tests run the real migration chain including a live-Postgres proof of the 0009 `time_window` text→jsonb USING conversion; the boot path swaps adapters, registers the durable consumers (`invariant-phi-sessions`, `invariant-mfci-intake`), and starts the lease-guarded scheduler | Complete |
| Residuals | the WS-I seam is CLOSED (the ranking boundary consults `effectsEnabled` per invariant: promoted effects enforce, shadow effects are computed and logged with `enforced: false`); WS-J owns queue UX, the hostility signal behind the Hodge seam, and the appeals flow over `appeal_summary`; WS-K owns learned restriction maps, framing/misleading classifiers, governed summaries; WS-P wires the GWEI/CID gates into the experiment framework and the transparency pipeline | Tracked elsewhere |

### WS-I: Ranking and distribution

Plan: `docs/planning/10-ranking-and-distribution.md`
Documentation: `docs/ranking/README.md`

Complete.  The SPEC §13.3 pipeline serves `GET /v1/feed` (front page +
`?topic=`) and `GET /v1/rooms/:roomId/feed` (WS-G-visibility-gated) end
to end, with PWAtt as a BOUNDED input (the §30.5 lift), invariant
effects gated on the WS-H promotion service, and the safe chronological
fallback one runtime kill-switch write away.

| Sub-area | Key surface | Status |
|----------|-------------|--------|
| Candidates | Eight organic retrievers behind the `CandidateRetriever` interface + closed registry (subscribed rooms, locale-region local news, PWAtt-threshold global with honest cold start, constructive-velocity emerging discussions, seen-story evidence additions, SCOI bridge candidates with context metadata, expert-led/human-summary explanations, per-room chronological catch-up) + the `room_surface_v1` scoper (inert outside room feeds); hidden/archived stories never retrieve; the orchestrator merges/dedupes (origins merged, max score kept), isolates failures with per-retriever timing, budgets, and re-validates the strict `Candidate` boundary; quotas reserve ceil(pct·budget) slots (fresh 15% / independent 20% / local 10%) with JOINT class protection (filling one class never breaks another's reserve), logged graceful degradation, and always-reported targets carrying an `applicable` flag | Complete |
| Surfaces | `front_page`; `topic` (`?topic=` scopes the pool and derives profile sensitivity from the topic — sensitive topics always select the conservative profile); `room` (`/v1/rooms/:roomId/feed` behind `roomContentVisibleToUser` — restricted/expert-led rooms read 404 for signed-out and pending users; the pool scopes to the room; lens balancing runs on REAL per-item assignments: each item's most frequent lens-tagged `lens_id`, ties lexicographic, pinned in the decision log for replay) | Complete |
| Feature store | Strict-closed WS-I.2.1a vector (every invariant field OPTIONAL — degraded ⇒ ABSENT, never zero) + the WS-I.2.1b denylist (the SHARED WS-A.1.1 list pinned to the versioned `denylist.config.json` artifact with a load-time drift assertion; typed `DeniedFinancialFieldError`; case-insensitive nested/camelCase matching) inside `upsert` on BOTH adapters; append-only `(item_id, revision)` history with optimistic concurrency + by-timestamp `getAt` snapshots + one-query DISTINCT ON bulk reads; `invariant_versions` (version/timestamp/config-hash) per row with batch-logged version distribution; populated by the durable `ranking-feature-store` consumer (story/thread-target `invariant.run.completed` AND `integrity.signal.detected` for the MFCI intake path's sub-minute freshness) + the hourly batch; `duplicate_cluster_id` from a bounded BFS over MinHash hits (chains A↔B↔C share one key); source reliability from the real §14.3 aggregates (correction frequency, evidence-type diversity, notes, the citation seam); per-request topic relevance never persisted | Complete |
| Safety filter | Authoritative, BEFORE scoring, never overridable (§24.4): WS-F hidden state, WS-E integrity removals, WS-G thread restriction, age gating (graphic/crisis excluded for teens AND unknown-age — fail closed), the WS-N jurisdiction seam, the BATCHED WS-J `ModerationStateProvider` seam (three bulk reads per request; unknown items fail closed); every exclusion logged with `policy_reason` + case ref; a feasibility assertion proves scoring cannot re-admit | Complete |
| Scoring | §5.4 exactly: convex §5.5 weights (validated through the SAME guardrail code WS-E uses; integer percents summing to exactly 100), baseline = profile-configured integer-percent weights over freshness/source-reliability/relevance (evergreen 50/30/20, breaking 60/25/15; schema-defaulted so pre-upgrade log snapshots replay identically; renormalized when personalization is off; Licio-internal history only — never popularity, never a truth score; cold-start nonzero), penalties pM=max(MFCI ladder, tropical) with inclusive-tie enforcement / pH (sensitive topics get stricter thresholds) / pT (reads ONLY Hodge `harmful_tension_risk`, zero absent hostility) / pR (MERI redundancy) — all nonnegative, enforced ONLY via `effectsEnabled`, able to drive totals below zero; constraints (MFCI cross-community exclusion, SCOI card/reduce/pause ladder, PHI per-user diversification over the max of recent session buckets, the recency-windowed suppression-aware GWEI deployment gate with TTL cache + the `ranking.gwei_override` documented-owner override) hard-limit the feasible set; `rankFeasibleSet` is clockless/seedless — byte-identical output for identical inputs | Complete |
| Diversification | MERI duplicate-cluster cap (default 2/page; demoted siblings ride the wire as `more_on_this_story` on the cluster representative), source ≤ 15% / topic ≤ 25% page shares with deterministic backfill + logged graceful degradation, lens representation (≥ 2 when available; real assignments on room surfaces), PHI tightening halves topic caps; SCOI-flagged items carry the compact `context_card` (level, lens count, open bridge attempts) and read `needs-context` | Complete |
| Decision logs + replay | EXACTLY one `RankingDecisionLog` per served request (ranked AND fallback; a failed write is a counted auditability incident, never a serving failure); privacy-bucketed requester (`bucket:<2 hex>`/`anonymous` — zod refinement AND a db CHECK reject identifier shapes); full per-item score/penalty breakdowns, per-feasible-item feature revisions, the profile SNAPSHOT, enforcement flags, resolved per-item relevance (the interest list itself is never persisted), per-item lens assignments; §22.4 retention 180–365d (clamped, swept); `replayDecision` re-executes the pure core at the recorded versions → structured diff (backward-compatible with pre-baseline_weights snapshots via schema defaults); a scheduled replay-regression sample alerts after deploys and verifies logged template ids still exist; `ranking.decision.logged` event per selected item (ONE batched insertMany) | Complete |
| Explanations | Closed template registry (positive/contextual/constraint/safety + honest fallback reasons), parameter zod validation, priority selection from the item's REAL signal profile (slowing reasons outrank positive; no raw statistics or thresholds in any rendered string; room counts claimed only when genuinely multi-room); LOCALE-READY rendering (`renderTemplate(id, params, locale)` guards prohibited language on the EN canonical then localizes; the `x-pseudo` two-language proof is CI-tested; catalogs slot into `LOCALE_CATALOGS`); the story page links each reason to the reader's own Signal Ledger; the §13.6/§30.6 prohibited-language list is ONE shared artifact enforced at render time, in the package suite, and by neutrality test 9 | Complete |
| Kill switch + fallback | Runtime config control (global/per-surface/per-profile scopes; §30.8 owner/trigger/rollback/review fields; audited engage/release; UNREADABLE state fails closed to the fallback); the fallback serves chronological order over the SAFETY-FILTERED set with no PWAtt/personalization/financial anything, an honest "ranking is paused" reason, and a `fallback: true` decision log | Complete |
| Neutrality suite | All ten WS-I.3 tests in CI on every PR (`pnpm check:neutrality` is a named test-job step): wallet-link feed equivalence on the front-page, topic, AND room surfaces (incl. the fallback + candidate sets, with synthesized wallet credentials and payment events in the durable log under the crypto flag), deep schema field walks, TRANSITIVE import-closure + runtime donor neutrality, treasury side-channel equivalence, governance-vote claim-label immutability (durable-log AND live-router-published legs), paid-status bypass checks, the ML feature audit (add → fail naming the field, remove → pass), the closed organic source enum (no `sponsored`), endorsement-language scans over templates + web copy, and financially-clean product-health metrics with the ACTUAL admin health payload introspected; complemented by the db table denylist + the wallet↔ranking BFS isolation targets | Complete |
| Admin surface | `/v1/ranking/admin/*` (steward + per-session MFA): decision queries on all six audit dimensions (TRUE SQL keyset pagination — composite `(timestamp, request_id)` row comparison; every read META-AUDITED as `ranking_decision_query`), decision detail, replay (`ranking_replay_run`), feature snapshots (`/features/:itemId[?at=ISO]`), the kill switch (`ranking_killswitch_change`), validated config writes (422; `ranking_config_change`), profiles, health | Complete |
| Config + scheduler | Fail-closed `ranking.scalars`/`ranking.profiles`/`ranking.gwei_override` keys (invalid stored values logged, reviewed defaults kept; profile sets all-or-none through the §5.5 loader; an unreadable override never overrides); hourly tick under the `ranking_hourly` Postgres lease: config reload, feature batch (+ version-distribution and staleness-needle logs), decision-log sweep, replay-regression sample + explanation-template existence check (per-task error isolation) | Complete |
| Production bindings | `DrizzleFeatureStore` (append-only PK realizes optimistic concurrency; DISTINCT ON bulk reads; by-timestamp snapshots) + `DrizzleDecisionLogStore` (jsonb containment queries for the audit dimensions; SQL keyset pagination) behind the in-memory interfaces; gated integration tests run the REAL migration chain (0012 tables + CHECKs, 0013 audit-enum extension) in CI's service containers, incl. the bulk serving-path reads on the WS-E/WS-F adapters; an opt-in RUN_PERF benchmark records the 10k-candidate core budget + decision-log query latency at depth; boot wires the adapters, registers the durable consumer, and starts the scheduler | Complete |
| Residuals | WS-J replaces the default `ModerationStateProvider` + supplies the Hodge hostility signal and coordinated-reporting detection behind existing seams; WS-N supplies the jurisdiction engine (defaults: none restricted); WS-K supplies governed topic classification + learned relevance; WS-L/WS-M plug real staging financial events into the neutrality harness (§30.6 pre-pilot requirement) and own sponsored surfaces (quarantined by the closed enum); WS-P wires experiment ids (field exists), the GWEI experiment-gate integration, and BFF-in-the-loop feed E2E; a first-class WS-D location preference can replace locale-region matching behind the same port | Tracked elsewhere |

### WS-J through WS-P

Plans: `docs/planning/11-trust-and-safety.md` through
`docs/planning/17-experimentation-and-launch.md`

Not yet started.  Read the relevant planning document and the
master index (`docs/planning/00-index.md`) before beginning
implementation.

## Vulnerability reporting

Licio follows a private disclosure process.  See `SECURITY.md` for
the full policy:

- **Contact:** `security@licio.app`
- **Acknowledgment SLA:** 48 hours
- **Critical patch SLA:** 14 days
- **In-scope:** XSS, CSRF, CSP/Trusted Types bypass, session flaws,
  supply-chain attacks, wallet exploits, privacy leakage

For non-security issues (features, documentation, tooling), the
standard issue tracker workflow applies.

---

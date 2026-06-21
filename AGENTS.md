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
(15 core + 18 flagged Knomosis topics in a separate bounded context), the
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
WS-G plus WS-T ship forum and conversation (`docs/forum/README.md`): a
comment-first contribution model where `comment` is the base live-write type
and `evidence`/`correction` remain typed enrichments, while the historical
contribution taxonomy remains readable for backward compatibility.  Each story
owns an inline comment section backed by the materialized-path `contributions`
tree (depth-capped, GIN-containment subtree reads) that shows exactly ONE nested
reply layer to protect the reading area; deeper threads — and the full
conversation — open in a dedicated comment-centric page
(`/stories/$storyId/comments`, `depth=2` + `?root=` re-rooting) reached by the
per-thread "continue" links and the section-level "Show more comments" entry, so
a reader drills arbitrarily deep one focused view at a time while a persistent
"Back to the story" control always returns them to the inline section.  The
§15.4 conversation/safety state machines are preserved (table-driven legal
transitions, audited transitions emitting `thread.state.changed`).  The WS-G.4
UGC pipeline remains the only DOM egress path (strict Markdown-lite AST with no
raw-HTML node → constrained serializer → DOMPurify `licio-ugc` Trusted Types
policy → THE single sanctioned `dangerouslySetInnerHTML` sink) with the
external-link safety interstitial and metadata-stripped same-origin image/GIF
uploads.  Evidence cards, §24.3 summaries (`cited_contribution_ids`), rooms,
lenses, steward roles, audited governance settings, report/block/mute seams,
conversation-health metrics, encrypted offline drafts, live same-origin comment
SSE, reply notifications, and reply-depth attention buckets are shipped; the
old `/threads` directory/branch reader and eleven-mode participation composer
are retired behind story-page comments and a `/threads/$threadId` redirect.
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
gated by WS-G content visibility, with REAL lens-tagged balancing), all
with seen-aware `?cursor=` pagination (each page a replayable decision
linking its parent; the fallback paginates too) and the WS-G visibility
bar enforced on the distribution side (restricted-room content never on
public feeds) —
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
WS-Q (content–room ownership and visibility,
`docs/planning/18-content-and-room-model.md`) implements the SPEC v0.7 model —
rooms own content, content owns conversation, binary public/private rooms with
orthogonal join-model/posting-policy axes, per-item public/`room_only`
visibility with private-room forcing (`deriveStoryVisibility`), native
image/video posts, tier-scoped canonical-URL dedup with cross-tier linking, the
`content.visibility.changed` core event (core topics 14→15), author
narrow/widen transitions, the steward public⇄private room cascade, and the
always-on surface-aware distribution gate (`filterByVisibility`) + item read
bar (`storyReadableByUser`) proven by the extended `check:neutrality`
containment leg.  The shared schemas, migrations (`0014`–`0020`,
expand→backfill→contract), and the ingestion/rooms/ranking backend are shipped,
along with: the native-video pipeline (byte-level MP4/WebM sniffing,
duration/size caps, offset-preserving metadata neutralization, range serving);
DSAR/anonymization across both tiers; takedown reach over room-tier content;
fail-closed content rollout flags (containment is NOT flaggable); the gated
end-to-end migration-validation harness (monotonic-visibility property, verified
against live pgvector); and the full WS-Q.5 client surface — the story-submission
composer (home-room picker, visibility lock, image/video modes, encrypted draft
autosave that round-trips room + visibility, and share-target link prefill),
native media rendering (no autoplay), the room shell/feed/in-room chip/create
form, the author visibility control, the participation-weighted front-page
framing (now also under the route-scanning no-applause gate), and the offline
cache-version bump.  An authenticated **BFF-in-the-loop E2E harness** (the WS-P
seed: an in-memory API `e2e-server` + a gated test-only login + a proxied
preview) drives the WS-Q flows in real browsers with axe.
WS-J (trust, safety, and abuse operations) is complete
(`docs/trust-safety/README.md`): user safety controls (taxonomy-bound reports
with idempotency + per-user/per-target rate limits + emergency routing; bilateral
blocks; one-directional mutes; appeals with reviewer independence enforced at
assignment AND decision; the unauthenticated published support contact; the
statement-of-reasons + appeal-outcome notice inbox), the role-gated steward
moderation console (priority/SLA report queue with filters/bulk/assignment +
new-case auto-assignment, the full-context review panel with role-gated reporter
identity + financial-data-free user history + the REAL WS-H invariant
decision-support + thread context + side-by-side edit diff, the capability-gated
action palette with reversal-integrity revert, the independence-enforcing appeal
review, the ROLE_INTEGRITY coordinated-report incident queue, and the append-only
audit log + small-cell-suppressed transparency export), the WS-J.2.6 automated
pre-check math (noisy-OR spam confidence + malware fail-toward-flagging auto-block
paths, duplicate-flood + policy-risk flag-only detectors) wired onto the WS-G
contribution submission path, and base-rate-conditioned coordinated-report
detection that actually DELAYS volume-driven enforcement pending integrity review
(MFCI-1/2; clearing the incident lifts the delay, confirming it dismisses the
case).  The five doctrine steward roles are persisted per-user (`steward_roles`)
with a single-sourced capability/queue policy pinned to the ratified
`STEWARD_ROLES.md`/`MODERATION_TAXONOMY.md` by a no-drift test.  Production wiring
is shipped: the gated Drizzle adapters for all ten stores (append-only audit
trigger that permits only the right-to-erasure NULLing of user references, so a
WS-D account hard-purge of a logged user succeeds while the record stays
immutable), the real WS-D/E/F/G/H ports (content removal → the WS-E item-safety
state the ranking seam reads + WS-G state, user-history stats,
`moderation.case.created` emission, the WS-H invariant reads, the side-by-side
snapshot), block/mute + contribution-safety enforcement across the forum + ranking
surfaces, and a WS-J demo seed.  WS-J residuals (the BFF E2E for the safety flows;
mounting the report/block affordances on every contribution row + profile; and the
SPEC enhancements beyond the §-DoD — two-person co-approval, escalation
auto-routing, room-steward-layer routing, the on-call paging provider) are tracked
in `docs/trust-safety/README.md`.
WS-K ships AI and model governance (`docs/ai-governance/README.md`): the new
browser-safe `@licio/ai-governance` domain package (schemas + deterministic
governance math, the WS-K counterpart of `@licio/ranking`) and the
`apps/api/src/ai-governance` services.  The value is the GOVERNANCE, not ML
inference — the governed models are deterministic providers (the WS-F heuristic
seam) carrying full governance identity, so a real backend swaps in behind the
unchanged surface.  It delivers the model registry whose deployment GATE is the
single chokepoint (no model deploys without a complete card + a passing harness
decision + a resolved risk assessment; old versions preserved; append-only
update_history), the NIST AI RMF / ISO 42001 risk assessments + the eight-use-case
AI inventory (governance marked never-autonomous), the pre-execution
prohibited-use guard (the five platform prohibitions + the §24.5 governance
matrix, by capability AND structural defense-in-depth, every block audited),
immutable data lineage (the §24.2 privacy-review precondition as a schema refine
+ DB CHECK), audit-sensitive `AIOutputRecord` logging (server-side SHA-256 config
hashing), the evaluation harness (bias two-proportion z-test, source-grounded
hallucination detection, the safety/privacy suite, the red-team gate) feeding the
deploy decision, runtime monitoring (drift/report-rate alerts + a human-approved
rollback recommendation, never autonomous), the content pipelines (topic
classification, claim extraction, the structured §24.3-quality/grounding-gated
summary published as the WS-G automated draft, translation with a number-invariant
consistency check), human-in-the-loop correction + accuracy metrics, the §24.5
governance summaries/advisories, the persistent provenance labels (the
upgrade-only ladder; the `AiLabel` web badge), the `ai.model.manage` RBAC
capability (the AI team), and the full boot wiring (the governed models registered
+ deployed through the real gate on boot, the durable `content.normalized`
classification consumer, the lease-guarded hourly scheduler).  WS-K residuals (the
gated Drizzle adapters for the WS-K stores; deeper client render-path integration;
WS-M proposal-data wiring; a real model backend; the WS-P experiment-log consumer)
are tracked in `docs/ai-governance/README.md`.  Workstreams WS-L
through WS-P are planned (planning documents exist under `docs/planning/`;
implementation not yet started, beyond the WS-O.4.5 adversarial suite and that
E2E-harness seed).  The extension workstream **WS-R** (Decentralized Data Plane,
Part I — offline content availability / LCAP v0.2) has shipped its **entire
pure-protocol core** as the new zero-dependency `@licio/lcap` package: the
deterministic CBOR (LDC) codec, content-addressed CIDs, COSE_Sign1 detached
ES256 low-S proofs with downgrade-resistant suite agility, and strict
closed-schema records/proofs (WS-R.0); the identity chain — device certificates,
room capabilities, revocation, and the §18.3 steps-6-11 chain validator (WS-R.1);
the record graph — contribution mapping, append-only edit/tombstone projection,
display ordering, device-fork detection (WS-R.2); blocks, fixed-size
chunking/reassembly, attachment laziness, and Compression-Streams gzip/deflate
with bomb caps (WS-R.3); the packfile / `.licio-bundle` format — streaming
writer/reader, partial import + quarantine, signed manifest (WS-R.4); the
anti-starvation lane scheduler (byte reservations, deficit-round-robin, the
clamped finite score) behind the `check:lcap-scheduler` CI gate (WS-R.5); the
transport-independent sync-decision plane — the pulse + frontier diff, exchange
request/response assembly, resource/privacy budget shrinking, privacy-scoped
interests, wants + resumable range fetch, and idempotent-ingestion keying
(WS-R.6) — plus the §17.1 frontier-first reconciliation order and the §17.5
`minimalClosure` the scheduler consumes (WS-R.7); the
single `validate()` trust-projection entry point over the §18.2 state lattice
(WS-R.8); the RFC 9162 Merkle / checkpoint plane — inclusion + consistency
proofs, witnesses, fork evidence (WS-R.9); the liveness / receipts /
durable-outbox model (WS-R.10); and the §25.1 conflict-table dispatch + the
trust/safety-aware visible-thread projection (WS-R.13) — all I/O-free,
exhaustively tested, and conformance-vector-pinned (`docs/lcap/README.md`).  The
remaining WS-R cards are predominantly **I/O integration** (the `lcap_v2`
IndexedDB store, the server ingestion/reconciliation routes + DB schema, the sync
wire orchestration, the DoS/privacy controls, the transport profiles, the client
surface, and the network simulator); they, and the entire WS-S private-rooms
(E2EE) plane, remain planned.  See "Implementation roadmap" below for the full
status table.

## Build and run

```bash
# Prerequisites: Node 22+ (pinned in .nvmrc), pnpm 9.15.4+.
corepack enable && corepack prepare pnpm@9.15.4 --activate
pnpm install

# Daily commands.
pnpm dev                            # web (5173) + api (3001); in-memory + seeds demo data (no DB/Redis)
pnpm build                          # shared → db/invariants → web/api
pnpm test                           # Vitest across all workspaces (80% coverage gate)
pnpm test -- --coverage             # with coverage report
pnpm test:e2e                       # Playwright E2E (Chromium, Firefox, WebKit)
pnpm --filter web test:e2e:bff      # BFF-in-the-loop authenticated E2E (in-memory API)
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
pnpm check:adversarial              # the WS-O.4.5 ensemble adversarial suite
pnpm check:lcap-scheduler           # the WS-R.5.4 LCAP lane anti-starvation gate
pnpm check:no-applause              # no likes/votes/karma/reactions in components + routes
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
pnpm --filter @licio/ai-governance build  # build AI-governance package
pnpm --filter @licio/governance build  # build AI-governed-rooms domain package
pnpm --filter @licio/lcap build     # build LCAP offline-availability protocol core
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
  affordances appear in `apps/web/src/components/` or `apps/web/src/routes/`
  (the latter covers route-level page copy, e.g. the front-page framing).
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
│   │   │   ├── sw-push.js       --   push + background-sync + share-target handler
│   │   │   └── assets/          --   brand lockups: light_/dark_ {192,512}.png
│   │   │                              (theme-adaptive logo, favicons, PWA icons)
│   │   └── src/
│   │       ├── main.tsx                 -- app entry point
│   │       ├── routeTree.gen.ts         -- auto-generated route tree
│   │       ├── components/
│   │       │   ├── ui/                  -- 33 reusable UI primitives (incl. BrandLogo)
│   │       │   ├── ai/                  -- AiLabel provenance badge (WS-K, machine-generated/
│   │       │   │                           AI-classified/AI-draft/AI-translated + revisions)
│   │       │   ├── a11y/                -- RouteAnnouncer, SkipToContent, useSpaFocus
│   │       │   ├── cognitive/           -- DefinedTerm, ProgressiveDisclosure, jargon
│   │       │   ├── composer/            -- StoryComposer + shared affordances (Attachment,
│   │       │   │                           CitationCapture, PrivacyWarning, VoiceDictation)
│   │       │   ├── comments/            -- Inline CommentSection + comment composer/media (WS-T)
│   │       │   ├── feed/                -- FeedModeSwitcher, DiminishingReturnsPrompt
│   │       │   ├── rooms/               -- RoomCreateForm + RoomSettingsForm + RoomMembership
│   │       │   │                           (WS-Q.5.3c; join/leave ⇒ governance membership)
│   │       │   ├── story/               -- StoryCard, ContextCard, RatingLabel,
│   │       │   │                           ExposureLabel, TopicRepeatsButton,
│   │       │   │                           WhereInterpretationsDiffer (WS-H), StoryMedia +
│   │       │   │                           AuthorVisibilityControl + feed-card (WS-Q.5)
│   │       │   ├── safety/              -- ReportButton/ReportSheet (two-tap report),
│   │       │   │                           block/mute controls, notice inbox + appeal (WS-J.1)
│   │       │   ├── moderation/          -- ModerationConsole (queue/review/palette/appeals/
│   │       │   │                           integrity/audit; server-side authorized) (WS-J.2)
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
│   │       │   ├── blob-url.ts          --   WS-Q.5.2c object-URL sanitizer (local media preview)
│   │       │   ├── queries.ts           --   TanStack Query hooks
│   │       │   ├── query-keys.ts        --   query-key factory
│   │       │   ├── query-client.ts      --   SWR defaults (30s stale, 5min gc)
│   │       │   ├── bootstrap.ts         --   app initialization
│   │       │   ├── sw-register.ts       --   service-worker registration
│   │       │   ├── telemetry.ts         --   privacy-safe RUM (sendBeacon)
│   │       │   ├── time.ts              --   time utilities
│   │       │   └── cn.ts               --   class-name merger
│   │       ├── offline/                 -- offline-first (IndexedDB)
│   │       │   ├── db.ts                --   6 object stores, versioned migrations
│   │       │   ├── store.ts             --   zod-validated integrity layer
│   │       │   ├── queue.ts             --   pending-operation sync queue
│   │       │   ├── sync.ts              --   sync engine
│   │       │   ├── drafts.ts            --   contribution + story draft management
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
│   │       │   ├── threads_.$threadId.tsx -- legacy thread→story#comments redirect
│   │       │   ├── rooms*.tsx           --   room views + governance
│   │       │   ├── profile*.tsx         --   profile, settings, privacy, security, saved
│   │       │   ├── submit.tsx           --   content submission (auth-guarded)
│   │       │   └── -pages/              --   internal page components
│   │       ├── design-system/           -- design-token SSOT
│   │       │   ├── tokens.ts            --   color tokens (neumorphic fabric
│   │       │   │                              surfaces), neu soft-UI shadows,
│   │       │   │                              light/dark
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
│           ├── index.ts                 -- server entry point (Postgres/Redis)
│           ├── e2e-server.ts            -- in-memory BFF for the E2E harness (gated)
│           ├── routes/
│           │   ├── v1.ts                --   /v1/* API routes
│           │   ├── test-auth.ts         --   test-ONLY login (e2e-server only, gated)
│           │   ├── auth.ts              --   /v1/auth/* (WS-D auth surface)
│           │   ├── privacy.ts           --   /v1/privacy/* (WS-D privacy controls)
│           │   ├── events.ts            --   POST /v1/events/attention (WS-E.1.3)
│           │   ├── stories.ts           --   POST /v1/stories, search, takedowns, reads (WS-F)
│           │   ├── ingestion-admin.ts   --   /v1/ingestion/admin/* steward surface (WS-F)
│           │   ├── invariants-admin.ts  --   /v1/invariants/admin/* analyst surface (WS-H)
│           │   ├── invariants-public.ts --   public SCOI/MERI story reads (WS-H)
│           │   ├── ranking-admin.ts     --   /v1/ranking/admin/* steward surface (WS-I)
│           │   ├── forum.ts             --   /v1/contributions, story comments/SSE,
│           │   │                             thread redirect reads, summaries, uploads, flags
│           │   ├── rooms.ts             --   /v1/rooms/* + lenses + governance (WS-G)
│           │   ├── trust-safety.ts      --   reports, blocks, mutes, appeals, support,
│           │   │                             notice inbox (WS-J.1)
│           │   ├── moderation-console.ts --  role-gated console: queue, review, action
│           │   │                             palette, appeals, incidents, audit (WS-J.2)
│           │   ├── ai-governance-admin.ts --  /v1/ai/admin/* AI-team model lifecycle +
│           │   │                             deploy gate + steward review (WS-K)
│           │   ├── ai-governance-public.ts -- model-card lookup, translation,
│           │   │                             summary/translation reports (WS-K)
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
│           │   ├── submission.ts        --   POST /v1/stories orchestration (room/posting
│           │   │                             guards + visibility derivation + tier dedup, WS-Q)
│           │   ├── visibility.ts        --   WS-Q.2.4 author narrow/widen visibility transitions
│           │   ├── content-flags.ts     --   WS-Q.6.2 fail-closed content rollout flags
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
│           ├── forum/                   -- WS-G/WS-T forum, comments, rooms, lenses, summaries
│           │   ├── stores.ts            --   store interfaces + in-memory adapters
│           │   ├── services.ts          --   injectable container + metrics + boot wiring
│           │   ├── contributions.ts     --   create/edit/remove guard chain + live fan-out
│           │   ├── comments.ts          --   story comment pages, reply previews, media projection
│           │   ├── comment-broadcaster.ts -- same-origin live comment broadcaster port
│           │   ├── threads.ts           --   overview/anchor/subtree compatibility reads
│           │   ├── tree.ts              --   materialized-path math + depth-first ordering
│           │   ├── rooms.ts             --   rooms/lenses/stewards/joins + the binary
│           │   │                             read bar / userMayPostTopLevel / Commons (WS-Q)
│           │   ├── room-visibility.ts   --   WS-Q.3.3b/3.4 governance settings + visibility cascade
│           │   ├── video.ts             --   WS-Q.2.3d validate-only MP4/WebM sniff + metadata strip
│           │   ├── data-rights.ts       --   WS-Q.3.5 DSAR export + anonymize across both tiers
│           │   ├── summaries.ts         --   §24.3 layered summaries (supersede semantics)
│           │   ├── transitions.ts       --   audited §15.4 state machines → thread.state.changed
│           │   ├── safety.ts            --   heuristic contribution pre-screen (WS-J/K seam)
│           │   ├── exif.ts              --   byte-level image metadata stripping (WS-G.4.4)
│           │   ├── config.ts            --   fail-closed runtime config (forum.* keys)
│           │   └── drizzle-forum-stores.ts -- production Postgres adapters (gated)
│           ├── moderation/               -- WS-J trust, safety, and abuse operations
│           │   ├── stores.ts            --   ten store interfaces + in-memory adapters
│           │   ├── drizzle-moderation-stores.ts -- production Postgres adapters (gated)
│           │   ├── reports.ts           --   submission + idempotency + rate limits +
│           │   │                             routing + coordinated-report detection (WS-J.1.1/2.6e)
│           │   ├── relations.ts         --   block/mute CRUD + the RelationshipReader seam
│           │   ├── appeals.ts           --   eligibility + independent assignment + decision
│           │   ├── actions.ts           --   action palette + reversal-integrity revert + MFCI-2 gate
│           │   ├── incidents.ts         --   ROLE_INTEGRITY coordinated-report incident review
│           │   ├── audit.ts             --   append-only writer + suppressed transparency export
│           │   ├── notices.ts           --   statement-of-reasons + appeal-outcome inbox
│           │   ├── review.ts            --   queue + full-context review + appeal projections
│           │   ├── prechecks.ts         --   WS-J.2.6 detection math (spam/malware/flood/policy-risk)
│           │   ├── forum-integration.ts --   the WS-J.2.6 contribution-safety classifier + sink
│           │   ├── malware-fetch.ts     --   WS-J.2.6b redirect-chain malware verdict (SSRF-safe)
│           │   ├── assignment.ts        --   load-balanced assignment (reports + appeals)
│           │   ├── authz.ts             --   doctrine-role authorization (MFA + senior + integrity)
│           │   ├── ports.ts             --   content/user/invariant/event/alert seams (safe defaults)
│           │   ├── production-ports.ts  --   the REAL ports over WS-D/E/F/G/H
│           │   ├── support.ts           --   the unauthenticated published support contact
│           │   ├── config.ts            --   fail-closed runtime config (moderation.* keys)
│           │   ├── scheduler.ts         --   lease-guarded sweeps (mute expiry, queue gauges)
│           │   └── services.ts          --   injectable container + singleton + boot wiring
│           ├── ai-governance/            -- WS-K AI and model governance
│           │   ├── stores.ts            --   store interfaces + in-memory adapters (registry,
│           │   │                             lineage, output records, review queue, …)
│           │   ├── registry.ts          --   model registry + the deployment GATE (WS-K.1.1b)
│           │   ├── guard.ts             --   the pre-execution ProhibitedUseGuard + audit (WS-K.1.1d)
│           │   ├── harness.ts           --   evaluation-harness orchestrator + decision (WS-K.1.2e)
│           │   ├── output-records.ts    --   immutable AIOutputRecord writer + config hash (WS-K.1.1f)
│           │   ├── lineage.ts           --   data lineage + privacy-review precondition (WS-K.1.1e)
│           │   ├── models.ts            --   governed deterministic models + classifier + translator
│           │   ├── seed.ts              --   register + DEPLOY models through the gate; inventory
│           │   ├── pipelines.ts         --   topic classification + claim extraction (WS-K.1.3a/b)
│           │   ├── summaries.ts         --   AI summary + §24.3 quality/grounding gate (WS-K.1.4)
│           │   ├── translation.ts       --   translation + consistency check (WS-K.2.1a)
│           │   ├── correction.ts        --   human-in-the-loop correction + accuracy (WS-K.1.3c)
│           │   ├── governance-ai.ts     --   §24.5 proposal summaries + advisories (WS-K.2.2a)
│           │   ├── runtime-monitor.ts   --   drift/report-rate alerts + rollback rec (WS-K.1.2f)
│           │   ├── config.ts            --   fail-closed runtime config (ai.* keys)
│           │   ├── metrics.ts           --   observability counters/gauges
│           │   ├── scheduler.ts         --   lease-guarded hourly tick
│           │   ├── wiring.ts            --   deps-builders + the durable classification consumer
│           │   └── services.ts          --   injectable container + singleton
│           ├── lcap/                     -- WS-R server-side LCAP I/O binding
│           │   ├── server-ingest.ts      --   ingestion engine over the pure ingestRecord +
│           │   │                             validate(): CID-verified commit, idempotency + fork
│           │   │                             detection (WS-R.12.1a/c), server-computed §18.3
│           │   │                             validation over registered identity state (R.12.1b),
│           │   │                             commitBatch (§24.4 ordered, §27.2 graph-guarded);
│           │   │                             durable state via the LcapServerStore boundary
│           │   ├── store.ts              --   the LcapServerStore boundary (WS-R.12.2): async CAS +
│           │   │                             acceptance log + device-seq + fork evidence; the
│           │   │                             in-memory adapter (CID-opaque, ordered acceptance log)
│           │   ├── drizzle-store.ts      --   the gated Postgres adapter for LcapServerStore (WS-R.12.2)
│           │   ├── routes.ts             --   §29 routes: content-read GETs by CID + the
│           │   │                             pack-import POST /packs (CSRF-exempt, rate-limited;
│           │   │                             §22.1.1 status), mounted at /api/lcap/v2 (WS-R.12.4)
│           │   └── service.ts            --   the process-wide ingestion-server singleton
│           ├── lib/
│           │   ├── rate-limit.ts        --   global fixed-window budget (no client keying)
│           │   ├── push-service.ts      --   VAPID push (session-scoped delete)
│           │   ├── vapid.ts             --   VAPID key management
│           │   ├── logger.ts            --   pino logger setup
│           │   ├── story-media.ts       --   WS-Q.5.2c story→feed media projection
│           │   ├── media-urls.ts        --   WS-Q.5.2c signed media read URLs (mint/verify)
│           │   ├── demo-data.ts         --   demo feed fixtures + stable demo ids
│           │   └── demo-seed.ts         --   rich dev seed: dev test accounts
│           │                                  (admin/steward/expert), rooms/stories across
│           │                                  every lifecycle state, evidence + divergent
│           │                                  lenses + signatures + a native image post +
│           │                                  a moderation review queue; seedOperationalSignals
│           │                                  COMPUTES the invariant outputs (real WS-H batch)
│           │                                  and PRODUCES the Signal Ledger (real WS-E PWAtt
│           │                                  scorer); runs on non-prod boot
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
│   │       │   ├── steward-roles.ts     --   the five doctrine roles + capability/queue
│   │       │   │                             policy + appeal-eligibility matrix (WS-J)
│   │       │   ├── moderation-api.ts    --   user-facing trust & safety contracts (WS-J)
│   │       │   ├── moderation-console-api.ts -- steward console contracts (WS-J)
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
│   │       │                                 tiers, 15 core topic schemas, topic
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
│   │   ├── drizzle/                     --   generated SQL migrations (WS-D – WS-K)
│   │   └── src/
│   │       ├── schema/                  --   PostgreSQL table definitions
│   │       │   ├── ai-governance.ts     --     WS-K: model cards/registry, risk assessments,
│   │       │   │                               inventory, lineage, output records, evaluations,
│   │       │   │                               corrections, blocked-invocation audit, summaries/
│   │       │   │                               translations + reports, runtime metrics/alerts
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
│   │       │   ├── moderation.ts        --     WS-J cases, reports, actions, append-only
│   │       │   │                               audit (right-to-erasure-safe trigger), blocks,
│   │       │   │                               mutes, appeals, notices, incidents (+steward_roles)
│   │       │   ├── lcap.ts              --     WS-R.12.2 LCAP server state: content store,
│   │       │   │                               per-room acceptance log, device-seq index,
│   │       │   │                               fork evidence (no FK edges; CID-addressed)
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
│   ├── ai-governance/           -- WS-K pure AI-governance domain (no I/O; browser-safe)
│       └── src/
│           ├── schemas/                 --   model card, registry, NIST/ISO risk assessment,
│           │                                 inventory, prohibited-use, data lineage, output
│           │                                 record, evaluation results, pipelines, summary +
│           │                                 quality, translation, correction, governance,
│           │                                 provenance labels (all zod + co-located types)
│           ├── prohibited-use.ts        --   the guard core + the §24.5 capability matrix
│           ├── bias-audit.ts            --   two-proportion z-test + disparity gating
│           ├── hallucination.ts         --   source grounding + consistency + attribution
│           ├── safety-suite.ts          --   PII/harmful/minimization/disclaimer checks
│           ├── red-team.ts              --   coverage + critical-finding gate
│           ├── harness.ts               --   eval-set selection + aggregation + decision
│           ├── summary-quality.ts       --   the five §24.3 quality constraints
│           ├── inventory.ts             --   the canonical 8 use cases + risk assessments
│           ├── labels.ts                --   the upgrade-only provenance label ladder
│           ├── canonical-json.ts        --   deterministic config-hash serialization
│           └── __tests__/               --   ~13 deterministic unit/property suites
│   └── lcap/                    -- WS-R LCAP v0.2 protocol core (no I/O; zero npm deps in
│       └── src/                 --   the codec/CID/COSE core; browser-safe; NEVER @licio/db)
│           ├── runtime.ts              --   WebCrypto adapter + BufferSource helper (no node: leak)
│           ├── priority.ts             --   §15.1.1 priority ↔ class ↔ lane SSOT
│           ├── cbor/                   --   LDC deterministic CBOR (encode/decode/errors/types)
│           ├── cid/                    --   §9.2 CID construction + RFC 4648 base32 + sha256
│           ├── cose/                   --   aad, ecdsa (low-S), keys, suites, sign1 (COSE_Sign1)
│           ├── schemas/                --   strict zod records/proofs/pack/checkpoint/receipt + LDC codec
│           ├── identity/               --   cert, capability, sequence chain, revocation, chain validator
│           ├── limits/                  --   §27.2 malicious-dependency-graph guard (cycle/fan-out/
│           │                                depth/dup-dep/private-in-public/unknown-field detectors)
│           ├── records/                --   contribution mapping, edit/tombstone projection, fork detection
│           ├── block/                  --   descriptor, fixed-size chunking, attachment split, compression
│           ├── pack/                   --   uvarint, streaming writer/reader, partial import, manifest
│           ├── scheduler/              --   reservations, candidate closure, DRR allocator, clamped score
│           ├── sync/                   --   §16/§17 sync-decision plane: closure, frontiers, pulse,
│           │                                reconcile, budgets, interests, wants/resume, exchange,
│           │                                server-ingest (§24.1 commit-stage decision),
│           │                                ingest-order (§24.4 topological validation order)
│           ├── checkpoint/             --   RFC 9162 merkle, room log, inclusion/consistency, witness
│           ├── validate/               --   §18 trust-state lattice + the single validate() entry point
│           ├── liveness/               --   liveness state machine, receipts, durable-outbox logic
│           ├── conflict/               --   §25.1 conflict dispatch + visible-thread projection
│           ├── test-vectors/           --   normative golden corpus (cbor/cid/sign1 .json)
│           └── __tests__/              --   unit + conformance-replay + determinism properties
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
│   ├── OFFLINE_SPEC.md          -- LCAP v0.2 delay-tolerant sync (WS-R extension spec)
│   ├── PRIVATE_SPEC.md          -- E2EE private P2P rooms (WS-S extension spec)
│   ├── planning/                -- per-workstream planning documents
│   │   ├── 00-index.md          --   master index (~858 atomic tasks)
│   │   ├── 01-repository-foundation.md  -- WS-0
│   │   ├── 02-doctrine-and-policy.md    -- WS-A
│   │   ├── 03-design-system.md          -- WS-B
│   │   ├── 04-pwa-client.md             -- WS-C
│   │   ├── 05–17-*.md                   -- WS-D through WS-P
│   │   ├── 18-content-and-room-model.md -- WS-Q (room-owned content + visibility)
│   │   └── 19-decentralized-data-plane.md -- WS-R (LCAP v0.2) + WS-S (E2EE P2P rooms): the
│   │                                          Decentralized Data Plane (supersedes 19/20;
│   │                                          ext of OFFLINE_SPEC.md + PRIVATE_SPEC.md)
│   ├── design-system/           -- design system documentation
│   ├── pwa-client/              -- PWA implementation documentation
│   ├── identity/                -- WS-D implementation reference
│   ├── events/                  -- WS-E implementation reference
│   ├── ingestion/               -- WS-F implementation reference
│   ├── forum/                   -- WS-G implementation reference
│   ├── invariants/              -- WS-H implementation reference
│   ├── ranking/                 -- WS-I implementation reference
│   ├── trust-safety/            -- WS-J implementation reference
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
@licio/ai-governance       (depends on @licio/shared only; browser-safe,
                            NEVER @licio/db — the WS-K governance domain has
                            no database access by construction)
@licio/governance          (depends on @licio/shared only; browser-safe,
                            NEVER @licio/db — the WS-U AI-governed-rooms domain
                            (policy DSL, kernel, capabilities, elections) has
                            no database access by construction)
@licio/lcap                (depends on @licio/shared, zod; browser-safe,
                            NEVER @licio/db — the WS-R LCAP protocol core
                            (deterministic CBOR, CIDs, COSE detached proofs,
                            schemas) has no database access by construction;
                            the codec/CID/COSE core carries zero npm imports —
                            WebCrypto + a hand-rolled CBOR/COSE subset only)

apps/web                   (depends on @licio/shared, @licio/invariants,
                            @licio/ai-governance; NEVER @licio/db — enforced
                            by check:workspace-deps)
apps/api                   (depends on @licio/shared, @licio/db,
                            @licio/invariants, @licio/ranking,
                            @licio/ai-governance, @licio/governance,
                            @licio/lcap)
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

**Pinned transitive override (`ws`).**  `pnpm.overrides` pins `ws` to
`^8.21.0`.  `viem` (the WS-D SIWE / EIP-4361 verifier) pins `ws@8.20.1`
*exactly*, which carries GHSA-96hv-2xvq-fx4p (a WebSocket-server
memory-exhaustion DoS).  `viem@2.52.2` is the latest release and no `viem`
version yet pins a patched `ws`, so the override is the only remediation
(8.20.1 → 8.21.0 is an API-compatible patch; `pnpm audit --audit-level=high`
is clean with it).  `ws` is viem's RPC WebSocket transport; Licio uses
`viem` only for offline SIWE signature verification and runs no `ws`
server, so exploitability is low regardless.  Remove this override once
`viem` ships a release pinning `ws >= 8.21.0`.

**Pinned transitive override (`undici`).**  `pnpm.overrides` pins `undici`
to `^7.28.0`.  `undici` reaches the tree only through `jsdom@29.1.1` (the
Vitest jsdom test environment), which declares `undici@^7.25.0` and would
otherwise resolve it to 7.27.2.  7.27.2 carries GHSA-vmh5-mc38-953g (high; a
TLS certificate-validation bypass via dropped `requestTls` in the SOCKS5
`ProxyAgent`) and GHSA-pr7r-676h-xcf6 (moderate; cross-user information
disclosure), both patched in 7.28.0.  `jsdom@29.1.1` does not yet ship a
release pinning a patched `undici`, so the override is the remediation
(7.27.2 → 7.28.0 is the latest 7.x and within jsdom's `^7.25.0` range, so
it is API-compatible; `pnpm audit --audit-level=high` is clean with it).
`undici` is a test-only transitive dependency (jsdom's `fetch`
implementation); it never reaches the production bundle, so exploitability
is low regardless, but the `pnpm audit --audit-level=high` CI gate flags it
tree-wide.  Remove this override once `jsdom` ships a release pinning
`undici >= 7.28.0`.

## Reading large files

`docs/SPEC.md` and `docs/planning/00-index.md` (~858 tasks) are large.
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

- **Neumorphic fabric theme.**  Surfaces are soft, tinted neutrals — the
  canvas is intentionally **not** pure white/black (a white neumorphic
  highlight is invisible on white).  Apply soft-UI depth with the
  `neu-raised`/`neu-pressed`/`neu-inset` utilities (theme-aware
  `--licio-shadow-*` tokens), never ad-hoc `box-shadow`; the brand logo
  (`BrandLogo`, `public/assets/`) is theme-adaptive.  The decorative woven
  background texture was removed pending a redesign of the background theme —
  the canvas is currently a solid theme-aware surface colour.  The lighting is
  decorative: keep solid borders + focus rings, and never relax the token
  contrast ratios verified in `tokens.test.ts`.

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
(sendBeacon cannot set custom headers), `/v1/takedowns` (public copyright
intake — no session to ride), and `/api/lcap/v2/packs` (WS-R.12.4 pack
import — device-certificate-authenticated content with no session cookie;
abuse bounded by its own rate limit + the §27 caps + the graph guard).

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

The core specification defines 18 workstreams (WS-0 through WS-Q).
WS-T (conversation as comments) and the cross-cutting **WS-U**
(AI-governed-rooms redesign) extend the core spec.  Two **extension
workstreams** — WS-R and WS-S — derive from the standalone
`docs/OFFLINE_SPEC.md` (LCAP v0.2) and `docs/PRIVATE_SPEC.md`
specifications rather than `docs/SPEC.md`; both are post-M3
resilience/privacy extensions and are not launch-blocking for the core
social product.  **WS-U** is the maintainer's binding redesign of AI's
role (`docs/planning/22-ai-governed-rooms.md`; SPEC §16.6/§24.6): every
room has an **elected steward** whose only two powers are to propose a
community-approved, member-downloadable AI **model** and its **prompt**
(both ratified by a Knomosis member vote), and the approved **in-room AI
agent** may then moderate, manage the room treasury, and facilitate
lawmaking **within community-voted, kernel-enforced bounds, holding no
keys, subordinate to a non-overridable platform legal floor**.  It is
**doctrine-first** (Stage 0: SPEC + policy + plan landed; no runtime code
yet), re-scopes WS-K into the platform evaluation/transparency substrate,
amends WS-J/L/M, and preserves the pay-to-rank firewall and fail-closed
crypto in full.
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
| WS-J | Trust, safety, and abuse operations | Complete (residuals tracked, `docs/trust-safety/README.md`) |
| WS-K | AI and model governance | Complete (residuals tracked, `docs/ai-governance/README.md`); **re-scoped by WS-U** into the platform eval/transparency substrate for community room models |
| WS-L | Knomosis and wallets | Planned |
| WS-M | Treasury and governance | Planned |
| WS-N | Compliance | Planned |
| WS-O | Security and reliability | Planned (WS-O.4.5 adversarial hardening shipped) |
| WS-P | Experimentation and launch | Planned |
| WS-Q | Content–room ownership and visibility | Complete |
| WS-R | Offline content availability (LCAP v0.2) | In progress (extension; `docs/OFFLINE_SPEC.md`) — **pure-protocol core (`@licio/lcap`) shipped**: WS-R.0 foundations (deterministic CBOR/LDC, CIDs, COSE_Sign1 ES256 low-S proofs, suite agility, closed-schema records), WS-R.1 identity chain (§18.3 validator), WS-R.2 record graph + fork detection, WS-R.3 blocks/chunking/compression, WS-R.4 packfile/`.licio-bundle`, WS-R.5 lane scheduler + `check:lcap-scheduler` gate, WS-R.6 sync-decision plane (pulse/exchange/interests/wants/budgets/idempotency), WS-R.7 reconciliation (frontier-first order + `minimalClosure`), WS-R.8 `validate()` trust projection, WS-R.9 RFC 9162 Merkle/checkpoint, WS-R.10 liveness/receipts/outbox, WS-R.13 conflict dispatch, the WS-R.12.1 server-ingestion commit-stage decision core (`ingestRecord`), and the WS-R.12.1b §24.4 topological ingestion-order resolver (`resolveIngestionOrder`: prerequisites-before-dependents order with class priority, transitively-absent missing-dependency detection, cycle isolation), and the WS-R.14.2 §27.2 malicious-dependency-graph guard (`checkDependencyGraph`: cycle/fan-out/depth/duplicate-dep/private-in-public/unknown-critical-field detectors mapped to §16.11 wire codes) — all conformance-vector-pinned (`docs/lcap/README.md`); plus the WS-R.12.1a/b/c **in-memory server binding** in `apps/api/src/lcap` (`LcapIngestServer`: CID-verified CAS + per-room acceptance log + authoritative idempotency/fork detection + **server-computed `validate()`** over registered identity state — device certs, room capabilities, account/room authority keys, revocations — never a client-supplied verdict + `commitBatch` ordered batch ingestion, graph-guarded before expansion) + the WS-R.12.4 §29 routes (the content-read endpoints `GET /api/lcap/v2/{records,proofs,blocks}/:cid` (with RFC 7233 resumable range/206 reads) + the CSRF-exempt, rate-limited pack-import `POST /api/lcap/v2/packs` — read under the WS-R.4.2 caps, every CID-verified frame durably stored (proofs/blocks then fetchable via the GET routes), identity frames registered, contributions committed through validate→guard→commit, one §16.11 status per object — with §22.1.1 status mapping, mounted through the global security middleware) + the WS-R.12.2 `LcapServerStore` boundary (the async store interface — CAS + acceptance log + device-seq + fork evidence — with BOTH the in-memory adapter AND the **gated Drizzle/Postgres adapter** (`drizzle-store.ts` over migration `0039`, DATABASE_URL-gated, selected in `service.ts`), proven by the parameterized store-contract test); the remaining I/O-integration cards (the rest of WS-R.12.4 — exchange/pulse endpoints — the rest of WS-R.14/15/16/17/18 + WS-R.11) planned |
| WS-S | Private P2P rooms (E2EE) | Planned (extension; `docs/PRIVATE_SPEC.md`) |
| WS-T | Conversation as comments | Complete |
| WS-U | AI-governed rooms (redesign) | Doctrine ratified (Stage 0) + runtime Stages 1-4 & 5-core shipped: the `@licio/governance` pure domain (policy DSL, proof-carrying kernel, capabilities, elections, member ratification, lawmaking facilitation), the `knomosis` schema + migrations `0035`–`0038` (isolation-proven), the `GovernanceService` (member-gated/law-pack-driven seat elections, model admission + member ratification vote, bounded moderation agent with real author-history + author statement-of-reasons notices, deterministic lawmaking facilitation, kernel-backed treasury), and the rate-limited, uuid-validated, room-content-bar-gated `/v1/rooms/*` governance + ratification + lawmaking routes (ballots room-bound + close-time-enforced; one-open-ratification atomic); residuals (the WS-M lawmaking trigger + on-chain election mode, the remaining web surfaces, gated Drizzle adapters) tracked in `docs/governance/README.md` |

Read the per-workstream planning document under `docs/planning/`
before starting new work.  The master index at
`docs/planning/00-index.md` lists all ~971 atomic tasks.

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
5. `docs/DEVELOPMENT.md` — if the change affects the local dev environment,
   the seeded demo data, or the dev test accounts / sign-in flow.

Canonical ownership: `docs/SPEC.md` owns the design; this file owns
engineering conventions; `README.md` owns the top-level introduction.

**Don't extend audit narratives in this file.**  Per-audit and
per-workstream completion details belong in commit messages and PR
descriptions.  This file describes the *current state*, not the path
that got us here.

**No workstream-reference section.**  Per-workstream plans, design
rationale, sub-area breakdowns, and per-task detail live exclusively in
the relevant `docs/planning/` document (indexed by
`docs/planning/00-index.md`) and the per-workstream `docs/*/README.md`
implementation references.  Do **not** reintroduce a "Workstream
reference" section or equivalent per-WS index/detail tables into this
file.  The only workstream-level material this file keeps is the
one-line-per-workstream status table under "Implementation roadmap."

## Implement-the-improvement rule

When an audit, code review, or any reading of the codebase surfaces a
discrepancy between the **code** and the **documentation, docstring,
comment, type signature, or design intent** that describes it, and the
description represents an *improvement* over the actual code (a more
complete behaviour, a more symmetric API, a stronger invariant, a routed
dispatch where the code is a stub, a function that "should" exist but does
not), the remediation is **always** to implement the improvement so the
description becomes true.

It is **forbidden** to weaken, dilute, qualify, or rewrite the
documentation to match inferior code.  Documenting incorrect or incomplete
code in lieu of fixing it is not an acceptable engineering outcome on this
project.

Concretely:

- A comment referencing a function `X` that does not exist → **implement
  `X`**, never "remove the reference."
- A docstring describing a complete spec while the implementation is
  truncated → **complete the implementation**, never "document the
  truncation."
- A stub that throws `not implemented` (or returns a placeholder) while the
  design says it should route to a verified entry point → **wire up the
  routing.**
- Two API call paths handling the same condition asymmetrically → **make
  them symmetric**, never "document the asymmetry" (e.g. the two
  attention-ingestion routes through the shared pipeline, or client- vs.
  server-side validation of the same shared zod schema).
- An implicit invariant maintained only by convention → **enforce it
  structurally** (a zod schema at the trust boundary, a branded/opaque type
  whose constructors discharge the obligation, a discriminated union, a
  database `CHECK` constraint, or a CI static gate such as
  `check:no-applause` / `check:no-raw-egress` / `check:neutrality`), never
  "add an inline comment about the convention."
- A computed-and-validated data structure that the surrounding code does
  not consume → **wire it into the consumer** so the guarantee carries
  through to runtime, never "remove the unwired structure."
- Deferred items buried in source comments → **fix them** if the current
  scope permits; otherwise lift them into the relevant `docs/planning/`
  workstream document or the per-workstream `docs/*/README.md` residual
  note (where this project already tracks residuals).  Never leave in-source
  TODOs that age out with the surrounding workstream.
- A capability or status claim (a "Complete" workstream in the
  Implementation-roadmap table, a "production binding", a lifted shadow
  gate) while the path is non-functional → **make the path functional**,
  never qualify the claim with a stub-status caveat.

The single legitimate exception is when the documentation describes a
**worse** state than the code (e.g. a stale "shadow mode" or "planned"
marker on a feature that has since been wired into production, or a
deprecation note on a function the project has decided to keep).  In that
direction the documentation is the inferior artefact and updating it to
match the better code is correct.

**Audit reports and remediation plans must apply this rule.**  Findings of
the form "documentation describes feature X; code lacks feature X;
recommendation: weaken the documentation" are not acceptable.  The
recommendation must instead be "implement feature X" — and where the
implementation is non-trivial, the audit must split the work into the
proper sequence of PRs (each a coherent slice that passes `pnpm typecheck`,
`pnpm lint`, and `pnpm test`) rather than treating documentation surgery as
a substitute for the code change.

When the optimal implementation is genuinely out of scope for the current
cut, the correct outcome is to **defer the release**, not to ship a
documentation-only patch.  Forced deferrals must be recorded as tracked
debt with an explicit closure target in the relevant `docs/planning/`
document, not absorbed silently into a weaker public claim.

*Adopted from the seLe4n project's `CLAUDE.md` (`hatter6822/seLe4n`).*

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
| apps/web | ~134 unit + 8 E2E (6 frontend-only + 2 BFF-in-the-loop specs; incl. the WS-J report flow, the notice-inbox appeal affordance, safety controls, the moderation console panels incl. the appeal-review-before-decide gate, the WS-T comment-flow BFF spec — inline story comments + legacy thread redirect, and the WS-K AI provenance-label component) | jsdom / Playwright | `pnpm --filter web test` |
| apps/api | ~119 (incl. WS-D identity + the `expert`/`admin` RBAC roles + WS-E pipeline + WS-F ingestion + WS-G forum + WS-H invariants + WS-I ranking/surfaces/neutrality + the WS-J trust-safety services/routes/stores/units + the gated WS-J Postgres adapters incl. the right-to-erasure path + the WS-K governance backbone/pipelines/routes/stores/coverage + the WS-Q E2E test-auth route + the WS-R in-memory LCAP ingestion engine (incl. server-computed §18.3 validation over registered identity state) + the §29 LCAP routes (content reads + the pack-import POST, with shared crypto fixtures) + the LcapServerStore contract over the in-memory + gated Drizzle adapters + the dev-seed showcase integration test + the RUN_PERF benchmarks) | node | `pnpm --filter api test` |
| packages/shared | ~20 (incl. WS-D–WS-H schemas, URL/lifecycle utils, the §5.6 rating-label SSOT, the UGC pipeline + XSS-vector suite) | node | `pnpm --filter @licio/shared test` |
| packages/db | ~4 (isolation + content denylist + gated integration) | node | via root `pnpm test` (db project) |
| packages/invariants | ~19 (PWAtt/MinHash/freshness + the WS-H invariant mathematics: matroid/fiber/GW/sheaf/holonomy/supporting property suites + the regression harness + the SPEC-purpose oracle suite) | node | `pnpm --filter @licio/invariants test` |
| packages/ranking | ~7 (denylist + versioned-artifact pinning, strict schemas, §5.5 profile fuzzing + baseline weights, §5.4 arithmetic, penalties/constraints incl. tie enforcement, dedup/balancing, templates + x-pseudo localization, pipeline determinism, replay diff) | node | `pnpm --filter @licio/ranking test` |
| packages/ai-governance | ~13 (the prohibited-use guard + §24.5 matrix, the upgrade-only label ladder, the canonical inventory + risk assessments, the bias-audit math (two-proportion z-test + small-cohort), hallucination/safety/red-team, the harness selection/decision/reproducibility, the §24.3 summary-quality constraints + renderer, accuracy, canonical JSON, and the schema refinements) | node | `pnpm --filter @licio/ai-governance test` |
| packages/governance | ~5 (WS-U AI-governed-rooms domain: the moderation policy DSL + interpreter, the proof-carrying treasury kernel + investment bands, the capability model + derivation (floor-reserved structural disjointness), the quorum-gated fail-safe election tally, and the canonical-JSON content addressing) | node | `pnpm --filter @licio/governance test` |
| packages/lcap | ~33 (WS-R LCAP v0.2 pure-protocol core: the LDC deterministic-CBOR encoder/decoder + the §9.1.5 integer table + the full decode rejection matrix, CID construction (SHA-256 known-answer grounded) + RFC 4648 base32, ES256 low-S + the malleability-twin defense, COSE_Sign1 build/verify + the §10.2.4 six-step matrix, device-key/COSE_Key round-trip, suite agility/downgrade, strict closed-schema records/proofs + LDC codec pairing, the §18.3 identity-chain accept/quarantine/reject/revoke matrix, arrival-order-independent record projection + fork detection, blocks/chunk reassembly + compression-bomb abort, the packfile round-trip/cap/tamper matrix, the exhaustive RFC 9162 Merkle inclusion/consistency proofs, the `validate()` trust-projection staged matrix, liveness/receipts, conflict dispatch, the §16/§17 sync-decision plane (`minimalClosure` + scheduler integration, frontier diff, pulse build/apply, reconciliation order, monotonic budget shrinking, the interest privacy/leak matrix, wants + resume ranges, idempotency, exchange assembly + status, the §24.1 server-ingestion commit-stage decision, the §24.4 topological ingestion-order resolver, the §27.2 malicious-graph guard), the conformance-corpus replay, and the P1/P2/P3 determinism properties) | node | `pnpm --filter @licio/lcap test` |
| scripts | ~4 | node | via root `pnpm test` (policy project) |

WS-D, WS-E, WS-F, WS-G, WS-H, WS-I, WS-U, and WS-R (the LcapServerStore
contract) add **gated** integration tests (Postgres + Redis) that run only
when `DATABASE_URL` / `REDIS_URL` are set.
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
axe-core accessibility assertions on every page load.  Two configs:
`playwright.config.ts` is the frontend-only suite against the static
preview; `playwright.bff.config.ts` (`pnpm --filter web test:e2e:bff`,
spec glob `*.bff.spec.ts`) is the **BFF-in-the-loop** harness — it boots
the in-memory API `e2e-server` (no Postgres/Redis) plus the preview with
its API proxy enabled (`E2E_API_PROXY=1`) so the browser drives REAL
authenticated flows over one same-origin host, using a test-only login
route that mints a session cookie (gated to the e2e-server, never the
production app).  Both run in CI's E2E job.

**CI pipeline.**  `.github/workflows/ci.yml` runs 8 jobs on every PR:

1. Lint & format (Biome + security lint + policy + no-raw-egress)
2. Type check (strict-mode across all workspaces)
3. Lockfile integrity
4. Dependency budget
5. Test & coverage (Vitest + V8 coverage + JUnit XML; Postgres/pgvector +
   Redis service containers so the gated integration suites run too; plus
   the named `check:neutrality` step — the ten WS-I.3 ranking-neutrality
   tests as an explicit pay-to-rank gate on every PR — and the
   `check:lcap-scheduler` step, the WS-R.5.4 LCAP lane anti-starvation gate)
6. Build & size check (production build + bundle-size gate)
7. E2E tests (Playwright, requires build)
8. Security audit (pnpm audit, SBOM, build validation, AGPL headers,
   secret scanning, install-script detection)

CodeQL (`.github/workflows/codeql.yml`) runs `security-extended`
queries on push to main, PRs, and weekly.

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

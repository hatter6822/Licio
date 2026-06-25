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
exhaustively tested, and conformance-vector-pinned (`docs/lcap/README.md`).  The WS-R I/O integration has since shipped (the `lcap_v2` client store, the server ingestion/reconciliation + §29 sync routes, the DoS/privacy controls, the transport profiles + network simulator, and the client surface); the remaining WS-R work is field confirmation on PHYSICAL phones and the live two-browser WebRTC convergence E2E (see WS-S).  The **WS-S private-rooms (E2EE) plane has
shipped its foundation** — the new browser-safe `@licio/private-p2p` package
(the zero-dependency canonical DAG-CBOR encoder + the strict §10/§13/§19 private
schemas), the room-class model (the three §4.1 axes + coherence in
`@licio/shared`, migration `0043`), the server **non-storage contract** keystone
(the §8.2 stub/rendezvous column allowlist in migration `0044`; the
submission/contribution/feed rejection guards; the retriever/search/event-
pipeline exclusion; the seven §23.10 CI gates), and the honest-limits disclosure
+ Appendix E privacy-matrix copy SSOT — so a partially-built P2P client can never
write server content (`docs/private-p2p/README.md`).  The **WS-S.3 cryptographic
foundation is now shipped** on top: the §10.2 MLS group keying (an audited
`ts-mls` RFC 9420 wrapper, suite-pinned, behind the `check:p2p-mls-wrapper` gate)
+ the epoch→key-schedule bridge, the HKDF five-key schedule, the §10.5 two-layer
object AEAD, the §10.3 HPKE invite bootstrap, §10.7 Ed25519 device signatures,
the §10.8 four-tier key store + §12.6/§12.7 recovery kit, and §12.6.1 threshold
recovery — every primitive a thin RFC-vector-pinned WebCrypto wrapper (RFC
5869/7748/8032/9180 + an `@hpke/core` interop vector + `@noble/curves` KATs).
The **§9.4 content-addressing (WS-S.4.2, dependency-free CIDv1-over-ciphertext,
multiformats-pinned) and the COMPLETE §14.3 deterministic operation-log reducer
(WS-S.5.1–5.8 — the Lamport canonical order, the room/capability state, the
authority-enforcing fold + §14.4 conflict policy, the structural §14.2 pre-pass,
the §14.2 stage-1 op wire-codec (`sealOp`/`openOp`), the §14.5 verify-before-use
snapshots, the §14.6 device-local moderation overlays, and the §13.7 local-only
encrypted search, byte-identical across shuffles) are also shipped** (the
maintainer-chosen lighter-transport path; no Helia).  The **WS-S.6 P2P
sync-decision plane is shipped as a pure, transport-independent core
(WS-S.6.1–6.5, `packages/private-p2p/src/sync/`)**: §15.2/§15.3 blind rendezvous
(blind-id derivation over canonical messages, sealed announcements, the §15.3.1
"key IS the capability" property, the §15.3.2 metadata mitigations), §15.4
encrypted signaling + relay-only ICE suppression (over the X25519-ECDH pairwise
secure channel), the §15.5 membership-proving handshake, the §15.6/§15.7/§15.8
head announcement + frontier-first reconciliation + fetch-order priority, and the
§15.9 offline encrypted-archive (CAR) exchange whose import re-validates every
envelope (no container-conferred trust).  The **WS-S.6.6 server-blind rendezvous
endpoint is also shipped** (`POST /v1/private-rendezvous/{announce,poll,signal,
signal/poll}` in `apps/api` — opaque-only blind ids + ciphertext + a clamped TTL,
the §15.3.1 no-existence-oracle, aggregate-only metrics, IP-free rate limits,
CSRF-exempt; presence persists to the migration-`0044` table behind a gated
Postgres adapter, signals are transient).  The WS-S live `RTCPeerConnection` carrier (the WebRTC/IPFS-bridge path over `@licio/lcap-p2p`, chosen over full Helia), the hardened update channel, the server→private migration, and the WS-S.11 audit suite have since shipped; the remaining WS-S work is the live two-browser create→invite→join→connect→converge E2E (with multi-peer mesh fan-out) and the grant-delivery/media room-UI affordances.  See "Implementation
roadmap" below.

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
pnpm check:lcap-p2p-split           # the WS-R.15.8 gate: apps/web imports @licio/lcap-p2p only dynamically
pnpm check:private-p2p-split        # WS-S.2.1 gate: apps/web imports @licio/private-p2p only dynamically
pnpm check:lcap-schema-egress       # no IP/location/attention/applause field in any LCAP schema
pnpm check:no-p2p-server-content    # WS-S.1.5: a Private P2P room places NO content on the server (umbrella)
pnpm check:no-private-cid-egress    # WS-S.1.5: no public IPFS gateway / public routing for a private CID
pnpm check:private-rendezvous-schema # WS-S.1.5: the §8.1 column denylist on the stub/rendezvous tables
pnpm check:private-bundle-transparency # WS-S.1.5: the private bundle loads no dynamic remote code
pnpm check:p2p-endpoint-rejections  # WS-S.1.5: submission/contribution/feed reject p2p rooms
pnpm check:p2p-ranking-exclusion    # WS-S.1.5: every retriever predicates storage_mode='server'
pnpm check:p2p-search-exclusion     # WS-S.1.5: server search indexes/serves only server rooms
pnpm check:update-channel           # WS-S.10.2b: the private-mode bundle is signature + transparency-log + digest verified BEFORE activation (untrusted ⇒ rooms locked)
pnpm check:no-applause              # no likes/votes/karma/reactions in components + routes + LCAP + private-p2p
pnpm check:no-raw-egress            # no raw attention traces leaving the browser (+ the LCAP + private-p2p planes)
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
pnpm --filter @licio/lcap-p2p build # build the optional WebRTC/IPFS transport carriers
pnpm --filter @licio/private-p2p build # build the WS-S Private P2P rooms domain (canonical encoding + schemas)
pnpm --filter courier build         # WS-R.15.4a native courier: no-fork gate + cap sync + debug APK (needs the Android SDK + JDK 21; web build must precede)
pnpm --filter courier test:unit     # courier Layer-1+2 JVM unit tests (pure framing + Robolectric plugin-contract) — NO emulator, NO radio, NO root
```

`package.json` (root and per-workspace) is the source of truth for
every build command; consult it before adding new scripts.

**Toolchain.**  Node 22 (pinned in `.nvmrc`), pnpm 9.15.4 (pinned
in `package.json` `packageManager`), TypeScript 6.0.3, Vite 8.0.16,
Biome 2.5.0.

## Pre-commit verification (mandatory)

Before committing any source file, run the relevant checks:

```bash
pnpm typecheck                      # strict-mode compilation (fast, incremental)
pnpm lint                           # Biome format + lint (WHOLE repo, not just staged)
pnpm test                           # Vitest (80% coverage threshold)
```

**`tsc -b` caches — do not trust a green `pnpm typecheck` before pushing.**  `pnpm typecheck`
is `tsc -b`, which keys off `.tsbuildinfo`; a stale cache can report **`0 errors` for code that
actually fails to compile** (this has reached the remote before — the cached local check passed
while clean CI failed).  The AUTHORITATIVE typecheck is **`pnpm typecheck:ci`** (`tsc -b --force`,
cache-independent) — it is what the `pre-push` hook and the CI Type-Check job run.  Run
`pnpm typecheck:ci` (or `find . -name '*.tsbuildinfo' -not -path '*/node_modules/*' -delete`
first) before declaring a branch green, and run the FULL `pnpm lint` (the `pre-commit` hook
only lints the *staged* files, so an unused import/var created in an unstaged file slips past
it until `pre-push` / CI).

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
* `pnpm check:update-channel` — fails if the WS-S.10 hardened
  private-mode update path loses its verify-before-activate wiring:
  the pure verifier (`@licio/shared/update`) must bind maintainer
  signature + RFC 9162 transparency-log inclusion + the running-bundle
  digest and expose the typed lock reasons; the client gate
  (`apps/web/src/update`) must verify BEFORE unlock and lock the rooms
  on any untrusted verdict; and the service worker must refuse a silent
  takeover by an unverified bundle.

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
├── biome.json                   -- Biome linter/formatter (2.5.0)
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
│   │       ├── lcap/                    -- WS-R LCAP client offline store (separate from `licio`)
│   │       │   ├── db.ts                --   the `lcap_v2` IndexedDB schema: the 12 §23.1
│   │       │   │                             stores + indexes + versioned migration (WS-R.11.3a)
│   │       │   ├── store.ts             --   §23.2 durability layer: cursor-only streaming,
│   │       │   │                             blob↔metadata separation, atomic verified-record
│   │       │   │                             commit, capped txns, quota retry (WS-R.11.3b)
│   │       │   ├── gc.ts                --   §21.2 pinning classes + eviction order (WS-R.11.1)
│   │       │   ├── storage-modes.ts     --   §21.3 storage modes + persistence + pressure
│   │       │   │                             degradation (WS-R.11.2)
│   │       │   ├── sync-triggers.ts     --   §23.3 C0-first sync orchestration (WS-R.11.4)
│   │       │   └── replication.ts       --   §21.4 privacy-aware replication eligibility (WS-R.11.5)
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
│   ├── api/                     -- Hono BFF server
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
│   └── courier/                 -- WS-R.15.4a native Android courier (Capacitor 7 shell)
│       ├── capacitor.config.ts  --   webDir → apps/web/dist (no courier-only web fork);
│       │                              androidScheme https → secure-context WebView
│       ├── scripts/
│       │   └── check-no-fork.mjs --   byte-identity gate (web build ≡ synced WebView assets)
│       └── android/             --   generated Capacitor Android project; `pnpm --filter
│                                      courier build` produces the debug APK (Gradle + SDK)
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
│   │       │   ├── room.ts (+ axes)     --     WS-S.1.1 room storage/authority/directory axes
│   │       │   │                               + the six §23.2 coherence CHECKs (migration 0043)
│   │       │   ├── private-room.ts      --     WS-S.1.2 private_room_stubs + private_rendezvous
│   │       │   │                               _records: the §8.2 column allowlist (migration 0044)
│   │       │   └── wallet/wallet-account.ts -- isolated financial WalletAccount
│   │       ├── isolation.ts             --   wallet↔ranking BFS isolation (WS-D.3.2)
│   │       ├── private-room-guard.ts    --   WS-S.1.2 checkPrivateServerTables (§8.1 column denylist)
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
│   └── private-p2p/             -- WS-S Private P2P rooms domain (no I/O; browser-safe;
│       └── src/                 --   NEVER @licio/db, NEVER @licio/lcap — a separate plane)
│           ├── crypto/                 --   canonical.ts: the ONE DAG-CBOR deterministic
│           │                                profile (WS-S.2.2; later: MLS/HPKE/AEAD/KDF/Ed25519)
│           ├── schemas/                --   strict §10/§12/§13/§19 records (envelope + AAD
│           │                                alignment, manifest, op bodies w/ WS-G parity,
│           │                                invite/join, attachment, search shard, report)
│           └── __tests__/              --   canonical determinism/reject/bomb + schema + op suites
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
│   ├── private-p2p-gates.ts     --   WS-S.1.5 shared assertions for the 7 private-room gates
│   ├── check-no-p2p-server-content.ts  --  WS-S.1.5 umbrella server-non-storage gate
│   ├── check-no-private-cid-egress.ts  --  WS-S.1.5 no public-gateway for a private CID
│   ├── check-private-rendezvous-schema.ts -- WS-S.1.5 §8.1 stub/rendezvous column denylist
│   ├── check-private-bundle-transparency.ts -- WS-S.1.5 no dynamic remote private code
│   ├── check-p2p-{endpoint-rejections,ranking-exclusion,search-exclusion}.ts -- WS-S.1.5
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
│   ├── private-p2p/             -- WS-S implementation reference (foundation shipped)
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
                            schemas, the transport seam) has no database access
                            by construction; the codec/CID/COSE core carries
                            zero npm imports — WebCrypto + a hand-rolled
                            CBOR/COSE subset only)
@licio/lcap-p2p            (depends on @licio/shared, @licio/lcap, zod;
                            browser-safe, NEVER @licio/db — the WS-R.15.6/15.7
                            OPTIONAL transports: the WebRTC data-channel carrier
                            + server-blind signaling envelope, and the
                            dependency-free IPFS gateway bridge.  No npm runtime
                            dep beyond the shared zod baseline; the carriers use
                            only browser WebRTC + fetch + WebCrypto.  Code-split:
                            apps/web loads it by DYNAMIC import only)
@licio/private-p2p         (depends on @licio/shared, zod; browser-safe,
                            NEVER @licio/db, NEVER @licio/lcap — the WS-S Private
                            P2P rooms confidentiality & authority plane (canonical
                            DAG-CBOR encoding, the strict private schemas, and —
                            in later slices — MLS/HPKE/AEAD/KDF/Ed25519 crypto,
                            Helia/libp2p, the Lamport reducer, sync).  The two
                            decentralization planes pin DIFFERENT crypto suites on
                            purpose (Ed25519/MLS/HPKE here; ES256 in LCAP) and
                            never share keys/code.  All heavy P2P/crypto deps are
                            declared HERE + loaded only from a lazy code-split
                            route chunk measured against its own bundle budget)

apps/web                   (depends on @licio/shared, @licio/invariants,
                            @licio/ai-governance, @licio/lcap, @licio/lcap-p2p,
                            @licio/private-p2p; NEVER @licio/db — enforced by
                            check:workspace-deps.  @licio/lcap is the WS-R.15.1
                            bundle flows + the WS-R.15.2/15.4b/15.5 transports;
                            @licio/lcap-p2p is the WebRTC/IPFS carriers;
                            @licio/private-p2p is the WS-S.7 room engine
                            (`apps/web/src/private-p2p/`: the IndexedDb storage
                            adapter + the dynamic-import room manager).  All
                            three load as lazy dynamic-import chunks —
                            `check:lcap-p2p-split` + `check:private-p2p-split`
                            assert NO static value import — so no protocol/crypto
                            core enters the initial bundle)
apps/api                   (depends on @licio/shared, @licio/db,
                            @licio/invariants, @licio/ranking,
                            @licio/ai-governance, @licio/governance,
                            @licio/lcap, @licio/lcap-p2p, @licio/private-p2p;
                            the lcap-p2p edge is the Gate-19 public-block
                            (re)publisher
                            (`apps/api/src/lcap/{takedown-oracle,publisher}.ts`)
                            — the server-side DB binding of the `TakedownOracle`
                            seam + `IpfsBridge` that `@licio/lcap-p2p` cannot
                            carry itself (it must never import `@licio/db`).
                            The private-p2p edge is the WS-S Tier-2 rendezvous-cap
                            verify (`apps/api/src/private-rendezvous/cap-verifier.ts`)
                            — it imports ONLY the `@licio/private-p2p/rendezvous-cap`
                            subpath (the BBS verify + context derivation, NOT the
                            room engine/MLS); verifying a ZK presence proof reveals
                            nothing beyond the per-epoch pseudonym the server already
                            stores, so §15.3.1 server-blindness is preserved.
                            apps/api has no initial-bundle constraint, so the
                            `check:lcap-p2p-split` / `check:private-p2p-split`
                            code-split gates do not apply to it; both are static
                            server-side value imports, budget-exempt as `workspace:*` deps)
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

The same policy is ALSO delivered as a `<meta http-equiv="Content-Security-Policy">`
in `apps/web/index.html` (the enforceable-in-meta directives only — `frame-ancestors` /
`report-uri` / `report-to` are header-only and omitted).  On the web it is redundant with
the header (identical policy → no behaviour change); it is the **sole CSP/Trusted-Types
source in the WS-R.15.4a native courier WebView**, which serves the same bundled assets
from `https://localhost` with no server headers, so the `script-src`/`object-src`/
Trusted-Types posture survives the WebView with no relaxation.

### CSRF protection

Per-session single-use tokens (256-bit, `crypto.randomBytes(32)`),
1-hour TTL, constant-time comparison (`crypto.timingSafeEqual`).
**Mutations are serialized** through a promise chain on the client —
each mutation fetches its own fresh token immediately before sending,
preventing concurrent nonce sharing.  GETs bypass the chain.

Exempt paths: `/health`, `/api/security/csp-report`, `/v1/telemetry`
(sendBeacon cannot set custom headers), `/v1/takedowns` (public copyright
intake — no session to ride), and the WS-R.12.4 native LCAP sync surface
`/api/lcap/v2/{packs,pulse,exchange}` (device-certificate-authenticated
content / public frontier reads with no session cookie; abuse bounded by
each endpoint's own rate limit + the §27 caps + the graph guard).  The
web-UI `/api/lcap/v2/bundles/import` alias is NOT exempt — a session-bearing
browser flow keeps the double-submit token.

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
| WS-R | Offline content availability (LCAP v0.2) | In progress (extension; `docs/OFFLINE_SPEC.md`) — **pure-protocol core (`@licio/lcap`) shipped**: WS-R.0 foundations (deterministic CBOR/LDC, CIDs, COSE_Sign1 ES256 low-S proofs, suite agility, closed-schema records), WS-R.1 identity chain (§18.3 validator), WS-R.2 record graph + fork detection, WS-R.3 blocks/chunking/compression, WS-R.4 packfile/`.licio-bundle`, WS-R.5 lane scheduler + `check:lcap-scheduler` gate, WS-R.6 sync-decision plane (pulse/exchange/interests/wants/budgets/idempotency), WS-R.7 reconciliation (frontier-first order + `minimalClosure`), WS-R.8 `validate()` trust projection, WS-R.9 RFC 9162 Merkle/checkpoint, WS-R.10 liveness/receipts/outbox, WS-R.13 conflict dispatch, the WS-R.12.1 server-ingestion commit-stage decision core (`ingestRecord`), and the WS-R.12.1b §24.4 topological ingestion-order resolver (`resolveIngestionOrder`: prerequisites-before-dependents order with class priority, transitively-absent missing-dependency detection, cycle isolation), and the WS-R.14.2 §27.2 malicious-dependency-graph guard (`checkDependencyGraph`: cycle/fan-out/depth/duplicate-dep/private-in-public/unknown-critical-field detectors mapped to §16.11 wire codes) — all conformance-vector-pinned (`docs/lcap/README.md`); plus the WS-R.12.1a/b/c **in-memory server binding** in `apps/api/src/lcap` (`LcapIngestServer`: CID-verified CAS + per-room acceptance log + authoritative idempotency/fork detection + **server-computed `validate()`** over registered identity state — device certs, room capabilities, account/room authority keys, revocations — never a client-supplied verdict + `commitBatch` ordered batch ingestion, graph-guarded before expansion + §18.3-step-9 aggregate capability-quota enforcement on accept — the atomic, idempotent `acceptContribution` checks + debits a durable per-capability usage counter (events, total payload bytes, AND media bytes — the media charge being the summed CID-verified stored size of a contribution's referenced blocks; `lcap_capability_usage`, migrations `0041`+`0042`) and rejects an over-budget contribution `rejected_quota`) + the WS-R.12.4 §29 routes (the content-read endpoints `GET /api/lcap/v2/{records,proofs,blocks}/:cid` with RFC 7233 resumable range/206 reads; the rate-limited pack-import `POST /api/lcap/v2/packs` — CSRF-exempt, read under the WS-R.4.2 caps, every CID-verified frame durably stored (proofs/blocks then fetchable via the GET routes), identity frames registered, contributions committed through validate→guard→commit, one §16.11 status per object; the §29.1 `POST /pulse` frontier exchange + the §29.2 `POST /exchange` main bidirectional path — both deriving the server's §17.2/§17.3 frontiers via the shared `roomIdHash` and serving the peer's explicit wants as a budget-bounded content pack (the pulse's C0 `critical_pack`, the exchange's `response_pack`, repacked from held bytes with content-derived §15.1.1 lane/priority hints + a conservative privacy label); the exchange also ingesting its push pack through the SAME validator and deriving `wanted_from_client`; the §29.7 room checkpoint/inclusion/consistency reads — RFC 9162 proofs over the reconstructed §19.1 room log; and the §29.8 `POST /bundles/import` web alias + the capability-gated `POST /bundles/export` (a room's self-contained, re-validatable content closure — each record led by the IDENTITY it validates against, its capability + signer device certificate with authority proofs, then its own proofs + blocks — repacked from held bytes + re-importable, via an import-captured closure index over migration `0040`; gated by a device-signed, freshness-windowed `may_export_bundle` capability via `verifyExportAuthorization`) — all with the §22.1.1 status mapping, mounted through the global security middleware) + the WS-R.12.2 `LcapServerStore` boundary (the async store interface — CAS + acceptance log + device-seq + fork evidence — with BOTH the in-memory adapter AND the **gated Drizzle/Postgres adapter** (`drizzle-store.ts` over migration `0039`, DATABASE_URL-gated, selected in `service.ts`), proven by the parameterized store-contract test) + the **WS-R.11 client offline store** (`apps/web/src/lcap`: the `lcap_v2` IndexedDB schema — 12 §23.1 stores + indexes + versioned migration, isolated from the `licio` DB, R.11.3a; the §23.2 durability layer — cursor-only streaming, blob↔metadata separation, atomic verified-record commit, capped transactions, quota-retry, R.11.3b; the §21.2 pinning/eviction policy, R.11.1; the §21.3 storage modes + pressure degradation, R.11.2; the §23.3 C0-first sync orchestration, R.11.4; the §21.4 privacy-aware replication gate, R.11.5); plus **WS-R.14 privacy + DoS controls** — the §27.1 resource-cap SSOT (`limits/caps.ts`: one frozen config every parser path sources, profile-tunable but never disable-able, the `checkCap`/`enforceCap` helper; the server parse enforces the §27.1 CPU-time + quarantine-byte caps, R.14.1a), the §27.2 malicious-graph guard now run over the pack's DECLARED DAG before any storage (R.14.1b), the §27.3 relay admission quotas + the §27.4 no-PoW/no-client-address policy (`limits/relay-quota.ts`, R.14.4), the §26.2 export-disclosure + §26.3 stealth-mode policy (`privacy/`, R.14.2; the interest-privacy half shipped with R.6.3), and the WS-R.14.3 LCAP doctrine CI gates (`check:lcap-schema-egress` + no-applause/no-raw-egress extended over the LCAP trees); plus the **WS-R.15.3 untrusted-relay decision core** (`apps/api/src/lcap/relay.ts` `LcapRelay`: a content-addressed cache that stores/serves by CID, returns storage receipts, enforces the §27.3 quotas + private-content refusal, and STRUCTURALLY cannot accept — no room-log/commit surface; §19.1 opaque peer keys); plus the **WS-R.17 client surface** (`apps/web/src/lcap` + `apps/web/src/components/lcap`: the §34 honest trust/liveness label mapping + the `TrustBadge` — 13 distinct honest labels, never one "secure"/"trusted"/"delivered" badge; the §33 operational modes — minimal/standard/courier/relay/stealth/emergency driving storage/priority/media/discovery/export posture; the §25/§22.1.1/§20 offline-state surfaces — `ConflictWarning` (never-discard fork alert) / `QuarantineNotice` (partial-import wait + `wants` fetch) / `OutboxStatus` (honest queued/retrying/exported chip); these always-available surfaces mirror the state unions locally rather than importing `@licio/lcap`, so they stay off the lazy codec chunk); plus the **WS-R.15.1a/b offline bundle export/import** (`apps/web/src/lcap/bundle-{export,import}.ts` + the `OfflineBundlePanel` / `/profile/offline` route): CLIENT-LOCAL — the REAL @licio/lcap pack writer/reader run in the browser, loaded as a LAZY dynamic-import chunk so the initial bundle is untouched (apps/web now takes @licio/lcap, a `workspace:*` dep outside the <15 budget); export gathers a room's record→proof→block closure with the §26.2 disclosure-before-file + a generic high-risk filename (§26.3); import reads under the §27.1 caps with typed rejection + a pre-render summary + missing-dep quarantine, committing at INTEGRITY-ONLY trust (nothing rendered before trust projection, §8.3); plus the **WS-R transport plane over one `LcapTransport` seam** (WS-R.15.2/15.3/15.4b/15.5/15.6/15.7/15.8 + the §32 simulator): the §22.6 seam (`packages/lcap/src/transport` — server-anchor-last selection + the public-only carriage gate + the fallback driver); the client carriers `apps/web/src/lcap/transports` (the HTTPS anchor, the platform WebTransport adapter, the courier ferry, and the registry running `fallbackExchange` with WebRTC loaded by DYNAMIC import); the new code-split **`@licio/lcap-p2p`** (the WebRTC data-channel transport + the server-blind AES-GCM signaling envelope + the §26.4 ICE/NAT-privacy policy; the DEPENDENCY-FREE IPFS gateway bridge — the verification-preserving `block_cid ⇄ CIDv1(raw,sha2-256)` map, re-verify-before-use, public-only publish); the §22.3 QR micro-bundle (a hand-rolled byte-mode encoder proven by a jsQR round-trip + lazy jsQR still-image decode); the server-blind `POST /api/lcap/v2/p2p/signal` rendezvous (+ the CSRF-protected `POST …/p2p/signal/poll` drain); the `check:lcap-p2p-split` code-split gate + the egress/applause gates extended over the new trees; and the §32.3/§32.5 deterministic network simulator (seeded link model + pluggable adversaries running the REAL scheduler + closure, asserting C0-never-starved / fork-detection / transport-independence).  The **WS-R.15.4a native Android Capacitor courier shell is shipped** (`apps/courier`: a Capacitor 7 shell whose `webDir`→`apps/web/dist` builds a real debug APK via `pnpm --filter courier build` behind the two-stage byte-identity `check-no-fork` gate + the `courier-apk` CI job — the SDK installed from dl.google.com, no third-party action; the CSP/Trusted-Types posture preserved in the `https://localhost` WebView by an `index.html` `<meta>` CSP mirror of the server header; `@capacitor/*` native-scoped so the web `<15` budget + the `<200 KB` bundle gate hold; the doctrine gates extended over `apps/courier`).  The server also **issues signed `room_checkpoint`s and ingestion receipts** on a lease-guarded hourly tick (build→sign→store, chained + idempotent by tree size; one COSE-signed receipt per status group, stamped onto the pack/exchange responses), the **WS-R.11.4 service-worker C0-first sync hooks** are wired (an app-open/online/focus minimal frontier pulse + the SW `lcap-c0-sync` background nudge, the codec lazy-loaded so the initial bundle is untouched), and the **§36 acceptance-gate checklist + the browser↔Node ES256 crypto-interop Playwright spec (WS-R.18.5/18.6)** plus the §34 honest trust badge mounted on the REAL bundle-import state (WS-R.17.1) are shipped.  NOW SHIPPED: the **WS-R.15.6a live `connectWebrtc`** (a real `RTCPeerConnection` driven through offer/answer/trickled-ICE-with-buffering/datachannel-open over the sealed server-blind rendezvous — relay-only/force-off APPLIED to the live config; proven against a faithful fake-peer PAIR AND a real-Chromium-WebRTC datachannel loopback E2E `apps/web/e2e/webrtc-loopback.spec.ts`), the **WS-R.15.4c native Nearby Connections plugin** (`NearbyCourierPlugin.java` compiled into the debug APK + the per-API radio permissions + the TS CourierMedium bridge over the injected Capacitor global — no `@capacitor/core` web dep — + the WS-R.15.4e `decideCourierStart` off-by-default/Stealth-force-off gating), the **WS-R.16.1 encryption-envelope carrier** (`EncryptedPayloadDescriptorV2` — ciphertext + OPAQUE hints only, NEVER decodes the envelope, the closed schema forbids plaintext-equality hints for the group-keyed suite §10.6), and the **WS-R.17 transport-selection / operational-mode UI** (the `/profile/mode` `OperationalModeSelector` + `TransportStatus` + the QR micro-bundle surface, with the §33 posture wired into the offline-bundle export + discovery).  **WS-R.15.4f is VERIFIED on emulated radios** with a MULTI-MEDIUM, MULTI-SCENARIO matrix — two headless Android emulators sharing the **netsim** virtual radio bus (RootCanal BLE/Bluetooth) run `apps/courier/scripts/radio-e2e.sh` over SIX coordinated two-device scenarios, all green offline: **Nearby Connections** (`NearbyConnectionsRadioTest`) — basic, a 512 KiB pack streamed as 64 ordered chunks reassembled BYTE-EXACT (the §13.2 chunked-pack path), bidirectional duplex, and the disconnect-lifecycle event; **Bluetooth LE GATT** (`BleGattRadioTest`) — advertise + GATT server + the central's serialized chunked writes, integrity-asserted; **Bluetooth Classic RFCOMM** (`BluetoothRfcommRadioTest`) — an insecure, no-pairing length-prefixed 64 KiB frame, the client dialing A's address directly.  The matrix script is self-validating (it preflights each AVD's system image) and runs over the SAME GMS / Android radio APIs the plugins wrap, BUT it is now the OPTIONAL Layer-3 (hardware confidence) of a test pyramid that needs NO root/emulator for normal dev: ALL FOUR courier plugins (Nearby / Bluetooth / Wi-Fi Direct / USB) are now thin Capacitor HUMBLE OBJECTS over per-radio drivers (`NearbyCourierRadio` / `BluetoothCourierRadio` / `WifiDirectRadio` / `UsbCourierRadio`) that implement one shared `CourierRadio` contract (`Context` + a `CourierRadio.Events` callback, raw bytes), built on the PURE, JVM-tested `CourierFraming` (the length-prefix framing + the `FrameAssembler` + the blocking-stream `readFramedStream` + the serialize-on-ack chunked-send state machine).  GMS Nearby is isolated behind a `NearbyConnections` seam (`GmsNearbyConnections` glue) so the courier ORCHESTRATION is fake-tested with no GMS.  **68 JVM unit tests** (`pnpm --filter courier test:unit`, now a CI gate in the `courier-apk` job) cover it with NO device/radio/root — Layer-1 pure tests (`CourierFramingTest` framing/flow-control; `BleSendPumpTest` the BLE send state machine; `CourierStreamLinkTest` the shared blocking data-path over pipes) + Layer-2 the `*RadioTest`s (the BLE GATT contract + BOTH receive directions — peripheral write-request AND central `onCharacteristicChanged` notify reassembly, incl. the pre-33 deprecated overload via `@Config(sdk=31)`; the Nearby found→request/initiated→accept/payload→event orchestration; send-routing/idempotent-stop) via Robolectric/fakes (the `mac80211_hwsim`/`wpa_supplicant` privileged radio path is therefore never required).  The BLE SEND path is **callback-driven** (`BleSendPump`): `enqueue` writes the first chunk, the GATT write-complete callback drives the next, a scheduled timeout fails a stalled write, disconnect fails all — NO worker thread, NO blocking queue, NO 30s poll (the old design forced BLE's async, one-op-at-a-time API into a blocking loop, which leaked a thread and could only be tested via a cross-thread rendezvous; the pump's entire state machine is now pure + deterministically unit-tested).  The three blocking-stream transports (RFCOMM / Wi-Fi Direct / USB) share ONE data-path, `CourierStreamLink` (outbound routing + length-prefixed inbound + lifecycle), unit-tested over in-memory pipes — so there is NO real-socket / fixed-port test seam (the earlier Wi-Fi `dataPort`-ForTest seam was removed).  Earlier audit hardening also stands: `FrameAssembler` is amortized O(n) (offset-based, closing a slow-trickle CPU-DoS), `stop()` closes live sockets so a blocked read unblocks, and cross-thread `serverSocket`/`descriptor` are `volatile`.  (The BLE CLIENT send path is covered end-to-end by `bleClientSendDrivesAMultiChunkFrameToCompletion`: a discoverable courier service is injected into the shadow gatt, and the shadow acks each `writeCharacteristic` with SUCCESS, so a 2000-byte multi-chunk send self-drives through the radio's real `onCharacteristicWrite → pump.onAck` wiring to completion — provable ONLY because the send is callback-driven.  The CENTRAL notify path is covered by its fail-closed test (the shadow can't ack a notify → the radio reports `write_rejected`) + the central-receive reassembly; only a SUCCESSFUL central notify stays real-radio-only via `BleGattRadioTest`.  The RFCOMM data path is now driven over a REAL shadow `BluetoothSocket` (`rfcommSocketDrivesTheCourierDataPathOverARealBluetoothSocket`, via `ShadowBluetoothServerSocket.deviceConnected` + the stream feeder/sink) on top of the netsim `BluetoothRfcommRadioTest`.)  A follow-up audit hardened the redesign: BLE ack-timeout `arm()` never resurrects a stopped scheduler (closing a `stop()`/disconnect race that could throw `RejectedExecutionException` out of a binder callback); USB `stop()` closes the READ stream (not just the accessory descriptor) so a parked read thread unblocks + fires `onDisconnected`; `CourierStreamLink` removes its outbound entry BY VALUE so a same-endpoint reconnect can't clobber the newer link; `BleSendPump` null-checks its inputs.  Two residuals were then CLOSED: the BLE scheduler→timeout glue is now a named, unit-tested `ScheduledAckTimeout` (a real scheduler + a short delay covers arm-fires / cancel / re-arm-cancels-prior / shutdown-tolerated — no 30s wait, no seam), and the unbounded thread-per-send was replaced by a BOUNDED daemon send executor with caller-runs backpressure (`CourierStreamLink.newSendExecutor`, ≤8 threads, self-reaping) shared by RFCOMM/Wi-Fi/USB through `CourierStreamLink.send`.  A FINAL audit closed two more: a stale-timeout race (chunk N's 30s timeout, already RUNNING when its ack re-armed for chunk N+1 — `cancel()` can't stop a running task — could spuriously fail the advanced send) is fixed by a per-arm EPOCH echoed to `BleSendPump.onTimeout(epoch)` and checked under the pump monitor (a stale epoch is a no-op); and `CourierStreamLink.send` now guards `isShutdown()` → `onError` (the bounded executor's `CallerRunsPolicy` SILENTLY DISCARDS after shutdown, which would leak the `SendResult`/PluginCall if a `shutdown()` were ever added) and the dead `RejectedExecutionException` catch was removed — both with a regression test proven to fail without the fix.  The six pre-33 BLE deprecations (the value-carrying `writeCharacteristic`/`notifyCharacteristicChanged`/`writeDescriptor` overloads are API-33+; minSdk is 23 to maximize device reach) are isolated in three minimal `*Legacy` compat shims — NOT broadly suppressed — so every real method stays deprecation-checked; compileSdk/targetSdk are 35.  The TS `NativeChannelMedium` is UNAFFECTED (it drives the plugins by Capacitor name + the unchanged `connectionResult`/`payloadReceived`/`disconnected` surface); the never-consumed `endpointFound`/`connectionInitiated`/`endpointLost` Nearby events were dropped as dead code.  **Wi-Fi Direct can't be exercised between two STOCK emulators** — the framework works (`discoverPeers` SUCCESS, a `p2p-dev-wlan0` interface exists) but netsim bridges only Bluetooth (RootCanal), not Wi-Fi, so the emulators never discover each other (no shared Wi-Fi medium for the P2P probe frames — which is why the Bluetooth-based legs cross netsim and Wi-Fi Direct does not); `WifiDirectRadioTest` is therefore gated to real radios (`-e includeWifiDirect 1` / `RADIO_E2E_INCLUDE_WIFI_DIRECT=1`).  Needs KVM + a host GPU (`-gpu host` — the bundled SwiftShader software renderer SIGSEGVs qemu during SurfaceFlinger bring-up on this CPU; verified on an AMD Radeon/RADV host).  NOW SHIPPED on top: the **WS-R.15.6 live LCAP P2P transport, driven + fragmented** — `apps/web/src/lcap/transports/sync-over-p2p.ts` (`syncRoomOverP2p`) is the FIRST real runtime consumer of the `WebrtcTransport`: it derives a PUBLIC signaling key by HKDF over the public `roomIdHash` (`signal-key.ts` `derivePublicSignalKeyBytes` — public plane only; the WS-S engine never imports it because signaling secrecy is not LCAP's trust root, content-addressing + COSE signatures are), establishes a live `WebrtcTransport` over the server-blind rendezvous (`connectLcapWebrtc`, dynamic-import only), and runs ONE §16 exchange through `offlineExchange` so `selectTransports` still forces the HTTPS anchor LAST (anchor-last + public-only carriage preserved); falls back to the anchor alone if the channel never opens.  `@licio/lcap-p2p`'s `webrtc/fragment.ts` (`fragmentMessage`/`FragmentReassembler`, ≤ 16 KiB cross-browser-safe SCTP fragments, fail-closed reassembly, the 16 MiB §27 DoS bound) lets an exchange pack exceed the datachannel size limit; **WS-R.16.1 the cross-plane bundle bridge** (`apps/web/src/lcap/cross-plane-bridge.ts` — `exportPrivateEnvelopesToBundle`/`importBundleToPrivateEnvelopes`) carries a WS-S private-p2p ciphertext envelope inside an LCAP `.licio-bundle` as an opaque `encrypted_payload` block (the `MLS-derived-AEAD` suite, so the §28.2 schema forbids any plaintext hint, §10.6); LCAP never decrypts — it re-hashes the CID and re-parses the recovered bytes through the private-p2p envelope schema, handing the opaque envelopes back for the engine's real trust projection (§8.3 — the bundle confers no trust); **WS-R.15.4c/d/e the native courier, driven end-to-end** — `apps/web/src/lcap/transports/courier-controller.ts` (`CourierController`) runs the Nearby plugin to actual byte exchange (off-by-default; Stealth/Emergency force-off via `decideCourierStart`; public-only carriage), all four §22.5 controls + the radio-metadata-disclosure ack gate in `courier-controls-state.ts` rendered by the `CourierControls` UI (the advertise/discover toggles disabled until the disclosure is acknowledged), and three new Java plugins compiled into the debug APK — `WifiDirectCourierPlugin.java` (Wi-Fi Direct — the framework works on the emulator (`discoverPeers` SUCCESS) but netsim bridges only Bluetooth, not Wi-Fi, so two stock emulators never discover each other; group formation is gated to real radios) + `BluetoothCourierPlugin.java` (Classic RFCOMM + a now-IMPLEMENTED duplex BLE-GATT fallback — a write+notify characteristic + a length-prefixed `FrameAssembler`, version-guarded for minSdk 23 — both netsim-verified) + `UsbCourierPlugin.java` (USB accessory mode, physical-OTG-only — there is no emulated USB bus); **WS-R.15.4f re-verified + massively expanded** — the two-emulator radio E2E (`apps/courier/scripts/radio-e2e.sh`) now runs a six-scenario, three-medium matrix (Nearby ×4 incl. 512 KiB chunked-integrity + duplex + disconnect, BLE GATT, RFCOMM), all green on the rebuilt APK; and **Gate-19 (WS-R.15.7b / WS-S.4.4) wired to REAL takedown state** — the `lcap_block_provenance` table (migration `0046`) maps `block_cid → (target_type, target_id)`, `apps/api/src/lcap/takedown-oracle.ts` (`DrizzleTakedownOracle`, fail-closed: a thrown query is treated as a halt) + `publisher.ts` (`LcapPublicPublisher`) re-check the live oracle at PUBLISH and REPUBLISH behind `assertPublicGatewayEligible`, and the env-gated `POST /api/lcap/v2/public-bridge/{publish,republish}` route (503 when `LCAP_IPFS_*` + `DATABASE_URL` are unset) is the real caller — so `@licio/lcap-p2p` is now an `apps/api` dependency (the DB binding it cannot import itself).  The remaining WS-R work is field confirmation on PHYSICAL phones (the emulated-radio E2E validates the full code path; real radios add hardware confidence) and the live two-browser WebRTC convergence E2E for the private plane (see WS-S) |
| WS-S | Private P2P rooms (E2EE) | In progress (extension; `docs/PRIVATE_SPEC.md`) — **the foundation is shipped** (the room-class model, the server non-storage contract, and the private schemas + canonical encoding land FIRST, so a partially-built P2P client can never write server content): **WS-S.0.1** the three §4.1 room axes in `@licio/shared` (`storage_mode`/`authority_model`/`directory_mode` enums + the `roomAxesSchema` coherence refinement — the SSOT the DB CHECKs mirror — + `roomClassOf` + the `unlisted` p2p default); the **WS-S.0.2/0.3 honest-limits copy SSOT** (`packages/shared/src/constants/private-rooms.ts`: the §6 creation/removal disclosures, the five §20.2 acknowledgments, the §20.1 "Members-only server room" labels, the Appendix E privacy matrix — locale-ready BLOCKING copy pinned by a prohibited-language copy-lint; the UI render lands with WS-S.7/9.1); **WS-S.1** the server non-storage gates (the keystone) — **1.1** the `rooms` axes columns + the six §23.2 coherence CHECKs (migration `0043`, additive) mirroring the shared schema, with `RoomRecord.storageMode` threaded through the in-memory + Drizzle forum stores; **1.2** `private_room_stubs` + `private_rendezvous_records` (migration `0044`) — the ONLY two server tables a P2P room may touch, with a strict §8.2 column ALLOWLIST (the §8.1 forbiddance list is the denylist; the rendezvous record has NO room FK, §15.3.1) enforced by `checkPrivateServerTables()`; **1.3** the endpoint rejection guards (`POST /v1/stories` → `409 p2p_room_requires_client_sync` before any side effect; the contribution path → `404`; `GET /v1/rooms/:id/feed` → `409 p2p_room_local_only`; the server room-create route hard-codes `server` storage); **1.3b** the §8.3 DATABASE guard — a `BEFORE INSERT OR UPDATE` trigger on every room-referencing table except the §8.2 stub/rendezvous (`stories`+`threads` content roots, transitively covering contributions/uploads/summaries, plus the non-content `room_stewards`/`room_subscriptions`/`lenses` a room-keys-only p2p room can never have; migration `0045`, additive trigger-only) rejects any row whose `room_id` resolves to `storage_mode='p2p'`, the code-path-independent backstop below the service-layer 409/404 (a gated Postgres harness proves it bites on all five tables AND that the 0043 coherence CHECKs reject each incoherent axis tuple by name); **1.4** the retriever/search/event-pipeline exclusion (every ranking retriever + the room surface predicate `roomStorageMode === 'server'`; server search — in-memory + the Drizzle `storage_mode = 'server'` SQL — excludes p2p docs; the event router refuses any content event referencing a p2p room, wired by the forum boot); **1.5** the seven §23.10 CI gates (`check:no-p2p-server-content`, `check:no-private-cid-egress`, `check:private-rendezvous-schema`, `check:private-bundle-transparency`, `check:p2p-endpoint-rejections`, `check:p2p-ranking-exclusion`, `check:p2p-search-exclusion` — proven to bite on injected fixtures), with `check:no-applause`/`check:no-raw-egress` extended over `packages/private-p2p`; and **WS-S.2** the private schemas + canonical encoding — **2.1** the code-split `@licio/private-p2p` workspace (depends on `@licio/shared` only; registered in all four `check-workspace-deps` maps + the dedicated private-chunk bundle budget excluded from the core 320 KiB total); **2.2** `canonical(...)`/`decodeCanonical(...)`, the ONE DAG-CBOR deterministic profile (zero-dependency; shortest-form ints, definite-length, bytewise-encoded-key map order, optional-omit, UTF-8/NFC, fail-closed reject matrix + §27 caps, pinned by the P1/P2/P3 + integer-boundary + bomb-abort suite); **2.3** every strict private schema (the §10.4 envelope — EXTENDED with `capability_root_at_seq`/`chunk_index`/`chunk_total` so a verifier reconstructs both §10.5 AADs from it; the §13 manifest/op-bodies/attachment/search; the §10.3 invite + §12.3 join; the §19.4 report — **contribution ops REUSE the shipped WS-G constants** so the typed rules cannot drift).  The **WS-S.3 cryptographic foundation is shipped** (all in `packages/private-p2p/src/crypto/`, every primitive a thin RFC-vector-pinned WebCrypto wrapper): **3.1a** the minimal `ts-mls` MLS wrapper (RFC 9420, suite `MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519` pinned, `check:p2p-mls-wrapper` forbids deep imports); **3.1b** the epoch bridge (`room_epoch_secret` = MLS-Exporter → the five-key schedule, atomic rotation, manifest-fork divergence); **3.2** HKDF-Expand-Label + the five room keys (RFC 5869 vectors); **3.3a/b** the §10.5 two-layer AES-256-GCM object AEAD (canonical body/wrap AADs, epoch-bound replay defense, §25.4 padding, §10.6 pad-not-compress); **3.4** HPKE base-mode invite bootstrap (RFC 9180 suite A.1 over WebCrypto X25519, pinned to an `@hpke/core` interop vector + RFC 7748 DH); **3.5** Ed25519 device signatures (cross-validated against `@noble/curves`); **3.6a** the §10.8 four-tier key store (Argon2id/non-extractable/passkey-PRF/agent + the high-risk-tier policy); **3.6b** the §12.6/§12.7 portable recovery kit (no platform involvement; the `check:no-p2p-server-content` umbrella now forbids a server recovery endpoint); **3.6c** §12.6.1 capability-based threshold recovery (M distinct recover-capable admins; NOT secret-sharing — the op carries no key; recovery = an ordinary MLS Add); **3.7** the forward-secrecy/nonce-uniqueness/fuzz property suite.  Vetted deps (§6.12.12, MIT, no install scripts, code-split private chunk): `ts-mls` (+ `@noble/ciphers`/`@noble/curves` peers) + `@noble/hashes` (Argon2id).  The **§9.4 content-addressing (WS-S.4.2 — dependency-free CIDv1-over-ciphertext, multiformats/RFC-4648-pinned) and the §14.3 deterministic reducer (WS-S.5 — the Lamport canonical total order, the §11.3 capability model, the authority-enforcing fold + §14.4 conflict policy, `roomStateCommitment`, the structural §14.2 pre-pass; byte-identical across 25 shuffles) are also shipped** (the maintainer-chosen lighter path; no Helia).  **WS-S.5 is now complete** (5.6/5.7/5.8: the §14.5 verify-before-use snapshots, the §14.6 device-local moderation overlays, the §13.7 local-only encrypted search) **plus the §14.2 stage-1 op wire-codec** (`sealOp`/`openOp` — seal a `PrivateRoomOp` into a signed `PrivateEncryptedEnvelope` and reverse it fail-closed: signature → AEAD-open → schema → plaintext-vs-signed-metadata cross-check) + the §10.4 author-device-blind derivation (`deriveAuthorDeviceIdBlind` — the per-epoch device pseudonym, an HKDF-Expand-Label key + an HMAC blind id; the spec names the field but leaves it underivable) and `buildOpIntakeContext` (composing reduced state + held epoch keys into the `openOp` context, recomputing each device's blind id from its recorded `signing_public_key` so `sealOp`/`openOp` round-trip against REAL room state).  The **WS-S.6 P2P sync-decision plane is shipped as a pure, transport-independent core** (`packages/private-p2p/src/sync/`): **6.1a/6.1b** §15.2/§15.3 blind rendezvous (HMAC-SHA256 blind ids over CANONICAL messages, the §15.3.1 "rendezvous_key IS the capability" property, sealed announcements AAD-bound to the record, the §15.3.2 coarse-bucket/jitter/cover-record/high-risk-steering mitigations); **6.2** §15.4 encrypted signaling (the opaque server-routed `EncryptedSignal`, the server reads no SDP/ICE) + relay-only ICE suppression, over the X25519-ECDH transcript-bound pairwise secure channel (`crypto/ecdh.ts` + `sync/secure-channel.ts`); **6.3** §15.5 membership-proving handshake (device-key proof over a room/epoch/ephemeral-bound transcript, fail-closed admission before block exchange, epoch-bound session key); **6.4** §15.6/§15.7/§15.8 head announcement + frontier-first reconciliation (`computeHeads`/`wantedHeads`/`missingParents`) + the fetch-order priority + block request/response + refuse-large/backoff; **6.5** §15.9 offline encrypted-archive (CAR) exchange whose import re-runs §14.2 stage-1 on every envelope (no container-conferred trust).  **WS-S.6.6 — the server-blind rendezvous endpoint — is also shipped** (`apps/api/src/private-rendezvous/` + the `POST /v1/private-rendezvous/{announce,poll,signal,signal/poll}` routes): opaque-only blind ids + ciphertext + a server-clamped TTL, the §15.3.1 no-existence-oracle (`poll` always returns a bounded list, never 404), aggregate-only metrics, IP-free global rate limits, CSRF-exempt (sessionless); presence persists to the migration-`0044` `private_rendezvous_records` table behind a gated Postgres adapter while signals are transient.  The endpoint imports `@licio/private-p2p` ONLY for the blindness-preserving **WS-S Tier-2 per-announcer cap** verify (the `rendezvous-cap` subpath; a ZK proof check revealing nothing beyond the per-epoch pseudonym the server already stores, §15.3.1 preserved).  The **client-side `PrivateRoomEngine` is also shipped** (`packages/private-p2p/src/engine/`): the pure orchestration composing the §14.2 wire-intake + the §10.4 device-blind resolution + the §14.3 fold + the `sealOp` author path behind a `PrivateRoomStorage` port — running the bounded open→fold fixpoint (an out-of-order causal batch converges), re-verifying every envelope on load (§8.3, storage confers no trust), quarantining what cannot open, and exposing the §15.6 sync surface + the §15.9 archive export/import (two engines with the same room keys converge by exchanging an archive, no live transport).  The **WS-S.7.1 room-creation + membership orchestration is also shipped** (`engine/room-lifecycle.ts`): `createPrivateRoom` ties the §10.2 MLS keying + epoch bridge + §13.1 manifest + the §12.1 founder genesis into one node-testable call (REAL Ed25519/X25519/MLS-KeyPackage material via the new `encodeKeyPackage`/`decodeKeyPackage` codec), and `inviteDevice`/`joinRoom`/`buildMemberAddOp`/`removeDeviceFromRoom` complete the membership flow — the full **two-device invite→join→converge dance** (a joiner independently derives byte-identical epoch keys; an archive exchange converges both engines) runs end-to-end with no transport, an MLS Remove rotates the epoch so an evicted device's engine quarantines post-removal content (forward secrecy, via `findDeviceLeafIndex` kept inside the wrapper), and `buildRoomOp` + the engine's `nextLamport`/`nextAuthorSeq` author content (story/comment) with correct causal metadata.  **WS-S.8 chunked media is also shipped** (`crypto/attachment.ts`): `encryptAttachment`/`decryptAttachment` split a blob into uniform §25.4-padded chunks AEAD-sealed under one attachment object key, bound by `chunk_index`/`chunk_total` in the `body_aad` (no reorder/drop/cross-attachment splice), the §13.6 manifest's CIDs all over CIPHERTEXT with a coarse `byte_size_class`, the object key wrapped under the epoch key, and decrypt verifying ciphertext-CID/hash + AEAD + plaintext commitment per chunk (fail-closed; uniform chunk length reveals only the count).  The **WS-S.7 apps/web client foundation is also shipped** (`apps/web/src/private-p2p/`): the IndexedDb `PrivateRoomStorage` adapter (the dedicated isolated `licio_private_p2p` DB) + `loadPrivateRoomEngine` (the DYNAMIC-import engine construction, code-split behind `check:private-p2p-split` so the crypto/protocol core stays out of the initial bundle — verified: initial JS 144.5 KB, the ~100 KB crypto core excluded via the `private-p2p` manualChunks); the WS-S.7.4 client UI is shipped (the `CreatePrivateRoomWizard` — SSOT disclosure + 5 blocking acknowledgments — + `PrivateRoomView` + the `/private` routes linked from Profile, jsdom+axe tested), plus the §10.3/§12.3 invite+join orchestration, §13.6 chunked media, and §14.5 snapshots/compaction (the membership-delivery transport + two-browser E2E are the device-session slice; see docs/private-p2p/SECURITY-REVIEW.md).  NOW SHIPPED on top: the **§15.7 op-exchange wire protocol** (`sync/op-exchange.ts`: `head_announcement`/`op_request`/`op_response` + the canonical codec) + `PrivateRoomEngine.missingDependencies`/`serveOps` + the event-driven apps/web **`PrivateSyncSession`** — a fresh peer converges to **byte-identical reduced state by walking the DAG** (proven end-to-end through the wire codec, + bidirectional-union/chunking/fail-closed orchestration tests); the **§15.5 safety number (SAS)** (`crypto/safety-number.ts`, Signal-style iterated fingerprint, symmetric/room-scoped/MITM-detecting) + the **member display-name mapping** (the `member.add` op + reduced `MemberState`, authority-invariant, §14.3.3-converged); the **WS-S.7.4 invite/join/member/verify UI** (`InvitePanel`/`JoinPanel`/`SafetyNumberPanel` over the real MLS/HPKE/Ed25519 copy-paste invite→join→admit); and the **WS-S.9 migration core** (the §24 copy SSOT + `planMigration` Fresh/Selected/Full/Redacted decision + honest leakage disclosures).  Real Chromium WebRTC is verified on-host (the LCAP datachannel loopback E2E).  NOW SHIPPED on top: the **WS-S.4.3 live private-p2p WebRTC carrier** — `apps/web/src/private-p2p/connect-peer.ts` (`connectPrivatePeer`) composes the §15.2/§15.3 blind rendezvous + the §15.4 X25519-ECDH SEALED signaling + the §15.5 membership-proving handshake into a real `RTCPeerConnection` → a post-handshake `PeerChannel` (its OWN driver, no shared crypto with LCAP); fail-closed — the handshake proves the remote device is REGISTERED + ACTIVE at the epoch BEFORE any op frame is served (a `MessageInbox` buffers so a first frame is never lost; a failed handshake tears the connection down).  `apps/web/src/private-p2p/rendezvous-client.ts` (`httpRendezvousTransport`) is the zod-validated fetch transport over `POST /v1/private-rendezvous/*`; `PrivateRoomSession.connect()` derives the epoch keys, builds the transport + a `resolveDevice` over `engine.state().devices`, calls `connectPrivatePeer`, and hands the channel to `PrivateSyncSession` (the §15.7 op-exchange) — so two REAL engines converge to byte-identical reduced state, wired into a "Connect & sync with members" control in `PrivateRoomView` (a node integration test converges two real engines over the real op-exchange codec; the carrier node test converges two engines over a fake-RTC pair + in-memory rendezvous with a fail-closed-reject case); the **WS-S.10 hardened update channel + WS-O substrate** — `packages/shared/src/update/` is the PURE verify-before-unlock core (`verifyUpdateManifest`/`decideUpdateActivation`: a private room activates only when the running bundle is maintainer-Ed25519-SIGNED over a body whose `bundle_digest` equals the SHA-256 of the running bytes, PRESENT in the append-only transparency log via an RFC 9162 inclusion proof against a log-signed checkpoint, and NOT stale — anything else yields a typed UNTRUSTED verdict that LOCKS the rooms), `apps/web/src/update/` is the client gate + SW pinning, the new `check:update-channel` CI gate proves that wiring stays present, and `ensurePrivateBundleTrusted()` is wired into `PrivateRoomSession.{create,load}`/`loadPrivateRoomEngine` (engaged only when a signer set is build-pinned); the **WS-S.9 functional migration** — `apps/api/src/forum/migration-export.ts` (`exportRoomForMigration`/`freezeRoomForMigration`/`purgeRoomForMigration`, steward-gated, 404-over-403, p2p-room-refusing) + the 6-phase `MigrationWizard` (`apps/web/src/components/migration/`) + the `/private/migrate` route + `apps/web/src/private-p2p/migrate.ts` (`reauthorIntoPrivateRoom` runs the §24.2 `planMigration` decision then re-authors each item into the destination P2P room, which encrypts as it authors); a server-enforced read-only freeze (migration `0047`, a `frozen` flag — purge is fail-closed gated on freeze-first so the §8 disclosure stays honest) + purge/anonymize via `POST /v1/rooms/:id/migration/{export,freeze,purge}`; and the **WS-S.11 audit suite** — a 3+-peer convergence matrix (star / chain-relay / concurrent-author / out-of-order+duplicate topologies, asserting identical `roomStateCommitment`), the no-server-content umbrella audit, and the rendezvous-privacy audit (which fixed a latent `DrizzleRendezvousStore.poll` Date-bind bug — now `gt(expiresAt, new Date(nowMs))`), plus a pinned known-answer **SAS (safety number)** vector.  The **live carrier now converges across the FULL room lifecycle over `PrivateSyncSession`** (not a single static epoch): §10.9 epoch rotation (the `mls_commit` delivers each add/remove commit to every connected member, which applies it → derives + installs the new epoch keys → re-opens its pending content; the engine RETAINS rather than drops an op awaiting a key, and a request guard prevents livelock), §12.3 `completeJoin` (the admit returns a GRANT — MLS Welcome + the current device roster + a §14.5 snapshot sealed under the new epoch — so a joiner bootstraps the existing members/devices/content WITHOUT the historical keys it never held, forward-secrecy preserved, and authors with its own proof-bound Ed25519 device signing key — no MLS-leaf-key reuse), epoch-rotating `removeMember` (the evicted device cannot read post-removal content), §13.6 media block exchange (`block_request`/`block_response` lazily fetch the manifest then chunks + `decryptAttachment`, every CID re-verified before store), and §14.5 live snapshot fetch (a compacted/lagging reader that cannot fetch the pruned prefix op-by-op bootstraps over `snapshot_request`/`snapshot_response`); post-handshake op frames are additionally AEAD-sealed under the §15.5 step-4 pairwise session key.  The **LCAP P2P sync + the native courier are wired to real UI** (`P2pSyncPanel` on `/profile/offline`, `CourierRunner` on `/profile/mode`), and the optional LCAP-P2P transport plane is separately budgeted (its own `lcap-p2p` chunk, excluded from the core total like `private-p2p`).  The carrier is now resilient end-to-end: §15.4 ICE-restart recovers a TRANSIENT path failure (NAT rebinding, a Wi-Fi↔cellular handover) IN PLACE on the live `RTCPeerConnection` — the offerer re-offers with `iceRestart` over the still-live sealed signaling while the answerer renegotiates, keeping the SAME data channel + the membership-proven §15.5 session key (never re-running the handshake), with bounded retries before a hard drop falls back to `maintainConnection`'s re-dial — atop the already-shipped bounded mesh fan-out (`maintainMesh`) and auto-reconnection (`maintainConnection`).  The real-Chromium carrier E2E (`apps/web/e2e/private-carrier.realwebrtc.spec.ts`) now proves a real-WebRTC frame exchange, full §15.7 op-exchange convergence to byte-identical reduced state, AND a real ICE-restart re-offer that keeps the channel alive (the deterministic restart state machine — grace, bounded retries, offerer-initiates, a self-driving recovery loop that triggers off BOTH `iceConnectionState` and `connectionState`, and an exhaustion→teardown→re-dial path (so a `disconnected`-that-never-`failed` connection can't leak the signaling pump) — is unit-covered in `connect-peer`'s `ice-restart.test.ts`).  The remaining residual is field confirmation on PHYSICAL browser radios + multi-peer mesh fan-out under real loss (the headless real-WebRTC E2E validates the full code path).  The **WS-S Tier-2 rendezvous-cap is shipped END-TO-END (crypto + server enforcement + the client carrier hookup)** (`packages/private-p2p/src/crypto/bbs` + `src/rendezvous-cap` + `apps/web/src/private-p2p/rendezvous-cap-manager.ts`, ~50 tests; `docs/private-p2p/TIER2-RENDEZVOUS-CAP.md`): an anonymous-credential per-announcer cap so the rendezvous (server OR a peer) bounds a member to one presence slot per `(epoch, bucket)` WITHOUT learning identity — IETF-byte-exact-vector-pinned base BBS (`BBS_BLS12381G1_XMD:SHA-256_SSWU_RO_`, the `decentralized-identity/bbs-signature` fixtures) + a per-verifier pseudonym nullifier + BLIND issuance (admin-unlinkable, composition-anchored to the vetted base; the pseudonym/blind drafts publish no vectors yet, so those layers are composition/property-verified) + the rendezvous-cap credential.  The server (`apps/api/src/private-rendezvous`) verifies the ZK proof (the time bucket validated against its clock so a fresh bucket cannot mint a fresh slot; the per-`(room,epoch)` issuer key first-seen-pinned), keys the slot by the pseudonym (dedup = the cap), and FAILS OPEN to the Tier-1 sample-poll.  The MLS DISTRIBUTION rides the §14.3 op log (the self-publishing `rendezvous.request` → one converged `DeviceState.rendezvousCommitment`; the admin-only `rendezvous.issue` carries the per-epoch issuer key + each device's blind signature as an authority-checked event), bridged to the session by `coordinator.ts`.  The CLIENT cap is live: the §15.3 announcement carries an OPTIONAL `cap` ({proof, pseudonym}) sealed INSIDE it (the relay never sees it), `connect-peer.ts` seals it on announce + SKIPS a present-but-invalid cap on poll, and `RendezvousCapManager` (a lazy subpath load; `RendezvousIssuer.fromSeed` for a stable per-epoch issuer key) drives publish→install→issue over the engine reads + feeds the hooks into `PrivateRoomSession` (after each ingest + before each dial) — fail-open to Tier-1 throughout, proven by a real session authoring its `rendezvous.request` on ingest.  The nid/issuer-seed persist in a v4 `cap_secrets` IndexedDB store (the same trust boundary as the room epoch keys, off origin-wide localStorage), and the flood adversary is tested through the REAL carrier (a flooder under a different issuer publishes 20 unverifiable-cap announcements → `connectPrivatePeer` skips every one + never reaches the dial path, while without the cap a fake is dialed).  Residual: drive enrollment continuously during live sync + a PHYSICAL two-radio field run (the headless two-browser convergence + ICE-restart carrier E2E is shipped).  See `docs/private-p2p/README.md` |
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

**Vitest configuration.**  Twelve test projects: shared (node), db (node),
invariants (node), ranking (node), ai-governance (node), governance (node),
lcap (node), lcap-p2p (node), private-p2p (node), api (node), web (jsdom),
policy (node).  Their
settings live once in `vitest.shared.ts`; the root `vitest.config.ts`
composes them into the unified `pnpm test` run + the cross-workspace V8
coverage gate, and each workspace has a thin local `vitest.config.ts`
re-using the same settings so `pnpm --filter <ws> test` runs standalone.
Coverage threshold: 80% minimum for lines, functions, branches,
and statements.

**Test counts.**  `pnpm test` is the canonical query (≈5673 tests pass
at current state).  Approximate file counts:

| Workspace | Test files | Environment | Canonical query |
|-----------|-----------|-------------|-----------------|
| apps/web | ~140 unit + 8 E2E (6 frontend-only + 2 BFF-in-the-loop specs; incl. the WS-J report flow, the notice-inbox appeal affordance, safety controls, the moderation console panels incl. the appeal-review-before-decide gate, the WS-T comment-flow BFF spec — inline story comments + legacy thread redirect, the WS-K AI provenance-label component, the WS-R.11 client-store suites — `lcap_v2` schema, §23.2 durability layer, §21.2 eviction, §21.3 storage modes, §23.3 sync triggers, §21.4 replication — and the WS-S.7 private-room client suite — the IndexedDb storage adapter (room isolation + idempotent upsert) + `loadPrivateRoomEngine` + the `PrivateRoomSession` create/author/persist/reload manager + the `CreatePrivateRoomWizard`/`PrivateRoomView` UI suites over fake-indexeddb + axe) | jsdom / Playwright | `pnpm --filter web test` |
| apps/api | ~120 (incl. WS-D identity + the `expert`/`admin` RBAC roles + WS-E pipeline + WS-F ingestion + WS-G forum + WS-H invariants + WS-I ranking/surfaces/neutrality + the WS-J trust-safety services/routes/stores/units + the gated WS-J Postgres adapters incl. the right-to-erasure path + the WS-K governance backbone/pipelines/routes/stores/coverage + the WS-Q E2E test-auth route + the WS-R in-memory LCAP ingestion engine (incl. server-computed §18.3 validation over registered identity state) + the §29 LCAP routes (content reads + the pack-import POST, with shared crypto fixtures) + the LcapServerStore contract over the in-memory + gated Drizzle adapters + the WS-S.6.6 server-blind rendezvous suite (TTL clamp, no-existence-oracle, signal queue/drain, CSRF-exempt mount) + the dev-seed showcase integration test + the RUN_PERF benchmarks) | node | `pnpm --filter api test` |
| packages/shared | ~22 (incl. WS-D–WS-H schemas, URL/lifecycle utils, the §5.6 rating-label SSOT, the UGC pipeline + XSS-vector suite, the WS-S.10 update-channel verify-before-unlock core — RFC 9162 Merkle inclusion + `verifyUpdateManifest`/`decideUpdateActivation` fail-closed matrix) | node | `pnpm --filter @licio/shared test` |
| packages/db | ~4 (isolation + content denylist + gated integration) | node | via root `pnpm test` (db project) |
| packages/invariants | ~19 (PWAtt/MinHash/freshness + the WS-H invariant mathematics: matroid/fiber/GW/sheaf/holonomy/supporting property suites + the regression harness + the SPEC-purpose oracle suite) | node | `pnpm --filter @licio/invariants test` |
| packages/ranking | ~7 (denylist + versioned-artifact pinning, strict schemas, §5.5 profile fuzzing + baseline weights, §5.4 arithmetic, penalties/constraints incl. tie enforcement, dedup/balancing, templates + x-pseudo localization, pipeline determinism, replay diff) | node | `pnpm --filter @licio/ranking test` |
| packages/ai-governance | ~13 (the prohibited-use guard + §24.5 matrix, the upgrade-only label ladder, the canonical inventory + risk assessments, the bias-audit math (two-proportion z-test + small-cohort), hallucination/safety/red-team, the harness selection/decision/reproducibility, the §24.3 summary-quality constraints + renderer, accuracy, canonical JSON, and the schema refinements) | node | `pnpm --filter @licio/ai-governance test` |
| packages/governance | ~5 (WS-U AI-governed-rooms domain: the moderation policy DSL + interpreter, the proof-carrying treasury kernel + investment bands, the capability model + derivation (floor-reserved structural disjointness), the quorum-gated fail-safe election tally, and the canonical-JSON content addressing) | node | `pnpm --filter @licio/governance test` |
| packages/lcap | ~33 (WS-R LCAP v0.2 pure-protocol core: the LDC deterministic-CBOR encoder/decoder + the §9.1.5 integer table + the full decode rejection matrix, CID construction (SHA-256 known-answer grounded) + RFC 4648 base32, ES256 low-S + the malleability-twin defense, COSE_Sign1 build/verify + the §10.2.4 six-step matrix, device-key/COSE_Key round-trip, suite agility/downgrade, strict closed-schema records/proofs + LDC codec pairing, the §18.3 identity-chain accept/quarantine/reject/revoke matrix, arrival-order-independent record projection + fork detection, blocks/chunk reassembly + compression-bomb abort, the packfile round-trip/cap/tamper matrix, the exhaustive RFC 9162 Merkle inclusion/consistency proofs, the `validate()` trust-projection staged matrix, liveness/receipts, conflict dispatch, the §16/§17 sync-decision plane (`minimalClosure` + scheduler integration, frontier diff, pulse build/apply, reconciliation order, monotonic budget shrinking, the interest privacy/leak matrix, wants + resume ranges, idempotency, exchange assembly + status, the §24.1 server-ingestion commit-stage decision, the §24.4 topological ingestion-order resolver, the §27.2 malicious-graph guard), the conformance-corpus replay, the P1/P2/P3 determinism properties, the §22.6 transport seam (server-anchor-last selection / fallback / public-only carriage gate), and the §32.3/§32.5 deterministic network simulator (seeded link model + pluggable adversaries over the REAL scheduler + closure; the C0-never-starved / fork-detection / transport-independence scenarios)) | node | `pnpm --filter @licio/lcap test` |
| packages/lcap-p2p | ~3 (WS-R.15.6/15.7 optional transports: the server-blind AES-GCM signaling envelope (AAD-bound, opaque-fields), the §26.4 ICE/NAT-privacy policy (off-by-default / Stealth-force-off / relay-only-requires-TURN), the WebRTC data-channel transport over a fake channel + the ≤16 KiB SCTP datachannel fragmentation/reassembly fail-closed matrix; the `block_cid ⇄ CIDv1(raw,sha2-256)` mapping, the gateway bridge's re-verify-before-use + public-only publish gate + the `TakedownOracle` seam / `takedownInForce` / `republicationSet` halt rule) | node | `pnpm --filter @licio/lcap-p2p test` |
| packages/private-p2p | ~33 (WS-S Private P2P rooms: the canonical DAG-CBOR + strict-schema + op-body suites; the **WS-S.3 crypto foundation** — RFC 5869 HKDF vectors, the two-layer AEAD (AAD-flip/epoch-replay/nonce-uniqueness), Ed25519 KATs cross-validated against `@noble/curves` + the RFC 9180 HPKE interop vector + RFC 7748 X25519 + RFC 4231 HMAC KATs, the MLS multi-device/epoch/manifest-fork suite, the four-tier key store + recovery kit + threshold recovery, the forward-secrecy + fuzz properties; the **WS-S.4.2/5** reducer suites — the CIDv1 multiformats/RFC-4648 pins, the Lamport/canonical-order tests, the reducer genesis/capability/§14.4-conflict matrix, the §14.3.3 25-shuffle determinism property, the structural pre-pass + the §14.2 stage-1 op-codec seal→open→reduce matrix, and the §14.5/§14.6/§13.7 snapshot/overlay/search suites; AND the **WS-S.6** sync suites — blind rendezvous derivation/authorization/mitigations, X25519 ECDH agreement, the transcript-bound channel-key separation, signaling seal/open + relay-only ICE filtering, the handshake success + reject matrix, head-sync reconciliation-to-closure + fetch-order, and the offline-archive re-validating import; the §10.4 device-blind derivation + the buildOpIntakeContext seal→open-against-state composition + the PrivateRoomEngine lifecycle + sync surface + two-engine archive convergence + the WS-S.7.1 room-lifecycle (createPrivateRoom/inviteDevice/joinRoom/buildMemberAddOp + MLS KeyPackage codec) with the full two-device invite→join→converge membership flow + content authoring + §10.9 removal-with-forward-secrecy + §13.6 chunked media + §10.3/§12.3 invite+join + §14.5 snapshots/compaction; AND the **WS-S.11 audit** legs — the 3+-peer convergence matrix (star/chain-relay/concurrent-author/out-of-order+duplicate, identical `roomStateCommitment`) + the pinned known-answer SAS (safety-number) vector — crypto + reducer + sync all ≳ 92% coverage) | node | `pnpm --filter @licio/private-p2p test` |
| scripts | ~5 (incl. the seven WS-S.1.5 private-room CI gates proven to bite + the live-source marker regression catch) | node | via root `pnpm test` (policy project) |

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

1. Lint & format (Biome + security lint + policy + no-raw-egress +
   no-applause + the WS-R.14.3 `check:lcap-schema-egress` LCAP doctrine gate
   + the WS-S.10.2b `check:update-channel` verify-before-activate gate)
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

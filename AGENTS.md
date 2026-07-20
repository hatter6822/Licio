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

## Build and run

```bash
# Prerequisites: Node 22+ (pinned in .nvmrc), pnpm 11.15.1+.
corepack enable && corepack prepare pnpm@11.15.1 --activate
pnpm install

# Daily commands.
pnpm dev                            # web (5173) + api (3001); in-memory + seeds demo data (no DB/Redis);
                                    #   the DEV-ONLY simulated governance-LLM runtime auto-starts (LICIO_LLM_SIM=off disables)
pnpm setup:llm                      # provision + verify the REAL local governance-LLM runtime (pulls the
                                    #   default model; --docker also starts the Compose `llm` profile ollama)
pnpm bench:llm                      # race local models through the REAL governed surfaces (latency +
                                    #   validity per model; native-probe diagnosis for broken pairings)
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
pnpm audit:advisories               # dependency advisories via the npm BULK endpoint
                                    #   (the retired-classic-endpoint `pnpm audit` replacement)
pnpm check:deps                     # dependency-budget enforcement
pnpm check:workspace-deps           # workspace boundary enforcement (pkg.json + imports)
pnpm check:policy                   # doctrine/policy document validation
pnpm check:prod-parity              # the dev↔prod parity gate: every in-memory adapter needs a
                                    #   boot-wired production counterpart; every env key must be
                                    #   schema-validated or a documented dev flag; production
                                    #   adapters hold no in-memory state
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
pnpm check:p2p-mls-wrapper          # WS-S.3.1a: ts-mls is imported ONLY via the reviewed MLS wrapper
pnpm check:update-channel           # WS-S.10.2b: the private-mode bundle is signature + transparency-log + digest verified BEFORE activation (untrusted ⇒ rooms locked)
pnpm check:no-applause              # no likes/votes/karma/reactions in components + routes + LCAP + private-p2p
pnpm check:no-raw-egress            # no raw attention traces leaving the browser (+ the LCAP + private-p2p planes)
pnpm check:knomosis-pins            # WS-L.1.1a: every non-local Knomosis deployment pins real finality values (sentinel commit/manifest rejected outside `local`)
pnpm check:sw                       # SW security scan (run after build)

# Supply chain and build validation.
pnpm run sbom                       # CycloneDX SBOM (includes transitive deps; `run` is
                                    #   required — pnpm 11's builtin `sbom` shadows the bare name)
pnpm clean                          # remove build artifacts

# Database (development).  Migrations are HAND-AUTHORED (SQL + a
# drizzle/meta/_journal.json entry — docs/DEVELOPMENT.md §15): the tracked
# meta snapshots are far behind the chain, so db:generate would diff against
# stale state and emit a garbage migration — do not run it here.
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

**Toolchain.**  Node 22 (pinned in `.nvmrc`), pnpm 11.15.1 (pinned
in `package.json` `packageManager`; engines require pnpm >= 11 — the
security overrides live in `pnpm-workspace.yaml`, which pnpm 9 would
silently ignore), TypeScript 7.0.2, Vite 8.1.5, Biome 2.5.4.  pnpm 11's
default supply-chain gate (24h `minimumReleaseAge`) vets every
resolution: a version published less than 24 hours ago is held back
until it ages — do NOT weaken or bypass the gate to force a
newer-than-24h version in.

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

A directory-level map for orientation — **per-file purpose lives in each
file's leading comment block, not duplicated here**.  Directories map to
workstreams via `docs/planning/00-index.md`; the per-workstream
`docs/*/README.md` files are the implementation references.

```
licio/
├── package.json, pnpm-workspace.yaml, tsconfig*.json, vitest*.ts,
│   biome.json, lefthook.yml, docker-compose.yml, .nvmrc    -- root config
├── CLAUDE.md / AGENTS.md (byte-identical), README.md, SECURITY.md,
│   CONTRIBUTING.md, CODE_OF_CONDUCT.md                     -- top-level docs
├── apps/
│   ├── web/                 -- React 19 PWA (Vite 8 / Rolldown).  vite.config.ts
│   │   │                       owns the PWA manifest + CSP, playwright.config.ts
│   │   │                       the E2E matrix, public/sw-push.js the service worker
│   │   └── src/
│   │       ├── components/      -- UI primitives + feature components (ai, a11y,
│   │       │                       composer, comments, feed, rooms, story, safety,
│   │       │                       moderation, ugc, reader, profile, governance,
│   │       │                       treasury, wallet, compliance, security, i18n,
│   │       │                       wellbeing, migration, DEV-only simulator panel)
│   │       ├── routes/          -- TanStack Router file-based routes (+ -pages/)
│   │       ├── stores/          -- Zustand state (auth, ui, feature-flags) + zod persist
│   │       ├── lib/             -- typed RPC client, per-WS API modules, queries,
│   │       │                       telemetry, wallet-signing, link-safety
│   │       ├── offline/         -- IndexedDB offline-first: db, store, queue, sync,
│   │       │                       drafts, AES-256-GCM draft-crypto, eviction
│   │       ├── lcap/            -- WS-R LCAP client store (lcap_v2 IDB, GC, storage
│   │       │                       modes, sync triggers, replication)
│   │       ├── private-p2p/     -- WS-S private-room client (IndexedDb adapter +
│   │       │                       dynamic-import room manager)
│   │       ├── signals/         -- attention pipeline (in-browser; only bucketed
│   │       │                       aggregates egress) + assertNoRawEgress guard
│   │       ├── security/        -- Trusted Types policies
│   │       ├── design-system/   -- design-token SSOT + WCAG contrast validation
│   │       ├── i18n/, hooks/, perf/, push/, routing/, styles/, styleguide/
│   │       └── test/, e2e/      -- Vitest utils + Playwright specs
│   ├── api/                 -- Hono BFF (app.ts middleware stack, index.ts prod boot,
│   │   │                       e2e-server.ts gated in-memory harness)
│   │   └── src/
│   │       ├── routes/          -- /v1/* surfaces (auth, privacy, events, stories,
│   │       │                       forum, rooms, moderation, ai, wallet, knomosis,
│   │       │                       governance, treasury, compliance, health, csp)
│   │       ├── middleware/      -- security-headers (CSP/HSTS), csrf, cors, auth, logger
│   │       ├── identity/        -- WS-D: crypto, sessions, rbac, webauthn, siwe, totp,
│   │       │                       email-otp, secrets, rate-limit; gated Drizzle/Redis/S3
│   │       ├── events/          -- WS-E pipeline: ingest, privacy-gate, replay, router
│   │       │                       (pay-to-rank firewall), realtime (HLL), retention
│   │       ├── pwatt/           -- WS-E PWAtt scoring: aggregation, anti-signals,
│   │       │                       scoring, shadow boundary, ranking-v0, scheduler
│   │       ├── invariants/      -- WS-H platform: the 11 invariant services, runner,
│   │       │                       promotion gate, scheduler
│   │       ├── ranking/         -- WS-I: retrievers, quotas, orchestrator, features,
│   │       │                       safety-filter, killswitch, the 8-stage service
│   │       ├── ingestion/       -- WS-F: submission, SSRF-safe fetch, robots, extraction,
│   │       │                       MinHash dedup, embeddings, search, lifecycle
│   │       ├── forum/           -- WS-G/T: contributions, comments, rooms, lenses,
│   │       │                       visibility, video, data-rights, EXIF strip
│   │       ├── moderation/      -- WS-J: reports, relations, appeals, actions, incidents,
│   │       │                       evidence, notices, prechecks, authz, production-ports
│   │       ├── ai-governance/   -- WS-K: registry + deploy gate, prohibited-use guard,
│   │       │                       harness, output-records, models, debate, llm/
│   │       ├── lcap/            -- WS-R server I/O: server-ingest, store, §29 routes
│   │       ├── knomosis/        -- WS-L gateway: manifest, preflight/submit, kill switches
│   │       ├── governance/      -- WS-U runtime: elections, model ratification, kernel
│   │       ├── treasury/        -- WS-M: mode machine, treasury, payment intents,
│   │       │                       proposals, grants, delegations, hash-chained audit
│   │       ├── compliance/      -- WS-N: §19.1 region ladder, CompliancePort, cases,
│   │       │                       SAR/lawful-access, no-key filter, hash-chained audit
│   │       ├── private-rendezvous/ -- WS-S.6.6 server-blind rendezvous
│   │       ├── simulator/       -- DEV-ONLY traffic simulator + governance-LLM sim
│   │       ├── telemetry/       -- WS-P Web-Vitals RUM sink
│   │       ├── lib/             -- concurrency, hash-chain, rate-limit, push, media-urls,
│   │       │                       parity-guard, demo-seed
│   │       └── __tests__/       -- route/middleware/service suites
│   └── courier/             -- WS-R.15.4a native Android courier (Capacitor 8 shell;
│                               webDir → apps/web/dist, byte-identity no-fork gate)
├── packages/
│   ├── shared/              -- schemas/types/constants SSOT (leaf): zod schemas, the
│   │                           UGC pipeline (Markdown-lite AST + DOMPurify), the EIP-712
│   │                           registry, the jurisdiction vocabulary, env validation
│   ├── db/                  -- Drizzle schema + migrations (+ isolation BFS, private-room
│   │                           guard); depends on @licio/shared only
│   ├── invariants/          -- PWAtt/MinHash/freshness pure math + type-level invariants
│   ├── ranking/             -- WS-I pure ranking (denylist, scoring, diversify, the
│   │                           deterministic pipeline); NEVER @licio/db
│   ├── ai-governance/       -- WS-K pure domain (prohibited-use, bias/hallucination,
│   │                           harness, summary-quality); browser-safe, NEVER @licio/db
│   ├── governance/          -- WS-U + WS-M pure math (moderation wrapper, kernel,
│   │                           voting/tally, payment-intent lifecycle, exact decimals)
│   ├── lcap/                -- WS-R LCAP v0.2 core: deterministic CBOR, CIDs, COSE,
│   │                           identity chain, sync plane, checkpoints, validate()
│   ├── lcap-p2p/            -- WS-R optional WebRTC/IPFS transports (code-split)
│   └── private-p2p/         -- WS-S private-room plane: canonical DAG-CBOR, schemas,
│                               MLS/HPKE/AEAD crypto, Lamport reducer, sync
├── scripts/                -- build validation + CI static gates (check-*, validate-build)
├── docs/                   -- SPEC.md, OFFLINE_SPEC.md, PRIVATE_SPEC.md, planning/
│                               (00-index.md), per-workstream + policy references
└── .github/workflows/      -- ci.yml (9 jobs), codeql.yml, dependabot
```

## Workspace dependency graph

```
@licio/shared        leaf; no workspace deps
@licio/db            → shared
@licio/invariants    → shared
@licio/ranking       → shared, invariants
@licio/ai-governance → shared
@licio/governance    → shared            (WS-U rooms domain + WS-M treasury math)
@licio/lcap          → shared, zod       (WS-R LCAP core; codec/CID/COSE has zero npm deps)
@licio/lcap-p2p      → shared, lcap, zod (WS-R optional WebRTC/IPFS transports)
@licio/private-p2p   → shared, zod       (WS-S E2EE rooms; NEVER @licio/lcap)
apps/web             → shared, invariants, ai-governance, lcap, lcap-p2p, private-p2p
apps/api             → shared, db, invariants, ranking, ai-governance, governance, lcap, lcap-p2p
```

Load-bearing boundaries (enforced by `check:workspace-deps`, `check:lcap-p2p-split`,
`check:private-p2p-split`; violations block CI):

- **Only `@licio/db` and `apps/api` touch the database.** Every other package is
  `NEVER @licio/db` by construction — the ranking / invariant / governance / LCAP /
  private-p2p math is browser-safe and DB-free.
- **The two decentralization planes never share keys or code:** private-p2p pins
  Ed25519/MLS/HPKE, LCAP pins ES256; `private-p2p` never imports `lcap`.
- **`apps/web` loads `lcap`, `lcap-p2p`, and `private-p2p` by DYNAMIC import only**
  (the split gates assert no static value import) so no protocol/crypto core enters
  the initial bundle.
- **`apps/api` does NOT import `@licio/private-p2p`** (PRIV-API-RENDEZVOUS-1: the
  server holds no per-room issuer key — it would be a cross-bucket linking handle;
  the rendezvous cap is peer-side only). Its `lcap-p2p` edge is the Gate-19 public
  re-publisher (`apps/api/src/lcap/{takedown-oracle,publisher}.ts`) — the DB binding
  `@licio/lcap-p2p` cannot carry itself.

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

**Pinned dependencies (`pnpm-workspace.yaml` `overrides` + exact peers).**
A few versions are pinned to keep the `audit:advisories` gate clean or to
satisfy an exact peer; drop each once upstream ships the fix (per-CVE
rationale lives in the commit that added the pin, not here).  The overrides
live in `pnpm-workspace.yaml` — pnpm >= 10 no longer reads the `pnpm` field
in `package.json`, so an override placed there is silently ignored.

| Pin | Reason | Drop when |
|-----|--------|-----------|
| `ws ^8.21.0` | patched line for viem→isows (old `ws@8.20.1` DoS advisory); no `ws` server runs here | viem/isows guarantees a patched `ws` |
| `undici ^7.28.0` | test-only (jsdom `fetch`); patches two 7.27.2 advisories | jsdom pins `undici >= 7.28.0` |
| `esbuild ^0.28.1` | dev-only toolchain; dedupes onto one audited line | bump with the Vite major |
| `@noble/curves 2.0.1` + `@noble/ciphers 2.1.1` (EXACT) | `ts-mls@1.6.2` declares them as exact peers (KAT cross-checks guard the pin) | `ts-mls` widens its `@noble/*` peer range |

## Reading large files

`docs/SPEC.md` and `docs/planning/00-index.md` (~994 tasks) are large.
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
  - Store adapters (ENFORCED by `check:prod-parity`): in-memory
    adapters are named `InMemory*` (or `Memory*`); production
    adapters `Drizzle*` / `Redis*` / `Postgres*` / `S3*` / `Ses*` /
    `Http*`.  The gate keys on these prefixes to prove every
    in-memory adapter has a production counterpart instantiated in
    the production boot's import closure — an unconventionally named
    adapter is invisible to it.

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
intake — no session to ride), and the decentralized-plane surfaces, all of
which are session-less (the request carries no cookie for CSRF to ride) and
individually rate-limited: the WS-R.12.4 native LCAP sync surface
`/api/lcap/v2/{packs,pulse,exchange}` (device-COSE-authenticated content /
public frontier reads; abuse bounded by each endpoint's own rate limit + the
§27 caps + the graph guard), the WS-R.15.6a server-blind WebRTC signaling
rendezvous `/api/lcap/v2/p2p/signal{,/poll}` (opaque sealed blob to/from an
opaque peer key), the §29.8 device-signed bundle export
`/api/lcap/v2/bundles/export` (a device-signed `export_request` capability is
the authentication), and the WS-S.6.6 server-blind Private P2P rendezvous
`/v1/private-rendezvous/{announce,poll,signal,signal/poll}` (opaque blind
ids + ciphertext under a short TTL).  The web-UI
`/api/lcap/v2/bundles/import` alias is NOT exempt — a session-bearing browser
flow keeps the double-submit token.  `/v1/auth/*` and `/v1/privacy/*` are
token-exempt but STILL Origin-checked (they rely on `SameSite=Strict` + the
opaque session model + a per-flow `login_attempt_id`).

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
  usb=(), bluetooth=(), accelerometer=(), gyroscope=(), magnetometer=(),
  serial=(), midi=()
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

## TypeScript 6+ notes

- TypeScript 7 is the native (non-JS) compiler; `tsc -b` project builds
  behave as before, but `.tsbuildinfo` caches from 6.x are not reused —
  the first post-upgrade `pnpm typecheck` recompiles everything.
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
| `@anthropic-ai/sdk` ^0.110 | api | WS-U ADR-9 governance LLM provider, Anthropic backend (explicit operator opt-in; production DEFAULTS to the loopback-local backend instead, which uses plain fetch; every governed surface fails closed per call to its deterministic path) |

No Lean or Rust toolchains.  This is a pure TypeScript monorepo.

## Implementation roadmap

The core specification defines 18 workstreams (WS-0 through WS-Q).
WS-T (conversation as comments) and the cross-cutting **WS-U**
(AI-governed-rooms redesign) extend the core spec.  Two **extension
workstreams** — WS-R and WS-S — derive from the standalone
`docs/OFFLINE_SPEC.md` (LCAP v0.2) and `docs/PRIVATE_SPEC.md`
specifications rather than `docs/SPEC.md`.  Both are **launch-relevant
and ship WITH the core product**, not deferred: WS-R was elevated to P1
(the 2026-06 maintainer decision making the native courier + browser
P2P/WebTransport/IPFS transports first-class), and **WS-S private P2P
rooms (E2EE) are LAUNCH-BLOCKING** — they go live at the same time as
the rest of Licio (the 2026-06 maintainer decision), so their completeness
+ launch gates (`docs/PRIVATE_SPEC.md` §29) are part of the GA bar, not a
post-M3 add-on.  **WS-U** is the maintainer's binding redesign of AI's
role (`docs/planning/22-ai-governed-rooms.md`; SPEC §16.6/§24.6): every
room has an **elected steward** whose only two powers are to propose a
community-approved, member-downloadable AI **model** and its **prompt**
(both ratified by a Knomosis member vote), and the approved **in-room AI
agent** may then moderate, manage the room treasury, and facilitate
lawmaking **within community-voted, kernel-enforced bounds, holding no
keys, subordinate to a non-overridable platform legal floor**.  The
bounded-autonomy runtime is SHIPPED (elections, model proposal/ratification,
the LLM moderation model in its deterministic wrapper, lawmaking
facilitation, the kernel-backed treasury core behind the fail-closed crypto
flags); WS-U re-scopes WS-K into the platform evaluation/transparency
substrate, amends WS-J/L/M, and preserves the pay-to-rank firewall and
fail-closed crypto in full.
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
| WS-L | Knomosis and wallets | Complete (residuals tracked, `docs/knomosis/README.md`); all behind the fail-closed `cryptoEnabled`/`governanceEnabled` flags |
| WS-M | Treasury and governance | Complete (residuals tracked, `docs/treasury/README.md`); all behind the fail-closed `cryptoEnabled`/`governanceEnabled` flags — governance lifecycle + live readiness, charters, law-packs, the real-asset treasury + payment intents + three-source reconciliation, deadline-driven proposals with wallet-signed voting/challenges, grants/delegations/budgets, the hash-chained audit log, and the web lifecycle/treasury/proposal surfaces |
| WS-N | Compliance | Complete (residuals tracked, `docs/compliance/README.md`) — the identity-free (§19.1 declared-region) jurisdiction engine over the ratified cell vocabulary, the real `CompliancePort` (sanctions screening, velocity/high-value fraud verdicts, wallet risk), the guarded case system + fraud queue, SAR/lawful-access records, risk disclosures + the intent-create ack gate, hash-chained erasure-safe audit, retention sweeps; fail-closed with ZERO policies populated until counsel authors them |
| WS-O | Security and reliability | Planned (WS-O.4.5 adversarial hardening shipped) |
| WS-P | Experimentation and launch | Planned |
| WS-Q | Content–room ownership and visibility | Complete |
| WS-R | Offline content availability (LCAP v0.2) | Core + transports shipped; physical-device field confirmation remains |
| WS-S | Private P2P rooms (E2EE) | Shipped through the live WebRTC carrier + update channel; residuals tracked (`docs/private-p2p/README.md`) |
| WS-T | Conversation as comments | Complete (incl. challenge resolution — the governed debate adjudicator) |
| WS-U | AI-governed rooms (redesign) | Runtime shipped (see `docs/governance/README.md`) |

Read the per-workstream planning document under `docs/planning/`
before starting new work.  The master index at
`docs/planning/00-index.md` lists all ~994 atomic tasks.

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

**Test counts.**  `pnpm test` is the canonical query (≈8200 tests pass without
the gated integration env; more with live Postgres/Redis).  Only monotonic
growth is enforced — no gate pins the count and exact numbers drift, so the
per-suite breakdown lives in each per-workstream `docs/*/README.md`, not here.
Run one workspace with `pnpm --filter <ws> test`.

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

**CI pipeline.**  `.github/workflows/ci.yml` runs 9 jobs on every PR:

1. Lint & format (Biome + security lint + policy + the `check:prod-parity`
   dev↔prod parity gate + no-raw-egress + no-applause + the WS-R.14.3
   `check:lcap-schema-egress` LCAP doctrine gate + the WS-S.10.2b
   `check:update-channel` verify-before-activate gate)
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
8. Security audit (`pnpm audit:advisories` — the lockfile posted to the npm
   BULK advisory endpoint at the high/critical threshold; the registry
   retired the classic endpoint `pnpm audit` itself calls — plus SBOM,
   build validation, AGPL headers,
   secret scanning, install-script detection)
9. Native courier APK (WS-R.15.4a: builds the debug APK from the
   unchanged web build behind the byte-identity no-fork gate)

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

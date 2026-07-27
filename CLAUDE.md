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
pnpm dev                            # web (5173) + api (3001); in-memory + seeded demo data. The governance
                                    #   LLM defaults to the local vLLM lanes in dev AND prod; the dev boot
                                    #   probes each lane and the DEV-ONLY simulated runtime stands in per
                                    #   absent lane (LICIO_LLM_SIM=off disables the stand-in)
pnpm setup:llm                      # provision + verify the REAL local governance-LLM lanes (moderation
                                    #   Qwen3Guard-Gen-4B @ :8001, adjudication Qwen3.6-27B @ :8002; vLLM
                                    #   default; --docker = Compose `llm` profile; --runtime ollama = single-URL alt)
pnpm bench:llm                      # race local models through the REAL governed surfaces, per role
                                    #   (--role moderation|adjudication|all; guard models use their native dialect)
pnpm build                          # shared → db/invariants → web/api
pnpm test                           # Vitest across all workspaces; `--coverage` adds the 80% gate
                                    #   (NOT `-- --coverage`: pnpm passes the `--` through and vitest
                                    #   drops every flag after it, so the gate would never run)
pnpm test:e2e                       # Playwright E2E (Chromium/Firefox/WebKit); web test:e2e:bff = authenticated BFF harness
pnpm lint / lint:fix                # Biome check / auto-fix
pnpm typecheck                      # TypeScript strict-mode (tsc -b; see the cache warning below)

# Security and static gates (what each enforces lives in its scripts/check-*.ts header).
pnpm lint:security                  # innerHTML/eval/Function()/javascript:-URL scan (the
                                    #   dynamic-code sinks are defined once in
                                    #   scripts/dangerous-code-patterns.ts and shared with
                                    #   check:sw, check:update-channel, and
                                    #   check:private-bundle-transparency)
pnpm lint:lockfile                  # lockfile integrity
pnpm audit:advisories               # dependency advisories (npm BULK endpoint; classic `pnpm audit` is retired)
pnpm check:deps                     # dependency budgets      · check:workspace-deps — boundary enforcement
pnpm check:policy                   # doctrine documents      · check:prod-parity — dev↔prod adapter/env parity
pnpm check:csp-parity               # index.html carries NO hand-written CSP, and (after a web build)
                                    #   dist/index.html carries exactly the injected shared policy — the
                                    #   courier WebView's only policy, and the one delivery point the
                                    #   compiler cannot check
pnpm check:dead-exports             # no exported VALUE is referenced nowhere (NAMED exports only —
                                    #   types and `export default` are out of scope; see "Unreferenced
                                    #   exports" under Key conventions).  survey:internal-exports is the
                                    #   narrower, NOT-in-CI report of exports confined to their own file
pnpm check:a11y-hue-usage           # `text-<hue>` (3:1 in dark mode) is never used for NORMAL text —
                                    #   only `text-<hue>-on-soft` clears WCAG 1.4.3 AA there
pnpm check:sql-identifiers          # no migration identifier AT Postgres's 63-byte limit, read with
                                    #   the server's own parser (over-long names TRUNCATE silently and
                                    #   can collide).  The parser applies the limit too, so a cut name
                                    #   is indistinguishable from a genuine 63 — declare the genuine
                                    #   ones; the gated migration harness settles it authoritatively by
                                    #   listening for Postgres's own truncation NOTICE, which also
                                    #   covers Drizzle-derived and `EXECUTE format()` names
pnpm check:governance-kyc           # every governance-participation POST enforces the KYC guard
pnpm check:neutrality               # WS-I ranking neutrality · check:adversarial — WS-O.4.5 ensemble suite
pnpm check:lcap-scheduler           # WS-R lane anti-starvation
pnpm check:lcap-p2p-split           # web imports @licio/lcap-p2p only dynamically (private-p2p-split: same for WS-S)
pnpm check:lcap-schema-egress       # no IP/location/attention/applause field in any LCAP schema
pnpm check:no-p2p-server-content    # WS-S umbrella: no private-room content on the server; siblings:
                                    #   no-private-cid-egress, private-rendezvous-schema, private-bundle-transparency,
                                    #   p2p-endpoint-rejections, p2p-ranking-exclusion, p2p-search-exclusion, p2p-mls-wrapper
pnpm check:update-channel           # private-mode bundle verified BEFORE activation (untrusted ⇒ rooms locked)
pnpm check:no-applause              # no likes/votes/karma/reactions anywhere user-facing
pnpm check:no-raw-egress            # no raw attention traces leave the browser (all planes)
pnpm check:knomosis-pins            # non-local Knomosis deployments pin real finality values
pnpm check:sw                       # service-worker security scan (run after a web build)
pnpm run sbom                       # CycloneDX SBOM (`run` required — pnpm 11's builtin `sbom` shadows it)

# Database (development). Migrations are HAND-AUTHORED (SQL + a drizzle/meta/_journal.json
# entry — docs/DEVELOPMENT.md §15). NEVER run db:generate here: the tracked meta snapshots
# lag the chain and it would emit a garbage migration.
pnpm db:migrate                     # run Drizzle migrations
pnpm db:push                        # push schema directly (development only)

# Per-workspace: `pnpm --filter <ws> <script>` (dev/build/test per workspace; web also has
# gen:tokens + test:e2e; courier build needs the Android SDK + JDK 21 after a web build).
```

`package.json` (root and per-workspace) is the source of truth for
every build command; consult it before adding new scripts.

**Toolchain.**  Node 22 (pinned in `.nvmrc`), pnpm 11.15.1 (pinned
in `package.json` `packageManager`; engines require pnpm >= 11 — the
security overrides live in `pnpm-workspace.yaml`, which pnpm 9 would
silently ignore), TypeScript 7.0.2, Vite 8.1.5, Biome 2.5.5.  pnpm 11's
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

After any source change, also run the gates relevant to what you touched
(each is described under **Build and run → Security and static gates**
above): `lint:security`, `check:deps`, and `check:workspace-deps` on any
change; `check:no-applause` / `check:no-raw-egress` when touching
components, routes, or the signals layer; `check:governance-kyc` when
touching governance-participation routes; `check:csp-parity` when touching
the CSP or its injection plugin; `check:dead-exports` when removing a call site
(the last caller going away is what turns an export dead);
`check:a11y-hue-usage` when touching component class names;
`check:update-channel` when touching the private-mode update path; and — after
a production build
(`pnpm --filter web build`) — `check:sw`.  CI runs all of the above on
every PR.

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
│   │       ├── invariants/      -- WS-H platform: the 12 invariant services, runner,
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
├── scripts/                -- build validation + CI static gates (check-*, validate-build);
│                              dangerous-code-patterns.ts is the SSOT for the eval /
│                              Function-constructor / string-timer sinks every code-scan
│                              gate shares
├── docs/                   -- SPEC.md, OFFLINE_SPEC.md, PRIVATE_SPEC.md, planning/
│                               (00-index.md), per-workstream + policy references
└── .github/workflows/      -- ci.yml (9 jobs), codeql.yml (dependabot RAISES
                            update PRs but never auto-merges them)
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
| `brace-expansion ^5.0.8` | GHSA-mh99-v99m-4gvg (unbounded-expansion OOM) lists EVERY prior release vulnerable (`<=5.0.7`) — there is no backported 1.x/2.x fix, so 5.0.8 is the only patched version | the advisory gains a backported fix, or nothing resolves brace-expansion below 5.0.8 |
| `filelist ^2.0.2` | pairs with the pin above: the workbox dev chain (`…off-main-thread`→ejs→jake→filelist) pulled `minimatch@5`, whose CJS `require('brace-expansion')` expects the pre-5.x DEFAULT export and throws `expand is not a function` under 5.0.8.  filelist 2.x moves to `minimatch@^10.2.1`, which uses the patched line | jake ships a release depending on `filelist >= 2` |
| `ws ^8.21.0` | patched line for viem→isows (old `ws@8.20.1` DoS advisory); no `ws` server runs here | viem/isows guarantees a patched `ws` |
| `fast-uri ^3.1.4` | dev-only toolchain (ajv→workbox-build→vite-plugin-pwa); patches the 3.1.3 host-confusion advisory | ajv/workbox resolve `fast-uri >= 3.1.4` |
| `undici ^7.28.0` | test-only (jsdom `fetch`); patches two 7.27.2 advisories | jsdom pins `undici >= 7.28.0` |
| `esbuild ^0.28.1` | dev-only toolchain; dedupes onto one audited line | bump with the Vite major |
| `@noble/curves 2.0.1` + `@noble/ciphers 2.1.1` (EXACT) | `ts-mls@1.6.2` declares them as exact peers (KAT cross-checks guard the pin) | `ts-mls` widens its `@noble/*` peer range |

## Reading and editing large files

`docs/SPEC.md` and `docs/planning/00-index.md` (~994 tasks) are large —
`Read` them in chunks (`offset`/`limit`) rather than whole, and read the
region around an edit target first so the `old_string` matches exactly.
Prefer `Edit` over `Write` for existing files.  When parallel or
background agents run, partition files strictly and never delegate a
write for a file the foreground agent may also touch.

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

- **Unreferenced exports (enforced by `check:dead-exports`).**  An exported
  **value** — any binding of a `const`/`let`/`var` declarator list (destructuring
  included), a `function`/`class`/`enum`, a name published by an `export { … }`
  clause, or the binding of an `export * as name from '…'` — that nothing
  references is a gate failure, not a style note: it is compiled, bundled, and read by the next
  person as though it were the way to do the thing.  When one appears, decide
  which of three it is before acting:
    1. an **unwired guarantee** — a doctrine constant, a limit, or a client call
       that SHOULD be consulted somewhere.  Wire it up (the
       implement-the-improvement rule below); the unreferenced symbol is the
       evidence of a missing gate, not the defect.
    2. one of **two spellings of a live value** — make the exported, documented
       one the single source and delete the duplicate literal, never the reverse.
    3. genuinely **vestigial** — delete it.
  Used only inside its own file?  Drop the `export`, keep the symbol —
  `pnpm survey:internal-exports` lists those, and is deliberately NOT in CI while
  the ~969 standing cases are worked through
  (`docs/planning/audit-residuals-2026-07.md`).  An unchanged barrel re-export
  (`export { live } from './x.js'`) is judgeable too — publishing a name is not
  consuming it — but the 254 standing cases are overwhelmingly module barrels
  publishing their SSOT surface, so they are surveyed by
  `pnpm survey:barrel-reexports` and tracked there rather than gated.
  **BOTH SIDES COME FROM THE COMPILER** (`scripts/resolve-export-references.ts`),
  never from parsing: the export list is the module's own export table, and
  references are resolved to the module BINDING rather than matched by name — so
  an unrelated local, parameter or property that happens to share a spelling is
  not a consumer, and no export shape needs a pattern of its own.  The gate
  REFUSES to run if any tracked file falls outside every tsconfig, or if a
  module's export table cannot be read, since either would let it report success
  over code it never judged.  The one thing resolution cannot see is a module fetched by URL at
  runtime (the Playwright `/src` harnesses); those carry a
  `dead-exports-entry: <reason>` comment.
  **`export default` is out of scope**, and not as an exemption: it publishes the
  binding `default`, so the declaration's own name is module-local and every
  importer picks its own — the name is under no obligation to appear anywhere
  else.  Named exports of a DYNAMICALLY imported module ARE in scope: `mod.foo()`
  and `const { foo } = await import(…)` both spell the name.
  **Types are deliberately out of scope.**  A `type`/`interface` is erased at
  build, and nearly every unreferenced one here is a mechanical projection of a
  value that IS live (`z.infer<typeof xSchema>`, `typeof table.$inferSelect`,
  `(typeof CONST)[number]`).  Those are uniform by construction — every table
  having a `Row` type is worth more than pruning the few nothing imports yet.

- **Pino is the ONLY server logging path.**  Redaction is worth exactly
  as much as the share of output that passes through it, so a `console.*`
  write — or a LIBRARY that logs on its behalf — is a hole in it, not a
  style issue.  `@licio/db` therefore always passes `onnotice` to
  postgres.js (whose unset default is `console.log` of the whole notice
  object, `detail`/`internal_query` included) and projects a notice to
  severity/code/message before any consumer sees it.  A dependency that
  logs for you needs the same treatment.

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

- **Merging (ABSOLUTE): MERGE COMMITS ONLY — never squash.**  `gh pr merge <n>
  --merge`.  The PR's individual commits ARE the engineering record: this file
  deliberately keeps per-audit and per-workstream detail in commit messages
  rather than here, so squashing destroys that record and the boundaries
  `git bisect` and a reviewer need between original work, follow-up findings,
  and review-response fixes.  Squash and rebase merging are disabled on the
  repository, so the wrong method fails at the API — but do not reach for a
  workaround: the failure is the policy working.  Do NOT infer the merge style
  from recent history; `CONTRIBUTING.md` is the authority (recent history can be
  a previous agent session's drift, which is exactly how #148–#162 became
  squashed against policy).

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

Defense-in-depth across seven layers, each enforced by BOTH runtime guards
and CI static gates.  The full design (exact CSP/header/cookie strings, the
draft-crypto and signal-privacy mechanics) is owned by `docs/SPEC.md` and
`docs/pwa-client/README.md` — this file keeps only what changes how you
write code here.

| Layer | Mechanism | Enforced by | Key file(s) |
|-------|-----------|-------------|-------------|
| Content | Trusted Types + DOMPurify | CSP `require-trusted-types-for 'script'` | `security/trusted-types.ts` |
| Network | Strict CSP, CORS, HSTS | `security-headers.ts` middleware + `check:csp-parity` | `middleware/security-headers.ts` |
| Session | HttpOnly `__Host-` cookies, serialized CSRF | `csrf.ts` middleware + `api.ts` client | `middleware/csrf.ts`, `lib/api.ts` |
| Data | AES-256-GCM draft encryption (non-extractable key) | `draft-crypto.ts` + zod on every boundary | `offline/draft-crypto.ts` |
| Privacy | assertNoRawEgress + bucketed aggregates only | `check:no-raw-egress` CI gate | `signals/privacy.ts` |
| Resilience | Eviction detection, quarantine, rage-loop dampening | Unit + E2E tests | `offline/eviction.ts`, `signals/return-tracker.ts` |
| Service worker | Same-origin importScripts, TT policy injection | `check:sw` CI gate | `scripts/inject-sw-trusted-types.ts` |

Working rules that follow from it:

- **CSP: ONE definition, three delivery points.**  The directives live in
  `packages/shared/src/security/csp.ts` and nowhere else.  They reach the
  browser three ways — the `apps/api` response header, the `vite preview`
  header, and a `<meta http-equiv>` — and all three derive from that module:
  the two TypeScript consumers import it (the Vite config by RELATIVE path;
  a bare `@licio/shared` specifier is externalised by Vite's config loader,
  which then cannot resolve the package's `.js`-suffixed TS source), and
  `apps/web/index.html` carries NO policy — the `licio:inject-csp-meta`
  plugin injects the meta form at build time.  The meta form is the header
  minus `frame-ancestors`/`report-uri`/`report-to`, which CSP L3 §3.3
  ignores in a meta element.  That `<meta>` is redundant on the web and
  LOAD-BEARING in the native courier WebView (no server headers there), so
  `check:csp-parity` asserts on the BUILT artifact — the one delivery point
  no compiler can check, where a plugin that quietly stops firing would ship
  a courier with no policy at all.  The policy itself has no
  `'unsafe-inline'`/`'unsafe-eval'` and `connect-src 'self'`: the browser
  NEVER talks to a third party; anything external (e.g. the huggingface.co
  model-hub metadata) is proxied through the BFF.
- **Trusted Types**: three named policies (`default`, `dompurify`,
  `licio-ugc`); the default policy validates script URLs by ORIGIN
  comparison, and `licio-ugc`'s `createScriptURL` throws unconditionally.
- **CSRF**: per-session single-use tokens; the web client SERIALIZES
  mutations (each fetches a fresh token).  Exempt paths are session-less
  and individually rate-limited; `/v1/auth/*` + `/v1/privacy/*` are
  token-exempt but still Origin-checked.
- **Identity-free rate limiting (SPEC §19.1)**: the application never reads
  the client network address (enforced by `no-client-address.test.ts`).
  Budgets are per-account, per-target, or global fixed-window — never per-IP.
- **Bot prevention, three layers**: (1) sign-up proof-of-work CAPTCHA
  (`identity/pow-captcha.ts`; `SIGNUP_POW_MAX_NUMBER=0` opts out, warned);
  (2) behavioral-authenticity damping over the already-bucketed aggregates
  (`pwatt/behavior.ts` — never zero, never boosts, no new collection);
  (3) KYC-gated GOVERNANCE participation (`governance/eligibility.ts`,
  fail-closed; `check:governance-kyc` is the structural gate).  Content
  participation is never KYC-gated.
- **Governance LLM egress**: the `local` backend is LOOPBACK-ONLY (enforced
  at env validation AND the pure resolver; `redirect: 'error'` on every
  local fetch); the hosted `anthropic` backend is an explicit, boot-logged
  operator opt-in.  Model-hub reads are metadata-only against the fixed
  huggingface.co host, never room content.

## Linting limitations

Biome 2.x cannot express `noConsole`, `noRestrictedSyntax` (innerHTML /
outerHTML / document.write), or `javascript:` URL blocking — those are
covered by `pnpm lint:security` + `scripts/validate-build.ts`.  Use pino
for server-side logging.

## TypeScript + toolchain notes

- TypeScript 6+ defaults `types` to `[]` — ambient `@types/*` packages must
  be listed per workspace (`"types": ["node"]`); `esModuleInterop` is
  always on and cannot be disabled; `moduleResolution` is `"bundler"`.
- Vite 8 uses Rolldown: `rollupOptions.output.manualChunks` must be a
  FUNCTION (object form removed).  Biome reads Tailwind v4 directives via
  `css.parser.tailwindDirectives: true`.

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

The core specification defines 18 workstreams (WS-0 through WS-Q); WS-T
(conversation as comments) and the cross-cutting **WS-U** (AI-governed-rooms
redesign) extend it, and two **extension workstreams** — WS-R (LCAP v0.2)
and WS-S (Private P2P rooms) — derive from `docs/OFFLINE_SPEC.md` and
`docs/PRIVATE_SPEC.md`.  Both extensions ship WITH the core product, not
deferred: WS-R is P1 (native courier + browser P2P/WebTransport/IPFS), and
**WS-S is LAUNCH-BLOCKING** — its §29 launch gates are part of the GA bar.
WS-U is the maintainer's binding redesign of AI's role (SPEC §16.6/§24.6):
any **governance-eligible member** proposes a member-downloadable AI
**model + prompt** (optionally selecting revision-pinned huggingface.co
models per governed role), the **members** adopt it by Knomosis-ratified
vote, and the **elected steward VALIDATES** — the ratification-opening gate,
the improper-vote cancel, and the post-hoc overrules; the last line of
defence, never the author. The approved **in-room agent** may moderate,
manage the room treasury, and facilitate lawmaking **within
community-voted, kernel-enforced bounds, holding no keys, under a
non-overridable platform legal floor** — it re-scopes WS-K into the
platform eval/transparency substrate and preserves the pay-to-rank
firewall + fail-closed crypto in full
(`docs/planning/22-ai-governed-rooms.md`, `docs/governance/README.md`).
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
| WS-K | AI and model governance | Complete (residuals: `docs/ai-governance/README.md`); **re-scoped by WS-U** into the platform eval/transparency substrate |
| WS-L | Knomosis and wallets | Complete (residuals: `docs/knomosis/README.md`); behind the fail-closed `cryptoEnabled`/`governanceEnabled` flags |
| WS-M | Treasury and governance | Complete (residuals: `docs/treasury/README.md`); behind the fail-closed `cryptoEnabled`/`governanceEnabled` flags |
| WS-N | Compliance | Complete (residuals: `docs/compliance/README.md`); fail-closed with ZERO policies populated until counsel authors them |
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

**Vitest.**  Twelve node/jsdom test projects composed by the root
`vitest.config.ts` from shared settings in `vitest.shared.ts`; each
workspace has a thin local config so `pnpm --filter <ws> test` runs
standalone.  Coverage gate: 80% minimum (lines, functions, branches,
statements).

**Test counts.**  `pnpm test` is the canonical query (≈9200 pass without
the gated integration env; ≈9500 with live Postgres/Redis — the gated env
also drops the skip count from ≈270 to ≈10, the residual being the
`RUN_PERF` benchmarks).  Only monotonic growth is enforced — exact numbers
drift, so the per-suite breakdown lives in each `docs/*/README.md`, not
here.  WS-D/E/F/G/H/I/U and WS-R add **gated** Postgres+Redis integration
suites that run only with `DATABASE_URL`/`REDIS_URL` set (CI provisions
`pgvector/pgvector:pg16` + `redis:7`).  Locally they are provisioned by the
`.claude/hooks/session-start.sh` SessionStart hook (Postgres 16 + the
`vector` extension + Redis on the CI ports); without either service the
suites self-skip, so a bare run proves strictly less than CI does.

**Coverage.**  The 80% gate is only ENFORCED when coverage is actually
enabled — `pnpm test --coverage`, never `pnpm test -- --coverage` (pnpm
forwards the `--` verbatim and vitest drops every flag after it, so the run
looks normal while computing no coverage at all).  Measure it with the gated
services up: the WS-D/E/F/G/H/I/U + WS-R integration suites carry a large
share of the branch coverage, and branches clear the bar by a thin margin
(≈81%) WITH them.

**E2E.**  Playwright over Chromium/Firefox/WebKit with axe-core assertions.
`playwright.config.ts` is the frontend-only suite against the static
preview; `playwright.bff.config.ts` (`pnpm --filter web test:e2e:bff`,
`*.bff.spec.ts`) is the BFF-in-the-loop harness driving REAL authenticated
flows against the in-memory `e2e-server`.  Both run in CI.

**CI.**  `.github/workflows/ci.yml` runs 9 jobs on every PR (lint/format +
static gates, type check, lockfile, dep budget, test & coverage incl.
`check:neutrality` + `check:lcap-scheduler`, build & size, E2E, security
audit, native courier APK).  CodeQL (`codeql.yml`) runs `security-extended`
on push to main, PRs, and weekly.

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

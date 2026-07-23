# WS-0: Repository Foundation and Secure Development Environment

| Field | Value |
|---|---|
| **Milestone** | M0 |
| **Priority** | 0 |
| **Dependencies** | None |
| **Wave** | 1 |
| **Estimated duration** | 2 weeks |

## Overview

WS-0 establishes the monorepo structure, build tooling, code quality gates, security baseline, CI/CD pipeline, and local development environment that every subsequent workstream depends on. No feature code is written until WS-0 is complete. The decisions made here -- strict TypeScript, strict CSP, no inline scripts, pnpm phantom-dependency prevention, Biome security linting, lockfile integrity, and reproducible builds -- define the security posture of the entire application. A UGC platform that connects wallets cannot afford to bolt security on after the fact; it must be the foundation.

This workstream is intentionally exhaustive. Because every other workstream inherits its toolchain, a gap here propagates everywhere: a missing CSP directive, a phantom dependency, an un-redacted log field, or a non-deterministic build becomes a latent vulnerability in 16 downstream workstreams. The tasks below are therefore decomposed to 0.5-2 day atomic units, each independently reviewable, testable, and reversible per Section 30.8, with explicit dependencies, concrete configuration, and security rationale traceable to Section 25.

### Conventions used in this document

- **ID:** every task has a stable, unique identifier. When a task was split during refinement, the original ID is preserved and sub-IDs are appended (e.g., WS-0.5.1 became WS-0.5.1a/WS-0.5.1b); references elsewhere in the plan continue to resolve to the group ID.
- **Ref:** the governing SPEC section(s).
- **Description:** what is built and why it matters for security or correctness.
- **Acceptance criteria:** objective, checkable conditions for "done."
- **Testing:** the concrete commands, fixtures, and assertions that prove the acceptance criteria.
- **Dependencies:** the task IDs that must be merged before this task starts.
- **Security (Section …):** present wherever the spec mandates a security control; states the threat and the defense.

### Task index

| Group | Tasks |
|---|---|
| WS-0.1 Repository hygiene | WS-0.1.1, WS-0.1.2, WS-0.1.3, WS-0.1.4, WS-0.1.5 |
| WS-0.2 Monorepo & package management | WS-0.2.1, WS-0.2.2, WS-0.2.3, WS-0.2.4 |
| WS-0.3 Build tooling & framework init | WS-0.3.1a, WS-0.3.1b, WS-0.3.1c, WS-0.3.2, WS-0.3.3, WS-0.3.4a, WS-0.3.4b, WS-0.3.5, WS-0.3.6, WS-0.3.7, WS-0.3.8, WS-0.3.9, WS-0.3.10, WS-0.3.11 |
| WS-0.4 Code quality & security tooling | WS-0.4.1a, WS-0.4.1b, WS-0.4.1c, WS-0.4.2, WS-0.4.3, WS-0.4.4, WS-0.4.5 |
| WS-0.5 Security baseline | WS-0.5.1a, WS-0.5.1b, WS-0.5.2a, WS-0.5.2b, WS-0.5.3, WS-0.5.4, WS-0.5.5 |
| WS-0.6 CI/CD pipeline | WS-0.6.1a, WS-0.6.1b, WS-0.6.1c, WS-0.6.1d, WS-0.6.1e, WS-0.6.1f, WS-0.6.2, WS-0.6.3 |
| WS-0.7 Development environment | WS-0.7.1, WS-0.7.2, WS-0.7.3 |

---

## WS-0.1 Repository hygiene

### WS-0.1.1 Create .gitignore

**ID:** WS-0.1.1
**Ref:** Section 25.2 (no secrets in client)

**Description:**
Create a comprehensive `.gitignore` at the repository root that prevents secrets, build artifacts, editor state, and ephemeral files from being committed. This is the first line of defense against accidental secret exposure. Because the project handles wallet connections and session tokens, even a single committed `.env` file could compromise user funds or sessions.

**Covered patterns:**
- Build artifacts: `node_modules/`, `dist/`, `build/`, `.cache/`, `.vite/`
- Secrets and environment: `.env`, `.env.local`, `.env.*.local`
- Editor and OS files: `.vscode/`, `.idea/`, `*.swp`, `.DS_Store`, `Thumbs.db`
- Test output: `coverage/`, `test-results/`, `playwright-report/`, `.playwright/`
- TypeScript build info: `*.tsbuildinfo`
- Logs: `*.log`
- Certificates and keys: `*.pem`, `*.key`, `*.p12`, `*.pfx`, `*.crt`
- Database migrations metadata: `drizzle/meta/`
- Docker data volumes: `.docker-data/`
- Supply-chain/build artifacts that must never be committed unsigned: `*.sbom.json`, `*.intoto.jsonl`, `provenance/`

**Allow-list exceptions (negated patterns):**
- `!.env.example` -- the documented, secret-free template must be tracked.
- `!.vscode/extensions.json` and `!.vscode/settings.json` are NOT exempted (kept ignored) to avoid leaking developer-specific paths; shared editor config lives in `.editorconfig` instead.

**Acceptance criteria:**
- `.gitignore` exists at the repository root.
- Running `echo "SECRET=leak" > .env && git add .env` results in the file not being staged.
- Running `mkdir -p node_modules/test && git add node_modules/` results in no files staged.
- `.env.example` IS trackable (negated exception works).
- All patterns listed above are present and correctly formatted.

**Testing:**
- Manual verification: create a test `.env` file and confirm `git status` does not list it after `git add -A`.
- Manual verification: create files matching each pattern category and confirm none are staged.
- Manual verification: create `.env.example` and confirm `git add .env.example` stages it.

**Dependencies:** None (first task in the repository).

**Security (Section 25.2):** Prevents accidental commit of secrets, signing keys, and seed-phrase-adjacent material. A leaked `SESSION_SECRET` or `DATABASE_URL` would allow session forgery or direct data exfiltration; the `*.pem`/`*.key`/`*.p12` patterns prevent committing TLS or KMS material.

---

### WS-0.1.2 Update LICENSE to AGPL-3.0-or-later

**ID:** WS-0.1.2
**Ref:** Section 20.4

**Description:**
Replace the current GPL-3.0 license text with the full AGPL-3.0-or-later license. The current GPL-3.0 does not close the network/SaaS gap: a party could modify the Licio server code and serve it to users without sharing their modifications. AGPL-3.0 closes this gap, which is essential for a project delivered entirely as a web application. AGPL-3.0-or-later is explicitly compatible with GPL-3.0-or-later, preserving compatibility with Knomosis.

Update the `license` field in the root `package.json` to `"AGPL-3.0-or-later"` (SPDX identifier). Add an SPDX license header comment convention to `CLAUDE.md` for new source files (`// SPDX-License-Identifier: AGPL-3.0-or-later`).

**Acceptance criteria:**
- `LICENSE` file contains the full text of the GNU Affero General Public License, Version 3.
- Root `package.json` contains `"license": "AGPL-3.0-or-later"`.
- The SPDX identifier is valid and recognized by standard tooling.
- The SPDX header convention is documented for source files.

**Testing:**
- `grep -q "AGPL" LICENSE` succeeds.
- `jq -r .license package.json` outputs `AGPL-3.0-or-later`.
- Run an SPDX validator (e.g., `npx spdx-expression-parse "AGPL-3.0-or-later"`) and verify it parses.

**Dependencies:** None.

**Security (Section 20.4):** Licensing is part of the trust-and-integrity story: AGPL guarantees that any network-served modification of the bundle or BFF must publish its source, which supports the anti-tampering and provenance posture of Section 20.2 (a modified, malicious deployment cannot legally hide its changes).

---

### WS-0.1.3 Create CLAUDE.md

**ID:** WS-0.1.3
**Ref:** Sections 6.12, 25.2, 6.12.12

**Description:**
Create a project-level Claude Code configuration file at the repository root. This file provides AI-assisted development tools with project context, conventions, and hard constraints. It must accurately reflect the monorepo layout, available commands, coding conventions, and security constraints so that AI-generated code is safe by default.

**Content requirements:**
- Monorepo layout description (apps/web, apps/api, packages/shared, packages/db, packages/invariants)
- Build commands: `pnpm build`, `pnpm --filter web build`, `pnpm --filter api build`
- Test commands: `pnpm test`, `pnpm test:e2e`, `pnpm --filter <workspace> test`
- Lint commands: `pnpm biome check .`, `pnpm typecheck`
- Coding conventions: TypeScript strict mode, no `any`, no `dangerouslySetInnerHTML`, no inline styles, no `eval()`, no `innerHTML`, no `document.write`
- UGC handling: all user-generated content must be sanitized via DOMPurify before rendering
- Security constraints: strict CSP, no inline scripts, no secrets in client bundle, no wallet seed phrases
- Commit message conventions
- Dependency budget: client < 15 direct production dependencies, BFF < 20 direct production dependencies (per Section 6.12.12)
- Import conventions: use workspace aliases (`@licio/shared`, `@licio/db`, `@licio/invariants`)
- SPDX header convention for new source files
- Dependency-addition checklist (maintainer trust, transitive count, install scripts must be none, AGPL compatibility, Web-API alternative) per Section 6.12.12

**Acceptance criteria:**
- `CLAUDE.md` exists at the repository root.
- File contains accurate guidance for all categories listed above.
- Dependency budgets match Section 6.12.12.
- Security constraints match Sections 25.2 and 6.12.11.

**Testing:**
- Manual review: confirm all sections are present and accurate.
- Spot check: verify dependency budget numbers match the spec.
- Spot check: confirm the dependency-addition checklist is present and lists "install scripts must be none."

**Dependencies:** WS-0.1.2 (license string referenced), WS-0.2.1 (monorepo layout must exist to be documented accurately). May be drafted earlier and finalized after WS-0.2.1.

**Security (Section 25.2):** The constraints file is a control surface for AI-assisted code: by enumerating the forbidden patterns (`eval`, `innerHTML`, `dangerouslySetInnerHTML`, secrets in client) it reduces the probability that generated code introduces an XSS or secret-exposure vector that would later have to be caught by lint/CI.

---

### WS-0.1.4 Editor and commit hygiene configuration

**ID:** WS-0.1.4
**Ref:** Section 6.12.10

**Description:**
Add `.editorconfig` and `.gitattributes` to enforce consistent file encoding, line endings, and whitespace across operating systems and editors, independent of Biome. Cross-OS line-ending drift (CRLF vs LF) corrupts content hashes and breaks reproducible builds (Section 20.2); normalizing it at the VCS layer is a prerequisite for deterministic output. Add a `.nvmrc` (or `.node-version`) pinning the Node.js LTS major version so every contributor and CI runner uses the same runtime.

**Files to create:**
- `.editorconfig` -- `root = true`; UTF-8; LF line endings; final newline; trim trailing whitespace; 2-space indent for `*.{ts,tsx,js,jsx,json,css,yml,yaml}`; tab width 2.
- `.gitattributes` -- `* text=auto eol=lf`; mark binary assets (`*.png`, `*.woff2`, `*.ico`) as `binary`; mark `pnpm-lock.yaml` as `-diff linguist-generated` to keep diffs readable.
- `.nvmrc` -- the pinned Node.js LTS major (e.g., `22`).

**Acceptance criteria:**
- `.editorconfig`, `.gitattributes`, and `.nvmrc` exist at the repository root.
- A file authored with CRLF is normalized to LF on commit (`git add` then `git diff --cached` shows LF).
- `node --version` matches the `.nvmrc` major when using a version manager.
- Binary assets are not line-ending-normalized.

**Testing:**
- Create a file with CRLF endings; `git add` it; run `git ls-files --eol`; verify the working/index eol is `lf`.
- Run `nvm use` (or `fnm use`); verify it selects the pinned version.
- Verify `pnpm-lock.yaml` is marked generated (collapsed in diffs).

**Dependencies:** WS-0.1.1.

**Security (Section 20.2):** Deterministic line endings and a pinned runtime are preconditions for reproducible builds; without them, identical source can produce different byte output and different content hashes, defeating Subresource Integrity and provenance verification.

---

### WS-0.1.5 Contribution and security policy documents

**ID:** WS-0.1.5
**Ref:** Sections 25.1, 25.4, 20.4

**Description:**
Add the standard repository governance documents that the security and supply-chain posture depends on: a `SECURITY.md` describing how to report vulnerabilities (private disclosure channel, expected response time, scope), a `CODE_OF_CONDUCT.md`, and a `CONTRIBUTING.md` that codifies the branch/PR workflow, the requirement that every PR passes the full CI gate, and the dependency-addition review process. These are lightweight but load-bearing: a published, monitored security contact is part of the OWASP/NIST baseline in Section 25.1, and a documented contribution process keeps the dependency budget and security gates from being bypassed.

**Files to create:**
- `SECURITY.md` -- private vulnerability-disclosure instructions (e.g., security contact email), supported versions, coordinated-disclosure window, explicit mention that wallet/financial exploits follow the incident-communications plan (Section 25.6, owned by WS-O).
- `CODE_OF_CONDUCT.md` -- standard contributor covenant.
- `CONTRIBUTING.md` -- branch naming, PR requirements (CI green, review required), dependency-addition checklist reference (Section 6.12.12), commit-message convention, AGPL header requirement.

**Acceptance criteria:**
- All three files exist at the repository root.
- `SECURITY.md` names a private reporting channel and a response-time commitment.
- `CONTRIBUTING.md` states that no PR merges with a failing CI gate and references the dependency budget.
- GitHub surfaces `SECURITY.md` in the repository "Security" tab.

**Testing:**
- Manual review of each document for completeness against the requirements above.
- Verify GitHub renders the security policy (the file is at a recognized path).

**Dependencies:** WS-0.1.3.

**Security (Section 25.1, 25.4):** A documented, monitored disclosure path is an explicit OWASP ASVS / NIST CSF governance control; without it, externally discovered vulnerabilities have no safe channel and risk public zero-day disclosure. The contribution policy enforces that the CI security gates cannot be merged around.

---

## WS-0.2 Monorepo structure and package management

### WS-0.2.1 Initialize pnpm workspace

**ID:** WS-0.2.1
**Ref:** Section 6.12.2

**Description:**
Initialize the pnpm monorepo workspace with the directory structure specified in the spec. pnpm is chosen specifically for its strict dependency resolution: a package cannot import a transitive dependency it did not explicitly declare (phantom dependencies), closing a supply-chain attack vector that npm and Yarn classic leave open.

**Directory structure:**
```
licio/
├── apps/
│   ├── web/                 # React 19 PWA (Vite 8)
│   │   ├── src/
│   │   ├── public/
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   └── vite.config.ts
│   └── api/                 # Hono BFF server
│       ├── src/
│       ├── package.json
│       └── tsconfig.json
├── packages/
│   ├── shared/              # Shared zod schemas, types, constants, enums
│   │   ├── src/
│   │   ├── package.json
│   │   └── tsconfig.json
│   ├── db/                  # Drizzle schema and migrations
│   │   ├── src/
│   │   ├── package.json
│   │   └── tsconfig.json
│   └── invariants/          # Invariant computation modules
│       ├── src/
│       ├── package.json
│       └── tsconfig.json
├── docs/
├── scripts/                 # Build validation, SRI, bundle-size, dep-budget scripts
├── .github/workflows/
├── biome.json
├── pnpm-workspace.yaml
├── tsconfig.base.json
├── package.json
└── .npmrc
```

**Root `package.json`:** `"private": true`, `"license": "AGPL-3.0-or-later"`, `"packageManager": "pnpm@<pinned-version>"` (so Corepack enforces the exact pnpm version), `"engines": { "node": ">=22", "pnpm": ">=9" }`, and workspace scripts for dev, build, test, lint, typecheck.

**`pnpm-workspace.yaml`:**
```yaml
packages:
  - "apps/*"
  - "packages/*"
```

**`.npmrc`:**
```ini
strict-peer-dependencies=true
auto-install-peers=false
shamefully-hoist=false
# Supply-chain hardening:
resolution-mode=highest
prefer-frozen-lockfile=true
# Block lifecycle scripts by default; allow-list specific packages only after review:
enable-pre-post-scripts=false
```

These `.npmrc` settings enforce strict peer dependency resolution and prevent hoisting, ensuring each workspace's dependency boundaries are respected. `enable-pre-post-scripts=false` and the install-script posture (combined with the CI install-script check in WS-0.6.1e) reduce the install-script supply-chain attack surface; CI installs use `--frozen-lockfile` (and, where supported, `--ignore-scripts`) so a poisoned postinstall cannot execute on the runner.

Each workspace `package.json` must declare its own dependencies explicitly. Workspace packages use the `workspace:*` protocol for internal references (e.g., `"@licio/shared": "workspace:*"`).

**Acceptance criteria:**
- `pnpm install` succeeds from the repository root with zero errors.
- Each workspace resolves independently (no phantom dependencies).
- An import of an undeclared transitive dependency fails at build time.
- `pnpm-workspace.yaml` lists `apps/*` and `packages/*`.
- `.npmrc` contains all strict settings including `strict-peer-dependencies=true`, `auto-install-peers=false`, `shamefully-hoist=false`.
- Root `package.json` has `"private": true`, correct license, and a pinned `packageManager` field.
- Corepack (or the pinned `packageManager`) enforces the declared pnpm version.

**Testing:**
- Run `pnpm install` and verify exit code 0.
- Create a test file in `apps/web/` that imports a package only declared in `apps/api/`; verify the import fails to type-check and to build (phantom-dependency prevention).
- Verify `pnpm ls --depth 0` shows expected workspace packages.
- Run `pnpm install --frozen-lockfile` and verify it succeeds against the committed lockfile.
- Temporarily mismatch the local pnpm version; verify Corepack refuses to run with the wrong version.

**Dependencies:** WS-0.1.1 (`.gitignore` must exist so `node_modules/` is not committed by the first install), WS-0.1.2 (license string).

**Security (Section 6.12.2):** pnpm strict resolution is the primary defense against phantom-dependency supply-chain attacks; `auto-install-peers=false` prevents silent introduction of unreviewed peer packages; the pinned `packageManager` prevents a malicious or buggy pnpm version from being used in CI or locally; `enable-pre-post-scripts=false` shrinks the install-script attack surface.

---

### WS-0.2.2 Configure TypeScript strict mode

**ID:** WS-0.2.2
**Ref:** Section 6.12.2

**Description:**
Create `tsconfig.base.json` at the repository root with strict TypeScript configuration. Strict mode catches null-safety violations, type-coercion bugs, and unchecked property access at compile time. This is non-negotiable for a security-critical application that handles wallet connections and user-generated content.

**`tsconfig.base.json` compiler options:**
```jsonc
{
  "compilerOptions": {
    "strict": true,                          // all strict type-checking options
    "noUncheckedIndexedAccess": true,        // arr[i] / obj[k] is T | undefined
    "exactOptionalPropertyTypes": true,      // distinguishes `undefined` from missing
    "noImplicitOverride": true,              // explicit `override` keyword required
    "noFallthroughCasesInSwitch": true,      // prevent accidental case fallthrough
    "noPropertyAccessFromIndexSignature": true,
    "noUncheckedSideEffectImports": true,
    "noEmit": true,                          // type checking only; Vite/tsx compile
    "esModuleInterop": true,                 // correct CJS/ESM interop
    "moduleResolution": "bundler",           // matches Vite resolution
    "module": "ESNext",                      // modern ES module output
    "target": "ES2022",                      // matches browser support targets
    "lib": ["ES2022"],                       // base; workspaces add DOM as needed
    "skipLibCheck": true,                    // skip .d.ts checking for build speed
    "forceConsistentCasingInFileNames": true,// prevent case-sensitivity bugs across OS
    "isolatedModules": true,                 // required for esbuild transform
    "verbatimModuleSyntax": true,            // explicit type-only imports/exports
    "resolveJsonModule": true,               // allow importing JSON
    "declaration": true,                     // emit .d.ts for packages
    "declarationMap": true,                  // source maps for declarations
    "sourceMap": true                        // source maps for debugging
  }
}
```

The additions beyond the spec minimum (`noImplicitOverride`, `noFallthroughCasesInSwitch`, `noPropertyAccessFromIndexSignature`, `verbatimModuleSyntax`, `noUncheckedSideEffectImports`) each close a class of subtle bug or import-side-effect ambiguity and cost nothing in a greenfield codebase.

**Workspace-specific configurations:**
- `apps/web/tsconfig.json`: extends base, includes `src/**/*`, adds path aliases for `@licio/*` packages, sets `lib: ["ES2022", "DOM", "DOM.Iterable"]`, `jsx: "react-jsx"`.
- `apps/api/tsconfig.json`: extends base, includes `src/**/*`, omits DOM libs (`lib: ["ES2022"]`), adds `"types": ["node"]`, sets `module: "ESNext"` and `moduleResolution: "bundler"`.
- `packages/shared/tsconfig.json`: extends base, includes `src/**/*`, no DOM libs needed.
- `packages/db/tsconfig.json`: extends base, includes `src/**/*`, adds `"types": ["node"]`.
- `packages/invariants/tsconfig.json`: extends base, includes `src/**/*`.
- A root `tsconfig.json` with `"references"` to each workspace enables project-reference builds and a single `tsc -b` entry point.

**Acceptance criteria:**
- `tsconfig.base.json` exists at the repository root with all specified options.
- Each workspace has a `tsconfig.json` that extends the base.
- `pnpm tsc --noEmit` (or `tsc -b`) passes across all workspaces with zero errors.
- `apps/api/tsconfig.json` does not include DOM libs.
- A file with an unchecked index access produces a type error.
- `verbatimModuleSyntax` forces type-only imports to be written as `import type`.

**Testing:**
- Run `pnpm typecheck` from the root and verify zero errors.
- Create a test file with `const arr: string[] = []; const x: string = arr[0];` and verify it produces a type error (due to `noUncheckedIndexedAccess`).
- Create a test file in `apps/api/` that references `document` and verify it produces a type error (DOM libs not included).
- Create a value import used only as a type and verify `verbatimModuleSyntax` flags it.

**Dependencies:** WS-0.2.1.

**Security (Section 6.12.2):** Strict typing eliminates entire classes of data-handling bugs (null dereference, shape mismatch, type confusion) that in weaker stacks become runtime vulnerabilities; `noUncheckedIndexedAccess` in particular prevents `undefined`-as-data bugs at trust boundaries where user input is indexed.

---

### WS-0.2.3 Configure workspace dependency boundaries

**ID:** WS-0.2.3
**Ref:** Sections 6.12.2, 6.12.12

**Description:**
Establish and enforce dependency boundaries between workspace packages to maintain a clean architecture. The dependency graph must be a DAG with no cycles. Packages in `packages/` must never import from `apps/`. The `packages/db` package must not import from `apps/` or from `packages/invariants`. The `packages/shared` package must have no internal workspace dependencies. These boundaries prevent coupling that would make the codebase harder to test, reason about, and secure.

**Dependency rules:**
- `packages/shared` -- no workspace dependencies (leaf package)
- `packages/db` -- may depend on `@licio/shared` only
- `packages/invariants` -- may depend on `@licio/shared` only
- `apps/web` -- may depend on `@licio/shared`, `@licio/invariants`
- `apps/api` -- may depend on `@licio/shared`, `@licio/db`, `@licio/invariants`

Note the critical client-isolation rule: `apps/web` must NOT depend on `@licio/db`. Database schema, connection strings, and SQL must never reach the client bundle. This is the build-time enforcement of the client-server boundary from Section 6.12.1.

**Implementation:**
- Document dependency rules in `CLAUDE.md`.
- Configure TypeScript path aliases so that only permitted dependencies are resolvable per workspace.
- Add a CI check (`scripts/check-workspace-deps.ts`) that parses each workspace `package.json` plus its imports and verifies no workspace package imports from a disallowed workspace. The script reads the dependency allow-list table above as data and fails with a clear message naming the offending import.

**Acceptance criteria:**
- Dependency rules are documented in `CLAUDE.md`.
- TypeScript path aliases in each workspace's `tsconfig.json` only reference permitted dependencies.
- A test import from `packages/db` to `apps/web` fails at build time.
- A test import from `packages/shared` to `@licio/db` fails at build time.
- A test import from `apps/web` to `@licio/db` fails the boundary check.
- CI check verifies dependency boundaries on every PR.

**Testing:**
- Create a test file in `packages/db/src/` that imports from `apps/web/`; verify it fails.
- Create a test file in `packages/shared/src/` that imports from `@licio/db`; verify it fails.
- Create a test file in `apps/web/src/` that imports from `@licio/db`; verify the boundary script fails.
- Run the dependency boundary check script and verify it passes on a clean workspace.

**Dependencies:** WS-0.2.1, WS-0.2.2.

**Security (Section 6.12.2, 6.12.12):** Enforcing that `apps/web` cannot import `@licio/db` is a hard, build-time guarantee that database credentials and query construction never enter the browser bundle -- a structural defense against the "secrets in the client" failure mode of Section 25.2. The acyclic boundary also keeps the dependency budget auditable per package.

---

### WS-0.2.4 Dependency-budget enforcement check

**ID:** WS-0.2.4
**Ref:** Section 6.12.12

**Description:**
The spec mandates a hard dependency budget -- the client bundle targets fewer than **15 direct production dependencies** and the BFF fewer than **20** -- but a budget that is not mechanically enforced will silently erode. Create `scripts/check-dep-budget.ts` that reads `apps/web/package.json` and `apps/api/package.json`, counts the entries in `dependencies` (production only, excluding `devDependencies` and `workspace:*` internal references), and fails if either exceeds its budget. Wire it into CI (WS-0.6.1b) and as a root script (`pnpm check:deps`).

**Counting rules:**
- Count only `dependencies` (not `devDependencies`, `peerDependencies`, or `optionalDependencies`).
- Exclude `workspace:*` internal packages (`@licio/*`) from the count -- they are first-party, not supply-chain surface.
- Budgets: `apps/web` < 15; `apps/api` < 20.
- The script prints the current count and the remaining headroom for each app, so reviewers see the budget pressure in CI logs.

**Acceptance criteria:**
- `scripts/check-dep-budget.ts` exists and is runnable via `pnpm check:deps`.
- The check passes on the WS-0 baseline (which is well under budget).
- Adding a 15th production dependency to `apps/web` fails the check with a clear message.
- `workspace:*` references are excluded from the count.
- The check is part of the CI lint/typecheck job (WS-0.6.1b).

**Testing:**
- Run `pnpm check:deps` on the baseline; verify it passes and prints counts.
- Temporarily add dummy production deps to push `apps/web` to 15; verify the check fails and names the budget.
- Add a `workspace:*` dependency; verify it does NOT count toward the budget.

**Dependencies:** WS-0.2.1, WS-0.3.2 (web app exists), WS-0.3.3 (api app exists). Practically lands after the apps are scaffolded but is grouped here because it governs package management.

**Security (Section 6.12.12):** Each direct production dependency is supply-chain surface (maintainers to trust, transitive packages to audit, install-script risk). Mechanical budget enforcement makes every addition a visible, reviewed decision rather than an accreting liability, directly implementing the Section 6.12.12 control.

---

## WS-0.3 Build tooling and framework initialization

### WS-0.3.1a Vite 8 base configuration

**ID:** WS-0.3.1a
**Ref:** Section 6.12.2

**Description:**
Install Vite 8 in `apps/web/` and create the base `vite.config.ts`. Vite is chosen over Next.js, Webpack, and other bundlers for specific security reasons: it produces no inline scripts (enabling strict CSP without `'unsafe-inline'`), has a small auditable dependency tree (an order of magnitude smaller than Next.js), and produces deterministic content-hashed output suitable for reproducible builds and SRI.

**Configuration requirements (`apps/web/vite.config.ts`):**
```ts
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  base: '/',
  plugins: [react()],
  build: {
    target: 'es2022',
    sourcemap: false,            // no source maps in production
    cssCodeSplit: true,
    rollupOptions: {
      output: {
        // deterministic, content-hashed filenames for cache-busting + SRI
        entryFileNames: 'assets/[name]-[hash].js',
        chunkFileNames: 'assets/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash][extname]',
        // Vite 8 / Rolldown: manualChunks must be a function (object form removed)
        manualChunks: (id) =>
          /[\\/]node_modules[\\/](react|react-dom)[\\/]/.test(id) ? 'react' : undefined,
      },
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': { target: 'http://localhost:3001', changeOrigin: true },
    },
  },
});
```

- `@vitejs/plugin-react` for the React JSX transform.
- Route-level code splitting via dynamic imports (configured per-route in WS-C).
- Content-hashed output filenames for cache busting and SRI compatibility.
- `base: '/'` for PWA routing.
- No source maps in production builds (`build.sourcemap: false`) -- avoids shipping readable source and internal paths.
- `build.target: 'es2022'` matching the TypeScript target.
- `build.cssCodeSplit: true` for optimal CSS loading.
- Rollup `manualChunks` for vendor splitting.
- Dev server: port, HMR, proxy `/api` to the BFF (so the browser sees a same-origin API in development, matching the `connect-src 'self'` CSP).

**Acceptance criteria:**
- `apps/web/vite.config.ts` exists with all specified configuration.
- `pnpm --filter web dev` starts the dev server with HMR functional.
- `pnpm --filter web build` produces output in `apps/web/dist/`.
- Output filenames contain content hashes (e.g., `assets/index-[hash].js`).
- Dev server proxies `/api` requests to the BFF.
- Production build emits no source maps.

**Testing:**
- Run `pnpm --filter web dev` and verify the server starts on port 5173.
- Run `pnpm --filter web build` and verify output files have content hashes.
- Verify the Vite config contains `@vitejs/plugin-react`.
- Verify `apps/web/dist/` contains no `*.map` files after a production build.

**Dependencies:** WS-0.2.1, WS-0.2.2.

**Security (Section 6.12.2, 25.2):** Vite's clean, inline-script-free output is what makes `script-src 'self'` (no `'unsafe-inline'`) viable; content-hashed deterministic filenames are the substrate for SRI and reproducible builds (Section 20.2). Disabling production source maps avoids leaking source structure to attackers probing the bundle.

---

### WS-0.3.1b Vite 8 production build validation

**ID:** WS-0.3.1b
**Ref:** Sections 6.12.2, 20.2, 25.2

**Description:**
Validate that the Vite 8 production build meets the security requirements for strict CSP and supply-chain integrity. This is a critical security gate: a single inline script in the build output would require `'unsafe-inline'` in the CSP, which would undermine the entire XSS defense strategy for a platform that connects wallets.

**Validation requirements:**
- Zero inline `<script>` blocks in the built `index.html` -- verify with a build script that parses the HTML and fails if any `<script>` tag lacks a `src` attribute.
- Zero inline `<style>` blocks and zero inline `style=` attributes injected at build time in the built `index.html`.
- Zero inline event-handler attributes (`onclick`, `onload`, etc.) in the built HTML.
- Bundle size tracking: record the total JS and CSS sizes, set initial budgets (JS < 200KB gzipped initial load, CSS < 50KB gzipped).
- Build output inventory: list all emitted files with sizes and SHA-384 hashes.

**Implementation:**
- Create `scripts/validate-build.ts` that parses the built `index.html` (using a real HTML parser, not a regex) and asserts: zero `<script>` without `src`, zero `<style>`, zero inline `style=`/`on*=` attributes. Exit non-zero with the offending snippet on failure.
- Add it as a `postbuild` step in `apps/web/package.json` (`"postbuild": "tsx ../../scripts/validate-build.ts"`).

(SRI manifest generation and bundle-size gating are split into WS-0.3.1c so each is independently testable.)

**Acceptance criteria:**
- `pnpm --filter web build` followed by the validation script succeeds with zero inline scripts/styles/handlers.
- A build that introduces an inline script fails the validation step.
- A build that introduces an inline `style=` attribute fails the validation step.
- The validation runs automatically as `postbuild`.

**Testing:**
- Run the full build and validation pipeline; verify exit code 0.
- Manually add an inline `<script>alert('test')</script>` to the `index.html` template; verify the validation script fails and prints the snippet.
- Manually add `<div style="color:red">`; verify the validation fails.
- Manually add `<img onerror="...">`; verify the validation fails.

**Dependencies:** WS-0.3.1a, WS-0.3.2 (a real `index.html` and React entry must exist to validate).

**Security (Section 25.2, 20.2):** This is the automated CSP-compliance gate. Because `script-src 'self'` and `require-trusted-types-for 'script'` forbid inline execution, any inline `<script>`, `style`, or `on*` handler that slipped into the build would either break the app under CSP or force an `'unsafe-inline'` regression that re-opens the XSS-to-wallet-drain path. Failing the build closed is the only safe behavior.

---

### WS-0.3.1c SRI manifest and bundle-size gating scripts

**ID:** WS-0.3.1c
**Ref:** Sections 20.2, 6.10, 6.12.12

**Description:**
Produce the supply-chain and performance artifacts that the build-integrity story (Section 20.2) and the performance budgets (Section 6.10) require, split from the inline-script validation so each is independently reviewable. Generate a Subresource Integrity manifest of SHA-384 digests for every emitted JS/CSS asset, and a bundle-size report compared against budgets that fails the build when exceeded.

**Implementation:**
- `scripts/generate-sri.ts` -- compute `sha384-<base64>` digests for all emitted JS/CSS assets and write an integrity manifest (`apps/web/dist/sri-manifest.json`) plus, where applicable, inject `integrity` attributes for first-party assets referenced from `index.html`. This is the local-asset SRI scaffolding; third-party-asset SRI (none expected by default) follows the same path.
- `scripts/check-bundle-size.ts` -- read the Rollup/Vite build manifest, compute gzipped sizes for the initial-load JS and total CSS, compare against budgets (initial JS < 200KB gzip; CSS < 50KB gzip; largest single chunk tracked and reported), and exit non-zero on breach. Emit a machine-readable `bundle-size.json` for the CI PR comment (WS-0.6.1c).
- Add both as `postbuild` steps after `validate-build.ts`.

**Acceptance criteria:**
- An SRI integrity manifest (`sri-manifest.json`) is generated for all emitted assets, each entry a valid `sha384-` digest.
- A bundle-size report (`bundle-size.json`) is generated and compared against budgets.
- A build that exceeds the JS or CSS budget fails the size check.
- The largest chunk size is reported even when within budget.

**Testing:**
- Run the build; verify `sri-manifest.json` exists and every value matches `^sha384-[A-Za-z0-9+/=]+$`.
- Independently recompute one asset's SHA-384 and confirm it equals the manifest entry.
- Add a large dependency to inflate initial JS past 200KB gzip; verify the size check fails.
- Verify `bundle-size.json` is emitted and parseable.

**Dependencies:** WS-0.3.1a, WS-0.3.1b.

**Security (Section 20.2):** The SRI manifest lets the integrity story detect asset tampering: if a served asset's bytes differ from the signed manifest, integrity verification fails. Bundle-size gating is both a performance gate (Section 6.10) and a supply-chain canary -- an unexpected size jump can indicate an injected or bloated dependency that warrants review.

---

### WS-0.3.2 Initialize React 19

**ID:** WS-0.3.2
**Ref:** Section 6.12.3

**Description:**
Install React 19 and ReactDOM 19 in `apps/web/`. React is chosen for its JSX auto-escaping (the strongest built-in XSS defense of any major UI framework), Trusted Types compatibility, and mature accessibility primitives. Create the minimal application entry point.

**Files to create:**
- `apps/web/src/main.tsx` -- application entry point using `createRoot`, importing the Tailwind CSS entry and (later) the Trusted Types policy bootstrap (WS-0.5.4).
- `apps/web/src/App.tsx` -- placeholder root component.
- `apps/web/index.html` -- minimal HTML shell referencing `src/main.tsx` via `<script type="module" src="/src/main.tsx">`.

The `index.html` must contain no inline scripts, no inline styles, and a minimal DOM structure: `<!DOCTYPE html>`, `<html lang="en">`, proper `<head>` with charset, viewport meta (`width=device-width, initial-scale=1, viewport-fit=cover` for mobile-first thumb-zone layout), and `theme-color` meta, and a single `<div id="root">` in the body. The module entry `<script>` carries a `src` and is the only script tag.

**Acceptance criteria:**
- React 19 and ReactDOM 19 are installed in `apps/web/`.
- `pnpm --filter web dev` renders a React component in the browser.
- `pnpm --filter web build` produces working production output.
- `index.html` contains no inline scripts or styles.
- TypeScript compilation succeeds with strict mode.

**Testing:**
- Start the dev server and verify a React component renders.
- Build for production and serve the output; verify it renders.
- Verify `index.html` has no `<script>` tags without `src` attributes (the module entry point is the only script tag and has a `src`).

**Dependencies:** WS-0.3.1a.

**Security (Section 6.12.3, 25.2):** React JSX auto-escaping is the default XSS defense; rendering raw HTML requires an explicit, reviewable `dangerouslySetInnerHTML` (blocked by Biome in WS-0.4.1b). A clean inline-script-free `index.html` is what keeps `script-src 'self'` enforceable.

---

### WS-0.3.3 Initialize Hono BFF

**ID:** WS-0.3.3
**Ref:** Section 6.12.8

**Description:**
Install Hono in `apps/api/` and create the BFF application skeleton. Hono is chosen for its ultra-lightweight footprint (~14 KB), built-in security middleware, and Hono RPC for end-to-end type-safe client-server communication. The BFF is the security-critical gateway between the PWA and internal services.

**Files to create:**
- `apps/api/src/app.ts` -- Hono application factory (`createApp()` returns a configured Hono instance, exported for testability).
- `apps/api/src/index.ts` -- application entry point (starts the server; validates env via WS-0.5.3 before binding the port).
- `apps/api/src/routes/health.ts` -- health-check route `GET /health` returning `{ status: "ok", timestamp: ISO8601 }`.

**Configuration:**
- Dev script using `tsx watch` for hot reloading.
- Build targeting Node.js LTS (ESM output).
- Port configurable via environment variable with a sensible default (e.g., `PORT=3001`).
- Application factory pattern so tests can create isolated app instances.
- Export the app's route types for Hono RPC consumption by `apps/web` (the type-safe contract; the client import lands in WS-C).

**Acceptance criteria:**
- `pnpm --filter api dev` starts the server and responds `200` on `GET /health`.
- `pnpm --filter api build` produces runnable Node.js output.
- The health endpoint returns valid JSON with `status` and `timestamp` fields.
- The application factory is exported from `app.ts` for test use.
- TypeScript compilation succeeds with strict mode (no DOM libs).

**Testing:**
- Start the dev server and `curl http://localhost:3001/health`; verify 200 response.
- Build and run the production output; verify health endpoint responds.
- Write a unit test that creates an app instance via the factory and tests the health route (using Hono's test client, no live socket).

**Dependencies:** WS-0.2.1, WS-0.2.2.

**Security (Section 6.12.8):** The BFF is the single security boundary between the PWA and internal services; the factory pattern enables isolated security tests (CSP headers, CORS, CSRF) without a live socket. The health route is deliberately trivial and exempt from CSRF (WS-0.5.2b) so liveness checks never require state-changing tokens.

---

### WS-0.3.4a Tailwind CSS 4 installation with CSS-first configuration

**ID:** WS-0.3.4a
**Ref:** Section 6.12.6

**Description:**
Install Tailwind CSS 4 in `apps/web/`. Tailwind v4 uses CSS-first configuration, replacing the JavaScript `tailwind.config.js` with native CSS directives. This is a significant change from v3: the entry point uses `@import "tailwindcss"` (NOT the legacy `@tailwind base/components/utilities` directives). Tailwind compiles entirely to static CSS at build time, producing zero JavaScript runtime for styling. This eliminates the `'unsafe-inline'` CSP requirement that CSS-in-JS libraries impose.

**Base CSS file (`apps/web/src/styles/app.css`):**
```css
@import "tailwindcss";
```

Wire Tailwind into Vite via the official `@tailwindcss/vite` plugin in `vite.config.ts` (Tailwind v4's first-class Vite integration), so no PostCSS config file is needed.

**Tailwind v4 CSS-first configuration:** All customization is done via CSS using `@theme` directives and CSS custom properties, not a JavaScript config file. Custom theme values, colors, spacing, fonts, and breakpoints are defined in CSS.

**Acceptance criteria:**
- Tailwind CSS 4 is installed in `apps/web/`.
- `apps/web/src/styles/app.css` uses the `@import "tailwindcss"` syntax (NOT `@tailwind` directives).
- No `tailwind.config.js` or `tailwind.config.ts` file exists (v4 uses CSS-first config).
- Tailwind utility classes render correctly in the dev server.
- Production CSS is a static file with zero JavaScript runtime injection.
- Production build contains no `<style>` tags injected by JavaScript.

**Testing:**
- Add a Tailwind class (e.g., `className="text-blue-500 p-4"`) to the placeholder App component; verify it renders with correct styles.
- Run the production build; verify the emitted CSS is a static `.css` file, not injected by JS.
- Verify no `tailwind.config.js` exists in the workspace.
- Grep the built JS bundle for runtime style injection (`insertRule`, dynamic `<style>` creation) attributable to styling; verify none.

**Dependencies:** WS-0.3.1a, WS-0.3.2.

**Security (Section 6.12.6, 25.2):** Static CSS output means no runtime `<style>` injection and therefore no `'unsafe-inline'` in `style-src` -- a CSS-in-JS library would force that regression and widen the injection surface. Tailwind's zero-runtime model keeps `style-src 'self'` enforceable.

---

### WS-0.3.4b Design token CSS custom properties and dark mode setup

**ID:** WS-0.3.4b
**Ref:** Sections 6.12.6, 26.2

**Description:**
Define the design token system using CSS custom properties (Tailwind v4's CSS-first approach) and configure dark mode with `prefers-color-scheme` support. The design tokens establish a consistent visual language across the application and support high-contrast and reduced-motion accessibility modes. (This is the WS-0 scaffolding; the full design system is WS-B.)

**Design tokens to define (in `apps/web/src/styles/app.css` using `@theme`):**
- Color palette: primary, secondary, accent, surface, background, text, border, error, warning, success, info
- Dark mode variants of all colors using `@variant dark` and `prefers-color-scheme: dark`
- Spacing scale (consistent with Tailwind defaults, extended as needed)
- Typography scale: font families (system stack), font sizes, line heights, letter spacing
- Border radius scale
- Shadow scale
- Z-index scale (named layers: base, dropdown, modal, toast, overlay)
- Transition/animation durations (respecting `prefers-reduced-motion`)
- Focus ring styles for keyboard navigation (visible, high-contrast)

**Accessibility support:**
- `@media (prefers-reduced-motion: reduce)` -- disable animations and transitions
- `@media (prefers-contrast: more)` -- increase contrast ratios
- Focus-visible ring with sufficient contrast in both light and dark modes

**Acceptance criteria:**
- Design tokens are defined as CSS custom properties via Tailwind v4's `@theme`.
- Dark mode toggles correctly via `prefers-color-scheme` media query.
- Reduced-motion media query disables animations.
- High-contrast media query increases contrast.
- Focus ring is visible in both light and dark modes with sufficient contrast.
- All color combinations meet WCAG 2.2 AA contrast ratios (4.5:1 for text, 3:1 for large text/UI).

**Testing:**
- Visual verification: toggle dark mode in browser dev tools; verify colors switch.
- Visual verification: enable reduced motion; verify animations are disabled.
- Run a contrast ratio check on primary text/background combinations.
- Verify focus rings are visible on interactive elements.

**Dependencies:** WS-0.3.4a.

**Security (Section 26.2):** Not a security control per se, but the system-stack font choice avoids loading third-party font origins (consistent with `font-src 'self'`), and visible focus rings support the keyboard-navigation accessibility gate that is a release requirement at every milestone.

---

### WS-0.3.5 Set up shared package with zod

**ID:** WS-0.3.5
**Ref:** Sections 6.12.7, 6.12.9

**Description:**
Initialize `packages/shared/` as the leaf package containing zod schemas, TypeScript types, constants, and enums shared across all apps and packages. Zod provides runtime schema validation at every system boundary, catching malformed or injected payloads. The shared package ensures type contracts between the client, BFF, and database layers cannot silently diverge.

**Files to create:**
- `packages/shared/src/index.ts` -- barrel export
- `packages/shared/src/schemas/index.ts` -- placeholder schema exports
- `packages/shared/src/types/index.ts` -- placeholder type exports
- `packages/shared/src/constants/index.ts` -- placeholder constants
- `packages/shared/src/enums/index.ts` -- placeholder enums
- `packages/shared/package.json` -- name `@licio/shared`, `"private": true`, exports configuration

**Package configuration:**
- `"name": "@licio/shared"`
- `"private": true`
- Proper `"exports"` field for ESM
- `"types"` field pointing to source for development (TypeScript project references)
- No external dependencies beyond `zod`

**Acceptance criteria:**
- `packages/shared/` is initialized with the specified structure.
- `zod` is installed as a dependency.
- Both `apps/web` and `apps/api` can import from `@licio/shared`.
- TypeScript project references resolve correctly.
- `pnpm tsc --noEmit` passes.

**Testing:**
- Create a simple zod schema in `packages/shared/src/schemas/`; import it in both apps; verify type checking passes.
- Verify the package has no workspace dependencies (it is a leaf).

**Dependencies:** WS-0.2.1, WS-0.2.2, WS-0.2.3.

**Security (Section 6.12.7):** Co-locating zod schemas with their TypeScript types in a shared leaf package is what makes runtime validation at every boundary possible without contract drift; this is the single source of truth that `zod.parse()` calls at the API and env boundaries rely on (Section 6.12.9).

---

### WS-0.3.6 Set up database package with Drizzle

**ID:** WS-0.3.6
**Ref:** Section 6.12.8

**Description:**
Initialize `packages/db/` with Drizzle ORM, Drizzle Kit, and the PostgreSQL driver. Drizzle is SQL-first: queries map directly and transparently to SQL statements, making them auditable for injection, performance, and access-control correctness. There is no implicit query generation, lazy loading, or magic relation traversal.

**Files to create:**
- `packages/db/src/index.ts` -- barrel export for schema and client utilities
- `packages/db/src/schema/index.ts` -- placeholder schema exports
- `packages/db/src/client.ts` -- database client factory (connection configuration; reads `DATABASE_URL` from the validated server env, never hard-codes credentials)
- `packages/db/drizzle.config.ts` -- Drizzle Kit configuration

**Dependencies (npm):**
- `drizzle-orm` -- the ORM
- `drizzle-kit` -- migration generation tool (dev dependency)
- `postgres` -- PostgreSQL driver (pg alternative with better TypeScript support)
- `@licio/shared` -- workspace dependency for shared types

**Drizzle Kit configuration:**
- Schema path: `./src/schema/`
- Migration output: `./drizzle/`
- Dialect: `postgresql`
- Connection string from environment variable

**Acceptance criteria:**
- `packages/db/` is initialized with the specified structure.
- `drizzle-kit generate` runs without errors (with placeholder schema).
- Schema types are importable from `@licio/db` in `apps/api/`.
- Migration output directory is `drizzle/` within the package.
- The package depends only on `@licio/shared` for workspace dependencies.
- The client factory reads the connection string from the environment, not a literal.

**Testing:**
- Run `pnpm --filter db drizzle-kit generate`; verify it produces migration files.
- Import a placeholder schema type in `apps/api/`; verify type checking passes.
- Verify `packages/db` does not import from `apps/` or `packages/invariants/`.
- Verify `apps/web` cannot import `@licio/db` (boundary check WS-0.2.3).

**Dependencies:** WS-0.2.1, WS-0.2.2, WS-0.2.3, WS-0.3.5.

**Security (Section 6.12.8, 25.2):** Drizzle's parameterized, SQL-first queries are the SQL-injection defense (all user input is bound, never interpolated). Keeping `@licio/db` out of `apps/web` (WS-0.2.3) guarantees the connection string and query construction never enter the client bundle.

---

### WS-0.3.7 Set up invariants package

**ID:** WS-0.3.7
**Ref:** Sections 1, 30.4

**Description:**
Initialize `packages/invariants/` as the home for invariant computation modules. This package will hold the implementations of MERI, MFCI, GWEI, SCOI, PHI, and supporting invariants. At this stage, only the placeholder structure and shared types are created.

**Files to create:**
- `packages/invariants/src/index.ts` -- barrel export
- `packages/invariants/src/types.ts` -- shared invariant types: `InvariantType` enum (MERI, MFCI, GWEI, SCOI, PHI), `InvariantOutput` interface (type, confidence, coverage, reason codes, fallback behavior), `InvariantVersion` type

**Package configuration:**
- `"name": "@licio/invariants"`
- `"private": true`
- Depends on `@licio/shared` only (no external dependencies beyond what shared provides)

**Acceptance criteria:**
- `packages/invariants/` is initialized with the specified structure.
- Package builds with zero errors.
- Types are importable from `@licio/invariants` in both apps.
- No external dependencies beyond `@licio/shared`.
- `InvariantOutput` includes fields for confidence, coverage, reason codes, and fallback behavior.

**Testing:**
- Import `InvariantType` and `InvariantOutput` from `@licio/invariants` in a test file; verify type checking passes.
- Verify the package has no dependencies on `apps/` or `packages/db/`.

**Dependencies:** WS-0.2.1, WS-0.2.2, WS-0.2.3, WS-0.3.5.

**Security (Section 30.4):** Establishing `InvariantOutput` with explicit `confidence`, `coverage`, `reasonCodes`, and `fallbackBehavior` fields at the foundation enforces the "no hidden sanctions" principle from the start -- every downstream invariant must report why it acted and how it degrades, which the M2 gate (WS-H.1.2) checks.

---

### WS-0.3.8 Set up structured logging with pino

**ID:** WS-0.3.8
**Ref:** Sections 6.12.8, 21.4, 25.2

**Description:**
Install pino in `apps/api/` and create logging middleware for Hono. Structured logging is essential for the audit-trail requirements: moderation actions, authentication events, financial operations, and security incidents must all produce structured, searchable log entries. Pino is chosen for its high performance (JSON serialization in the hot path) and structured output.

**Files to create:**
- `apps/api/src/middleware/logger.ts` -- Hono middleware that logs every request/response with:
  - Unique request ID (generated via `crypto.randomUUID()`, also echoed in the `X-Request-ID` response header)
  - HTTP method, path, status code, response time
  - User agent (truncated)
  - Content length
  - Correlation ID from request headers (if present)
- `apps/api/src/lib/logger.ts` -- configured pino instance with:
  - Structured JSON output in production
  - Pretty-printed output in development (via `pino-pretty` dev dependency)
  - Configurable log levels per environment (`LOG_LEVEL` env var)
  - Redaction of sensitive fields (see explicit redaction paths below)
  - Dedicated log fields for audit-sensitive actions: `auditAction`, `auditActor`, `auditTarget`, `auditResult`

**Explicit pino redaction configuration (`redact.paths`):**
```ts
redact: {
  paths: [
    'req.headers.authorization',
    'req.headers.cookie',
    'res.headers["set-cookie"]',
    'password', '*.password',
    'token', '*.token',
    'secret', '*.secret',
    'apiKey', '*.apiKey',
    'sessionSecret', '*.sessionSecret',
    'privateKey', '*.privateKey',
    'seedPhrase', '*.seedPhrase', 'mnemonic', '*.mnemonic',
    'DATABASE_URL', 'REDIS_URL', 'SESSION_SECRET',
  ],
  censor: '[REDACTED]',
}
```

The wildcard (`*.field`) paths catch nested occurrences. Wallet-specific paths (`privateKey`, `seedPhrase`, `mnemonic`) are included now so the logger is safe before WS-L introduces wallet flows -- it must be impossible to ever log a seed phrase (Section 25.6).

**Audit-sensitive action categories (dedicated log fields):**
- Authentication: login, logout, session rotation, email-OTP verification, wallet sign-in, passkey registration
- Moderation: content removal, account action, appeal decision
- Financial: payment intent, treasury action, wallet link/unlink
- Security: rate limit triggered, CSRF failure, CSP violation report

**Acceptance criteria:**
- Every API request is logged with a unique request ID.
- Structured JSON output in production; pretty-printed in development.
- Sensitive fields are redacted in log output, including nested (`*.password`) and wallet (`seedPhrase`, `privateKey`, `mnemonic`) paths.
- `authorization` and `cookie` headers and `set-cookie` response headers are redacted.
- Log level is configurable via `LOG_LEVEL` environment variable.
- Audit-sensitive actions have dedicated structured fields.

**Testing:**
- Start the dev server and make requests; verify request IDs appear in logs and in the `X-Request-ID` response header.
- Set `LOG_LEVEL=error` and verify debug/info messages are suppressed.
- Log an object containing `password`, `token`, and a nested `user.password`; verify all are `[REDACTED]`.
- Log an object containing `seedPhrase`/`privateKey`; verify they are redacted.
- Write a unit test for the logger that asserts the redaction paths censor each listed field.

**Dependencies:** WS-0.3.3.

**Security (Section 25.2, 25.6, 21.4):** Log redaction is a direct control for "no secrets in the client/logs." Authorization headers, cookies, session secrets, and -- critically -- wallet private keys and seed phrases must never reach log sinks; the explicit redaction path list (including wildcard and wallet paths) makes accidental secret logging fail closed. Structured audit fields underpin the Section 21.4 audit-trail requirement.

---

### WS-0.3.9 Initialize client state and data-fetching libraries

**ID:** WS-0.3.9
**Ref:** Sections 6.12.4, 6.12.9

**Description:**
Install and minimally wire the client state, routing, and data-fetching libraries mandated by Section 6.12.4 so the dependency budget, bundle size, and type-safety baseline are established in WS-0 (full routing/state design is WS-C). These are TanStack Router (type-safe routing), TanStack Query v5 (server state with offline support and zod-validated responses), and Zustand (~1 KB client state). Establishing them now lets WS-0.2.4's dependency-budget check and WS-0.3.1c's bundle-size budget measure the real baseline rather than a stub.

**Minimal scaffolding:**
- Install `@tanstack/react-router`, `@tanstack/react-query`, and `zustand` in `apps/web`.
- Create `apps/web/src/lib/query-client.ts` exporting a configured `QueryClient` (sensible defaults: retry policy, stale time) wrapped by a provider in `main.tsx`.
- Create a placeholder root route and router instance so the app renders through TanStack Router.
- Create a trivial Zustand store (`apps/web/src/lib/store.ts`) to confirm the pattern and bundle impact.
- Establish the convention (documented for WS-C) that every TanStack Query response is parsed through a `zod` schema before entering the cache.

**Acceptance criteria:**
- TanStack Router, TanStack Query v5, and Zustand are installed in `apps/web` as production dependencies.
- The app renders through a TanStack Router root route in dev and production builds.
- A `QueryClient` provider wraps the app.
- A placeholder Zustand store is usable from a component.
- The combined addition keeps `apps/web` within the < 15 production-dependency budget (verified by WS-0.2.4).
- The zod-validated-response convention is documented.

**Testing:**
- Start the dev server; verify the app renders via the router.
- Build for production; verify the bundle-size check (WS-0.3.1c) still passes within budget.
- Run `pnpm check:deps`; verify `apps/web` remains under 15 production deps.
- Render a component that reads the Zustand store; verify it works.

**Dependencies:** WS-0.3.2, WS-0.3.1c, WS-0.2.4.

**Security (Section 6.12.4, 6.12.9):** Zustand's lack of proxy magic and middleware attack surface, and TanStack Query's enforced zod validation of every server response before it enters the cache, are the security rationale for these choices -- malformed or injected server/network data is rejected at the boundary. Establishing them within the dependency budget keeps the supply-chain surface bounded per Section 6.12.12.

---

### WS-0.3.10 Initialize vite-plugin-pwa (Workbox 7) scaffolding

**ID:** WS-0.3.10
**Ref:** Sections 6.12.5, 20.1, 25.2

**Description:**
Install and configure `vite-plugin-pwa` (Workbox 7) in `apps/web` with a minimal, security-hardened service worker and Web App Manifest. The spec mandates this in Section 6.12.5, but the existing WS-0 plan had no dedicated task for it -- yet the service-worker scope, manifest, and CSP `worker-src`/`manifest-src` directives are interdependent and must be established at the foundation. The full offline/precaching/background-sync/push behavior is WS-C; WS-0 establishes a locked-down, integrity-respecting baseline.

**Configuration (`vite.config.ts` `VitePWA({...})`):**
- `registerType: 'prompt'` -- user-facing activation prompt for updates (Section 20.1), never silent auto-update.
- `injectRegister: 'script'` writing to an external file (NOT inline) so registration does not introduce an inline `<script>` -- alternatively register the SW from `main.tsx` so no generated inline script exists. The build-validation gate (WS-0.3.1b) must still pass.
- `workbox.globPatterns` for app-shell precaching with revision hashes.
- Locked SW scope (`scope: '/'`); no `importScripts` from external origins; no remote code evaluation in the worker.
- `manifest`: name, short_name, `display: 'standalone'`, `theme_color`, `background_color`, maskable icons, `start_url`.

**Manifest icons:** generate maskable icons and place them in `apps/web/public/`; reference them as same-origin assets (`img-src 'self'`, `manifest-src 'self'`).

**Acceptance criteria:**
- `vite-plugin-pwa` is installed and configured; a service worker and `manifest.webmanifest` are emitted by `pnpm --filter web build`.
- The service worker registration does NOT introduce an inline `<script>` (WS-0.3.1b validation still passes).
- The SW scope is `'/'` and references no external-origin `importScripts`.
- The manifest declares `display: standalone`, `theme_color`, and maskable icons, all same-origin.
- `registerType` is `prompt` (no silent updates).
- The app is installable (manifest + SW recognized by the browser).

**Testing:**
- Build the web app; verify `sw.js` (or equivalent) and `manifest.webmanifest` exist in `dist/`.
- Run the inline-script validation (WS-0.3.1b); verify it still passes with the PWA plugin enabled.
- Load the built app under a preview server; verify the browser recognizes it as installable (Application panel shows manifest + registered SW).
- Inspect the generated SW; verify no external `importScripts`.

**Dependencies:** WS-0.3.1a, WS-0.3.1b, WS-0.3.2.

**Security (Section 25.2, 6.12.5):** The service worker is a high-value target (it can intercept every request); locking its scope, forbidding remote code evaluation and external `importScripts`, and using prompt-based integrity-verified updates implements the Section 25.2 service-worker controls. Keeping SW registration out of inline scripts preserves strict CSP; `worker-src 'self'`/`manifest-src 'self'` (WS-0.5.1a) confine the worker and manifest to the same origin, preventing service-worker poisoning.

---

### WS-0.3.11 Root-level development orchestration

**ID:** WS-0.3.11
**Ref:** Section 6.12

**Description:**
Configure root-level scripts to orchestrate concurrent development of all workspaces and ensure correct build order. Developers must be able to start the entire development environment with a single command. Build order must respect the dependency graph: shared packages build before apps. (Renumbered from the original WS-0.3.9; references to "root orchestration" resolve here.)

**Root `package.json` scripts:**
- `"dev"` -- run web and api dev servers concurrently (using a tool like `concurrently` or pnpm's `--parallel` flag)
- `"build"` -- build all workspaces in dependency order (packages first, then apps)
- `"test"` -- run tests across all workspaces
- `"test:e2e"` -- run Playwright E2E tests
- `"lint"` -- run Biome check across all workspaces
- `"typecheck"` -- run `tsc --noEmit` (or `tsc -b`) across all workspaces
- `"check:deps"` -- run the dependency-budget check (WS-0.2.4)
- `"clean"` -- remove all `dist/`, `build/`, `node_modules/.cache/`, and `*.tsbuildinfo`

**Build order (dependency graph):**
1. `packages/shared` (no dependencies)
2. `packages/db` and `packages/invariants` (depend on shared, can build in parallel)
3. `apps/web` and `apps/api` (depend on packages, can build in parallel)

**Acceptance criteria:**
- `pnpm dev` starts both web and api dev servers concurrently.
- `pnpm build` builds all workspaces in correct dependency order.
- `pnpm test` runs tests across all workspaces.
- `pnpm lint` runs Biome across all workspaces.
- `pnpm typecheck` runs type checking across all workspaces.
- `pnpm check:deps` runs the dependency-budget check.
- `pnpm clean` removes build artifacts.
- All scripts are runnable from the repository root.

**Testing:**
- Run `pnpm dev` and verify both servers start (web on 5173, api on 3001).
- Run `pnpm build` and verify all workspaces produce output in dependency order.
- Run `pnpm clean` and verify build artifacts are removed.

**Dependencies:** WS-0.3.2, WS-0.3.3, WS-0.3.5, WS-0.3.6, WS-0.3.7, WS-0.2.4.

**Security (Section 6.12):** Correct dependency-ordered builds ensure that the validated, typed packages compile before the apps that consume them, so a contract break is a build failure rather than a runtime surprise; a single `pnpm build` entry point also makes the CI build gate (WS-0.6.1c) reproducible.

---

## WS-0.4 Code quality and security tooling

### WS-0.4.1a Biome formatter configuration

**ID:** WS-0.4.1a
**Ref:** Section 6.12.10

**Description:**
Install Biome at the repository root and configure the formatter in `biome.json`. Biome replaces both ESLint and Prettier with a single, fast tool. Consistent formatting eliminates noise in code reviews and diffs, letting reviewers focus on logic and security issues.

**Formatter configuration (`biome.json`):**
```jsonc
{
  "$schema": "https://biomejs.dev/schemas/<version>/schema.json",
  "formatter": {
    "enabled": true,
    "indentStyle": "space",
    "indentWidth": 2,
    "lineWidth": 100
  },
  "javascript": {
    "formatter": {
      "quoteStyle": "single",
      "jsxQuoteStyle": "double",
      "trailingCommas": "all",
      "semicolons": "always",
      "quoteProperties": "asNeeded",
      "bracketSpacing": true
    }
  },
  "files": {
    "includes": ["apps/**", "packages/**", "scripts/**"],
    "ignore": ["**/node_modules", "**/dist", "**/build", "**/coverage", "**/drizzle", "**/playwright-report", "**/.vite"]
  },
  "organizeImports": { "enabled": true }
}
```

**Acceptance criteria:**
- `biome.json` exists at the repository root with all formatter settings.
- `pnpm biome format --check .` passes on a clean workspace.
- A file with incorrect formatting (e.g., tabs, double quotes) is flagged.
- Ignored directories (`dist`, `drizzle`, `coverage`, etc.) are not scanned.

**Testing:**
- Run `pnpm biome format --check .` and verify exit code 0 on a clean workspace.
- Create a file with double quotes; run the formatter check; verify it fails.
- Run `pnpm biome format --write .` and verify the file is corrected.
- Add a file under `dist/`; verify Biome ignores it.

**Dependencies:** WS-0.2.1.

**Security (Section 6.12.10):** Consistent formatting reduces review diff noise, which keeps reviewer attention on the security-relevant logic rather than whitespace; it is the substrate on which the security lint rules (WS-0.4.1b) operate.

---

### WS-0.4.1b Biome linter security rules

**ID:** WS-0.4.1b
**Ref:** Sections 6.12.10, 6.12.11, 25.2

**Description:**
Configure Biome linter rules that block security-risk patterns. For a UGC platform that connects wallets, these rules are the first automated defense against injection vulnerabilities. A single `eval()` call or `dangerouslySetInnerHTML` usage could create an XSS vector that leads to wallet drain.

**Security rules (must be set to `error`, not `warn`, in `biome.json` `linter.rules`):**
- `security/noDangerouslySetInnerHtml` -- block React's unsafe HTML rendering escape hatch
- `security/noDangerouslySetInnerHtmlWithChildren` -- block the combined pattern
- `security/noGlobalEval` (a.k.a. `noEval`) -- block `eval()` and `new Function()` (arbitrary code execution)
- `suspicious/noGlobalAssign` -- prevent overwriting global objects
- `suspicious/useValidTypeof` -- prevent typeof comparison bugs
- `suspicious/noExplicitAny` -- prevent type-safety escape hatches (overridable only in designated type-utility files via an `overrides` block)
- Block `innerHTML`/`outerHTML` assignment and `document.write` via `nursery/noDocumentCookie`-style restricted syntax or a `noRestrictedSyntax`/custom rule (Biome `noRestrictedSyntax` with selectors for `AssignmentExpression[left.property.name='innerHTML']` and `CallExpression[callee.property.name='write']`).
- Block `javascript:` URLs in JSX `href`/`src` via `a11y`/`security` URL rules or a restricted-syntax selector.

**Override for type-utility files:**
```jsonc
"overrides": [
  { "includes": ["packages/shared/src/types/**"], "linter": { "rules": { "suspicious": { "noExplicitAny": "off" } } } }
]
```

**Acceptance criteria:**
- All security rules are configured as `error` severity in `biome.json`.
- `pnpm biome check .` passes on a clean workspace.
- A file containing `eval("code")` fails the lint check.
- A file containing `dangerouslySetInnerHTML` fails the lint check.
- A file containing `el.innerHTML = x` fails the lint check.
- A file containing `document.write()` fails the lint check.
- A file containing an explicit `any` type annotation (outside the type-utility override) fails the lint check.

**Testing:**
- Create test files with each blocked pattern (`eval`, `new Function`, `dangerouslySetInnerHTML`, `innerHTML =`, `document.write`, `any`, `javascript:` href); verify each fails `biome check`.
- Verify the error messages clearly identify the security risk.
- Verify an `any` inside `packages/shared/src/types/**` is allowed by the override.
- Run `biome check` on a clean workspace; verify zero violations.

**Dependencies:** WS-0.4.1a.

**Security (Section 25.2, 6.12.11):** These rules are the automated, in-editor and in-CI enforcement of the "no unsafe DOM access" property from Section 6.12.11. Every blocked pattern (`eval`, `Function`, `innerHTML`, `document.write`, `dangerouslySetInnerHTML`, `javascript:` URLs) is a known XSS-injection vector; for a wallet-connected platform, blocking them at `error` severity is what keeps an injected script from ever reaching a signature prompt.

---

### WS-0.4.1c Biome import organization and code quality rules

**ID:** WS-0.4.1c
**Ref:** Section 6.12.10

**Description:**
Configure Biome rules for import organization, code quality, and maintainability. Well-organized imports make it easier to review dependencies at a glance. Code quality rules catch common bugs and enforce consistent patterns.

**Import organization:**
- Sort imports alphabetically within groups
- Group order: builtin (`node:`), external, internal (`@licio/`), parent, sibling, index
- Separate groups with blank lines
- No unused imports (error)

**Code quality rules:**
- `useStrictEquals` / `noDoubleEquals` -- enforce `===` and `!==` (prevent type coercion bugs)
- `noUnusedVariables` -- error on unused variables
- `noUnusedImports` -- error on unused imports
- `noUnreachable` -- error on unreachable code
- `noConstAssign` -- error on const reassignment
- `noSwitchDeclarations` -- error on declarations in switch cases without blocks
- `useIsNaN` -- enforce `Number.isNaN()` over `isNaN()`
- `useNodejsImportProtocol` -- enforce `node:` prefix for Node.js builtins (api/db workspaces)
- `noConsoleLog` / `noConsole` -- error on `console.log` in `apps/api` (use structured pino logger instead); warn elsewhere

**Acceptance criteria:**
- Import organization rules are configured and enforced.
- All code quality rules are configured in `biome.json`.
- `pnpm biome check .` passes on a clean workspace.
- Unsorted imports are flagged.
- `==` comparisons are flagged as errors.
- Unused variables and imports are flagged as errors.
- `console.log` in `apps/api` is flagged (logging must go through pino).

**Testing:**
- Create a file with unsorted imports; verify `biome check` flags it.
- Create a file with `==` comparison; verify it is flagged.
- Create a file with unused variables; verify it is flagged.
- Add `console.log` in `apps/api/src`; verify it is flagged.
- Run `biome check --write .` and verify auto-fixable issues are corrected.

**Dependencies:** WS-0.4.1a.

**Security (Section 6.12.10):** Enforcing `node:` import protocol prevents a malicious package from shadowing a core module name (`import fs from 'fs'` vs `'node:fs'`), a known dependency-confusion vector; forbidding `console.log` in the BFF ensures sensitive data flows through the redacting pino logger (WS-0.3.8) rather than an unredacted console sink.

---

### WS-0.4.2 Configure Vitest

**ID:** WS-0.4.2
**Ref:** Section 6.12.10

**Description:**
Install Vitest at the root and configure workspace-aware testing. Vitest is Vite-native, so tests run against the same build pipeline as production, ensuring CSP and Trusted Types behavior is tested rather than mocked.

**Configuration:**
- Root `vitest.workspace.ts` defining workspace configurations for `apps/web`, `apps/api`, `packages/shared`, `packages/db`, `packages/invariants`
- Coverage provider: `v8`
- Coverage thresholds: 80% lines, 80% functions, 80% branches, 80% statements
- Test patterns: `**/*.test.ts`, `**/*.test.tsx`
- TypeScript path aliases matching workspace `tsconfig.json` configurations
- Setup files for each workspace environment (DOM via happy-dom/jsdom for web, Node for api/packages)
- Reporter: `verbose`/`junit` in CI, `default` locally

**Acceptance criteria:**
- `pnpm test` discovers and runs tests across all workspaces.
- Coverage reports are generated in `coverage/` directory.
- Coverage threshold enforcement: test run fails if coverage drops below 80%.
- TypeScript aliases resolve correctly in tests.
- Web workspace tests have access to DOM APIs (jsdom/happy-dom).
- API/package workspace tests run in Node environment.

**Testing:**
- Create a placeholder test in each workspace; run `pnpm test`; verify all are discovered and pass.
- Verify coverage report is generated.
- Create a test that imports from a workspace alias; verify it resolves correctly.
- Drop coverage below 80% in one workspace; verify the run fails.

**Dependencies:** WS-0.3.2, WS-0.3.3, WS-0.3.5, WS-0.3.6, WS-0.3.7, WS-0.2.2.

**Security (Section 6.12.10):** Running tests through the Vite pipeline means CSP- and Trusted-Types-relevant behavior is exercised under the real build, not mocked; the coverage threshold ensures security-relevant branches (auth checks, validation failures, redaction) are actually executed by tests rather than silently uncovered.

---

### WS-0.4.3 Configure Playwright

**ID:** WS-0.4.3
**Ref:** Sections 6.12.10, 26.1, 26.2

**Description:**
Install Playwright in `apps/web/` with Chromium, Firefox, and WebKit browsers. Install `@axe-core/playwright` for automated WCAG 2.2 AA accessibility regression testing. Playwright tests verify that strict CSP is enforced in real browsers, that the PWA installs correctly, and that accessibility requirements are met.

**Configuration (`apps/web/playwright.config.ts`):**
- Projects: Chromium, Firefox, WebKit (three browser engines)
- Base URL: Vite preview server URL
- Screenshot on failure: enabled
- Trace collection on failure: enabled (for debugging)
- Timeout: 30 seconds per test
- Retries: 2 in CI, 0 locally
- Reporter: HTML in CI, line locally
- Web server command: starts the Vite preview server before tests

**Axe-core integration:**
- Import `@axe-core/playwright` for accessibility assertions
- Default axe configuration: WCAG 2.2 AA rules
- Accessibility check runs on every page load in E2E tests

**CSP enforcement check:** include a baseline E2E test that loads the built app and asserts (via the browser's `securitypolicyviolation` event or response headers) that the strict CSP from WS-0.5.1a is present and that an injected inline script would be blocked.

**Acceptance criteria:**
- `pnpm --filter web test:e2e` runs a placeholder E2E test across three browsers.
- Axe accessibility check runs and passes on the placeholder page.
- A baseline CSP-presence test asserts the strict CSP header on the served app.
- Screenshots are captured on test failure.
- Traces are collected on test failure.
- Playwright configuration references the correct base URL.

**Testing:**
- Run `pnpm --filter web test:e2e` with a placeholder test that navigates to the app and asserts the page title.
- Include an axe accessibility assertion in the placeholder test.
- Include a test asserting the CSP header is present and contains `require-trusted-types-for 'script'`.
- Verify screenshots and traces are generated on a deliberately failing test.

**Dependencies:** WS-0.3.2, WS-0.3.10 (PWA/preview server), WS-0.4.2.

**Security (Section 26.1, 26.2, 25.2):** Real-browser E2E is the only place strict CSP and Trusted Types enforcement can be proven (unit tests can only assert header strings); axe-core makes WCAG 2.2 AA a mechanical regression gate, which is a release requirement at every milestone.

---

### WS-0.4.4 Configure lockfile-lint

**ID:** WS-0.4.4
**Ref:** Section 6.12.2

**Description:**
Install and configure `lockfile-lint` to validate the pnpm lockfile against declared registries on every CI run. This prevents lockfile-poisoning supply-chain attacks where a dependency is silently redirected to a malicious registry. A compromised lockfile could introduce backdoored packages without any visible change to `package.json`.

**Configuration (`.lockfile-lintrc.json`):**
```json
{
  "path": "pnpm-lock.yaml",
  "type": "pnpm",
  "validate-https": true,
  "allowed-hosts": ["registry.npmjs.org"],
  "allowed-schemes": ["https:"],
  "validate-integrity": true
}
```

**Acceptance criteria:**
- `pnpm lockfile-lint` passes on a clean lockfile.
- A lockfile entry pointing to a non-npmjs registry is detected and fails.
- A lockfile entry using `http:` protocol is detected and fails.
- Integrity-hash validation is enabled.
- The check is added as a root-level script (`"lint:lockfile"` in root `package.json`).

**Testing:**
- Run `pnpm lockfile-lint` on the clean lockfile; verify it passes.
- Manually modify a lockfile entry to point to `http://evil-registry.com`; verify the check fails.
- Manually modify an integrity hash; verify integrity validation fails.
- Restore the lockfile; verify the check passes again.

**Dependencies:** WS-0.2.1.

**Security (Section 6.12.2, 25.2):** lockfile-lint is the defense against lockfile-poisoning, where a resolved URL or integrity hash is swapped to pull a backdoored tarball while `package.json` looks unchanged. Pinning `allowed-hosts` to `registry.npmjs.org` over `https:` and validating integrity hashes closes the dependency-confusion and registry-redirect vectors.

---

### WS-0.4.5 Pre-commit hooks for local fast-feedback gating

**ID:** WS-0.4.5
**Ref:** Sections 6.12.10, 25.2

**Description:**
Install a lightweight git hook manager (e.g., `lefthook` or `simple-git-hooks` -- chosen for zero/low transitive footprint over `husky`+`lint-staged`) to run fast checks before commit and push, catching security and quality violations locally before they reach CI. This shifts the lint/secret feedback loop left and reduces the chance a secret or an `eval()` ever gets pushed. Hooks must be advisory-fast (staged-files only) and must never be the sole gate -- CI (WS-0.6) remains authoritative.

**Hook configuration:**
- `pre-commit`: run `biome check` on staged files only; run a fast secret-pattern scan over staged content (block obvious key/`.env`/private-key patterns); run `check:deps` if any `package.json` is staged.
- `pre-push`: run `pnpm typecheck` and `pnpm lint:lockfile`.
- Hooks are installed automatically on `pnpm install` via a `prepare` script, but skippable with `--no-verify` for emergencies (with CI as the backstop).

**Acceptance criteria:**
- The hook manager is installed and configured at the repository root with low transitive dependency cost.
- `pre-commit` runs Biome on staged files and blocks a commit containing `eval(` or a staged `.env`.
- `pre-push` runs typecheck and lockfile-lint.
- Hooks install automatically after `pnpm install`.
- Hooks operate on staged files (fast), not the whole tree.

**Testing:**
- Stage a file containing `eval("x")`; attempt `git commit`; verify it is blocked.
- Stage a `.env` file; attempt commit; verify the secret scan blocks it.
- Make a type error; attempt `git push`; verify the pre-push hook blocks it.
- Verify `git commit --no-verify` bypasses hooks (documented emergency path; CI still catches).

**Dependencies:** WS-0.4.1b, WS-0.4.1c, WS-0.2.4, WS-0.4.4.

**Security (Section 25.2):** Local pre-commit secret scanning and lint gating reduce the window in which a secret or injection-risk pattern exists in history at all -- once a secret is pushed, it must be treated as compromised even if later removed. The hooks are a defense-in-depth complement to the authoritative CI gates, not a replacement.

---

## WS-0.5 Security baseline

### WS-0.5.1a Content-Security-Policy and core security headers in Hono

**ID:** WS-0.5.1a
**Ref:** Sections 6.12.8, 6.12.11, 25.2, 20.2

**Description:**
Create Hono middleware that sets the Content-Security-Policy and the core transport/anti-clickjacking security headers on every response. The CSP is the most critical header for a UGC + wallet PWA served without an app store vouching for code integrity: it prevents XSS by blocking inline scripts, which is essential because a single injection could trigger a malicious wallet signature and drain user funds. (Split from the original WS-0.5.1: CSP + core headers here; CSP violation reporting and Permissions-Policy detail in WS-0.5.1b.)

**Security headers middleware (`apps/api/src/middleware/security-headers.ts`):**

**Content-Security-Policy (exact string):**
```
default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; worker-src 'self'; manifest-src 'self'; frame-ancestors 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; require-trusted-types-for 'script'
```

- `default-src 'self'` -- only load resources from the same origin by default
- `script-src 'self'` -- no inline scripts, no eval, no external scripts
- `style-src 'self'` -- no inline styles (Tailwind compiles to static CSS)
- `img-src 'self' data:` -- allow same-origin images and data URIs for small icons
- `font-src 'self'` -- only same-origin fonts
- `connect-src 'self'` -- restrict fetch/XHR to same origin (API proxy handles backend)
- `worker-src 'self'` -- service worker must be same-origin
- `manifest-src 'self'` -- web app manifest must be same-origin
- `frame-ancestors 'self'` -- prevent clickjacking (replaces X-Frame-Options functionally)
- `object-src 'none'` -- no plugins (Flash, Java, etc.)
- `base-uri 'self'` -- prevent base tag injection
- `form-action 'self'` -- forms can only submit to same origin
- `require-trusted-types-for 'script'` -- enforce Trusted Types where supported

Additionally emit `trusted-types <policy-names>` (e.g., `trusted-types default dompurify; require-trusted-types-for 'script'`) once the client policy names are fixed in WS-0.5.4, so only the named policies may create sinks.

**Other core security headers:**
- `Strict-Transport-Security: max-age=63072000; includeSubDomains; preload` -- HSTS with 2-year max-age and preload eligibility
- `X-Content-Type-Options: nosniff` -- prevent MIME type sniffing
- `X-Frame-Options: SAMEORIGIN` -- legacy clickjacking protection (CSP `frame-ancestors` is the modern equivalent); wallet/signing routes will override to `DENY` in WS-L
- `Referrer-Policy: strict-origin-when-cross-origin` -- limit referrer leakage
- `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Resource-Policy: same-origin` -- origin isolation hardening

**Acceptance criteria:**
- All specified headers are present on every API response (and on the served app shell).
- CSP exactly matches the string above, including `worker-src`, `manifest-src`, and `require-trusted-types-for 'script'`.
- No `'unsafe-inline'` or `'unsafe-eval'` appears anywhere in the CSP.
- HSTS, `X-Content-Type-Options: nosniff`, `Referrer-Policy`, and COOP/CORP are present.
- Headers are verified via an integration test.

**Testing:**
- Write an integration test that makes a request and asserts each header is present with the exact expected value (string-compare the CSP).
- Assert the CSP contains none of `unsafe-inline`, `unsafe-eval`, `*`, `http:`.
- Verify the CSP parses cleanly in a CSP validator.
- E2E (Playwright, WS-0.4.3): load the app in a real browser and verify a CSP violation is raised for an injected inline script.

**Dependencies:** WS-0.3.3, WS-0.3.8.

**Security (Section 25.2, 20.2, 6.12.11):** This header set is the primary XSS, clickjacking, and transport-security defense. `script-src 'self'` with no `'unsafe-inline'`/`'unsafe-eval'` plus `require-trusted-types-for 'script'` is the structural barrier between an injected string and code execution -- the exact path that would otherwise lead to a malicious wallet signature. `frame-ancestors 'self'` and `object-src 'none'` close clickjacking and plugin vectors; HSTS preload enforces TLS.

---

### WS-0.5.1b CSP violation reporting and Permissions-Policy

**ID:** WS-0.5.1b
**Ref:** Sections 6.12.11, 25.2, 21.4

**Description:**
Add CSP violation reporting and the Permissions-Policy header, split from the core CSP task so reporting infrastructure is independently testable. A CSP without reporting is blind: violations (which can indicate an attempted or successful injection, or a legitimate-but-blocked resource) must be captured as structured audit events. Permissions-Policy disables powerful browser features the app does not use, shrinking the attack surface.

**CSP reporting:**
- Add `report-to csp-endpoint` and the `Reporting-Endpoints: csp-endpoint="/api/security/csp-report"` header (and the legacy `report-uri` for older browsers) to the CSP from WS-0.5.1a.
- Create `apps/api/src/routes/csp-report.ts` -- `POST /api/security/csp-report` that accepts `application/csp-report`/`application/reports+json`, validates the body with a zod schema, and logs it as an audit-category security event (`auditAction: "csp_violation"`) via the pino logger (WS-0.3.8). Rate-limit and size-limit this endpoint so it cannot be used as a log-flooding vector. It is exempt from CSRF (browser-initiated) but accepts only the report content types.

**Permissions-Policy header:**
```
Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=(), usb=(), bluetooth=(), accelerometer=(), gyroscope=(), magnetometer=(), serial=(), midi=()
```
Note `payment=()` disables the Payment Request API by default; wallet/payment routes (WS-L/WS-M) will selectively relax only what they need, behind feature flags.

**Acceptance criteria:**
- The CSP advertises a reporting endpoint via `Reporting-Endpoints`/`report-to` (and `report-uri` fallback).
- `POST /api/security/csp-report` validates and logs reports as structured `csp_violation` audit events.
- The report endpoint is rate-limited and body-size-limited.
- `Permissions-Policy` disables camera, microphone, geolocation, payment, USB, bluetooth, and sensor APIs by default.

**Testing:**
- Send a sample CSP report payload to the endpoint; verify it is validated and a `csp_violation` audit log entry is produced.
- Send a malformed report; verify it is rejected by the zod schema without crashing.
- Flood the endpoint past the rate limit; verify excess requests are throttled.
- Assert the `Permissions-Policy` header value on a normal response.

**Dependencies:** WS-0.5.1a, WS-0.3.8, WS-0.5.3 (env for any report-sampling config).

**Security (Section 25.2, 21.4):** Violation reporting turns the CSP into a detective control -- attempted injections and policy gaps become structured audit events for the Section 21.4 audit trail and incident response. Permissions-Policy `payment=()`/sensor lockdown removes high-risk browser capabilities the social product never uses, so a future XSS cannot, for example, silently invoke the Payment Request API.

---

### WS-0.5.2a CORS configuration

**ID:** WS-0.5.2a
**Ref:** Section 6.12.11

**Description:**
Configure CORS middleware in Hono to restrict cross-origin requests to the PWA domain only. CORS is the browser-enforced boundary that prevents malicious third-party sites from making authenticated requests to the Licio API.

**CORS configuration (`apps/api/src/middleware/cors.ts`):**
- Allowed origin: PWA domain (configurable via `CORS_ORIGIN` environment variable, e.g., `https://licio.app`)
- Allowed methods: `GET`, `POST`, `PATCH`, `DELETE`, `OPTIONS`
- Allowed headers: `Content-Type`, `Authorization`, `X-Request-ID`, `X-CSRF-Token`
- Credentials: `true` (required for cookie-based authentication)
- Max age: `86400` (24 hours for preflight cache)
- Expose headers: `X-Request-ID` (so the client can log correlation IDs)

**Environment-specific behavior:**
- Development: allow `http://localhost:5173` (the Vite dev origin) explicitly -- not a wildcard
- Production: strict single-origin enforcement
- Origin validation must be exact match, not substring or regex (prevent `evil-licio.app` matching). Implement as an allow-list set membership test, never `startsWith`/`includes`/regex.

**Acceptance criteria:**
- CORS headers are present on API responses for the authorized origin.
- Cross-origin requests from unauthorized origins are rejected (no `Access-Control-Allow-Origin` header).
- Preflight `OPTIONS` requests receive correct CORS headers.
- Credentials are allowed only for the authorized origin.
- Origin validation is exact-match set membership, not substring.
- `Access-Control-Allow-Origin` is never `*` when credentials are allowed.

**Testing:**
- Write an integration test with `Origin: https://licio.app`; verify CORS headers are present.
- Write an integration test with `Origin: https://evil-licio.app`; verify CORS headers are absent (substring attack fails).
- Write an integration test with `Origin: https://evil.com`; verify the request is rejected.
- Test preflight `OPTIONS` request; verify correct response and `Access-Control-Allow-Credentials: true` only for the allowed origin.

**Dependencies:** WS-0.3.3, WS-0.5.3 (`CORS_ORIGIN` env).

**Security (Section 6.12.11):** Exact-match origin validation is critical: a substring or regex check would let `https://evil-licio.app` or `https://licio.app.evil.com` pass, enabling credentialed cross-origin attacks. Because the API uses `credentials: true`, the allow-list must be a precise set and `Access-Control-Allow-Origin` must never be `*`.

---

### WS-0.5.2b CSRF protection

**ID:** WS-0.5.2b
**Ref:** Sections 6.12.11, 25.2

**Description:**
Configure CSRF protection in Hono to prevent cross-site request forgery attacks on state-changing endpoints. CSRF protection is essential because the application uses cookie-based session authentication with `credentials: true` in CORS, which means the browser will automatically send session cookies with cross-origin requests unless defended against.

**CSRF protection layers:**
1. **SameSite cookies:** All session cookies set `SameSite=Strict`, preventing the browser from sending them with cross-origin requests in most scenarios.
2. **Anti-replay nonces:** State-changing requests (POST, PATCH, DELETE) require a CSRF token in the `X-CSRF-Token` header. The token is a nonce bound to the session and validated server-side.
3. **Token validation:** The server generates a CSRF token per session, stores it server-side (in Redis or session store), and validates it on every state-changing request. Tokens are single-use or time-limited to prevent replay. Use a constant-time comparison for token validation to avoid timing oracles.

**Cookie configuration for session tokens:**
- `HttpOnly: true` -- prevent JavaScript access to session cookies
- `Secure: true` -- only send over HTTPS
- `SameSite: Strict` -- prevent cross-site cookie sending
- `Path: /` -- available to all routes
- `Max-Age` or `Expires` -- session duration
- `__Host-` cookie name prefix for the session cookie -- binds it to the origin with `Secure` + `Path=/` + no `Domain`, preventing subdomain cookie injection

**CSRF middleware (`apps/api/src/middleware/csrf.ts`):**
- Generate token: `GET /api/csrf-token` returns a new CSRF token
- Validate token: middleware checks `X-CSRF-Token` header on POST/PATCH/DELETE requests using constant-time comparison
- Reject invalid/missing tokens with `403 Forbidden` and a clear error message
- Exempt health-check, the CSP-report endpoint, and public read-only endpoints

**Acceptance criteria:**
- State-changing requests (POST, PATCH, DELETE) without a valid CSRF token return 403.
- State-changing requests with a valid CSRF token succeed.
- GET requests do not require a CSRF token.
- Session cookies are set with `HttpOnly`, `Secure`, `SameSite=Strict`, and the `__Host-` prefix.
- CSRF tokens are bound to sessions and cannot be reused across sessions.
- Token comparison is constant-time.

**Testing:**
- Write an integration test: POST without CSRF token returns 403.
- Write an integration test: POST with valid CSRF token returns success.
- Write an integration test: POST with another session's token returns 403 (cross-session binding).
- Write an integration test: POST with expired/invalid CSRF token returns 403.
- Write an integration test: GET request succeeds without CSRF token.
- Verify session cookies have all required attributes and the `__Host-` prefix.

**Dependencies:** WS-0.5.2a, WS-0.7.2 (Redis available for token storage), WS-0.5.3 (`SESSION_SECRET`).

**Security (Section 25.2, 6.12.11):** With `credentials: true` CORS and cookie sessions, CSRF is a live threat: a malicious page could trigger a state-changing request that drains or alters user data using the victim's session. SameSite=Strict + per-session nonces + `__Host-` prefix + constant-time validation is the layered defense; the `__Host-` prefix specifically prevents a compromised or attacker-controlled subdomain from injecting a session cookie.

---

### WS-0.5.3 Set up environment variable validation

**ID:** WS-0.5.3
**Ref:** Sections 6.12.7, 25.2

**Description:**
Create zod schemas in `packages/shared/` for environment variable validation. Separate schemas enforce a hard boundary between client-safe variables (prefixed with `VITE_`) and server-only variables. The server must fail fast (fail-closed) on startup if required variables are missing or malformed. The client build must never bundle server-only variables.

**Files to create:**
- `packages/shared/src/env/server.ts` -- server environment schema
- `packages/shared/src/env/client.ts` -- client environment schema (VITE_ prefix only)
- `packages/shared/src/env/index.ts` -- barrel export

**Server environment variables (initial set, zod-typed):**
- `DATABASE_URL` -- PostgreSQL connection string (required, `z.string().url()`)
- `REDIS_URL` -- Redis connection string (required, `z.string().url()`)
- `PORT` -- server port (optional, default 3001, `z.coerce.number().int().positive()`)
- `NODE_ENV` -- environment (required, `z.enum(['development','production','test'])`)
- `LOG_LEVEL` -- logging level (optional, default "info", `z.enum(['debug','info','warn','error'])`)
- `CORS_ORIGIN` -- allowed CORS origin (required in production, `z.string().url()`)
- `SESSION_SECRET` -- session signing secret (required, `z.string().min(32)`)

**Client environment variables (initial set, zod-typed):**
- `VITE_API_URL` -- BFF API base URL (required, `z.string().url()`)
- `VITE_APP_URL` -- application base URL (required, `z.string().url()`)

**Validation behavior:**
- Server: validate on startup in `apps/api/src/index.ts` BEFORE binding the port; on failure, print every missing/invalid variable and exit non-zero (fail-closed).
- Client: validate at build time; Vite only exposes `VITE_` prefixed variables. A guard asserts no key without the `VITE_` prefix is referenced in client code.
- Both: use zod `.parse()` for fail-fast behavior (not `.safeParse()` at the boundary).
- The server schema must reject any attempt to read a `VITE_`-prefixed secret as a server secret, and the client schema must reject any non-`VITE_` key, so the two namespaces cannot cross.

**Acceptance criteria:**
- Server startup fails (non-zero exit) with a clear, aggregated error if `DATABASE_URL` is missing.
- Server startup fails if `SESSION_SECRET` is fewer than 32 characters.
- Server validation runs before the port is bound (no half-initialized server).
- Client build does not bundle `DATABASE_URL`, `SESSION_SECRET`, or any non-`VITE_` variable.
- All environment variables have documented types and constraints.
- Default values are provided where appropriate (`PORT`, `LOG_LEVEL`).

**Testing:**
- Write a unit test: server schema rejects missing `DATABASE_URL` with a clear message listing the field.
- Write a unit test: server schema rejects `SESSION_SECRET` shorter than 32 characters.
- Write a unit test: client schema only accepts `VITE_` prefixed variables and rejects others.
- Integration test: start the server with a missing required var; verify it exits non-zero before listening.
- Verify the client build output does not contain any server-only variable names (grep the built JS for `SESSION_SECRET`, `DATABASE_URL`).

**Dependencies:** WS-0.3.5, WS-0.3.3.

**Security (Section 25.2, 6.12.7):** Fail-closed env validation prevents a misconfigured server from booting in a partially-secured state (e.g., with a short or missing `SESSION_SECRET`, which would make sessions forgeable). The hard `VITE_`/server split is the enforcement point for "no secrets in the client": server secrets are structurally unable to enter the client schema, and the client build only ever exposes `VITE_` values.

---

### WS-0.5.4 Trusted Types policy wiring (client)

**ID:** WS-0.5.4
**Ref:** Sections 6.12.7, 6.12.11, 25.2

**Description:**
Wire the client-side Trusted Types policy that the `require-trusted-types-for 'script'` CSP directive (WS-0.5.1a) requires. Without a named, registered Trusted Types policy, enforcing `require-trusted-types-for 'script'` would break legitimate DOM sink usage; with one, the ONLY way to create a `TrustedHTML`/`TrustedScript` is through the reviewed policy, structurally eliminating string-to-DOM injection. This task establishes the policy and the DOMPurify integration scaffolding (full UGC sanitization is WS-G.4, but the policy plumbing belongs at the foundation alongside the CSP that demands it).

**Implementation:**
- `apps/web/src/security/trusted-types.ts` -- create a default Trusted Types policy (and a named `dompurify` policy) via `window.trustedTypes.createPolicy(...)`, guarded for browsers without Trusted Types support. The default policy must be deliberately restrictive (throw on raw HTML by default) so that any un-sanitized sink usage fails loudly.
- Configure DOMPurify with `RETURN_TRUSTED_TYPE: true` so `DOMPurify.sanitize()` returns a `TrustedHTML` value compatible with the policy (the sanitizer install/usage is finalized in WS-G.4; WS-0 wires the policy and a smoke test).
- Bootstrap the policy from `main.tsx` before any rendering.
- Ensure the policy names match the `trusted-types` CSP directive emitted by WS-0.5.1a.

**Acceptance criteria:**
- A Trusted Types policy is created at startup and named consistently with the CSP `trusted-types` directive.
- The default policy rejects raw HTML (throws), so unguarded sink usage fails.
- DOMPurify is configured to return `TrustedHTML` (`RETURN_TRUSTED_TYPE: true`).
- The policy bootstrap is guarded for browsers lacking Trusted Types (no crash; CSP backstop still applies).
- No inline script is introduced by the policy bootstrap (WS-0.3.1b validation still passes).

**Testing:**
- Unit/E2E: in a Trusted-Types-capable browser (Chromium), verify assigning a raw string to a sink (e.g., `innerHTML`) without the policy throws a Trusted Types violation.
- Verify `DOMPurify.sanitize(dirty, { RETURN_TRUSTED_TYPE: true })` returns a `TrustedHTML` instance accepted by a sink.
- Verify the app loads without errors in WebKit/Firefox (no Trusted Types) using the CSP backstop.
- Verify the build still passes the inline-script gate.

**Dependencies:** WS-0.5.1a, WS-0.3.2, WS-0.3.10.

**Security (Section 25.2, 6.12.7, 6.12.11):** Trusted Types is the strongest available DOM-XSS defense: with `require-trusted-types-for 'script'` enforced and a restrictive default policy, a string can only reach a dangerous sink after passing through the reviewed DOMPurify policy that returns `TrustedHTML`. This makes the wallet-drain-via-injection path structurally unreachable on supporting browsers, with the strict CSP as the cross-browser backstop.

---

### WS-0.5.5 Supply-chain provenance and SBOM scaffolding

**ID:** WS-0.5.5
**Ref:** Sections 20.2, 25.2

**Description:**
Scaffold the supply-chain integrity artifacts that Section 20.2 mandates -- a Software Bill of Materials (SBOM) and the placeholder for signed build provenance -- so the foundation produces them from day one. Full provenance signing (Sigstore/cosign + in-toto attestations recorded in a transparency log) and reproducible-build verification are owned by WS-O.3, but the SBOM generation and the artifact contract belong in WS-0 so every CI build emits them and downstream tasks have a stable interface. This task scaffolds; WS-O.3 hardens and signs.

**Implementation:**
- `scripts/generate-sbom.ts` (or a CI step using `pnpm sbom`/CycloneDX) -- generate a CycloneDX SBOM (`sbom.cdx.json`) of the production dependency graph for `apps/web` and `apps/api`, including licenses and versions. Run in CI (WS-0.6.1e) and uploaded as an artifact.
- Establish the provenance artifact contract: define where build provenance/attestation files will live (`provenance/` in `.gitignore`) and document that WS-O.3 will populate them with Sigstore/cosign signatures and in-toto attestations over the deterministic build output (the SRI manifest from WS-0.3.1c is the digest source).
- Add an SBOM license cross-check: fail (or warn) if any dependency license is incompatible with AGPL-3.0-or-later (implements the Section 20.4 SBOM cross-check). Maintain an allow-list of compatible SPDX licenses.

**Acceptance criteria:**
- `scripts/generate-sbom.ts` produces a valid CycloneDX `sbom.cdx.json` for both apps.
- The SBOM lists every production dependency with its version and license.
- A license-compatibility check flags any non-AGPL-compatible license.
- The provenance artifact location is defined and gitignored, with WS-O.3 documented as owner.
- CI uploads the SBOM as an artifact (WS-0.6.1e).

**Testing:**
- Run `pnpm sbom` (or the script); verify `sbom.cdx.json` validates against the CycloneDX schema.
- Verify the SBOM includes a known dependency (e.g., `hono`) with correct version and license.
- Introduce a dependency with an incompatible license (fixture); verify the license check flags it.
- Verify the SBOM is produced and uploaded by the CI security job.

**Dependencies:** WS-0.2.1, WS-0.3.1c, WS-0.2.4.

**Security (Section 20.2, 25.2, 20.4):** An SBOM is the inventory that makes vulnerability and license auditing possible -- you cannot defend a dependency you do not know you ship. Generating it every build, plus reserving the signed-provenance artifact contract for WS-O.3, implements the Section 20.2 requirement that a backdoored or targeted bundle cannot be served without public evidence, and the Section 20.4 SBOM license cross-check.

---

## WS-0.6 CI/CD pipeline

### WS-0.6.1a CI workflow structure

**ID:** WS-0.6.1a
**Ref:** Section 30.8

**Description:**
Create the GitHub Actions CI workflow file at `.github/workflows/ci.yml` with the overall structure, triggers, matrix strategy, caching, and least-privilege permissions. This is the skeleton that the subsequent CI tasks (WS-0.6.1b through WS-0.6.1f) fill with specific jobs.

**Workflow triggers:**
- `push` to `main` branch
- `pull_request` to `main` branch
- Manual trigger (`workflow_dispatch`) for ad-hoc runs

**Top-level hardening:**
- `permissions: contents: read` at the workflow level (least privilege); individual jobs elevate only what they need (e.g., the security job may add `security-events: write`).
- Pin all third-party actions to a full commit SHA, not a floating tag, to prevent a compromised action tag from injecting code into CI.
- `concurrency: { group: ci-${{ github.ref }}, cancel-in-progress: true }` except on `main`.

**Shared configuration (composite/setup steps):**
- Node.js version: LTS (e.g., 22.x) via matrix strategy for future multi-version testing; sourced from `.nvmrc`.
- pnpm version: from the root `packageManager` field via Corepack (single source of truth).
- pnpm store caching: cache the pnpm store directory (resolved via `pnpm store path`) keyed by `pnpm-lock.yaml` hash.
- Playwright browser caching: keyed by the resolved Playwright version.
- Install step uses `pnpm install --frozen-lockfile` (and `--ignore-scripts` where feasible, with an explicit allow-list otherwise).

**Acceptance criteria:**
- `.github/workflows/ci.yml` exists with correct trigger configuration.
- Workflow-level `permissions` is `contents: read` (least privilege).
- All third-party actions are pinned to commit SHAs.
- pnpm store is cached across runs (cache hit on second run).
- Playwright browsers are cached across runs.
- In-progress runs are cancelled for updated PRs (not for `main`).
- All jobs use the same Node.js and pnpm versions, sourced from `.nvmrc`/`packageManager`.
- Install uses `--frozen-lockfile`.

**Testing:**
- Push a commit to a branch; verify the workflow triggers.
- Push a second commit to the same branch; verify the first run is cancelled.
- Verify cache is created on first run and hit on second run (check workflow logs).
- Verify every `uses:` reference is a 40-char SHA, not a tag.
- Confirm `--frozen-lockfile` is used (log inspection).

**Dependencies:** WS-0.1.4 (`.nvmrc`), WS-0.2.1 (`packageManager`, lockfile).

**Security (Section 30.8, 25.2):** SHA-pinned actions and least-privilege `contents: read` permissions defend the CI pipeline itself from supply-chain compromise (a poisoned action tag or an over-privileged token can exfiltrate secrets or push malicious commits). `--frozen-lockfile` + `--ignore-scripts` prevents a lockfile or install-script attack from executing on the runner.

---

### WS-0.6.1b Lint + type check + lockfile-lint + dependency-budget jobs

**ID:** WS-0.6.1b
**Ref:** Sections 6.12.10, 6.12.2, 6.12.12

**Description:**
Add CI jobs for linting, type checking, lockfile integrity validation, and dependency-budget enforcement. These jobs run in parallel and must all pass for the PR to be mergeable. They are the fastest feedback loop for catching code quality and security issues.

**Jobs:**

**Job: lint**
- Run `pnpm biome check .` to verify formatting and linting rules
- Fail the build on any violation (security rules are errors, not warnings)

**Job: typecheck**
- Run `pnpm typecheck` (`tsc --noEmit` / `tsc -b`) across all workspaces
- Fail the build on any type error
- This catches type-safety violations that could become runtime vulnerabilities

**Job: lockfile-lint**
- Run `pnpm lockfile-lint` to validate lockfile integrity
- Fail the build if any dependency points to a non-npmjs registry or uses HTTP

**Job: dep-budget**
- Run `pnpm check:deps` (WS-0.2.4)
- Fail the build if `apps/web` ≥ 15 or `apps/api` ≥ 20 production dependencies
- Print current counts and headroom in the log

**Acceptance criteria:**
- All four jobs are defined in the CI workflow.
- Jobs run in parallel (no dependencies between them).
- A PR introducing `eval()` is blocked by the lint job.
- A PR introducing a type error is blocked by the typecheck job.
- A corrupted lockfile is blocked by the lockfile-lint job.
- A PR pushing `apps/web` to 15 production deps is blocked by the dep-budget job.

**Testing:**
- Submit a PR with an `eval()` call; verify the lint job fails.
- Submit a PR with a deliberate type error; verify the typecheck job fails.
- Submit a PR adding a 15th production dependency to `apps/web`; verify the dep-budget job fails.
- Verify all four jobs pass on a clean codebase.

**Dependencies:** WS-0.6.1a, WS-0.4.1b, WS-0.4.1c, WS-0.4.4, WS-0.2.4, WS-0.2.2.

**Security (Section 6.12.2, 6.12.10, 6.12.12):** This job bundle is the automated enforcement of three security controls: injection-pattern lint rules (XSS defense), lockfile integrity (supply-chain), and the dependency budget (supply-chain surface limit). All run at `error`/fail severity so none can be merged around.

---

### WS-0.6.1c Test + coverage + bundle size jobs

**ID:** WS-0.6.1c
**Ref:** Sections 6.12.10, 6.12.12, 6.10

**Description:**
Add CI jobs for running tests with coverage enforcement and tracking bundle size. Coverage gates prevent merging code that drops test coverage below the threshold. Bundle size tracking prevents gradual bloat that would degrade mobile performance and can flag injected dependencies.

**Jobs:**

**Job: test**
- Run `pnpm test --coverage` across all workspaces
- Coverage threshold: 80% (lines, functions, branches, statements)
- Fail the build if coverage drops below threshold
- Upload coverage report as a CI artifact
- Post coverage summary as a PR comment (optional, via action)

**Job: build-and-size**
- Run `pnpm build` for all workspaces
- Run the inline-script/style validation (`scripts/validate-build.ts`, WS-0.3.1b) on web build output
- Run `scripts/generate-sri.ts` and `scripts/check-bundle-size.ts` (WS-0.3.1c)
- Record bundle sizes (total JS gzipped, total CSS gzipped, largest chunk) from `bundle-size.json`
- Compare against budgets: initial JS < 200KB gzipped, CSS < 50KB gzipped (Section 6.10)
- Fail the build if budgets are exceeded
- Post size comparison as a PR comment (optional, via action)
- Upload the SRI manifest and SBOM-adjacent artifacts

**Acceptance criteria:**
- Test job runs all workspace tests and enforces 80% coverage threshold.
- Build job validates zero inline scripts/styles in web build output.
- Bundle size is tracked and compared against budgets; SRI manifest generated.
- Coverage report is available as a CI artifact.
- A PR that drops coverage below 80% is blocked.
- A PR that exceeds bundle size budgets is blocked.

**Testing:**
- Remove tests to drop coverage below 80%; verify the job fails.
- Add a large dependency to inflate bundle size past 200KB gzip; verify the size check fails.
- Add an inline `<script>` to the HTML template; verify the build-and-size job fails on the inline-script gate.
- Verify both jobs pass on a clean codebase and upload artifacts.

**Dependencies:** WS-0.6.1a, WS-0.4.2, WS-0.3.1b, WS-0.3.1c.

**Security (Section 25.2, 6.10, 6.12.12):** The build-and-size job is a CSP-compliance gate (inline-script validation) and a supply-chain canary (an unexpected bundle-size jump can indicate an injected dependency); coverage enforcement ensures security-critical branches are actually tested.

---

### WS-0.6.1d E2E + accessibility audit job

**ID:** WS-0.6.1d
**Ref:** Sections 6.12.10, 26.1, 26.2

**Description:**
Add a CI job that runs Playwright E2E tests with axe-core accessibility audits on the built application. This job depends on the build job completing successfully. E2E tests verify that the application works correctly in real browsers with strict CSP enforced and that accessibility requirements (WCAG 2.2 AA) are met.

**Job: e2e**
- Depends on: build-and-size job (needs the built artifacts)
- Start a preview server serving the built web app
- Run Playwright tests across Chromium, Firefox, and WebKit
- Every page navigation includes an axe-core accessibility assertion
- Include the CSP-presence/enforcement assertion (WS-0.4.3)
- Collect test results, screenshots, and traces as CI artifacts
- Fail on any accessibility violation at the WCAG 2.2 AA level
- Use cached Playwright browsers (WS-0.6.1a)

**Accessibility checks (via @axe-core/playwright):**
- Color contrast (WCAG 2.2 AA: 4.5:1 for text, 3:1 for large text)
- Focus order and keyboard navigation
- ARIA roles and labels
- Image alt text
- Form label association
- Target size (WCAG 2.2 AA: 24x24 CSS pixels minimum)

**Acceptance criteria:**
- E2E job runs after the build job completes.
- Tests execute in three browser engines.
- Axe accessibility checks run on every page.
- The strict CSP is asserted present and enforced in a real browser.
- Accessibility violations fail the build.
- Screenshots, traces, and test results are uploaded as artifacts.
- The job uses cached Playwright browsers.

**Testing:**
- Run the E2E job on a clean build; verify it passes.
- Introduce an accessibility violation (e.g., remove an alt attribute); verify the job fails.
- Remove the CSP header in a test build; verify the CSP assertion fails.
- Verify artifacts (screenshots, traces) are uploaded on failure.

**Dependencies:** WS-0.6.1c, WS-0.4.3, WS-0.5.1a.

**Security (Section 26.1, 26.2, 25.2):** This is the only gate that proves strict CSP and Trusted Types are actually enforced by real browser engines (not merely present as header strings) and that WCAG 2.2 AA holds -- both are release requirements at every milestone.

---

### WS-0.6.1e Security audit job

**ID:** WS-0.6.1e
**Ref:** Sections 6.12.2, 6.12.11, 25.2, 20.2

**Description:**
Add a CI job dedicated to security checks. This job runs in parallel with other jobs and aggregates multiple security validation steps. It is the automated component of the security review process required before any production deployment.

**Job: security**
- **pnpm audit:** Run `pnpm audit --audit-level=high` to check for known vulnerabilities in dependencies. Fail on high or critical severity.
- **lockfile-lint:** Run `pnpm lockfile-lint` (also run in the lint job, but duplicated here for the security audit report). Validate all dependencies resolve to `https://registry.npmjs.org`.
- **Inline script check:** Run the build validation script to verify zero inline scripts/styles in the web build output. This is the CSP compliance gate.
- **SBOM generation:** Run `scripts/generate-sbom.ts` (WS-0.5.5); upload `sbom.cdx.json` as an artifact; run the AGPL license-compatibility cross-check.
- **Secret scanning:** Check that no `.env`, `.pem`, `.key`, `.p12`, or files matching secret patterns are committed. Use `git ls-files` to check tracked files against a blocklist, plus a content scan (e.g., gitleaks) for high-entropy strings and known key formats.
- **Dependency install scripts:** Check for packages with install scripts (`pnpm ls --json` / lockfile inspection for `install`/`preinstall`/`postinstall`). Flag any for manual review.

**Acceptance criteria:**
- Security job runs on every PR.
- Known high/critical vulnerabilities in dependencies fail the build.
- Lockfile integrity is validated.
- Zero inline scripts/styles in build output is enforced.
- An SBOM is generated, license-checked, and uploaded.
- Committed secrets (by filename or content pattern) are detected and the build fails.
- Packages with install scripts are flagged for review.

**Testing:**
- Install a package with a known high-severity vulnerability; verify the audit fails.
- Commit a `.env` file; verify the secret scan fails.
- Add a high-entropy fake key string to a tracked file; verify the content scan flags it.
- Add a dependency with a postinstall script; verify it is flagged.
- Verify all checks pass on a clean codebase and the SBOM artifact is produced.

**Dependencies:** WS-0.6.1a, WS-0.4.4, WS-0.3.1b, WS-0.5.5.

**Security (Section 25.2, 20.2, 6.12.2):** This job aggregates the supply-chain and secret-hygiene controls: vulnerability scanning (known CVEs), lockfile integrity (registry redirection), install-script flagging (postinstall attacks), secret scanning (no secrets in repo), SBOM (inventory + license cross-check), and inline-script validation (CSP). Together they implement the Section 25.2 supply-chain bullet and the Section 20.2 provenance/SBOM requirement.

---

### WS-0.6.1f Branch protection and required status checks

**ID:** WS-0.6.1f
**Ref:** Sections 30.8, 25.1

**Description:**
Configure GitHub branch protection on `main` so the CI security gates are mandatory, not advisory. A pipeline that can be merged around provides no guarantee. Codify the required status checks, required review, and merge constraints. Because branch-protection settings live in repository configuration rather than the codebase, document the exact required settings in `CONTRIBUTING.md`/an ADR so they are reproducible and auditable, and apply them via repository settings (or `gh api`/Terraform if infrastructure-as-code is adopted).

**Required settings on `main`:**
- Require all CI jobs to pass (lint, typecheck, lockfile-lint, dep-budget, test, build-and-size, e2e, security) before merge.
- Require at least one approving review; dismiss stale approvals on new commits.
- Require branches to be up to date before merging.
- Require linear history (no merge commits) or squash-merge only, to keep provenance clean.
- Restrict force-pushes and deletion of `main`.
- Require signed commits (optional but recommended) to strengthen provenance.

**Acceptance criteria:**
- `main` cannot be pushed to directly; changes require a PR.
- A PR with any failing required check cannot be merged.
- A PR without an approving review cannot be merged.
- Force-push and branch deletion on `main` are blocked.
- The required-checks list is documented and matches the CI job names.

**Testing:**
- Open a PR with a failing lint job; verify the merge button is blocked.
- Attempt a direct push to `main`; verify it is rejected.
- Attempt to merge without a review; verify it is blocked.
- Verify the documented required-check names exactly match the workflow job names.

**Dependencies:** WS-0.6.1b, WS-0.6.1c, WS-0.6.1d, WS-0.6.1e, WS-0.1.5 (CONTRIBUTING documents the policy).

**Security (Section 30.8, 25.1):** Branch protection is what makes every preceding gate enforceable rather than optional -- without it, a contributor (or a compromised credential) could merge code that bypasses lint, tests, and the security job. Required review and restricted force-push protect the integrity and provenance of `main`, the branch from which production bundles are built.

---

### WS-0.6.2 Dependency scanning

**ID:** WS-0.6.2
**Ref:** Sections 6.12.2, 6.12.12, 25.4

**Description:**
Configure automated dependency updates and vulnerability scanning. This ensures the project stays current with security patches and that newly discovered vulnerabilities are flagged promptly.

**Configuration options (choose one):**
- **Dependabot** (`.github/dependabot.yml`): weekly update checks, grouped by ecosystem, auto-merge for patch updates with passing CI
- **Renovate** (`renovate.json`): similar functionality with more granular control

**Configuration requirements:**
- Check for updates weekly
- Group minor and patch updates to reduce PR noise
- Auto-merge patch updates that pass all CI checks (auto-merge is gated by the full required-check set from WS-0.6.1f, so a malicious patch still cannot merge without green security jobs)
- Flag packages with install scripts for manual review
- Alert on known CVEs immediately (not just on schedule), via the security advisory integration
- Respect the dependency budget (Section 6.12.12): new direct dependencies require human review and re-run the dep-budget check

**Acceptance criteria:**
- Dependency update PRs are created automatically on a weekly schedule.
- Vulnerable packages are flagged with CVE details.
- Patch updates with passing CI (including the security job) can be auto-merged.
- Packages with install scripts are flagged for manual review in the PR.
- The configuration file is committed to the repository.

**Testing:**
- Verify the dependency scanning configuration file is valid (schema check).
- Manually trigger a dependency check; verify PRs are created for outdated packages.
- Verify an auto-merge candidate still requires the security and dep-budget checks to pass.

**Dependencies:** WS-0.6.1f.

**Security (Section 25.4, 6.12.12):** Automated scanning closes the window between a CVE disclosure and a patched deployment, implementing the Section 25.4 vulnerability-management control. Gating auto-merge on the full required-check set ensures the convenience of automation never bypasses the security gate.

---

### WS-0.6.3 CodeQL static analysis

**ID:** WS-0.6.3
**Ref:** Sections 25.2, 25.4, 30.8

**Description:**
Add a GitHub CodeQL (or equivalent SAST) workflow that performs semantic static analysis of the TypeScript codebase to detect security anti-patterns that lint rules cannot catch -- data-flow from untrusted sources to dangerous sinks (taint tracking), injection, prototype pollution, and unsafe deserialization. Biome catches syntactic patterns; CodeQL adds data-flow-aware detection, which is a meaningfully different layer for a UGC + wallet platform where the dominant risk is injection reaching a sink.

**Configuration (`.github/workflows/codeql.yml`):**
- Languages: `javascript-typescript`.
- Triggers: `pull_request` to `main`, `push` to `main`, and a weekly scheduled scan (to catch newly published query updates against unchanged code).
- Query suite: `security-extended` (broader than the default).
- Results surfaced in the GitHub Security tab (job adds `security-events: write`).
- Fail the PR on new high/critical findings (treat as a required check via WS-0.6.1f).

**Acceptance criteria:**
- `.github/workflows/codeql.yml` exists and runs on PRs, pushes to `main`, and weekly.
- The `security-extended` query suite is configured.
- Findings appear in the repository Security tab.
- A new high/critical finding blocks the PR.
- The job uses least-privilege permissions plus `security-events: write`.

**Testing:**
- Introduce a deliberate taint-flow (untrusted input concatenated into a sink) on a branch; verify CodeQL flags it.
- Verify a clean codebase produces no high/critical findings.
- Verify results are visible in the Security tab.
- Verify the weekly schedule is configured.

**Dependencies:** WS-0.6.1a.

**Security (Section 25.2, 25.4):** CodeQL's data-flow analysis catches injection and taint-to-sink vulnerabilities that syntactic linting misses -- e.g., user input flowing through several functions before reaching a DOM or SQL sink. For a platform where an injection can drain wallets, this semantic layer materially raises the bar, and the weekly scan catches newly discovered vulnerability classes in already-merged code.

---

## WS-0.7 Development environment

### WS-0.7.1 Development scripts

**ID:** WS-0.7.1
**Ref:** Section 6.12

**Description:**
Configure all root-level `package.json` scripts for daily development workflows. Every common development action must be a single command from the repository root. This reduces friction and ensures consistent tooling across the team.

**Root `package.json` scripts:**
- `"dev"` -- start web and api dev servers concurrently
- `"build"` -- build all workspaces in dependency order
- `"test"` -- run unit tests across all workspaces via Vitest
- `"test:e2e"` -- run Playwright E2E tests in `apps/web/`
- `"lint"` -- run `biome check .` across all workspaces
- `"lint:fix"` -- run `biome check --write .` to auto-fix
- `"lint:lockfile"` -- run `lockfile-lint`
- `"typecheck"` -- run `tsc --noEmit` (or `tsc -b`) across all workspaces
- `"check:deps"` -- run the dependency-budget check (WS-0.2.4)
- `"sbom"` -- run `scripts/generate-sbom.ts` (WS-0.5.5)
- `"db:generate"` -- run `drizzle-kit generate` in `packages/db/`
- `"db:migrate"` -- run `drizzle-kit migrate` in `packages/db/`
- `"db:push"` -- run `drizzle-kit push` in `packages/db/`
- `"clean"` -- remove `dist/`, `build/`, `coverage/`, `test-results/`, `playwright-report/`, `*.tsbuildinfo`, `node_modules/.cache/`

**Acceptance criteria:**
- Every listed script is defined in the root `package.json`.
- Every script runs successfully from the repository root.
- `pnpm dev` starts both servers.
- `pnpm build` builds all workspaces.
- `pnpm test` runs all tests.
- `pnpm check:deps` and `pnpm sbom` run successfully.
- `pnpm clean` removes all build artifacts and caches.

**Testing:**
- Run each script from the repository root; verify it executes without errors.
- Run `pnpm clean` then `pnpm build`; verify a clean build succeeds.

**Dependencies:** WS-0.3.11, WS-0.2.4, WS-0.5.5, WS-0.3.6.

**Security (Section 6.12):** A single, consistent set of entry points means the local commands match exactly what CI runs (`lint`, `typecheck`, `check:deps`, `sbom`, `build` with validation), so a developer cannot accidentally use a weaker local path than the enforced gate.

---

### WS-0.7.2 Docker Compose for local services

**ID:** WS-0.7.2
**Ref:** Sections 6.12.8, 21.1, 21.2

**Description:**
Create `docker-compose.yml` at the repository root for local development services. The Hono BFF connects to PostgreSQL for data storage and Redis for session management, rate limiting, and caching. Docker Compose provides a reproducible local environment that matches production service dependencies.

**Services:**

**PostgreSQL 16:**
- Image: `postgres:16-alpine` (pinned by digest for reproducibility)
- Port: `5432:5432` (mapped to host)
- Environment variables:
  - `POSTGRES_USER: licio`
  - `POSTGRES_PASSWORD: licio_dev` (development only; never used outside local)
  - `POSTGRES_DB: licio_dev`
- Volume: `postgres-data:/var/lib/postgresql/data` (persistent across restarts)
- Health check: `pg_isready -U licio -d licio_dev` with interval 10s, timeout 5s, retries 5, start_period 30s
- Restart policy: `unless-stopped`

**Redis 7:**
- Image: `redis:7-alpine` (pinned by digest)
- Port: `6379:6379` (mapped to host)
- Command: `redis-server --appendonly yes --maxmemory 256mb --maxmemory-policy allkeys-lru`
- Volume: `redis-data:/data` (persistent across restarts)
- Health check: `redis-cli ping` with interval 10s, timeout 5s, retries 5, start_period 10s
- Restart policy: `unless-stopped`

**Named volumes:**
- `postgres-data` -- persistent PostgreSQL data
- `redis-data` -- persistent Redis data

**Environment file:**
- Create `.env.example` with all required environment variables and documentation (matching the WS-0.5.3 schemas exactly, with safe placeholder values).
- `.env` (gitignored) for local overrides.

**Acceptance criteria:**
- `docker compose up -d` starts PostgreSQL and Redis.
- Both services pass their health checks within 30 seconds.
- Service images are pinned (digest) for reproducibility.
- Data persists across `docker compose down` / `docker compose up` cycles (named volumes).
- The API can connect to PostgreSQL using the configured credentials.
- The API can connect to Redis using the configured connection string.
- `.env.example` documents all required variables and matches the env schema field-for-field.
- `.env` is gitignored and not committed.

**Testing:**
- Run `docker compose up -d`; verify both services start and become healthy.
- Connect to PostgreSQL: `docker compose exec postgres pg_isready`; verify success.
- Connect to Redis: `docker compose exec redis redis-cli ping`; verify `PONG` response.
- Run `docker compose down` then `docker compose up -d`; verify data persists.
- Diff `.env.example` keys against the WS-0.5.3 server/client schema; verify they match.
- Verify `.env` is in `.gitignore`.

**Dependencies:** WS-0.1.1 (`.gitignore`), WS-0.5.3 (env schema), WS-0.3.6 (db client connects).

**Security (Section 21.1, 21.2, 25.2):** A reproducible local stack that mirrors the production services (relational DB, Redis for sessions/rate limiting/CSRF tokens) ensures security middleware (CSRF token storage, rate limiting) is developed and tested against the real backing stores. Pinned image digests prevent a base-image swap from silently changing the local environment; the development-only credentials never leave local and are documented as such in `.env.example`.

---

### WS-0.7.3 Local HTTPS and security-header parity for development

**ID:** WS-0.7.3
**Ref:** Sections 25.2, 6.12.8, 20.2

**Description:**
Several security mechanisms only function over HTTPS or a secure context: `Secure` and `__Host-` cookies, Service Workers (beyond `localhost`), HSTS, and some Trusted Types behaviors. To develop and test these faithfully, provide an optional local HTTPS setup (e.g., `mkcert`-generated locally-trusted certificates wired into the Vite dev server and the Hono server) and ensure the strict security headers and CSP (WS-0.5.1a/b) are applied in development as well as production, so a developer sees CSP violations and cookie behavior locally rather than discovering them only in CI/production.

**Implementation:**
- Document a `mkcert`-based local-CA workflow in `CONTRIBUTING.md`/`docs`; generate dev certs into a gitignored path (`*.pem` already ignored by WS-0.1.1).
- Add an optional Vite dev-server `https` config and a Hono TLS option keyed off an env flag (`DEV_HTTPS=true`).
- Apply the security-headers and CSP middleware in development (not only production), with a clearly-scoped relaxation only for Vite HMR's dev-time websocket if strictly necessary (documented, dev-only, never shipped).
- Verify the service worker (WS-0.3.10) registers over the local HTTPS origin.

**Acceptance criteria:**
- A documented local HTTPS workflow exists; dev certificates are gitignored.
- With `DEV_HTTPS=true`, the dev servers serve over `https://localhost` with a locally-trusted cert.
- The strict CSP and security headers are present in development responses.
- `Secure`/`__Host-` cookies and the service worker function over local HTTPS.
- Any HMR-related CSP relaxation is dev-only, documented, and absent from production builds.

**Testing:**
- Run with `DEV_HTTPS=true`; load `https://localhost`; verify no certificate warning (mkcert CA trusted) and the CSP header is present.
- Verify a `__Host-`-prefixed `Secure` cookie is accepted by the browser locally.
- Verify the service worker registers over HTTPS.
- Build for production; verify no dev-only CSP relaxation appears in the production header (string-compare against WS-0.5.1a).

**Dependencies:** WS-0.5.1a, WS-0.5.2b, WS-0.3.10, WS-0.7.2.

**Security (Section 25.2, 20.2):** Developing against the same strict headers and a real secure context closes the "works in dev, breaks under CSP in prod" gap that otherwise tempts developers to weaken the production CSP. It lets `Secure`/`__Host-` cookie and service-worker security be validated locally, and guarantees the dev-only HMR relaxation never leaks into the shipped policy.

---

## Task dependency summary

The table lists every atomic task, its group, and its direct task-level dependencies (predecessors that must be merged first). External-workstream dependencies are noted where relevant. Tasks with "None" can start immediately at the beginning of Wave 1.

| Task | Title | Depends on |
|---|---|---|
| WS-0.1.1 | Create .gitignore | None |
| WS-0.1.2 | LICENSE → AGPL-3.0-or-later | None |
| WS-0.1.3 | Create CLAUDE.md | WS-0.1.2, WS-0.2.1 |
| WS-0.1.4 | Editor & commit hygiene config | WS-0.1.1 |
| WS-0.1.5 | Contribution & security policy docs | WS-0.1.3 |
| WS-0.2.1 | Initialize pnpm workspace | WS-0.1.1, WS-0.1.2 |
| WS-0.2.2 | TypeScript strict mode | WS-0.2.1 |
| WS-0.2.3 | Workspace dependency boundaries | WS-0.2.1, WS-0.2.2 |
| WS-0.2.4 | Dependency-budget enforcement | WS-0.2.1, WS-0.3.2, WS-0.3.3 |
| WS-0.3.1a | Vite 8 base config | WS-0.2.1, WS-0.2.2 |
| WS-0.3.1b | Vite production build validation | WS-0.3.1a, WS-0.3.2 |
| WS-0.3.1c | SRI manifest & bundle-size scripts | WS-0.3.1a, WS-0.3.1b |
| WS-0.3.2 | Initialize React 19 | WS-0.3.1a |
| WS-0.3.3 | Initialize Hono BFF | WS-0.2.1, WS-0.2.2 |
| WS-0.3.4a | Tailwind CSS 4 (CSS-first) | WS-0.3.1a, WS-0.3.2 |
| WS-0.3.4b | Design tokens & dark mode | WS-0.3.4a |
| WS-0.3.5 | Shared package with zod | WS-0.2.1, WS-0.2.2, WS-0.2.3 |
| WS-0.3.6 | DB package with Drizzle | WS-0.2.3, WS-0.3.5 |
| WS-0.3.7 | Invariants package | WS-0.2.3, WS-0.3.5 |
| WS-0.3.8 | Structured logging (pino) | WS-0.3.3 |
| WS-0.3.9 | Client state/router/query libs | WS-0.3.2, WS-0.3.1c, WS-0.2.4 |
| WS-0.3.10 | vite-plugin-pwa (Workbox 7) | WS-0.3.1a, WS-0.3.1b, WS-0.3.2 |
| WS-0.3.11 | Root dev orchestration | WS-0.3.2, WS-0.3.3, WS-0.3.5, WS-0.3.6, WS-0.3.7, WS-0.2.4 |
| WS-0.4.1a | Biome formatter | WS-0.2.1 |
| WS-0.4.1b | Biome security lint rules | WS-0.4.1a |
| WS-0.4.1c | Biome import/quality rules | WS-0.4.1a |
| WS-0.4.2 | Configure Vitest | WS-0.3.2, WS-0.3.3, WS-0.3.5, WS-0.3.6, WS-0.3.7 |
| WS-0.4.3 | Configure Playwright + axe | WS-0.3.2, WS-0.3.10, WS-0.4.2 |
| WS-0.4.4 | Configure lockfile-lint | WS-0.2.1 |
| WS-0.4.5 | Pre-commit hooks | WS-0.4.1b, WS-0.4.1c, WS-0.2.4, WS-0.4.4 |
| WS-0.5.1a | CSP & core security headers | WS-0.3.3, WS-0.3.8 |
| WS-0.5.1b | CSP reporting & Permissions-Policy | WS-0.5.1a, WS-0.3.8, WS-0.5.3 |
| WS-0.5.2a | CORS configuration | WS-0.3.3, WS-0.5.3 |
| WS-0.5.2b | CSRF protection | WS-0.5.2a, WS-0.7.2, WS-0.5.3 |
| WS-0.5.3 | Env variable validation | WS-0.3.5, WS-0.3.3 |
| WS-0.5.4 | Trusted Types policy (client) | WS-0.5.1a, WS-0.3.2, WS-0.3.10 |
| WS-0.5.5 | Provenance & SBOM scaffolding | WS-0.2.1, WS-0.3.1c, WS-0.2.4 |
| WS-0.6.1a | CI workflow structure | WS-0.1.4, WS-0.2.1 |
| WS-0.6.1b | Lint/typecheck/lockfile/dep-budget jobs | WS-0.6.1a, WS-0.4.1b, WS-0.4.1c, WS-0.4.4, WS-0.2.4, WS-0.2.2 |
| WS-0.6.1c | Test/coverage/bundle-size jobs | WS-0.6.1a, WS-0.4.2, WS-0.3.1b, WS-0.3.1c |
| WS-0.6.1d | E2E + accessibility job | WS-0.6.1c, WS-0.4.3, WS-0.5.1a |
| WS-0.6.1e | Security audit job | WS-0.6.1a, WS-0.4.4, WS-0.3.1b, WS-0.5.5 |
| WS-0.6.1f | Branch protection & required checks | WS-0.6.1b, WS-0.6.1c, WS-0.6.1d, WS-0.6.1e, WS-0.1.5 |
| WS-0.6.2 | Dependency scanning | WS-0.6.1f |
| WS-0.6.3 | CodeQL static analysis | WS-0.6.1a |
| WS-0.7.1 | Development scripts | WS-0.3.11, WS-0.2.4, WS-0.5.5, WS-0.3.6 |
| WS-0.7.2 | Docker Compose local services | WS-0.1.1, WS-0.5.3, WS-0.3.6 |
| WS-0.7.3 | Local HTTPS & header parity | WS-0.5.1a, WS-0.5.2b, WS-0.3.10, WS-0.7.2 |

**Critical path (longest dependency chain):** WS-0.1.1 → WS-0.2.1 → WS-0.2.2 → WS-0.3.1a → WS-0.3.2 → WS-0.3.1b → WS-0.3.1c → WS-0.5.5 → WS-0.6.1e → WS-0.6.1f → WS-0.6.2. The security-header and CSRF chain (WS-0.3.3 → WS-0.5.3 → WS-0.5.2a → WS-0.5.2b, requiring WS-0.7.2) runs in parallel and converges at WS-0.6.1d/WS-0.7.3.

---

## Workstream definition of done

WS-0 is complete when ALL of the following conditions hold. Each clause maps to the task groups above and to the M0 "Repository" gate in `00-index.md`.

1. **Repository hygiene:** `.gitignore` prevents secret and artifact commits and allow-lists `.env.example` (WS-0.1.1). LICENSE is AGPL-3.0-or-later with SPDX identifier (WS-0.1.2). `CLAUDE.md` accurately documents the project, dependency budgets, and the dependency-addition checklist (WS-0.1.3). `.editorconfig`, `.gitattributes`, and `.nvmrc` enforce cross-OS consistency and a pinned runtime (WS-0.1.4). `SECURITY.md`, `CODE_OF_CONDUCT.md`, and `CONTRIBUTING.md` exist with a private disclosure channel and the contribution/CI policy (WS-0.1.5). Root `package.json` has correct license, `private: true`, pinned `packageManager`, and `engines` fields.

2. **Monorepo structure:** pnpm workspace is initialized with all five workspaces (`apps/web`, `apps/api`, `packages/shared`, `packages/db`, `packages/invariants`); `pnpm install --frozen-lockfile` succeeds (WS-0.2.1). Phantom dependencies are prevented and Corepack enforces the pnpm version. TypeScript strict mode (`strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, plus the hardening flags) passes across all workspaces (WS-0.2.2). Dependency boundaries are enforced, including the hard rule that `apps/web` cannot import `@licio/db` (WS-0.2.3). The dependency-budget check passes and is wired into CI, with `apps/web` < 15 and `apps/api` < 20 production deps (WS-0.2.4).

3. **Build tooling:** Vite 8 produces builds with content-hashed, deterministic filenames and no production source maps (WS-0.3.1a); the build validation gate enforces zero inline scripts, styles, and event-handler attributes (WS-0.3.1b); an SRI manifest and a within-budget bundle-size report are generated every build (WS-0.3.1c). React 19 renders in dev and production with a clean inline-script-free `index.html` (WS-0.3.2). Hono BFF responds on `/health` via the factory pattern (WS-0.3.3). Tailwind CSS 4 compiles to static CSS using `@import "tailwindcss"` CSS-first config with no `tailwind.config.js`, design tokens, and dark/reduced-motion/high-contrast support (WS-0.3.4a/b). The shared (zod), db (Drizzle, SQL-first), and invariants packages build and export types correctly, with `InvariantOutput` carrying confidence/coverage/reason-codes/fallback (WS-0.3.5/6/7). Structured pino logging is operational with explicit redaction of auth headers, cookies, secrets, and wallet seed phrases/keys (WS-0.3.8). TanStack Router/Query and Zustand are wired within the dependency budget, with the zod-validated-response convention documented (WS-0.3.9). vite-plugin-pwa (Workbox 7) emits a scope-locked service worker and a same-origin standalone manifest with prompt-based updates and no inline registration script (WS-0.3.10). Root-level dependency-ordered orchestration scripts work (WS-0.3.11).

4. **Code quality:** Biome formatter is configured (WS-0.4.1a). Biome security lint rules block `eval`, `new Function`, `dangerouslySetInnerHTML`, `innerHTML`/`outerHTML` assignment, `document.write`, `javascript:` URLs, and explicit `any` (outside designated type-utility files) at `error` severity (WS-0.4.1b). Import organization, strict equality, `node:` import protocol, and no-`console.log`-in-BFF rules are enforced (WS-0.4.1c). Vitest runs across all workspaces with an 80% coverage threshold (WS-0.4.2). Playwright runs E2E across Chromium/Firefox/WebKit with axe-core WCAG 2.2 AA checks and a real-browser CSP-enforcement assertion (WS-0.4.3). lockfile-lint validates registry and integrity (WS-0.4.4). Pre-commit/pre-push hooks provide fast local lint/secret/typecheck gating (WS-0.4.5).

5. **Security baseline:** Hono sets the exact strict CSP (`default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; worker-src 'self'; manifest-src 'self'; frame-ancestors 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; require-trusted-types-for 'script'`) with no `'unsafe-inline'`/`'unsafe-eval'`, plus HSTS preload, nosniff, Referrer-Policy, and COOP/CORP (WS-0.5.1a). CSP violations are reported to a validated, rate-limited audit endpoint and a restrictive Permissions-Policy disables payment/sensor/camera/mic/geolocation (WS-0.5.1b). CORS restricts to the PWA domain by exact-match set membership, never `*` with credentials (WS-0.5.2a). CSRF tokens (per-session nonces, constant-time comparison, Redis-backed) protect state-changing requests; session cookies are `HttpOnly`, `Secure`, `SameSite=Strict`, `__Host-` prefixed (WS-0.5.2b). Environment variables are validated with zod and fail closed before the port binds, with a hard `VITE_`/server split so no server secret can enter the client (WS-0.5.3). A Trusted Types policy is wired so `require-trusted-types-for 'script'` is satisfiable, with DOMPurify returning `TrustedHTML` and a restrictive default policy (WS-0.5.4). An SBOM is generated every build with an AGPL license cross-check, and the signed-provenance artifact contract is reserved for WS-O.3 (WS-0.5.5).

6. **CI/CD:** GitHub Actions CI runs on every PR with least-privilege permissions and SHA-pinned actions (WS-0.6.1a); parallel jobs cover lint, typecheck, lockfile-lint, dependency-budget (WS-0.6.1b), tests with coverage and build with inline-script validation, SRI, and bundle-size gating (WS-0.6.1c), E2E with accessibility and CSP enforcement (WS-0.6.1d), and a security audit with pnpm audit, secret scanning, install-script flagging, and SBOM generation (WS-0.6.1e). Branch protection on `main` makes all of these required checks with mandatory review and no force-push (WS-0.6.1f). Dependency scanning creates automated update PRs gated on the full check set (WS-0.6.2). CodeQL `security-extended` static analysis runs on PRs, pushes, and weekly (WS-0.6.3).

7. **Development environment:** All root-level scripts work (`dev`, `build`, `test`, `test:e2e`, `lint`, `typecheck`, `check:deps`, `sbom`, `db:*`, `clean`) and match what CI runs (WS-0.7.1). Docker Compose starts PostgreSQL 16 and Redis 7 with digest-pinned images, health checks, persistent volumes, and a documented `.env.example` matching the env schema field-for-field (WS-0.7.2). An optional local-HTTPS workflow applies the strict headers in development so `Secure`/`__Host-` cookies, the service worker, and CSP behave faithfully, with any HMR relaxation provably absent from production (WS-0.7.3). A new developer can clone the repo, run `pnpm install && docker compose up -d && pnpm dev`, and have a fully working, security-faithful development environment.

8. **Cross-cutting:** TypeScript strict mode passes across all workspaces with zero errors. No inline scripts, styles, or event-handler attributes exist in any build output (verified by the build gate and asserted in a real browser by E2E). No secrets are committed (filename and content scanning) and no secret can reach the client bundle (env split + `@licio/db` boundary). The dependency graph has no cycles and stays within budget. Strict CSP with `require-trusted-types-for 'script'` is enforced in real browsers, not merely present as a header. Every acceptance criterion in every sub-task is met, and `main` is protected so none of these gates can be merged around.

# Contributing to Licio

Thank you for your interest in contributing to Licio. This document describes the
development workflow, quality gates, and security requirements.

## Prerequisites

- Node.js 22+ (see `.nvmrc`)
- pnpm 9+ (enforced via Corepack and the `packageManager` field)
- Docker & Docker Compose — optional, only for running dev against a real
  PostgreSQL/Redis (basic `pnpm dev` uses in-memory stores)

## Getting Started

```bash
git clone https://github.com/hatter6822/temp_licio.git
cd temp_licio
corepack enable
pnpm install
pnpm dev   # zero setup: in-memory stores + seeded demo data
```

To run dev against a real database/cache instead, start the stack and pass the
connection URLs (see the README "Quick start"):

```bash
docker compose up -d
DATABASE_URL=postgres://licio:licio_dev@localhost:5432/licio_dev \
REDIS_URL=redis://localhost:6379 pnpm dev
```

## Branch & PR Workflow

1. Create a feature branch from `main`
2. Make changes following the coding conventions in `CLAUDE.md`
3. Ensure all CI gates pass locally before pushing:
   - `pnpm lint` — formatting and linting
   - `pnpm typecheck` — TypeScript strict-mode check
   - `pnpm test` — unit tests with coverage
   - `pnpm check:deps` — dependency budget
   - `pnpm check:workspace-deps` — workspace boundary enforcement
4. Push and open a PR against `main`
5. All CI checks must pass before merge
6. At least one approving review is required (repository admins are exempt from
   the review COUNT only — see **Merge constraints** below)
7. Merge with a **merge commit**: `gh pr merge <n> --merge`.  Squash and rebase
   merging are disabled on the repository, so this is the only option the API
   will accept

## Branch Protection (`main`)

The `main` branch is protected with the following settings to ensure the CI
security gates are mandatory, not advisory:

**Required status checks (all must pass):**
- `Lint & Format` — Biome formatting and security lint rules
- `Type Check` — TypeScript strict-mode across all workspaces
- `Lockfile Integrity` — registry and integrity hash validation
- `Dependency Budget` — production dependency count enforcement
- `Test & Coverage` — unit tests with 80% coverage threshold
- `Build & Size Check` — zero inline scripts/styles, SRI, bundle-size budgets
- `E2E Tests` — Playwright across Chromium/Firefox/WebKit with axe-core a11y
- `Security Audit` — dependency audit, secret scan, SBOM generation
- `Native Courier APK (WS-R.15.4a)` — the Capacitor shell builds from the web bundle
- `CodeQL Analysis` — `security-extended` static analysis

**Merge constraints:**
- Every change reaches `main` through a pull request — direct pushes are blocked
- Branches must be up to date with `main` before merging
- Every review conversation must be resolved before merging
- Force-pushes to `main` are blocked; deletion of `main` is blocked
- At least one approving review; stale approvals are dismissed on new pushes
- **Merge commits only — never squash.**  A PR's commits are the durable
  engineering record: `CLAUDE.md` deliberately keeps per-audit and per-workstream
  completion detail in commit messages rather than in the doctrine files, and
  squashing collapses that record into a single blob.  It also destroys the
  boundaries a reviewer and `git bisect` depend on — original work, follow-up
  findings, and review-response fixes stop being separable.  A merge commit keeps
  every commit AND records which commits formed which PR, so
  `git log --first-parent` reads as one entry per PR while `git log` still shows
  the full history.

**How this is enforced.**  Two rulesets on `refs/heads/main`, plus the repository
merge-method settings.  The split exists because a bypass applies to a whole
ruleset, and only the review COUNT should be waivable:

| Ruleset | Bypass | Rules |
|---|---|---|
| `main-core` | **none** — applies to admins too | `pull_request` (0 approvals, `merge` only, conversation resolution), `required_status_checks` (all ten, strict), `non_fast_forward`, `deletion` |
| `main-review` | repository admin | `pull_request` (1 approval) |

GitHub does not let an author approve their own pull request, so on a
single-maintainer repository an unwaivable review requirement would block every
merge.  Putting the count in its own bypassable ruleset means the maintainer can
land their own work today, a second contributor gets a real review gate the
moment they exist, and **no one — admin included — can push directly to `main`,
force-push it, delete it, or merge past a red CI gate.**

Do NOT express this with classic branch protection: its `enforce_admins` flag is
all-or-nothing, so waiving the review count for the maintainer would also waive
the direct-push and force-push blocks.  That was verified by trying it — an admin
push to `main` succeeded until the rulesets replaced it.

Squash and rebase merging are additionally disabled at the repository level
(`allow_squash_merge: false`, `allow_rebase_merge: false`), so the wrong merge
method fails at the API rather than silently rewriting history.

These settings ensure that no code reaches `main` without passing every security
gate, and that the history it lands with is the history that was reviewed.

## CI Gates (Required for Merge)

No PR merges with a failing CI gate.  These are the SAME ten checks the
`main-core` ruleset requires above — the two lists are one inventory described
twice (job name here, check name there) and must not drift apart:

| Job (`ci.yml`) | Required check name | What it enforces |
|---|---|---|
| `lint` | `Lint & Format` | Biome formatting and lint rules (security rules at `error` severity) |
| `typecheck` | `Type Check` | TypeScript strict mode across all workspaces |
| `lockfile-lint` | `Lockfile Integrity` | Lockfile integrity (registry and integrity hash validation) |
| `dep-budget` | `Dependency Budget` | Dependency budgets (`apps/web` < 15, `apps/api` < 20) |
| `test` | `Test & Coverage` | Unit tests with the 80% coverage threshold (lines, functions, branches, statements) |
| `build-and-size` | `Build & Size Check` | Build validation (zero inline scripts/styles), SRI, bundle-size budget |
| `e2e` | `E2E Tests` | Playwright across Chromium, Firefox, WebKit with axe-core WCAG 2.2 AA checks |
| `security` | `Security Audit` | Dependency audit, secret scan, SBOM generation |
| `courier-apk` | `Native Courier APK (WS-R.15.4a)` | The Capacitor shell builds from the web bundle (byte-identity no-fork gate) |
| (`codeql.yml`) | `CodeQL Analysis` | `security-extended` static analysis |

## Adding Dependencies

Every new direct production dependency requires review. Follow the checklist in `CLAUDE.md`:

1. Maintainer trust assessment
2. Transitive dependency count
3. **Install scripts must be NONE** — no postinstall/preinstall/install scripts
4. AGPL-3.0-or-later license compatibility
5. Consider Web API alternatives first

## Commit Messages

```
type(scope): description

Types: feat, fix, refactor, docs, test, chore, security, perf
Scope: web, api, shared, db, invariants, ci, docs
```

### Signed Commits (Recommended)

We recommend signing commits with GPG or SSH keys. Signed commits provide
cryptographic proof of authorship and are required for verified badges on GitHub.

```bash
# Configure GPG signing
git config --global commit.gpgsign true
git config --global user.signingkey YOUR_GPG_KEY_ID

# Or use SSH signing (Git 2.34+)
git config --global gpg.format ssh
git config --global user.signingkey ~/.ssh/id_ed25519.pub
git config --global commit.gpgsign true
```

## SPDX License Headers

All new source files must include:
```
// SPDX-License-Identifier: AGPL-3.0-or-later
```

## Local HTTPS Development (Optional)

Several security mechanisms require HTTPS or a secure context: `Secure` and
`__Host-` cookies, Service Workers (beyond `localhost`), HSTS, and some Trusted
Types behaviors. An optional local HTTPS workflow lets you develop and test
these faithfully.

### Setup with mkcert

```bash
# Install mkcert (macOS)
brew install mkcert
mkcert -install

# Install mkcert (Linux)
# See https://github.com/FiloSottile/mkcert#installation

# Generate dev certificates (from the repo root)
mkcert -cert-file localhost.pem -key-file localhost-key.pem localhost 127.0.0.1 ::1
```

The generated `*.pem` files are gitignored (WS-0.1.1). Never commit certificates.

### Running with HTTPS

Set the `DEV_HTTPS` environment variable to enable HTTPS on the dev servers:

```bash
DEV_HTTPS=true pnpm dev
```

- **Vite dev server**: reads `localhost.pem`/`localhost-key.pem` from the repo root
  and serves on `https://localhost:5173`
- **Hono BFF**: reads the same certs and serves on `https://localhost:3001`

### What changes with HTTPS

- `__Host-session` cookies are fully functional (browsers require `Secure` flag)
- The service worker registers and operates over a secure origin
- HSTS headers are respected by the browser
- CSP and security headers behave identically to production

### HMR WebSocket

Vite's HMR WebSocket connection may need a `wss://` upgrade when using HTTPS.
This is handled automatically by Vite when the `server.https` config is present.
No CSP relaxation is needed for HMR — it uses same-origin WebSocket which is
covered by `connect-src 'self'`.

## Security

- See `SECURITY.md` for vulnerability reporting
- Never commit secrets, keys, or `.env` files
- All user-generated content must be sanitized via DOMPurify with Trusted Types
  (`RETURN_TRUSTED_TYPE: true`)
- SQL queries must use Drizzle parameterized queries only
- CSRF tokens are required for all state-changing requests (POST/PATCH/DELETE)
- Session cookies use `HttpOnly`, `Secure`, `SameSite=Strict`, `__Host-` prefix
- Follow the security constraints documented in `CLAUDE.md`

# WS-0 Foundation Implementation Notes

This document records how the repository foundation maps to `docs/planning/01-repository-foundation.md`.

## Repository hygiene

- `.gitignore` blocks dependencies, build artifacts, test output, logs, local environment files, certificates, keys, Docker volumes, and unsigned supply-chain artifacts while allowing `.env.example`.
- `.editorconfig`, `.gitattributes`, and `.nvmrc` normalize LF/UTF-8 formatting and pin the Node major version to 22.
- `SECURITY.md`, `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, and `CLAUDE.md` document governance, disclosure, dependency review, and local conventions.

## Monorepo and build tools

The workspace is intentionally small and explicit:

1. `packages/shared` builds first and owns environment schemas and logging redaction.
2. `packages/db` and `packages/invariants` build after shared.
3. `apps/web` and `apps/api` build last.

`pnpm check:deps` enforces direct production dependency budgets, declared bare imports, allowed first-party package dependencies, and cross-package relative-import boundaries. The web app is forbidden from importing `@licio/db` by package manifest or path traversal.

## Security gates

- `scripts/validate-build.ts` parses the built HTML with `parse5` and fails closed on inline scripts, inline styles, inline event handlers, or `javascript:` URLs.
- `scripts/generate-sri.ts` writes SHA-384 SRI digests for emitted JS/CSS assets.
- `scripts/check-bundle-size.ts` writes `bundle-size.json` and enforces the initial JS/CSS gzip budgets.
- `scripts/check-security-patterns.ts` complements Biome by scanning for unsafe DOM/string-code patterns not covered by Biome's built-in rules.
- `scripts/generate-sbom.ts` emits a CycloneDX-shaped workspace SBOM scaffold and verifies workspace package license metadata.
- CSP report ingestion is rate-limited, JSON-schema validated, and capped at 16 KiB before logging so violation reports cannot become an unbounded memory/logging sink.

## Local services

`docker-compose.yml` provides digest-pinned PostgreSQL and Redis images for local development only. Real secrets belong in an untracked `.env` file; `.env.example` documents safe placeholder values. The API startup path reads `.env`/`.env.local`, rejects the documented placeholder `SESSION_SECRET`, and uses an ephemeral generated development-only session secret when no local secret exists; production still fails closed before binding if required server variables are missing. Use `pnpm db:up` and `pnpm db:down` to manage the local service stack. Use `pnpm dev:https` to run the PWA dev server over a generated, short-lived localhost certificate so service-worker and secure-cookie behavior can be checked during local development.

## Remaining production handoffs

WS-0 now enforces local and CI gates in source control. Repository administrators still need to apply the branch-protection settings in `docs/development/branch-protection.md` in GitHub because those rules live outside the git tree.

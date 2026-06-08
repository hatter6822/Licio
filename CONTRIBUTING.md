# Contributing to Licio

Licio is a security-sensitive AGPL-3.0-or-later PWA and API. Contributions must preserve the strict client/server boundary, dependency budget, CSP, and reproducible-build posture established by WS-0.

## Branches and commits

- Use short-lived branches named `workstream/<id>-<topic>` or `fix/<topic>`.
- Use Conventional Commits (`feat:`, `fix:`, `docs:`, `test:`, `chore:`).
- New source files must be compatible with the repository AGPL-3.0-or-later license and package metadata. Where a source-file header is practical, include `SPDX-License-Identifier: AGPL-3.0-or-later`.

## Pull request requirements

No PR may merge with a failing CI gate. Required checks include install, lint/security scan, typecheck, dependency boundaries, lockfile lint, tests with coverage, build validation, SBOM generation, and security audit.

Every PR must include:

- A clear description and linked workstream/task IDs.
- Tests for behavior and security controls changed by the PR.
- Documentation updates for user-facing or developer-facing changes.
- Review approval from a maintainer.

## Dependency-addition checklist

Every direct production dependency expands the supply-chain attack surface. Before adding one:

1. Verify it is necessary and cannot be replaced by a small first-party implementation.
2. Confirm the package is actively maintained, correctly licensed, and has no known critical vulnerabilities.
3. Confirm it respects the dependency budgets: `apps/web` must remain below 15 direct production dependencies and `apps/api` below 20, excluding `workspace:*` first-party packages.
4. Run `pnpm check:deps`, `pnpm check:lockfile`, and `pnpm security:audit`; every source import must be declared by that workspace package and cross-package relative imports are forbidden.
5. Document why the dependency belongs in the affected package.

## Security rules

- Never commit `.env` files, private keys, seed phrases, session secrets, certificates, or production credentials.
- Do not use `eval`, `new Function`, `dangerouslySetInnerHTML`, `innerHTML` assignment, `document.write`, or `javascript:` URLs.
- Server secrets must never be referenced in client code. Only `VITE_` variables may enter the browser bundle.
- Keep the API CORS allow-list exact-match only; never use `*` with credentials.

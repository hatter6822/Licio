# Branch Protection Requirements

Configure the `main` branch in GitHub rulesets before accepting external contributions.

Required settings:

- Require pull requests before merging.
- Require at least one approving maintainer review.
- Dismiss stale approvals when new commits are pushed.
- Require conversation resolution before merge.
- Require linear history.
- Block force pushes and branch deletion.
- Require the following status checks:
  - `install`
  - `lint-typecheck`
  - `test-build`
  - `e2e-accessibility-csp`
  - `security-audit`
  - `codeql`
- Require branches to be up to date before merging.
- Do not allow bypasses except for repository administrators during declared incidents.

This document is the source-controlled branch-protection contract; repository administrators must keep the GitHub ruleset aligned with it.

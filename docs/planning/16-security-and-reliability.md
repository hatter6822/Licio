# WS-O: Security, Reliability, and Incident Response

**Milestone:** M0-M6
**Priority:** P0
**Dependencies:** WS-0 (repository foundation)
**Wave:** 2+6
**Estimated duration:** Continuous

---

## Overview

Security is a release gate at every milestone. This is a continuous workstream, not a one-time phase. Licio's combined UGC + wallet surface makes XSS the dominant risk: a single injection could trigger a malicious wallet signature and drain funds (Section 25.2). Defense-in-depth against XSS is therefore paramount, followed by auth/session hardening, API authorization, and wallet-specific security. Incident response covers severity classification, escalation, rollback, and treasury-specific procedures. Reproducible builds and supply-chain provenance ensure that no backdoored bundle can be served without public evidence. Every security test described here runs in CI and is a merge-blocking gate for relevant code paths.

---

## WS-O.1 Security testing

### WS-O.1.1a OWASP XSS vector testing
**ID:** WS-O.1.1a
**Ref:** Section 25.2

**Description:**
Build an automated test suite that runs every XSS vector from the OWASP XSS Cheat Sheet against every user-generated-content rendering path in the application. UGC rendering paths include: story cards (title, source summary, context chips), thread contributions (body, citations), room descriptions, user profiles (display name, bio if present), evidence cards (relevance notes, citations), context cards (summary text), and AI-generated summaries. Each vector is injected into each rendering path and the test verifies that: (1) the injected script does not execute (no alert, no network request, no DOM mutation beyond the sanitized output); (2) the output is sanitized by DOMPurify through the Trusted Types pipeline; (3) no raw HTML is rendered -- all output passes through the allow-list sanitizer. The test suite uses Playwright to render the component in a real browser context and verify that no script executes.

**Acceptance criteria:**
- Every OWASP XSS Cheat Sheet vector is tested against every UGC rendering path.
- Zero vectors result in script execution.
- Test results include the vector, the rendering path, and the sanitized output for audit.
- The test suite runs in CI on every PR that modifies UGC rendering, sanitization, or CSP configuration.
- New UGC rendering paths must be added to the test suite before merging (enforced by code review checklist).

**Testing:**
- E2E: Playwright tests inject each vector and assert no script execution (no `alert`, no injected network requests, no DOM mutations outside the sanitized container).
- CI: Test suite is a required check in GitHub Actions.

---

### WS-O.1.1b Trusted Types violation detection
**ID:** WS-O.1.1b
**Ref:** Section 25.2

**Description:**
Implement automated testing that verifies Trusted Types enforcement across the application. The test suite must prove that any call to `innerHTML`, `document.write`, `eval`, `setTimeout(string)`, `setInterval(string)`, or `new Function(string)` that does not go through a registered Trusted Types policy triggers a violation. The test is run in a browser context (Playwright) with Trusted Types enforcement enabled (`require-trusted-types-for 'script'`). The test navigates through all major application routes and interactions, and asserts that zero Trusted Types violations are logged. If a violation occurs, the test captures the call site (stack trace) and the violating value for debugging.

**Acceptance criteria:**
- Trusted Types are enforced in the test browser context via CSP header.
- Zero Trusted Types violations occur during a full application navigation (all routes, all UGC rendering paths, all dynamic content loading).
- Any violation is captured with stack trace and violating value.
- The test suite runs in CI on every PR.
- New routes or dynamic content paths are covered by extending the navigation in the test.

**Testing:**
- E2E: Playwright navigates all routes with a violation listener that fails the test on any Trusted Types violation.
- CI: Required check in GitHub Actions.

---

### WS-O.1.1c CSP bypass testing
**ID:** WS-O.1.1c
**Ref:** Section 25.2

**Description:**
Implement a test suite that attempts to bypass the Content Security Policy. Tests include: (1) inline script injection -- inject `<script>alert(1)</script>` into UGC and verify it is blocked by CSP; (2) eval injection -- attempt to execute `eval()` from UGC context and verify it is blocked; (3) external script injection -- inject `<script src="https://evil.example.com/malware.js">` and verify it is blocked by `default-src 'self'`; (4) data URI injection -- inject `<a href="data:text/html,<script>alert(1)</script>">` and verify it is blocked; (5) javascript URI injection -- inject `<a href="javascript:alert(1)">` and verify it is stripped by the sanitizer and blocked by CSP; (6) object/embed injection -- inject `<object>` and `<embed>` tags and verify blocked by `object-src 'none'`; (7) base tag injection -- inject `<base href="https://evil.example.com">` and verify blocked by `base-uri 'self'`; (8) style injection with expression/behavior -- inject CSS expressions and verify blocked. Each test runs in Playwright with the production CSP headers.

**Acceptance criteria:**
- All eight CSP bypass categories are tested.
- Zero bypasses succeed -- all injected content is blocked by CSP or stripped by the sanitizer.
- Tests run with the exact CSP headers used in production (verified by reading the response headers).
- Test results document each attempt and the blocking mechanism (CSP directive, sanitizer rule).
- The test suite runs in CI on every PR that modifies CSP configuration or UGC rendering.

**Testing:**
- E2E: Playwright tests inject each bypass attempt and verify no script execution, no external resource loading, no base URI change.
- CI: Required check in GitHub Actions.

---

### WS-O.1.1d Code audit
**ID:** WS-O.1.1d
**Ref:** Section 25.2

**Description:**
Implement a CI check that audits the codebase for unsafe DOM access patterns. The check scans all TypeScript, TSX, and JavaScript files for: `dangerouslySetInnerHTML` (must be zero or wrapped in a DOMPurify call within 3 lines), `innerHTML` assignment (must be zero outside DOMPurify), `document.write` (must be zero), `eval()` (must be zero), `new Function()` (must be zero), `setTimeout` or `setInterval` with string arguments (must be zero). The check uses a combination of Biome lint rules (configured in WS-0) and a custom script that performs AST-based detection for patterns Biome cannot catch. Any violation fails the CI check with the file path, line number, and the unsafe pattern found. DOMPurify-wrapped `dangerouslySetInnerHTML` is allowed only when the wrapping is verified structurally (not just by proximity).

**Acceptance criteria:**
- CI check scans all source files for the six unsafe DOM patterns.
- Zero violations in the current codebase at the time of merge.
- Any new violation fails the CI check with file path, line number, and pattern.
- DOMPurify-wrapped `dangerouslySetInnerHTML` is allowed only with structural verification.
- The check runs on every PR.
- False positives are documented and suppressed with inline comments that require a security justification.

**Testing:**
- Unit: Test the scanner against known-good and known-bad code samples. Verify detection of each pattern. Verify DOMPurify-wrapped patterns are allowed.
- CI: Required check in GitHub Actions.

---

### WS-O.1.2a Credential brute-force test
**ID:** WS-O.1.2a
**Ref:** Section 25.3

**Description:**
Implement a test that verifies progressive delays and account lockout for credential brute-force attacks. The test attempts repeated failed login attempts against a test account and verifies: (1) after N failed attempts (configurable, default 5), the response time increases progressively (exponential backoff or fixed delays); (2) after M failed attempts (configurable, default 10), the account is temporarily locked and all login attempts return a lockout response; (3) the lockout duration is configurable (default 15 minutes); (4) successful login after lockout expiry resets the counter; (5) rate limiting applies per account and per IP independently; (6) the lockout response does not reveal whether the account exists (same response for nonexistent accounts).

**Acceptance criteria:**
- Progressive delays are observable after the threshold number of failed attempts.
- Account lockout engages after the lockout threshold.
- Lockout duration matches the configured value.
- Successful login after lockout expiry works and resets the counter.
- Rate limits apply per account and per IP.
- Lockout response is identical for existing and nonexistent accounts (no account enumeration).

**Testing:**
- Integration: Attempt 15 failed logins against a test account. Verify progressive delays after attempt 5. Verify lockout after attempt 10. Wait for lockout expiry, verify successful login. Repeat with a nonexistent account, verify identical responses.

---

### WS-O.1.2b Session fixation test
**ID:** WS-O.1.2b
**Ref:** Section 25.3

**Description:**
Implement a test that verifies session ID regeneration after authentication. The test: (1) creates a pre-authentication session (e.g., by visiting a public page); (2) records the session ID; (3) authenticates; (4) verifies that the post-authentication session ID is different from the pre-authentication session ID; (5) verifies that the old session ID is invalidated and cannot be used to access authenticated resources. This prevents session fixation attacks where an attacker sets a known session ID and waits for the victim to authenticate.

**Acceptance criteria:**
- Session ID changes after successful authentication.
- The pre-authentication session ID is invalidated after authentication.
- Attempting to use the old session ID returns 401/403.
- The test covers both WebAuthn and email/password authentication paths.

**Testing:**
- Integration: Record session ID before login. Authenticate. Verify new session ID. Use old session ID to access a protected endpoint -- verify rejection.

---

### WS-O.1.2c Session hijacking prevention test
**ID:** WS-O.1.2c
**Ref:** Sections 25.2, 25.3

**Description:**
Implement a test that verifies session cookie security attributes. The test inspects the `Set-Cookie` header on authentication responses and verifies: (1) `HttpOnly` flag is present (prevents JavaScript access); (2) `Secure` flag is present (cookies sent only over HTTPS); (3) `SameSite=Strict` is set (prevents cross-site request attachment) or `SameSite=Lax` with CSRF token for cross-site posts; (4) cookie `Path` is set to the minimum required scope; (5) cookie `Max-Age` or `Expires` is set to a reasonable session duration. The test also verifies that session tokens are not transmitted in URLs, local storage, or non-HttpOnly cookies.

**Acceptance criteria:**
- Session cookies have `HttpOnly`, `Secure`, and `SameSite=Strict` (or `Lax` with CSRF).
- Cookie `Path` is scoped appropriately.
- Session tokens are not present in URLs, localStorage, or non-HttpOnly cookies.
- All assertions pass on both WebAuthn and email/password auth flows.

**Testing:**
- Integration: Authenticate and inspect response headers. Verify all cookie attributes. Attempt to read the session cookie from JavaScript (Playwright `page.evaluate`) -- verify failure (HttpOnly). Check localStorage and URL for session tokens -- verify absent.

---

### WS-O.1.2d Token replay test
**ID:** WS-O.1.2d
**Ref:** Section 25.3

**Description:**
Implement a test that verifies used nonces and tokens are rejected on reuse. The test covers: (1) CSRF tokens -- use a CSRF token for a state-changing request, then attempt to reuse the same token for another request; verify rejection; (2) WebAuthn challenge nonces -- capture a WebAuthn challenge, complete authentication, then attempt to replay the same challenge; verify rejection; (3) wallet signing nonces -- capture a wallet signing nonce (SIWE), complete the signing flow, then attempt to replay the signed message with the same nonce; verify rejection. Each replay attempt must return an appropriate error (400 or 403) and not result in a successful action.

**Acceptance criteria:**
- Reused CSRF tokens are rejected.
- Replayed WebAuthn challenges are rejected.
- Replayed wallet signing nonces (SIWE) are rejected.
- Each rejection returns an appropriate error status (400 or 403).
- No state change occurs from a replay attempt.

**Testing:**
- Integration: Execute a valid request with a CSRF token. Replay the same token -- verify rejection. Complete a WebAuthn authentication. Replay the challenge -- verify rejection. Complete a SIWE signing. Replay the signed message -- verify rejection.

---

### WS-O.1.2e CSRF verification test
**ID:** WS-O.1.2e
**Ref:** Section 25.2

**Description:**
Implement a test that verifies all state-changing API requests require a valid CSRF token (via Hono CSRF middleware). The test: (1) identifies all state-changing endpoints (POST, PUT, PATCH, DELETE); (2) attempts each endpoint without a CSRF token; (3) verifies that all return 403 Forbidden; (4) attempts each endpoint with an invalid CSRF token; (5) verifies 403; (6) attempts with a valid CSRF token; (7) verifies success (200/201/204). The test also verifies that GET/HEAD/OPTIONS requests do not require CSRF tokens.

**Acceptance criteria:**
- All state-changing endpoints (POST, PUT, PATCH, DELETE) require a CSRF token.
- Requests without a CSRF token return 403.
- Requests with an invalid CSRF token return 403.
- Requests with a valid CSRF token succeed.
- GET, HEAD, and OPTIONS requests do not require CSRF tokens.
- The test covers all registered routes (auto-discovered from the Hono app).

**Testing:**
- Integration: Enumerate all state-changing routes. Attempt each without token, with invalid token, and with valid token. Verify expected responses.

---

### WS-O.1.3a Object-level authorization test
**ID:** WS-O.1.3a
**Ref:** Section 25.4

**Description:**
Implement a test suite that verifies object-level authorization across all API endpoints. The test creates two users (A and B) and verifies that: (1) user A cannot access user B's private attention data; (2) user A cannot access user B's privacy settings; (3) user A cannot access user B's wallet links; (4) user A cannot access user B's Signal Ledger; (5) user A cannot read user B's compliance cases; (6) user A cannot modify user B's profile; (7) user A cannot delete user B's contributions; (8) user A cannot view user B's private reputation summary. Each unauthorized access attempt must return 403 or 404 (not revealing whether the resource exists). The test covers all endpoints that return user-specific data.

**Acceptance criteria:**
- User A cannot access any of user B's private resources (attention, privacy settings, wallet links, Signal Ledger, compliance cases, reputation).
- User A cannot modify user B's resources (profile, contributions).
- Unauthorized access returns 403 or 404 (no information leakage about resource existence).
- The test covers all endpoints returning user-specific data.
- The test runs in CI on every PR.

**Testing:**
- Integration: Create two users. Authenticate as user A. Attempt to access each of user B's private resources. Verify rejection. Authenticate as user B. Verify own resource access succeeds.

---

### WS-O.1.3b Role-based access test
**ID:** WS-O.1.3b
**Ref:** Section 25.4

**Description:**
Implement a test suite that verifies role-based access control (RBAC) across all protected endpoints. The test creates users with different roles (regular user, room steward, moderator, admin) and verifies: (1) regular users cannot access moderation endpoints (moderation queue, action palette, case management); (2) regular users cannot access admin endpoints (user management, policy configuration, system settings); (3) room stewards can access steward-scoped endpoints for their room but not for other rooms; (4) moderators can access moderation endpoints but not admin endpoints; (5) admins can access all endpoints. Each role boundary is tested with explicit assertions.

**Acceptance criteria:**
- Regular users receive 403 on moderation and admin endpoints.
- Room stewards receive 403 on endpoints for rooms they do not steward.
- Room stewards can access endpoints for their own rooms.
- Moderators receive 403 on admin-only endpoints.
- Admins can access all endpoints.
- Role checks are applied consistently across all protected endpoints.

**Testing:**
- Integration: Create users with each role. Authenticate as each. Attempt to access endpoints at each role level. Verify correct access/denial patterns.

---

### WS-O.1.3c Privilege escalation test
**ID:** WS-O.1.3c
**Ref:** Section 25.4

**Description:**
Implement a test suite that verifies users cannot escalate their own privileges. Tests include: (1) self-role-elevation -- a regular user attempts to set their role to moderator/admin via the profile update API; verify rejection; (2) parameter manipulation -- a regular user sends a request with role/permission fields in the body (mass assignment attempt); verify the fields are ignored or rejected; (3) path traversal -- a user attempts to access admin endpoints by manipulating URL parameters (e.g., changing user_id in the path to their own with elevated permissions); verify rejection; (4) token manipulation -- a user attempts to modify their session token to include elevated claims; verify rejection (server-side session validation). Each escalation attempt must fail with no privilege change.

**Acceptance criteria:**
- Self-role-elevation via API returns 403 and does not change the user's role.
- Mass assignment of role/permission fields is ignored or rejected.
- Path traversal with manipulated user_id does not bypass authorization.
- Token manipulation does not result in elevated privileges.
- After all escalation attempts, the user's role remains unchanged (verified by querying the database).

**Testing:**
- Integration: Authenticate as a regular user. Attempt each escalation vector. Verify rejection. Query the database to confirm role is unchanged.

---

### WS-O.1.3d Mass assignment test
**ID:** WS-O.1.3d
**Ref:** Section 25.4

**Description:**
Implement a test that verifies mass assignment protection on all API endpoints that accept user input. The test sends requests with additional fields beyond the expected schema (e.g., `role: "admin"`, `account_state: "active"`, `is_moderator: true`, `risk_level: "low"`) and verifies that: (1) extra fields are stripped by the zod validation layer and do not reach the database; (2) protected fields (role, account_state, risk_level, verification_state) cannot be set by regular users regardless of how they are submitted; (3) the response does not echo back the injected fields. The test covers all POST, PUT, and PATCH endpoints.

**Acceptance criteria:**
- Extra fields in request bodies are stripped by zod validation.
- Protected fields (role, account_state, risk_level) are not settable by regular users.
- The database record does not contain the injected field values after the request.
- API responses do not echo back injected fields.
- The test covers all mutation endpoints.

**Testing:**
- Integration: For each mutation endpoint, send a request with extra protected fields. Verify the request succeeds (for the valid fields) but the protected fields are not applied. Query the database to confirm.

---

### WS-O.1.4a Wallet-drainer phishing simulation
**ID:** WS-O.1.4a
**Ref:** Section 25.6

**Description:**
Implement a test that simulates wallet-drainer phishing attacks and verifies that the application's defenses prevent them. The test: (1) injects UGC containing known wallet-drainer patterns (URLs matching known drainer domains, contract addresses associated with drainer contracts, social-engineering text patterns); (2) verifies that links to suspected drainer domains trigger an interstitial warning before navigation; (3) verifies that contract addresses matching known drainer contracts are flagged in transaction previews; (4) verifies that the interstitial warning is clear, specific, and cannot be bypassed without explicit user acknowledgment. The drainer pattern list is configurable and updatable. The test uses Playwright to verify the interstitial rendering and user interaction flow.

**Acceptance criteria:**
- Known wallet-drainer URLs in UGC trigger an interstitial warning.
- Known drainer contract addresses are flagged in transaction previews.
- The interstitial cannot be bypassed without explicit user acknowledgment (click-through with clear warning text).
- The drainer pattern list is configurable and does not require a deployment to update.
- The test covers drainer patterns in story cards, contributions, room descriptions, and evidence cards.

**Testing:**
- E2E: Playwright injects drainer URLs into UGC. Navigates to the content. Verifies the interstitial appears. Verifies the warning text is specific. Verifies the drainer contract is flagged in a transaction preview.

---

### WS-O.1.4b Blind-signing prevention
**ID:** WS-O.1.4b
**Ref:** Section 25.6

**Description:**
Implement a test that verifies blind signing is prevented in all wallet interaction flows. The test verifies: (1) every signing request shows a full human-readable preview of what is being signed (action name, recipient, amount, asset, contract, chain, nonce, expiration) before the user can proceed; (2) the signing preview cannot be skipped or dismissed without cancelling the action; (3) the preview uses EIP-712 typed-data formatting with all fields visible; (4) unsigned or unreviewed actions are rejected by the backend (the backend verifies the signed typed data matches the previewed data); (5) raw hex signing requests (non-typed-data) are rejected by the application -- Licio never asks users to sign opaque bytes.

**Acceptance criteria:**
- Every signing flow shows a human-readable preview with all required fields.
- The preview cannot be skipped; cancelling is the only alternative to reviewing.
- EIP-712 typed-data format is used for all signing requests.
- The backend rejects signatures that do not match the previewed typed data.
- Raw hex signing requests are never generated by the application.

**Testing:**
- E2E: Playwright walks through each signing flow (wallet link, payment, proposal, grant payout). Verifies the preview appears with all fields. Attempts to skip the preview -- verifies failure. Verifies EIP-712 format in the signing request.
- Integration: Submit a signature with mismatched typed data -- verify backend rejection.

---

### WS-O.1.4c Unknown-recipient warning
**ID:** WS-O.1.4c
**Ref:** Section 25.6

**Description:**
Implement a test that verifies a warning is shown when a user is sending to an unrecognized address. An address is "unrecognized" if it: (1) has not been previously transacted with by the user; (2) is not in the room's known-recipient list; (3) is not a Licio-recognized contract address. The warning must: explain that the recipient is not recognized; advise the user to verify the address; allow the user to proceed after explicit acknowledgment; and be displayed in the transaction preview (not a separate dialog that can be missed). The warning is distinct from the drainer warning (WS-O.1.4a) -- it applies to any unknown address, not just known-bad ones.

**Acceptance criteria:**
- Transactions to unrecognized addresses show a warning in the transaction preview.
- The warning explains the address is not recognized and advises verification.
- The user must explicitly acknowledge the warning to proceed.
- Previously-transacted addresses do not trigger the warning.
- Known Licio contract addresses do not trigger the warning.
- Room-known recipients do not trigger the warning.

**Testing:**
- E2E: Initiate a transaction to a new address. Verify the warning appears. Acknowledge the warning and complete the transaction. Initiate a transaction to a previously-used address. Verify no warning.
- Integration: Check the recipient-recognition logic for known contracts, known recipients, and unknown addresses.

---

### WS-O.1.4d Contract-address allowlist test
**ID:** WS-O.1.4d
**Ref:** Section 25.6

**Description:**
Implement a test that verifies only allowlisted contract addresses pass the gateway preflight check. The test: (1) submits a transaction targeting an allowlisted contract address -- verifies preflight passes; (2) submits a transaction targeting a non-allowlisted contract address -- verifies preflight rejects with a clear error ("This contract is not recognized by Licio"); (3) submits a transaction targeting an EOA (non-contract) -- verifies the address passes preflight but triggers the unknown-recipient warning if unrecognized (WS-O.1.4c); (4) verifies the allowlist is configurable and environment-specific (different allowlists for testnet and production); (5) verifies that the allowlist is checked at preflight time, not just at submission time (early rejection).

**Acceptance criteria:**
- Allowlisted contracts pass preflight.
- Non-allowlisted contracts are rejected at preflight with a clear error.
- The allowlist is environment-specific (testnet vs production).
- The allowlist is configurable without code changes (configuration-managed).
- Preflight rejection occurs before the user signs (no wasted signatures).

**Testing:**
- Integration: Submit transactions to allowlisted, non-allowlisted, and EOA addresses. Verify correct preflight responses. Switch environment configuration, verify different allowlists apply.

---

### WS-O.1.4e EIP-712 domain-separation test
**ID:** WS-O.1.4e
**Ref:** Section 25.6

**Description:**
Implement a test that verifies EIP-712 domain separation prevents cross-chain and cross-application signature replay. The test: (1) generates a signed typed-data message on chain A; (2) submits the signature to the backend claiming it is for chain B; (3) verifies the backend rejects the signature because the chain ID in the domain does not match; (4) generates a signed message with a different contract/verifying-contract domain; (5) submits it to Licio's backend; (6) verifies rejection because the domain does not match Licio's expected domain; (7) generates a valid signed message with correct domain and chain ID; (8) verifies it is accepted. The test also verifies that nonces are checked (same nonce cannot be reused) and expiration is enforced (expired signatures are rejected).

**Acceptance criteria:**
- Signatures with mismatched chain ID are rejected.
- Signatures with mismatched verifying-contract domain are rejected.
- Signatures with reused nonces are rejected.
- Expired signatures are rejected.
- Valid signatures with correct domain, chain ID, nonce, and unexpired timestamp are accepted.
- Rejection errors are specific (not generic "invalid signature" -- states which check failed).

**Testing:**
- Integration: Generate signatures with each type of mismatch. Submit to the backend. Verify specific rejection reasons. Generate a valid signature. Verify acceptance.

---

## WS-O.2 Incident response

### WS-O.2.1a Severity classification
**ID:** WS-O.2.1a
**Ref:** Section 29.7

**Description:**
Define and document the incident severity classification system. Severity levels: **Sev1 (Critical)** -- data breach affecting user personal data, loss or theft of user/room funds, active exploitation of a security vulnerability, complete service outage; **Sev2 (Major)** -- partial service outage, security vulnerability discovered (not yet exploited), treasury reconciliation divergence, significant feature degradation affecting >10% of users; **Sev3 (Minor)** -- single feature degraded, minor bug affecting <10% of users, non-critical security finding, performance degradation below SLO; **Sev4 (Informational)** -- cosmetic issues, logging improvements, documentation gaps, non-user-facing bugs. Each severity level has: a response time target, an escalation path, a communication requirement, and a resolution time target. The classification is documented in the incident response playbook and linked from the on-call runbook.

**Acceptance criteria:**
- All four severity levels are defined with clear criteria and examples.
- Each severity level has response time, escalation, communication, and resolution targets.
- The classification covers security, availability, financial, and product incidents.
- The document is reviewed and approved by engineering and security leads.
- The classification is referenced by the incident response playbook (WS-O.2.1b).

**Testing:**
- Review: Classification document exists and covers all categories. Each severity level has quantitative response/resolution targets. Examples are provided for each level.

---

### WS-O.2.1b Escalation paths
**ID:** WS-O.2.1b
**Ref:** Section 29.7

**Description:**
Define escalation paths for each incident severity level. The escalation path specifies: who gets paged (on-call engineer, engineering lead, security lead, executive), through which communication channels (PagerDuty/equivalent, Slack/equivalent, email, phone), within what time frame, and what authority they have (e.g., Sev1 responder can unilaterally trigger emergency feature flags and rollbacks). The escalation path also defines handoff procedures for cross-timezone teams, backup contacts for each role, and escalation override for treasury incidents (which always page the treasury-incident team regardless of initial severity classification). Communication templates are provided for each severity level: internal status updates, user-facing status page updates, and if applicable, regulatory notifications.

**Acceptance criteria:**
- Each severity level has a defined escalation path with named roles (not specific individuals -- roles rotate).
- Communication channels are specified for each severity level.
- Response time targets are defined per severity level.
- Treasury incidents have a dedicated escalation path that pages treasury-incident responders.
- Communication templates exist for internal updates, status page, and regulatory notification.
- Backup contacts and cross-timezone handoff procedures are documented.

**Testing:**
- Review: Escalation paths are documented and complete. Templates exist for each severity level. Treasury escalation is distinct from general escalation.
- Drill: A tabletop exercise verifies the escalation path works for a simulated Sev1 and a simulated treasury incident.

---

### WS-O.2.1c Rollback procedures
**ID:** WS-O.2.1c
**Ref:** Section 29.7

**Description:**
Define and test rollback procedures for every high-risk feature. Rollback procedures cover: (1) client rollback -- redeploy the previous bundle version; the service worker updates and prompts users; (2) feature-flag rollback -- disable a specific feature via emergency feature flags (WS-O.2.2) without redeployment; (3) database migration rollback -- down migrations for schema changes; tested in staging before production; (4) configuration rollback -- revert policy changes, jurisdiction policies, and feature configurations; (5) Knomosis/treasury rollback -- pause treasury operations, disable wallet features, freeze proposals. Each rollback procedure is tested in staging for every release that modifies the relevant system. Rollback time targets: client rollback < 5 minutes, feature-flag rollback < 1 minute, configuration rollback < 5 minutes.

**Acceptance criteria:**
- Rollback procedures exist for client, feature flags, database, configuration, and treasury.
- Each procedure has a time target and an owner.
- Client rollback is tested: previous bundle is redeployed and serves correctly.
- Feature-flag rollback is tested: feature is disabled within 1 minute.
- Database rollback is tested: down migration applies cleanly in staging.
- Treasury rollback is tested: treasury operations pause within 1 minute of flag activation.
- All rollback procedures are documented in the on-call runbook.

**Testing:**
- Integration: Execute each rollback procedure in staging. Measure time to effect. Verify the system is stable after rollback.
- Drill: Quarterly rollback drill for at least one high-risk feature.

---

### WS-O.2.1d Treasury incident procedure
**ID:** WS-O.2.1d
**Ref:** Section 29.7

**Description:**
Define and test the treasury incident response procedure per the spec's treasury incident workflow: detect (monitoring detects suspicious treasury movement, indexer divergence, high-risk recipient, governance-capture signal, or contract alert) -> case open (treasury incident case opened with severity, affected room, assets, caps, pending transactions, user impact) -> pause (new deposits/proposals/executions can be paused independently and scoped; withdrawals/remediation remain available where technically and legally possible) -> review (security, legal, T&S, and finance review) -> reconcile (reconciliation worker snapshots product DB, Knomosis receipts, and L1 observations) -> resolve (cleared status, cap reduction, proposal cancellation, migration, remediation, or permanent feature disablement) -> postmortem (updates runbooks, caps, monitoring, copy, audit evidence). Users see a safe status message that avoids leaking investigative detail.

**Acceptance criteria:**
- The procedure covers all seven phases: detect, case open, pause, review, reconcile, resolve, postmortem.
- Each phase has specific actions, responsible roles, and time targets.
- Pause is scoped: deposits, proposals, and executions can be paused independently.
- Reconciliation snapshots all three sources: product DB, Knomosis receipts, L1 observations.
- User-facing status messages are pre-written and do not leak investigative detail.
- Postmortem produces tracked action items that update runbooks and monitoring.
- The procedure is tested in a tabletop exercise before any real-funds pilot.

**Testing:**
- Drill: Tabletop exercise simulating a treasury incident. Walk through all seven phases. Verify roles, actions, and communication.
- Integration: Test pause/resume of treasury operations via emergency flags. Test reconciliation worker against known divergence. Verify user-facing status message rendering.

---

### WS-O.2.1e Post-incident review template
**ID:** WS-O.2.1e
**Ref:** Section 29.7

**Description:**
Define a structured post-incident review (PIR) template. The template includes: (1) timeline -- minute-by-minute chronology from detection to resolution; (2) root cause analysis -- the specific technical, process, or human failure that caused the incident; contributing factors; (3) impact assessment -- users affected, data exposed/lost, funds at risk/lost, service degradation duration, SLO violations; (4) response evaluation -- what went well, what went poorly, where the playbook was insufficient; (5) action items -- specific, assigned, time-bound actions to prevent recurrence; categorized as immediate (this week), short-term (this month), long-term (this quarter); (6) follow-up -- scheduled review of action item completion. The template is used for all Sev1 and Sev2 incidents and optionally for Sev3. PIR documents are stored in a shared, access-controlled repository.

**Acceptance criteria:**
- Template covers all six sections: timeline, root cause, impact, response evaluation, action items, follow-up.
- Action items are specific, assigned to named owners, and have deadlines.
- The template is required for all Sev1 and Sev2 incidents.
- PIR documents are stored in a shared repository with access controls.
- A follow-up review is scheduled for every PIR to verify action item completion.

**Testing:**
- Review: Template is complete and covers all sections. A sample PIR using the template is reviewed for clarity and actionability.

---

## WS-O.3 Reproducible builds and provenance

### WS-O.3.1a Deterministic Vite/Rollup output
**ID:** WS-O.3.1a
**Ref:** Section 20.2

**Description:**
Configure the Vite/Rollup build pipeline to produce deterministic output. Two builds from the same source commit, on the same platform, with the same Node.js and pnpm versions, must produce byte-identical `dist/` directories. This requires: (1) stable chunk ordering in Rollup (explicit `output.manualChunks` or sorted entry order); (2) no timestamps, random IDs, or process-specific values in output; (3) deterministic CSS ordering (Tailwind CSS purge order is deterministic from source); (4) reproducible source maps (relative paths, no absolute machine-specific paths). A CI job builds the project twice from the same commit and compares the output byte-for-byte. Any difference fails the build.

**Acceptance criteria:**
- Two builds from the same commit produce byte-identical `dist/` directories.
- CI job runs both builds and performs a diff -- zero differences.
- Source maps use relative paths (no machine-specific absolute paths).
- No timestamps, random values, or process-specific values appear in output files.
- The CI job runs on every PR that modifies build configuration.

**Testing:**
- CI: Build twice, `diff -r` the two `dist/` directories. Fail on any difference.
- Manual: Build locally and compare against CI build output (should match given same toolchain versions).

---

### WS-O.3.1b Content-hashed filenames
**ID:** WS-O.3.1b
**Ref:** Section 20.2

**Description:**
Verify that all output files from the Vite/Rollup build include content hashes in their filenames. This ensures that: (1) cache busting works correctly when file contents change; (2) unchanged files keep the same filename across builds (enabling long-term caching); (3) the mapping between source and output is auditable via the manifest. The test verifies that all `.js`, `.css`, and asset files in `dist/` match the pattern `{name}-{hash}.{ext}` where `{hash}` is a content-derived hash. The `index.html` entry point and the manifest file are exceptions (they have stable names). The manifest (`dist/.vite/manifest.json` or equivalent) maps source files to hashed output files.

**Acceptance criteria:**
- All `.js` and `.css` files in `dist/` include a content hash in their filename.
- Asset files (images, fonts) include content hashes.
- `index.html` and manifest are the only files without content hashes.
- Changing a source file's content changes the output file's hash.
- Not changing a source file preserves the output file's hash across builds.
- The manifest accurately maps source to output files.

**Testing:**
- Unit: Build the project. Verify filename patterns match `{name}-{hash}.{ext}`. Modify a source file. Rebuild. Verify the output hash changed. Rebuild without changes. Verify the hash is stable.

---

### WS-O.3.1c SRI hash generation
**ID:** WS-O.3.1c
**Ref:** Sections 20.2, 25.2

**Description:**
Generate Subresource Integrity (SRI) hashes for all assets loaded by the application. The build pipeline generates SHA-384 (or SHA-512) hashes for every `.js` and `.css` file in `dist/`. The `index.html` references these files with `integrity` attributes on `<script>` and `<link>` tags. A post-build step verifies that every script and stylesheet reference in `index.html` has a correct `integrity` attribute. If any third-party assets are loaded (e.g., CDN fonts), they must also have SRI attributes. The SRI hashes are published alongside the build for external verification.

**Acceptance criteria:**
- Every `<script>` and `<link>` tag in `index.html` has an `integrity` attribute.
- SRI hashes use SHA-384 or SHA-512.
- SRI hashes are correct (verified by recomputing the hash of the referenced file).
- Third-party assets (if any) have SRI attributes.
- A post-build verification step confirms all references have correct SRI attributes.
- SRI hashes are included in the build provenance artifacts.

**Testing:**
- CI: Post-build step parses `index.html`, extracts integrity attributes, recomputes hashes from the referenced files, and verifies they match. Fail on mismatch or missing integrity.

---

### WS-O.3.1d Inline script verification
**ID:** WS-O.3.1d
**Ref:** Section 25.2

**Description:**
Implement an automated CI check that verifies the production build output contains zero inline `<script>` or `<style>` blocks. Inline scripts and styles violate the strict CSP (`default-src 'self'`, no `unsafe-inline`) and create XSS surface area. The check parses `index.html` and any other HTML files in `dist/` and fails if any `<script>` tag without a `src` attribute or any `<style>` tag without a `href` (i.e., inline) is found. The only exception is nonce-based script tags if the CSP uses nonces -- these must be verified against the CSP configuration. Vite's default behavior of inlining CSS chunks must be explicitly disabled.

**Acceptance criteria:**
- Zero inline `<script>` tags (without `src`) in production HTML.
- Zero inline `<style>` tags in production HTML.
- Vite's CSS inlining is disabled in the production build configuration.
- The check runs in CI on every PR.
- Exceptions for nonce-based scripts are documented and verified against CSP configuration.

**Testing:**
- CI: Parse all HTML files in `dist/`. Fail on any inline `<script>` or `<style>`.

---

### WS-O.3.2a Sigstore/cosign signatures
**ID:** WS-O.3.2a
**Ref:** Section 20.2

**Description:**
Integrate Sigstore/cosign signing into the CI/CD pipeline to sign build artifacts. After a successful production build, the pipeline: (1) generates a cosign signature for the `dist/` tarball; (2) uses keyless signing with the CI's OIDC identity (GitHub Actions OIDC token); (3) publishes the signature to the Sigstore transparency log (Rekor); (4) stores the signature alongside the build artifact; (5) provides a verification command that anyone can use to verify the signature against the transparency log. The signing step is mandatory for production builds and cannot be skipped.

**Acceptance criteria:**
- Production builds are signed with cosign using keyless OIDC signing.
- Signatures are published to the Sigstore transparency log.
- The signature is stored alongside the build artifact.
- A verification command is documented and works against the transparency log.
- Signing is mandatory for production builds (pipeline fails if signing fails).
- Non-production builds (dev, staging) are not signed (to avoid log pollution).

**Testing:**
- CI: Production build pipeline includes signing step. Verify signature exists after build. Run verification command against transparency log -- verify success.
- Manual: Download a signed artifact. Run the verification command. Verify it passes.

---

### WS-O.3.2b In-toto attestations
**ID:** WS-O.3.2b
**Ref:** Section 20.2

**Description:**
Generate in-toto attestations for each build step in the CI/CD pipeline. Attestations record: (1) the source commit hash; (2) the build command and arguments; (3) the environment (Node.js version, pnpm version, OS); (4) input materials (source files, dependency lockfile hash); (5) output products (dist/ files with hashes); (6) build timestamps. Attestations are signed using the same OIDC identity as cosign signatures. Attestations are published to an append-only transparency log so that any modification to the build pipeline or its outputs is publicly visible. The attestation chain allows verification that a served bundle was produced from a specific source commit via a specific build process.

**Acceptance criteria:**
- In-toto attestations are generated for every production build.
- Attestations include source commit, build command, environment, inputs, and outputs.
- Attestations are signed and published to an append-only log.
- The attestation chain links source commit to final output.
- Attestation verification is documented and executable.

**Testing:**
- CI: Verify attestations are generated and signed after production builds. Verify attestation includes correct source commit and output hashes.
- Manual: Verify the attestation chain from a served bundle back to the source commit.

---

### WS-O.3.2c SBOM generation
**ID:** WS-O.3.2c
**Ref:** Sections 20.2, 25.2

**Description:**
Generate a Software Bill of Materials (SBOM) for every release. The SBOM lists all runtime dependencies with: package name, version, license, source repository, integrity hash. The SBOM is generated in a standard format (SPDX or CycloneDX). The generation is automated as part of the CI/CD pipeline and runs on every production build. The SBOM is stored alongside the release artifacts and published for external consumers. SBOM generation uses the pnpm lockfile as the source of truth for dependency versions.

**Acceptance criteria:**
- SBOM is generated for every production build.
- SBOM format is SPDX or CycloneDX.
- SBOM includes all runtime dependencies with name, version, license, source, and hash.
- SBOM is derived from the pnpm lockfile (ensuring accuracy).
- SBOM is stored alongside release artifacts.
- SBOM generation is automated in CI/CD.

**Testing:**
- CI: Verify SBOM is generated after production build. Verify SBOM lists all runtime dependencies. Verify SBOM format is valid (schema validation against SPDX or CycloneDX spec).

---

### WS-O.3.2d License cross-check
**ID:** WS-O.3.2d
**Ref:** Sections 20.2, 20.4

**Description:**
Implement an automated license compatibility check that verifies all dependencies are compatible with AGPL-3.0-or-later. The check uses the SBOM (WS-O.3.2c) or the pnpm lockfile to enumerate all runtime and development dependencies and their licenses. Licenses are classified as: compatible (MIT, BSD-2, BSD-3, ISC, Apache-2.0, LGPL-2.1+, LGPL-3.0+, GPL-2.0+, GPL-3.0+, AGPL-3.0+, MPL-2.0), incompatible (proprietary, SSPL, Commons Clause, non-commercial), or unknown (requires manual review). The check fails on any incompatible or unknown license. A manual-review allowlist can mark specific packages as reviewed and approved. The check runs in CI on every PR that modifies `pnpm-lock.yaml`.

**Acceptance criteria:**
- All runtime and development dependencies have identified licenses.
- All licenses are classified as compatible, incompatible, or unknown.
- Incompatible or unknown licenses fail the CI check.
- A manual-review allowlist permits specific reviewed packages.
- The check runs on every PR modifying `pnpm-lock.yaml`.
- The allowlist includes the reviewer and review date for each entry.

**Testing:**
- CI: Run the license check. Verify zero incompatible or unknown licenses (or all are in the reviewed allowlist). Add a dependency with a proprietary license -- verify the check fails.

## Workstream definition of done

WS-O is complete when ALL of the following conditions hold:

1. **Zero XSS vectors:** The full XSS test suite passes with zero vectors reaching the DOM. CSP, Trusted Types, DOMPurify, and Markdown AST sanitization are all enforced and tested together.

2. **Auth attack mitigation:** Authentication attacks (credential stuffing, brute force, session fixation, session hijacking) are mitigated with rate limiting, account lockout, secure session management, and monitoring.

3. **API authorization coverage:** Authorization is tested for every API endpoint. Horizontal and vertical privilege escalation attempts are rejected. Unauthenticated access to protected endpoints returns 401/403.

4. **Wallet security:** Wallet-related security is tested, including transaction signing verification, replay protection, gateway preflight enforcement, and private key non-exposure.

5. **Incident playbook:** The incident response playbook is documented and tested via tabletop exercise. Escalation paths, communication templates, and recovery procedures are validated.

6. **Reproducible builds with SRI:** Production builds are reproducible (same source produces identical output). All served scripts and stylesheets have Subresource Integrity (SRI) hashes.

7. **SBOM generated:** A Software Bill of Materials (SBOM) in SPDX or CycloneDX format is generated for every production build, listing all runtime dependencies with name, version, license, source, and hash.

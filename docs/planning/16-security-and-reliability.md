# WS-O: Security, Reliability, and Incident Response

**Milestone:** M0-M6
**Priority:** P0
**Dependencies:** WS-0 (repository foundation)
**Wave:** 2+6 (continuous)
**Estimated duration:** Continuous

---

## Overview

Security is a release gate at every milestone. This is a continuous workstream, not a one-time phase. Licio's combined UGC + wallet surface makes XSS the dominant risk: a single injection could trigger a malicious wallet signature and drain funds (Section 25.2). Defense-in-depth against XSS is therefore paramount, followed by auth/session hardening, API authorization, and wallet-specific security. Because a PWA cannot use native device attestation, abuse defense is **server-side and behavioral** (Section 25.5): bot/sock resistance, coordination detection, forged-attention-event rejection, and look-alike-domain defense are first-class security tasks, not afterthoughts. Backend hardening covers secrets management, least-privilege keys, encryption at rest, and supply-chain scanning (Section 25.4). Reliability and disaster recovery (SLOs, backups, restore drills, chain monitoring) live here because availability is a security property for a financial surface. Incident response covers severity classification, escalation, rollback, emergency feature flags, and treasury-specific procedures. Reproducible builds and supply-chain provenance ensure that no backdoored bundle can be served without public evidence (Section 20.2). Every security test described here runs in CI and is a merge-blocking gate for relevant code paths.

**Cross-cutting requirements for this workstream:**
- Every task carries `**ID:**`, `**Ref:**`, `**Description:**`, `**Acceptance criteria:**`, `**Testing:**`, and `**Dependencies:**`; security-sensitive tasks add observability and edge-case notes.
- No secret, signing key, or seed phrase is ever embedded in or handled by the client bundle (Section 25.2 #7).
- The integrity model assumes the browser is hostile-adjacent and every wallet signature is a high-risk action (Section 25.1).
- Emergency feature flags (WS-O.2.2) are the universal "stop" control and underpin rollback (WS-O.2.1c) and treasury incident response (WS-O.2.1d).

---

## WS-O.1 Security testing

### WS-O.1.1a OWASP XSS vector testing
**ID:** WS-O.1.1a
**Ref:** Section 25.2

**Description:**
Build an automated test suite that runs every XSS vector from the OWASP XSS Cheat Sheet against every user-generated-content rendering path in the application. UGC rendering paths include: story cards (title, source summary, context chips), thread contributions (body, citations), room descriptions, user profiles (display name, bio if present), evidence cards (relevance notes, citations), context cards (summary text), and AI-generated summaries. Each vector is injected into each rendering path and the test verifies that: (1) the injected script does not execute (no alert, no network request, no DOM mutation beyond the sanitized output); (2) the output is sanitized by DOMPurify through the Trusted Types pipeline; (3) no raw HTML is rendered -- all output passes through the allow-list sanitizer. The vector corpus must include modern bypass families beyond the classic cheat sheet: mutation XSS (mXSS), DOM-clobbering, `srcset`/`<template>`/`<noscript>` parsing quirks, SVG `<use>`/`xlink:href`, and Markdown-link `javascript:`/`data:` smuggling. The test suite uses Playwright to render the component in a real browser context and verify that no script executes.

**Acceptance criteria:**
- Every OWASP XSS Cheat Sheet vector plus the mXSS/DOM-clobbering/SVG/Markdown families is tested against every UGC rendering path.
- Zero vectors result in script execution.
- Test results include the vector, the rendering path, and the sanitized output for audit.
- The test suite runs in CI on every PR that modifies UGC rendering, sanitization, or CSP configuration.
- New UGC rendering paths must be added to the test suite before merging (enforced by code review checklist).

**Testing:**
- E2E: Playwright tests inject each vector and assert no script execution (no `alert`, no injected network requests, no DOM mutations outside the sanitized container).
- CI: Test suite is a required check in GitHub Actions.

**Dependencies:** WS-G.4.1 (Markdown-lite parser), WS-G.4.2a-d (DOMPurify/Trusted Types pipeline + wallet-drainer detection), WS-0.5.1 (CSP/Trusted Types headers), WS-0.4.3 (Playwright + axe-core harness).

---

### WS-O.1.1b Trusted Types violation detection
**ID:** WS-O.1.1b
**Ref:** Section 25.2

**Description:**
Implement automated testing that verifies Trusted Types enforcement across the application. The test suite must prove that any call to `innerHTML`, `document.write`, `eval`, `setTimeout(string)`, `setInterval(string)`, or `new Function(string)` that does not go through a registered Trusted Types policy triggers a violation. The test is run in a browser context (Playwright) with Trusted Types enforcement enabled (`require-trusted-types-for 'script'`). The test navigates through all major application routes and interactions, and asserts that zero Trusted Types violations are logged. If a violation occurs, the test captures the call site (stack trace) and the violating value for debugging. The test also asserts that only the named `licio-ugc` policy (WS-G.4.2a) is registered and that `trustedTypes.defaultPolicy` is not used as an escape hatch.

**Acceptance criteria:**
- Trusted Types are enforced in the test browser context via CSP header.
- Zero Trusted Types violations occur during a full application navigation (all routes, all UGC rendering paths, all dynamic content loading).
- Only the allow-listed named policy is registered; no permissive default policy exists.
- Any violation is captured with stack trace and violating value.
- The test suite runs in CI on every PR.
- New routes or dynamic content paths are covered by extending the navigation in the test.

**Testing:**
- E2E: Playwright navigates all routes with a violation listener that fails the test on any Trusted Types violation.
- CI: Required check in GitHub Actions.

**Dependencies:** WS-0.5.1 (CSP `require-trusted-types-for`), WS-0.5.4 (Trusted Types policy wiring), WS-G.4.2a (named `licio-ugc` policy).

---

### WS-O.1.1c CSP bypass testing
**ID:** WS-O.1.1c
**Ref:** Section 25.2

**Description:**
Implement a test suite that attempts to bypass the Content Security Policy. Tests include: (1) inline script injection -- inject `<script>alert(1)</script>` into UGC and verify it is blocked by CSP; (2) eval injection -- attempt to execute `eval()` from UGC context and verify it is blocked; (3) external script injection -- inject `<script src="https://evil.example.com/malware.js">` and verify it is blocked by `default-src 'self'`; (4) data URI injection -- inject `<a href="data:text/html,<script>alert(1)</script>">` and verify it is blocked; (5) javascript URI injection -- inject `<a href="javascript:alert(1)">` and verify it is stripped by the sanitizer and blocked by CSP; (6) object/embed injection -- inject `<object>` and `<embed>` tags and verify blocked by `object-src 'none'`; (7) base tag injection -- inject `<base href="https://evil.example.com">` and verify blocked by `base-uri 'self'`; (8) style injection with expression/behavior -- inject CSS expressions and verify blocked. Each test runs in Playwright with the production CSP headers. A CSP report-only endpoint captures any violation for triage.

**Acceptance criteria:**
- All eight CSP bypass categories are tested.
- Zero bypasses succeed -- all injected content is blocked by CSP or stripped by the sanitizer.
- Tests run with the exact CSP headers used in production (verified by reading the response headers).
- Test results document each attempt and the blocking mechanism (CSP directive, sanitizer rule).
- The test suite runs in CI on every PR that modifies CSP configuration or UGC rendering.

**Testing:**
- E2E: Playwright tests inject each bypass attempt and verify no script execution, no external resource loading, no base URI change.
- CI: Required check in GitHub Actions.

**Dependencies:** WS-0.5.1a/b (CSP string + reporting), WS-G.4.2 (sanitizer).

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

**Dependencies:** WS-0.4.1b (Biome security rules), WS-0.6.1e (security audit CI job).

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

**Dependencies:** WS-D.1.3d (auth rate limiting/lockout), WS-D.1.4b (email-OTP login -- the brute-forceable fallback path), WS-O.4.1 (turnstile/PoW for repeated abuse).

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
- The test covers all authentication paths: WebAuthn, email-OTP, and wallet (EIP-4361).

**Testing:**
- Integration: Record session ID before login. Authenticate. Verify new session ID. Use old session ID to access a protected endpoint -- verify rejection.

**Dependencies:** WS-D.1.3b (session creation), WS-D.1.3e (session rotation on privilege change).

---

### WS-O.1.2c Session hijacking prevention test
**ID:** WS-O.1.2c
**Ref:** Sections 25.2, 25.3

**Description:**
Implement a test that verifies session cookie security attributes. The test inspects the `Set-Cookie` header on authentication responses and verifies: (1) `HttpOnly` flag is present (prevents JavaScript access); (2) `Secure` flag is present (cookies sent only over HTTPS); (3) `SameSite=Strict` is set (prevents cross-site request attachment) or `SameSite=Lax` with CSRF token for cross-site posts; (4) cookie uses the `__Host-` prefix and `Path=/` minimum scope; (5) cookie `Max-Age` or `Expires` is set to a reasonable session duration. The test also verifies that session tokens are not transmitted in URLs, local storage, or non-HttpOnly cookies.

**Acceptance criteria:**
- Session cookies have `HttpOnly`, `Secure`, and `SameSite=Strict` (or `Lax` with CSRF).
- Cookie uses the `__Host-` prefix and is scoped appropriately.
- Session tokens are not present in URLs, localStorage, or non-HttpOnly cookies.
- All assertions pass on every auth flow: WebAuthn, email-OTP, and wallet (EIP-4361).

**Testing:**
- Integration: Authenticate and inspect response headers. Verify all cookie attributes. Attempt to read the session cookie from JavaScript (Playwright `page.evaluate`) -- verify failure (HttpOnly). Check localStorage and URL for session tokens -- verify absent.

**Dependencies:** WS-D.1.3b (secure cookie session), WS-0.5.1 (HSTS/transport headers).

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

**Dependencies:** WS-0.5.2b (CSRF anti-replay nonces), WS-D.1.2a (WebAuthn challenge TTL), WS-L.2.3a (SIWE nonce store).

---

### WS-O.1.2e CSRF verification test
**ID:** WS-O.1.2e
**Ref:** Section 25.2

**Description:**
Implement a test that verifies all state-changing API requests require a valid CSRF token (via Hono CSRF middleware). The test: (1) identifies all state-changing endpoints (POST, PUT, PATCH, DELETE); (2) attempts each endpoint without a CSRF token; (3) verifies that all return 403 Forbidden; (4) attempts each endpoint with an invalid CSRF token; (5) verifies 403; (6) attempts with a valid CSRF token; (7) verifies success (200/201/204). The test also verifies that GET/HEAD/OPTIONS requests do not require CSRF tokens, and that the CSRF comparison is constant-time.

**Acceptance criteria:**
- All state-changing endpoints (POST, PUT, PATCH, DELETE) require a CSRF token.
- Requests without a CSRF token return 403.
- Requests with an invalid CSRF token return 403.
- Requests with a valid CSRF token succeed.
- GET, HEAD, and OPTIONS requests do not require CSRF tokens.
- The test covers all registered routes (auto-discovered from the Hono app).

**Testing:**
- Integration: Enumerate all state-changing routes. Attempt each without token, with invalid token, and with valid token. Verify expected responses.

**Dependencies:** WS-0.5.2b (CSRF middleware), WS-0.3.3 (Hono app factory for route discovery).

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

**Dependencies:** WS-D.1.6b (object-level authz helpers), WS-D.1.6c (audit logging).

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

**Dependencies:** WS-D.1.6b (RBAC middleware), WS-A.2.2 (steward role definitions).

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

**Dependencies:** WS-D.1.6b (authz), WS-O.1.3d (mass-assignment defense), WS-D.1.3b (server-side session).

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

**Dependencies:** WS-D.1.1d (zod schemas with strict/strip), WS-0.2.2 (workspace boundaries for shared schemas).

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

**Dependencies:** WS-G.4.2c (wallet-drainer link detection), WS-L.2.6 (transaction preview), WS-O.6.3 (updatable threat-intel list).

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

**Dependencies:** WS-L.2.6 (transaction preview renderer), WS-L.2.4 (signature verification), WS-L.3.1 (preflight match check).

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

**Dependencies:** WS-L.2.6 (preview), WS-L.3.1b-1 (contract allowlist), WS-M.2.3 (room-known recipients).

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

**Dependencies:** WS-L.3.1b-1 (contract-allowlist registry), WS-L.1.1a-1 (deployment manifest / pinned addresses).

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

**Dependencies:** WS-L.2.4c (EIP-712 typed-data validation), WS-L.2.4d (shared typed-data registry).

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

**Dependencies:** None (foundational doc); informs WS-O.2.1b-e.

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

**Dependencies:** WS-O.2.1a (severity classification).

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

**Dependencies:** WS-O.2.2 (emergency feature flags), WS-O.6.2 (backup/restore for DB rollback), WS-M.2.4 (treasury freeze).

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

**Dependencies:** WS-O.2.2 (kill switches), WS-L.3.4 (reconciliation engine), WS-M.2.4 (treasury freeze), WS-N.2.1 (financial compliance case).

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

**Dependencies:** WS-O.2.1a (severity), WS-P.2.1 (transparency report inputs).

---

### WS-O.2.2a Emergency feature-flag infrastructure
**ID:** WS-O.2.2a
**Ref:** Sections 25.6, 29.7

**Description:**
Build the emergency feature-flag substrate that all kill switches and rollbacks depend on (referenced by WS-O.2.1c/d and mirrored in WS-L.3.5). Requirements: flags are evaluated server-side on every request and propagate to clients within one polling interval; flag state is stored in a fast, replicated store (Redis) with a durable audit trail; each flag has a scope dimension (global, per-region, per-room) with documented precedence (global overrides region overrides room); flag changes require an authenticated operator with the incident-responder role and are recorded with actor, timestamp, reason, and previous value; flags are fail-safe (if the flag store is unreachable, security-sensitive flags fail to the SAFE/disabled state); a read-only status surface shows current flag state to on-call. The substrate is independent of application deploys so a flag can be flipped without shipping code.

**Acceptance criteria:**
- A flag flip takes effect server-side immediately and on clients within one polling interval.
- Scope precedence (global > region > room) is enforced and tested.
- Every flag change is recorded with actor/timestamp/reason/previous value in an append-only audit log.
- If the flag store is unreachable, security-sensitive flags evaluate to disabled (fail-closed).
- Only incident-responder/admin roles can change flags; attempts by other roles are rejected and logged.

**Testing:**
- Integration: Flip a flag; assert server-side effect is immediate and client effect within the interval. Simulate flag-store outage; assert security-sensitive flags fail closed. Attempt a flag change as a non-privileged user; assert rejection.
- Unit: Scope-precedence resolution across global/region/room combinations.

**Dependencies:** WS-0.7.2 (Redis), WS-C.1.3c (client feature-flag store, fail-closed), WS-D.1.6b (role checks), WS-D.1.6c (audit log).

---

### WS-O.2.2b Kill switches for wallet, payment, action, treasury, and governance
**ID:** WS-O.2.2b
**Ref:** Sections 25.6, 29.7

**Description:**
Implement the five spec-mandated emergency kill switches on top of WS-O.2.2a: (1) wallet connection; (2) payment-intent creation; (3) action submission; (4) treasury execution; (5) governance voting. Each switch is independently togglable at global, per-region, and per-room scope, takes effect immediately, and when engaged produces a clear, accessible, localizable disabled-state message (coordinated with WS-N.1.2) rather than an opaque failure. Engaging a switch must not corrupt in-flight state: in-flight actions reach a safe terminal/paused state and are reconciled (WS-L.3.4). This task is the WS-O view of the same switches owned operationally in WS-L.3.5; the two MUST resolve to the same flag keys (single source of truth) to avoid drift.

**Acceptance criteria:**
- All five kill switches exist and are independently togglable at global/region/room scope.
- Engaging any switch takes effect immediately and surfaces a specific disabled-state explanation.
- In-flight operations reach a safe state and reconcile; no funds or records are lost or duplicated.
- The five switches share flag keys with WS-L.3.5 (verified by a cross-reference test).
- Crypto kill switches default to engaged (disabled) until a jurisdiction/feature is explicitly enabled (fail-closed).

**Testing:**
- Integration: Engage each switch; assert the corresponding flow is blocked with the correct message and in-flight items reconcile. Verify shared flag keys with WS-L.3.5.
- E2E: Disabled-state UX is accessible (screen reader, focus) and localized.

**Dependencies:** WS-O.2.2a (flag substrate), WS-L.3.5 (operational kill switches), WS-N.1.2 (disabled-state UX), WS-L.3.4 (reconciliation).

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

**Dependencies:** WS-0.3.1a/b (Vite base config + build validation), WS-0.1.4 (pinned toolchain via `.nvmrc`).

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

**Dependencies:** WS-0.3.1a (Vite config), WS-O.3.1a (determinism).

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

**Dependencies:** WS-0.3.1c (SRI manifest generation), WS-O.3.1a (deterministic output).

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

**Dependencies:** WS-0.3.1b (build validation), WS-0.6.1e (security audit job).

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

**Dependencies:** WS-O.3.1a (deterministic artifact), WS-0.6.1 (CI pipeline with OIDC).

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

**Dependencies:** WS-O.3.2a (cosign signing), WS-O.3.2c (SBOM as input material).

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

**Dependencies:** WS-0.2.1 (pnpm lockfile), WS-0.4.4 (lockfile-lint).

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

**Dependencies:** WS-O.3.2c (SBOM), WS-0.1.2 (AGPL license posture).

---

## WS-O.4 Integrity and abuse defense (no device attestation)

Because a PWA cannot use native device attestation, abuse defense is server-side and behavioral (Section 25.5). These tasks build the non-attestation defenses and the test harnesses that prove them.

### WS-O.4.1 Bot/sock-account resistance
**ID:** WS-O.4.1
**Ref:** Section 25.5

**Description:**
Implement server-side, behavioral bot and sock-puppet resistance without device attestation. Components: (1) account-age and trust tiers (new accounts have reduced reach and rate limits that relax with established, non-abusive history); (2) a privacy-preserving challenge layer (Turnstile-style CAPTCHA and/or lightweight proof-of-work) triggered on risk signals such as burst registration, datacenter IP ranges, or anomalous velocity -- never on normal use; (3) behavioral anomaly scoring (registration velocity, action cadence, device/locale churn) that feeds the trust tier and the MFCI coordination signal; (4) WebAuthn as a strong, phishing-resistant trust booster that raises an account's tier. No mechanism uses device attestation or fingerprinting beyond coarse, privacy-respecting signals; raw signals are not retained beyond what the abuse model needs.

**Acceptance criteria:**
- New accounts start in a low trust tier with reduced reach and stricter rate limits; tiers relax with verified, non-abusive history.
- Challenge prompts fire only on documented risk signals, not on normal use; solving a challenge does not require an account.
- Behavioral anomaly scores are produced and exposed to MFCI (WS-H.3) and moderation (WS-J.2.2c) without exposing private attention behavior.
- WebAuthn enrollment measurably raises trust tier.
- The defense degrades gracefully: if the challenge provider is unavailable, the system tightens rate limits rather than failing open.

**Testing:**
- Integration: Simulate burst registration from a datacenter range; assert challenges fire and reach is throttled. Establish a clean history; assert tier relaxation. Enroll WebAuthn; assert tier increase.
- Unit: Trust-tier state machine and risk-trigger thresholds.

**Dependencies:** WS-D.1.1 (User/account state), WS-D.1.2 (WebAuthn), WS-E.1.3c (rate limiting), WS-H.3 (MFCI consumer).

**Observability:** Emit metrics for challenge rate, challenge solve rate, tier distribution, and false-positive appeals; alert on challenge-rate spikes (possible attack or provider issue).

---

### WS-O.4.2 Forged-attention-event defense
**ID:** WS-O.4.2
**Ref:** Sections 25.5, 19.2

**Description:**
Harden the attention-event ingestion path (WS-E.1.3) against forgery and inflation so that client aggregates are treated as hints, never sole truth. Components: (1) server-side validation of event shape, bounds, and plausibility (e.g., dwell within physical limits, per-item caps re-enforced server-side); (2) replay protection (nonce + timestamp window) and per-user/per-IP rate limits; (3) lightweight integrity tokens binding an event batch to an authenticated session without device attestation; (4) cross-checks that flag implausible aggregates (e.g., source-open without a corresponding fetch) for downweighting and MFCI review; (5) strict rejection of any attention field that could encode wealth/payment data (defense-in-depth for no-pay-to-rank). This task is the security view of WS-E.1.3; the two share the same endpoint and validators.

**Acceptance criteria:**
- Events failing shape/bounds/plausibility validation are rejected or quarantined, never silently trusted.
- Replayed event batches (same nonce) are rejected; rate limits apply per user and per IP.
- Server re-enforces per-item dwell caps regardless of client-reported values.
- Implausible aggregates are downweighted and flagged to MFCI.
- No financial field can enter the attention path (schema denylist test passes).

**Testing:**
- Integration: Submit forged/inflated/replayed batches; assert rejection/quarantine and no ranking effect. Submit a batch with an injected wallet field; assert schema rejection.
- Unit: Plausibility validators and cap re-enforcement.

**Dependencies:** WS-E.1.3 (ingestion API + replay protection), WS-I.2.1b (schema-level financial denylist), WS-H.3 (MFCI), WS-C.4 (in-browser processing contract).

---

### WS-O.4.3 Coordinated-abuse and brigading hooks
**ID:** WS-O.4.3
**Ref:** Sections 25.5, 29.3

**Description:**
Provide the security-side integration that turns invariant signals into protective action for brigading, coordinated reporting, and harassment raids, per the coordination-incident workflow (Section 29.3). Components: (1) report-delay/aggregation mechanism so a sudden burst of reports on one target does not produce immediate automated action (mitigates weaponized reporting); (2) wiring from MFCI (WS-H.3) and tropical cascade (WS-H.7.2) risk states to ranking slow/freeze (WS-I.2.7) and the integrity analyst queue (WS-J.2); (3) target-protection actions (distribution freeze, surfacing protective controls to the targeted user) on harassment-raid detection; (4) a clear human-review path so automated freezes are confirmable, reversible, and appealable. Sub-minute response uses cheap statistics; the exact fiber test confirms (WS-H.3.3).

**Acceptance criteria:**
- A burst of reports on one target is delayed/aggregated rather than auto-actioned; the workflow matches Section 29.3.
- MFCI/cascade risk states drive ranking slow/freeze and create analyst cases with preserved margins/baselines.
- Harassment-raid detection triggers target protection and surfaces controls to the targeted user.
- Every automated protective action is reversible and appealable (notice + appeal).

**Testing:**
- Integration: Simulate a coordinated report burst; assert delay/aggregation and case creation, not immediate action. Simulate a synchronized cascade; assert ranking freeze and analyst case. Verify appeal path reverses a false-positive freeze.

**Dependencies:** WS-H.3 (MFCI), WS-H.7.2 (tropical cascade), WS-I.2.7 (kill switch/freeze), WS-J.1.1d/2 (report handling, console), WS-J.1.3 (appeals).

---

### WS-O.4.4 Phishing-PWA and look-alike-domain defense
**ID:** WS-O.4.4
**Ref:** Sections 25.5, 20.2

**Description:**
Defend against phishing PWAs and look-alike domains -- the web equivalent of repackaged-build threats. Components: (1) prominent publication of Licio's canonical domain and an onboarding/anti-impersonation step that teaches users to verify it; (2) the wallet risk interstitial reiterates the canonical domain before any signing flow; (3) signed provenance (WS-O.3.2) so the authentic bundle is publicly verifiable; (4) optional monitoring for newly registered look-alike domains and a takedown intake path; (5) a documented user-reporting channel for suspected fake "Licio" installs. No defense relies on app-store gatekeeping (out of scope by design).

**Acceptance criteria:**
- The canonical domain is published prominently and reinforced in onboarding and the wallet interstitial.
- Signing flows display the canonical-domain reminder (verified in WS-L.2.6 previews).
- A look-alike-domain monitoring + takedown intake path is documented and operational.
- A user-reporting channel for fake installs exists and routes to T&S.

**Testing:**
- E2E: Onboarding and wallet interstitial display the canonical-domain verification step (accessible, localized).
- Review: Takedown intake and user-reporting runbooks exist and are linked from support.

**Dependencies:** WS-O.3.2 (signed provenance), WS-L.2.6 (wallet interstitial), WS-A.2.1 (jurisdiction/onboarding posture), WS-N.2.3 (support workflows).

---

### WS-O.4.5 Model-gaming and adversarial-testing defense
**ID:** WS-O.4.5
**Ref:** Sections 25.5, 24.4

**Description:**
Reduce the gameability of ranking and invariant features. Components: (1) feature caps and saturation already in PWAtt (WS-E.2.3) are stress-tested for manipulation resistance; (2) randomized audits that periodically sample ranking decisions and re-score them with held-out/perturbed features to detect over-fitting to a single gameable signal; (3) an adversarial test corpus that simulates known gaming strategies (burst commenting, synthetic source-opens, threshold-gaming of trending) and asserts they do not gain disproportionate reach; (4) a feedback loop filing detections to MFCI/Braid (WS-H.7.3) and the integrity queue. These tests run before any ranking-power promotion (M3 gate).

**Acceptance criteria:**
- An adversarial corpus of known gaming strategies is maintained and runs against the ranking/invariant pipeline.
- No simulated gaming strategy achieves disproportionate reach beyond defined bounds.
- Randomized audits run on a schedule and surface anomalies to the integrity queue.
- Results gate ranking-power promotion at M3.

**Status (component 3 — the adversarial corpus — IMPLEMENTED):** the
ensemble adversarial suite ships as the named `pnpm check:adversarial` CI gate
(`apps/api/src/__tests__/invariants-ensemble-adversarial.test.ts`), documented
by the attack catalog `docs/invariants/ADVERSARIAL-THREATS.md`. It proves the
ENSEMBLE property — evading one invariant trips another — over the catalogued
strategies (Sybil brigade, paraphrase/near-dup flood, threshold-hugging,
synchronized cascade, context-collapse, path-steering, bias evasion,
coordinated-report abuse, multi-front evasion). The catalog and suite grow with
each invariant-hardening slice (the threshold-hugging meta-signal, the MFCI
calibration anti-poisoning, the MERI semantic independence signal, and the
account-age weighting). Components (1) feature-cap stress, (2) randomized
audits, and (4) the detection→integrity-queue feedback loop remain follow-ups.

**Testing:**
- Integration: Run the adversarial corpus against the scoring pipeline; assert reach bounds hold. Run a randomized audit; assert anomalies are surfaced.

**Dependencies:** WS-E.2.3 (PWAtt saturation/caps), WS-H.3 (MFCI), WS-H.7.3 (braid agenda dynamics), WS-I.3 (neutrality suite), WS-I.2.7 (kill switch).

---

## WS-O.5 Backend hardening, secrets, and key management

### WS-O.5.1 Secrets management and rotation
**ID:** WS-O.5.1
**Ref:** Sections 25.2, 25.4, 25.6

**Description:**
Establish secrets management so no secret, signing key, or seed phrase is ever embedded in the client bundle (Section 25.2 #7) and server secrets are centrally managed. Components: (1) a secrets store (cloud KMS/secret manager) as the single source of truth; server reads secrets at boot via the validated env schema (WS-0.5.3), never from source control; (2) rotation procedures and schedules for each secret class (DB credentials, session signing keys, VAPID keys, service-to-service tokens, indexer/gateway/treasury operator keys); (3) CI secret scanning (WS-0.6) blocks any secret committed to the repo; (4) a documented "no private keys/seed phrases ever requested, stored, transmitted, or logged" rule enforced by a log-redaction policy (WS-0.3.8) covering key/seed-phrase field names.

**Acceptance criteria:**
- All server secrets come from the secrets store; none are present in the repo or client bundle (verified by build-output scan and secret scanning).
- Each secret class has a documented rotation procedure and schedule; rotation is rehearsed at least once.
- Private keys/seed phrases are never logged: log-redaction covers their field names and a test asserts redaction.
- CI fails if a secret is committed.

**Testing:**
- CI: Secret scanner over the repo and build output; assert zero findings. Log-redaction unit test for key/seed-phrase fields.
- Drill: Execute one secret rotation in staging; verify no downtime and old secret invalidated.

**Dependencies:** WS-0.5.3 (env validation), WS-0.3.8 (pino redaction), WS-0.6.2 (dependency/secret scanning).

**Security:** Separation of duties: the operator who can read a secret cannot also approve its rotation policy unilaterally for treasury keys (see WS-O.5.2).

---

### WS-O.5.2 Least-privilege service keys and separation of duties
**ID:** WS-O.5.2
**Ref:** Section 25.6

**Description:**
Apply least privilege to every service identity and enforce separation of duties for high-value keys. Components: (1) distinct, minimally-scoped credentials for the event indexer, gateway workers, treasury operators, and deployment scripts -- no shared "god" credential; (2) platform signing keys (if any) stored in HSM/KMS with access policies and dual control; (3) treasury execution above low thresholds requires multisig and timelock (coordinated with WS-M.2.3); (4) per-identity audit logging of privileged operations; (5) periodic data-access reviews that re-justify each identity's scope. No human holds a single credential that can both move treasury funds and approve the policy that authorizes the move.

**Acceptance criteria:**
- Each service identity has a documented, minimal scope; no shared high-privilege credential exists.
- Platform signing keys are in HSM/KMS with dual-control access policies.
- Treasury execution above the configured threshold requires multisig + timelock.
- Privileged operations are audit-logged per identity; a periodic access review is scheduled and recorded.
- A separation-of-duties matrix shows no single actor can both execute and authorize a treasury movement.

**Testing:**
- Integration: Attempt a cross-scope operation with a service identity; assert denial. Attempt treasury execution below multisig threshold with a single key; assert it requires the second approval/timelock.
- Review: Access-review record and separation-of-duties matrix exist.

**Dependencies:** WS-O.5.1 (secrets store), WS-M.2.3 (spend auth/timelocks), WS-L.3 (gateway/indexer identities), WS-D.1.6c (audit log).

---

### WS-O.5.3 Encryption at rest, audit logging, and data-access reviews
**ID:** WS-O.5.3
**Ref:** Section 25.4

**Description:**
Implement backend data-protection controls. Components: (1) encryption at rest for sensitive stores (user PII, privacy settings, compliance cases, wallet-link table) using managed encryption with documented key custody; (2) append-only, tamper-evident audit logging for security-relevant actions (auth, role changes, moderation, financial, privacy requests) -- consistent with WS-D.1.6c, extended to all sensitive subsystems; (3) scheduled data-access reviews that re-justify which roles can read which sensitive datasets; (4) least-privilege database roles (app role cannot DROP/ALTER; migration role is separate). Audit logs themselves are access-controlled and retained per the retention policy (WS-E.1.4 / Section 22.4).

**Acceptance criteria:**
- Sensitive tables are encrypted at rest with documented key custody.
- All security-relevant actions write to an append-only, tamper-evident audit log.
- A scheduled data-access review exists with a recorded last-run and owner.
- Database roles follow least privilege (separate app vs migration roles; app role lacks DDL).

**Testing:**
- Integration: Verify sensitive tables are encrypted; verify the app DB role cannot run DDL. Generate each security-relevant action; assert an audit record is written and is append-only.
- Review: Data-access review record exists.

**Dependencies:** WS-0.7.2 (Postgres config), WS-D.1.6c (audit logging baseline), WS-E.1.4 (retention jobs), WS-N.2.1 (compliance case store).

---

### WS-O.5.4 Dependency, secret, and static/dynamic security scanning in CI
**ID:** WS-O.5.4
**Ref:** Sections 25.2, 25.4

**Description:**
Stand up the continuous supply-chain and code-security scanning that backstops WS-0's tooling. Components: (1) dependency vulnerability scanning (e.g., `pnpm audit` + advisory database) failing CI on high/critical with a documented triage/allowlist process; (2) secret scanning on every PR and on the full history (push-protection); (3) SAST (e.g., CodeQL) on application code with security queries; (4) optional DAST against a staging deployment for the OWASP top risks; (5) lockfile-lint (WS-0.4.4) and provenance checks gating release. Findings route to a security backlog with severity-based SLAs aligned to WS-O.2.1a.

**Acceptance criteria:**
- High/critical dependency vulnerabilities fail CI unless explicitly triaged with an expiry-dated allowlist entry.
- Secret scanning runs on PRs and history with push protection enabled.
- SAST runs on every PR to application code; new high-severity findings block merge.
- DAST runs against staging on a schedule (where applicable) and files findings.
- Findings have severity-based remediation SLAs.

**Testing:**
- CI: Introduce a known-vulnerable dependency in a test branch; assert CI fails. Commit a fake secret; assert push protection blocks it. Introduce a SAST-detectable flaw; assert the check fails.

**Dependencies:** WS-0.4.4 (lockfile-lint), WS-0.6.1e (security audit job), WS-0.6.2 (dependency scanning), WS-O.2.1a (severity/SLA).

---

## WS-O.6 Reliability and disaster recovery

### WS-O.6.1 Service-level objectives, monitoring, and alerting
**ID:** WS-O.6.1
**Ref:** Section 25.4

**Description:**
Define SLOs and stand up monitoring/alerting so availability and latency regressions are detected before users report them. Components: (1) SLOs for API availability and latency, ranking-pipeline freshness, and Core Web Vitals (the p75 budgets owned by WS-P.1.1d / WS-C.5.1); (2) structured-log-based and metric-based dashboards (built on pino logging from WS-0.3.8) for request rates, error rates, saturation, and queue depths; (3) alerting with severity mapping to WS-O.2.1a and routing to on-call (WS-O.2.1b); (4) synthetic checks for critical user journeys (load feed, submit contribution, sign-in) from multiple regions. Error budgets inform release gating.

**Acceptance criteria:**
- SLOs are documented with targets and error budgets for availability, latency, freshness, and Core Web Vitals.
- Dashboards show request/error/saturation/queue metrics in real time.
- Alerts fire on SLO burn and route to on-call with the correct severity.
- Synthetic checks cover the critical journeys and run continuously.

**Testing:**
- Integration: Inject latency/error in staging; assert alert fires with correct severity and routing. Verify synthetic checks detect a simulated outage of a critical journey.

**Dependencies:** WS-0.3.8 (pino structured logging), WS-P.1.1d (Core Web Vitals), WS-C.5.1 (RUM budgets), WS-O.2.1a/b (severity/escalation).

---

### WS-O.6.2 Backups and restore drills
**ID:** WS-O.6.2
**Ref:** Section 25.4

**Description:**
Implement backups and prove recoverability. Components: (1) automated, encrypted backups of PostgreSQL (and any durable state) with a documented RPO; (2) point-in-time recovery configured where supported; (3) periodic restore drills into an isolated environment that verify backups are usable and measure RTO; (4) documented runbooks for partial (single-table) and full restore; (5) backup integrity checks (restore + checksum) so a silently-corrupt backup is detected. Database migration rollback (WS-O.2.1c) depends on tested down migrations plus these backups as a safety net.

**Acceptance criteria:**
- Encrypted backups run automatically on a schedule meeting the documented RPO.
- A restore drill is performed on a schedule and recorded, with measured RTO meeting target.
- Restore runbooks exist for partial and full restore and are validated in the drill.
- Backup integrity is verified (a restore + checksum) -- corrupt backups are detected and alerted.

**Testing:**
- Drill: Restore the latest backup into an isolated environment; verify data integrity and measure RTO. Simulate a corrupt backup; assert integrity check fails and alerts.

**Dependencies:** WS-0.7.2 (Postgres), WS-O.2.1c (DB rollback), WS-O.5.3 (encryption/key custody).

---

### WS-O.6.3 Chain monitoring and threat-intelligence feeds
**ID:** WS-O.6.3
**Ref:** Sections 25.6, 29.7

**Description:**
Monitor on-chain and threat-intel signals that feed wallet/treasury security and incident response. Components: (1) monitoring of event ingestion lag, reorgs, deposits, withdrawals, and challenge windows (coordinated with the reorg-aware indexer WS-L.3.3 and reconciliation WS-L.3.4); (2) alerts on indexer divergence, suspicious treasury movement, high-risk recipients, and contract anomalies that open a treasury incident case (WS-O.2.1d); (3) an updatable wallet-drainer/threat-intel list backing the UGC interstitial (WS-O.1.4a) and transaction-preview risk labels, refreshable without a deploy; (4) suspicious-call monitoring on allowlisted contracts. Privacy boundary: monitoring uses on-chain/operational data, never users' private attention behavior.

**Acceptance criteria:**
- Reorg, ingestion-lag, deposit/withdrawal, and challenge-window events are monitored with alert thresholds.
- Indexer divergence or suspicious movement automatically opens a treasury incident case (WS-O.2.1d).
- The drainer/threat-intel list is updatable without a deploy and is consumed by WS-O.1.4a and transaction previews.
- Monitoring does not read or expose private attention behavior.

**Testing:**
- Integration: Simulate a reorg and an indexer divergence; assert alerts and case creation. Update the threat-intel list; assert the interstitial reflects it without a deploy.

**Dependencies:** WS-L.3.3 (reorg-aware indexer), WS-L.3.4 (reconciliation), WS-O.2.1d (treasury incident), WS-O.1.4a (drainer interstitial).

---

### WS-O.6.4 External audit and bug-bounty program
**ID:** WS-O.6.4
**Ref:** Sections 25.6, 20.2

**Description:**
Operationalize external security assurance. Components: (1) scope and schedule external audits of wallet signature flows, gateway, contract/L2 interactions, indexer, reconciliation, and treasury before mainnet funds and after material law-pack/contract changes (coordinated with the WS-L.1.3 audit-scope definition); (2) run a bug-bounty program with a published scope, safe-harbor language, severity rubric, and payout tiers; (3) a triage pipeline that routes external findings into the security backlog with WS-O.2.1a severities and SLAs; (4) re-test and disclosure procedures. Real-funds milestones (M5) are gated on a clean external audit and a live bounty.

**Acceptance criteria:**
- External audit scope and cadence are documented; an audit is completed before any real-funds pilot.
- A bug-bounty program is live with published scope, safe harbor, severity rubric, and payouts.
- External findings are triaged into the backlog with severities and SLAs and re-tested on fix.
- M5 gating on clean audit + live bounty is enforced in the launch-readiness register.

**Testing:**
- Review: Audit scope, bounty policy, and triage runbook exist; M5 gate references them. Submit a test finding through the triage pipeline; verify routing and SLA assignment.

**Dependencies:** WS-L.1.3 (audit requirement/bounty scope), WS-O.2.1a (severity/SLA), WS-M.2 (treasury), WS-N (compliance sign-off).

---

## Task dependency summary

| ID | Task | Key dependencies |
|---|---|---|
| WS-O.1.1a | OWASP XSS vector testing | WS-G.4.1/4.2a-d, WS-0.5.1, WS-0.4.3 |
| WS-O.1.1b | Trusted Types violation detection | WS-0.5.1/5.4, WS-G.4.2a |
| WS-O.1.1c | CSP bypass testing | WS-0.5.1a/b, WS-G.4.2 |
| WS-O.1.1d | Code audit (unsafe DOM) | WS-0.4.1b, WS-0.6.1e |
| WS-O.1.2a | Credential brute-force test | WS-D.1.3d, WS-D.1.4b, WS-O.4.1 |
| WS-O.1.2b | Session fixation test | WS-D.1.3b, WS-D.1.3e |
| WS-O.1.2c | Session hijacking prevention | WS-D.1.3b, WS-0.5.1 |
| WS-O.1.2d | Token replay test | WS-0.5.2b, WS-D.1.2a, WS-L.2.3a |
| WS-O.1.2e | CSRF verification test | WS-0.5.2b, WS-0.3.3 |
| WS-O.1.3a | Object-level authorization test | WS-D.1.6b/c |
| WS-O.1.3b | Role-based access test | WS-D.1.6b, WS-A.2.2 |
| WS-O.1.3c | Privilege escalation test | WS-D.1.6b, WS-O.1.3d |
| WS-O.1.3d | Mass assignment test | WS-D.1.1d, WS-0.2.2 |
| WS-O.1.4a | Wallet-drainer phishing simulation | WS-G.4.2c, WS-L.2.6, WS-O.6.3 |
| WS-O.1.4b | Blind-signing prevention | WS-L.2.6, WS-L.2.4, WS-L.3.1 |
| WS-O.1.4c | Unknown-recipient warning | WS-L.2.6, WS-L.3.1b-1, WS-M.2.3 |
| WS-O.1.4d | Contract-address allowlist test | WS-L.3.1b-1, WS-L.1.1a-1 |
| WS-O.1.4e | EIP-712 domain-separation test | WS-L.2.4c/d |
| WS-O.2.1a | Severity classification | (foundational) |
| WS-O.2.1b | Escalation paths | WS-O.2.1a |
| WS-O.2.1c | Rollback procedures | WS-O.2.2, WS-O.6.2, WS-M.2.4 |
| WS-O.2.1d | Treasury incident procedure | WS-O.2.2, WS-L.3.4, WS-M.2.4, WS-N.2.1 |
| WS-O.2.1e | Post-incident review template | WS-O.2.1a, WS-P.2.1 |
| WS-O.2.2a | Emergency feature-flag infrastructure | WS-0.7.2, WS-C.1.3c, WS-D.1.6b/c |
| WS-O.2.2b | Kill switches (5) | WS-O.2.2a, WS-L.3.5, WS-N.1.2, WS-L.3.4 |
| WS-O.3.1a | Deterministic build output | WS-0.3.1a/b, WS-0.1.4 |
| WS-O.3.1b | Content-hashed filenames | WS-0.3.1a, WS-O.3.1a |
| WS-O.3.1c | SRI hash generation | WS-0.3.1c, WS-O.3.1a |
| WS-O.3.1d | Inline script verification | WS-0.3.1b, WS-0.6.1e |
| WS-O.3.2a | Sigstore/cosign signatures | WS-O.3.1a, WS-0.6.1 |
| WS-O.3.2b | In-toto attestations | WS-O.3.2a, WS-O.3.2c |
| WS-O.3.2c | SBOM generation | WS-0.2.1, WS-0.4.4 |
| WS-O.3.2d | License cross-check | WS-O.3.2c, WS-0.1.2 |
| WS-O.4.1 | Bot/sock-account resistance | WS-D.1.1/1.2, WS-E.1.3c, WS-H.3 |
| WS-O.4.2 | Forged-attention-event defense | WS-E.1.3, WS-I.2.1b, WS-H.3, WS-C.4 |
| WS-O.4.3 | Coordinated-abuse/brigading hooks | WS-H.3, WS-H.7.2, WS-I.2.7, WS-J.1/2 |
| WS-O.4.4 | Phishing-PWA/look-alike defense | WS-O.3.2, WS-L.2.6, WS-A.2.1, WS-N.2.3 |
| WS-O.4.5 | Model-gaming/adversarial testing | WS-E.2.3, WS-H.3, WS-H.7.3, WS-I.3 |
| WS-O.5.1 | Secrets management and rotation | WS-0.5.3, WS-0.3.8, WS-0.6.2 |
| WS-O.5.2 | Least-privilege keys / SoD | WS-O.5.1, WS-M.2.3, WS-L.3, WS-D.1.6c |
| WS-O.5.3 | Encryption at rest / audit / reviews | WS-0.7.2, WS-D.1.6c, WS-E.1.4, WS-N.2.1 |
| WS-O.5.4 | Dependency/secret/SAST-DAST scanning | WS-0.4.4, WS-0.6.1e/6.2, WS-O.2.1a |
| WS-O.6.1 | SLOs, monitoring, alerting | WS-0.3.8, WS-P.1.1d, WS-C.5.1, WS-O.2.1a/b |
| WS-O.6.2 | Backups and restore drills | WS-0.7.2, WS-O.2.1c, WS-O.5.3 |
| WS-O.6.3 | Chain monitoring / threat-intel | WS-L.3.3/3.4, WS-O.2.1d, WS-O.1.4a |
| WS-O.6.4 | External audit and bug bounty | WS-L.1.3, WS-O.2.1a, WS-M.2, WS-N |

---

## Workstream definition of done

WS-O is complete when ALL of the following conditions hold:

1. **Zero XSS vectors:** The full XSS test suite (incl. mXSS/DOM-clobbering/SVG/Markdown families) passes with zero vectors reaching the DOM. CSP, Trusted Types (named policy only), DOMPurify, and Markdown AST sanitization are enforced and tested together (WS-O.1.1a-d).

2. **Auth attack mitigation:** Credential stuffing, brute force, session fixation, session hijacking, token replay, and CSRF are tested and mitigated with rate limiting, lockout, secure `__Host-` cookies, rotation, and constant-time CSRF checks (WS-O.1.2a-e).

3. **API authorization coverage:** Object-level, RBAC, privilege-escalation, and mass-assignment defenses are tested for every endpoint; unauthorized access returns 403/404 with no existence leakage (WS-O.1.3a-d).

4. **Wallet security:** Drainer phishing, blind-signing prevention, unknown-recipient warnings, contract allowlist, and EIP-712 domain separation are tested; the application never generates raw-hex signing requests (WS-O.1.4a-e).

5. **Integrity without attestation:** Bot/sock resistance, forged-attention-event defense, coordinated-abuse hooks, phishing-PWA defense, and model-gaming defense are implemented and tested entirely server-side/behaviorally -- no device attestation or invasive fingerprinting (WS-O.4.1-4.5).

6. **Emergency controls:** The feature-flag substrate and all five kill switches (wallet, payment, action submission, treasury execution, governance voting) work at global/region/room scope, fail closed, share flag keys with WS-L.3.5, and underpin rollback and treasury incident response (WS-O.2.2a/b).

7. **Incident readiness:** Severity classification, escalation paths, rollback procedures, the seven-phase treasury incident procedure, and the PIR template are documented and validated via tabletop and rollback drills (WS-O.2.1a-e).

8. **Backend hardening:** Secrets come only from the managed store (never the client bundle or repo), with rotation rehearsed; least-privilege service identities and separation of duties are enforced for treasury keys; sensitive data is encrypted at rest with append-only audit logging; dependency/secret/SAST(/DAST) scanning gates CI (WS-O.5.1-5.4).

9. **Reliability and DR:** SLOs with error budgets, monitoring/alerting, synthetic journey checks, automated encrypted backups, and a recorded restore drill (measured RTO/RPO) are in place; chain monitoring feeds treasury incident response (WS-O.6.1-6.3).

10. **Reproducible builds with provenance:** Two builds from one commit are byte-identical; all served scripts/styles carry SRI; production builds are cosign-signed with in-toto attestations in an append-only log; an SBOM is generated and license-cross-checked against AGPL-3.0-or-later; zero inline scripts/styles ship (WS-O.3.1a-d, WS-O.3.2a-d).

11. **External assurance:** External audit scope is defined and a clean audit plus a live bug bounty gate the M5 real-funds pilot (WS-O.6.4).

12. **No secrets in client; no private keys ever:** The bundle contains no secret, signing key, or seed phrase; private keys/seed phrases are never requested, stored, transmitted, or logged (redaction tested).

# WS-J. Trust, Safety, and Abuse Operations

**Milestone:** M1 | **Priority:** 0-1 | **Dependencies:** WS-D.1 | **Wave:** 3-4 | **Estimated duration:** 3-4 weeks | **Task count:** 29 atomic cards

## Overview

Safety controls work before the forum is complete. Reports, blocks, mutes, and appeals are early features that ship in Wave 3, ahead of WS-G (forum/conversation), so a user can protect themselves the moment they can read and post. The moderation console serves stewards and safety moderators (roles defined in WS-A.2.2). Safety is continuous, not a phase: automated pre-checks, coordinated-report detection, and the audit trail run from M1 onward and feed the transparency reports (WS-A.1.3a, WS-P.2).

This workstream depends on WS-D.1 (accounts, sessions, role grants, MFA for stewards) and on the WS-A doctrine documents that define *what* is enforced: the moderation taxonomy and reason codes (WS-A.1.2), the appeal-eligibility matrix (WS-A.1.2c), the steward roles and console authorization (WS-A.2.2), and the anti-signal catalog (WS-A.1.1c). It has no dependency on WS-G — reports work before the forum is complete (index dependency graph). MFCI integration points (WS-H.3) degrade gracefully before invariants ship: until MFCI is live, coordinated-report checks run on cheap statistics (temporal clustering, account-correlation heuristics) and tighten when the MFCI service is available, consistent with the cold-start fallback principle.

### Cross-cutting requirements (apply to every task in WS-J)

- **Reason codes are taxonomy-bound.** Every enforcement action and report carries a reason code from `docs/policy/MODERATION_TAXONOMY.md` (WS-A.1.2). Invalid codes are rejected.
- **Notice and appeal for significant actions.** Significant actions emit a readable statement of reasons and, where appealable (WS-A.1.2c), an appeal path. Shadow/reduced-distribution actions are never silent.
- **Human review, not auto-removal, for policy-risk.** Automated layers flag and prioritize; only high-confidence spam (WS-J.2.6a) and malware (WS-J.2.6b) are auto-blocked. Everything else routes to a human.
- **Reporter-identity protection.** A reporter's identity is never exposed to the reported user through any surface or API. Reporter identities are never published in transparency reports and never placed on-chain (SPEC 19.5).
- **MFCI base-rate conditioning.** Coordination/brigading detection conditions on normal activity so large authentic communities are not penalized for volume (MFCI-1); coordinated reporting has delayed enforcement until reviewed (MFCI-2).
- **Authorization.** Every console capability is gated by steward role (WS-A.2.2) with object-/action-level authorization (SPEC 25.4). Financial data (wallet, payment, treasury, donor) is excluded from moderation surfaces (ranking-neutrality principle; SPEC 13.6).
- **Auditability.** Every steward action and every automated block emits a structured audit record (WS-J.2.5 fields). Bulk actions emit one record per affected item.
- **Accessibility.** All console and user-facing safety surfaces meet WCAG 2.2 AA: keyboard-operable, screen-reader-labeled, non-color-only status, ≥48×48px touch targets.
- **Observability.** Each task defines the metrics, alerts, and dashboards it emits; safety SLAs, queue depth, false-positive rates, and appeal-overturn rate are continuously monitored and feed WS-A.1.3a.
- **Room-class scope (server-hosted vs Private P2P).** WS-J's moderation authority — the report queue, the console, the action palette, and the automated pre-checks — covers **server-hosted content only**: the `public_server` ("Public room") and `restricted_server` ("Members-only server room") classes (WS-Q; the latter renamed from WS-Q's "private room" by WS-S §20.1). For `private_p2p` ("Private P2P room", WS-S) the platform never possesses content, keys, op heads, or membership and therefore **cannot read, alter, recover, moderate, add members to, or delete** in-room content (PRIVATE_SPEC §11.4 — no platform-role or emergency-key authority); the platform's only levers are **delisting a listed directory stub** and **suspending a Licio account's access to Licio-hosted services**, and in-room moderation is performed locally by the room's key holders (MLS epoch operations). This is an honest, by-design boundary — **not** a reduction of WS-J's authority over server-hosted content, where the M6 moderation-override gate ("the platform can moderate harmful content regardless of local governance votes") holds in full. Content reconciled from the WS-R / LCAP offline transport lands in the **same** canonical server state and traverses the identical validation pipeline, so it is fully moderable server-side once reconciled — offline ingress never bypasses reports or moderation.

### API conventions

All endpoints are Hono routes behind the BFF (SPEC 23.1): HTTPS, short-lived tokens, `SameSite=Strict` cookies with CSRF protection, and `zod`-validated request/response payloads co-located with route types. Request/response shapes below are normative for the client contract (WS-C.3 Hono RPC client). Errors use the standard envelope `{ error: { code, message, fields? } }`. Timestamps are RFC 3339 UTC. IDs are opaque strings.

---

## WS-J.1 User safety controls

### WS-J.1.1a POST /v1/reports endpoint
**ID:** WS-J.1.1a
**Ref:** Sections 18.3, 23.2

Implement the `POST /v1/reports` endpoint for user-submitted content and account reports. The endpoint accepts:

- **target_type:** content | account | room.
- **target_id:** the ID of the reported content, account, or room.
- **reason_code:** a code from the moderation taxonomy (WS-A.1.2), mapping to the policy categories defined in Section 18.1 (illegal content, threats, harassment, hate, sexual exploitation, graphic content, misinformation, impersonation, spam, privacy violations, synthetic media, IP).
- **context:** optional free-text field (max 500 characters) providing additional context.
- **evidence_urls:** optional list of URLs supporting the report (screenshots, links).

The endpoint validates inputs against the zod schema, creates a report record with status "new," assigns a severity based on the reason code, and routes to the appropriate queue (emergency or standard per WS-J.1.1b). The endpoint returns a report_id and a confirmation.

Reports are rate-limited per user (WS-J.1.1d). The reporter's identity is protected from the reported user.

**Request/response shape:**

    POST /v1/reports
    Request {
      target_type: "content" | "account" | "room",
      target_id: string,
      reason_code: string,            // must exist in MODERATION_TAXONOMY (WS-A.1.2)
      context?: string,               // max 500 chars
      evidence_urls?: string[]        // max 5, each a valid https URL
    }
    201 Response {
      report_id: string,
      status: "new",
      severity: "minor" | "moderate" | "severe" | "critical",
      routed_to: "emergency" | "standard",
      created_at: string              // RFC 3339
    }
    Errors:
      400 { error: { code: "invalid_reason_code" | "validation_error", fields? } }
      404 { error: { code: "target_not_found" } }
      429 { error: { code: "rate_limited", retry_after: number } }

**Acceptance criteria:**
- Endpoint accepts valid reports and returns a report_id.
- Reason codes map to the moderation taxonomy (WS-A.1.2).
- Invalid reason codes are rejected with a 400 response.
- Report records are persisted with status "new," severity, and timestamp.
- Reporter identity is not exposed to the reported user.
- The endpoint returns within 500ms.
- Reports are idempotent for the same reporter + target + reason within a cooldown window.

**Testing:**
- Unit test: valid report submission returns 201 with report_id.
- Unit test: invalid reason code returns 400.
- Unit test: missing required fields return 400 with field-level errors.
- Unit test: malformed/non-https evidence URL is rejected.
- Integration test: report appears in the moderation queue after submission.
- Security test: reporter identity is not accessible via any API by the reported user.
- Rate limit test: excessive reports from one user are rate-limited (WS-J.1.1d).
- Idempotency test: duplicate reporter+target+reason within cooldown returns the original report_id, not a new record.

**Dependencies:** WS-D.1 (auth, session, user identity), WS-A.1.2a (reason codes and default severities), WS-J.1.1b (queue routing). Edge cases: reporting one's own content (allowed, e.g. regret/withdrawal); reporting deleted content (resolve against tombstone); reporting a room (target_type=room) routes to the room's steward layer first.

**Observability:** emit `reports.created` (tagged by reason_code, severity, target_type, routed_to), report-submission latency histogram, and validation-rejection counter. Alert on anomalous spikes per reason_code (feeds WS-J.2.6e).

**Security/privacy:** reporter identity stored separately from the report payload returned to any non-authorized actor; only authorized steward roles (WS-A.2.2) may see reporter identity, and only when role requires it. Evidence URLs are stored, not fetched server-side at submission time (SSRF avoidance); any later fetch goes through the malware-check path (WS-J.2.6b).

---

### WS-J.1.1b Emergency vs disagreement distinction
**ID:** WS-J.1.1b
**Ref:** Section 18.3

Distinguish emergency reports from disagreement reports at submission time. Emergency reports cover imminent safety threats and receive priority routing. The distinction is based on reason code classification:

**Emergency reason codes** (priority routing):
- Credible threats of violence or imminent harm.
- CSAM (child sexual abuse material).
- Active self-harm or suicide risk.
- Doxxing with imminent physical risk.
- Terrorism or incitement to imminent violence.

**Standard reason codes** (normal queue):
- Harassment, hate speech, spam, misinformation, impersonation, IP violations, policy disagreements.

Emergency reports bypass the standard queue and are routed to the emergency review path with a tight SLA (target: review within 1 hour). The system sends an alert to on-call safety moderators for emergency reports. Standard reports enter the priority-sorted queue based on severity.

The emergency/standard mapping is sourced from the moderation taxonomy (WS-A.1.2a): the emergency set is exactly the reason codes whose default severity is `critical` plus the explicitly enumerated imminent-risk codes. This keeps the routing rule single-sourced and version-controlled.

**Acceptance criteria:**
- Emergency reason codes are classified and documented.
- Emergency reports are routed to the emergency queue, not the standard queue.
- Emergency reports trigger an alert to on-call safety moderators.
- Emergency SLA is tracked (target: review within 1 hour).
- Standard reports enter the priority-sorted standard queue.
- Reason code classification is configurable and version-controlled.

**Testing:**
- Unit test: report with emergency reason code is routed to the emergency queue.
- Unit test: report with standard reason code is routed to the standard queue.
- Integration test: emergency report triggers an alert notification.
- SLA test: emergency reports that exceed the SLA are escalated.
- Configuration test: adding a new emergency reason code correctly routes to the emergency queue.
- Consistency test: the emergency set equals the taxonomy-derived set (no drift between routing config and WS-A.1.2a).

**Dependencies:** WS-A.1.2a (severity defaults and emergency enumeration), WS-J.1.1a (submission), on-call alerting (WS-O.2 incident tooling). Edge cases: a standard-severity report that the reporter marks as urgent does not bypass the queue on the reporter's say-so (prevents urgency abuse); reclassification by a reviewer re-routes the live case and logs the change.

**Observability:** emit `reports.emergency_routed`, emergency-queue depth, and emergency time-to-first-review histogram with SLA-breach counter. Page on-call when emergency-queue oldest item approaches the 1-hour SLA.

**Security/privacy:** emergency alerts carry the minimum necessary context (target_id, reason_code, severity), not the reporter identity, in the paging channel; full context is available only inside the authenticated console.

---

### WS-J.1.1c Two-tap report UX
**ID:** WS-J.1.1c
**Ref:** Section 18.3

Implement a two-tap report flow accessible from any content in the app. The flow is:

1. **Long-press** (or right-click on desktop) on any content item (story card, comment, thread, evidence card, user profile). A context menu appears with "Report" as an option.
2. **Tap "Report":** a reason selector sheet slides up with the available reason codes from the moderation taxonomy, grouped by category (safety, content quality, policy). Each reason has a short label and a one-line description.
3. **Tap a reason:** the report is submitted. An optional context field is available but not required. A confirmation toast appears: "Report submitted. We will review it."

The entire flow completes in a maximum of 3 taps (long-press + "Report" + reason). The optional context field adds one more tap only if the user chooses to provide additional detail.

**Acceptance criteria:**
- Long-press on any content item shows a context menu with "Report."
- Reason selector shows all applicable reason codes grouped by category.
- Selecting a reason submits the report and shows a confirmation.
- The flow completes in maximum 3 taps (without optional context).
- The reason selector is accessible: keyboard-operable, screen-reader-compatible, minimum 48x48px touch targets.
- The flow works offline (report is queued and submitted when connectivity returns).

**Testing:**
- E2E test: long-press on a story card, select "Report," select a reason, verify report submission.
- E2E test: long-press on a comment, verify the same flow.
- Accessibility test: complete the report flow using only keyboard navigation.
- Accessibility test: screen reader announces each step of the flow.
- Offline test: submit a report while offline, verify it is queued and submitted on reconnect.
- Touch target test: all interactive elements in the flow meet 48x48px minimum.
- Idempotency test: an offline-queued report that the user re-submits on reconnect does not create a duplicate (relies on WS-J.1.1a idempotency window).

**Dependencies:** WS-J.1.1a (endpoint), WS-A.1.2a (reason-code labels/descriptions and grouping), WS-B (primitive components, focus management), WS-C.2 (offline store / background sync for offline queueing). Edge cases: long-press conflicts with text selection (report affordance also reachable from an explicit overflow/"..." menu for keyboard and assistive-tech users); reporting from a profile sets target_type=account.

**Observability:** emit `report_ux.opened`, `report_ux.completed`, abandonment rate by step, and offline-queued-report count. A high abandonment at the reason step signals confusing labels (feeds WS-A.1.2a copy review).

**Security/privacy:** the optional context field is sanitized client-side and server-side; no PII prompts are shown. Offline-queued reports are stored locally (IndexedDB) and cleared after successful submission.

---

### WS-J.1.1d Report rate limiting
**ID:** WS-J.1.1d
**Ref:** Sections 18.3, 8.3

Implement per-user rate limits for report submission to prevent report flooding and abuse. Rate limits:

- **Per-user cap:** maximum N reports per hour (configurable, default 10).
- **Per-target cap:** maximum M reports from the same user against the same target per 24 hours (configurable, default 3).
- **Global velocity:** if a single target receives reports from many users simultaneously, MFCI integration detects coordinated reporting patterns.

When a user exceeds the rate limit, the report endpoint returns a 429 with a "try again later" message and the retry-after time. Rate limit state is tracked server-side, not in the client.

MFCI integration: when multiple reports arrive against the same target within a short window, the system computes the MFCI coordination score for the reporting pattern. If the coordination score exceeds the threshold, reporting impact on the target is delayed pending integrity review, per MFCI-2.

**Acceptance criteria:**
- Per-user rate limit is enforced (default: 10 reports/hour).
- Per-target rate limit is enforced (default: 3 reports from same user per target per 24 hours).
- Exceeding rate limits returns 429 with retry-after.
- MFCI coordination score is computed for simultaneous reports against the same target.
- High-coordination report patterns delay enforcement impact pending review.
- Rate limit configuration is adjustable without code deployment.

**Testing:**
- Unit test: submitting 11 reports in one hour returns 429 on the 11th.
- Unit test: submitting 4 reports against the same target in 24 hours returns 429 on the 4th.
- Integration test: 20 reports from different users against the same target within 2 minutes triggers MFCI coordination check.
- Integration test: high-coordination reports delay enforcement impact.
- Configuration test: changing rate limits takes effect without restart.
- Base-rate test: a large room legitimately reporting a genuinely harmful item is not throttled into uselessness (per-user caps do not block distinct genuine reporters; MFCI-1 conditioning applies).

**Dependencies:** WS-J.1.1a (endpoint), WS-H.3 (MFCI; degrades to cheap clustering statistics before MFCI is live), WS-J.2.6e (coordinated-report detection consumes the same signal). Edge cases: a user editing-then-resubmitting to evade the per-target cap is treated as the same logical report; rate-limit counters are keyed on authenticated user, not IP, to avoid penalizing shared networks.

**Observability:** emit `reports.rate_limited` (per-user vs per-target), and coordination-check trigger count. Dashboard the ratio of rate-limited to accepted reports to tune defaults.

**Security/privacy:** rate-limit state is server-side and not enumerable by clients (no oracle for "how many more can I send"). Coordination scoring conditions on base rates so authentic mass-reporting of a real harm is not mislabeled as brigading (MFCI-1).

---

### WS-J.1.1e Published support contact
**ID:** WS-J.1.1e
**Ref:** Sections 18.3, 18.4

Publish a support contact accessible from every screen in the app. The support contact provides a way for users to reach the safety team outside the in-app report flow (for situations where the report flow is insufficient, such as account lockout, urgent non-content safety issues, or accessibility barriers).

The support contact is accessible from the profile menu on every screen and includes:
- An email address for the safety team.
- A link to the support/help center.
- Emergency resource links (crisis hotlines, child safety reporting) appropriate to the user's jurisdiction.

The support contact is always visible and does not require authentication to access (so locked-out users can still reach support).

**Acceptance criteria:**
- Support contact is accessible from the profile/help menu on every screen.
- Support contact is accessible without authentication.
- Support contact includes email, help center link, and emergency resource links.
- Emergency resource links are jurisdiction-appropriate when jurisdiction is known.
- Support contact is screen-reader-accessible with appropriate labels.

**Testing:**
- E2E test: navigate to 5 different screens, verify support contact is accessible from each.
- E2E test: access support contact without being logged in.
- Accessibility test: screen reader announces the support contact correctly.
- Content test: emergency resource links are present and functional.
- Jurisdiction test: with a known jurisdiction, region-appropriate hotlines render; with unknown jurisdiction, a safe default set renders.

**Dependencies:** WS-D.1 (auth state, to render in both authed and unauthed shells), WS-A.2.3 / WS-N (jurisdiction resolution for region-appropriate resources), WS-B (layout/menu primitives). Edge cases: locked-out/suspended users must still reach support (renders in the suspension screen); offline state shows cached contact info.

**Observability:** emit `support_contact.opened` by entry point and auth state. A spike from the lockout screen signals an auth incident.

**Security/privacy:** the support contact surface requests no credentials; emergency resource links open externally with appropriate `rel="noopener"` and are part of the strict CSP allowlist (WS-O.1).

---

### WS-J.1.2a POST /v1/blocks endpoint (block)
**ID:** WS-J.1.2a
**Ref:** Sections 18.3, 18.4

Implement account blocking. A block prevents all interaction between the two accounts and hides content bilaterally: the blocker no longer sees the blocked user's content, and the blocked user cannot interact with (reply to, mention, report-pile, follow, or DM where applicable) the blocker. Blocks take effect immediately and are persisted. Enforcement is at the API level: a blocked user's attempt to interact with the blocker is rejected server-side, not merely hidden client-side.

This task fills the canonical WS-J.1.2 (block and mute) scope referenced by the workstream definition of done; it is split into block (WS-J.1.2a) and mute (WS-J.1.2b) because they have different semantics, different enforcement points, and are independently testable/reversible.

**Request/response shape:**

    POST /v1/blocks
    Request { blocked_user_id: string }
    201 Response { block_id: string, blocked_user_id: string, created_at: string }
    DELETE /v1/blocks/{block_id}    // unblock
    200 Response { ok: true }
    GET /v1/blocks                  // list the caller's blocks (paginated)
    200 Response { blocks: [{ block_id, blocked_user_id, created_at }], next_cursor? }
    Errors:
      400 { error: { code: "cannot_block_self" } }
      404 { error: { code: "user_not_found" } }

**Acceptance criteria:**
- Block takes effect immediately and is persisted.
- Block hides content bilaterally (neither party sees the other's content in feeds, threads, or search).
- API-level enforcement: blocked users cannot reply to, mention, or otherwise interact with the blocker; attempts are rejected server-side.
- Unblock reverses the effect.
- A user cannot block themselves (400).
- The block relationship is private (the blocked user is not notified that they were blocked).

**Testing:**
- Unit test: block creates a persisted, immediately effective relationship.
- Unit test: self-block returns 400.
- Integration test: after blocking, the blocked user's content is absent from the blocker's feed/thread/search.
- Security test: blocked user's API attempt to reply to or mention the blocker is rejected with an authorization error.
- Integration test: unblock restores normal visibility.
- Privacy test: the blocked user receives no notification of the block.

**Dependencies:** WS-D.1 (accounts), WS-G (content surfaces consume the block relationship; before WS-G ships, blocks are stored and enforced at the API boundary so they are correct the moment content exists). Edge cases: blocking a steward does not exempt the blocker from moderation (blocks are interpersonal, not a moderation shield); existing replies/mentions made before the block are handled per thread-integrity rules (tombstoned/hidden from the blocker, not deleted globally); mutual interactions in shared threads are resolved so the conversation remains coherent for third parties.

**Observability:** emit `blocks.created` / `blocks.removed` counters and block-enforcement-rejection counter (signals attempted evasion).

**Security/privacy:** block lists are private to the owner; never exposed to the blocked party or published. Blocks are never placed on-chain. Block enforcement is authorization, not just rendering, to prevent client-side bypass.

---

### WS-J.1.2b POST /v1/mutes endpoint (mute)
**ID:** WS-J.1.2b
**Ref:** Sections 18.3, 18.4

Implement account muting. A mute hides the muted user's content from the muting user without preventing the muted user from interacting and without notifying the muted user. Mute is a one-directional visibility filter for the muter; the muted user is unaffected and unaware. Mutes take effect immediately and are persisted.

**Request/response shape:**

    POST /v1/mutes
    Request { muted_user_id: string, duration?: "1d" | "7d" | "30d" | "forever" }
    201 Response { mute_id: string, muted_user_id: string, expires_at?: string, created_at: string }
    DELETE /v1/mutes/{mute_id}      // unmute
    200 Response { ok: true }
    GET /v1/mutes                   // list the caller's mutes (paginated)
    200 Response { mutes: [{ mute_id, muted_user_id, expires_at?, created_at }], next_cursor? }

**Acceptance criteria:**
- Mute hides the muted user's content from the muting user only.
- Mute does not prevent the muted user from interacting and does not notify them.
- Mute takes effect immediately and is persisted.
- Optional mute duration is supported; expired mutes auto-lift.
- Unmute reverses the effect.
- The mute relationship is private to the muter.

**Testing:**
- Unit test: mute creates a persisted, immediately effective one-directional filter.
- Integration test: muted user's content is hidden from the muter's feed/thread; the muted user's experience is unchanged.
- Unit test: a mute with a duration expires at the correct time and content reappears.
- Privacy test: the muted user receives no notification and cannot enumerate who muted them.
- Integration test: unmute restores visibility.

**Dependencies:** WS-D.1 (accounts), WS-G (content surfaces apply the mute filter), WS-C (client filtering for muted content with a clear "muted" affordance rather than silent gaps where appropriate). Edge cases: mute vs block precedence (a block supersedes a mute for the same pair); muted content that is also reported still flows to moderation (mute is personal, not a moderation suppressant).

**Observability:** emit `mutes.created` / `mutes.removed` / `mutes.expired` counters and mute-duration distribution.

**Security/privacy:** mute lists are private to the owner and never published or placed on-chain. Mute is purely a viewing-side filter and carries no enforcement against the muted user.

---

### WS-J.1.3a Appeal eligibility rules
**ID:** WS-J.1.3a
**Ref:** Sections 16.4, 18.3

Define which moderation actions are appealable and under what conditions. Appeal eligibility:

| Action | Appealable | Conditions |
|---|---|---|
| Warn | Yes | Immediately after action. |
| Hide | Yes | Immediately after action. |
| Remove | Yes | Immediately after action. |
| Restrict | Yes | Immediately after action. |
| Ban | Yes | After a cooldown period (configurable, default 24 hours). |
| Emergency restriction | No | Until the emergency review is complete. After review, the resulting action is appealable. |

Appeal eligibility is checked before the appeal form is shown to the user. Ineligible appeals display a message explaining why the appeal is not available and when it will become available.

This rules implementation mirrors the policy-side appeal-eligibility matrix (WS-A.1.2c); the two must agree exactly. Where WS-A.1.2c enumerates additional significant actions (shadow/reduced-distribution with notice, temporary suspension, room-governance freeze, treasury freeze), this implementation includes them with the same eligibility, reviewing role, and conditions.

**Acceptance criteria:**
- Each moderation action type has a documented appeal eligibility status.
- Warn, hide, remove, and restrict actions are immediately appealable.
- Ban actions are appealable after the cooldown period.
- Emergency restrictions are not appealable until the emergency review completes.
- The appeal form is hidden for ineligible actions with a clear explanation.
- Eligibility rules are configurable and version-controlled.
- Shadow/reduced-distribution actions are appealable and the user has been notified they occurred.

**Testing:**
- Unit test: each action type returns correct eligibility status.
- Unit test: ban action within cooldown period returns ineligible with cooldown remaining time.
- Unit test: ban action after cooldown returns eligible.
- Unit test: emergency restriction returns ineligible with explanation.
- E2E test: user sees "appeal" option for an eligible action and no option for an ineligible action.
- Consistency test: eligibility output matches the WS-A.1.2c matrix for every action type (no drift).

**Dependencies:** WS-A.1.2c (canonical eligibility matrix), WS-A.2.2 (reviewing roles). Edge cases: an action that was modified on appeal is not re-appealable indefinitely (one appeal per action, except a ban's single permitted appeal); CSAM/imminent-threat removals are non-appealable by policy and must surface the lawful basis rather than an appeal path.

**Observability:** emit `appeals.eligibility_checked` by action type and outcome; track the share of actions that are appealable (should match policy expectations).

**Security/privacy:** eligibility checks do not leak other users' case details; the "why ineligible" message references only the requesting user's own action.

---

### WS-J.1.3b POST /v1/appeals endpoint
**ID:** WS-J.1.3b
**Ref:** Sections 16.4, 23.2

Implement the `POST /v1/appeals` endpoint for user-submitted appeals of moderation actions. The endpoint accepts:

- **action_id:** reference to the original moderation action being appealed.
- **user_statement:** the user's explanation of why the action should be reconsidered (max 2000 characters).
- **new_evidence:** optional list of evidence references (URLs, screenshots, context) supporting the appeal.

The endpoint validates:
- The action exists and belongs to the requesting user.
- The action is eligible for appeal (per WS-J.1.3a).
- The user has not already submitted an appeal for this action.
- The user statement is non-empty.

On success, the appeal is created with status "pending," assigned to a reviewer different from the original decision-maker (WS-J.1.3c), and the user receives a confirmation.

**Request/response shape:**

    POST /v1/appeals
    Request {
      action_id: string,
      user_statement: string,         // 1..2000 chars
      new_evidence?: string[]         // max 5 https URLs
    }
    201 Response {
      appeal_id: string,
      status: "pending",
      action_id: string,
      sla_due_at: string,             // RFC 3339
      created_at: string
    }
    Errors:
      400 { error: { code: "validation_error", fields? } }
      403 { error: { code: "action_not_appealable", reason: string, available_at?: string } }
      404 { error: { code: "action_not_found" } }
      409 { error: { code: "appeal_already_exists", appeal_id: string } }

**Acceptance criteria:**
- Endpoint accepts valid appeals and returns an appeal_id.
- Ineligible actions are rejected with a 403 and explanation.
- Duplicate appeals for the same action are rejected with a 409.
- Appeals are assigned to a reviewer different from the original decision-maker.
- The endpoint returns within 500ms.
- Appeal records are persisted with status "pending," timestamp, and action reference.

**Testing:**
- Unit test: valid appeal returns 201 with appeal_id.
- Unit test: appeal for ineligible action returns 403.
- Unit test: duplicate appeal returns 409.
- Unit test: appeal with empty user_statement returns 400.
- Integration test: appeal appears in the appeal review queue.
- Security test: user cannot appeal another user's moderation action.

**Dependencies:** WS-D.1 (auth/ownership), WS-J.1.3a (eligibility), WS-J.1.3c (assignment/queue). Edge cases: appealing a ban during its cooldown returns 403 with `available_at`; appealing an emergency restriction before review completes returns 403 with the deferred-eligibility reason; new_evidence URLs are stored, not fetched at submission (SSRF avoidance), and routed through malware checks if later opened.

**Observability:** emit `appeals.created`, appeal-submission latency, and 403/409 rejection counters by reason. Track appeal rate per action type (feeds appeal-overturn-rate metric TM-AOR).

**Security/privacy:** ownership is enforced server-side (a user may only appeal their own action). The appeal payload and any reviewer notes are access-controlled to `ROLE_APPEALS` (WS-A.2.2).

---

### WS-J.1.3c Appeal review queue
**ID:** WS-J.1.3c
**Ref:** Section 16.4

Implement the appeal review queue as a separate queue from the report queue. Appeals are assigned to reviewers who were not involved in the original moderation decision to ensure independent review.

Queue features:
- **Separate queue:** appeals are not mixed with reports in the moderation queue.
- **Independent reviewer:** the system enforces that the assigned reviewer is different from the original decision-maker.
- **Original context:** the queue item shows the original moderation action, its reason, the user's appeal statement, and any new evidence.
- **SLA tracking:** appeals have a configurable SLA (default: 72 hours for standard appeals, 24 hours for ban appeals).
- **Load balancing:** appeals are distributed across available reviewers, respecting reviewer availability and workload.

**Acceptance criteria:**
- Appeal queue is separate from the report queue.
- Appeals are assigned to a reviewer different from the original decision-maker.
- Appeal queue items show original action context, user statement, and new evidence.
- SLA is tracked per appeal with countdown.
- Appeals approaching SLA are highlighted.
- Reviewer assignment respects load balancing.

**Testing:**
- Unit test: appeal assignment excludes the original decision-maker.
- Unit test: SLA countdown is computed correctly from appeal creation time.
- Integration test: appeal queue renders separately from report queue.
- Integration test: appeal with original action context is displayed correctly.
- Load balance test: appeals are distributed evenly across available reviewers.
- Edge case test: when the only available reviewer is the original decision-maker, the appeal escalates to a senior reviewer rather than violating independence.

**Dependencies:** WS-J.1.3b (appeal records), WS-A.2.2 (`ROLE_APPEALS` and independence requirement), WS-J.2.1d (assignment/load-balancing primitives shared with the report queue). Edge cases: a reviewer who becomes unavailable mid-review has their appeals reassigned with continuity of context; ban appeals (24h SLA) are visually distinguished from standard appeals (72h SLA).

**Observability:** emit appeal-queue depth, time-to-decision histogram, SLA-breach counter, and per-reviewer open-appeal count. Alert when any appeal approaches its SLA.

**Security/privacy:** the independence constraint is enforced in assignment logic, not merely by convention. Reviewers see only the appellant's case context, never unrelated users' data.

---

### WS-J.1.3d Appeal outcome notification
**ID:** WS-J.1.3d
**Ref:** Section 16.4

Notify the user of the appeal outcome with a clear explanation. Appeal outcomes:

- **Overturn:** the original action is reversed. The user is notified that the action has been removed, with an explanation of why.
- **Uphold:** the original action stands. The user is notified with an explanation of why the appeal was not successful.
- **Modify:** the original action is changed to a less severe action (e.g., remove changed to warn). The user is notified of the modification and the reasoning.

All outcomes include:
- The appeal_id and original action reference.
- A human-readable explanation of the decision.
- The reviewer's reason code (from the moderation taxonomy).
- The timestamp of the decision.

All appeal decisions are recorded in the audit log with the reviewer identity, original action, outcome, and reasoning.

**Acceptance criteria:**
- Users receive a notification for all three outcome types (overturn, uphold, modify).
- Notifications include explanation, reason code, and timestamps.
- Overturned actions are reversed in the system (hidden content is unhidden, etc.).
- Modified actions apply the new, less severe action.
- All outcomes are recorded in the audit log.
- Notifications are accessible (screen-reader-compatible).

**Testing:**
- Unit test: overturn outcome reverses the original action.
- Unit test: uphold outcome leaves the original action in place.
- Unit test: modify outcome applies the new action and removes the old one.
- Integration test: user receives a push notification or in-app notification for the outcome.
- Audit test: appeal outcome is logged with all required fields.
- E2E test: user can view the outcome explanation from their notification center.
- Reversal-integrity test: overturning a removal restores content without resurrecting separately-removed child content or violating a still-active block.

**Dependencies:** WS-J.1.3c (review/decision), WS-J.2.5 (audit log), WS-C.2 (push/in-app notifications), WS-A.1.2 (reason codes for the explanation). Edge cases: overturning an action whose target was since deleted by the user (notify, but nothing to restore); modify that crosses appealability boundaries (the new action's own appealability follows WS-J.1.3a, but the same case is not re-appealable beyond the permitted count).

**Observability:** emit `appeals.decided` tagged by outcome; this is the source for appeal-overturn rate (TM-AOR, WS-A.1.3a). Track notification delivery success.

**Security/privacy:** the outcome explanation references only the appellant's case; reviewer identity is recorded in the audit log (internal) but not necessarily exposed to the user beyond role attribution, per WS-A.2.2 accountability rules.

---

## WS-J.2 Moderation console

The moderation console is the steward and safety-moderator workspace. Every view and action is authorized by steward role (WS-A.2.2) and audited (WS-J.2.5). The console comprises: the report queue (WS-J.2.1), the content review interface (WS-J.2.2), the action palette (WS-J.2.3), the appeal review interface (WS-J.2.4), the audit log viewer (WS-J.2.5), and the automated pre-checks that feed the queue (WS-J.2.6). The console and its pre-checks operate over **server-hosted** content (Public and Members-only server rooms); `private_p2p` content (WS-S) is never enqueued because the server holds nothing to enqueue, and the automated pre-checks (WS-J.2.6) cannot run on it (the server never sees its plaintext) — the only private-room items reachable from the console are **directory-stub reports**, whose only outcomes are stub delisting or account action.

### WS-J.2.1a Queue layout
**ID:** WS-J.2.1a
**Ref:** Section 18.2

Build the report queue layout for the moderation console. The queue presents reports as a priority-sorted list with the following columns/indicators:

- **Priority indicator:** visual severity indicator (critical/high/medium/low) using color + icon (never color alone per WCAG).
- **Status:** new, in-progress, resolved, escalated.
- **SLA countdown:** time remaining before the SLA is breached, displayed as a countdown timer. Reports approaching SLA breach are visually highlighted.
- **Report summary:** target type, reason code label, reporter count (if multiple reports on same target), and a truncated preview of the content.
- **Assignment:** assigned reviewer (if any) or "unassigned."
- **Created at:** timestamp of the first report.

The queue auto-refreshes to show new reports. Clicking a queue item opens the content review interface (WS-J.2.2a).

**Acceptance criteria:**
- Reports are sorted by priority (severity + SLA urgency).
- All columns are displayed: priority, status, SLA, summary, assignment, timestamp.
- SLA countdown updates in real time.
- Reports approaching SLA breach are highlighted.
- Queue auto-refreshes with new reports.
- Queue is keyboard-navigable and screen-reader-accessible.
- Priority indicators use icon + color, not color alone.

**Testing:**
- Unit test: reports are sorted correctly by priority.
- Unit test: SLA countdown computes correctly.
- E2E test: queue renders with all columns and real-time SLA updates.
- Accessibility test: queue is navigable by keyboard with screen reader.
- Integration test: a new report appears in the queue within the refresh interval.
- Edge case test: a report whose SLA has already breached sorts to the top and is visually distinct from "approaching."

**Dependencies:** WS-J.1.1a/b (reports, severity, routing), WS-A.1.2a (reason-code labels, SLA targets), WS-A.2.2 (queue-access authorization), WS-B (table/list primitives, focus management). The emergency queue (WS-J.1.1b) is rendered as a distinct, always-on-top section. Edge cases: a target with many aggregated reports shows a single row with a reporter count, not N rows.

**Observability:** emit queue-depth gauges per severity and per queue (emergency/standard), oldest-item age, and SLA-breach counter. Dashboard feeds harassment-protection latency (TM-HPL).

**Security/privacy:** the queue shows reason-code labels and content previews but not reporter identities to roles not authorized to see them; financial data never appears (ranking-neutrality / WS-J.2.2b rule).

---

### WS-J.2.1b Filter and search
**ID:** WS-J.2.1b
**Ref:** Section 18.2

Implement filter and search capabilities for the report queue. Filters:

- **Severity:** critical, high, medium, low (multi-select).
- **Category:** reason code categories from the moderation taxonomy (multi-select).
- **Status:** new, in-progress, resolved, escalated (multi-select).
- **Date range:** reports created within a start/end date range.
- **Reporter:** search by reporter user ID or username.
- **Target user:** search by target user ID or username.
- **Assignment:** unassigned, assigned to me, assigned to a specific reviewer.

Filters are combinable (AND logic). Filter state persists across page navigation within the session. A "clear all filters" action resets to the default view. The filtered count is displayed.

**Acceptance criteria:**
- All seven filter dimensions are available.
- Filters are combinable with AND logic.
- Filter state persists across page navigation.
- Filtered result count is displayed.
- "Clear all" resets to the default queue view.
- Search by reporter/target returns results by ID or username.
- Filters update the queue in real time without full page reload.

**Testing:**
- Unit test: each filter dimension correctly filters the queue.
- Unit test: combined filters produce the correct intersection.
- E2E test: apply filters, navigate away, return, verify filters persist.
- E2E test: "clear all" resets the queue.
- Performance test: filtering a queue of 10k reports completes within 1 second.
- Authorization test: the "reporter" search is available only to roles permitted to see reporter identity; for other roles the dimension is hidden/disabled.

**Dependencies:** WS-J.2.1a (queue), WS-A.1.2a (categories), WS-A.2.2 (which filter dimensions a role may use). Edge cases: filtering by reporter is privacy-sensitive and role-gated; a date range with no results shows an explicit empty state, not a stale list.

**Observability:** emit filter-usage counts (which dimensions stewards rely on) and slow-filter warnings above the 1s budget.

**Security/privacy:** reporter-search visibility is role-gated (WS-A.2.2); queries do not log reporter identities into general analytics.

---

### WS-J.2.1c Bulk actions
**ID:** WS-J.2.1c
**Ref:** Section 18.2

Implement bulk actions for the report queue to handle obvious spam and mass reports efficiently. Bulk actions:

- **Select multiple:** checkbox selection on queue items, with "select all on this page" and "select all matching filter" options.
- **Bulk dismiss:** dismiss selected reports as not actionable (e.g., false reports). Requires a reason code.
- **Bulk remove:** remove the content targeted by selected reports (for obvious spam/malware). Requires a reason code.
- **Bulk assign:** assign selected reports to a specific reviewer.

Bulk actions require confirmation before execution ("Are you sure you want to dismiss 15 reports?"). Bulk actions are logged individually in the audit log (each report gets its own audit entry). Bulk actions are reversible: dismissed reports can be reopened, removed content can be restored.

**Acceptance criteria:**
- Multi-select works with individual checkboxes and "select all" options.
- Bulk dismiss, remove, and assign actions are available.
- Bulk actions require a reason code and confirmation.
- Each individual report in a bulk action gets its own audit log entry.
- Bulk actions are reversible (dismiss can be reopened, remove can be restored).
- Maximum bulk action size is configurable (default: 100 items per action).

**Testing:**
- Unit test: selecting multiple reports enables bulk action buttons.
- Unit test: bulk dismiss creates individual audit entries for each report.
- E2E test: select 5 reports, bulk dismiss with reason, verify all are dismissed.
- E2E test: reopen a bulk-dismissed report.
- Integration test: bulk action audit entries are queryable.
- Edge case test: bulk action on 100+ items respects the maximum.
- Authorization test: bulk remove is available only to roles permitted to remove content (`ROLE_SAFETY`); other roles can bulk-assign/dismiss only within their capability.

**Dependencies:** WS-J.2.1a (queue/selection), WS-J.2.3 (action semantics, reason codes, undo), WS-J.2.5 (per-item audit), WS-A.2.2 (which bulk actions a role may invoke). Edge cases: a "select all matching filter" that spans more than the maximum is chunked and each chunk confirmed; bulk remove never applies to non-spam policy-risk content (that requires individual human review per the human-review invariant).

**Observability:** emit bulk-action volume and per-action reason-code distribution; flag unusually large bulk removes for secondary review.

**Security/privacy:** bulk remove is constrained to obvious spam/malware contexts; the confirmation surfaces the count and reason to prevent accidental mass removal. Every item is individually audited and individually reversible.

---

### WS-J.2.1d Case assignment
**ID:** WS-J.2.1d
**Ref:** Section 18.2

Implement case assignment for reports in the moderation queue. Assignment features:

- **Manual assignment:** a reviewer or lead can assign a report to a specific reviewer by selecting from a list of available reviewers.
- **Self-assignment:** a reviewer can claim an unassigned report.
- **Load balancing:** when auto-assignment is enabled, new reports are distributed across available reviewers based on current workload (number of open cases) and expertise (reason code category).
- **Reassignment:** a reviewer can reassign a case to another reviewer with a reason.
- **Availability:** reviewers can set their status (available, busy, offline). Offline reviewers do not receive auto-assigned cases.

**Acceptance criteria:**
- Reports can be manually assigned to a specific reviewer.
- Reviewers can self-assign unassigned reports.
- Auto-assignment distributes based on workload and expertise when enabled.
- Reassignment is supported with a reason.
- Reviewer availability status is respected by auto-assignment.
- Assignment changes are logged in the audit log.

**Testing:**
- Unit test: manual assignment updates the report's assigned reviewer.
- Unit test: auto-assignment distributes to the least-loaded available reviewer.
- Unit test: offline reviewers are excluded from auto-assignment.
- Integration test: reassignment logs the change with reason.
- E2E test: reviewer sets status to offline, verifies no new auto-assignments.
- Edge case test: an emergency case is assignable even when all reviewers are "busy" (emergency overrides soft availability) and pages on-call.

**Dependencies:** WS-J.2.1a (queue), WS-A.2.2 (roles eligible for assignment; expertise maps to category capability), WS-J.2.5 (assignment audit). Shared assignment/load-balancing primitives are reused by the appeal queue (WS-J.1.3c) with the independence constraint added there. Edge cases: a case assigned to a now-offline reviewer is surfaced for reassignment; self-assignment is blocked for categories outside a reviewer's capability.

**Observability:** emit per-reviewer open-case counts, assignment latency, and reassignment rate (high reassignment may signal mis-routing).

**Security/privacy:** assignment respects least privilege (a reviewer is only assignable to categories their role permits). Assignment changes are audited with actor and reason.

---

### WS-J.2.2a Full-context panel
**ID:** WS-J.2.2a
**Ref:** Section 18.3

Build the full-context review panel for the content review interface. When a reviewer opens a report, the panel shows:

- **Thread view:** the complete thread centered on the reported content, with the reported item highlighted. Sufficient surrounding context is shown (parent comment, sibling comments, child comments) to understand the conversation flow.
- **Content highlight:** the reported content is visually highlighted within the thread (background color + border + icon, not color alone).
- **Report details:** the reason code, reporter's optional context, evidence URLs, and submission timestamp.
- **Multiple reports:** if multiple reports target the same content, all are shown with their individual reasons and contexts.

The panel supports expanding the thread context (show more parent/child comments) and collapsing to focus on the reported item.

**Acceptance criteria:**
- Thread view is centered on the reported content with surrounding context.
- Reported content is visually highlighted with non-color indicators.
- Report details (reason, context, evidence, timestamp) are displayed.
- Multiple reports on the same content are aggregated and shown.
- Thread context is expandable and collapsible.
- Panel is keyboard-navigable.

**Testing:**
- Unit test: panel renders with reported content highlighted.
- Unit test: multiple reports on the same content are aggregated.
- E2E test: expand thread context, verify additional comments load.
- Accessibility test: panel is navigable by keyboard and screen reader.
- Integration test: report details match the original submission.
- Edge case test: reported content that was deleted shows the preserved snapshot/tombstone used at report time, so review is still possible.

**Dependencies:** WS-J.1.1a (report details), WS-G (thread structure; the panel reads thread context once forum content exists), WS-A.2.2 (review-access authorization), WS-B (panel/focus primitives). Edge cases: evidence URLs are rendered as non-auto-loading links routed through the malware-check path (WS-J.2.6b) before navigation; deeply nested threads paginate context rather than loading unbounded children.

**Observability:** emit review-open events and context-expansion usage; track time-in-review per case (feeds reviewer-throughput dashboards).

**Security/privacy:** reporter identity is shown only to authorized roles; evidence links are not fetched on render (SSRF avoidance) and are malware-checked before the reviewer navigates.

---

### WS-J.2.2b User history sidebar
**ID:** WS-J.2.2b
**Ref:** Section 18.3

Build the user history sidebar for the content review interface. When reviewing a report, the sidebar shows the reported user's moderation-relevant history:

- **Past reports:** number of reports filed against this user, by category, with outcomes.
- **Past moderation actions:** list of previous moderation actions taken against this user (warn, hide, remove, restrict, ban) with dates and reason codes.
- **Account age:** when the account was created.
- **Contribution patterns:** summary statistics -- number of contributions, contribution types, rooms active in, average contribution quality (from internal signals, not public scores).

The sidebar is collapsible. Information is access-controlled -- only reviewers with the appropriate role can see user history. The sidebar does not show financial data (wallet, payment, treasury) per the ranking neutrality principle.

**Acceptance criteria:**
- Sidebar shows past reports, moderation actions, account age, and contribution patterns.
- Past reports are grouped by category with outcomes.
- Past moderation actions include dates and reason codes.
- Sidebar is collapsible.
- Sidebar does not display any financial data (wallet, payment, treasury, donor).
- Access is restricted to authorized reviewer roles.

**Testing:**
- Unit test: sidebar renders with correct user history data.
- Unit test: sidebar excludes financial data fields.
- Integration test: user with prior moderation actions shows complete history.
- Security test: unauthorized role cannot access user history.
- E2E test: collapse and expand sidebar.
- Privacy test: the sidebar never surfaces reporter identities of past reports against this user, only counts/categories/outcomes.

**Dependencies:** WS-D.1 (account metadata), WS-J.2.5 (past actions sourced from the audit log), WS-A.2.2 (role-gated access), WS-E/WS-K (contribution-quality internal signals). Edge cases: a brand-new account with no history shows an explicit "no prior history" state (account age itself is a signal); contribution-quality is an internal, bounded, private signal — never a public score (SPEC 5.16).

**Observability:** emit history-access events by role (audit of who viewed whose history) and access-denied counts.

**Security/privacy:** this sidebar is the primary place the ranking-neutrality "no financial data in moderation" rule is enforced in UI: wallet/payment/treasury/donor fields are absent at the schema level, not merely hidden. Access is role-gated and itself audited to deter fishing.

---

### WS-J.2.2c Invariant signals panel
**ID:** WS-J.2.2c
**Ref:** Sections 8.3, 10.4

Build the invariant signals panel for the content review interface. This panel provides reviewers with machine-intelligence context to inform (not replace) their moderation decision:

- **MFCI coordination score:** the current MFCI risk state for the user and the reported content. If elevated, shows the coordination pattern summary (e.g., "synchronized reporting from 15 accounts within 3 minutes").
- **SCOI context state:** the current SCOI level for the content (coherent, ambiguous, split, obstructed, weaponized). If elevated, shows which lenses/communities interpret the content differently.
- **PHI loop indicators:** whether the reported user or content is associated with high-holonomy recommendation loops.
- **Hodge tension:** the harmonic tension level of the thread containing the reported content.

Signals are presented as informational context with plain-language labels, not as automated verdicts. The panel includes a disclaimer: "These signals inform review but do not determine outcomes."

**Acceptance criteria:**
- Panel displays MFCI, SCOI, PHI, and Hodge tension for the reported content/user.
- Each signal shows a plain-language label and current state.
- MFCI elevated state includes a coordination pattern summary.
- SCOI elevated state includes lens/community interpretation differences.
- Panel includes a disclaimer that signals do not determine outcomes.
- Panel is read-only (reviewers cannot modify invariant signals from here).

**Testing:**
- Unit test: panel renders with correct signal data from fixtures.
- Unit test: elevated MFCI shows coordination pattern summary.
- Unit test: elevated SCOI shows interpretation differences.
- Integration test: signals match the current state from invariant services.
- Accessibility test: panel is screen-reader-accessible with labeled sections.
- Fallback test: when an invariant service is unavailable (cold start / outage), the panel shows an explicit "signal unavailable" state with reason rather than a misleading zero.

**Dependencies:** WS-H.3 (MFCI), WS-H.4 (SCOI), WS-H.6 (PHI), WS-H (Hodge tension); these ship in Wave 5, so before then the panel renders "not yet available" placeholders and the console remains fully usable without them. WS-A.2.2 gates which roles see MFCI coordination detail (integrity-sensitive). Edge cases: an integrity analyst sees fuller coordination detail than a community steward (role-scoped depth).

**Observability:** emit panel-render events and signal-availability gauges (how often invariants are present vs unavailable at review time).

**Security/privacy:** the panel is read-only and decision-support only — it must not drive auto-removal (human-review invariant). Coordination detail is integrity-sensitive and role-gated; it never exposes reporter identities, only aggregate coordination descriptions conditioned on base rates (MFCI-1).

---

### WS-J.2.2d Side-by-side view
**ID:** WS-J.2.2d
**Ref:** Section 18.3

Build a side-by-side view for reviewing content edits. When reported content has been edited since the original report, the reviewer sees:

- **Left panel:** the original content at the time of the report (from edit history).
- **Right panel:** the current content after edits.
- **Diff highlighting:** material changes between versions are highlighted (additions in one color, deletions in another, with text-decoration as a non-color indicator).
- **Edit metadata:** timestamp of each edit, whether the edit was made before or after the report.

For content that has not been edited, the side-by-side view is not shown (only the full-context panel is displayed).

**Acceptance criteria:**
- Side-by-side view shows original and current content for edited items.
- Material changes are highlighted with diff indicators (color + text-decoration).
- Edit timestamps are shown.
- Pre-report and post-report edits are distinguished.
- The view is hidden for unedited content.
- Both panels are scrollable independently.

**Testing:**
- Unit test: side-by-side renders for edited content.
- Unit test: diff highlighting correctly identifies additions and deletions.
- Unit test: side-by-side is hidden for unedited content.
- E2E test: review a report on edited content, verify original and current versions are displayed.
- Accessibility test: diff indicators are perceivable without color vision.
- Edge case test: content edited to remove a violation after reporting still shows the offending original (prevents edit-to-evade); content edited multiple times shows the report-time version against current.

**Dependencies:** WS-G (edit history / material-change tracking; SPEC 15.5), WS-J.2.2a (hosts the view), WS-B (diff primitives). Edge cases: an edit that deletes the content entirely shows the tombstone on the right and the report-time snapshot on the left.

**Observability:** emit side-by-side-shown rate (how often reported content was edited post-report), a signal of edit-to-evade behavior.

**Security/privacy:** edit history shown to reviewers is scoped to the reported item; it does not expose unrelated private drafts (drafts are local/encrypted per SPEC 19.2).

---

### WS-J.2.3a Action palette
**ID:** WS-J.2.3a
**Ref:** Sections 16.4, 18.2, 18.3

Build the moderation action palette in the content review interface. The palette is the single place a steward takes an enforcement action, and it enforces the doctrine in the UI: an action cannot be committed without a reason code, a significant action generates a user notice, and reversible actions are undoable. This task fills the canonical WS-J.2.3 (moderation action palette) scope referenced by the index and risk matrix; it is split into the palette+reason-code+notice mechanics (WS-J.2.3a) and the undo/revert mechanics (WS-J.2.3b) because they are independently testable and the undo path has distinct reversal-integrity concerns.

**Actions:** warn, hide, remove, restrict, escalate, clear (dismiss as not-actionable). Each action:
- Requires selecting a reason code from the moderation taxonomy (WS-A.1.2), filtered to codes valid for the action and the content's category.
- Is gated by the steward's role capabilities (WS-A.2.2): only `ROLE_SAFETY` may remove/restrict; community/evidence stewards may warn/escalate/clear within scope; escalate routes to the next layer (WS-A.1.2b).
- Generates a readable user notice (statement of reasons) for significant actions, including the reason code and, where appealable (WS-A.1.2c), the appeal path. "Clear" produces no user-facing notice (no action was taken against the user) but is audited.
- Emits an audit record (WS-J.2.5 fields) including actor, role, reason code, target, prior/next distribution state, and reversibility flag.

**Request/response shape:**

    POST /v1/moderation/actions
    Request {
      target_type: "content" | "account",
      target_id: string,
      action: "warn" | "hide" | "remove" | "restrict" | "escalate" | "clear",
      reason_code: string,            // valid for action + category (WS-A.1.2)
      duration?: string,              // for restrict/ban-like actions
      reviewer_note?: string,         // internal, not shown to user
      report_ids?: string[]           // reports this action resolves
    }
    201 Response {
      action_id: string,
      action: string,
      reversible: boolean,
      notice_sent: boolean,
      appealable: boolean,
      created_at: string
    }
    Errors:
      400 { error: { code: "invalid_reason_for_action" | "validation_error" } }
      403 { error: { code: "insufficient_capability", required_role: string } }

**Acceptance criteria:**
- All six actions (warn, hide, remove, restrict, escalate, clear) are available, gated by role capability.
- A reason code is required for every action and validated against the taxonomy and the content category.
- Significant actions generate a readable user notice with reason code and appeal path where appealable.
- Escalate routes the case to the next moderation layer per WS-A.1.2b.
- Every action emits a complete audit record.
- Actions resolve their associated report(s), moving them to "resolved" status.

**Testing:**
- Unit test: committing an action without a reason code is rejected.
- Unit test: a role lacking capability receives 403 with the required role.
- Unit test: a significant action sets `notice_sent=true` and `appealable` per WS-A.1.2c.
- Integration test: remove hides content from all surfaces and resolves the linked reports.
- Integration test: escalate creates a case at the next layer.
- Audit test: each action emits the full audit field set (WS-J.2.5).
- Doctrine test: a policy-risk classification cannot be auto-removed from here; removal is an explicit human action with a reason code.

**Dependencies:** WS-A.1.2 (reason codes, appeal eligibility), WS-A.2.2 (capability gating), WS-J.2.2 (review context), WS-J.2.5 (audit), WS-J.1.3d/notification (notice delivery). Edge cases: acting on content already removed (idempotent no-op with audit note); restricting an account already restricted (extends/updates, audited); clearing a report that other reviewers also hold open (concurrency-safe resolution).

**Observability:** emit `moderation.action` tagged by action and reason_code; this is a primary source for moderation-volume transparency (WS-A.1.3a) and harassment-protection latency.

**Security/privacy:** capability gating is server-side authorization, not UI-only. `reviewer_note` is internal and never shown to the user. No financial data is read or written by the action path (ranking-neutrality). Significant actions are never silent (notice required), satisfying notice-and-appeal.

---

### WS-J.2.3b Action undo and revert
**ID:** WS-J.2.3b
**Ref:** Sections 16.4, 18.3, 30.8

Implement undo/revert for reversible moderation actions, satisfying the reversibility requirement (SPEC 16.4 steward actions reversible where possible; Section 30.8 reversible tasks). Reversible actions (warn, hide, remove, restrict, clear) can be reverted by an authorized steward; the revert restores the prior state, notifies the affected user where a notice was originally sent, and is itself audited as a distinct action linked to the original.

**Acceptance criteria:**
- Reversible actions expose an undo/revert affordance to authorized roles.
- Reverting restores the prior content/account state (unhide, unremove, lift restriction, reopen cleared report).
- A revert emits its own audit record linked to the original action (actor, reason, timestamp).
- The affected user is notified of a revert when the original action carried a user notice.
- Irreversible actions (e.g., legally mandated CSAM removal) are marked non-revertible and the affordance is absent.
- Reverts respect reversal integrity (do not resurrect separately-removed children, do not override an active block).

**Testing:**
- Unit test: reverting a hide unhides the content and logs a linked revert action.
- Unit test: reverting a restriction lifts it and notifies the user.
- Unit test: an irreversible action exposes no revert affordance.
- Integration test: revert audit record references the original action_id.
- Reversal-integrity test: reverting a removal does not restore content that was independently removed for a different reason.
- Authorization test: a role without revert capability cannot revert.

**Dependencies:** WS-J.2.3a (actions to revert), WS-J.2.5 (linked audit), WS-A.2.2 (revert capability), WS-J.1.3d (notification reuse). Edge cases: reverting an action that an appeal already overturned (idempotent; the system reflects a single restored state); reverting after the target was deleted by the user (notify, nothing to restore).

**Observability:** emit `moderation.revert` tagged by original action type and reason; a high revert rate for a reviewer or reason code signals quality issues (feeds reviewer quality review).

**Security/privacy:** revert is an audited, role-gated action; it cannot be used to silently undo a notice (the user is re-notified). Reversal integrity prevents accidental exposure of content removed for an unrelated violation.

---

### WS-J.2.4a Appeal review interface
**ID:** WS-J.2.4a
**Ref:** Section 16.4

Build the appeal review interface for `ROLE_APPEALS` reviewers, distinct from the report review interface. It presents the appeals queue (WS-J.1.3c) and, for each appeal, the full decision context needed to overturn, uphold, or modify. This task fills the canonical WS-J.2.4 (appeal review interface) scope.

The interface shows, per appeal:
- The original moderation action: action type, reason code, original reviewer (for independence display), timestamp, and the content/account it targeted (report-time snapshot via WS-J.2.2d where edited).
- The appellant's statement and any new evidence (non-auto-loading, malware-checked links).
- The user's relevant history (WS-J.2.2b), role-scoped.
- A decision control: overturn | uphold | modify, each requiring a reason code (WS-A.1.2) and a human-readable explanation that becomes the user notice (WS-J.1.3d).

The interface enforces independence (the assigned reviewer is never the original decision-maker; WS-J.1.3c) and records the decision in the audit log (WS-J.2.5).

**Acceptance criteria:**
- Appeals render with full original-decision context, appellant statement, and new evidence.
- The decision control offers overturn/uphold/modify, each requiring a reason code and explanation.
- Independence is visible and enforced (original reviewer shown; same-reviewer assignment impossible).
- A decision triggers the outcome path (WS-J.1.3d): state change, user notification, audit record.
- Modify lets the reviewer select the new, less-severe action and its reason code.
- The interface is keyboard-navigable and screen-reader-accessible.

**Testing:**
- Unit test: rendering an appeal shows the original action, reason code, and appellant statement.
- Unit test: submitting a decision without a reason code/explanation is rejected.
- Integration test: overturn triggers reversal and user notification (via WS-J.1.3d).
- Integration test: modify applies the new action and removes the old one.
- Security test: the original decision-maker cannot be assigned or act on the appeal.
- Accessibility test: the decision control and context panels are fully keyboard/screen-reader operable.

**Dependencies:** WS-J.1.3b/c/d (appeal records, queue, outcome path), WS-J.2.2b/d (history, side-by-side), WS-A.1.2 (reason codes), WS-A.2.2 (`ROLE_APPEALS`, independence, senior escalation). Edge cases: an appeal whose original action was already reverted (WS-J.2.3b) shows the current state and prevents contradictory outcomes; an appeal referencing deleted target content reviews the snapshot.

**Observability:** emit appeal-decision events by outcome (source for TM-AOR), time-to-decision, and per-reviewer decision distribution (quality monitoring).

**Security/privacy:** independence is enforced server-side. Reviewers see only the appellant's case context; reporter identities of the original report are not exposed in the appeal view. Decisions are fully audited with reviewer identity and reasoning.

---

### WS-J.2.5a Audit log writer and schema
**ID:** WS-J.2.5a
**Ref:** Sections 16.4, 25.4

Define and implement the moderation audit log: an append-only, tamper-evident record of every steward action, automated block, assignment, appeal decision, and revert. This task fills the canonical WS-J.2.5 (audit log viewer) scope, split into the writer/schema (WS-J.2.5a) and the viewer (WS-J.2.5b) because the durable record must exist and be correct before any UI reads it, and the two are independently testable.

**Audit record fields (every moderation event emits):**
- `audit_id`, `event_time` (RFC 3339)
- `actor_id`, `actor_role` (WS-A.2.2) — or `system` for automated blocks
- `action` (warn/hide/remove/restrict/escalate/clear/revert/assign/appeal_decision/auto_block)
- `reason_code` (WS-A.1.2) where applicable
- `target_type`, `target_id`
- `prior_state`, `next_state` (e.g., distribution/visibility/account status)
- `reversible` flag and `linked_action_id` (for reverts/appeal outcomes)
- `report_ids` resolved (where applicable)
- `co_approver_id` for irreversible/high-impact actions (WS-A.2.2)
- `notes` (internal)

The log is append-only (no updates/deletes), access-controlled, and retained per the counsel-approved retention schedule (SPEC 17.10). It is the source of truth for the user-history sidebar (WS-J.2.2b), transparency-report aggregates (WS-A.1.3a / WS-P.2), and incident review.

**Acceptance criteria:**
- Every steward action, automated block, assignment, appeal decision, and revert writes a complete audit record.
- The log is append-only; records cannot be updated or deleted through the application.
- Records include all required fields, with `system` as actor for automated events.
- Reverts and appeal outcomes set `linked_action_id` to the original action.
- The log is access-controlled (only authorized roles may read) and write access is restricted to the moderation services.
- Retention follows the configured schedule.

**Testing:**
- Unit test: each action type writes a record with the full field set.
- Unit test: automated block records use `actor_id=system`.
- Unit test: a revert record links to the original action_id.
- Integration test: attempting to update/delete a record via the application is rejected.
- Security test: an unauthorized role cannot write or read the log.
- Completeness test: for a sequence of mixed actions, every action has exactly one corresponding audit record.

**Dependencies:** WS-A.2.2 (actor roles, co-approver rules), WS-A.1.2 (reason codes), all action producers (WS-J.2.1c, WS-J.2.3a/b, WS-J.2.4a, WS-J.2.6). Edge cases: a bulk action writes one record per item (WS-J.2.1c); a partially-failed action writes the attempt and outcome so the trail is gap-free.

**Observability:** emit audit-write success/failure counters; an audit-write failure is a high-severity alert because it threatens accountability. Monitor for any record-mutation attempts.

**Security/privacy:** append-only + access control makes the log tamper-evident (SPEC 25.4 audit logging). Reporter identities are not duplicated into broadly-readable audit fields; where reporter linkage is recorded it is access-gated to the minimum roles. No financial data is recorded in moderation audit records. On-chain placement is prohibited (SPEC 19.5).

---

### WS-J.2.5b Audit log viewer
**ID:** WS-J.2.5b
**Ref:** Sections 16.4, 25.4

Build the searchable audit log viewer over the records from WS-J.2.5a. The viewer supports filtering and export for transparency reporting, and is access-controlled.

Filters: moderator (actor), target user, action type, reason code, date range. Export: produce a transparency-report-ready aggregate/extract (respecting small-cell suppression and never exposing reporter identities; WS-A.1.3a). Access: read access is role-gated; every export is itself audited.

**Acceptance criteria:**
- The viewer lists audit records with all filters (moderator, target user, action type, reason code, date).
- Results are paginated and performant on large logs.
- Export produces a transparency-ready extract with small-cell suppression applied and reporter identities excluded.
- Read access is restricted to authorized roles; export actions are audited.
- The viewer is keyboard-navigable and screen-reader-accessible.

**Testing:**
- Unit test: each filter dimension returns correct records.
- Unit test: export applies small-cell suppression and omits reporter identities.
- Integration test: an export action writes its own audit record (who exported what, when).
- Performance test: filtering/searching a large log returns within the budget.
- Security test: an unauthorized role cannot open the viewer or export.
- Accessibility test: the viewer table and filters are fully operable by keyboard and screen reader.

**Dependencies:** WS-J.2.5a (records), WS-A.2.2 (read/export authorization), WS-A.1.3a (suppression thresholds and what may be published). Edge cases: an export request spanning a period below the privacy threshold returns suppressed cells, not raw counts; cross-referencing by target user does not reveal reporter identities.

**Observability:** emit viewer-access and export events (audited), and slow-query warnings. Export volume by role is dashboarded.

**Security/privacy:** the viewer is the controlled lens onto sensitive moderation history; access is least-privilege and every export is audited to deter misuse. Exports feed public transparency only after suppression and identity exclusion (WS-A.1.3a).

---

### WS-J.2.6a Spam detection
**ID:** WS-J.2.6a
**Ref:** Section 18.2

Implement automated spam detection as a pre-check layer. Spam detection runs on all new content before it enters the moderation queue, using:

- **Pattern matching:** known spam phrases, URL patterns, and content templates. The pattern list is version-controlled and updatable without code deployment.
- **Velocity checks:** rapid submission of similar content from the same account within a short window (configurable threshold, default: 5 similar items in 10 minutes).
- **Known spam signatures:** hash-based matching against a database of previously identified spam content.
- **Account age/trust tier:** new accounts with no contribution history submitting link-heavy content receive higher spam scores.

Spam detection produces a confidence score. High-confidence spam (above threshold) is blocked from publishing and logged. Medium-confidence spam is published but flagged for human review with elevated queue priority. Low-confidence content proceeds normally.

Spam detection never auto-removes content that is not high-confidence spam. False positive rate is monitored and reported.

**Acceptance criteria:**
- Spam detection runs on all new content submissions.
- High-confidence spam is blocked from publishing.
- Medium-confidence spam is published but flagged for human review.
- Low-confidence content proceeds without intervention.
- Pattern list is updatable without code deployment.
- Velocity checks detect rapid similar submissions.
- False positive rate is monitored with a dashboard.
- Blocked content is logged with the spam signal that triggered it.

**Testing:**
- Unit test: known spam pattern triggers high-confidence detection.
- Unit test: rapid similar submissions trigger velocity check.
- Unit test: legitimate content from established accounts passes with low confidence.
- Integration test: high-confidence spam is blocked from publishing.
- Integration test: medium-confidence spam appears in the queue with elevated priority.
- False positive test: run detection against a corpus of known-good content and verify low false positive rate.

**Dependencies:** WS-G.3 (content submission hook), WS-D.1 (account-age/trust tier; SPEC 25.5), WS-J.2.5a (auto-block audit with `actor=system`), WS-A.1.1c (spam/low-info anti-signals). Edge cases: an established account legitimately posting a templated update (e.g., recurring data release) is not blocked at low volume; a high-confidence block is appealable through the standard flow (false-positive recourse).

**Observability:** emit spam-confidence distribution, block rate, and false-positive rate (from appeal overturns of spam blocks). Alert on a sudden block-rate spike (possible bad pattern push).

**Security/privacy:** high-confidence auto-block is one of only two permitted auto-removal paths (the other is malware, WS-J.2.6b); everything else flags for humans. Blocks are audited and reversible.

---

### WS-J.2.6b Malware link detection
**ID:** WS-J.2.6b
**Ref:** Section 18.2

Implement automated malware link detection for all user-submitted URLs. Detection checks:

- **URL reputation:** check submitted URLs against known malware domain databases (e.g., Google Safe Browsing API or equivalent).
- **Known malware domains:** maintain a local blocklist of domains identified as hosting malware, phishing, or wallet-drainer payloads, updated regularly.
- **Redirect chain analysis:** follow URL redirects (up to a configurable maximum, default 5 hops) and check each intermediate URL against the reputation database. Flag URLs with excessive or suspicious redirect chains.

Detected malware links are blocked from publishing and replaced with a warning interstitial. The original URL is logged for analysis. False positives are appealable through the standard appeal flow.

**Acceptance criteria:**
- All user-submitted URLs are checked against malware databases.
- Known malware URLs are blocked from publishing.
- Redirect chains are followed and each hop is checked.
- Blocked URLs show a warning interstitial instead of the link.
- The malware domain blocklist is updatable without code deployment.
- Blocked URLs are logged with the detection signal.
- False positives are appealable.

**Testing:**
- Unit test: known malware URL is blocked.
- Unit test: URL redirecting to a known malware domain is blocked.
- Unit test: legitimate URL passes detection.
- Integration test: blocked URL shows interstitial in the rendered content.
- Update test: adding a new domain to the blocklist takes effect without restart.
- Redirect test: redirect chain exceeding maximum hops is flagged.

**Dependencies:** WS-G.3/WS-F (URL submission and canonicalization), WS-J.2.5a (auto-block audit), WS-A.1.2d (wallet-drainer abuse mode `MOD_CRYPTO_DRAIN` shares this blocklist), WS-O (egress controls for the redirect-following fetcher). Edge cases: redirect-following is done by a sandboxed, egress-restricted fetcher to avoid SSRF; a URL that is reachable only behind auth is treated as unverifiable and flagged for human review rather than blocked or trusted.

**Observability:** emit malware-block rate, redirect-depth distribution, reputation-provider latency/error rate, and false-positive rate from appeals. Alert if the reputation provider is down (fail toward flagging, not trusting).

**Security/privacy:** this is the second permitted auto-block path and a primary control for the "XSS → wallet drain" and "Phishing PWA" Critical risk lines. The fetcher never executes content; it resolves reputation only, with strict egress allowlisting. Wallet-drainer domains feed and are fed by the crypto-abuse blocklist (WS-A.1.2d).

---

### WS-J.2.6c Duplicate flood detection
**ID:** WS-J.2.6c
**Ref:** Section 18.2

Implement automated detection of duplicate content floods -- the same or near-identical content posted rapidly across multiple threads, rooms, or stories. Detection uses:

- **Content similarity:** compute similarity between new submissions and recent submissions from the same account using text hashing (MinHash or similar) and URL canonicalization.
- **Temporal clustering:** flag when an account posts content with similarity above threshold across multiple targets within a short window (configurable, default: 3+ similar posts in 15 minutes across 2+ rooms).
- **Cross-account detection:** when multiple accounts post the same content simultaneously, flag for MFCI coordination analysis.

Duplicate floods are flagged for human review with elevated queue priority. The system does not auto-remove duplicate content (legitimate cross-posting exists), but it flags the pattern for reviewer assessment.

**Acceptance criteria:**
- Same-content rapid posting from one account across multiple targets is detected.
- Near-identical content is detected via similarity hashing.
- Detection thresholds are configurable.
- Detected floods are flagged for human review, not auto-removed.
- Cross-account duplicate floods are flagged for MFCI coordination analysis.
- Legitimate cross-posting (e.g., same user posting in 2 relevant rooms) is not penalized at low volume.

**Testing:**
- Unit test: 3 identical posts across 3 rooms in 5 minutes triggers detection.
- Unit test: near-identical posts (minor variations) trigger detection.
- Unit test: 2 posts across 2 rooms in 30 minutes does not trigger detection.
- Integration test: detected floods appear in the queue with elevated priority.
- Integration test: cross-account duplicate flood triggers MFCI coordination check.

**Dependencies:** WS-F (URL canonicalization, source lineage; SPEC 25.5 duplicate-spam mitigation), WS-H.2 (MERI dedup shares similarity infrastructure), WS-H.3 (MFCI for cross-account), WS-J.2.5a (flag/audit). Before MFCI is live, cross-account detection uses cheap simultaneity statistics and tightens later. Edge cases: a steward or evidence card legitimately referenced across rooms is whitelisted from flood scoring; quoting/citing is distinguished from copy-paste flooding.

**Observability:** emit flood-flag rate, single-account vs cross-account split, and the share later confirmed as genuine flood vs legitimate cross-post (tunes thresholds).

**Security/privacy:** duplicate flood detection flags for humans and never auto-removes (human-review invariant); cross-account scoring conditions on base rates so a popular item legitimately shared widely is not mislabeled coordination (MFCI-1).

---

### WS-J.2.6d Policy-risk content flagging
**ID:** WS-J.2.6d
**Ref:** Section 18.2

Implement automated flagging of content that may violate platform policies, for human review. This layer flags but never auto-removes content (with the exception of high-confidence spam and malware per WS-J.2.6a/b). Flagging categories:

- **Toxicity/harassment:** content matching harassment, hate speech, or threat patterns (language model or rule-based classifier).
- **Graphic/disturbing content:** content matching patterns for graphic violence, self-harm, or disturbing imagery descriptions.
- **Misinformation indicators:** content matching known misinformation patterns or claims flagged by fact-checking databases.
- **Impersonation indicators:** username or profile patterns matching known impersonation tactics.

Each flagged item receives a severity classification that determines queue priority:
- **Critical:** content that may require emergency action (threats, CSAM indicators).
- **High:** content that likely violates policy.
- **Medium:** content that may violate policy, needs context review.
- **Low:** content with minor policy signals, review when capacity allows.

**Acceptance criteria:**
- Content matching policy-risk patterns is flagged for human review.
- Flagged content is never auto-removed (except high-confidence spam/malware).
- Each flag includes a severity classification.
- Severity determines queue priority.
- Flagging runs on all new content submissions.
- Critical flags trigger an alert to on-call reviewers.
- False positive rate is monitored.

**Testing:**
- Unit test: content matching toxicity patterns is flagged with correct severity.
- Unit test: benign content is not flagged.
- Unit test: critical-severity flag triggers an alert.
- Integration test: flagged content appears in the queue with correct priority.
- False positive test: run flagging against a corpus of known-good content.
- Negative test: flagged content remains published (not auto-removed) pending review.

**Dependencies:** WS-K (classifier / AI governance for any model-based flagging; model registry and evaluation), WS-A.1.2a (categories/severity mapping), WS-J.1.1b (critical-flag alerting reuses emergency path), WS-J.2.5a (flag audit). Edge cases: a CSAM *indicator* (not confirmation) routes to expedited human review and external-escalation readiness, never to model auto-removal; classifier disagreement at a boundary defaults to flagging, not suppression.

**Observability:** emit flag rate by category and severity, classifier confidence distribution, and false-positive rate from human dispositions. The human-review-not-auto-removal invariant is dashboarded (auto-removals from this layer must be zero).

**Security/privacy:** this layer is the explicit embodiment of the human-review invariant: it prioritizes and alerts but never removes. Any model used is governed by WS-K (evaluation, bias review) so flagging does not encode discriminatory bias; misclassification has recourse via human review and appeal.

---

### WS-J.2.6e Coordinated-report detection
**ID:** WS-J.2.6e
**Ref:** Sections 8.3, 18.3

Implement MFCI-backed detection of coordinated reporting patterns. When multiple reports arrive against the same target within a short time window, the system computes the MFCI coordination score for the reporting pattern to distinguish genuine community concern from organized report abuse.

Detection checks:
- **Temporal clustering:** N+ reports against the same target within M minutes (configurable thresholds).
- **Account correlation:** reporting accounts share unusual patterns (creation time, activity patterns, room membership overlap) beyond base-rate expectations.
- **Target pattern:** the same set of accounts has previously reported the same targets together.

When coordinated reporting is detected:
- Reporting impact on the target is delayed pending integrity review (MFCI-2).
- The coordination pattern is logged and queued for integrity analyst review.
- The target user is not notified of the coordinated reports until the review is complete.
- A notification is sent to integrity analysts.

This detection drives the coordination-incident workflow (SPEC 29.3): detect → assign severity → slow/freeze enforcement if threshold met (cheap statistics in the sub-minute path; exact MFCI fiber test confirms or clears) → integrity-analyst case with preserved margins and baselines → moderator action or false-positive clear → public label update if distribution is affected → log for transparency.

**Acceptance criteria:**
- Temporal clustering of reports is detected based on configurable thresholds.
- MFCI coordination score is computed for clustered report patterns.
- High-coordination reports delay enforcement impact on the target.
- Coordination patterns are logged for integrity analyst review.
- Target user is protected from coordinated report impact during review.
- Detection thresholds are configurable.

**Testing:**
- Unit test: 10 reports from different accounts in 5 minutes triggers detection.
- Unit test: 10 reports spread over 48 hours does not trigger detection.
- Integration test: coordinated reports delay enforcement impact on the target.
- Integration test: coordination pattern appears in the integrity analyst queue.
- MFCI test: coordination score correctly conditions on base rates (large community discussing controversial topic is not flagged as coordinated reporting).

**Dependencies:** WS-J.1.1d (shared coordination signal and report-delay mechanism), WS-H.3 (MFCI; cheap clustering statistics provide the sub-minute path and a fallback before MFCI ships), WS-A.1.1c (brigading anti-signal `SIG-ANTI-BRIGADE`), WS-J.2.2c (surfaces the coordination summary to reviewers), WS-J.2.5a (case/audit logging). Edge cases: a genuine harm reported by an authentically large community must still be actioned quickly — the delay applies to *enforcement driven solely by report volume*, not to a reviewer's independent finding; a confirmed false-positive clears the delay and restores the target's standing with an audit note.

**Observability:** emit coordinated-report incidents by severity (source for TM-MFCI breakdown), share cleared as false positives, and time-to-integrity-review. Page integrity analysts when a high-coordination cluster forms.

**Security/privacy:** the protective delay shields targets of organized report abuse (Risk Matrix: "False coordination positives — High") while base-rate conditioning (MFCI-1) protects authentic communities from being mislabeled brigaders. Reporter identities are never exposed to the target, and coordination descriptions are aggregate, not per-reporter.

---

## Task dependency summary

| Task | Deliverable | Depends on | Notes |
|---|---|---|---|
| WS-J.1.1a | POST /v1/reports | WS-D.1, WS-A.1.2a, WS-J.1.1b | Idempotent; reporter identity protected |
| WS-J.1.1b | Emergency vs disagreement routing | WS-A.1.2a, WS-J.1.1a, WS-O.2 (alerting) | Emergency set = taxonomy-derived |
| WS-J.1.1c | Two-tap report UX | WS-J.1.1a, WS-A.1.2a, WS-B, WS-C.2 | Offline-queued; ≤3 taps |
| WS-J.1.1d | Report rate limiting | WS-J.1.1a, WS-H.3, WS-J.2.6e | MFCI-2 report delay |
| WS-J.1.1e | Published support contact | WS-D.1, WS-A.2.3/WS-N, WS-B | Unauthenticated access |
| WS-J.1.2a | POST /v1/blocks | WS-D.1, WS-G | Bilateral, API-enforced |
| WS-J.1.2b | POST /v1/mutes | WS-D.1, WS-G, WS-C | One-directional filter |
| WS-J.1.3a | Appeal eligibility rules | WS-A.1.2c, WS-A.2.2 | Mirrors policy matrix |
| WS-J.1.3b | POST /v1/appeals | WS-D.1, WS-J.1.3a, WS-J.1.3c | Ownership-enforced |
| WS-J.1.3c | Appeal review queue | WS-J.1.3b, WS-A.2.2, WS-J.2.1d | Independent reviewer |
| WS-J.1.3d | Appeal outcome notification | WS-J.1.3c, WS-J.2.5, WS-C.2, WS-A.1.2 | Source for TM-AOR |
| WS-J.2.1a | Queue layout | WS-J.1.1a/b, WS-A.1.2a, WS-A.2.2, WS-B | Emergency section on top |
| WS-J.2.1b | Filter and search | WS-J.2.1a, WS-A.1.2a, WS-A.2.2 | Reporter filter role-gated |
| WS-J.2.1c | Bulk actions | WS-J.2.1a, WS-J.2.3, WS-J.2.5, WS-A.2.2 | Per-item audit, reversible |
| WS-J.2.1d | Case assignment | WS-J.2.1a, WS-A.2.2, WS-J.2.5 | Shared with appeal queue |
| WS-J.2.2a | Full-context panel | WS-J.1.1a, WS-G, WS-A.2.2, WS-B | Report-time snapshot |
| WS-J.2.2b | User history sidebar | WS-D.1, WS-J.2.5, WS-A.2.2, WS-E/WS-K | No financial data |
| WS-J.2.2c | Invariant signals panel | WS-H.3/H.4/H.6, WS-A.2.2 | Decision-support only |
| WS-J.2.2d | Side-by-side view | WS-G (edit history), WS-J.2.2a, WS-B | Anti edit-to-evade |
| WS-J.2.3a | Action palette | WS-A.1.2, WS-A.2.2, WS-J.2.2, WS-J.2.5 | Reason code + notice required |
| WS-J.2.3b | Action undo and revert | WS-J.2.3a, WS-J.2.5, WS-A.2.2 | Reversal integrity |
| WS-J.2.4a | Appeal review interface | WS-J.1.3b/c/d, WS-J.2.2b/d, WS-A.2.2 | Independence enforced |
| WS-J.2.5a | Audit log writer + schema | WS-A.2.2, WS-A.1.2, all action producers | Append-only, tamper-evident |
| WS-J.2.5b | Audit log viewer | WS-J.2.5a, WS-A.2.2, WS-A.1.3a | Suppressed, identity-free export |
| WS-J.2.6a | Spam detection | WS-G.3, WS-D.1, WS-J.2.5a, WS-A.1.1c | Auto-block (high confidence) |
| WS-J.2.6b | Malware link detection | WS-G.3/WS-F, WS-J.2.5a, WS-A.1.2d, WS-O | Auto-block; SSRF-safe fetcher |
| WS-J.2.6c | Duplicate flood detection | WS-F, WS-H.2, WS-H.3, WS-J.2.5a | Flag, not remove |
| WS-J.2.6d | Policy-risk flagging | WS-K, WS-A.1.2a, WS-J.1.1b, WS-J.2.5a | Flag, never auto-remove |
| WS-J.2.6e | Coordinated-report detection | WS-J.1.1d, WS-H.3, WS-A.1.1c, WS-J.2.2c, WS-J.2.5a | MFCI-2; SPEC 29.3 workflow |

Sequencing notes: WS-J.1.1a-e and WS-J.1.2a-b are the Wave-3 user-safety set and depend only on WS-D.1 (plus WS-A doctrine), so they ship before WS-G. WS-J.1.3a-d (appeals) follow the report set. The WS-J.2 console (queues, review, palette, appeal interface, audit) is the Wave-4 set; the audit writer (WS-J.2.5a) precedes its viewer (WS-J.2.5b) and is a dependency of every action producer. The automated pre-checks (WS-J.2.6a-e) attach to content submission (WS-G.3) and the invariant services (WS-H), degrading gracefully to cheap statistics before MFCI/MERI are live. Directionally, WS-J ships in M1 and is a **prerequisite** for the later extension workstreams' moderation interactions, not a dependent of them: **WS-Q** (Wave 9) lands before WS-J takes full queue ownership; **WS-R** (Wave 10) routes offline-reconciled content through WS-J's existing server-side pipeline (no new WS-J work — only the post-reconciliation moderability invariant); and **WS-S** (Wave 11) establishes that `private_p2p` content is **outside** WS-J's queue/console/pre-check scope (platform levers limited to stub delisting + account suspension). These are scope statements, not new `Depends on` edges — no WS-Q/R/S row is added to the dependency table above.

---

## Workstream definition of done

WS-J is complete when ALL of the following conditions hold:

1. **Reports, blocks, mutes, and appeals.** Users can report content, accounts, and rooms (`POST /v1/reports`); block (`POST /v1/blocks`, bilateral, API-enforced) and mute (`POST /v1/mutes`, one-directional) other users; and appeal moderation decisions (`POST /v1/appeals`). All flows work end-to-end with confirmation and feedback, are accessible (WCAG 2.2 AA), and function offline where applicable (report queueing). Reporter identity is never exposed to the reported user.

2. **Emergency report routing.** Emergency reports (imminent harm, CSAM, credible threats) are distinguished at submission from ordinary disagreement, routed to a distinct emergency path with a 1-hour review SLA, and page trained on-call responders. The emergency reason-code set is single-sourced from the taxonomy (WS-A.1.2a) with no drift.

3. **Moderation console.** The console is operational for stewards and safety moderators with role-gated access (WS-A.2.2): a priority/SLA-sorted report queue with filters, bulk actions, and assignment (WS-J.2.1); a full-context review interface with user history (no financial data), invariant decision-support signals, and side-by-side edit diff (WS-J.2.2); an action palette requiring reason codes, generating user notices for significant actions, and supporting undo/revert for reversible actions (WS-J.2.3); an appeal review interface enforcing reviewer independence (WS-J.2.4); and a searchable, append-only, access-controlled audit log with suppressed, identity-free transparency export (WS-J.2.5).

4. **Notice and appeal for significant actions.** Every significant moderation and account action carries a reason code and a readable statement of reasons; appealable actions surface the appeal path per the eligibility matrix (WS-A.1.2c / WS-J.1.3a); shadow/reduced-distribution actions are never silent; and appeal outcomes (overturn/uphold/modify) are communicated and audited (feeding TM-AOR).

5. **Automated pre-checks.** Automated pre-moderation catches spam and malware before publication via the only two permitted auto-block paths (WS-J.2.6a/b, with appeal recourse), and flags — never auto-removes — duplicate floods (WS-J.2.6c) and policy-risk content (WS-J.2.6d) for human review, with configurable thresholds, severity-driven queue priority, and monitored false-positive rates. The human-review-not-auto-removal invariant holds (auto-removals from the policy-risk layer are zero).

6. **Coordinated-report detection.** MFCI-backed coordinated-report detection (WS-J.2.6e) is active, identifying temporal clustering and account-correlation patterns conditioned on base rates (MFCI-1) so authentic communities are not mislabeled, delaying volume-driven enforcement pending integrity review (MFCI-2), protecting targets and reporter identities, and following the coordination-incident workflow (SPEC 29.3) with transparency logging.

7. **Auditability and observability.** Every steward action, automated block, assignment, appeal decision, and revert writes a complete, append-only audit record (WS-J.2.5a); safety SLAs, queue depths, false-positive rates, and appeal-overturn rate are continuously monitored and feed the transparency dictionary (WS-A.1.3a / WS-P.2). No financial data appears on any moderation surface, and no reporter identity, private moderation data, or minors' data is ever placed on-chain.

8. **Room-class scope (honest boundary).** WS-J's queue, console, action palette, and automated pre-checks govern **server-hosted** content only (`public_server` / `restricted_server`). `private_p2p` ("Private P2P room", WS-S) content is structurally out of reach — the platform never holds it (PRIVATE_SPEC §8/§11.4) — so it is never enqueued, scanned, or actioned in-room; the platform's only private-room levers are directory-stub delisting and account suspension, and in-room moderation is room-local. WS-R / LCAP-reconciled content is moderated through the same server-side pipeline once it reconciles to canonical state. This boundary is documented as by-design, not a coverage gap.

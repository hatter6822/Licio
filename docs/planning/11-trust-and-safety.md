# WS-J. Trust, Safety, and Abuse Operations

**Milestone:** M1 | **Priority:** 0-1 | **Dependencies:** WS-D.1 | **Wave:** 3-4 | **Estimated duration:** 3-4 weeks

## Overview

Safety controls work before the forum is complete. Reports, blocks, mutes, and appeals are early features. The moderation console serves stewards and safety moderators. Safety is continuous, not a phase.

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
- Integration test: report appears in the moderation queue after submission.
- Security test: reporter identity is not accessible via any API by the reported user.
- Rate limit test: excessive reports from one user are rate-limited (WS-J.1.1d).

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

**Acceptance criteria:**
- Each moderation action type has a documented appeal eligibility status.
- Warn, hide, remove, and restrict actions are immediately appealable.
- Ban actions are appealable after the cooldown period.
- Emergency restrictions are not appealable until the emergency review completes.
- The appeal form is hidden for ineligible actions with a clear explanation.
- Eligibility rules are configurable and version-controlled.

**Testing:**
- Unit test: each action type returns correct eligibility status.
- Unit test: ban action within cooldown period returns ineligible with cooldown remaining time.
- Unit test: ban action after cooldown returns eligible.
- Unit test: emergency restriction returns ineligible with explanation.
- E2E test: user sees "appeal" option for an eligible action and no option for an ineligible action.

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

---

## WS-J.2 Moderation console

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

---

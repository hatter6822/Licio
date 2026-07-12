# Trust, Safety, and Abuse Operations — implementation reference (WS-J)

WS-J ships the safety controls that protect users the moment they can read and
post: **reports, blocks, mutes, and appeals** (user safety), the **steward
moderation console** (queue, review, action palette, appeals, audit), the
**automated pre-checks** (spam/malware auto-block; duplicate-flood/policy-risk
flagging), and **coordinated-report detection**.  Everything is reason-code
bound (`docs/policy/MODERATION_TAXONOMY.md`), role-gated
(`docs/policy/STEWARD_ROLES.md`), and audited.

The planning document is `docs/planning/11-trust-and-safety.md`; the design lives
in `docs/SPEC.md` §16/§18/§25.  Where this disagrees with the SPEC, the SPEC
wins.

## Architecture

```
@licio/shared
  constants/moderation.ts   reason-code severity/SLA/appealability + the
                            emergency set (single-sourced; pinned to the
                            ratified taxonomy by a no-drift test)
  schemas/steward-roles.ts  the five doctrine roles, the capability→action/queue
                            policy, and the appeal-eligibility matrix (WS-A.1.2c)
  schemas/moderation-api.ts            user-facing wire contracts
  schemas/moderation-console-api.ts    console wire contracts

@licio/db
  schema/moderation.ts      cases, reports, actions, append-only audit, blocks,
                            mutes, appeals, notices, reviewer status, coordinated
                            incidents; + the steward_roles user column
  drizzle/0023_*.sql        migration; moderation_audit carries a DB-level
                            append-only (BEFORE UPDATE/DELETE) trigger whose ONLY
                            exception is the right-to-erasure NULLing of its
                            user-reference columns (the WS-D account-purge
                            ON DELETE SET NULL cascade)
  drizzle/0024_*.sql        partial unique index on coordinated_report_incidents
                            (target_type, target_id) WHERE status = 'open' — the
                            cross-connection authority that keeps coordinated-
                            incident creation atomic (one open incident per target)
  drizzle/0025_*.sql        moderation_cases.subject_user_id (FK users ON DELETE
                            SET NULL + index) — the user a case is ABOUT, populated
                            at report time, driving the `target_user` queue filter
  drizzle/0026_*.sql,       right-to-erasure: a `users` BEFORE DELETE trigger NULLs
  drizzle/0028_*.sql        an `account` target's polymorphic `target_id` (NOT an
                            FK, so the SET NULL cascade can't reach it) — 0026 on
                            the immutable audit log, 0028 extends it to
                            cases/reports/actions/incidents (target_id made
                            nullable; NULLs stay distinct in the open-target
                            partial unique indexes), so a hard purge leaves no
                            stable account id in ANY moderation table

apps/api/src/moderation/
  stores.ts        store interfaces + in-memory adapters (Postgres drop-in seam)
  drizzle-moderation-stores.ts  the gated production Postgres adapters (same
                            interfaces; the audit clear() is TRUNCATE, never a
                            row DELETE — the append-only trigger holds)
  config.ts        fail-closed runtime config (moderation.*; tunable without deploy)
  authz.ts         doctrine-role authorization (admin implies all; MFA + senior;
                            isIntegrityActor for the MFCI-2 / incident path)
  ports.ts         content / user / invariant / event / alert seams (safe defaults)
  production-ports.ts  the REAL ports over WS-D/E/F/G/H: content state →
                            ranking seam + WS-G state; user history stats; the
                            moderation.case.created event; the WS-H invariant
                            decision-support reads; the side-by-side snapshot
  forum-integration.ts  the WS-J.2.6 contribution-safety classifier + auto-block
                            sink assigned to the forum seams at boot
  malware-fetch.ts the WS-J.2.6b redirect-chain malware verdict (SSRF-safe)
  prechecks.ts     the WS-J.2.6 detection math + classifiers (pure, bounded)
  reports.ts       submission + idempotency + rate limits + routing + coordination
                            + new-case auto-assignment
  relations.ts     block/mute CRUD + the RelationshipReader enforcement seam
  appeals.ts       eligibility + independent assignment + decision/outcome
  actions.ts       the action palette + reversal-integrity revert (performRevert)
                            + the MFCI-2 enforcement-delay gate
  incidents.ts     the integrity queue: clear/confirm a coordinated-report
                            incident (reconciles the case's enforcement delay)
  audit.ts         append-only writer + transparency export (small-cell suppressed)
  notices.ts       statement-of-reasons + appeal-outcome inbox
  review.ts        queue + full-context review + appeal review projections
  assignment.ts    load-balanced assignment (shared by reports + appeals)
  scheduler.ts     lease-guarded sweeps (mute expiry, window prune, queue gauges)
  support.ts       the unauthenticated published support contact
  services.ts      injectable container + singleton + boot wiring

apps/api/src/routes/
  trust-safety.ts        user-facing: reports, blocks, mutes, appeals, support,
                         notice inbox
  moderation-console.ts  role-gated console: queue, review, actions, revert,
                         bulk, assignment, appeals, integrity incidents, audit,
                         export, config

apps/web/src/
  lib/safety-api.ts                       typed client (zod on every response)
  components/safety/                      report sheet + ReportButton (mounted on
                                          the feed card + story page), support
                                          contact, block/mute, notice inbox + appeal
  components/moderation/ModerationConsole steward console (queue/review/palette/
                                          appeals/integrity/audit)
  routes/support.tsx, profile_.notices.tsx, profile_.safety.tsx, moderation.tsx
```

## WS-J.1 User safety controls

- **Reports (`POST /v1/reports`, WS-J.1.1a–d).** Taxonomy-bound `reason_code`,
  optional `context`/`evidence_urls` (stored, never fetched at submit —
  SSRF-safe), and a `local_operation_id` idempotency key (offline-replay safe).
  Severity and emergency routing are derived from the SINGLE taxonomy source
  (`isEmergencyReasonCode` = {critical} ∪ {imminent-risk}); reports aggregate
  into one open **case** per target.  Rate limits (per-user/hour, per-target/day)
  are derived from the durable store (correct across restarts).  Emergency
  reports page on-call with minimum context (never reporter identity).
- **Blocks (`/v1/blocks`, WS-J.1.2a).** Bilateral and API-enforced: the
  `RelationshipReader.interactionBlocked` seam is what forum interaction
  rejection + thread/feed viewing filters consult.  Lists are private; the
  blocked user is never notified.
- **Mutes (`/v1/mutes`, WS-J.1.2b).** One-directional viewing filter with an
  optional duration that auto-lifts (the scheduler sweeps expired mutes).
- **Appeals (`/v1/appeals`, WS-J.1.3).** Eligibility mirrors the WS-A.1.2c matrix
  (`appealEligibility`): warn/hide/restrict immediate; remove except CSAM/
  imminent-threat (lawful basis); ban after a cooldown; emergency deferred;
  shadow only after notice.  **Independence is enforced server-side at BOTH
  assignment (never the original decision-maker) and decision time** (the
  original decision-maker can never act on the appeal).
- **Support contact (`GET /v1/support-contact`, WS-J.1.1e).** Unauthenticated,
  jurisdiction-aware emergency resources with a safe default set.
- **Notices (WS-J.1.3d).** Every significant action emits a durable
  statement-of-reasons notice (the in-app inbox) with the reason code and, where
  appealable, the appeal path — **no silent sanctions**.

## WS-J.2 Moderation console

Role-gated by doctrine steward role + verified MFA (`requireConsole`); the
platform `admin` role implicitly holds all five doctrine roles.

- **Queue (WS-J.2.1).** Priority/SLA-sorted, emergency section on top, keyset
  pagination, filters, assignment + reviewer availability, and bulk actions
  (per-item audited + reversible).
- **Review (WS-J.2.2).** Full-context panel: reports (reporter identity only for
  ROLE_SAFETY/ROLE_INTEGRITY — §19.5), the user-history sidebar with prior-
  contribution count + per-type tally + distinct rooms (**no
  wallet/payment/treasury/donor field exists, by construction** — §13.6), the
  REAL WS-H invariant decision-support signals (MFCI risk state, SCOI context,
  PHI holonomy, Hodge tension — MFCI coordination detail role-gated to
  ROLE_INTEGRITY; a missing output degrades to "unavailable", never a misleading
  zero), the thread context centered on the reported item (all moderation states
  visible to the reviewer), and the side-by-side edit diff reconstructed from the
  WS-G edit history (anti edit-to-evade).
- **Action palette (WS-J.2.3).** The single enforcement entry point:
  capability-gated, reason-code-required, notice-generating, audited,
  report-resolving; reversible actions revert with reversal integrity (a revert
  restores visibility ONLY when no other active removal still holds the item).
  An appeal overturn/modify reverses the original under ROLE_APPEALS authority
  (bypassing the steward-capability gate, which the original action required) —
  the lift is NOT gated on the action's `reversible` flag (that flag governs only
  the steward self-revert endpoint), so an overturned/modified **ban is actually
  lifted**, and a `modify` reflects the new, less-severe action's full effect to
  distribution (content hide/remove AND account restrict/suspend), never leaving
  the target silently fully restored.  A **`shadow`** action is a DISTRIBUTION
  reduction, not a WS-D account-state change (`accountStateFor('shadow')` stays
  null, so it never appears in `account_state` or client context): it drops the
  author's content to ZERO organic reach at the WS-I ranking safety filter
  (`author_shadow`) — via `listActiveShadowedSubjects`, injected as a function
  dependency so the ranking import closure stays moderation-free — while the
  content stays directly readable and in-room.  Reverting the shadow restores
  reach (the auto-expiry sweep covers only restrict/suspend, so a shadow is
  permanent until manually reverted).
- **Integrity incidents (WS-J.2.6e / MFCI-2).** A coordinated-report incident
  HOLDS the case's volume-driven enforcement (`applyAction` returns
  `enforcement_delayed` for non-ROLE_INTEGRITY actors).  The ROLE_INTEGRITY
  integrity queue (`GET /v1/moderation/incidents`) lists open incidents
  (aggregate, base-rate-conditioned summary — never per-reporter identity) and
  resolves them: `cleared` lifts the delay (enforcement may proceed), `confirmed`
  dismisses the case (the target is protected).  Every resolution is audited.
- **Audit (WS-J.2.5).** Append-only (app path + DB trigger); the viewer is
  role-gated and meta-audited; the transparency export applies small-cell
  suppression and never exposes reporter identities.  The DB trigger blocks all
  row UPDATE/DELETE EXCEPT the right-to-erasure NULLing of the user-reference
  columns — so a WS-D account hard-purge (SPEC §19.2) of a user who appears in
  the log succeeds (the substantive record survives with severed identity links)
  rather than being rejected by the trigger.

## WS-J.2.6 Automated pre-checks (the detection math)

All in `prechecks.ts`, as pure, total, bounded, unit-tested functions:

- **Spam (WS-J.2.6a)** — confidence via **noisy-OR** (`1 − ∏(1 − pᵢ)`,
  monotone and order-independent) over known-hash / pattern / velocity /
  new-account-link-heavy signals; ≥ block threshold auto-blocks (a permitted
  auto-block path), ≥ 0.5 flags, else passes.
- **Malware (WS-J.2.6b)** — local blocklist + an injected reputation provider;
  malicious auto-blocks; unavailable **fails toward flagging, never trusting**.
- **Duplicate flood (WS-J.2.6c)** — per-account near-dup across rooms in a
  window; **flags, never removes**.
- **Policy-risk (WS-J.2.6d)** — heuristic toxicity/graphic classifier;
  **flags with a severity, never removes** (the human-review invariant).
- **Coordinated reports (WS-J.2.6e)** — the coordination score is
  **base-rate-conditioned (MFCI-1)**: dominated by the new-account cohort
  fraction, so a large *authentic* community (diverse, older accounts) scores
  near 0 regardless of volume, while a freshly-minted sock-puppet brigade scores
  high.  Above threshold it opens an incident and **delays volume-driven
  enforcement pending integrity review (MFCI-2)** — protecting the target
  without mislabelling communities.

## Testing

| Suite | What it pins |
|---|---|
| `packages/shared/.../moderation-metadata.test.ts` | severity/SLA/appealability/emergency helpers |
| `apps/api/.../moderation-doctrine-consistency.test.ts` | the code constants EQUAL the ratified policy docs (no drift) |
| `apps/api/.../moderation-prechecks.test.ts` | the detection math: noisy-OR monotonicity, bounds, the MFCI-1 base-rate guarantee |
| `apps/api/.../moderation-services.test.ts` | submission/coordination, palette+revert, appeal independence, relations, audit, notices, review, authz, config, MFCI-2 enforcement-delay + incident resolution, reversal integrity, **and the appeal ban-lift / `modify` state-reflection** (an overturned/modified ban is actually lifted) |
| `apps/api/.../moderation-stores.test.ts` | every in-memory adapter branch: filter dimensions, keyset/offset pagination boundaries, idempotency, bilateral/expiry rules, owner/miss guards |
| `apps/api/.../moderation-review.test.ts` | queue filters + pagination, SLA-state thresholds, the side-by-side snapshot + thread context, and the appeal queue/review panels |
| `apps/api/.../moderation-units.test.ts` | the lease-guarded tick (+ per-task error sink), assignment load-balancing + appeal independence, jurisdiction-aware support contact, statement-of-reasons phrasing |
| `apps/api/.../moderation-routes.test.ts` | the HTTP surface end-to-end (report→action→notice→appeal→overturn; role separation; integrity-queue gating; audit/export; config) + the error/edge branches (mute/block/notice 404s, eligibility/duplicate/non-appealable, rate-limit 429, bulk, assign, revert, reviewer-status, audit pagination) |
| `apps/api/.../moderation-production-ports.test.ts` | the real ports: content state → ranking seam, case-event persist-before-publish, the invariant decision-support mapping, side-by-side snapshot reconstruction, user-history stats |
| `apps/api/.../moderation-integration.test.ts` | the gated Postgres adapters over the real 0023 migration chain (keyset queue, idempotent block/mute, numeric round-trip, append-only) + **the right-to-erasure path** (purging a user severs the audit user-links but preserves the record) |
| `apps/web/.../safety.test.tsx`, `console.test.tsx`, `ModerationConsole.panels.test.tsx` | the two-tap report flow, support contact, and the console (queue→review→palette, appeals, integrity incidents, audit; empty/forbidden states; with axe) |
| `apps/web/.../lib/safety-api.test.ts` | the typed client assembles every user-facing + console request (with and without each optional argument) |

## Production wiring (shipped)

The in-memory stores + safe-default ports still back dev/test/CI; the production
boot now swaps in the durable + real wiring:

- **Durability.** The gated Drizzle adapters (`drizzle-moderation-stores.ts`)
  back all ten stores when `DATABASE_URL` is set; `moderation_audit` stays
  append-only (the BEFORE UPDATE/DELETE trigger; the test-only `clear()` uses
  TRUNCATE; the trigger permits ONLY the right-to-erasure NULLing so a WS-D
  account purge of a logged user succeeds).  That same hard purge also scrubs the
  polymorphic `account` `target_id` to NULL across EVERY moderation table (audit +
  cases/reports/actions/incidents), so no stable erased-account id survives
  anywhere.  The lease-guarded scheduler runs the sweeps.  (`drizzle-moderation-stores.ts` is exercised by the gated integration
  suite, not unit tests — the same coverage convention as every other
  workstream's Drizzle adapter.)
- **Real ports.** A content removal writes the WS-E item-safety state (the
  ranking-exclusion seam) + the WS-G contribution state; a STORY removal also sets
  its canonical `hiddenState` (gone from the direct read), and a THREAD removal
  locks the thread to `restricted` (gone from the direct thread reads + the create
  guard + the ranking filter — not just the distribution seam, then lifted on a
  revert); account actions write the WS-D state; user resolution reads the WS-D
  directory + the WS-G history stats; opening a case emits `moderation.case.created`
  (persist-then-publish, restricted); the review panel reads the REAL WS-H
  invariant outputs.  Reports carry the SERVER-resolved `content_kind`
  (story/thread/contribution), never an unverified client hint.
- **Enforcement.** Blocks/mutes are consumed in forum interaction rejection +
  thread/feed viewing filters and the ranking feed filter; the WS-J.2.6
  classifier + auto-block sink run on the WS-G contribution submission path
  (WS-F story submission rejects spam/malware at submission time — a stronger,
  by-design gate, so it is NOT double-processed through WS-J).

## Correctness & accountability invariants (enforced)

These are structural guarantees the code holds (each covered by a test):

- **Action reversibility is truthful.** Only enforcement actions that changed a
  content/account state are `reversible`; the workflow-only verbs (`escalate`/
  `clear`) report `reversible: false`, so `/actions/:id/revert` returns
  `not_reversible` rather than falsely succeeding while the case stays open.
- **`case_id` must match the action target.** Resolving a case off a stale/forged
  `case_id` for a DIFFERENT target is refused — the enforcement stands on its own
  target and the unrelated case is never silently dropped from the queue.
- **One open incident per target.** Coordinated-incident creation is atomic
  (synchronous in-memory check-and-insert; the 0024 partial unique index in
  Postgres), so a high-volume target cannot spawn duplicate incidents that would
  leave the enforcement delay half-lifted.
- **The audit log audits its own reads.** Both the transparency export AND the
  `/audit` viewer write a meta-audit record (the query scope), so steward
  inspection of the accountability trail is itself accountable.
- **Config is an enforcement surface.** Reading or writing `moderation.*` runtime
  config requires report-queue or integrity-queue access (not an evidence-only or
  appeals-only steward), and every write is audited with the keys it touched.
- **Appeals are decided from the review surface.** The console offers no inline
  decide on a queue row; a decision requires opening the review (appellant
  statement, new evidence, original context, side-by-side snapshot) and a written
  explanation.  Filing an appeal flips the originating notice to `pending`, so the
  inbox stops offering an Appeal affordance that would 409.  A `modify` outcome
  must be both strictly less severe AND applicable to the original target type
  (no account→content "modification" that leaves no enforcement).
- **Queue filters are honored.** `target_user` filters on the case's
  `subject_user_id`; `reporter` resolves the reporter → their case ids and is
  honored ONLY for roles permitted to see reporter identity.  Both the report
  queue and the appeal queue are keyset-paginated (stable under inserts), so no
  case/appeal is stranded beyond the first page.
- **Accountability completeness.** Console actions persist the case's aggregated
  `report_ids` (the audit view exposes them); coordinated incidents record the
  recomputed aggregate severity; and a user's moderation notices are included in
  their DSAR export (reason codes only, never reporter identity).

**Evidence queue + decisions (ROLE_EVIDENCE — STEWARD_ROLES.md).**  The
console's Evidence tab serves the doctrine surface: `GET
/v1/moderation/evidence-queue` lists citation-bearing published contributions
(sourced comments + corrections) OLDEST first — the queue is DERIVED
(citation-bearing rows with no decision yet), so it can never drift from
store reality; the cursor advances over already-decided rows.  `POST
/v1/moderation/evidence-decisions` applies the two doctrine actions —
`mark-primary-source` / `flag-citation` (each annotates exactly ONE of the
contribution's own citations; flags require a ratified WS-A reason code) —
plus the `clear` queue workflow (reviewed, no annotation).  Decisions are
evidence METADATA only (ROLE_EVIDENCE holds no content-removal power by
construction: the module never touches a moderation state), audited under the
doctrine action ids, duplicate-protected by partial unique indexes
(`evidence_decisions`, migration 0077), and listed newest-first via `GET
/v1/moderation/evidence-decisions`.  The public consumer is the WS-H
independent-sources drawer, which surfaces `mark-primary-source` annotations
on the story's lineage panel ("reviewed by an evidence steward").  The
reviewer link-opening malware check (`/url-verdict`) is access-gated to the
panels the links render in: report-queue OR evidence-queue roles — and
`mark-primary-source` itself refuses a citation whose server verdict is
`malicious` (promoting a URL to a public surface is the one console action
that cannot skip the check).  Two deliberate postures: the queue is
PROACTIVE — unlike the report queue it lists citation-bearing contributions
platform-wide (including private-room and `room_only` content) with no
member report as a trigger, the SPEC §16.1 "private from the public, not
from the platform" rule applied to provenance review; and
`evidence_decisions.decided_by` is an accountability field with the
audit-actor erasure posture (nullable, severed on a hard purge — steward
actions are not subject-data in the actor's own DSAR export, matching the
moderation audit log).

## Residuals (tracked)

These are honest, tracked gaps — see `docs/planning/11-trust-and-safety.md`:

- **BFF E2E** for the safety flows (report → console review → action → appeal),
  driven through the WS-P BFF-in-the-loop harness.
- **Block/mute + report affordances** are mounted on the safety page, the feed
  card, and the story page; mounting them on every contribution row + profile
  header is remaining client polish.
- **SPEC enhancements beyond the §-DoD** (not claimed complete): the two-person
  co-approval rule for the highest-severity actions; escalation AUTO-routing to a
  senior queue (today `escalate` sets the case status and seniors pull it);
  room-report room-steward-layer-first routing; and the on-call paging PROVIDER
  (a WS-O binding — alerts log today).

## Room-class scope (honest boundary)

WS-J's queue, console, palette, and pre-checks govern **server-hosted** content
only (`public_server` / `restricted_server`).  `private_p2p` content (WS-S) is
structurally out of reach — the platform never holds it — so it is never
enqueued, scanned, or actioned in-room; the only private-room levers are
directory-stub delisting and account suspension.  WS-R/LCAP-reconciled content is
moderated through the same server-side pipeline once it reconciles.

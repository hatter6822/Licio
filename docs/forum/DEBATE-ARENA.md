# Sourced comments & the correction debate arena — implementation reference (WS-T)

An extension of WS-G/WS-T (forum + conversation) that reworks **sources** and
**corrections** in story comment sections, adjudicated by the room's governed AI
(WS-K/WS-U). SPEC §15.4/§24.6.

## The model

**Sources are links on comments.** Any comment may attach `citations`
(`commentCreateSchema`, optional). A sourced comment counts as **strictly
greater participation** than an unsourced one — a PWAtt content/evidence weight
(`citationBonus`, applied to the *saturated* per-type value in both the served
v1 and the v0/ledger paths), never applause and never payment, so the
pay-to-rank neutrality firewall holds (`check:neutrality`).

**Corrections target a comment or story and MUST be sourced.**
`correctionCreateSchema` retargets from a claim to **exactly one** of a comment
(`target_contribution_id`, same thread) or the story root (`target_story_id`),
keeping the 1–5 mandatory-source floor.  The create guard refuses a correction
against a target already `under_debate` or already adjudicated `incorrect`
(`target_under_debate` / `target_already_incorrect`), so a direct API caller
cannot open a second arena or re-litigate a settled outcome.  A `validated`
target (challenged and proven accurate) is deliberately **NOT** refused — it
remains re-challengeable if new evidence emerges.

**A sourced correction opens a live debate arena** (`debate_arenas`, migrations
`0056`/`0078`/`0079`; `apps/api/src/forum/debate.ts` + `debate-store.ts`).  The
arena is about the **real material**: the challenged story/comment (the
**incumbent**'s side) and the correction (the **challenger**'s side) render on
the arena modal LIVE while it is open — either author may keep adjusting their
underlying content through the normal edit paths, and each side may layer an
optional co-visible **rebuttal statement** (summary + sources) on top.

| Phase | Duration | What happens |
|-------|----------|--------------|
| `open` | up to 23h | Both sides adjust their underlying content + rebuttal statements (live co-visibility). The challenger may **withdraw** the correction; the incumbent may **concede**. Every **material** content/rebuttal edit resets the editor's side-activity clock — a no-op PATCH (body/citations identical to the stored row) does NOT count as activity, so the both-sides-idle expedite can't be dodged with contentless pings. |
| `locked` | ≤1h | The material is **locked in** (a content snapshot is stamped). Two paths lead here: the **both-sides-idle expedite** — once BOTH sides have gone 1h without an edit, the arena locks at that instant and its queue entry pulls forward to *now* (a no-show incumbent therefore resolves ~1h after the challenge); or the **schedule** — at hour 23 the material locks regardless and the final hour is a frozen countdown. |
| `awaiting_verdict` → `judged` | — | At `resolve_due_at` the debate enters the **room's AI resolution queue**: the lease-guarded scheduler (`debate-scheduler.ts`) runs the governed adjudicator over the LOCKED snapshot (due arenas fan out 4-wide per pass — independent verdicts, per-arena failure isolation); a verdict + the 24h override window are recorded. |
| `judged` | 24h | The room **steward may fully overrule** the verdict either direction (audited, subordinate to the platform floor). |
| `resolved` | — | On `corrected` the loser is tagged `incorrect`; on `upheld` the challenged target is tagged `validated`. |
| `withdrawn` | — | Terminal early close: the challenger retracted the correction while the arena was open — no verdict, the target's tag clears to `none`, and the target stays re-challengeable. |

**Party-driven early closes (open window only).** The challenger may
**withdraw** the correction (`withdrawn`, above).  The incumbent may **concede**
— the arena resolves immediately as `corrected` with `decided_by =
'concession'` and the target is tagged `incorrect` (no adjudicator runs).
Removing the underlying contribution does the same thing through the same
gates: an author deleting their correction withdraws the debate; an incumbent
deleting the challenged comment concedes it.  From the lock onward
**everything is frozen**: rebuttal posts, underlying-content edits, removals,
withdrawal, and concession are all refused with `debate_locked` /
`window_closed` until the verdict lands.

Outcome: `upheld` (incumbent stands → the challenged target is tagged
`validated`: challenged and **proven accurate**, earning a modest ranking
**boost** and still re-challengeable), `corrected` (challenger prevails → the
target is tagged `incorrect`), or `inconclusive` (cleared back to `none`). An
`incorrect` contribution stays **VISIBLE** — an orthogonal `dispute_status`
column, never a `moderation_state` — but sinks to the bottom of its section; a
`validated` one is instead lifted ABOVE unchallenged content (a positive
content-integrity signal, never applause). A **self-targeted** arena (the
challenger is the target's own author) can never earn `validated` — an upheld
self-challenge clears to `none`, so the boost cannot be self-farmed. Fail-closed:
a blocked/unavailable judge resolves `inconclusive`.

## The AI judge — a governed probabilistic neural model

`@licio/ai-governance` `debate-judge.ts`: a real **MLP (ReLU hidden layer) +
softmax** over *content-structural* features only — independent-domain source
count (weighted over raw link count, anti-gaming), link-safety pass rate, WS-F
source reliability, evidence substance (over the side's **locked underlying
content plus its rebuttal statement**), direct rebuttal. The judge input is the
hour-of-lock snapshot: each side carries `content` (the challenged story/comment
text or the correction body), `summary` (the rebuttal statement), and the UNION
of both layers' citations. There is **no**
author/topic/viewpoint/wealth feature, so it cannot encode viewpoint preference
(neutrality) and is not a member vote/tally (no-applause). The independence
feature counts distinct **registrable domains** (eTLD+1 via `domainOf`, with a
curated two-label public-suffix set), so a challenger cannot inflate it by citing
sibling subdomains (`a.example.com`, `b.example.com`) of one domain.

The *model* is probabilistic + neural; the *shell* is deterministic, auditable,
verifiable: the weights are a **pinned, versioned artifact** (`DEBATE_JUDGE_WEIGHTS`),
the forward pass is pure with a fixed evaluation order (same input ⇒
byte-identical verdict, replayable), and every verdict runs through the WS-K
deploy gate + the pre-execution `ProhibitedUseGuard` and writes an **immutable
`AIOutputRecord`** whose config hash pins the exact weights. Real trained
weights swap into the same artifact behind the same registry/guard machinery —
the WS-K "real backend is a seam" contract.

**The LLM leg (the production default).** That seam is exercised: when a
governance LLM backend is enabled (production defaults to the loopback-`local`
backend; `GOVERNANCE_LLM_DEBATE=off` opts this surface out), the adjudicator is
a governed **LLM** (`apps/api/src/ai-governance/llm/debate.ts`) that reads both
sides' locked content, rebuttals, and sourcing and emits ONLY class
probabilities + a bounded rationale. Authority stays in the deterministic
shell: the outcome mapping is `judgeDebate`'s exact argmax/tie rule + the
shared verdict vocabulary, probabilities are clamped/renormalized, and the
rationale is length-capped with a no-URLs bound (the arena renders it). Its own
registry identity clears the WS-K deploy gate, every verdict writes an
`AIOutputRecord`, and **any** failure — transport, refusal, schema, budget,
breaker, an unusable assessment, a provenance-write fault — falls back to the
pinned-weights MLP above, so a verdict is always rendered at at least the
deterministic quality floor. The steward's 24h overrule remains the human
remedy over every leg. In development the DEV-ONLY simulated runtime serves
this surface (`docs/DEVELOPMENT.md` §16).

**The room's AI resolution queue (WS-U `debate.judge`).** The WS-U
`debate.judge` capability (floor-disjoint, deny-by-default; permitted by the
default law-pack) routes a governed room's debates through **its own ratified
agent**: the judge runner resolves `GovernanceService.debateConditioning(roomId)`
— active binding → `hasCapability(descriptor, 'debate.judge')` → the ratified
model under the SAME backend-admission pin as moderation → the room's
community-ratified prompt — and, when granted, the governed LLM leg runs
**room-conditioned** (the room prompt folds into the system prompt *subordinate
to the platform rules*, exactly the moderation proposer's framing). The
verdict's `AIOutputRecord` pins the room, the ratified model id, and the prompt
digest in its input refs, and the adjudication is appended to the WS-U **agent
action log** (`actionType: 'debate.judge'`, reversible — the steward's 24h
overrule is the human remedy).  The log append runs through the runner's
`onCommitted` hook, ONLY after the verdict's `recordVerdict` CAS lands on the
arena row — a concurrent judge that loses the supported `awaiting_verdict`
re-claim race never logs an adjudication the row discarded. Every failure at
any step resolves deny-by-default to the platform legs (platform-prompted LLM
→ pinned MLP).

**Window policy.** The 23h edit / 1h lock / 1h inactivity / 24h override
windows are the §15.4 spec constants (`DEBATE_EDIT_WINDOW_MS` /
`DEBATE_LOCK_WINDOW_MS` / `DEBATE_INACTIVITY_WINDOW_MS` /
`DEBATE_OVERRIDE_WINDOW_MS`; `DEBATE_LIVE_WINDOW_MS` = edit + lock = 24h),
injectable via `DebateDeps.windows` ← `ForumServices.debateWindowsOverride` — a
**dev/test-only seam** nothing in production wiring ever sets. The DEV traffic
simulator sets short windows (45s edit / 15s lock / 20s idle / 15s override)
while it runs (restored on stop), **scoped via `appliesToUser` to arenas whose
parties are BOTH synthetic personas** — a debate the developer's own account
opens or defends keeps the REAL spec windows and can be watched live, with the
dev **fast-forward** control (`POST /v1/dev/simulator/debates/:id/fast-forward`,
also in the arena modal in dev builds) jumping it to `locked`/`verdict`/`resolved`
by shifting its own deadlines and running the REAL lifecycle sweep. The
challenge-resolution **throughput pulse** (arenas opened/awaiting/adjudicated/
finalized, LLM verdict split + fallbacks, average adjudication wall-clock)
renders in the dev panel and at `GET /v1/dev/simulator/status` (see
`docs/DEVELOPMENT.md` §10).

## Surfaces

- **API:** `POST /v1/contributions` (a sourced correction opens the arena
  SYNCHRONOUSLY — `maybeEnterDebate` is awaited, so `metadata.debate_arena_id` is
  set on the response ONLY when the arena actually opened and always resolves, no
  navigate-to-404 race); `GET /v1/debates/:id` + `GET /v1/debates/:id/stream`
  (both **thread-readability-gated** — knowing a debate id never reveals a
  restricted-room conversation, 404-over-403; the projection carries
  `target_content`/`correction_content` — live rows while `open`, the locked
  snapshot after, and a moderation-removed row projects `removed: true` with no
  body); `POST /v1/debates/:id/position` (rebuttal statement, `open` only; the
  store update is `state = 'open'`-guarded so a write racing the lock/judge
  can't mutate locked-in material — and it resets the side's activity clock);
  `POST /v1/debates/:id/withdraw` (challenger, `open` only) +
  `POST /v1/debates/:id/concede` (incumbent, `open` only);
  `POST /v1/debates/:id/override` (steward, 24h window).  **Every debate
  WRITE carries the same thread-readability gate as the reads** (404-over-403):
  a party or steward who has since lost access to the conversation — left a
  restricted room, or the thread was pulled by the moderation floor — can no
  longer post to, close, or overrule its arena.  The story discovery list
  (`GET /v1/stories/:id/debates`) suppresses a moderation-withheld target's
  `target_excerpt` (null, exactly like the arena projection).  Contribution
  edit/removal of debated content is gated: allowed while `open` (a
  **material** edit counts as side activity and fans out live), refused with
  `debate_locked` while `locked`/`awaiting_verdict`.  Two race seams are
  closed structurally: the edit-race snapshot refresh runs AFTER the edit's
  moderation decision (a held edit refreshes into the locked snapshot as the
  SUPPRESSED side, never as material the floor is withholding), and
  removal-vs-open is closed from BOTH sides (the arena open re-checks the
  target after opening and voids itself against a tombstone; the removal
  re-reads live arenas after the tombstone and closes any late-opened arena
  with the party's exit — each side writes before it reads, so one of the two
  always observes the other).
- **Web:** source capture + render + a "Sourced" badge on comments
  (`CommentParts`/`CommentNode`).  Sources render **inline as clickable links in
  the comment body itself** (the `.ugc-body a` affordance — click-intercepted by
  `UgcBody`, WS-G.4.2c); legacy "bare" citations with no matching inline link fall
  back to a compact trailing list of `SafeExternalLink`s — there is **no separate
  "Sources" modal**.  The report control is an **icon-only flag** (mirrors the
  story card).  The "Correct" action → `CorrectionComposer`; a "View debate"
  control on `under_debate` comments.  The arena itself is a focused **MODAL**
  over the story surface (`components/debate/DebateArenaModal`, a Sheet),
  deep-linked via the `?debate=<id>` search param on the story page AND the
  dedicated comments page (the legacy `/stories/:id/debate/:id` route
  redirects into the param — the room-governance modal's pattern; closing
  clears the param so back/refresh behave honestly).  Inside, the two sides
  read **side-by-side**: each column shows the REAL material (the challenged
  story/comment | the correction) with live-vs-locked badges, clamped to a
  short preview that **expands to the full content + all sources**, with the
  side's argument statement beneath it (editable in place by its author while
  open).  The header carries the state line + lock/queue/override countdowns
  + the both-sides-idle early-resolution hint; the footer carries the
  withdraw/concede affordances, the verdict banner (including "Decided by the
  incumbent's concession"), the steward override, and a DEV-only fast-forward
  row.  The active-debates `DebatePanel` + `DisputeBanner` render
  on the story page AND the dedicated `/stories/:id/comments` surface.  Dispute
  tags render through the shared `DisputeBadge`/`DisputeBanner`:
  **"Challenged"** (`under_debate`), **"Incorrect"** (`incorrect`),
  **"Validated"** (`validated`) — on comments (the header), story cards (the
  rating row), and the story detail page (a banner).

## Doctrine

No-applause (no vote/tally/scoreboard anywhere — the outcome is a
content-structural adjudication); neutrality (uniform, content-only features +
`check:neutrality`); no-raw-egress (arena text rides the sanctioned schema
boundary + `UgcBody`); WS-K bounds (deploy gate + prohibited-use guard + output
record); steward power bounded (24h, audited, subordinate to the non-overridable
platform legal floor).

## Read-side, reorder, and feed integration

- Comment projections carry `active_debate_id` (from the debate store's
  `activeDebateIdsForContributions`), so a comment `under_debate` links straight
  to its arena — the `CommentNode` action row renders a **"View debate"** link so
  the incumbent author (and everyone else) can reach it to adjust their content
  and post their rebuttal while the arena is open; the story-comments `overview`
  reports `debates_count` + `incorrect_count`.
- The **"Sources" view is every SOURCED root** — an `evidence` card OR a comment
  carrying ≥1 citation (the exact predicate the "Sourced" badge uses), not just
  the `evidence` type — via the store's `sourced` predicate (`listRoots` +
  `countSourced`, in-memory + Drizzle); `overview.sources_count` counts the same
  set.
- `incorrect` comments SINK to the bottom of their section — a composite keyset
  `(sink, created_at, id)` that holds across pagination, both orderings, and
  recursively among children (in-memory + Drizzle; the `(thread, dispute_status,
  created)` index supports the ORDER BY).  No wire-format change: the cursor is
  the contribution id and the sink is derived at lookup.  Conversely, a
  `validated` comment is BOOSTED in the "highest participation" view
  (`commentParticipationWeight` + `VALIDATED_PARTICIPATION_BONUS`) so a comment
  challenged and proven accurate ranks above unchallenged ones.
- A `corrected` STORY sinks in the ranking feed.  The `dispute_penalty` is
  RECORDED as an always-enforced decision-log term, but the guaranteed bottom-out
  is an **ordering-level sink** (`disputeOrderingSink`, subtracted OUTSIDE the
  SCOI distribution multiplier and exceeding the whole non-sink score span), so a
  corrected story with strong baseline/participation still sorts strictly below
  every non-disputed story — the feed analogue of the comment sink (a
  content-derived, uniform, non-financial signal — `check:neutrality` green).
  `finalizeDebate` sets the story's `dispute_status` AND refreshes its ranking
  feature vector (`refreshStoryFeaturesBestEffort`) so the penalty applies
  immediately, not only on the next unrelated invariant event / hourly batch.
  A `validated` STORY gets the symmetric treatment: the assembler sets
  `dispute_validation`, and `disputeValidationBoost` (the profile's `vD`, default
  0.25) adds a modest lift OUTSIDE the SCOI multiplier — a soft nudge, never a
  guaranteed top, so it cannot be gamed into hard promotion (`check:neutrality`
  green: uniform, content-derived, non-financial).
- Live co-visibility is push-based: a `DebateBroadcaster` fans out the observer
  arena projection over `GET /v1/debates/:id/stream` (SSE), and the web
  `useDebateStream` nudges an immediate role-scoped refetch on each frame (the 5s
  poll is the fallback).
- The gated Drizzle `debate_arenas` adapter (over migrations 0056/0078/0079) is
  bound at production boot and proven by the parameterized `DebateStore`
  contract test (in-memory always; live Postgres under `DATABASE_URL`),
  including the lock CAS, withdrawal/concession, the activity clocks, and the
  both-sides-idle sweep over the partial `greatest(...)` index.

## Residuals

- Field confirmation of the live stream on physical browsers at scale (the
  headless path — broadcaster fan-out + the SSE route + the client hook — is
  covered; multi-instance fan-out runs the `RedisDebateBroadcaster` bound at
  production boot).
- WS-Q.3.5 data-rights anonymization does not yet scrub a locked debate
  snapshot (`locked_content`) that quotes an anonymized contribution — the
  arena is the transparency artifact of a judged dispute, but the DSAR sweep
  should redact snapshot bodies for erased authors (tracked here).

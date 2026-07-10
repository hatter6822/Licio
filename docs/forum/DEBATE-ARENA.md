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

**A sourced correction opens a live debate arena** (`debate_arenas`, migration
`0056`; `apps/api/src/forum/debate.ts` + `debate-store.ts`):

| Phase | Duration | What happens |
|-------|----------|--------------|
| `open` | 12h | The **incumbent** (target author) and **challenger** (correction author) post + edit a co-visible position (summary + sources). The client polls, so each sees the other's current draft and offers their strongest case. |
| `awaiting_verdict` → `judged` | — | At the deadline the lease-guarded scheduler (`debate-scheduler.ts`) runs the governed adjudicator (due arenas fan out 4-wide per pass — independent verdicts, per-arena failure isolation); a verdict + the 24h override window are recorded. |
| `judged` | 24h | The room **steward may fully overrule** the verdict either direction (audited, subordinate to the platform floor). |
| `resolved` | — | On `corrected` the loser is tagged `incorrect`; on `upheld` the challenged target is tagged `validated`. |

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
source reliability, evidence substance, direct rebuttal. There is **no**
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
positions' substance and sourcing and emits ONLY class probabilities + a
bounded rationale. Authority stays in the deterministic shell: the outcome
mapping is `judgeDebate`'s exact argmax/tie rule + the shared verdict
vocabulary, probabilities are clamped/renormalized, and the rationale is
length-capped with a no-URLs bound (the arena renders it). Its own registry
identity clears the WS-K deploy gate, every verdict writes an
`AIOutputRecord`, and **any** failure — transport, refusal, schema, budget,
breaker, an unusable assessment, a provenance-write fault — falls back to the
pinned-weights MLP above, so a verdict is always rendered at at least the
deterministic quality floor. The steward's 24h overrule remains the human
remedy over both legs. In development the DEV-ONLY simulated runtime serves
this surface (`docs/DEVELOPMENT.md` §16).

The WS-U `debate.judge` capability (floor-disjoint, deny-by-default) lets a
governed room route adjudication through its own agent under its law-pack bounds.

**Window policy.** The 12h edit / 24h override windows are the §15.4 spec
constants (`DEBATE_EDIT_WINDOW_MS`/`DEBATE_OVERRIDE_WINDOW_MS`), injectable via
`DebateDeps.windows` ← `ForumServices.debateWindowsOverride` — a **dev/test-only
seam** nothing in production wiring ever sets. The DEV traffic simulator sets
short windows (≈20s/10s) while it runs (restored on stop) and advances due
arenas every tick, so synthetic sourced corrections resolve observably: the
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
  restricted-room conversation, 404-over-403); `POST /v1/debates/:id/position`
  (12h window; the store update is `state = 'open'`-guarded so a write racing the
  judge tick can't mutate a judged arena); `POST /v1/debates/:id/override`
  (steward, 24h window).
- **Web:** source capture + render + a "Sourced" badge on comments
  (`CommentParts`/`CommentNode`).  Sources render **inline as clickable links in
  the comment body itself** (the `.ugc-body a` affordance — click-intercepted by
  `UgcBody`, WS-G.4.2c); legacy "bare" citations with no matching inline link fall
  back to a compact trailing list of `SafeExternalLink`s — there is **no separate
  "Sources" modal**.  The report control is an **icon-only flag** (mirrors the
  story card).  The "Correct" action → `CorrectionComposer`; a "View debate" link
  on `under_debate` comments; the `/stories/$storyId/debate/$debateId` arena
  (`components/debate/DebateArena`) with co-visible positions, countdowns, the
  verdict banner, and the steward override.  Dispute tags render through the
  shared `DisputeBadge`/`DisputeBanner`: **"Challenged"** (`under_debate`),
  **"Incorrect"** (`incorrect`), **"Validated"** (`validated`) — on comments (the
  header), story cards (the rating row), and the story detail page (a banner).

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
  the incumbent author (and everyone else) can reach it to post their 12-hour
  position; the story-comments `overview` reports `debates_count` +
  `incorrect_count`.
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
- The gated Drizzle `debate_arenas` adapter (over migration 0056) is bound at
  production boot and proven by the parameterized `DebateStore` contract test
  (in-memory always; live Postgres under `DATABASE_URL`).

## Residuals

- Multi-process SSE fan-out uses the in-memory broadcaster; a Redis pub/sub
  adapter (the `DebateBroadcaster` port already abstracts this) is the horizontal-
  scale follow-up, mirroring the comment broadcaster.
- Field confirmation of the live stream on physical browsers at scale (the
  headless path — broadcaster fan-out + the SSE route + the client hook — is
  covered).

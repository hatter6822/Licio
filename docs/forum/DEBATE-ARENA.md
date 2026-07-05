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
keeping the 1–5 mandatory-source floor.

**A sourced correction opens a live debate arena** (`debate_arenas`, migration
`0056`; `apps/api/src/forum/debate.ts` + `debate-store.ts`):

| Phase | Duration | What happens |
|-------|----------|--------------|
| `open` | 12h | The **incumbent** (target author) and **challenger** (correction author) post + edit a co-visible position (summary + sources). The client polls, so each sees the other's current draft and offers their strongest case. |
| `awaiting_verdict` → `judged` | — | At the deadline the lease-guarded scheduler (`debate-scheduler.ts`) runs the governed adjudicator; a verdict + the 24h override window are recorded. |
| `judged` | 24h | The room **steward may fully overrule** the verdict either direction (audited, subordinate to the platform floor). |
| `resolved` | — | On `corrected`, the loser is tagged `incorrect`. |

Outcome: `upheld` (incumbent stands), `corrected` (challenger prevails → the
target is tagged `incorrect`), or `inconclusive` (nothing tagged). An
`incorrect` contribution stays **VISIBLE** — an orthogonal `dispute_status`
column, never a `moderation_state` — but sinks to the bottom of its section.
Fail-closed: a blocked/unavailable judge resolves `inconclusive`.

## The AI judge — a governed probabilistic neural model

`@licio/ai-governance` `debate-judge.ts`: a real **MLP (ReLU hidden layer) +
softmax** over *content-structural* features only — independent-domain source
count (weighted over raw link count, anti-gaming), link-safety pass rate, WS-F
source reliability, evidence substance, direct rebuttal. There is **no**
author/topic/viewpoint/wealth feature, so it cannot encode viewpoint preference
(neutrality) and is not a member vote/tally (no-applause).

The *model* is probabilistic + neural; the *shell* is deterministic, auditable,
verifiable: the weights are a **pinned, versioned artifact** (`DEBATE_JUDGE_WEIGHTS`),
the forward pass is pure with a fixed evaluation order (same input ⇒
byte-identical verdict, replayable), and every verdict runs through the WS-K
deploy gate + the pre-execution `ProhibitedUseGuard` and writes an **immutable
`AIOutputRecord`** whose config hash pins the exact weights. Real trained
weights swap into the same artifact behind the same registry/guard machinery —
the WS-K "real backend is a seam" contract.

The WS-U `debate.judge` capability (floor-disjoint, deny-by-default) lets a
governed room route adjudication through its own agent under its law-pack bounds.

## Surfaces

- **API:** `POST /v1/contributions` (a sourced correction opens the arena,
  back-referencing `metadata.debate_arena_id`); `GET /v1/debates/:id`,
  `POST /v1/debates/:id/position` (12h window), `POST /v1/debates/:id/override`
  (steward, 24h window).
- **Web:** source capture + render + a "Sourced" badge on comments
  (`CommentParts`/`CommentNode`); the "Correct" action → `CorrectionComposer`;
  the `/stories/$storyId/debate/$debateId` arena (`components/debate/DebateArena`)
  with co-visible positions, countdowns, the verdict banner, and the steward
  override; "Under debate" / "Incorrect" dispute tags.

## Doctrine

No-applause (no vote/tally/scoreboard anywhere — the outcome is a
content-structural adjudication); neutrality (uniform, content-only features +
`check:neutrality`); no-raw-egress (arena text rides the sanctioned schema
boundary + `UgcBody`); WS-K bounds (deploy gate + prohibited-use guard + output
record); steward power bounded (24h, audited, subordinate to the non-overridable
platform legal floor).

## Residuals

- The comment-level `active_debate_id` projection + the read-time reorder that
  physically sinks an `incorrect` root to the bottom of a paginated section, and
  the story-level feed ranking penalty for a `corrected` story, are tracked
  follow-ups (the `dispute_status` signal is already on the wire + the arena is
  reachable via the correction's `debate_arena_id`).
- Live SSE co-visibility currently rides client polling (the broadcaster port
  exists on the arena service for a later push transport).
- The gated Drizzle adapter for `debate_arenas` (the in-memory store + the
  migration are shipped; production boot binds the Postgres adapter later).

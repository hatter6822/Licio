# WS-U. AI-Governed Rooms — Bounded-Autonomy Redesign (cross-cutting)

**Milestone:** M3 (governance substrate) → M4-M5 (treasury powers) | **Priority:** 3-5 | **Dependencies:** WS-K (model-governance substrate — re-scoped, see below), WS-G/WS-Q (rooms, content visibility, conversation/safety state machine), WS-J (platform trust & safety — becomes the legal floor), WS-L (Knomosis gateway, wallets, Lex bounds), WS-M (treasury, law-packs, proposals), WS-H (invariants — unbiased-facilitation audits), WS-N (jurisdiction/compliance) | **Wave:** 5 (substrate) → 8 (treasury) | **Estimated duration:** staged (see §U.7)

> **Status: DOCTRINE RATIFIED + RUNTIME STAGES 1-3 & 5-core SHIPPED (2026-06-19).** Stage 0
> amended `docs/SPEC.md` (§16.6, §17, §24.1, §24.5, §24.6), the `docs/policy/` register, and the
> WS-K/J/L/M plans. The runtime then landed (rather than reusing WS-K alone, a dedicated
> deterministic domain package was built): the **`@licio/governance`** pure domain (policy DSL,
> proof-carrying kernel, capabilities, election tally), the **`knomosis`** schema + migration
> `0035` (isolation-proven), the **`GovernanceService`** (seat/elections, model admission gate,
> bounded moderation agent **wired into the live contribution path** floor-dominantly, the
> platform-floor **freeze/restore** control, kernel-backed treasury), the **`/v1/rooms/*`** routes + seat
> bootstrap on room create, and the **web surface** (`apps/web/src/components/governance/`):
> the in-room "governed by" transparency panel and the elected-steward propose/ratify
> manager with the member-downloadable proposal registry, both on the room page. The nine
> stores have gated Drizzle adapters bound at boot (migration `0036` adds the vote PK + model
> digest uniqueness). Residuals (Stages 4/6, the steward-election voting UI, doctrine-matrix
> propagation) are tracked in `docs/governance/README.md`. The shipped WS-K
> platform (`@licio/ai-governance` + `apps/api/src/ai-governance` + the `0034` schema + the
> `/v1/ai/*` routes) is **not discarded** — it is re-scoped into the *platform-side*
> evaluation, transparency, lineage, and prohibited-use substrate that every community
> model must pass through (§U.3.2, §U.4).

---

## U.0 Why this document exists

The original doctrine (SPEC §24.1, pre-redesign) held that **AI is never the sole authority
for high-impact moderation and never autonomously spends funds, approves proposals, or issues
final sanctions.** The maintainer has deliberately inverted that posture for *in-room*
governance, while keeping it intact at the *platform* layer. The new model is:

- **Every room has an elected steward** (the room's first member at creation; a Knomosis
  election after one year and each year thereafter). The steward holds **exactly two powers**:
  upload a **community-approved governance/moderation AI model**, and upload the **in-room
  prompt** for that model. Both are *proposals* that take effect only on a Knomosis on-chain
  governance vote of the room's members. Any in-room member can **view and download** the
  approved model and read its prompt.
- **The in-room AI model is a bounded autonomous agent.** Once approved it may **moderate
  users**, **manage the room treasury** (programmatic reports at voted intervals, member
  benefits, voted investment strategy for the *treasury*), and **facilitate in-room lawmaking
  for Knomosis in an unbiased manner** — but every one of those powers executes *within*
  community-voted, **kernel-enforced** bounds, the agent **never holds private keys**, and the
  whole arrangement is **subordinate to a non-overridable platform legal floor**.

This is **bounded autonomy**, not unbounded autonomy. The safety of the design does not rest
on the model behaving well; it rests on a mathematically and cryptographically enforced box
(Knomosis Lex + the proof-carrying kernel), full transparency (the downloadable model + pinned
prompt), accountability (yearly elections), capability sandboxing, and a human platform floor
that no room, steward, model, prompt, or vote can override.

The maintainer's four binding decisions (the design envelope):

| # | Decision | Binding choice |
|---|---|---|
| 1 | **Safety floor** | **Platform legal floor.** Rooms are AI-governed for ordinary in-room matters, but the platform keeps a non-overridable floor for illegal content (CSAM, terrorism, sanctioned actors), legal/compliance duties (mandatory reporting, sanctions, age/jurisdiction gating), and cross-room abuse — operated by **human** platform stewards. |
| 2 | **AI bounds** | **Knomosis-bounded agent.** The AI acts *within* on-chain Knomosis rules the community votes on (voted intervals, spend caps, law definitions). Treasury moves execute through Knomosis contracts within those limits; the AI **never holds raw keys**. Transparency + on-chain bounds + elections are the safety envelope. |
| 3 | **Approval** | **Knomosis on-chain vote.** Model/prompt approval **and** the (first-member-then-yearly) steward election are Knomosis governance votes. |
| 4 | **Deliverable** | **Spec/architecture first.** Redesign the SPEC + doctrine + a revised workstream plan (the authoritative source of truth) and lay out staged, reviewable PRs. Code lands in slices *after* the design is ratified. |

---

## U.0.1 Resolved architectural decisions (ADR)

The four binding decisions above left several hard questions open. They are resolved here (a
second round of maintainer decisions, 2026-06-19) so the implementation has a settled spec.

**ADR-1 — A "model" is a declarative governance-policy bundle, not uploaded weights or code.**
What the steward proposes and members download is a **content-addressed `GovernancePolicyBundle`**:
a versioned, machine-readable document containing (a) a **moderation rule-set** in a small,
total, side-effect-free **policy DSL** (predicates over a room-scoped, structured `ModerationContext`
→ a bounded `ModerationDecision`), (b) **prompt templates** for the natural-language facilitation
surfaces, and (c) **config** (thresholds, cadences, requested capabilities). **No arbitrary code or
model weights execute server-side** — the platform-provided runtime *interprets* the bundle
deterministically. This is the only choice consistent with the sandboxed, fail-closed, deterministic
security doctrine, it makes the agent's behaviour fully reproducible from the downloadable artifact
(the accountability core of §16.6), and it keeps WS-K's "governance, not inference" thesis intact.
A real ML/LLM backend can later back the *advisory* surfaces behind the governed seam (ADR-3); the
*decision* surfaces stay deterministic.

**ADR-2 — Build the Knomosis foundations as a deterministic in-process kernel behind a seam.**
Stages 4-6 need the Knomosis gateway/treasury that WS-L/M have not built. Rather than fake crypto or
defer, the platform ships a **real, deterministic, in-process `GovernanceKernel`** that implements the
proof-carrying *semantics*: an action is accepted **iff** it carries machine-checkable evidence it
satisfies the room's `LawPack` preconditions (caps, intervals, categories, timelocks, COI), and the
kernel returns a typed `Verdict` with that evidence or a typed rejection. The same `KnomosisGateway`
**port** the kernel implements is the seam the real Lean/Solidity/Rust deployment plugs into later
(the WS-L v0.4 `POST /v1/actions` contract). This is production logic, not throwaway: the law-pack
interpreter, the bounded-execution semantics, the reconciliation, and the firewall all stay valid when
the real kernel swaps in. Everything financial remains behind the **fail-closed crypto flag**; with the
flag off, the treasury surface and the agent's treasury powers do not exist.

**ADR-3 — Natural-language work uses a governed provider port; the default is deterministic.**
`SummaryProvider`/`TranslationProvider`/`ExplanationProvider` are governed ports (the WS-K pattern).
The shipped default is **deterministic and templated** (no external calls, no secrets, unit-testable);
a real LLM can be configured behind the same audited interface later. **Moderation *decisions* never
use a non-deterministic provider** — they are pure policy-DSL evaluation — so the 80% deterministic-test
gate and reproducibility hold regardless of provider config.

**ADR-4 — The agent is a bounded *executor role*, never a key holder (the "no keys, still autonomous"
resolution).** Routine treasury moves do not require a human to sign each one — that is the point of
bounded autonomy — yet the agent holds no keys. The resolution: treasury authority lives in a
**policy-bounded executor**. In the deterministic kernel (now) the executor is the kernel itself,
which accepts an agent-submitted action only with a valid law-pack-compliance proof. In the real
deployment (later) the executor is a **smart-contract account / multisig with on-chain spend policy +
timelock**, where the agent holds a **capability-scoped executor role** (bounded by the on-chain
law-pack), **not** a private key; the *bound-changing* keys stay with a human multisig, and
material/irregular actions still trip the timelock + challenge window (§17.6). So: humans hold keys
and set bounds; the agent executes **within** those bounds without a key; the kernel/contract — not the
model — enforces them.

**ADR-5 — Prompt injection is defeated by enforcing capabilities *outside* the model.** Room content is
**untrusted input**. The model's output is never an instruction the runtime obeys — it is a *request*
the runtime validates against the **capability descriptor** and the **law-pack** before any effect.
The model cannot grant itself a capability, exceed a cap, reach a floor-reserved action, or move value
by being "convinced," because none of those are gated by the model's text — they are gated by the
runtime/kernel. Moderation *decisions* are deterministic policy-DSL evaluation, not free-text
obedience, so injected "ignore your rules" content has no decision channel. The advisory NL surfaces
(summaries) are clearly labelled, cited, deterministic, and contestable, and they carry **no**
authority. The §24.2 red-team admission gate includes an injection-resistance suite.

**ADR-6 — Cost and DoS are bounded.** The deterministic interpreter is O(policy size · context size)
and cheap. The agent runs **event-driven** (on the existing WS-E contribution/governance consumers),
never per-keystroke, with **per-room invocation budgets** layered on the existing identity-free
global fixed-window limiter (SPEC §19.1) — no per-IP state. The optional LLM seam (ADR-3), when
enabled, carries its own per-room call budget and a fail-closed circuit breaker. Forcing expensive
agent runs is rate-limited per room, not per identity.

**ADR-7 — Election legitimacy is quorum-gated and fail-safe.** The `LawPack` carries a
`minQuorum` and `minTurnout`. A single-member room auto-confirms its sole member (no contest). Below
quorum/turnout, the **incumbent (or bootstrap holder) continues** — a failed election never vacates
the seat (fail-safe), and the platform floor can always remove a captured/abandoned seat. The default
weight model is one-civic-account-one-vote with the §17.5 per-account cap; the tie-break is
incumbent, then earliest-eligible account.

**ADR-8 — "Unbiased lawmaking" is structural for the *tally*, mitigated for *framing*.** The kernel —
not the agent — computes quorum/threshold/weight/tally, so the **outcome** is structurally
agent-independent (the agent has no vote/tally/weight capability). The agent does draft the summaries
members read, which is a residual **framing** channel; this is **mitigated, not eliminated**, by
determinism + mandatory citations + member-editability + the bias-audit on summary outputs + the
`machine-generated` label. We state this honestly rather than overclaiming total neutrality.

---

## U.1 The three-layer authority model

Authority over a room is partitioned into three layers, ordered by precedence. A higher layer
is **always** able to act over a lower one; a lower layer can **never** override a higher one.

```
Layer 3 — Platform legal floor          (human platform stewards; non-overridable)
   ▲  illegal content · legal/compliance duties · cross-room abuse · appeals of last resort
   │  enforced by: WS-J console + the WS-I non-overridable safety filter + fail-closed crypto
   │               flag + WS-D.3.2 wallet↔ranking isolation. Cannot be reinstated-over by any room.
   │
Layer 2 — Knomosis-bounded in-room AI agent   (autonomous WITHIN community-voted Lex bounds)
   ▲  in-room moderation · treasury management · unbiased lawmaking facilitation
   │  enforced by: the proof-carrying Knomosis kernel (legality-as-a-type) + capability sandbox
   │               + the WS-K evaluation/prohibited-use gate + no key custody + transparency.
   │
Layer 1 — Room sovereignty             (the community + its elected steward)
      the elected steward proposes a model + prompt; the members approve them by Knomosis vote;
      any member may view/download the model and read the prompt; fork/exit preserved.
```

**Layer 1 — Room sovereignty.** The community owns its governance. The elected steward is a
*nominator*, not a ruler: their only levers are the model and the prompt, and even those bind
nothing until the members ratify them by a Knomosis vote. Transparency (download the model,
read the prompt) plus fork/exit rights mean a community that dislikes how it is governed can
elect a new steward, vote in a different model/prompt, or fork the room.

**Layer 2 — The Knomosis-bounded AI agent.** Once a model + prompt are approved, they become
the room's governance agent (§U.3). The agent has broad operational powers, but each one runs
*through* Knomosis within the community's voted law-pack. The bounds are enforced by the kernel
(every accepted state transition carries machine-checkable proof it satisfies the law-pack
preconditions), not by the model's good intentions. The agent submits **signed actions** to the
knomosis-gateway and **never holds private keys**.

**Layer 3 — The platform legal floor.** A small, fixed set of duties is reserved to **human**
platform stewards and can never be overridden by any room, steward, model, prompt, or vote
(§U.5). This is exactly SPEC §17.1 boundary 5 ("No DAO supremacy over safety") and the five
platform steward roles (§16.3) — *reframed* as the floor. It is the same non-overridable
mechanism the ranking pipeline already has.

---

## U.2 The elected room steward (Layer 1)

**Seat.** Every room has exactly **one** steward seat. It is a per-room governance role,
**distinct** from the five platform steward roles in §16.3 (which are cross-room and operate
the platform floor — see §U.5). To avoid colliding with the gate-validated `ROLE_*` namespace,
the seat is identified as `ELECTED_ROOM_STEWARD` (no `ROLE_` prefix; it is not one of the five
platform roles).

**Bootstrap.** At room creation the seat is held by the room's **first member** (the creator).
This is a fail-safe default that needs no election and no quorum: a brand-new room has exactly
one member, who is trivially its steward.

**Term and election.** The term is **one year**. At term end (and yearly thereafter) a
**steward election** is held as a **Knomosis governance vote** of the room's members
(decision #3). The election uses the room's voted weight model and anti-capture controls
(SPEC §17.5; one-civic-account-one-vote for small rooms by default). In **simulated** governance
mode the vote is an off-chain tally on the Knomosis governance primitive (no real assets, no
jurisdiction gate); in **testnet/capped/mature** modes it is the corresponding on-chain vote.
The incumbent may stand again. A vacated seat (steward departs, is removed by the platform floor,
or loses quorum) falls back to the longest-tenured active member until the next election, and
the room reverts to the **platform moderation baseline** (§U.3.5) in the interim.

**The two powers (and only these two).** The steward may:

1. **Propose a community model** — upload a governance/moderation AI **model artifact**
   (content-addressed, hash-pinned, reproducible) for the room. The proposal carries the model
   card (reusing the WS-K model-card schema) and must pass the **platform evaluation gate**
   (§U.4) before it is even *eligible* to be voted on.
2. **Propose the in-room prompt** — upload the **prompt** that conditions the approved model for
   this room's law-pack and norms.

Neither power takes effect on the steward's say-so. **Both require a Knomosis on-chain
governance vote of the room's members to be adopted** (decision #3). The steward has **no**
direct moderation, treasury, or lawmaking authority — those belong to the *approved agent*
(Layer 2), bounded by the *members' votes*, never to the steward personally. This is the
critical anti-capture property: capturing the steward seat grants only agenda-setting (the
right to *propose* a model/prompt), not rule — and agenda-setting is itself checked by the
yearly election and the members' ratifying vote.

**Transparency (the accountability core).** The approved model is **viewable and downloadable
by any in-room member**, and the prompt is in-room-readable, reusing the WS-Q content-visibility
bar (a member of the room passes the read bar; the artifact is served as content-addressed,
integrity-verified bytes). Because the model + prompt are reproducible, any member can run them
locally and verify that the live agent's behavior matches what was approved, and can fork them
under the room's fork/exit right (SPEC §17.5). Transparency is what makes "community-approved"
meaningful.

---

## U.3 The in-room AI agent (Layer 2)

Once a model + prompt are approved by member vote, the room's **AI agent** is the loaded
`(model, prompt, law-pack)` triple executed by a sandboxed, capability-scoped runtime. It has
three power domains, each bounded.

### U.3.1 User moderation (universal; no funds required)

The agent classifies, warns, limits, removes, and restores **in-room** content and applies
**in-room** sanctions, **strictly within the room's law-pack** (the community-voted categories,
thresholds, escalation ladder, and appeal path). Every moderation action:

- drives the existing **§15.4 conversation/safety state machine** through its audited, legal
  transitions (it does not invent new states), emitting the same `thread.state.changed` /
  contribution-safety events the human console emits;
- is **logged, explainable, and appealable** — the same statement-of-reasons + appeal inbox
  the WS-J user-safety surface already ships, with the agent as the actor of record and the
  model/version/prompt-hash on the audit row;
- is **subordinate to the platform floor** — the agent can never reinstate content the floor
  removed, never act on floor-reserved categories (§U.5), and the floor can always override the
  agent and act on the room.

In-room moderation is **universal**: any room (ordinary, pre-crypto) may adopt an elected
steward + community model and run AI moderation in **simulated** governance mode. It needs no
treasury, no real funds, and no jurisdiction gate, so it does **not** depend on the crypto
feature flag.

### U.3.2 Treasury management (gated by Knomosis-enablement + crypto flag + jurisdiction)

The agent **proposes and submits** treasury actions — programmatic transparency/financial
**reports at community-voted intervals**, **member benefits/distributions**, **grants/bounties**,
and a community-**voted investment strategy for the room treasury** (e.g. "hold 60% stablecoin /
40% ETH, rebalance monthly," within voted caps). Every treasury move:

- executes **through Knomosis contracts within the voted law-pack bounds** — spend caps, voted
  intervals, allowed categories, timelocks, COI rules. The **proof-carrying kernel** accepts an
  action only with machine-checkable proof it satisfies the law-pack preconditions, so a
  misbehaving or adversarial model **cannot** exceed a cap, change an interval, or spend outside
  an allowed category — the kernel rejects the transition regardless of what the model "wants";
- is submitted as a **signed action to the knomosis-gateway** (WS-L.3) by the runtime; **the
  agent never holds private keys** (decision #2). Execution authority lives in the room's
  multisig/contract + timelock, not in the model;
- is **firewalled from ranking** exactly as every other treasury action is (§U.6): the consumer
  router refuses Knomosis topics to ranking/PWAtt consumers, the WS-I.2.1b financial denylist
  rejects financial terms at every feature write, the wallet↔ranking schema isolation
  (WS-D.3.2) has no join path, and the standing-read seam (WS-L.3.6a) is governance-only.

Treasury powers are **gated**: they exist only in **Knomosis-enabled** rooms
(simulated → testnet → capped → mature, SPEC §17.4), behind the **fail-closed crypto flag** and
the **jurisdiction engine** (WS-N), and subject to every WS-M/WS-N production gate (legal
sign-off, custody, AML/sanctions, external audit). When the crypto flag is off — the default —
the treasury surface does not exist and the agent has no treasury powers at all.

> **The privacy/anti-manipulation distinction that is preserved.** The agent may execute a
> community-voted investment strategy *for the room treasury* (a transparent, capped, on-chain,
> collective decision). It may **not** give *individual users* personalized financial or
> investment advice, **profile** a user's wealth or financial vulnerability, or use wallet
> wealth to personalize anyone's feed. Those remain **prohibited** (SPEC §24.5; §U.5). "Manage
> the room's treasury within voted bounds" and "advise/profile individuals" are different acts;
> the redesign permits the first and keeps the second forbidden.

### U.3.3 Unbiased facilitation of in-room lawmaking (Knomosis)

The agent **facilitates** the process by which members propose, deliberate, and vote on in-room
laws (Knomosis Lex rules and law-pack amendments). It drafts **neutral, plain-language**
proposal summaries, surfaces missing budget/citation/recipient fields, runs law-pack/preflight
validation, schedules votes at the community-voted cadence, and tallies/attests outcomes for the
public audit log.

**Unbiased "by construction," not "by promise."** Neutrality is enforced structurally, not
asserted:

- **The kernel runs the vote, not the AI.** Quorum, threshold, weight, and tally are
  **kernel-computed** from the law-pack (SPEC §17.5). The facilitation capability is scoped so
  the agent has **no** vote, **no** tally authority, and **no** weight-assignment power — it
  literally cannot bias an outcome it does not compute.
- **Deterministic, reproducible facilitation outputs.** The summary path is deterministic:
  pinned model + pinned prompt + fixed seed ⇒ reproducible output. Any member can re-run the
  downloadable model on the proposal and confirm the summary they were shown.
- **Mandatory citations + contestability.** Every AI proposal summary cites the proposal fields
  it draws from, flags material uncertainty, carries the `machine-generated` label, and is
  editable/contestable by members and the steward (SPEC §24.5 final clause, preserved).
- **Platform bias audits as admission control.** Before a model is *eligible* for adoption, the
  WS-K evaluation harness runs the **two-proportion z-test bias audit**, the hallucination/
  factuality suite, the safety/privacy suite, and the red-team suite on its facilitation and
  moderation behavior (§U.4); WS-H invariants (MFCI for synchronized voting, SCOI for
  lens-divergent proposals, GWEI for disproportionate exposure) monitor the live process.

### U.3.4 The capability sandbox (how Layer 2 is contained)

The runtime that executes the agent is **capability-scoped** and **sandboxed**:

- **No ambient authority.** The agent can invoke only the tools its law-pack grants it: the
  in-room moderation port (§U.3.1), the gateway action-submission port (§U.3.2, signed actions
  only — no keys), and the summary/translation generators (§U.3.3). Everything else is denied by
  default (the WS-K prohibited-use guard becomes the bounded-capability enforcer).
- **No network egress, no key access, no out-of-room data.** The sandbox has no outbound network,
  no access to private keys or wallet seeds, and no read access to anything beyond the room's
  own scope (no cross-room data, no platform attention ledgers, no reporter identities, no
  minors' data, no private_p2p plaintext — the WS-K server-hosted-content boundary is preserved).
- **Deterministic where it matters.** Moderation explanations and lawmaking summaries are
  deterministic and reproducible; non-determinism is confined to advisory drafts a human/member
  can edit.
- **Admission control + runtime monitoring.** A model runs only after passing the §U.4 gate;
  the WS-K runtime monitor watches for drift and can recommend rollback; the platform floor can
  freeze any room's agent instantly (the kill-switch / `room-governance-freeze`, `ROLE_INTEGRITY`).

### U.3.5 Fallback (no approved model)

Until a room has a community-approved model + prompt (the steward has not proposed one, or the
members rejected the proposal), the room runs on the **platform moderation baseline** — the
existing WS-J automated pre-checks + human stewardship + the platform floor. A room is *eligible*
for AI governance, never *forced* into it. This is fail-safe and consistent with the gradual
rollout: AI governance is opt-in per room, ratified per room, and revocable per room (vote out
the model, or the platform floor freezes it).

---

## U.4 The platform evaluation / transparency substrate (re-scoped WS-K)

The shipped WS-K platform is **reused**, not discarded. Its responsibility shifts from
"govern the *platform's own* AI models" to "be the **platform-side admission gate and
transparency substrate** for **community-uploaded** room models." A community model is
**ineligible for adoption** until it clears this substrate:

| WS-K asset (shipped) | Re-scoped role in WS-U |
|---|---|
| Model registry + model card (`InMemoryModelRegistryStore`, `0034` schema) | The **room-model registry**: content-addressed, hash-pinned, version-tracked community models; the in-room view/download surface reads from it. |
| Evaluation harness — bias (two-proportion z-test), hallucination, safety/privacy, red-team | The **admission gate**: a community model must pass every suite (on the room's law-pack fixtures + the platform's floor-safety fixtures) before it is *eligible* to be voted on. A model that fails the safety/red-team suite can never be adopted, no matter how the room votes. |
| Prohibited-use guard | The **bounded-capability enforcer**: the runtime's deny-by-default capability descriptor (§U.3.4); it structurally prevents the agent from taking floor-reserved or out-of-capability actions. |
| Data-lineage + `AiOutputRecord` + correction stores | The **audit + provenance substrate**: model/version/prompt-hash + input/output refs on every agent action; the human/member correction loop; the lineage of any data the model was tuned on. |
| `AiLabel` provenance badge (web) | The in-room **`machine-generated` / `AI-facilitated` label** on agent outputs (summaries, moderation notices, reports). |
| `ai.model.manage` RBAC capability | Retained for **platform** model operations; the **per-room** adopt/propose path is the elected-steward + member-vote flow (not an RBAC grant). |

The substrate is what makes the maintainer's "community-approved model" both **safe** (it cannot
be adopted until it passes platform safety/red-team evaluation) and **transparent** (the exact
bytes that govern the room are registered, hash-pinned, and downloadable).

---

## U.5 The platform legal floor (Layer 3) — non-overridable

A fixed, narrow set of duties is reserved to **human** platform stewards (the five §16.3
`ROLE_*` roles, operating cross-room) and is **non-overridable** by any room, steward, model,
prompt, or vote. The floor is decision #1, and it is the existing SPEC §17.1 boundary 5
reframed and made load-bearing.

**Floor-reserved duties.**

1. **Illegal content** — CSAM, terrorism/violent-extremist content, dealings with sanctioned
   actors, and other categorically illegal material. The agent has **no capability** to reinstate
   or shield it; the floor removes it over any room model.
2. **Legal/compliance duties** — mandatory reporting (e.g. NCMEC), sanctions screening, lawful
   orders, age/jurisdiction gating, and the securities/AML/KYC gates on financial features. These
   run **above** every room and are never delegated to a room model.
3. **Cross-room abuse** — coordinated raids, platform-wide manipulation, ban evasion, and
   integrity attacks spanning rooms. The per-room agent acts only on **in-room** matters; the
   floor (`ROLE_INTEGRITY`, MFCI) owns the cross-room surface.
4. **Appeals of last resort** — a platform appeals path (`ROLE_APPEALS`) independent of the room
   and its model. Every agent moderation action is appealable to the floor.

**How the floor is structurally enforced (not by promise).**

- The **non-overridable safety filter** the ranking pipeline already runs (WS-I `safety-filter.ts`,
  the WS-J seam) sits above all room output; room governance cannot remove a platform safety
  state.
- The **capability sandbox** (§U.3.4) gives the agent **no** capability for any floor-reserved
  action; a maliciously-voted model still cannot, e.g., suppress a mandatory CSAM report — there
  is no tool for it to call.
- The **admission gate** (§U.4) refuses to make a model *eligible* if it fails the platform
  floor-safety fixtures, so an adversarial community cannot vote in a model that breaches the
  floor — the model never becomes eligible to be voted on.
- The **fail-closed crypto flag** + **wallet↔ranking isolation** keep the financial plane sealed
  off from ranking regardless of any room's agent.
- The platform retains the **freeze** powers (`room-governance-freeze`, `treasury-freeze` with
  counsel co-approval) to halt any room's agent instantly.

---

## U.6 The safety envelope and the preserved firewalls

**The safety envelope (why bounded autonomy is safe).** The design's safety does **not** depend
on the model being benign. It is the conjunction of:

1. **On-chain bounds (Knomosis Lex + the proof-carrying kernel).** The agent is autonomous only
   inside a box the kernel enforces by construction: every accepted transition carries a
   machine-checkable proof it satisfies the community-voted preconditions. Caps, intervals,
   categories, timelocks, and COI rules are kernel-enforced, not model-enforced.
2. **No key custody.** The agent submits signed actions; private keys live in the room
   multisig/contract + timelock. The model cannot move value on its own.
3. **Transparency.** The model and prompt are hash-pinned and downloadable by every member;
   behavior is reproducible and auditable.
4. **Elections.** The steward who nominates the model/prompt is accountable via yearly Knomosis
   election; members can replace the steward, the model, or the prompt.
5. **Capability sandboxing + admission control.** Deny-by-default capabilities; a model runs only
   after passing the platform evaluation/red-team gate; runtime drift monitoring.
6. **The platform legal floor.** Non-overridable human authority over illegality, compliance, and
   cross-room abuse.

**The pay-to-rank firewall is preserved in full.** The in-room AI agent manages treasury and
moderation but **nothing it does can touch organic ranking.** Every existing firewall stays
exactly as-is:

- **(a)** the fail-closed crypto feature flag (`cryptoEnabled` defaults false; treasury powers
  vanish when off);
- **(b)** the consumer router that **refuses Knomosis topics to any PWAtt/ranking consumer**
  (the agent's treasury/governance events are Knomosis-topic events and never reach ranking);
- **(c)** the WS-I.2.1b **financial denylist** pinned to the shared WS-A term list, asserted at
  every feature-store write;
- **(d)** the WS-D.3.2 **wallet↔ranking schema isolation** (separate `wallet`/`knomosis`
  pgSchemas, single `user_id` FK edge, CI-proven no-join-path);
- **(e)** the WS-L.3.6a **firewalled standing-read seam** (governance-only; never a ranking input).

The agent is firewalled from ranking exactly as the treasury is. `pnpm check:neutrality` (the ten
WS-I.3 tests) continues to gate every PR.

**Adversarial-community threat model (worked).**

| Threat | Why the design holds |
|---|---|
| A room votes in a model that refuses to remove illegal content | The model fails the §U.4 floor-safety/red-team gate → ineligible to be voted on; and the platform floor (§U.5) removes illegal content over any room regardless. |
| A captured steward uploads a self-dealing model | The steward only *proposes*; members must ratify by Knomosis vote; treasury self-dealing is bounded by kernel-enforced caps/COI; the yearly election removes the steward; transparency exposes the model. |
| The agent tries to overspend / change a voted interval | The proof-carrying kernel rejects any transition lacking a proof it satisfies the law-pack preconditions; the agent holds no keys. |
| The agent biases a vote it "oversees" | The kernel computes quorum/threshold/tally, not the agent; the facilitation capability has no vote/tally/weight authority; summaries are deterministic, cited, and contestable. |
| Treasury activity leaks into ranking | Firewalls (a)–(e) above; the agent's financial events are Knomosis-topic and router-refused to ranking; neutrality suite gates CI. |
| The agent profiles individual wealth / advises individuals | No capability for it (sandbox); SPEC §24.5 keeps individual financial advice + wealth profiling + wallet-personalized feeds **prohibited**; the financial denylist + wallet isolation block the data path. |

---

## U.7 Staged implementation (reviewable PRs)

Each stage is a coherent slice that passes `pnpm typecheck`, `pnpm lint`, `pnpm test`, and the
doctrine gates (`check:policy`, `check:neutrality`, `check:no-applause`, `check:no-raw-egress`,
`check:workspace-deps`, `check:deps`). Stages are landed in order; later stages are gated by the
fail-closed crypto flag until their production gates (WS-M/WS-N) clear.

> **Scope decision (ADR-2).** Per the maintainer's second-round decision, Stages 4-6 are built **now**
> on a **deterministic, in-process `GovernanceKernel`** (the new `@licio/governance` package) that
> implements the proof-carrying law-pack semantics behind the `KnomosisGateway` port the real
> WS-L/M deployment plugs into later. The kernel is production logic (law-pack interpreter,
> bounded-execution, reconciliation, firewall), not throwaway; everything financial stays behind the
> fail-closed crypto flag. This lifts the "blocked on unbuilt WS-L/M/N" constraint for the *semantics*
> while leaving real on-chain custody to WS-L/M.

- **Stage 0 — Doctrine ratification (this PR; docs-only).** SPEC §16.6/§17/§24 edits, the
  `docs/policy/` reframing, this charter, and the WS-K/J/L/M plan amendments. No runtime code;
  all gates green. *Acceptance:* maintainer review of the redesign.

- **Stage 1 — Room steward seat + election lifecycle (simulated).** Schema `room_steward_seat`
  (`room_id` PK, `holder_user_id`, `term_start`, `term_end`, `bootstrap` flag) and
  `steward_election` (lifecycle: open → tally → settle) in the **`knomosis` bounded context**
  (isolated from ranking). Bootstrap = creator; one-year term; election as a **simulated**
  Knomosis governance vote (off-chain tally, no crypto flag, no jurisdiction gate). The two-power
  *surface* (propose-model, propose-prompt) exists but adopts nothing yet. *Acceptance:* seat
  bootstraps on room create; election opens at term end; isolation test extended.

- **Stage 2 — Community model + prompt transparency registry (reuse WS-K).** Extend the WS-K
  registry for **room-scoped, community-uploaded** models + prompts: content-addressed artifact,
  the in-room view/download surface (WS-Q visibility bar), the **platform evaluation gate** as
  adoption admission control, and the model+prompt **approval vote** (simulated Knomosis). The
  prohibited-use guard becomes the capability descriptor. *Acceptance:* a model must pass
  bias/safety/red-team before it is votable; members can download an adopted model; approval is a
  recorded vote.

- **Stage 3 — The bounded AI-agent runtime: moderation only (no funds).** A sandboxed,
  capability-scoped runtime that loads `(model, prompt, law-pack)` and runs **in-room moderation**
  through the §15.4 state machine + WS-G/WS-J ports — logged, explainable, appealable to the floor,
  subordinate to the floor. Capability sandbox (no egress, no keys, no out-of-room data),
  deterministic explanations, neutrality/bias deployment audit, runtime drift monitor, and the
  platform freeze. **Universal** (ordinary rooms, simulated governance, crypto flag still false).
  *Acceptance:* the agent cannot take a floor-reserved action (no capability); every action is on
  the audit log with model/version/prompt-hash; the floor overrides it.

- **Stage 4 — Knomosis Lex binding + lawmaking facilitation (testnet).** Bind the room law-pack
  to community-voted **Lex** rules; the agent facilitates lawmaking (neutral summaries, field
  validation, vote scheduling, attestation) with the **kernel** computing quorum/threshold/tally.
  Testnet only; no real funds. *Acceptance:* the facilitation capability has no vote/tally/weight
  authority (structural); summaries are deterministic + cited + contestable; MFCI/SCOI/GWEI watch
  the live process.

- **Stage 5 — AI-executed treasury within Knomosis bounds (capped production; gated).** The agent
  submits **signed** treasury actions (voted-interval reports, member benefits, voted investment
  strategy) to the knomosis-gateway; the proof-carrying kernel enforces caps/intervals/categories/
  timelocks/COI; **the agent holds no keys**. Gated by the crypto flag + jurisdiction + every
  WS-M/WS-N production gate (legal sign-off, custody, AML/sanctions, external audit). Pay-to-rank
  firewall fully preserved. *Acceptance:* reconciliation zero-or-explained; the agent cannot
  exceed a cap or spend off-category (kernel-rejected); neutrality suite green.

- **Stage 6 — On-chain elections + maturity.** Steward election + model/prompt approval as
  **on-chain** Knomosis votes (mature mode), full SPEC §17.5 anti-capture controls, fork/exit.
  *Acceptance:* the WS-M.4 anti-capture suite; the §17.11 production-gate checklist.

---

## U.8 Cross-cutting amendments to existing workstreams

- **WS-K (`12-ai-governance.md`) — re-scoped.** From "platform AI model governance" to the
  **platform admission/transparency substrate** for community room models (§U.4). The shipped
  registry/evaluation/guard/lineage/label surface is retained and repointed; the new per-room
  adopt path (elected steward + member vote) is added. No shipped capability is removed.

- **WS-J (`11-trust-and-safety.md`) — becomes the platform legal floor.** The five §16.3 roles +
  the WS-J console are reframed as Layer 3 (§U.5): non-overridable illegal-content / compliance /
  cross-room-abuse authority and **appeals of last resort** over every room agent. New: agent
  moderation actions flow into the same statement-of-reasons + appeal inbox with the model as
  actor of record; the floor's freeze halts a room agent.

- **WS-L (`13-knomosis-and-wallets.md`) — Lex bounds + non-key-holding agent submission.** New:
  the room law-pack ↔ Knomosis **Lex** binding (the voted bounds the kernel enforces); the agent
  runtime as a **signed-action submitter** to the gateway (`POST /v1/actions`) that **never holds
  keys**; the standing-read seam stays governance-only. All existing WS-L invariants
  (crypto-behind-flags, fail-closed, schema isolation, no-blind-signing, no-key-custody,
  reorg/reconciliation) are inherited unchanged.

- **WS-M (`14-treasury-and-governance.md`) — AI-executed treasury + elected steward + Knomosis-vote
  approval.** New: the **elected room steward** seat + election (§U.2); **model/prompt approval as
  a governance proposal type**; the agent as the **executor** of voted-interval reports, member
  benefits, and the voted **treasury** investment strategy — all within kernel-enforced law-pack
  caps. The seven WS-M invariants (crypto-behind-flags, no-commingling, **platform-moderation
  supremacy**, **no-pay-to-rank**, no-on-chain-sensitive-data, reconciliation-zero-or-explained,
  server-hosted-rooms-only) are inherited unchanged — and "platform-moderation supremacy" is now
  the explicit Layer-3 floor.

---

## U.9 SPEC ratification map

The canonical doctrine for this redesign lives in `docs/SPEC.md`; this charter is the synthesis
+ staged plan. Stage 0 lands these SPEC edits:

| SPEC section | Edit |
|---|---|
| §16.3 | One framing sentence: the five roles are the **platform-wide (cross-room)** stewards forming the non-overridable floor (§U.5); the per-room elected steward is §16.6. *(Table unchanged — gate set-equality preserved.)* |
| §16.5 | The Knomosis-readiness checklist gains the elected-steward seat + the community-model transparency/evaluation requirement. |
| §16.6 *(new)* | **The elected room steward and in-room AI governance** — the seat, the bootstrap-then-yearly election (Knomosis vote), the two powers, model/prompt transparency, and the pointer to §24.6. |
| §17.1 | Boundary 5 kept verbatim and elevated to "the platform legal floor"; a sentence clarifying bounded in-room autonomy sits *within* boundaries 1/4/5. |
| §17.3.3 / §17.4 / §17.5 / §17.6 | Reframed so the **approved agent** is the executor/facilitator within voted bounds and the kernel/multisig hold authority; permitted/prohibited governance actions unchanged in substance. |
| §24.1 | **Inverted** to bounded autonomy: platform-layer AI stays non-autonomous; in-room a community-approved, downloadable agent may moderate, manage treasury, and facilitate lawmaking **within kernel-enforced bounds, subordinate to the floor, holding no keys.** |
| §24.2 | Adds community-model transparency (downloadable, hash-pinned) + the platform evaluation/admission gate to the responsible-AI requirements. |
| §24.5 | **Inverted** for treasury *execution within bounds*; keeps prohibited: individual financial advice, wealth profiling, wallet-personalized feeds, manipulative vote recommendations, risk-hiding rewrites. |
| §24.6 *(new)* | **The in-room AI governance agent** — the three power domains, the capability sandbox, the safety envelope, the preserved firewalls, and the fallback. |

---

# Part II — Atomic task decomposition (the staged PRs as cards)

The six staged PRs of §U.7 decompose into the atomic task cards below, in the house format
(**ID**, **Ref**, description, acceptance criteria, testing, dependencies; data-bearing cards
carry the authoritative Drizzle/zod shape and API request/response shapes). Each card is a single
deliverable that passes the full gate suite (`pnpm typecheck`/`lint`/`test` + `check:policy`,
`check:neutrality`, `check:no-applause`, `check:no-raw-egress`, `check:workspace-deps`,
`check:deps`). Cards are dependency-ordered; everything in the Knomosis bounded context lives in
the `knomosis` pgSchema (isolated from ranking), and every treasury power (WS-U.5) is gated by the
fail-closed crypto flag.

**Bounded-context placement.** The new entities (`room_steward_seat`, `steward_election`,
`steward_governance_vote`, `room_governance_model`, `room_governance_prompt`, `room_agent_binding`,
`agent_action_log`) live in the `knomosis` bounded context (SPEC §21.5), physically and logically
separated from feed ranking and ordinary social analytics, and the WS-D.3.2 schema-isolation test
is extended to each. They reference `room`/`user` by id (the established WS-M pattern) but never
join to ranking/attention tables.

**Card count.** WS-U decomposes into **49 atomic cards** across the six stages (U.1: 11, U.2: 9,
U.3: 11, U.4: 6, U.5: 8, U.6: 4).

**Migrations.** The seven new entities are added by Drizzle migrations starting at **`0035`**
(the latest shipped is `0034_ws_k_ai_governance`), each online-safe (expand → backfill → contract
where a column is added to a populated table), all in the `knomosis` pgSchema, and each followed by
the WS-D.3.2 isolation-walk extension in the same PR.

### Cross-cutting requirements (every WS-U card inherits these)

Reviewers must reject any card that weakens one of these. They are the runtime form of the §U.6
safety envelope and are inherited from WS-J/L/M.

1. **Bounded autonomy, never unbounded.** Every agent power runs within the kernel-enforced
   law-pack; no treasury or governance action executes without machine-checkable proof it satisfies
   the law-pack preconditions (SPEC §17.6, §24.6).
2. **Platform-legal-floor supremacy.** No agent, steward, model, prompt, or vote can countermand a
   platform safety action; the agent has *no capability* for any floor-reserved act (SPEC §17.1
   boundary 5; WS-U.3.6a).
3. **No key custody.** The agent never holds, requests, stores, logs, or recovers private keys or
   seed phrases; it submits signed actions only (SPEC §17.3.1; WS-L; WS-U.5.1a).
4. **No pay-to-rank.** The agent is firewalled from ranking exactly as the treasury is — crypto flag,
   consumer-router Knomosis refusal, financial denylist, wallet↔ranking isolation, governance-only
   standing read (SPEC §17.1 boundary 1, §17.9, §30.6; WS-U.5.4a).
5. **Fail-closed crypto + jurisdiction.** All treasury behavior is gated; flag off / unknown
   jurisdiction ⇒ the surface and the agent's treasury powers do not exist (SPEC §17.10, §17.11;
   WS-U.5.6a). In-room *moderation* needs no crypto flag.
6. **Schema isolation.** Every new `knomosis`-context entity is proven to have no FK/view join path
   to any ranking/attention table by the extended WS-D.3.2 walk (WS-U.1.5a and per-table thereafter).
7. **Transparency + reproducibility.** The model and prompt are hash-pinned and member-downloadable;
   moderation explanations and lawmaking summaries are deterministic and reproducible from the
   downloadable artifacts (SPEC §16.6, §24.6).
8. **Appealability + human floor.** Every agent action is appealable to the human platform floor and
   reversible through the §15.4 machine; the floor can freeze any agent instantly (WS-U.3.3a/3.3b).
9. **Auditability.** Every agent action emits an append-only `agent_action_log` row with the
   provenance triple (`model`/`version`/`prompt_hash`), the law-pack rule, and a statement of reasons
   (WS-U.3.2b).
10. **Accessibility + no applause.** All surfaces meet WCAG 2.2 AA and pass `check:no-applause`
    (governance votes are governance controls, never reactions/karma).

---

## WS-U.1 Room steward seat and election lifecycle (Stage 1; simulated)

Establishes the per-room elected-steward seat (§16.6), bootstrapped to the creator and re-elected
yearly via a **simulated** (off-chain tally) Knomosis governance vote. No AI, no treasury, no
crypto flag. The two-power *surface* exists but adopts nothing (that is WS-U.2).

### WS-U.1.1a `room_steward_seat` schema
**ID:** WS-U.1.1a **Ref:** SPEC §16.6 **Depends on:** WS-Q.1 (rooms), WS-D.1 (users), WS-M.1.1a (knomosis schema)

**Description.** Define the single-seat-per-room steward record in the `knomosis` bounded context.

```ts
export const roomStewardSeat = knomosisSchema.table('room_steward_seat', {
  roomId: uuid('room_id').primaryKey().references(() => room.roomId),
  holderUserId: uuid('holder_user_id').notNull().references(() => user.userId),
  termStart: timestamptz('term_start').notNull().defaultNow(),
  termEnd: timestamptz('term_end').notNull(),               // termStart + 1 year (WS-U.1.2b)
  bootstrap: boolean('bootstrap').notNull().default(true),  // true until the first election settles
  currentElectionId: uuid('current_election_id'),           // nullable; set while an election is open
  updatedAt: timestamptz('updated_at').notNull().defaultNow(),
});
```
zod mirror `roomStewardSeatSchema` in `@licio/shared` (`schemas/governance/steward-seat.ts`).

**Acceptance.** Exactly one row per room; `holder_user_id` always set (fail-safe — never a
vacant seat without a fallback holder); `term_end > term_start`; the table carries no FK or view
path to any ranking/attention table.
**Testing.** zod round-trip; a unit test asserts the one-row-per-room PK and the CHECK
`term_end > term_start`; the WS-D.3.2 isolation walk includes `room_steward_seat`.

### WS-U.1.1b `steward_election` schema + lifecycle state machine
**ID:** WS-U.1.1b **Ref:** SPEC §16.6, §17.5 **Depends on:** WS-U.1.1a

**Description.** The election record and its table-driven legal-transition machine.

```ts
export const stewardElectionStatus = pgEnum('steward_election_status',
  ['scheduled', 'open', 'tallying', 'settled', 'cancelled']);

export const stewardElection = knomosisSchema.table('steward_election', {
  electionId: uuid('election_id').primaryKey().defaultRandom(),
  roomId: uuid('room_id').notNull().references(() => room.roomId),
  status: stewardElectionStatus('status').notNull().default('scheduled'),
  opensAt: timestamptz('opens_at').notNull(),
  closesAt: timestamptz('closes_at').notNull(),
  weightModel: text('weight_model').notNull(),   // SPEC §17.5 model id; default 'one_civic_account_one_vote'
  winnerUserId: uuid('winner_user_id').references(() => user.userId),  // null until settled
  tally: jsonb('tally'),                          // settled snapshot: per-candidate weights (audit)
  mode: text('mode').notNull().default('simulated'),  // simulated | testnet | onchain
  createdAt: timestamptz('created_at').notNull().defaultNow(),
  settledAt: timestamptz('settled_at'),
});
```
Legal transitions (audited, append-only event): `scheduled → open → tallying → settled`; any
non-terminal → `cancelled`. Illegal transitions are rejected at the service boundary (the WS-G
table-driven pattern).

**Acceptance.** Only legal transitions persist; a settled election has a non-null `winner_user_id`
and `tally`; `closes_at > opens_at`.
**Testing.** Property test over the transition table (every illegal edge rejected); isolation walk
includes `steward_election`.

### WS-U.1.1c `steward_governance_vote` schema (simulated ballot store)
**ID:** WS-U.1.1c **Ref:** SPEC §16.6, §17.5 **Depends on:** WS-U.1.1b

**Description.** The off-chain ballot store used **only** in `simulated` mode (in testnet/onchain
modes the kernel is the tally authority and this store is not written). One ballot per voter per
election; stores the candidate choice and the computed weight, never any attention/ranking signal.

```ts
export const stewardGovernanceVote = knomosisSchema.table('steward_governance_vote', {
  electionId: uuid('election_id').notNull().references(() => stewardElection.electionId),
  voterUserId: uuid('voter_user_id').notNull().references(() => user.userId),
  candidateUserId: uuid('candidate_user_id').notNull().references(() => user.userId),
  weight: numeric('weight').notNull(),     // from the weight model; capped per anti-capture (§17.5)
  castAt: timestamptz('cast_at').notNull().defaultNow(),
}, (t) => ({ pk: primaryKey({ columns: [t.electionId, t.voterUserId] }) }));
```

**Acceptance.** One ballot per `(election, voter)`; `weight` derives from the election's
`weight_model` and respects the per-account cap; the table has no ranking join path.
**Testing.** Duplicate-ballot rejection; weight-cap enforcement; isolation walk inclusion.

### WS-U.1.2a Seat bootstrap on room creation
**ID:** WS-U.1.2a **Ref:** SPEC §16.6 **Depends on:** WS-U.1.1a, WS-Q.1

**Description.** On room creation, transactionally insert a `room_steward_seat` with
`holder_user_id = creator`, `bootstrap = true`, `term_end = now + 1 year`. Idempotent with the
room-create transaction (one seat or none, never partial).

**Acceptance.** Every newly-created room has exactly one seat held by its creator; re-running
create does not duplicate the seat.
**Testing.** Integration test: create room → seat exists, creator holds it, `bootstrap=true`.

### WS-U.1.2b Term tracking + election-due detection
**ID:** WS-U.1.2b **Ref:** SPEC §16.6 **Depends on:** WS-U.1.1a, WS-U.1.1b

**Description.** A lease-guarded hourly tick (reusing the WS-M/WS-L scheduler pattern) detects
seats whose `term_end <= now` with no open election and **schedules** one (`status='scheduled'`,
`opens_at`, `closes_at`). Fail-closed: if the tick cannot read state, it schedules nothing.

**Acceptance.** A seat past term with no open election gets exactly one scheduled election per
tick; an already-open/scheduled election is not duplicated.
**Testing.** Time-travel unit test (term in the past → one scheduled election; idempotent across
ticks).

### WS-U.1.3a Simulated Knomosis governance-vote primitive
**ID:** WS-U.1.3a **Ref:** SPEC §16.6, §17.5 **Depends on:** WS-U.1.1c

**Description.** The off-chain tally for `simulated` mode: given an election's ballots and weight
model, compute the winner deterministically (documented tie-break: incumbent, then earliest
account). This is the simulated stand-in for the kernel tally; the **interface** is identical so
testnet/onchain swap the kernel in behind it without changing callers.

**Acceptance.** Deterministic winner for a given ballot set; tie-break documented and tested;
the tally snapshot is reproducible.
**Testing.** Property test: permuting ballot insertion order yields the same winner; tie-break
cases.

### WS-U.1.3b Election open → tally → settle service + audit
**ID:** WS-U.1.3b **Ref:** SPEC §16.6 **Depends on:** WS-U.1.1b, WS-U.1.3a

**Description.** The service that opens a scheduled election at `opens_at`, closes voting at
`closes_at`, runs the tally (WS-U.1.3a in simulated mode), writes `winner_user_id`+`tally`,
transitions to `settled`, updates the seat (`holder_user_id = winner`, `bootstrap=false`, new
`term_*`), and emits an audited governance event.

**Acceptance.** A full lifecycle moves the seat to the winner and resets the term; every
transition is on the audit log; a cancelled election leaves the seat unchanged.
**Testing.** End-to-end lifecycle integration test; audit-row assertions.

### WS-U.1.4a Two-power proposal surface (records intent; adopts nothing)
**ID:** WS-U.1.4a **Ref:** SPEC §16.6 **Depends on:** WS-U.1.1a

**Description.** Expose the steward's two powers as **proposal intents** only: `propose-model` and
`propose-prompt` record a pending proposal (subject of the WS-U.2 approval vote) but change no
runtime behavior yet. Authorization: only the current seat holder may submit; everyone else is
rejected. No platform `ROLE_*` capability is involved.

**Acceptance.** Only the seat holder can submit a proposal intent; submission adopts nothing
(no agent runs); a non-holder is rejected.
**Testing.** Authz unit test (holder allowed, non-holder rejected); a test asserting no
moderation/treasury behavior changes.

### WS-U.1.5a Schema-isolation test extension
**ID:** WS-U.1.5a **Ref:** SPEC §17.1 boundary 1, §22.2; WS-D.3.2 **Depends on:** WS-U.1.1a-c

**Description.** Extend the WS-D.3.2 BFS isolation walk so the new governance tables are proven to
have **no** FK/view join path to any ranking/attention table — the pay-to-rank firewall covers the
steward/election plane.

**Acceptance.** The isolation test enumerates `room_steward_seat`, `steward_election`,
`steward_governance_vote` and finds no path to ranking; CI fails if a future migration adds one.
**Testing.** The extended isolation walk runs in CI (the existing gated DB test).

### WS-U.1.6a Seat/election API + wire contracts
**ID:** WS-U.1.6a **Ref:** SPEC §16.6, §23.2 **Depends on:** WS-U.1.1a-c, WS-U.1.3b

**Description.** `GET /v1/rooms/:roomId/steward` (seat + current election), `GET
/v1/rooms/:roomId/elections`, and `POST /v1/rooms/:roomId/elections/:id/vote` (simulated ballot;
auth + room-membership gated). zod request/response in `@licio/shared`. Reads pass the WS-Q room
visibility bar.

**Acceptance.** Endpoints validate through zod; voting is membership-gated and idempotent per
`(election, voter)`; financial/wallet fields never appear in any response.
**Testing.** Route tests (happy path, non-member rejected, double-vote idempotent).

### WS-U.1.7a Web steward panel (read-only)
**ID:** WS-U.1.7a **Ref:** SPEC §16.6, §26 **Depends on:** WS-U.1.6a

**Description.** A room-settings panel showing the current steward, term window, and any open
election (with a member ballot affordance in simulated mode). No applause primitives; WCAG 2.2 AA;
zod-validated TanStack Query reads. Passes `check:no-applause`.

**Acceptance.** Panel renders seat + election; the ballot affordance is a governance control, not
an applause/reaction; axe-clean.
**Testing.** Component test + an `check:no-applause` pass (it is a governance vote, not a reaction).

## WS-U.2 Community model + prompt transparency registry (Stage 2; reuse WS-K)

Extends the shipped WS-K registry so a steward-proposed, member-ratified model + prompt become a
content-addressed, member-downloadable, evaluation-gated artifact set.

### WS-U.2.1a `room_governance_model` schema (content-addressed)
**ID:** WS-U.2.1a **Ref:** SPEC §16.6, §24.2 **Depends on:** WS-K.1.1b (registry), WS-U.1.4a

**Description.** A room-scoped model artifact record extending the WS-K registry: the
content-addressed digest (the hash-pinned bytes), the WS-K model card, the proposing steward, and
the lifecycle status. The bytes themselves live in the existing upload/object store (scan-gated,
WS-G.4.4 / WS-Q media pipeline); this row is the governance handle.

```ts
export const roomModelStatus = pgEnum('room_model_status',
  ['proposed', 'evaluating', 'eligible', 'rejected', 'approved', 'superseded']);

export const roomGovernanceModel = knomosisSchema.table('room_governance_model', {
  modelId: uuid('model_id').primaryKey().defaultRandom(),
  roomId: uuid('room_id').notNull().references(() => room.roomId),
  artifactDigest: text('artifact_digest').notNull(),     // sha-256 of the model bytes (hash-pin)
  cardRef: uuid('card_ref').notNull(),                   // WS-K model-card registry id
  proposedByUserId: uuid('proposed_by_user_id').notNull().references(() => user.userId),
  status: roomModelStatus('status').notNull().default('proposed'),
  evaluationRef: uuid('evaluation_ref'),                 // WS-K evaluation decision (WS-U.2.2a)
  createdAt: timestamptz('created_at').notNull().defaultNow(),
}, (t) => ({ digestUniq: unique().on(t.roomId, t.artifactDigest) }));
```

**Acceptance.** A proposal is only `proposed` by the current seat holder; the `(room, digest)` pair
is unique; old versions are retained (`superseded`, never deleted); no ranking join path.
**Testing.** zod round-trip; seat-holder-only insertion; isolation walk inclusion.

### WS-U.2.1b `room_governance_prompt` schema (hash-pinned)
**ID:** WS-U.2.1b **Ref:** SPEC §16.6, §24.2 **Depends on:** WS-U.2.1a

**Description.** The in-room prompt artifact, hash-pinned and bound to a specific model proposal, so
the approved `(model, prompt)` pair is a single reproducible unit.

```ts
export const roomGovernancePrompt = knomosisSchema.table('room_governance_prompt', {
  promptId: uuid('prompt_id').primaryKey().defaultRandom(),
  roomId: uuid('room_id').notNull().references(() => room.roomId),
  modelId: uuid('model_id').notNull().references(() => roomGovernanceModel.modelId),
  promptDigest: text('prompt_digest').notNull(),         // sha-256 of the prompt text
  promptText: text('prompt_text').notNull(),             // in-room-readable
  proposedByUserId: uuid('proposed_by_user_id').notNull().references(() => user.userId),
  createdAt: timestamptz('created_at').notNull().defaultNow(),
});
```

**Acceptance.** A prompt is bound to a model proposal; `prompt_digest` matches `promptText`;
seat-holder-only insertion.
**Testing.** Digest-matches-text property; binding integrity; isolation walk inclusion.

### WS-U.2.2a Platform evaluation admission gate
**ID:** WS-U.2.2a **Ref:** SPEC §24.2, §24.6; §U.4 **Depends on:** WS-K.1.2 (harness), WS-U.2.1a

**Description.** Before a model becomes `eligible` (votable), run the WS-K evaluation harness on it
over (a) the room's law-pack fixtures and (b) the **platform floor-safety fixtures** (illegal-content
refusal, floor-reserved-category refusal, no-key-handling, no-out-of-room-data). A failing safety or
red-team suite forces `rejected` (a model that fails can never be adopted, regardless of the vote).
The decision is the existing WS-K `EvaluationDecision`; `evaluation_ref` records it.

**Acceptance.** A model that fails safety/red-team transitions `evaluating → rejected` and cannot be
voted on; a passing model transitions to `eligible`; the decision is reproducible.
**Testing.** Harness integration with a deliberately-failing safety fixture (→ rejected) and a
passing one (→ eligible); reproducibility of the decision.

### WS-U.2.2b Community model-card requirement
**ID:** WS-U.2.2b **Ref:** SPEC §24.2 **Depends on:** WS-K.1.1a, WS-U.2.1a

**Description.** A proposal is rejected at submission unless it carries a complete WS-K model card
(owner, version, purpose, training-data summary, known failure modes, data-lineage refs). Mirrors
the WS-K deployment-gate completeness check.

**Acceptance.** An incomplete card blocks the proposal with a typed error naming the missing fields.
**Testing.** Card-completeness unit test (missing-field cases enumerated).

### WS-U.2.3a In-room view/download surface
**ID:** WS-U.2.3a **Ref:** SPEC §16.6, §24.2 **Depends on:** WS-U.2.1a-b, WS-Q (visibility bar)

**Description.** Any room member may view the model card and **download** the hash-pinned model
bytes and read the prompt, served through the WS-Q content-visibility bar with integrity
verification (the served digest equals the pin). Non-members are barred by the same read bar.

**Acceptance.** A member downloads bytes whose digest matches the pin; a non-member is denied; a
digest mismatch fails closed.
**Testing.** Download integrity test (digest match); read-bar denial for non-members.

### WS-U.2.4a Model+prompt approval vote → adoption
**ID:** WS-U.2.4a **Ref:** SPEC §16.6, §17.3.3, §17.5 **Depends on:** WS-U.1.3a, WS-U.2.2a

**Description.** Adoption requires a member Knomosis governance vote (simulated tally in Stage 2) on
an `eligible (model, prompt)` pair. On approval, mark the model `approved` and create a **pending**
`room_agent_binding` (the runtime that consumes it is WS-U.3 — adoption changes no behavior until
the runtime ships). Reuses the WS-U.1.3a vote primitive.

```ts
export const roomAgentBinding = knomosisSchema.table('room_agent_binding', {
  roomId: uuid('room_id').primaryKey().references(() => room.roomId),
  modelId: uuid('model_id').notNull().references(() => roomGovernanceModel.modelId),
  promptId: uuid('prompt_id').notNull().references(() => roomGovernancePrompt.promptId),
  lawPackId: uuid('law_pack_id'),                 // bound in WS-U.4; nullable for moderation-only
  approvedByElectionId: uuid('approved_by_election_id').notNull(),
  capabilityDescriptorRef: uuid('capability_descriptor_ref'),  // WS-U.2.4b
  active: boolean('active').notNull().default(false),  // the runtime flips this (WS-U.3)
  approvedAt: timestamptz('approved_at').notNull().defaultNow(),
});
```

**Acceptance.** Only an `eligible` pair can be voted on; approval creates one pending binding per
room (latest wins, prior superseded); a rejected/ineligible model cannot be approved.
**Testing.** Approval-flow integration; ineligible-model rejection; one-binding-per-room invariant.

### WS-U.2.4b Prohibited-use guard → capability descriptor
**ID:** WS-U.2.4b **Ref:** SPEC §24.6 (sandbox); §U.3.4 **Depends on:** WS-K.1.1d (guard), WS-U.2.4a

**Description.** Derive the runtime **capability descriptor** (deny-by-default tool allow-list:
moderation port, gateway signed-action submitter, summary/translation generators) from the WS-K
prohibited-use guard + the room law-pack. Floor-reserved actions are structurally absent.

**Acceptance.** The descriptor grants only law-pack-permitted tools; no floor-reserved capability can
appear; the descriptor is content-addressed and bound to the approval.
**Testing.** A test asserting a law-pack that "tries" to grant a floor-reserved capability yields a
descriptor without it.

### WS-U.2.5a Provenance + lineage for adopted models
**ID:** WS-U.2.5a **Ref:** SPEC §24.2 **Depends on:** WS-K.1.1e/1.1f, WS-U.2.4a

**Description.** On adoption, write the WS-K data-lineage + provenance records so every later agent
action traces to `model_name`/`model_version`/`prompt_hash` and the approving election.

**Acceptance.** An adopted binding has resolvable lineage; agent actions (WS-U.3) carry the
provenance triple.
**Testing.** Lineage-resolution unit test.

### WS-U.2.6a Model-governance API + web surface
**ID:** WS-U.2.6a **Ref:** SPEC §16.6, §23.2 **Depends on:** WS-U.2.1a-2.5a

**Description.** `POST /v1/rooms/:roomId/governance/models` (propose; seat-holder), `GET …/models`
(list + eval status + download links), `POST …/models/:id/approve-vote` (member ballot). Web: the
steward proposal flow, the member review/download/vote surface, and the AI provenance label. zod
contracts; no applause primitives; axe-clean.

**Acceptance.** End-to-end propose → evaluate → download → approve in simulated mode; financial
fields never surfaced; passes `check:no-applause`.
**Testing.** Route + component tests; BFF-in-the-loop spec for the propose/vote flow.

## WS-U.3 Bounded AI-agent runtime — moderation only (Stage 3; no funds)

The sandboxed, capability-scoped runtime that loads an approved binding and runs in-room moderation
through the §15.4 state machine, subordinate to the platform floor. Universal (ordinary rooms,
simulated governance, crypto flag off).

### WS-U.3.1a Capability-scoped sandbox runtime
**ID:** WS-U.3.1a **Ref:** SPEC §24.6 (sandbox) **Depends on:** WS-U.2.4b

**Description.** A runtime that executes the agent with **no ambient authority**: deny-by-default
tools from the capability descriptor, **no outbound network egress, no key/seed access, no read
access beyond the room scope** (no cross-room data, no attention ledgers, no reporter identities, no
minors' data, no `private_p2p` plaintext). Deterministic where required.

**Acceptance.** The runtime cannot call a tool absent from the descriptor; an egress/key/out-of-room
access attempt is denied and audited.
**Testing.** Sandbox unit tests for each denial (egress, key, cross-room read); determinism check.

### WS-U.3.1b Agent loader + admission check
**ID:** WS-U.3.1b **Ref:** SPEC §24.2, §24.6 **Depends on:** WS-U.3.1a, WS-U.2.2a

**Description.** Load the `(model, prompt, law-pack)` triple for a room's active binding; refuse to
load a model whose evaluation is not `eligible/approved` or whose digests do not match the pins.
Flips `room_agent_binding.active = true` only on a clean load.

**Acceptance.** A binding with a failing/stale evaluation or a digest mismatch does not load
(fail-closed); a clean binding activates.
**Testing.** Load-refusal cases; activation on clean load.

### WS-U.3.2a In-room moderation port (§15.4 state machine)
**ID:** WS-U.3.2a **Ref:** SPEC §15.4, §18.2, §24.6 **Depends on:** WS-U.3.1b, WS-G (state machine)

**Description.** The agent's moderation actions drive the existing §15.4 conversation/safety state
machine through its **legal** transitions only, emitting the same `thread.state.changed` /
contribution-safety events the human console emits. No new states; no bypass of WS-G validation.

**Acceptance.** Agent moderation produces identical events/states to a human steward action; an
illegal transition is rejected.
**Testing.** Parity test (agent vs. console action → same state/events); illegal-transition rejection.

### WS-U.3.2b Agent action audit log
**ID:** WS-U.3.2b **Ref:** SPEC §24.2, §16.4 **Depends on:** WS-U.3.2a, WS-U.2.5a

**Description.** Every agent action writes an append-only audit row with the provenance triple
(`model`/`version`/`prompt_hash`), the law-pack rule applied, a statement of reasons, and the
reversibility flag — the agent as actor of record.

```ts
export const agentActionLog = knomosisSchema.table('agent_action_log', {
  actionId: uuid('action_id').primaryKey().defaultRandom(),
  roomId: uuid('room_id').notNull().references(() => room.roomId),
  bindingModelId: uuid('binding_model_id').notNull(),
  promptHash: text('prompt_hash').notNull(),
  actionType: text('action_type').notNull(),     // moderation/treasury/lawmaking verb
  subjectRef: text('subject_ref').notNull(),
  lawPackRuleRef: text('law_pack_rule_ref'),
  statementOfReasons: text('statement_of_reasons').notNull(),
  reversible: boolean('reversible').notNull(),
  createdAt: timestamptz('created_at').notNull().defaultNow(),
});
```

**Acceptance.** Every agent action has exactly one audit row with the provenance triple; rows are
append-only; no financial/wallet field leaks into moderation rows.
**Testing.** Audit-completeness test; append-only enforcement; isolation walk inclusion.

### WS-U.3.3a Appeal routing to the platform floor
**ID:** WS-U.3.3a **Ref:** SPEC §24.6, §16.4; §U.5 **Depends on:** WS-J.1 (appeals), WS-U.3.2b

**Description.** Every agent moderation action is appealable to the human platform floor via the
**existing** WS-J statement-of-reasons + appeal inbox, with the agent as actor of record. An upheld
appeal reverses the agent action through the §15.4 machine.

**Acceptance.** A user can appeal an agent action; an upheld appeal reverses it; the floor decision
is independent of the room.
**Testing.** Appeal-flow integration (agent action → appeal → reversal).

### WS-U.3.3b Floor override + agent-freeze control
**ID:** WS-U.3.3b **Ref:** SPEC §16.3, §17.1 boundary 5, §24.6 **Depends on:** WS-J.2 (console), WS-U.3.1b

**Description.** `ROLE_SAFETY` can remove content over any room model; `ROLE_INTEGRITY` can
`room-governance-freeze` a room's agent (deactivates the binding instantly, fail-closed). The agent
cannot reinstate floor-removed content.

**Acceptance.** A freeze deactivates the agent immediately; the agent cannot un-remove a
floor-removed item; the freeze is audited.
**Testing.** Freeze integration (agent stops acting); reinstatement-attempt rejection.

### WS-U.3.4a Deterministic moderation explanations
**ID:** WS-U.3.4a **Ref:** SPEC §24.6 **Depends on:** WS-U.3.2a

**Description.** Moderation explanations are deterministic and reproducible (pinned model + prompt +
seed ⇒ same explanation), so a member can reproduce them from the downloadable artifacts.

**Acceptance.** Identical inputs produce identical explanations across runs.
**Testing.** Determinism property test.

### WS-U.3.5a Neutrality/bias deployment audit (moderation)
**ID:** WS-U.3.5a **Ref:** SPEC §24.2, §24.6 **Depends on:** WS-K.1.2 (bias audit), WS-U.3.2a

**Description.** Before a binding activates, run the WS-K two-proportion-z bias audit on the model's
moderation behavior across protected cohorts (synthetic fixtures); a failing disparity blocks
activation.

**Acceptance.** A model with a significant moderation disparity cannot activate; a clean one can.
**Testing.** Bias-audit integration (failing + passing cohorts).

### WS-U.3.5b Runtime drift monitor + rollback recommendation
**ID:** WS-U.3.5b **Ref:** SPEC §24.2 **Depends on:** WS-K.1.2f (runtime monitor), WS-U.3.2b

**Description.** Reuse the WS-K runtime monitor over agent action streams (action-rate,
appeal-overturn, report-rate drift) to raise alerts and a **human-approved** rollback recommendation
(never autonomous rollback).

**Acceptance.** A drift threshold raises an alert + recommendation; rollback requires human approval.
**Testing.** Drift-threshold unit test; no-autonomous-rollback assertion.

### WS-U.3.6a Floor-reserved-category structural guard
**ID:** WS-U.3.6a **Ref:** SPEC §17.1 boundary 5, §24.6; §U.5 **Depends on:** WS-U.3.1a

**Description.** A structural test (not a runtime promise) that the agent has **no capability** for
any floor-reserved action (suppressing a mandatory report, acting cross-room, handling keys,
reinstating illegal content) — the capability descriptor cannot express them.

**Acceptance.** For every floor-reserved action, the descriptor offers no tool; the test fails CI if
a future change adds one.
**Testing.** Enumerated floor-reserved-action absence test in CI.

### WS-U.3.7a Web "governed by" panel + appeal affordance
**ID:** WS-U.3.7a **Ref:** SPEC §16.6, §26 **Depends on:** WS-U.3.2b, WS-U.3.3a

**Description.** An in-room panel showing the active model/prompt (with download), recent agent
actions (statements of reasons), and the appeal affordance routing to the floor. No applause
primitives; WCAG 2.2 AA.

**Acceptance.** The panel shows the active binding + actions + appeal entry; axe-clean; passes
`check:no-applause`.
**Testing.** Component test; BFF spec for view-action → appeal.

## WS-U.4 Knomosis Lex binding + lawmaking facilitation (Stage 4; testnet)

Binds the room law-pack to community-voted Lex rules and lets the agent **facilitate** lawmaking
while the kernel computes the vote.

### WS-U.4.1a Room law-pack ↔ Knomosis Lex binding
**ID:** WS-U.4.1a **Ref:** SPEC §17.3.4, §17.2 **Depends on:** WS-M (law-pack registry), WS-L (gateway)

**Description.** Bind a room's law-pack (allowed proposal types, caps, intervals, categories,
timelocks, COI, quorum/threshold/weight) to a Knomosis **Lex** definition the kernel enforces;
`room_agent_binding.law_pack_id` references it. Testnet mode.

**Acceptance.** A binding's law-pack resolves to a Lex definition; the kernel enforces it; mismatch
fails closed.
**Testing.** Binding-resolution test; fail-closed on unparseable Lex.

### WS-U.4.2a Facilitation capability (no vote/tally/weight authority)
**ID:** WS-U.4.2a **Ref:** SPEC §17.4, §17.5, §24.6 **Depends on:** WS-U.3.1a, WS-U.4.1a

**Description.** Grant the agent a **facilitation** capability: draft neutral summaries, validate
proposal fields, schedule votes at the voted cadence, attest outcomes. The capability descriptor
structurally **excludes** vote casting, tally computation, and weight assignment (kernel functions).

**Acceptance.** The facilitation capability cannot cast a vote, compute a tally, or assign weight.
**Testing.** Structural test: no vote/tally/weight tool in the facilitation descriptor.

### WS-U.4.2b Deterministic, cited, contestable summaries
**ID:** WS-U.4.2b **Ref:** SPEC §24.3, §24.5, §24.6 **Depends on:** WS-K.1.4 (summary gate), WS-U.4.2a

**Description.** Lawmaking summaries pass the WS-K §24.3 quality/grounding gate, cite the proposal
fields, carry the `machine-generated` label, are deterministic, and are editable/contestable by
members and the steward.

**Acceptance.** A summary cites fields, is reproducible, is labeled, and is editable; an
ungrounded/uncited summary is blocked.
**Testing.** Summary-gate integration; determinism; contestability path.

### WS-U.4.3a Kernel-computed quorum/threshold/tally integration
**ID:** WS-U.4.3a **Ref:** SPEC §17.5, §24.6 **Depends on:** WS-L (gateway), WS-U.4.1a

**Description.** Voting/attestation and execution are computed by the Knomosis kernel from the Lex
law-pack; the agent only schedules and reports. The agent never writes a tally.

**Acceptance.** The recorded tally originates from the kernel/gateway, not the agent.
**Testing.** Provenance assertion on the tally source; the WS-U.4.2a structural test covers absence.

### WS-U.4.4a MFCI/SCOI/GWEI live-process monitors
**ID:** WS-U.4.4a **Ref:** SPEC §17.5, §17.9 **Depends on:** WS-H (invariants)

**Description.** Wire MFCI (synchronized voting/proposal floods), SCOI (lens-divergent proposals),
and GWEI (disproportionate exposure) onto the lawmaking process as monitors — flagging, never
deciding the vote.

**Acceptance.** A synchronized-voting fixture raises an MFCI flag; flags inform stewards/floor,
never the tally.
**Testing.** Invariant-monitor integration with synthetic coordination fixtures.

### WS-U.4.5a Structural-neutrality test (gate)
**ID:** WS-U.4.5a **Ref:** SPEC §17.5, §24.6 **Depends on:** WS-U.4.2a, WS-U.4.3a

**Description.** A named CI test proving the facilitation path cannot reach vote/tally/weight — the
"unbiased by construction" property — analogous to `check:neutrality` for ranking.

**Acceptance.** The test fails if any code path lets the agent compute or influence the tally.
**Testing.** The neutrality test runs in CI as a named gate.

## WS-U.5 AI-executed treasury within Knomosis bounds (Stage 5; capped production, gated)

The agent submits **signed** treasury actions to the gateway within kernel-enforced bounds, holding
no keys. Gated by the fail-closed crypto flag + jurisdiction + the WS-M/WS-N production gates.

### WS-U.5.1a Signed-action submitter (no keys)
**ID:** WS-U.5.1a **Ref:** SPEC §17.6, §24.6; WS-L.3 **Depends on:** WS-L (gateway `POST /v1/actions`)

**Description.** The runtime port that submits the agent's treasury intents as **signed actions** to
the knomosis-gateway. Signing material lives in the room multisig/contract; the agent assembles the
action and submits, **never holding, requesting, storing, or recovering keys** (WS-L no-key-custody
invariant, log-redacted).

**Acceptance.** The agent never touches key material (the WS-L no-key-custody test extended to this
path); a submission carries a valid idempotency key + anti-replay nonce.
**Testing.** No-key-custody assertion; idempotency/replay test.

### WS-U.5.2a Voted-interval programmatic reports
**ID:** WS-U.5.2a **Ref:** SPEC §17.6, §24.6 **Depends on:** WS-U.5.1a

**Description.** The agent publishes transparency/financial reports at the community-voted cadence
(from the Lex law-pack), as audited public-ledger entries.

**Acceptance.** Reports fire at the voted interval; cadence changes require a member vote; each
report is on the public audit log.
**Testing.** Cadence integration (interval respected; off-cadence blocked).

### WS-U.5.2b Member benefits/distributions within caps
**ID:** WS-U.5.2b **Ref:** SPEC §17.6, §24.5, §24.6 **Depends on:** WS-U.5.1a

**Description.** The agent submits member benefit/distribution actions within the law-pack caps and
COI rules. These are **collective** treasury actions, never individualized financial advice.

**Acceptance.** A distribution within caps executes; one exceeding a cap is kernel-rejected; no
per-user financial advice/profiling occurs.
**Testing.** Cap-boundary test (within passes, over rejected); a no-individual-advice assertion.

### WS-U.5.2c Community-voted treasury investment strategy
**ID:** WS-U.5.2c **Ref:** SPEC §17.6, §24.5, §24.6 **Depends on:** WS-U.5.1a, WS-U.4.1a

**Description.** The agent executes a community-**voted** investment strategy for the **room
treasury** (allocation + rebalance cadence) within Lex caps/categories. Room-treasury scope only;
never personal portfolios.

**Acceptance.** Rebalance actions stay within voted allocation bands and caps; out-of-band actions
are kernel-rejected; scope is the room treasury alone.
**Testing.** Allocation-band test; scope assertion (no per-user assets touched).

### WS-U.5.3a Kernel-enforced bounds proof
**ID:** WS-U.5.3a **Ref:** SPEC §17.6, §24.6 **Depends on:** WS-L (kernel), WS-U.5.1a

**Description.** Every treasury action carries (or is rejected absent) machine-checkable proof it
satisfies the law-pack preconditions (caps/intervals/categories/timelocks/COI). The agent cannot
move value without a passing proof.

**Acceptance.** An action lacking a valid proof is rejected by the kernel/gateway; the agent has no
override path.
**Testing.** Proof-absent rejection; no-override assertion.

### WS-U.5.4a Pay-to-rank firewall over agent financial events
**ID:** WS-U.5.4a **Ref:** SPEC §17.1 boundary 1, §17.9, §30.6 **Depends on:** WS-I (router/denylist), WS-U.5.1a

**Description.** Extend the WS-I.3 neutrality suite so the agent's treasury/governance events
(Knomosis-topic) are proven router-refused to ranking/PWAtt consumers and rejected by the financial
denylist at every feature write — the agent is firewalled exactly as the treasury is.

**Acceptance.** `check:neutrality` covers the agent's financial event paths and stays green; a
deliberately-misrouted agent event is caught.
**Testing.** The extended neutrality suite (named CI gate) including the agent leg.

### WS-U.5.5a Reconciliation (zero-or-explained) for agent actions
**ID:** WS-U.5.5a **Ref:** SPEC §17.6, §28.3 **Depends on:** WS-L.3.4 (reconciliation), WS-U.5.1a

**Description.** Agent treasury actions reconcile across product DB / Knomosis receipts / chain to a
zero or explained gap before any cap/mode expansion (WS-M invariant 6 applied to agent actions).

**Acceptance.** A divergence opens an explained-gap case and blocks expansion; convergence permits it.
**Testing.** Reconciliation integration (induced divergence → case; convergence → pass).

### WS-U.5.6a Crypto-flag + jurisdiction gating (fail-closed)
**ID:** WS-U.5.6a **Ref:** SPEC §17.10, §17.11; WS-N **Depends on:** WS-N (jurisdiction), WS-C.1.3 (flags)

**Description.** All WS-U.5 treasury behavior is gated by the fail-closed crypto flag + jurisdiction
engine; flag off / unknown jurisdiction ⇒ the treasury surface and agent treasury powers do not
exist. Links to the WS-M/WS-N production-gate checklist (legal sign-off, custody, AML/sanctions,
audit).

**Acceptance.** Flag off ⇒ no treasury power (the agent runs moderation/lawmaking only); unknown
jurisdiction ⇒ fail-closed; the production-gate checklist is enforced before capped mode.
**Testing.** Flag-off and unknown-jurisdiction fail-closed tests; checklist-presence assertion.

## WS-U.6 On-chain elections + maturity (Stage 6)

Promotes governance votes on-chain and applies full anti-capture + production maturity.

### WS-U.6.1a On-chain steward election + model/prompt approval
**ID:** WS-U.6.1a **Ref:** SPEC §16.6, §17.5, §17.11 **Depends on:** WS-U.1.3b, WS-U.2.4a, WS-L (mature)

**Description.** In `mature` mode, the steward election and the model/prompt approval vote run as
**on-chain** Knomosis governance votes (the kernel is the tally authority; the simulated primitive is
retired for these rooms).

**Acceptance.** Mature-mode votes are kernel-tallied on-chain; the simulated tally is not used;
results reconcile.
**Testing.** Mature-mode lifecycle integration against the testnet/pinned deployment.

### WS-U.6.2a Full §17.5 anti-capture controls on elections
**ID:** WS-U.6.2a **Ref:** SPEC §17.5 **Depends on:** WS-U.6.1a, WS-M.4 (anti-capture)

**Description.** Apply the SPEC §17.5 anti-capture suite to steward elections (max weight per
account/cluster, eligibility age/history, MFCI synchronized-vote monitoring, COI, cooling-off,
fork/exit, emergency-freeze).

**Acceptance.** The anti-capture controls bind steward elections; a synchronized-capture fixture is
delayed/flagged per MFCI-2.
**Testing.** Anti-capture suite over the election path.

### WS-U.6.3a Governance-model fork/exit
**ID:** WS-U.6.3a **Ref:** SPEC §17.5, §16.6 **Depends on:** WS-U.2.3a (download), WS-U.6.1a

**Description.** A room (or a seceding subset) can fork the governance model+prompt (the downloadable
artifacts) and exit under the room fork/exit right, preserving the audit trail.

**Acceptance.** A fork produces an independent room with the forked artifacts; the original audit
trail is preserved.
**Testing.** Fork/exit integration.

### WS-U.6.4a Production-gate checklist for AI-governed treasury rooms
**ID:** WS-U.6.4a **Ref:** SPEC §17.11 **Depends on:** WS-U.5.6a, WS-M/WS-N production gates

**Description.** Bind the §17.11 real-funds production-gate checklist (legal sign-off, custody,
AML/fraud/sanctions, external audit, reconciliation/DR, monitoring, approved charters) as the
admission condition for an AI-governed room to enter `capped/mature` treasury mode.

**Acceptance.** No AI-governed room enters capped/mature treasury mode without the full checklist;
the gate is auditable.
**Testing.** Checklist-completeness gate test.

---

## Definition of done (WS-U)

WS-U is complete when:

- **Steward + elections.** Every room has a steward seat (creator-bootstrapped); the one-year term
  triggers a Knomosis election; the simulated lifecycle (open → tally → settle) moves the seat to the
  winner with a full audit trail (WS-U.1).
- **Transparent, evaluated models.** A steward can propose a model + prompt; a model is votable only
  after passing the platform bias/hallucination/safety/red-team gate on room + floor-safety fixtures;
  any member can download the hash-pinned model and read the prompt; adoption is a recorded member
  vote (WS-U.2).
- **Bounded moderation agent.** The sandboxed agent moderates within the law-pack through the §15.4
  machine — parity with the human console — logged with the provenance triple, appealable to the
  floor, freezable by the floor, with **no capability** for any floor-reserved act (the
  floor-capability-absence test is a green CI gate) (WS-U.3).
- **Unbiased lawmaking.** The agent facilitates lawmaking while the kernel computes the vote; the
  structural-neutrality gate proves the facilitation path cannot reach vote/tally/weight (WS-U.4).
- **Bounded treasury.** Treasury powers execute only through signed gateway actions within
  kernel-enforced caps/intervals/categories/timelocks/COI, the agent holding no keys, behind the
  fail-closed crypto + jurisdiction gates and the §17.11 production checklist; reconciliation is
  zero-or-explained (WS-U.5).
- **Maturity.** Mature rooms run on-chain elections + approvals with the full §17.5 anti-capture
  suite and fork/exit (WS-U.6).
- **Gates.** `check:policy`, the extended `check:neutrality` (incl. the agent's financial-event leg),
  the structural-neutrality gate, the floor-capability-absence test, `check:no-applause`,
  `check:no-raw-egress`, `check:workspace-deps`, and `check:deps` are all green in CI; SPEC §16.6/§24.6
  and the `docs/policy/` register stay in sync.
- **Doctrine fidelity.** The pay-to-rank firewall and fail-closed crypto are intact; managing the
  *room treasury* within voted bounds is permitted while personalized financial advice to, or wealth
  profiling of, *individual users* stays prohibited (SPEC §24.5).



---

## Changelog

| Version | Date | Author | Change |
|---|---|---|---|
| 0.1.0 (DESIGN) | 2026-06-19 | AI-Governed Rooms redesign | Initial cross-cutting charter ratifying the maintainer's four binding decisions: the three-layer authority model (room sovereignty → Knomosis-bounded AI agent → non-overridable platform legal floor), the elected room steward with exactly two powers, the bounded in-room AI agent (moderation, treasury, unbiased lawmaking facilitation), the re-scoped WS-K transparency/evaluation substrate, the preserved pay-to-rank firewall, the adversarial-community threat model, and the six staged implementation PRs. Doctrine-only (Stage 0); no runtime code. |
| 0.2.0 (DESIGN) | 2026-06-19 | AI-Governed Rooms redesign | Added Part II — the **atomic task decomposition** (49 cards across WS-U.1–U.6) in the house format (ID/Ref/description/acceptance/testing/dependencies), with authoritative Drizzle/zod shapes for the seven new `knomosis`-bounded-context entities (`room_steward_seat`, `steward_election`, `steward_governance_vote`, `room_governance_model`, `room_governance_prompt`, `room_agent_binding`, `agent_action_log`), the WS-D.3.2 isolation-walk extension, the WS-K registry/harness/guard/monitor reuse points, the §15.4 moderation-port parity, the structural-neutrality gate, the signed-action (no-key) submitter, and the fail-closed crypto/jurisdiction gating. Still doctrine-only; implementation-ready. |
| 0.3.0 (DESIGN) | 2026-06-19 | AI-Governed Rooms redesign | Hardened the plan to house-complete: a ten-point **cross-cutting requirements** block (bounded autonomy, floor supremacy, no-key-custody, no-pay-to-rank, fail-closed crypto/jurisdiction, schema isolation, transparency/reproducibility, appealability, auditability, accessibility/no-applause), a **migration-sequencing** note (`0035`+ in the `knomosis` pgSchema, online-safe, isolation-walk-extended), and a **Definition of done** spanning steward/elections, transparent-evaluated models, the bounded moderation agent, unbiased lawmaking, bounded treasury, maturity, the green-CI gate set, and doctrine fidelity. Verified all cited cross-references (WS-K/D/I/L/M/J/C task IDs) resolve. |
| 0.4.0 (DESIGN) | 2026-06-19 | AI-Governed Rooms redesign | Added **§U.0.1 Resolved architectural decisions (ADR-1…8)** from the maintainer's second-round decisions, resolving the hard questions left open by the first cut: a "model" is a declarative **`GovernancePolicyBundle`** (DSL + prompt templates + config) interpreted deterministically — not weights/code (ADR-1); the Knomosis foundations ship as a deterministic in-process **`GovernanceKernel`** behind the real-gateway seam (ADR-2); NL work uses a governed provider port, deterministic default (ADR-3); the agent is a **bounded executor role, never a key holder** (ADR-4); prompt injection is defeated by enforcing capabilities **outside** the model (ADR-5); cost/DoS are bounded by event-driven, per-room budgets (ADR-6); elections are quorum-gated and fail-safe (ADR-7); lawmaking neutrality is structural for the tally and honestly only mitigated for summary framing (ADR-8). Begins the runtime build (`@licio/governance` + DB + API + web). |




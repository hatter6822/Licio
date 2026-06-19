# WS-U. AI-Governed Rooms — Bounded-Autonomy Redesign (cross-cutting)

**Milestone:** M3 (governance substrate) → M4-M5 (treasury powers) | **Priority:** 3-5 | **Dependencies:** WS-K (model-governance substrate — re-scoped, see below), WS-G/WS-Q (rooms, content visibility, conversation/safety state machine), WS-J (platform trust & safety — becomes the legal floor), WS-L (Knomosis gateway, wallets, Lex bounds), WS-M (treasury, law-packs, proposals), WS-H (invariants — unbiased-facilitation audits), WS-N (jurisdiction/compliance) | **Wave:** 5 (substrate) → 8 (treasury) | **Estimated duration:** staged (see §U.7)

> **Status: DESIGN — ratified by the maintainer's four binding decisions (2026-06-19);
> implementation staged as reviewable PRs (§U.7). This round is doctrine-only: it amends
> `docs/SPEC.md` (§16.6, §17, §24.1, §24.5, §24.6), the `docs/policy/` register, and the
> WS-K/J/L/M plans. No runtime code lands until the design is reviewed.** The shipped WS-K
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

## Changelog

| Version | Date | Author | Change |
|---|---|---|---|
| 0.1.0 (DESIGN) | 2026-06-19 | AI-Governed Rooms redesign | Initial cross-cutting charter ratifying the maintainer's four binding decisions: the three-layer authority model (room sovereignty → Knomosis-bounded AI agent → non-overridable platform legal floor), the elected room steward with exactly two powers, the bounded in-room AI agent (moderation, treasury, unbiased lawmaking facilitation), the re-scoped WS-K transparency/evaluation substrate, the preserved pay-to-rank firewall, the adversarial-community threat model, and the six staged implementation PRs. Doctrine-only (Stage 0); no runtime code. |




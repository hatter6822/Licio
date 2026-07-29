# AI-Governed Rooms — implementation reference (WS-U)

This is the implementation reference for **WS-U (AI-governed rooms)**. The design
specification is SPEC §16.6 (elected room steward) and §24.6 (in-room AI agent);
the doctrine + staged plan is `docs/planning/22-ai-governed-rooms.md` (incl. the
ADR-1…8 architectural decisions).

## What is implemented

The bounded-autonomy runtime, deterministic and gate-green, across four layers:

| Layer | Where | Status |
|---|---|---|
| Pure domain (kernel, DSL, capabilities, elections) | `packages/governance` (`@licio/governance`) | **Shipped** |
| Isolated persistence | `packages/db/src/schema/governance.ts` (`knomosis` pgSchema) + migrations `0035`–`0038`, `0053` (durable floor-freeze), `0054` (frozen electorate + election lock), `0055` (treasury target allocation), `0066` (content-free deferred-re-moderation queue), `0067` (admitting-backend pin), `0094` (the per-lane adjudication pin + the hub-verification snapshot — the role split + model candidacy) | **Shipped** |
| Production store binding | `apps/api/src/governance/drizzle-governance-stores.ts` (gated; bound at boot when `DATABASE_URL` is set) | **Shipped** |
| Runtime service | `apps/api/src/governance/` | **Shipped (Stages 1-3, 5-core)** |
| HTTP surface | `apps/api/src/routes/governance.ts` (mounted in `v1.ts`); seat bootstrap on room create | **Shipped** |
| KYC eligibility floor (bot-prevention layer 3) | `apps/api/src/governance/eligibility.ts` + the `check:governance-kyc` CI gate | **Shipped** |
| Web surface | `apps/web/src/components/governance/` (mounted on the room page) | **Shipped** |

**The KYC eligibility floor.**  Every governance-PARTICIPATION mutation —
steward-election votes (voter AND candidate), model proposal, ratification
open/ballot, law-pack proposal/registration/adoption, lawmaking facilitation,
sim + production proposals/votes/execution, the comprehension quiz, charter
drafts, treasury provisioning, wallet-signed proposal signatures, challenges,
delegations, and steward-driven mode transitions — first passes
`checkGovernanceEligibility` / `requireGovernanceEligibility()`: a
reviewer-verified KYC standing (the WS-N.1.1f `kyc_partner` level, read
through the compliance container), no open high/critical compliance case
(the same anti-tipping-off query the availability engine uses), and no
HIGH-risk linked wallet.  Fail-closed on every unknown; denials are typed
(`kyc_required` / `compliance_hold` / `wallet_risk` /
`eligibility_unavailable`).  This is a PLATFORM floor enforced BEFORE the
community-configurable §17.5 eligibility rules and is not law-pack
overridable — the same posture as the non-overridable legal floor.  Platform
enforcement (agent freeze/unfreeze, clawback, staff recovery edges) and the
member safety valves justified in `scripts/check-governance-kyc.ts` are
deliberately outside it; content participation is never KYC-gated.  The CI
gate fails any new governance POST route that ships unclassified.

### `@licio/governance` (pure domain, I/O-free, never depends on `@licio/db`)

- **`GovernancePolicyBundle`** (ADR-1, revised) — the content-addressed "model":
  a member-ratified **moderation prompt** (prose that conditions the in-room LLM
  moderation model), prompt templates, config, and requested capabilities.
  Content-addressed via `canonicalize()` → caller's sha-256. *(The original cut
  carried a deterministic moderation **policy DSL** here; the
  LLM-in-a-deterministic-wrapper redesign replaced it — see
  `boundAiModerationAction` below.)*
- **Capability model** — a closed grantable-capability enum **disjoint** from the
  floor-reserved action set, so floor-reserved actions are *structurally
  inexpressible* (the WS-U.3.6a guarantee at the type level).
- **`LawPack`** — the community-voted bounds (treasury caps/intervals/categories/
  timelocks/COI, investment bands, quorum-gated fail-safe election rules).
- **`GovernanceKernel`** (`evaluateTreasuryAction`, ADR-2/4) — the proof-carrying
  bounded-execution semantics: a treasury action is accepted **iff** it carries
  machine-checkable evidence it satisfies the law-pack, else a typed rejection;
  fail-closed when crypto is off; the agent holds no keys. This is the
  `KnomosisGateway` seam the real Lean/Solidity/Rust kernel plugs into later.
- **`boundAiModerationAction`** (ADR-9, `moderation-bound.ts`) — the DETERMINISTIC
  WRAPPER around the in-room LLM's proposal: clamp to the escalate-to-human-review
  ceiling (never above `flag_for_review`), then to the community-granted capability.
  Pure, total, prompt-injection-inert (ADR-5) — authority is enforced OUTSIDE the
  model, so the *effect* is fixed regardless of what the model proposes.
- **`tallyElection`** (ADR-7/8) — deterministic, quorum/turnout-gated, fail-safe;
  the agent has no vote/tally/weight capability.

### Runtime (`apps/api/src/governance`)

`GovernanceService` composes the domain over injectable stores:

- **Stage 1** — seat bootstrap (creator), simulated Knomosis election lifecycle
  (schedule on term-elapse, idempotent ballots, kernel-tallied settle, fail-safe),
  DRIVEN at runtime by the lease-guarded hourly governance scheduler
  (`scheduler.ts` → `runElectionLifecycle`): it opens an election for every seat
  whose term has elapsed and settles every closed election (the eligible-voter
  count is a soft cross-context read of room membership), so a creator-bootstrapped
  seat actually rotates yearly rather than staying fixed. Ballots are
  **membership-gated** — `castVote` fail-closes on a non-member (symmetric with
  the ratification ballot), and the route additionally requires the *candidate* to
  be a room member (a steward is elected from among the room's own members). The
  tally rules AND the next term length come from the room's **community-voted
  law-pack** (`election` bounds: quorum, turnout, per-account cap, term), defaulting
  to the platform baseline — never a hardcoded constant.
- **Stage 2** — community model/prompt registry, content-addressing, **hub
  model candidacy**, and the **platform admission gate**. Candidacy is a
  MEMBER power (2026-07-21): any governance-eligible ROOM MEMBER proposes the
  bundle + prompt (`proposeModel` is membership-gated, with the elected
  seat-holder always counting as a member; the KYC floor applies at the
  route); the steward VALIDATES — the ratification-opening gate below plus a
  time-bounded **cancel of an improper open vote** (`cancelRatification`,
  CAS-raced against the scheduler settle via `transitionOpen` so a cancelled
  vote can never activate and a settled one can never be retro-cancelled). A
  bundle may carry a per-role `modelSelection` — REVISION-PINNED huggingface.co references for
  the room's MODERATION and/or ADJUDICATION model (any public, text-capable
  hub model; the propose form's model picker or a hand-authored block). Every reference is
  **verified against the hub at propose time** (existence at the pin — the
  revision endpoint must ECHO the pinned commit sha, a missing/malformed echo
  is `invalid_response`; not gated/private; a candidate pipeline; the verified
  snapshot is stored on the model row for transparency; no verifier ⇒
  `hub_disabled`, fail-closed — see `GOVERNANCE_MODEL_HUB`). A ref's
  `servedModelId` (the id the LOCAL runtime serves the model under, e.g. an
  Ollama GGUF re-serve) is accepted only when it equals the repo id or the
  operator attests the pair (`GOVERNANCE_MODEL_HUB_ALIASES`; otherwise
  `hub_served_id_not_attested`) — the hub cannot vouch for a runtime alias,
  so the party who provisioned the runtime does. Admission then evaluates **the selected model
  itself**: the moderation candidate is **sampled k-of-N** over the platform
  floor-safety eval set and must land in the platform `[min,max]` severity
  band on every fixture (catching under- and over-moderation), beneath —
  never replacing — the platform legal floor; a `debate.judge`-requesting
  bundle additionally passes the ADJUDICATION validity probe (one canonical
  debate fixture through the resolved adjudication model — advisory surface,
  so its bar is validity, not the floor bands). On pass, **both lane pins**
  are recorded (`admitted_backend_id` + `admitted_adjudication_backend_id`).
  A TRANSIENT outage during admission — including a hub selection no runtime
  serves YET — is **retryable, never a permanent reject**: the model stays
  `evaluating` (so the `(room,digest)` dedup can't lock the bundle out) and
  the scheduler's `admission_retry` sweep re-runs it when the backend (or the
  operator-provisioned runtime) recovers. A model
  becomes the active agent ONLY by passing a **member ratification vote** (`@licio/
  governance` `tallyRatification`): the seat-holder opens a vote on an eligible
  model (optionally binding a law-pack), members cast one yes/no ballot each
  (membership-gated, composite-PK idempotent), and the lease-guarded scheduler
  settles it at the window close — adopting the model only on a quorum-meeting
  approving majority (FAIL-SAFE otherwise). There is NO direct-activate route;
  adopting a new model **supersedes** the prior one.
- **Stage 3** — the in-room moderation MODEL is an **LLM inside a deterministic
  wrapper** (`GovernanceService.moderate`, ADR-9): the model CLASSIFIES a
  contribution and the wrapper bounds its proposal by the **escalate-to-human-review
  ceiling** (never above `flag_for_review` — an AI-driven removal is impossible; a
  human confirms) then the **community-capability clamp** (`boundAiModerationAction`);
  an un-granted action is clamped down, never escalated. On model **UNAVAILABLE**
  (timeout, breaker, budget, prohibited-use block, transport/schema error) the wrapper
  **fails to the always-on WS-J baseline** (returns no in-room decision) AND enqueues
  the contribution REF in the durable **pending-remoderation queue**
  (`knomosis.room_pending_remoderation`); the lease-guarded scheduler's
  `remoderation_lifecycle` sweep drains it — RECONSTRUCTING the moderation context from
  the live content stores at retry (the queue holds only soft refs — **no UGC** — so a
  contribution deletion has nothing to purge there), re-running the model once it
  recovers, and RAISING the already-published contribution to review post-hoc
  (floor-dominant), so the model's judgment is **delayed, never dropped**. The
  moderation model runs on the dedicated **MODERATION LANE** (project default: the
  `Qwen/Qwen3Guard-Gen-4B` guard classifier in its NATIVE Safety/Categories dialect,
  deterministically mapped onto the action vocabulary — `guard-format.ts`; a
  room-selected hub model resolves through the room-model resolver in ITS dialect).
  A model is admitted under a SPECIFIC backend (`ModerationProposer.backendId` —
  the bundle's hub selection when it carries one, else the lane — pinned on the
  model at admission); if the live resolution differs — LLM moderation enabled over
  a deterministic-admitted model, the moderation-lane model changed, or a hub
  selection no longer served — moderation **fails closed to the baseline** until the
  model is re-admitted (never runs under an un-vetted backend). A **deterministic
  default proposer** serves the same seam when no
  LLM is configured (dev/test; opt out of the LLM with `GOVERNANCE_LLM_MODERATION=off`).
  Provenance-triple audit log; the floor's
  room-governance-freeze — a live, platform-steward-gated control (`POST
  …/governance/agent/freeze` + `…/unfreeze`, gated by the WS-J `restrict` capability +
  verified MFA): a platform safety steward, never the room's elected steward, can
  pause or restore a room's community-approved agent at any time, and the "governed
  by" view reports the paused (`frozen`) state. The model is **wired into the live
  contribution path**: BOTH `createContribution` AND `editContribution` (an
  edit-to-violate is caught too) consult the `RoomAgentModerator` seam
  (`governance/forum-agent.ts`) for any room with an active binding and combine its
  recommendation **floor-dominantly** — the agent can raise a contribution's
  moderation state (flag → `under_review`) but can never lower or reverse a
  platform-floor decision, and the ceiling means it never reaches `removed`.
  The model decides over a `ModerationContext` carrying **real author-history
  signals** (account age from the identity articulation node, room familiarity from
  the subscription/steward state, prior in-room removals) and **canonical**
  link/mention counts (one token per URL; an email is not a mention), so a room
  policy that gates on those signals actually fires. Agent-held content is routed to
  the human review queue (the appeal path), suppressed from scoring emission exactly
  like a WS-J hold, AND — no silent sanctions — the author receives a
  **statement-of-reasons notice** carrying the agent's own reason: a COMMUNITY-layer
  notice (no platform taxonomy reason code, the queued human review as its recourse)
  distinct from a platform-floor enforcement.
- **Stage 3b (the room's AI resolution queue, WS-T)** — a governed room whose
  ratified agent holds the `debate.judge` capability (permitted by the default
  law-pack; deny-by-default derivation) adjudicates its own correction-debate
  queue: `GovernanceService.debateConditioning(roomId)` resolves the active
  binding → capability gate → the ratified model under its OWN
  **ADJUDICATION-lane admission pin** (`admitted_adjudication_backend_id` — the
  role split: the adjudicator runs the ADJUDICATION lane, project default the
  `Qwen/Qwen3.6-27B` generalist, or the bundle's hub adjudication selection
  resolved per call) → the community-ratified prompt, and the
  governed LLM debate leg runs room-conditioned (the prompt folds in
  subordinate to the platform rules).  A pin mismatch — a lane-model swap, an
  unserved hub selection, or a row admitted before the split — fails closed to
  the platform adjudicator legs until the scheduler's `adjudication_repin`
  sweep re-probes and heals it (a passing validity re-probe IS that lane's
  re-admission; the moderation pin stays strict — its re-admission is the full
  k-of-N floor evaluation).  The verdict's `AIOutputRecord` pins the
  room/model/prompt digest and `recordDebateAgentAction` appends the
  provenance triple to the agent action log (`actionType: 'debate.judge'`,
  reversible — the steward's 24h overrule is the human remedy).  Every failure
  resolves deny-by-default to the platform adjudicator legs
  (`docs/forum/DEBATE-ARENA.md`).
- **Stage 4 (facilitation)** — deterministic lawmaking facilitation
  (`@licio/governance` `summarizeProposal`/`scheduleProposalVote`/`attestOutcome`),
  exposed as capability-gated `facilitateSummary`/`Schedule`/`Attest`: each requires
  the matching `lawmaking.*` capability on the active binding (else a typed
  refusal), and every facilitation is logged with the provenance triple. The
  summary surface additionally accepts an ADR-3 `GovernanceNlProvider` (wired
  at boot; see the LLM-seam residual below): an LLM-drafted summary is served
  only after the deterministic quality/grounding gate passes, and any provider
  failure serves the deterministic summary instead. The agent
  attests a PLATFORM-COMPUTED outcome — it has no vote/tally/weight capability, so
  it can never compute or bias a result (ADR-8). The elected steward can trigger a
  neutral summary (`POST …/governance/lawmaking/summarize`); schedule/attest are
  exercisable primitives whose production trigger is the WS-M proposal lifecycle.
- **Stage 5 (core)** — the kernel-backed treasury executor: fail-closed when crypto
  is off, capability- and kernel-gated when on, the agent holding no keys; the
  verdict is logged.

The crypto flag defaults **false** (`config.ts`), so treasury powers do not exist
by default. In-memory stores back dev/tests; the gated Drizzle adapters bind the
same interfaces later. Every governance **write** route carries an identity-free
per-endpoint fixed-window budget (SPEC §19.1 load-shedding, never per-IP), placed
before auth: member ballots get a roomier budget than the steward writes, and the
platform-floor freeze stays unlimited so an emergency pause is always available.

### Web surface (`apps/web/src/components/governance`)

Both surfaces are mounted on the room page behind the WS-Q content read bar:

- **`GovernedByPanel`** — the in-room "how this room is governed" transparency view
  for every member: whether a community-approved agent governs the room, **which
  model serves each governed ROLE** (the ratified hub selection with its pinned
  revision, or "platform default" — the role-split transparency row), the powers
  the community granted it, the recent agent actions (each named as appealable to
  the platform's human floor), a one-click **download** of the active,
  content-addressed model artifact, and a distinct **floor-paused** state when the
  platform floor has frozen a community-approved agent (vs a room that never had one).
- **`StewardModelManager`** — member candidacy + the steward's validation gate +
  the member vote (the 2026-07-21 topology: members author and adopt; the steward
  checks): a MEMBER **propose** form (a declarative `GovernancePolicyBundle`
  editor seeded with a valid starter policy + an agent prompt, JSON-validated
  client-side before the POST) with the per-role **hub model picker** (search
  public huggingface.co models through the BFF `/v1/model-hub` proxy, pin the
  selection at its head revision sha into the bundle's `modelSelection`, clear
  back to the platform default; gated models are flagged, never selectable); on a
  model that cleared the admission gate, the steward's
  **"Open ratification vote"** action (the validation gate) and, while a vote is
  open, the steward's **improper-vote cancel** alongside the member voting panel
  (**Approve / Reject** with the live in-favour/opposed tally and the close
  time) shown to every member. The proposal **registry** — status pipeline +
  per-proposal digest + member **download** — is shown to every member for
  transparency. No applause primitives; the tally is governance data (in-favour /
  opposed counts), never a popularity signal.

### Production store binding (`drizzle-governance-stores.ts`)

The eleven store interfaces have gated Postgres adapters over the `knomosis` tables,
bound at boot (`apps/api/src/index.ts`) when `DATABASE_URL` is set (the in-memory
adapters remain the dev/test path). Concurrency invariants the in-memory adapters
held by convention are enforced by the schema, so the production path relies on
them instead of a read-then-write race:

- the **steward vote** carries a composite primary key `(election_id,
  voter_user_id)`, so a double ballot collides (idempotent `cast`, migration `0036`);
- the **governance model** carries a unique index on `(room_id, artifact_digest)`,
  so a duplicate proposal collides (`insert` returns null, migration `0036`); and
- the **model ratification** carries a partial unique index on `(room_id) WHERE
  status = 'open'` (migration `0038`), so two concurrent opens cannot both create
  an open vote (`insert` returns null on the second — the atomic one-open-per-room
  guard).

### Review hardening (cross-room + access control)

The route/service layer additionally enforces, with tests: ballots are bound to
their subject's room (a vote/ratification id from another room is a 404, never
counted with this room's membership gate); ballots are rejected once `closesAt`
has passed (independent of the scheduler tick); a supplied law-pack must belong to
the room (no foreign bounds); model digests use the `@licio/governance`
`canonicalize()` (key-order-independent); the read surfaces (model list/download,
agent view, ratification view) pass the WS-Q room content bar (a private room's
governance data is members/stewards-only); and every governance route validates
its uuid path params (a malformed id is a controlled 422, never a Postgres 500).

### Pay-to-rank isolation

The `knomosis` tables reference ranking/content (`public.rooms`, contributions, the
WS-K registry) only by **soft ref** (no FK); the only hard outward edge is to
`public.users` (the articulation node). The WS-D.3.2 schema-isolation walk seeds
from all eleven governance tables and proves no join path reaches ranking; a
hypothetical `knomosis → public.rooms` FK is caught.

## Tests

- `packages/governance` — deterministic unit/property tests, incl. the lawmaking
  facilitation suite (`lawmaking.test.ts`: deterministic summary/schedule/attest +
  the inconclusive-when-unsettled path).
- `apps/api` — the service vertical (seat/election incl. the member-gate + the
  law-pack-driven settle, admission, moderation + downgrade + freeze, the Stage 4
  lawmaking facilitation + per-capability gating in `governance-lawmaking.test.ts`,
  treasury fail-closed + accepted + every error branch), the real author-history
  reader + canonical token counting (`governance-author-history.test.ts`), config
  validation, and the HTTP route surface (auth, steward-only, download, the
  election-vote member/candidate gate, the lawmaking summary route, the write
  rate-limit ceiling, agent view).
- `apps/api` — the agent on the contribution path
  (`governance-agent-moderation.test.ts`) + the author statement-of-reasons notice
  on a hold/removal (`moderation-prechecks-wiring.test.ts`).
- `apps/web` — the governance client flows (`governance-api.test.ts`), the
  `GovernedByPanel` transparency states, and the `StewardModelManager` steward
  surface (member candidacy + the steward validation gate + the improper-vote
  cancel + the hub model picker, propose with client-side JSON validation, confirm-gated
  ratify, per-proposal download, loading/error branches, axe a11y).
- `apps/api` — the member-ratification vote (`governance-ratification.test.ts`:
  open/ballot membership-gating + idempotency, approving-majority activation,
  fail-safe non-activation, supersede, scheduler settle), the election-lifecycle
  scheduler (`governance-scheduler.test.ts`), and the dev **governed-room
  showcase** (`demo-seed-showcase.test.ts`: the *Elections & Governance* room
  ships with an active agent, a logged action, and an open ratification vote).
- `apps/api` (gated) — `governance-integration.test.ts`: the eleven Drizzle
  adapters against the real migration chain (seat upsert, election patch/settle,
  the vote-PK idempotency, the model digest-uniqueness collision, the ratification
  ballot-PK idempotency + settle patch, prompt/law-pack/binding round-trips,
  newest-first agent actions, accepted-treasury filtering).
- `packages/db` — the extended isolation walk over the governance context.

## Residuals (tracked)

- **Stages 4 & 6** — the community **law-pack** (the agent's bounds) is
  proposable and bindable: a steward-gated `POST …/governance/law-packs` registers
  it and `approveModel`'s `law_pack_id` binds it, so the derived capability
  descriptor is intersected with the community's permitted set (a community can
  tighten the agent below the model's request). The deterministic lawmaking
  *facilitation* primitives (`lawmaking.summarize/schedule/attest`) are now
  **shipped** and capability-gated (summary wired to a steward route; see Stage 4
  above). The WS-M production proposal lifecycle has since **shipped**
  (2026-07-14; `docs/treasury/README.md`): deliberation/voting windows,
  deadline-driven tallies, challenges, and execution — including
  `law_pack_upgrade` / `charter_update` / `steward_rotation` proposals routed
  through their owning services — plus delegation with anti-capture eligibility
  gates (cooling-off, COI recusal, capped weights). What remains is binding the
  agent's `lawmaking.schedule/attest` primitives to that lifecycle as the
  *agent-driven* trigger, the on-chain election mode, and the remainder of the
  §17.5 anti-capture suite.
- **Treasury execution** (`executeTreasuryAction`) — implemented and fail-closed
  behind the crypto flag (off by default).  **Its production caller has shipped**
  (2026-07-14, WS-M): the production proposal lifecycle
  (`apps/api/src/treasury/proposals.ts` → `buildTreasuryExecutorPort` in
  `apps/api/src/treasury/services.ts`) routes every fund-moving execution through
  this kernel executor — see `docs/treasury/README.md`.  This residual is closed.
- **Web surfaces** — the in-room "governed by" panel, the member propose surface,
  the member-downloadable proposal registry, AND the **member ratification voting
  panel** (open vote → Approve/Reject + live tally, now **membership-gated** — a
  non-member sees "Join the room to take part in this vote" rather than a ballot
  that would 403) are **shipped** (`apps/web/src/components/governance/`). The
  prerequisite **room membership affordance** — joining a room to become the active
  member that governance voting requires (`isRoomMember`) — is wired for public AND
  private rooms via `RoomMembership` (`apps/web/src/components/rooms/RoomMembership/`):
  a public room joins immediately, a private room by request/invite, with a Leave
  control and an anonymous sign-in prompt. The remaining web residual is the
  **steward-election ballot UI** (the *seat*-election candidate vote — distinct
  from model ratification; the seat election lifecycle and read view are shipped)
  and a richer model-card render.
- **Gated Drizzle adapters** — **shipped**
  (`apps/api/src/governance/drizzle-governance-stores.ts`, bound at boot when
  `DATABASE_URL` is set; the migration-chain integration test runs in CI). The
  in-memory adapters remain the dev/test path.
- **Doctrine-matrix propagation** — `CRYPTO_FEATURE_MATRIX` now carries the WS-U note
  (no new crypto tier; v1.1.0). `JURISDICTION_MATRIX` / `TRANSPARENCY_DICTIONARY` /
  `SIGNAL_MATRIX` need no new entries — the agent reuses the existing treasury/
  moderation/Knomosis surfaces (covered by their existing feature cells, safety +
  Knomosis metrics, and coordination anti-signals); confirming clarifying notes are
  the only residual.
- **Pluggable LLM provider seam** (ADR-3) — **shipped for the lawmaking-summary
  surface** (ADR-9, 2026-07). `GovernanceNlProvider`
  (`apps/api/src/governance/nl-provider.ts`) is the port; `facilitateSummary`
  consumes it, conditioning the draft on the room's member-ratified prompt +
  the bundle's `promptTemplates['lawmaking.summarize']` + `config.summaryStyle`,
  and FALLS BACK to the deterministic summary on any provider failure. Two real
  backends exist behind the same governed pipeline
  (`apps/api/src/ai-governance/llm/`): the hosted Anthropic API (official SDK)
  and **loopback-only local** OpenAI-compatible runtimes running the TWO role
  lanes of the 2026-07-21 split — moderation (`Qwen/Qwen3Guard-Gen-4B`,
  guard-native dialect) and adjudication (`Qwen/Qwen3.6-27B`; the summariser
  rides this lane, incl. a room's ratified hub adjudication model) — vLLM the
  reviewed default runtime, Ollama/llama.cpp/LM Studio the alternatives. Every
  invocation is guard-checked
  (`gov_summarize_proposal`, advisory), zod-validated, gated by the
  deterministic §24.5 quality/grounding checks, budgeted per room (ADR-6) with
  per-model circuit breakers, registered/deployed through the real WS-K gate
  (one registry identity per backend+config), and recorded as an immutable
  `AIOutputRecord`.
  Fail-closed and never silent: PRODUCTION **and DEVELOPMENT** default an
  unset `GOVERNANCE_LLM_PROVIDER` to the loopback-`local` backend (the
  vLLM-default-everywhere posture; the dev boot probes each lane and the
  DEV-ONLY simulated runtime stands in per lane whose real runtime is not
  serving its model — real runtimes are always preferred),
  `deterministic` is the explicit opt-out, and every
  governed surface fails closed per call to its deterministic path until its
  lane responds. The boot records a per-lane status summary
  (`AiGovernanceServices.llmStatus`) served to the AI team at
  `GET /v1/ai/admin/governance/llm` — the first-class "is the AI actually
  running?" answer. The hosted backend stays an explicit opt-in whose
  data-processor egress is boot-logged loudly; the `local` backend is
  loopback-enforced so content stays on-host (see `docs/DEVELOPMENT.md` §16). **The in-room moderation MODEL
  is the wrapped LLM** (ADR-9, revised — the deterministic policy-DSL and the
  earlier score-blind shadow advisor were both removed): a governed
  `toxicity_safety_triage` LLM CLASSIFIES each moderated contribution, and
  `GovernanceService.moderate` is the DETERMINISTIC WRAPPER that bounds the
  proposal (the escalate-to-human-review ceiling + the community-capability
  clamp; the ADR-1/ADR-5 authority invariant). It runs the full governed path
  (guard → completion → strict schema → immutable `AIOutputRecord`) under a
  per-room budget + breaker; on model unavailability it **fails to the WS-J
  baseline** and enqueues the contribution for **deferred re-moderation** (the
  durable `room_pending_remoderation` queue drained by the scheduler sweep —
  delayed, never dropped). Every decided moderation (raw proposed vs
  wrapper-bounded action, whether clamped — metadata only, no content, no
  attention values) is surfaced to the AI team at `GET
  /v1/ai/admin/governance/moderation/:roomId`. LLM by default when a backend is
  configured; opt out via `GOVERNANCE_LLM_MODERATION=off` (⇒ the deterministic
  default proposer). Remaining: the recorded-fixture eval corpus replacing the
  synthetic admission input (slice 3).

## Security & correctness audit (2026-07)

A deep multi-agent audit (domain, API, DB, web, spec conformance) surfaced 21
adversarially-verified findings. The following were **fixed** in this pass (each
with a regression test):

- **Non-overridable platform floor is now durable** (H1/M5). A room binding
  carries a `floor_frozen` flag distinct from `active` (migration `0053`): the
  WS-J-gated freeze sets it and only the unfreeze clears it, `approveModel` binds
  a re-ratified model **inactive** while frozen, and both freeze/unfreeze are
  written to the append-only agent audit log. A member re-vote can no longer
  resurrect a floor-frozen agent.
- **Moderation capability sandbox** (H2/M8). `MODERATION_ACTIONS` is reordered so
  severity is monotonic with content-hiding impact (`warn` < `flag_for_review`),
  and `gateDecision` now falls back to the strongest *granted* action ≤ the decided
  one (else `allow`) — the agent can never drive content to `under_review`/`removed`
  without the community-granted capability, and never escalates a visible action.
- **Kernel-enforced treasury bounds** (M1/M2/L1). The kernel enforces the voted
  investment allocation bands fail-closed (`checkInvestmentBands`, a required
  `targetAllocation`), rejects non-finite/negative amounts (`invalid_amount`), and
  `executeTreasuryAction` gates each action on its per-category `treasury.*`
  capability (not just the gateway cap).  "Fail-closed" holds on BOTH sides of
  every comparison: the proposed fractions and the policy band edges are checked
  for finiteness first, since a NaN on either side makes the comparison false and
  would let the bands pass vacuously — returning `accepted: true` with a positive
  `investment_bands passed` proof for an allocation satisfying no band.  The
  amount guard likewise covers the history entries and law-pack bound strings the
  arithmetic reads, not just `action.amount`: a value outside the decimal domain
  throws out of `decSum`/`decCompare`, so leaving those unguarded turned a bad
  input into an exception instead of a typed `Verdict`
  (`docs/knomosis/threat-model-treasury-indexer-lawpack.md` §4).
- **Election/ratification integrity** (M3/L3). The election winner is re-validated
  as a current room member at seat assignment (fail-safe to the incumbent), the
  cast-time candidate-eligibility is enforced on the service, and both tallies clamp
  turnout to `[0,1]`.
- **Route/authz hardening** (M6/L6). `GET …/steward` applies the WS-Q content bar
  (no private-room steward-identity leak), and `candidate_user_id` is uuid-validated
  (controlled 422, not a Postgres 500).
- **Member offline verification** (M7). The downloaded model bundle is written as the
  exact canonical (key-sorted) bytes, so `sha256(file) === artifact_digest`.
- **Store parity + UI polish** (L5/L9). The Drizzle ratification `patch` covers the
  full mutable surface (parity with the in-memory adapter), and the "governed by"
  panel handles a download failure instead of an unhandled rejection.

A follow-up pass then closed the remaining deferred items (each with a regression
test):

- **M4 — the ratification electorate is FROZEN at open.** `openRatification`
  snapshots the room's member count onto `eligible_count` (migration `0054`); the
  settle tally divides by that frozen denominator, not a live read (`minTurnout`
  needs no snapshot — it comes from the vote's immutable bound law-pack). Membership
  churn during the window can no longer flip the outcome. `runRatificationLifecycle`
  no longer takes a live count.
  A later review round closed the other half: the DENOMINATOR was frozen while
  the ballot gate still read live membership, so a member who joined after the
  open could vote and push turnout past 100% of the electorate it was measured
  against — making the window between open and close a recruitment window.
  `castVote` now takes the voter's join instant and refuses `joined_after_open`;
  `signProposal` applies the same freeze against the proposal's
  `deliberationEndsAt`, and `memberFacts` carries `memberSince` (the INSTANT —
  a day count taken "now" cannot answer a question about a past open).
- **L4 — one-open-election atomicity.** A `steward_election(room_id) WHERE
  status='open'` partial unique index (migration `0054`) + a nullable
  `ElectionStore.insert` (in-memory guard + Drizzle `onConflictDoNothing`) makes
  `scheduleElection` race-safe, mirroring the ratification guard.
- **L7 — the legacy `/rooms/$roomId/governance` route is no longer a dead end.** It
  redirects to the room with the governance modal deep-linked open
  (`?governance=<tab>`, validated by `roomDetailSearchSchema`); the modal opens to
  the linked tab. The "Governance unavailable" stub is gone.
- **L8 — the two governance panels are internationalized.** `GovernedByPanel` and
  `StewardModelManager` route every user-facing string (including the capability and
  status label maps) through `t(key, fallback)`, matching the `RoomGovernanceDialog`
  shell — localizable and catalog-ready.

**Deferred (tracked debt, closure target):**

- **L2 — a bounded `moderate.restore` action.** The capability is no longer granted
  by default (removed from `defaultModerationLawPack`), so nothing claims the agent
  can restore. Wiring an ACTUAL restore that reverses ONLY the agent's own prior
  in-room holds — never a platform-floor or human-steward removal — requires a
  **`moderation_source` field on the core `contributions` table** (the model today
  records only `moderation_state`, with no provenance), set on the create/edit
  moderation paths and cleared by every human-console action, plus a `restore`
  branch in the edit re-moderation flow gated on `moderation_source='agent'` +
  `moderate.restore` + a fresh-clear floor verdict. Shipping this without the
  provenance field would risk the agent reversing a floor/human removal (a
  floor-safety regression strictly worse than not having restore), so it is a
  deliberately-separate, security-reviewed slice. *Closure: the WS-U.3.1
  forum-integration slice (add `moderation_source` + the audited restore path).*

# Licio Signal Matrix

> Foundational policy document for Licio's no-applause architecture. It enumerates
> the **only** signals that may contribute positively to ranking (allowlist), the
> signals that must **never** affect ranking (denylist), and the **anti-signals**
> that deliberately reduce or penalize ranking. A signal that is not on the
> allowlist may not contribute positively to ranking without a doctrine amendment
> and a corresponding ranking-neutrality-suite update.

| Field | Value |
|---|---|
| **Document ID** | `SIGNAL_MATRIX` |
| **Produced by** | WS-A.1.1a (allowlist), WS-A.1.1b (denylist), WS-A.1.1c (anti-signals) |
| **Version** | 1.0.0 |
| **Owner** | Licio Maintainers — Doctrine & Policy Working Group |
| **Effective date** | 2026-06-08 |
| **Status** | Ratified (M0 doctrine gate) |
| **SPEC references** | §2.4, §5.2, §5.3, §13.6, §19.3, §30.6 |
| **Primary consumers** | WS-E.2 (PWAtt), WS-H (invariants), WS-I.2 (feature store), WS-I.3 (neutrality suite) |

**Naming convention.** Every signal carries a stable, globally unique signal ID so
downstream feature schemas and tests reference signals by identifier, never by prose:

| Prefix | Class | Section |
|---|---|---|
| `SIG-ATT-*` | Allowed attention signal | WS-A.1.1a |
| `SIG-PART-*` | Allowed participation signal | WS-A.1.1a |
| `SIG-PROH-*` | Prohibited signal (never affects ranking) | WS-A.1.1b |
| `SIG-ANTI-*` | Anti-signal (negative/protective ranking effect) | WS-A.1.1c |

The signal-ID sets for the four classes are **disjoint**: no ID appears in more than
one class. The canonical machine-readable enumeration at the end of this document is
the source of truth; the prose tables below must agree with it.

---

## WS-A.1.1a — Allowed positive signals (allowlist)

The allowlist is **closed**. A signal not present here may not contribute positively
to PWAtt ranking. Each allowed signal is bound to a required guardrail so that a
salience signal cannot be silently weaponized into an applause proxy. Every attention
signal is a *salience* signal, not an endorsement (SPEC §5.2); the guardrail names the
concrete mechanism that prevents salience from being read as approval.

### Attention signals (SPEC §5.3)

These signals may contribute positively to PWAtt ranking, subject to guardrails:

| Signal ID | Signal | Description | Guardrail (anti-applause mechanism) |
|---|---|---|---|
| `SIG-ATT-DWELL` | Active dwell | Reading with foreground focus and normal scroll cadence | Capped per item; idle time and screen-on inactivity are ignored, so raw time cannot accumulate |
| `SIG-ATT-SRCOPEN` | Source open | Opening the original article, document, dataset, or evidence | Do not reward clickbait if the user immediately returns (bounce check) |
| `SIG-ATT-CTXOPEN` | Context open | Opening context cards, source history, or claim timeline | Counted once per meaningful session, so reopening cannot inflate |
| `SIG-ATT-RETURN` | Return visit | Returning after time away, indicating sustained interest | Obsessive/rapid loops are excluded so compulsion is not rewarded |
| `SIG-ATT-TRAVERSE` | Thread traversal | Reading multiple branches or opposing views | Nonredundant traversal is weighted above repeated same-branch reading |
| `SIG-ATT-SAVE` | Save for later | Privately marking content to revisit | Private by default; low rank weight; never aggregated into a public score |
| `SIG-ATT-SHARE` | Share outside app | Sending a link externally | Low rank weight until recipient attention or participation actually occurs |

### Participation signals (SPEC §5.3)

These public actions may contribute positively to PWAtt ranking based on **quality and
downstream thread improvement**, never volume. Each ranking effect is conditional on an
*outcome* (cited, accepted, corroborated, SCOI decreased) so quantity alone earns nothing:

| Signal ID | Signal | Description | Ranking effect (outcome-conditioned) |
|---|---|---|---|
| `SIG-PART-QUESTION` | Clarifying question | Asks what evidence supports a claim, identifies ambiguity | Positive if it elicits useful answers or identifies ambiguity |
| `SIG-PART-EVIDENCE` | Evidence addition | Adds primary source, dataset, transcript, legal text, credible report | Strong positive **if cited and relevant** |
| `SIG-PART-CORRECT` | Correction | Identifies false quote, wrong date, missing caveat, broken link | Strong positive **when accepted or corroborated** |
| `SIG-PART-SYNTH` | Synthesis | Summarizes multiple branches fairly | Positive **when it reduces context obstruction or repetition** |
| `SIG-PART-COUNTER` | Counterexample | Adds a relevant exception or opposing case | Positive **when it broadens the evidence base** |
| `SIG-PART-DOMAIN` | Domain explanation | Explains technical, legal, scientific, or local context | Positive **if nonredundant and useful to readers** |
| `SIG-PART-BRIDGE` | Bridge comment | Translates one community's interpretation for another | Strong positive **when SCOI decreases** |
| `SIG-PART-STEWARD` | Steward action | Moderation clarification, rule reminder, merge suggestion | Positive **for thread health, not personal fame** |

**Guardrail rationale (no-applause doctrine).**
- No signal in this allowlist may be aggregated into a **public per-user score**;
  aggregation is private and surfaced only through the Signal Ledger (SPEC §5.1, §19.3).
- Participation signals are rewarded for **thread-state improvement**, not for posting
  frequency; the ranking-effect column is conditional on outcome.
- Adding a signal to this allowlist requires a doctrine amendment (changelog entry +
  maintainer sign-off) **and** a corresponding update to the neutrality suite (WS-I.3).

---

## WS-A.1.1b — Prohibited signals + neutrality-test mapping (denylist)

These signals are **absolutely prohibited** from influencing ranking, candidate
generation, search placement, notification priority, trend/Front-Page placement,
recommendation eligibility, or author/source status used in ranking. Each prohibited
signal carries (a) a rationale, (b) a precise, testable ranking-neutrality assertion,
and (c) the stable neutrality-test ID under which it is verified. This section is the
policy half of the contract with the neutrality verification suite (WS-I.3); the
bridging document is `SIGNAL_TEST_MAP.md` (WS-A.1.4).

| Signal ID | Prohibited signal | Rationale | Ranking-neutrality assertion | Policy test → suite test |
|---|---|---|---|---|
| `SIG-PROH-LIKES` | Likes | Do not exist in the platform; there is no like button | Feed replay with a hypothetical like field produces identical ranking order | `RNT-001` → `WS-I.3.1a` |
| `SIG-PROH-UPVOTES` | Upvotes | Do not exist in the platform; there is no upvote button | Feed replay with a hypothetical upvote field produces identical ranking order | `RNT-002` → `WS-I.3.1a` |
| `SIG-PROH-REACT` | Hearts / reactions | Applause mechanics measuring popularity, not quality | No reaction-counter field exists in any ranking feature schema | `RNT-003` → `WS-I.3.1b` |
| `SIG-PROH-KARMA` | Public karma | Aggregate reputation scores create gaming incentives | No karma field is readable by ranking services; karma absent from PWAtt inputs | `RNT-004` → `WS-I.3.1c` |
| `SIG-PROH-FOLLOW` | Follower counts | Popularity metric rewarding celebrity, not contribution | Follower count absent from PWAtt and all invariant joins | `RNT-005` → `WS-I.3.1c` |
| `SIG-PROH-DONOR` | Donor badges | Financial-status signal that creates pay-to-rank | Donor status/badge absent from all organic feature schemas | `RNT-006` → `WS-I.3.1c` |
| `SIG-PROH-TOKBAL` | Token balances | Crypto-wealth signal | Token balance absent from PWAtt feature inputs | `RNT-007` → `WS-I.3.1b` |
| `SIG-PROH-PAYAMT` | Payment amounts | Financial-transaction data | Payment amount absent from all organic ranking features | `RNT-008` → `WS-I.3.1b` |
| `SIG-PROH-TREAS` | Treasury contributions | Room financial contributions | Treasury contribution absent from story rank computation | `RNT-009` → `WS-I.3.1d` |
| `SIG-PROH-DAOVOTE` | DAO votes | Governance participation | DAO vote outcomes do not change claim labels without evidence/steward process | `RNT-010` → `WS-I.3.1e` |
| `SIG-PROH-WALLET` | Wallet connection status | Whether a user has linked a wallet | Feed replay for wallet-linked vs non-linked users yields identical ranking | `RNT-011` → `WS-I.3.1a` |
| `SIG-PROH-PAIDMEM` | Paid membership | Subscription status | Paid membership does not bypass safety, rate limits, or moderation | `RNT-012` → `WS-I.3.1f` |
| `SIG-PROH-NFT` | NFT ownership | Token-ownership status | NFT ownership absent from all ranking and recommendation features | `RNT-013` → `WS-I.3.1b` |
| `SIG-PROH-GOVOUT` | Governance vote outcomes | DAO proposal results (without evidence process) | Governance outcomes require evidence/steward review before any ranking effect | `RNT-014` → `WS-I.3.1e` |

**Scope of the prohibition.** Each prohibited signal is excluded from **all** of:
ranking score, candidate-generation eligibility, search placement and ordering,
notification priority and eligibility, trend/Front-Page placement, recommendation
eligibility, author/source status used in ranking, **and any derived feature computed
from a prohibited signal**. Derivation does not launder a prohibited signal: a feature
engineered from token balance is itself prohibited.

**One permitted, tightly-bounded exception.** Treasury contribution may surface content
*only* through a manually approved, clearly labeled public-interest prompt on a dedicated
treasury surface that the user has explicitly opted into. This is **not** organic ranking
and is verified separately (`RNT-009` / `WS-I.3.1d`, with labeling under `WS-I.3.1h`). The
exception is enumerated here so the prohibition elsewhere is unambiguous.

---

## WS-A.1.1c — Anti-signals and penalty responses

Anti-signals are detected patterns that **reduce or penalize** ranking, trigger rate
limiting, or route to safety review. They differ from prohibited signals: prohibited
signals must never have *any* ranking effect; anti-signals deliberately have a *negative*
or *protective* effect, conditioned on base rates so authentic enthusiasm is not punished
(SPEC §2.2).

| Signal ID | Anti-signal | Detection basis | Graduated response | Owner (downstream task) |
|---|---|---|---|---|
| `SIG-ANTI-REPEAT` | Rapid repetitive commenting | Velocity + similarity from one account | Damp participation weight; possible rate limit | WS-J.2.6c, WS-E.2.2 |
| `SIG-ANTI-BURST` | Coordinated bursts | MFCI synchrony beyond base rate | Apply MFCI penalty and review threshold | WS-H.3, WS-I.2.4 |
| `SIG-ANTI-RAGELOOP` | Rage-loop behavior | Repeated hostile returns to same target/thread | Do not convert hostile returns into positive attention | WS-E.2.2, WS-H.6 |
| `SIG-ANTI-LOWINFO` | Low-information replies | Classifier: volume without contribution value | Count as conversation volume but not constructive participation | WS-K, WS-E.2.2 |
| `SIG-ANTI-NOEVID` | Source-free accusation | Accusatory claim lacking cited evidence | Require evidence or downweight | WS-G, WS-E.2.2 |
| `SIG-ANTI-BRIGADE` | Brigading reports | MFCI coordination on reporting pattern | Report impact conditioned by MFCI and reporter reputation | WS-J.1.1d, WS-J.2.6e |
| `SIG-ANTI-HARASS` | Harassment cascade | Safety classifier + target-concentration | Freeze ranking growth; safety review; protect targets | WS-J.1, WS-H.3 |

**Conditioning requirement (anti-applause must not become anti-authenticity).** Each
response is conditioned so that normal high-volume authentic activity (a large community
discussing a major event) is not mistaken for manipulation:

- **MFCI-1** — large normal communities are not penalized solely for volume. Applies to
  the coordination-related anti-signals `SIG-ANTI-BURST` and `SIG-ANTI-HARASS`.
- **MFCI-2** — coordinated reporting has delayed enforcement until reviewed; report-based
  anti-signals additionally condition on reporter reputation. Applies to
  `SIG-ANTI-BRIGADE`.

Responses are **graduated and reversible** (damp → rate limit → review), never a silent
ban, preserving the notice-and-appeal and human-review-not-auto-removal invariants for
ambiguous cases.

---

## Canonical machine-readable enumeration

> This fenced block is the canonical source of truth for signal IDs. Tooling and the
> ranking-neutrality suite ingest it directly; the prose tables above must agree with it.
> Validated by `scripts/check-policy.ts` (counts, disjointness, naming, RNT mapping).

```json
{
  "document": "SIGNAL_MATRIX",
  "version": "1.0.0",
  "signals": [
    { "id": "SIG-ATT-DWELL", "kind": "attention", "name": "Active dwell" },
    { "id": "SIG-ATT-SRCOPEN", "kind": "attention", "name": "Source open" },
    { "id": "SIG-ATT-CTXOPEN", "kind": "attention", "name": "Context open" },
    { "id": "SIG-ATT-RETURN", "kind": "attention", "name": "Return visit" },
    { "id": "SIG-ATT-TRAVERSE", "kind": "attention", "name": "Thread traversal" },
    { "id": "SIG-ATT-SAVE", "kind": "attention", "name": "Save for later" },
    { "id": "SIG-ATT-SHARE", "kind": "attention", "name": "Share outside app" },
    { "id": "SIG-PART-QUESTION", "kind": "participation", "name": "Clarifying question" },
    { "id": "SIG-PART-EVIDENCE", "kind": "participation", "name": "Evidence addition" },
    { "id": "SIG-PART-CORRECT", "kind": "participation", "name": "Correction" },
    { "id": "SIG-PART-SYNTH", "kind": "participation", "name": "Synthesis" },
    { "id": "SIG-PART-COUNTER", "kind": "participation", "name": "Counterexample" },
    { "id": "SIG-PART-DOMAIN", "kind": "participation", "name": "Domain explanation" },
    { "id": "SIG-PART-BRIDGE", "kind": "participation", "name": "Bridge comment" },
    { "id": "SIG-PART-STEWARD", "kind": "participation", "name": "Steward action" },
    { "id": "SIG-PROH-LIKES", "kind": "prohibited", "name": "Likes", "rnt": "RNT-001", "suite": "WS-I.3.1a" },
    { "id": "SIG-PROH-UPVOTES", "kind": "prohibited", "name": "Upvotes", "rnt": "RNT-002", "suite": "WS-I.3.1a" },
    { "id": "SIG-PROH-REACT", "kind": "prohibited", "name": "Hearts / reactions", "rnt": "RNT-003", "suite": "WS-I.3.1b" },
    { "id": "SIG-PROH-KARMA", "kind": "prohibited", "name": "Public karma", "rnt": "RNT-004", "suite": "WS-I.3.1c" },
    { "id": "SIG-PROH-FOLLOW", "kind": "prohibited", "name": "Follower counts", "rnt": "RNT-005", "suite": "WS-I.3.1c" },
    { "id": "SIG-PROH-DONOR", "kind": "prohibited", "name": "Donor badges", "rnt": "RNT-006", "suite": "WS-I.3.1c" },
    { "id": "SIG-PROH-TOKBAL", "kind": "prohibited", "name": "Token balances", "rnt": "RNT-007", "suite": "WS-I.3.1b" },
    { "id": "SIG-PROH-PAYAMT", "kind": "prohibited", "name": "Payment amounts", "rnt": "RNT-008", "suite": "WS-I.3.1b" },
    { "id": "SIG-PROH-TREAS", "kind": "prohibited", "name": "Treasury contributions", "rnt": "RNT-009", "suite": "WS-I.3.1d" },
    { "id": "SIG-PROH-DAOVOTE", "kind": "prohibited", "name": "DAO votes", "rnt": "RNT-010", "suite": "WS-I.3.1e" },
    { "id": "SIG-PROH-WALLET", "kind": "prohibited", "name": "Wallet connection status", "rnt": "RNT-011", "suite": "WS-I.3.1a" },
    { "id": "SIG-PROH-PAIDMEM", "kind": "prohibited", "name": "Paid membership", "rnt": "RNT-012", "suite": "WS-I.3.1f" },
    { "id": "SIG-PROH-NFT", "kind": "prohibited", "name": "NFT ownership", "rnt": "RNT-013", "suite": "WS-I.3.1b" },
    { "id": "SIG-PROH-GOVOUT", "kind": "prohibited", "name": "Governance vote outcomes", "rnt": "RNT-014", "suite": "WS-I.3.1e" },
    { "id": "SIG-ANTI-REPEAT", "kind": "anti", "name": "Rapid repetitive commenting", "conditioning": [] },
    { "id": "SIG-ANTI-BURST", "kind": "anti", "name": "Coordinated bursts", "conditioning": ["MFCI-1"] },
    { "id": "SIG-ANTI-RAGELOOP", "kind": "anti", "name": "Rage-loop behavior", "conditioning": [] },
    { "id": "SIG-ANTI-LOWINFO", "kind": "anti", "name": "Low-information replies", "conditioning": [] },
    { "id": "SIG-ANTI-NOEVID", "kind": "anti", "name": "Source-free accusation", "conditioning": [] },
    { "id": "SIG-ANTI-BRIGADE", "kind": "anti", "name": "Brigading reports", "conditioning": ["MFCI-2"] },
    { "id": "SIG-ANTI-HARASS", "kind": "anti", "name": "Harassment cascade", "conditioning": ["MFCI-1"] }
  ]
}
```

---

## Changelog

| Version | Date | Author | Change | Sign-off |
|---|---|---|---|---|
| 1.0.0 | 2026-06-08 | Doctrine & Policy WG | Initial ratified Signal Matrix: 7 attention + 8 participation allowlist signals (WS-A.1.1a), 14 prohibited signals with RNT→suite mapping (WS-A.1.1b), 7 base-rate-conditioned anti-signals (WS-A.1.1c). Signal-ID classes verified disjoint. | Reviewed and approved by Licio maintainer (M0 doctrine gate) |

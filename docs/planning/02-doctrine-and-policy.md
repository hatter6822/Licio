# WS-A: Doctrine, Policy, and Governance Configuration

| Field | Value |
|---|---|
| **Milestone** | M0 |
| **Priority** | 0 |
| **Dependencies** | None |
| **Wave** | 1 |
| **Estimated duration** | 1 week |

## Overview

WS-A is a document-only workstream that produces no code. It creates the policy artifacts that constrain all implementation decisions across every subsequent workstream. No ranking, moderation, governance, or financial code is written without these documents in place. The doctrine establishes what signals are allowed and prohibited, how moderation is structured, what transparency metrics are tracked and which are forbidden, how jurisdictional compliance works, and how steward roles operate. Every engineering task in the product must be traceable to a policy decision made here.

Because WS-A produces documents rather than code, "acceptance criteria" describe the structure, completeness, and approval state of each deliverable; "testing" describes the review, cross-reference, and consistency checks that confirm the document is internally complete and aligned with the SPEC; and "dependencies" describe which other documents or SPEC sections must be settled first. Each deliverable is an enumerable, machine-readable-where-possible artifact that downstream workstreams cite by stable identifier. The downstream consumers are explicitly named per task so that a change here triggers review there.

### How WS-A tasks are sized and sequenced

Each WS-A task targets 0.5-2 days of authoring and review and produces exactly one document or one self-contained section of a document. Where a single SPEC concept (for example, the moderation taxonomy) is large enough that one document would exceed two days, it is split into sub-IDs that are independently reviewable and independently approvable, so that the signal allowlist can be ratified while the denylist is still under review without blocking either. Existing task IDs are preserved verbatim; splits append a letter or numeric suffix (for example, WS-A.1.2 splits into WS-A.1.2a, WS-A.1.2b, ...). No reference elsewhere in the plan is broken by a split because the parent ID continues to denote the union of its sub-IDs.

### Document register

| Document | Produced by | Primary consumers |
|---|---|---|
| `docs/policy/SIGNAL_MATRIX.md` | WS-A.1.1a-c | WS-E (PWAtt), WS-H (invariants), WS-I (ranking + neutrality suite) |
| `docs/policy/MODERATION_TAXONOMY.md` | WS-A.1.2a-d | WS-J (T&S), WS-G (UGC safety), WS-P (transparency), WS-N (compliance) |
| `docs/policy/TRANSPARENCY_DICTIONARY.md` | WS-A.1.3a-c | WS-P (metrics, anti-metrics, transparency reports), WS-I (explanations) |
| `docs/policy/SIGNAL_TEST_MAP.md` | WS-A.1.4 | WS-I.3 (ranking-neutrality verification suite) |
| `docs/policy/JURISDICTION_MATRIX.md` | WS-A.2.1 | WS-N (jurisdiction engine), WS-L/WS-M (crypto features), WS-D.1.7 (age gating) |
| `docs/policy/STEWARD_ROLES.md` | WS-A.2.2 | WS-J (console authz), WS-D.1 (role grants, MFA), WS-O (audit) |
| `docs/policy/PRIVACY_REGULATION_MAP.md` | WS-A.2.3 | WS-D.2 (privacy controls), WS-E.1 (event retention), WS-N (compliance) |
| `docs/policy/CRYPTO_FEATURE_MATRIX.md` | WS-A.2.4 | WS-L/WS-M (Knomosis), WS-N (jurisdiction engine), WS-C.1.3 (flags) |

### Cross-cutting doctrinal invariants

Every WS-A document, and every downstream task that cites one, upholds these non-negotiable invariants. They are restated here so that a reviewer of any single document can confirm conformance without reading all eight:

1. **No applause primitives.** No likes, upvotes, hearts, public karma, public follower counts, or reaction badges may affect ranking, recommendation, search placement, notification priority, trend placement, recommendation eligibility, or author status (SPEC 2.4, 13.6).
2. **No pay-to-rank.** No payment, token purchase, treasury grant, DAO vote, NFT, stake, bounty, donor status, or paid membership may purchase distribution or visibility (SPEC 13.6, 17.1).
3. **Notice and appeal for significant actions.** Significant moderation and account actions carry a reason code, a readable statement of reasons, and an appeal path (SPEC 16.4, 18.3).
4. **Published support contact.** A support contact is reachable without authentication from every screen (SPEC 18.3, 18.4).
5. **Human review, not auto-removal, for policy-risk.** Automated systems may flag and prioritize but must not auto-remove policy-risk content; only high-confidence spam and malware are blocked automatically (SPEC 18.2).
6. **MFCI base-rate conditioning.** Coordination detection conditions on normal activity so that large authentic communities are not penalized for volume (SPEC 2.2, 8.x, 18.5).
7. **Privacy by design.** Sensitive attention signals are minimized, aggregated, retained for the shortest feasible period, and user-controllable; never sold and never used for behavioral advertising (SPEC 19).
8. **Fail-closed crypto.** Crypto features are feature-flagged by region and default off; the core social product never depends on crypto availability (SPEC 17.10).

---

## WS-A.1 No-applause doctrine

### WS-A.1.1 Signal allowlist/denylist

**ID:** WS-A.1.1
**Ref:** Sections 5.3, 13.6, 30.3-A, 30.6, 2.4

The signal matrix is the foundational policy document for Licio's no-applause architecture and is large enough that it is authored and ratified as three independently reviewable sub-deliverables that together compose `docs/policy/SIGNAL_MATRIX.md`: the allowed-signal allowlist (WS-A.1.1a), the prohibited-signal denylist with per-signal neutrality-test mapping (WS-A.1.1b), and the anti-signal catalog (WS-A.1.1c). The parent ID WS-A.1.1 denotes the union of the three and is the identifier other workstreams cite when they mean "the signal matrix." Splitting lets the denylist — the most consequential and most tightly coupled to the neutrality suite (WS-I.3) — be reviewed in isolation while the allowlist and anti-signal catalog proceed in parallel.

**Document-wide format requirements (apply to all three sub-deliverables):**
- Each signal category is a table with clear, fixed columns.
- Every prohibited signal carries a specific, testable ranking-neutrality assertion and a stable test ID.
- The document carries a version number, an owner, an effective date, and a changelog section.
- Cross-references to SPEC sections are inline next to each table.
- Every signal has a stable signal ID (for example, `SIG-ATT-DWELL`, `SIG-PROH-LIKES`, `SIG-ANTI-RAGELOOP`) so downstream feature schemas and tests can reference signals by identifier rather than by prose.

**Dependencies:** None. This is a Wave 1 root document; it gates WS-E.2 (PWAtt), WS-I.2 (feature store, ranking), and WS-I.3 (neutrality suite). WS-A.1.4 (signal-to-test map) consumes the denylist directly.

---

#### WS-A.1.1a Allowed positive signals (attention + participation)

**ID:** WS-A.1.1a
**Ref:** Sections 5.3, 2.4

**Description:**
Author the allowlist sections of `docs/policy/SIGNAL_MATRIX.md`: the attention-signal allowlist and the participation-signal allowlist. These enumerate the only signals that may contribute positively to PWAtt ranking, each bound to a required guardrail so that an allowed signal cannot be silently weaponized into an applause proxy. The allowlist is closed: a signal not present here may not contribute positively to ranking without a doctrine amendment and a corresponding neutrality-suite update.

**Allowed positive signals (Section 5.3 — attention signals):**

These signals may contribute positively to PWAtt ranking, subject to guardrails:

| Signal ID | Signal | Description | Guardrail |
|---|---|---|---|
| SIG-ATT-DWELL | Active dwell | Reading with foreground focus and normal scroll cadence | Capped per item; ignore idle time and screen-on inactivity |
| SIG-ATT-SRCOPEN | Source open | Opening the original article, document, dataset, or evidence | Do not reward clickbait if the user immediately returns |
| SIG-ATT-CTXOPEN | Context open | Opening context cards, source history, or claim timeline | Count once per meaningful session |
| SIG-ATT-RETURN | Return visit | Returning after time away, indicating sustained interest | Avoid rewarding obsessive loops |
| SIG-ATT-TRAVERSE | Thread traversal | Reading multiple branches or opposing views | Weight nonredundant traversal above repeated same-branch reading |
| SIG-ATT-SAVE | Save for later | Privately marking content to revisit | Private by default; low rank weight |
| SIG-ATT-SHARE | Share outside app | Sending a link externally | Low rank weight until recipient attention or participation occurs |

**Allowed positive signals (Section 5.3 — participation signals):**

These public actions may contribute positively to PWAtt ranking based on quality and downstream thread improvement:

| Signal ID | Signal | Description | Ranking effect |
|---|---|---|---|
| SIG-PART-QUESTION | Clarifying question | Asks what evidence supports a claim, identifies ambiguity | Positive if it elicits useful answers or identifies ambiguity |
| SIG-PART-EVIDENCE | Evidence addition | Adds primary source, dataset, transcript, legal text, credible report | Strong positive if cited and relevant |
| SIG-PART-CORRECT | Correction | Identifies false quote, wrong date, missing caveat, broken link | Strong positive when accepted or corroborated |
| SIG-PART-SYNTH | Synthesis | Summarizes multiple branches fairly | Positive when it reduces context obstruction or repetition |
| SIG-PART-COUNTER | Counterexample | Adds a relevant exception or opposing case | Positive when it broadens the evidence base |
| SIG-PART-DOMAIN | Domain explanation | Explains technical, legal, scientific, or local context | Positive if nonredundant and useful to readers |
| SIG-PART-BRIDGE | Bridge comment | Translates one community's interpretation for another | Strong positive when SCOI decreases |
| SIG-PART-STEWARD | Steward action | Moderation clarification, rule reminder, merge suggestion | Positive for thread health, not personal fame |

**Guardrail rationale (per the no-applause doctrine):**
- Every attention signal is a *salience* signal, not an endorsement (SPEC 5.2); the guardrail column states the specific mechanism that prevents salience from being read as approval.
- Participation signals are rewarded for *thread-state improvement*, not volume; the ranking-effect column is conditional on outcome (cited, accepted, corroborated, SCOI decreased) so that quantity alone cannot earn rank.
- No signal in this allowlist may be aggregated into a public per-user score; aggregation is private and surfaced only through the Signal Ledger (SPEC 5.1, 19.3).

**Acceptance criteria:**
- The allowlist sections of `docs/policy/SIGNAL_MATRIX.md` exist and are complete.
- All 7 attention signals from Section 5.3 are listed with stable signal IDs and guardrails.
- All 8 participation signals from Section 5.3 are listed with stable signal IDs and ranking effects.
- The allowlist is explicitly stated to be closed (additions require a doctrine amendment).
- Each guardrail names the concrete mechanism that prevents applause-proxy behavior.
- The section is reviewed and approved by at least one project maintainer.

**Testing:**
- Cross-reference check: every signal in SPEC 5.3 attention and participation tables maps to exactly one row here.
- Consistency check: every signal ID is unique and matches the naming convention.
- Doctrine check: no allowlisted signal is also an anti-signal (WS-A.1.1c) or a prohibited signal (WS-A.1.1b); IDs are disjoint.
- Review sign-off recorded in the document changelog.

**Dependencies:** None. Consumed by WS-E.2 (PWAtt scoring inputs) and WS-A.1.1b (which must reference the closed allowlist to define "everything else is excluded").

---

#### WS-A.1.1b Prohibited signals + neutrality-test mapping

**ID:** WS-A.1.1b
**Ref:** Sections 13.6, 30.6, 2.4

**Description:**
Author the prohibited-signal section of `docs/policy/SIGNAL_MATRIX.md`. These signals are absolutely prohibited from influencing ranking, recommendation, search placement, notification priority, trend placement, recommendation eligibility, or author status. Each prohibited signal carries (a) a rationale, (b) a precise, testable ranking-neutrality assertion, and (c) the stable neutrality-test ID under which it is verified. This section is the policy half of the contract with the neutrality verification suite (WS-I.3); the engineering half is the executable test referenced by `WS-I.3.1*`, and the bridging document is `docs/policy/SIGNAL_TEST_MAP.md` (WS-A.1.4).

**Prohibited signals (Section 13.6 — must NEVER affect ranking):**

| Signal ID | Prohibited signal | Rationale | Ranking-neutrality assertion | Neutrality test |
|---|---|---|---|---|
| SIG-PROH-LIKES | Likes | Do not exist in the platform; no like button | Feed replay with a hypothetical like field produces identical ranking order | RNT-001 → WS-I.3.1a |
| SIG-PROH-UPVOTES | Upvotes | Do not exist in the platform; no upvote button | Feed replay with a hypothetical upvote field produces identical ranking order | RNT-002 → WS-I.3.1a |
| SIG-PROH-REACT | Hearts / reactions | Applause mechanics measuring popularity, not quality | No reaction counter field exists in any ranking feature schema | RNT-003 → WS-I.3.1b |
| SIG-PROH-KARMA | Public karma | Aggregate reputation scores create gaming incentives | No karma field is readable by ranking services; karma absent from PWAtt inputs | RNT-004 → WS-I.3.1c |
| SIG-PROH-FOLLOW | Follower counts | Popularity metric rewarding celebrity, not contribution | Follower count absent from PWAtt and all invariant joins | RNT-005 → WS-I.3.1c |
| SIG-PROH-DONOR | Donor badges | Financial-status signal that creates pay-to-rank | Donor status/badge absent from all organic feature schemas | RNT-006 → WS-I.3.1c |
| SIG-PROH-TOKBAL | Token balances | Crypto-wealth signal | Token balance absent from PWAtt feature inputs | RNT-007 → WS-I.3.1b |
| SIG-PROH-PAYAMT | Payment amounts | Financial-transaction data | Payment amount absent from all organic ranking features | RNT-008 → WS-I.3.1b |
| SIG-PROH-TREAS | Treasury contributions | Room financial contributions | Treasury contribution absent from story rank computation | RNT-009 → WS-I.3.1d |
| SIG-PROH-DAOVOTE | DAO votes | Governance participation | DAO vote outcomes do not change claim labels without evidence/steward process | RNT-010 → WS-I.3.1e |
| SIG-PROH-WALLET | Wallet connection status | Whether a user has linked a wallet | Feed replay for wallet-linked vs non-linked users yields identical ranking | RNT-011 → WS-I.3.1a |
| SIG-PROH-PAIDMEM | Paid membership | Subscription status | Paid membership does not bypass safety, rate limits, or moderation | RNT-012 → WS-I.3.1f |
| SIG-PROH-NFT | NFT ownership | Token-ownership status | NFT ownership absent from all ranking and recommendation features | RNT-013 → WS-I.3.1b |
| SIG-PROH-GOVOUT | Governance vote outcomes | DAO proposal results (without evidence process) | Governance outcomes require evidence/steward review before any ranking effect | RNT-014 → WS-I.3.1e |

**Scope of the prohibition (each prohibited signal is excluded from all of):**
ranking score, candidate generation eligibility, search placement and ordering, notification priority and eligibility, trend/Front-Page placement, recommendation eligibility, author/source status used in ranking, and any derived feature computed from a prohibited signal. Derivation does not launder a prohibited signal: a feature engineered from token balance is itself prohibited.

**One permitted, tightly-bounded exception (documented to prevent ambiguity):**
Treasury contribution may surface content *only* through a manually approved, clearly labeled public-interest prompt on a dedicated treasury surface that the user has opted into; this is not organic ranking and is verified separately (RNT-009 / WS-I.3.1d, and labeling under WS-I.3.1h). The exception is enumerated here so the prohibition elsewhere is unambiguous.

**Acceptance criteria:**
- The prohibited-signal section of `docs/policy/SIGNAL_MATRIX.md` exists and is complete.
- All 14 prohibited signals from Section 13.6 are listed with stable signal IDs, rationale, a testable assertion, and a neutrality-test mapping.
- Every prohibited signal maps to exactly one RNT test ID and to its canonical engineering test (`WS-I.3.1*`).
- The scope-of-prohibition statement explicitly covers derived features.
- The single bounded treasury exception is enumerated and pointed at its verification test.
- The section is reviewed and approved.

**Testing:**
- Coverage check: every signal in SPEC 13.6's prohibition list is present; count equals 14.
- Bidirectional mapping check: each RNT-NNN here appears in WS-A.1.4 and maps to an existing `WS-I.3.1*` test; no orphans in either direction.
- Disjointness check: prohibited signal IDs do not overlap allowlist (WS-A.1.1a) or anti-signal (WS-A.1.1c) IDs.
- Review sign-off recorded in the changelog.

**Security/privacy:** This section is the doctrinal root of the pay-to-rank defense (Risk Matrix: "Pay-to-rank leakage — Critical"). It pairs with the schema-level feature-store denylist (WS-I.2.1) and the continuously enforced neutrality suite (WS-I.3). Treating derived features as prohibited closes the laundering path where a financial signal re-enters ranking through an engineered feature.

**Dependencies:** WS-A.1.1a (closed allowlist, so "everything financial is excluded" is well-defined). Gates WS-A.1.4, WS-I.2.1, and WS-I.3.

---

#### WS-A.1.1c Anti-signals and penalty responses

**ID:** WS-A.1.1c
**Ref:** Sections 5.3, 25.5, 18.5

**Description:**
Author the anti-signal section of `docs/policy/SIGNAL_MATRIX.md`. Anti-signals are detected patterns that reduce or penalize ranking, trigger rate limiting, or route to safety review. Each anti-signal carries a stable ID, the detection basis, the graduated response, and the safety/integrity owner. Anti-signals are distinct from prohibited signals: prohibited signals must never have *any* ranking effect; anti-signals deliberately have a *negative* ranking effect or a protective effect, conditioned on base rates so authentic enthusiasm is not punished (SPEC 2.2).

**Anti-signals (Section 5.3 — signals that reduce or penalize ranking):**

| Signal ID | Anti-signal | Detection basis | Response | Owner |
|---|---|---|---|---|
| SIG-ANTI-REPEAT | Rapid repetitive commenting | Velocity + similarity from one account | Damp participation weight; possible rate limit | WS-J.2.6c, WS-E.2.2 |
| SIG-ANTI-BURST | Coordinated bursts | MFCI synchrony beyond base rate | Apply MFCI penalty and review threshold | WS-H.3, WS-I.2.4 |
| SIG-ANTI-RAGELOOP | Rage-loop behavior | Repeated hostile returns to same target/thread | Do not convert hostile returns into positive attention | WS-E.2.2, WS-H.6 |
| SIG-ANTI-LOWINFO | Low-information replies | Classifier: volume without contribution value | Count as conversation volume but not constructive participation | WS-K, WS-E.2.2 |
| SIG-ANTI-NOEVID | Source-free accusation | Accusatory claim lacking cited evidence | Require evidence or downweight | WS-G, WS-E.2.2 |
| SIG-ANTI-BRIGADE | Brigading reports | MFCI coordination on reporting pattern | Report impact conditioned by MFCI and reporter reputation | WS-J.1.1d, WS-J.2.6e |
| SIG-ANTI-HARASS | Harassment cascade | Safety classifier + target-concentration | Freeze ranking growth; safety review; protect targets | WS-J.1, WS-H.3 |

**Conditioning requirement (anti-applause must not become anti-authenticity):**
Each anti-signal response is conditioned so that normal high-volume authentic activity (a large community discussing a major event) is not mistaken for manipulation. The conditioning basis for coordination-related anti-signals is the MFCI base-rate model (MFCI-1: large normal communities are not penalized solely for volume). Reporting-based anti-signals additionally condition on reporter reputation and the MFCI coordinated-reporting check (MFCI-2: coordinated reporting has delayed enforcement until reviewed).

**Acceptance criteria:**
- The anti-signal section of `docs/policy/SIGNAL_MATRIX.md` exists and is complete.
- All 7 anti-signals from Section 5.3 are listed with stable IDs, detection basis, graduated response, and owner.
- Each anti-signal states its base-rate conditioning so authentic enthusiasm is protected.
- Owners reference the concrete downstream task that implements detection/response.
- The section is reviewed and approved.

**Testing:**
- Coverage check: every anti-signal in SPEC 5.3 is present; count equals 7.
- Conditioning check: each coordination/reporting anti-signal cites MFCI-1 and/or MFCI-2.
- Disjointness check: anti-signal IDs do not overlap allowlist or prohibited-signal IDs.
- Review sign-off recorded in the changelog.

**Security/privacy:** Anti-signals are a behavioral abuse-defense layer (SPEC 25.5, "no device attestation"). Documenting graduated, reversible responses (damp → rate limit → review, not silent ban) preserves the notice-and-appeal invariant and the human-review-not-auto-removal invariant for ambiguous cases.

**Dependencies:** WS-A.1.1a and WS-A.1.1b (IDs must be disjoint). Consumed by WS-E.2.2 (anti-signals), WS-H.3 (MFCI), WS-J.1.1d / WS-J.2.6 (reporting and pre-checks).

---

### WS-A.1.2 Moderation-escalation taxonomy

**ID:** WS-A.1.2
**Ref:** Sections 18.1, 18.2, 18.3, 18.4, 18.5

The moderation taxonomy is the operational reference for all moderation decisions and is large enough that it is authored as four independently reviewable sub-deliverables composing `docs/policy/MODERATION_TAXONOMY.md`: the 12 policy categories with severity/SLA/reason codes (WS-A.1.2a), the moderation layers and escalation path (WS-A.1.2b), the appeal-eligibility matrix (WS-A.1.2c), and the crypto-specific abuse modes (WS-A.1.2d). The parent ID WS-A.1.2 denotes the union and is the identifier other workstreams cite (for example, `WS-J.1.1a` validates reason codes against "the moderation taxonomy (WS-A.1.2)"). Every moderation action anywhere in the product references a category and reason code defined here. The taxonomy is enumerable and machine-readable so that moderation tooling, transparency reports, and audit logs reference it programmatically.

**Document-wide format requirements (apply to all four sub-deliverables):**
- Machine-readable reason codes (for example, `MOD_HARASS_001`, `MOD_CRYPTO_DRAIN_001`); each category owns a unique namespace.
- A canonical machine-readable enumeration block (a fenced code listing of `{category_id, reason_code, severity_default, appealable, sla_target}`) so tooling can ingest the taxonomy without parsing prose.
- Version number, owner, effective date, and changelog.
- Cross-references to SPEC sections inline.

**Dependencies:** None as a root document; WS-A.1.2d (crypto abuse) is logically downstream of the crypto-feature posture (WS-A.2.4) but may be authored in parallel. Gates WS-J (all report/appeal/console tasks) and WS-G.4 (UGC safety).

---

#### WS-A.1.2a Policy categories, severity, SLA, reason codes

**ID:** WS-A.1.2a
**Ref:** Sections 18.1, 18.3

**Description:**
Author the policy-category section of `docs/policy/MODERATION_TAXONOMY.md` defining all 12 policy categories. Each category includes: definition, severity levels (minor/moderate/severe/critical), illustrative examples, required evidence, escalation trigger, response SLA, default appeal eligibility, and a reason-code namespace with at least the most common reason codes enumerated.

**12 policy categories (Section 18.1):**

| # | Category ID | Category | Description | Severity range | Reason-code namespace |
|---|---|---|---|---|---|
| 1 | MOD_ILLEGAL | Illegal content | Content violating applicable law in the jurisdiction of viewer or poster | Severe — Critical | `MOD_ILLEGAL_*` |
| 2 | MOD_THREAT | Credible threats and incitement | Direct threats of violence; incitement to imminent lawless action | Critical | `MOD_THREAT_*` |
| 3 | MOD_HARASS | Harassment and targeted abuse | Targeted, sustained hostility against individuals or small groups | Minor — Severe | `MOD_HARASS_*` |
| 4 | MOD_HATE | Hate and dehumanization | Attacks on people based on protected characteristics | Moderate — Critical | `MOD_HATE_*` |
| 5 | MOD_CSE | Sexual exploitation and child safety | CSAM, grooming, sextortion, non-consensual intimate imagery | Critical | `MOD_CSE_*` |
| 6 | MOD_GRAPHIC | Graphic or shocking content | Gratuitous violence, gore, self-harm instruction or promotion | Moderate — Severe | `MOD_GRAPHIC_*` |
| 7 | MOD_MISINFO | Medical, civic, and crisis misinformation | Provably false claims about health, voting, emergencies causing imminent harm | Moderate — Severe | `MOD_MISINFO_*` |
| 8 | MOD_IMPERS | Impersonation and deceptive identity | Pretending to be another person, organization, or official entity | Moderate — Severe | `MOD_IMPERS_*` |
| 9 | MOD_SPAM | Spam and platform manipulation | Automated posting, fake engagement, coordinated inauthentic behavior | Minor — Severe | `MOD_SPAM_*` |
| 10 | MOD_PRIVACY | Privacy violations and doxxing | Publishing private information without consent | Moderate — Critical | `MOD_PRIVACY_*` |
| 11 | MOD_SYNTH | Synthetic-media disclosure | AI-generated/manipulated media presented without disclosure | Minor — Severe | `MOD_SYNTH_*` |
| 12 | MOD_IP | Intellectual-property reports | Copyright, trademark, or other IP infringement claims | Minor — Moderate | `MOD_IP_*` |

**Severity levels and SLA targets:**

| Severity | Response SLA | Examples |
|---|---|---|
| Minor | 72 hours | Low-information spam, minor formatting abuse, unintentional duplicate |
| Moderate | 24 hours | Harassment (isolated), impersonation attempt, undisclosed synthetic media |
| Severe | 4 hours | Sustained harassment, hate speech, privacy violation, coordinated manipulation |
| Critical | 1 hour | Credible threat to life, CSAM, child grooming, imminent harm, illegal content |

**Per-category required-evidence and escalation-trigger fields (specified for each of the 12 categories in the document):**
- *Required evidence* — what a reviewer must see to act (for example, MOD_IMPERS requires a comparison to the impersonated entity; MOD_IP requires a rights claim and identification of the work).
- *Escalation trigger* — the condition that routes the case to the next layer (for example, MOD_CSE escalates immediately to external escalation; MOD_MISINFO escalates to professional moderation when imminent-harm criteria are met).
- *Reason-code examples* — at least three representative codes per namespace (for example, `MOD_HARASS_001` targeted insults, `MOD_HARASS_002` sustained pile-on, `MOD_HARASS_003` off-platform-coordinated harassment).

**Acceptance criteria:**
- The policy-category section of `docs/policy/MODERATION_TAXONOMY.md` exists and is complete.
- All 12 categories from Section 18.1 are defined with category IDs, severity ranges, examples, required evidence, escalation triggers, SLAs, and reason-code namespaces.
- SLA targets are defined for each severity level.
- A canonical machine-readable enumeration block lists every reason code with its default severity and appealability.
- Reason codes follow the namespace convention and are unique.
- The section is reviewed and approved.

**Testing:**
- Coverage check: all 12 SPEC 18.1 categories present; count equals 12.
- Schema check: the machine-readable enumeration parses and every reason code has the required fields.
- SLA check: every severity level has exactly one SLA target; no category lacks a default severity.
- Review sign-off recorded in the changelog.

**Dependencies:** None. Gates WS-J.1.1a (reason-code validation), WS-J.2.3 (action palette reason codes), WS-G.4 (UGC safety mapping), WS-P (transparency reason-code breakdowns).

---

#### WS-A.1.2b Moderation layers and escalation path

**ID:** WS-A.1.2b
**Ref:** Sections 18.2, 16.3, 29.3

**Description:**
Author the moderation-layers section of `docs/policy/MODERATION_TAXONOMY.md` documenting the six moderation layers, the function of each, the escalation trigger that moves a case from one layer to the next, and the steward role(s) (WS-A.2.2) that operate at each layer. This section is the operational spine that the moderation console (WS-J.2) and the coordination-incident workflow (SPEC 29.3) follow.

**Moderation layers and escalation path (Section 18.2):**

| Layer | Function | Operated by | Escalation trigger |
|---|---|---|---|
| User controls | Mute, block, report, hide topic, reduce personalization | End user | User initiates report |
| Automated pre-checks | Detect obvious spam, malware links, duplicate floods, policy-risk content | System (WS-J.2.6) | Automated flag exceeds threshold; policy-risk flag routes to human |
| Community stewardship | Context repair, duplicate merge, branch organization, soft warnings | Community steward, Evidence steward | Steward cannot resolve; policy violation suspected |
| Professional moderation | Policy enforcement, urgent safety, appeals | Safety moderator, Appeals reviewer | Severity ≥ severe; legal risk; cross-room pattern |
| Integrity review | Coordination, brigading, bot activity, suspicious campaigns | Integrity analyst | MFCI flag; multi-account pattern; financial-fraud signal |
| External escalation | Legal, child safety, imminent harm, regulator requests | Safety lead + counsel | Imminent physical danger; CSAM; law-enforcement request |

**Escalation-path requirements:**
- Each transition names the *minimum role* authorized to act at the receiving layer (consistent with WS-A.2.2 capabilities).
- The automated pre-check layer never auto-removes policy-risk content; it flags and prioritizes for the human layers (cross-cutting invariant 5; SPEC 18.2). Only high-confidence spam (WS-J.2.6a) and malware (WS-J.2.6b) are auto-blocked.
- The integrity-review layer follows the coordination-incident workflow (SPEC 29.3): detect → assign severity → slow/freeze acceleration if threshold met → analyst case with preserved margins/baselines → moderator action or false-positive clear → public label update if distribution affected → log for transparency.
- External escalation specifies the irreversibility and additional-approval requirements that pair with WS-A.2.2 (irreversible actions require additional approval).

**Acceptance criteria:**
- The moderation-layers section exists and is complete.
- All 6 layers from Section 18.2 are documented with function, operating role(s), and escalation trigger.
- The "flag, do not auto-remove, for policy-risk" rule is stated explicitly with the two enumerated auto-block exceptions.
- The escalation path is consistent with the coordination-incident workflow (SPEC 29.3) and with steward capabilities (WS-A.2.2).
- The section is reviewed and approved.

**Testing:**
- Coverage check: all 6 SPEC 18.2 layers present.
- Consistency check: every operating role referenced exists in WS-A.2.2; every escalation trigger has a receiving layer.
- Workflow check: the integrity-review steps match SPEC 29.3 stage-for-stage.
- Review sign-off recorded in the changelog.

**Dependencies:** WS-A.2.2 (steward roles, for the operating-role column). Gates WS-J.2 (console queue/escalation), WS-J.2.6 (pre-check routing).

---

#### WS-A.1.2c Appeal-eligibility matrix

**ID:** WS-A.1.2c
**Ref:** Sections 16.4, 18.3

**Description:**
Author the appeal-eligibility section of `docs/policy/MODERATION_TAXONOMY.md` defining, for every action type and significant decision, whether it is appealable, under what conditions, to which role, and within what window. This is the policy source that WS-J.1.3a (appeal eligibility rules) implements; the two must agree exactly.

**Appeal eligibility by action type:**

| Action type | Appealable | Condition | Reviewed by |
|---|---|---|---|
| Warn | Yes | Immediately after action | Appeals reviewer |
| Hide (content) | Yes | Immediately after action | Appeals reviewer |
| Remove (content) | Yes | Immediately after action; except CSAM and imminent threat | Appeals reviewer |
| Restrict (account, temporary) | Yes | Immediately after action | Appeals reviewer |
| Shadow action (reduced distribution) | Yes | User must be notified the action occurred; then appealable | Appeals reviewer |
| Temporary suspension | Yes | After a cooling period | Appeals reviewer |
| Permanent ban | Yes | Once, after a cooldown (default 24h) | Senior appeals reviewer |
| Emergency restriction | No (deferred) | Not appealable until the emergency review completes; the resulting action is then appealable | Safety moderator → Appeals reviewer |
| Room governance freeze | Yes | Appealable to integrity analyst | Integrity analyst |
| Treasury freeze | Yes | Requires documented review | Integrity analyst + counsel |

**Notice-and-appeal requirements (SPEC 16.4, 18.3):**
- Every significant action produces a readable statement of reasons including the reason code, and where the action is appealable, the appeal path and any cooldown.
- Shadow/reduced-distribution actions are not silent: the user is notified, satisfying the "no hidden sanctions" principle that pairs with the invariant fallback requirement.
- Ineligible-appeal states display *why* the appeal is unavailable and *when* it becomes available.

**Acceptance criteria:**
- The appeal-eligibility section exists and is complete.
- Every action type and significant decision has a documented appealability, condition, and reviewing role.
- Non-appealable exceptions (CSAM, imminent threat, in-flight emergency review) are explicitly enumerated.
- Shadow/reduced-distribution actions are documented as requiring user notice.
- The matrix is consistent with WS-J.1.3a.
- The section is reviewed and approved.

**Testing:**
- Coverage check: every action in the WS-J action palette (WS-J.2.3) has an eligibility row.
- Consistency check: this matrix and WS-J.1.3a agree on every row.
- Doctrine check: notice-and-appeal invariant satisfied for all "significant" actions; no silent shadow actions.
- Review sign-off recorded in the changelog.

**Dependencies:** WS-A.1.2a (action/severity definitions), WS-A.2.2 (reviewing roles). Mirrored by WS-J.1.3a; consumed by WS-J.1.3b-d and WS-J.2.4.

---

#### WS-A.1.2d Crypto-specific abuse modes

**ID:** WS-A.1.2d
**Ref:** Sections 18.5, 17.10, 25.6

**Description:**
Author the crypto-abuse section of `docs/policy/MODERATION_TAXONOMY.md` enumerating the abuse modes introduced by Knomosis-enabled rooms. Each mode has indicators, a response playbook, the responsible layer/role, audit requirements, and (where applicable) the public-incident-note trigger. These modes extend the taxonomy with crypto-specific reason codes (`MOD_CRYPTO_*`).

**Crypto-specific abuse modes (Section 18.5):**

| Mode ID | Abuse mode | Indicators | Response |
|---|---|---|---|
| MOD_CRYPTO_DRAIN | Wallet-drainer links | Links to malicious dApps that drain connected wallets | Link interstitials, URL blocklist, immediate removal, user notification |
| MOD_CRYPTO_SIG | Malicious signature prompts | Tricking users into signing harmful transactions | Signing-preview enforcement, allowlist validation, account action |
| MOD_CRYPTO_IMPERS | Impersonation (financial) | Impersonating stewards, rooms, journalists, grant recipients, support | Identity verification, content removal, account suspension |
| MOD_CRYPTO_BOUNTY | Bounty collusion | Fake completion evidence, coordinated false verification | Steward review requirement, MFCI monitoring, payout hold |
| MOD_CRYPTO_VOTEBUY | Vote buying and coercion | Purchasing or coercing governance votes | MFCI detection, proposal challenge, governance freeze |
| MOD_CRYPTO_BRIBE | Bribery | Offering payment for specific moderation/governance outcomes | Audit-trail review, account action, law enforcement if warranted |
| MOD_CRYPTO_CAPTURE | Treasury capture | Wealthy/coordinated actors seizing treasury control | Capped voting power, role quorums, fork/exit provisions, challenge windows |
| MOD_CRYPTO_SANCTION | Sanctions evasion | Restricted actors transacting on the platform | Compliance screening, region gating, transaction monitoring, freeze |
| MOD_CRYPTO_PAIDHARASS | Paid harassment/brigading | Financial incentives coordinating harassment | MFCI detection, target protection, treasury freeze, law enforcement |
| MOD_CRYPTO_PAIDREPORT | Paid report abuse | Paying users to file false reports | Report-quality analysis, reporter reputation, integrity review |
| MOD_CRYPTO_PAIDDISINFO | Paid disinformation | Undisclosed paid promotion/coordinated influence | Disclosure requirements, MFCI detection, content labeling, account action |
| MOD_CRYPTO_INVEST | Misleading investment claims | Presenting crypto features as investment opportunities | Content labeling, risk disclosures, removal if fraudulent |
| MOD_CRYPTO_GRANTFRAUD | Fraudulent grants | Fake charities, fabricated invoices, phantom evidence | Steward review, audit log, fraud queue, treasury freeze |
| MOD_CRYPTO_INVOICE | Fabricated invoices | False financial claims against room treasuries | Multi-steward approval, evidence verification, challenge window |
| MOD_CRYPTO_DAOREVEAL | DAO vote to reveal private info | Using governance votes to expose private moderation/reporting data | Platform-policy override; DAO supremacy does not extend to privacy |

**Cross-cutting crypto-abuse requirements:**
- Responses draw on the wallet/contract security controls (SPEC 25.6): typed-signing previews, contract allowlists, emergency feature flags, just-in-time warnings.
- A *public incident note* is required when a treasury is materially affected (SPEC 18.5); the trigger threshold and note template are specified here.
- The DAO-reveal mode (`MOD_CRYPTO_DAOREVEAL`) is a hard platform-policy override: no governance vote can compel disclosure of reporter identities, private moderation data, or minors' data (consistent with SPEC 19.5 and the privacy invariant). This is the doctrinal counterpart to the "moderation override" M6 gate.
- All crypto-abuse actions are logged with the standard audit fields plus the affected treasury/room and any on-chain reference (off-chain record with on-chain hash commitment where auditability is needed; SPEC 19.5).

**Acceptance criteria:**
- The crypto-abuse section exists and is complete.
- All 15 crypto-specific abuse modes from Section 18.5 are documented with mode IDs, indicators, and responses.
- The public-incident-note trigger and template are specified.
- The DAO-reveal override is documented as absolute and tied to the privacy invariant and the M6 moderation-override gate.
- Crypto reason codes follow the `MOD_CRYPTO_*` namespace and appear in the machine-readable enumeration.
- The section is reviewed and approved.

**Testing:**
- Coverage check: all 15 SPEC 18.5 modes present; count equals 15.
- Control mapping check: each response references at least one concrete control (interstitial, allowlist, freeze, MFCI, challenge window) and, where relevant, a SPEC 25.6 control.
- Override check: the DAO-reveal override is unconditional and cross-referenced to SPEC 19.5 and the M6 gate.
- Review sign-off recorded in the changelog.

**Security/privacy:** This section is the policy basis for the Critical "Smart contract bug" and "XSS → wallet drain" risk lines. It enforces that financial-integrity responses (freezes, holds, challenge windows) are reversible-where-possible and audited, and that no governance mechanism can erode privacy.

**Dependencies:** WS-A.2.4 (crypto-feature posture/tiers), WS-A.1.2a (base namespaces). Gates WS-J crypto-abuse handling, WS-L/WS-M (Knomosis safety responses), WS-N (sanctions/compliance).

---

### WS-A.1.3 Transparency-report data dictionary

**ID:** WS-A.1.3
**Ref:** Sections 28.1, 28.2, 28.3, 28.4

The transparency dictionary defines what is published, how it is privacy-protected, and what must never be optimized for. It is authored as three independently reviewable sub-deliverables composing `docs/policy/TRANSPARENCY_DICTIONARY.md`: the product-health and safety metric definitions with privacy thresholds (WS-A.1.3a), the Knomosis governance/payment metrics (WS-A.1.3b), and the anti-metrics plus experimentation rules (WS-A.1.3c). The parent ID WS-A.1.3 denotes the union. This dictionary ensures transparency reporting is consistent, privacy-preserving, and aligned with the no-applause doctrine.

**Document-wide format requirements:**
- Every metric maps to a metric ID, a definition, a data source, a responsible workstream, an aggregation method, a privacy threshold (minimum count before publishing), and a report cadence.
- Small-cell suppression rule is stated once and applied to every metric: suppress any cell below its privacy threshold.
- Version number, owner, effective date, and changelog.

**Dependencies:** WS-A.1.1 (signal IDs, so metrics like source-open rate reference canonical signals) and WS-A.1.2 (reason codes, so safety metrics break down by category). Gates WS-P (metrics, transparency reports) and informs WS-I.2.6 (explanations).

---

#### WS-A.1.3a Product-health + safety metric definitions

**ID:** WS-A.1.3a
**Ref:** Sections 28.1, 28.4, 19.1

**Description:**
Author the product-health and safety metric section of `docs/policy/TRANSPARENCY_DICTIONARY.md`. Each metric includes definition, data source, responsible workstream, aggregation method, privacy threshold, and report cadence.

**Product-health metrics (Section 28.1):**

| Metric ID | Metric | Definition | Data source | Privacy threshold |
|---|---|---|---|---|
| TM-CPR | Constructive-participation rate | Fraction of contributions classified constructive (evidence, correction, synthesis, bridge, question) | Contribution classifier (WS-K) | Min 100 contributions/period |
| TM-SOR | Source-open rate | Fraction of story views where the user opened the original source | Attention event pipeline (WS-E) | Min 1000 views/period |
| TM-EAR | Evidence-addition rate | Rate of evidence cards added per active thread | Evidence submissions (WS-F) | Min 50 threads/period |
| TM-QRR | Question-resolution rate | Fraction of clarifying questions receiving a substantive answer | Thread state tracker (WS-G) | Min 50 questions/period |
| TM-MERI | MERI distribution | Distribution of nonredundancy scores across feeds and topics | MERI service (WS-H.2) | Aggregate only; no per-user scores |
| TM-SCOI | SCOI reduction after bridge/synthesis | Change in obstruction score after bridge/synthesis contributions | SCOI service (WS-H.4) | Min 20 bridge events/period |
| TM-MFCI | MFCI incidents by severity | Count and severity distribution of coordination incidents | MFCI service (WS-H.3) | Aggregate only; no individual cases |
| TM-GWEI | GWEI cohort disparity | Structural experience parity across defined cohorts | GWEI service (WS-H.5) | Min 5 cohorts; none < 100 users |
| TM-PHI | PHI steering-risk distribution | Distribution of path-dependency risk scores | PHI service (WS-H.6) | Aggregate only; no per-user scores |
| TM-HPL | Harassment-protection latency | Time from harassment report to target protection | Safety queue logs (WS-J) | Aggregate; no individual case timing |
| TM-AOR | Appeal-overturn rate | Fraction of appeals resulting in reversal | Appeals system (WS-J.1.3) | Min 20 appeals/period |
| TM-ADR | Accessibility-defect rate | Accessibility regression defects per release | QA tracking (WS-B/WS-0) | Per release |
| TM-CWV | Core Web Vitals (LCP, INP, CLS) | Performance at p75 across real users | RUM / field data (WS-P) | Min 1000 page loads/period |

**Safety and moderation transparency breakdowns:**
- Moderation actions by category and severity, using reason-code namespaces from WS-A.1.2a, aggregated; no individual cases below threshold.
- Appeal outcomes (overturn/uphold/modify) aggregated; reviewer identities never published.
- Coordinated-report incidents (count, share resolved as false positives) aggregated; reporter identities never published (privacy invariant; SPEC 25.5).

**Report cadence:**
- Product-health metrics: monthly.
- Safety and moderation metrics: monthly (weekly internal review).
- Core Web Vitals: continuous monitoring, monthly report.

**Acceptance criteria:**
- The product-health/safety section exists and is complete.
- All 13 product-health metrics from Section 28.1 are defined with metric IDs, data sources, responsible workstreams, and privacy thresholds.
- Safety breakdowns reference WS-A.1.2 reason-code namespaces and never expose individual identities.
- Report cadence is specified for each metric class.
- Small-cell suppression is applied to every metric.
- The section is reviewed and approved.

**Testing:**
- Coverage check: all 13 SPEC 28.1 metrics present; each maps to a responsible workstream.
- Privacy check: every metric has a privacy threshold and suppression rule; no metric exposes per-user scores where prohibited.
- Cross-reference check: safety breakdowns use existing reason-code namespaces (WS-A.1.2a).
- Review sign-off recorded in the changelog.

**Dependencies:** WS-A.1.1 (signal IDs), WS-A.1.2a (reason codes). Gates WS-P.2 (transparency reports).

---

#### WS-A.1.3b Knomosis governance + payment metrics

**ID:** WS-A.1.3b
**Ref:** Sections 28.3, 17.12

**Description:**
Author the Knomosis-metric section of `docs/policy/TRANSPARENCY_DICTIONARY.md`. These metrics measure public value, not asset volume, and each names the abuse it guards against.

**Knomosis governance and payment metrics (Section 28.3):**

| Metric ID | Metric | Definition | Guards against |
|---|---|---|---|
| KM-GRANT | Public-value grant completion | Funded grants producing accepted evidence/context outputs | Treasury waste |
| KM-TXCOMP | Transaction comprehension | User-test success on transaction-preview meaning | Blind signing |
| KM-TREASTRANS | Treasury-transparency completeness | Treasury actions with clear proposal/recipient/amount/outcome | Dark-money governance |
| KM-GOVDIV | Governance diversity | Participation breadth across eligible civic accounts (not wallet wealth) | Capture |
| KM-PROPDISP | Proposal-dispute rate | Proposals challenged for conflict/fraud/policy | Unaccountable execution |
| KM-FININC | Financial-incident rate | Confirmed scams/fraud/mistaken transfers/compromise per active wallet | Unsafe expansion |
| KM-P2RLEAK | Pay-to-rank leakage | Measured correlation between payments and ranking after controls | Wealth-driven visibility |
| KM-RECONGAP | Treasury-reconciliation gap | Divergence between app ledger, Knomosis receipts, and L1 state | Must be zero or explained before expansion |

**Requirements:**
- These metrics are published only when Knomosis is enabled; cadence monthly.
- `KM-P2RLEAK` is the published-metric counterpart of the neutrality suite (WS-I.3): it measures residual correlation after controls and must trend to zero; a nonzero value is an expansion blocker.
- `KM-RECONGAP` must be zero or explained before any tier expansion (SPEC 28.3, 17.11 production gates).

**Acceptance criteria:**
- The Knomosis-metric section exists and is complete.
- All 8 Knomosis metrics from Section 28.3 are defined with metric IDs and the abuse each guards against.
- `KM-P2RLEAK` and `KM-RECONGAP` carry explicit expansion-blocking semantics.
- Cadence and enablement condition are specified.
- The section is reviewed and approved.

**Testing:**
- Coverage check: all 8 SPEC 28.3 metrics present.
- Consistency check: `KM-P2RLEAK` cross-references the neutrality suite; `KM-RECONGAP` cross-references the production gates.
- Review sign-off recorded in the changelog.

**Dependencies:** WS-A.2.4 (crypto tiers, for enablement gating). Gates WS-P.2 and WS-M/WS-N reporting.

---

#### WS-A.1.3c Anti-metrics and experimentation rules

**ID:** WS-A.1.3c
**Ref:** Sections 28.2, 28.3

**Description:**
Author the anti-metric and experimentation-rule section of `docs/policy/TRANSPARENCY_DICTIONARY.md`. Anti-metrics must never be used as success criteria, growth KPIs, or optimization targets; they encode the engagement-trap and speculation-drift patterns Licio rejects. Each anti-metric carries a stable ID and a rationale, and the section states the enforcement mechanism (quarterly review confirming none is optimized).

**Anti-metrics (Section 28.2, 28.3 — NEVER optimize for these):**

| Anti-metric ID | Anti-metric | Why prohibited |
|---|---|---|
| AM-OUTRAGE | Outrage engagement | Optimizing for emotional reactions rewards divisive over informative content |
| AM-COMPULSION | Compulsion metrics | Session length / return frequency / notification CTR as growth drivers create addiction |
| AM-SPECULATION | Speculation metrics | Token price / trading volume / speculative activity as health indicators |
| AM-VANITY | Vanity engagement | Follower / like / reaction counts / public karma as success metrics |
| AM-TVL | Total value locked | Treating TVL as success incentivizes accumulation over public value |
| AM-TOKVOL | Tokens traded | Trading volume is speculation, not public value |
| AM-WALLETKPI | Wallet connects as growth KPI | Wallet connections measure crypto adoption, not social value |
| AM-PRICE | Speculative price | Token/asset price as a health indicator incentivizes hype |
| AM-TREASSTATUS | Treasury size as status | Large treasuries are not inherently better; public-value output matters |
| AM-VOTEVOL | Vote volume without outcome quality | Raw governance participation without decision-quality measurement |
| AM-ENGAGEONLY | Engagement alone as success criterion | No launch may use engagement as the sole success metric |

**Experimentation rules (Section 28.2):**
- No experiment may introduce likes, upvotes, public reaction counts, or follower leaderboards.
- Ranking experiments must include safety, MERI, MFCI, GWEI, SCOI, and PHI metrics alongside any engagement metric.
- Experiments optimizing attention must also monitor wellbeing and participation quality.
- Experiments on minors or sensitive topics require stricter review.
- All experiments have rollback switches.
- Major user-facing changes require user notice.
- Experiment logs include invariant versions.
- No launch uses engagement alone as a success criterion (`AM-ENGAGEONLY`).

**Enforcement and cadence:**
- Anti-metrics are reviewed quarterly to confirm none is being used as an optimization target; the review is logged.
- A change that would make any anti-metric a KPI requires explicit maintainer rejection and is recorded as a doctrine violation.

**Acceptance criteria:**
- The anti-metric/experimentation section exists and is complete.
- All 11 anti-metrics are listed with stable IDs and rationale.
- All experimentation rules from Section 28.2 are documented, including the mandatory invariant-metric set for ranking experiments.
- The quarterly enforcement review and its logging are specified.
- The section is reviewed and approved.

**Testing:**
- Coverage check: all 11 anti-metrics and all SPEC 28.2 rules present.
- Doctrine check: the no-applause and engagement-alone prohibitions are stated and tied to enforcement.
- Cross-reference check: the required invariant-metric set matches the invariant services (WS-H).
- Review sign-off recorded in the changelog.

**Dependencies:** WS-A.1.3a/b (metric IDs, so anti-metrics are clearly distinguished from published metrics). Gates WS-P (experimentation framework, release gates).

---

### WS-A.1.4 Signal-to-test mapping document

**ID:** WS-A.1.4
**Ref:** Sections 13.6, 30.6

**Description:**
Create `docs/policy/SIGNAL_TEST_MAP.md` that maps every prohibited signal from WS-A.1.1b to a specific, implementable ranking-neutrality test case *and* to the canonical engineering test ID in the verification suite (`WS-I.3.1*`). This document is the contract between policy and engineering: for every signal that must not affect ranking, there is a precise test specification that WS-I.3 implements as an automated test. The ranking-neutrality verification suite must prove that financial features cannot become hidden ranking inputs; this document defines what "prove" means for each prohibited signal and reconciles the policy-side RNT identifiers with the engineering-side suite identifiers so neither drifts.

**Test case structure for each prohibited signal:**

Each entry includes:
- **Signal name and signal ID** — the prohibited signal from WS-A.1.1b.
- **Test ID (policy-side)** — unique identifier (`RNT-NNN`).
- **Canonical suite test (engineering-side)** — the `WS-I.3.1*` test that implements it.
- **Test type** — feed replay, schema audit, feature inspection, or integration test.
- **Setup** — preconditions and test data.
- **Assertion** — what the test checks, in precise terms.
- **Frequency** — CI, pre-release, or post-release.
- **Failure action** — what happens on failure (block release, alert, etc.).

**Required test cases (one per prohibited signal from Section 13.6):**

| Test ID | Suite test | Prohibited signal | Test method | Assertion |
|---|---|---|---|---|
| RNT-001 | WS-I.3.1a | Likes | Feed replay | Replay with/without hypothetical like field yields identical ranking order |
| RNT-002 | WS-I.3.1a | Upvotes | Feed replay | Replay with/without hypothetical upvote field yields identical ranking order |
| RNT-003 | WS-I.3.1b | Hearts / reactions | Schema audit | No reaction-counter field exists in any ranking feature schema |
| RNT-004 | WS-I.3.1c | Public karma | Schema audit + feature inspection | No karma field readable by ranking; karma absent from PWAtt inputs |
| RNT-005 | WS-I.3.1c | Follower counts | Feature inspection | Follower count absent from PWAtt and all invariant joins |
| RNT-006 | WS-I.3.1c | Donor badges | Feature inspection | Donor status/badge absent from all organic feature schemas |
| RNT-007 | WS-I.3.1b | Token balances | Feature inspection | Token balance absent from PWAtt feature inputs |
| RNT-008 | WS-I.3.1b | Payment amounts | Feature inspection | Payment amount absent from all organic ranking features |
| RNT-009 | WS-I.3.1d | Treasury contributions | Integration test | Treasury contribution does not change story rank except via the manually approved public-interest prompt on a dedicated surface |
| RNT-010 | WS-I.3.1e | DAO votes | Integration test | Governance vote outcomes do not change claim labels without evidence/steward process |
| RNT-011 | WS-I.3.1a | Wallet connection status | Feed replay | Replay for wallet-linked vs non-linked users yields identical ranking except user-selected treasury surfaces |
| RNT-012 | WS-I.3.1f | Paid membership | Integration test | Paid membership does not bypass safety, rate limits, or moderation |
| RNT-013 | WS-I.3.1b | NFT ownership | Feature inspection | NFT ownership absent from all ranking and recommendation feature schemas |
| RNT-014 | WS-I.3.1e | Governance vote outcomes | Integration test | Governance outcomes require evidence/steward review before any ranking effect |

**Additional suite-level tests (Section 30.6):**
- ML feature audit (`WS-I.3.1g`): fails if wallet/token/payment/treasury fields are added to organic rankers without explicit approval.
- Sponsored-content labeling (`WS-I.3.1h`): sponsored/treasury-funded content is labeled and does not enter unpaid ranking.
- Public-explanation audit (`WS-I.3.1i`): explanations state that payments are support/governance actions, not endorsements (shares a prohibited-language denylist with UI copy).
- Dashboard separation (`WS-I.3.1j`): revenue/treasury metrics are separated from product-health metrics.

**Failure-action policy (stated once, applied per test):**
- CI-frequency tests block merge on failure.
- Pre-release tests block the release gate on failure.
- Post-release tests page the on-call owner and open an incident; a confirmed financial-feature leak is a Critical incident (Risk Matrix).

**Acceptance criteria:**
- `docs/policy/SIGNAL_TEST_MAP.md` exists and is complete.
- Every prohibited signal from WS-A.1.1b has exactly one RNT test case with a unique policy-side ID and a mapping to its canonical `WS-I.3.1*` suite test.
- Each test case specifies test method, setup, assertion, frequency, and failure action.
- The four suite-level tests from Section 30.6 are documented with their suite IDs.
- The document is structured so engineering can implement each test without ambiguity.
- Test IDs follow the RNT-NNN convention; the policy↔suite mapping is bijective over the 14 signals.
- The document is reviewed and approved.

**Testing:**
- Bidirectional mapping check: every RNT here exists in WS-A.1.1b and maps to an existing `WS-I.3.1*` test; no orphans in either direction.
- Completeness check: 14 signal-level tests + 4 suite-level tests, all present.
- Failure-policy check: every test names a frequency and a failure action.
- Review sign-off recorded in the changelog.

**Security/privacy:** This is the executable-contract layer of the pay-to-rank defense. Reconciling policy-side RNT IDs with engineering-side suite IDs prevents the documentation and the tests from silently diverging, closing the audit gap where a renamed or removed test would otherwise leave a prohibition unverified.

**Dependencies:** WS-A.1.1b (prohibited-signal list and assertions). Mirrors and is mirrored by WS-I.3; consumed directly by WS-I.3 implementers.

---

## WS-A.2 Jurisdiction and feature matrix

### WS-A.2.1 Jurisdiction-feature matrix template

**ID:** WS-A.2.1
**Ref:** Sections 17.10, 30.3-N

**Description:**
Create `docs/policy/JURISDICTION_MATRIX.md` as a template for mapping features, asset types, and capabilities to jurisdictions. This matrix is the operational input for the jurisdiction policy engine (Section 17.10) that controls feature availability by region. The default posture is crypto features disabled and fail-closed: any jurisdiction not explicitly approved has crypto features turned off. The template is the canonical structure; specific jurisdiction rows are populated by legal review (WS-N) and are out of scope for this document beyond providing exemplar rows and the required fields.

**Matrix structure (exact headings/fields the document must contain):**

**Rows (jurisdictions).** Each jurisdiction row carries these fields:
- Region/country code (ISO 3166-1 alpha-2; sub-national code where a state/province regime applies, for example `US-CA`).
- Regulatory-framework references (for example, EU MiCA, US state-level MSB, Singapore PSA).
- Legal-review status: `pending` | `in-progress` | `approved` | `blocked`.
- Legal-review date and reviewer.
- KYC/AML trigger conditions applicable in the region.
- Sanctions posture (screening required? restricted parties?).
- Age-assurance requirement.
- Tax-disclosure requirement.
- Consumer-risk-disclosure requirement.
- Disabled-region fallback UX reference.
- Notes and conditions.

**Columns (features/capabilities):**

| Feature category | Sub-features |
|---|---|
| Core social | Story submission, reading, discussion, reporting, blocking, moderation |
| PWAtt ranking | Attention signals, participation signals, invariant services |
| Wallet connection | Link/unlink, address display, identity separation |
| Testnet transactions | Simulated proposals, fake-asset governance, preview signing |
| Production payments | Real-asset deposits, withdrawals, transfers |
| Treasury operations | Room treasuries, grants, bounties, payouts |
| Governance | Proposals, voting, delegation, law-pack migration |
| Age-gated features | Features requiring age verification (crypto, sensitive content) |

**Cell values (closed vocabulary):** each cell is one of `enabled` | `disabled` | `simulated` | `testnet` | `pending-legal` | `blocked`, with an optional condition reference. The closed vocabulary lets the jurisdiction engine consume the matrix deterministically.

**Default posture per feature category:**
- Core social: enabled globally (subject to content law).
- PWAtt ranking: enabled globally.
- Wallet connection: disabled by default; enabled per approved jurisdiction.
- Testnet transactions: enabled in approved test jurisdictions.
- Production payments: disabled by default; enabled only after legal approval.
- Treasury operations: disabled by default; enabled only after legal approval.
- Governance: disabled by default for financial governance; enabled for non-financial room governance.
- Age-gated: requires age verification where applicable.

**Acceptance criteria:**
- `docs/policy/JURISDICTION_MATRIX.md` exists with the template structure.
- All feature categories are represented as columns; all jurisdiction fields are present as row attributes.
- The cell-value vocabulary is closed and documented so the jurisdiction engine can consume it deterministically.
- Default posture (disabled, fail-closed) is documented for crypto features.
- Cells requiring legal review are marked `pending-legal` with reviewer/date fields.
- KYC/AML trigger conditions, sanctions posture, and disabled-region fallback are present per row.
- The template is consistent with the crypto-feature matrix (WS-A.2.4) so the two compose without contradiction.

**Testing:**
- Structure check: every feature category and every required jurisdiction field is present.
- Vocabulary check: the cell-value enumeration is closed and each value is defined.
- Composition check: exemplar rows are consistent with WS-A.2.4 tiers (no cell enables a feature that the tier matrix gates behind an unmet requirement).
- Review sign-off recorded in the changelog (marked as requiring legal review for populated rows).

**Dependencies:** WS-A.2.4 (crypto tiers, for composition). Gates WS-N (jurisdiction engine), WS-L/WS-M (feature gating), WS-D.1.7 (age gating).

---

### WS-A.2.2 Steward roles and capabilities

**ID:** WS-A.2.2
**Ref:** Section 16.3, 16.4

**Description:**
Create `docs/policy/STEWARD_ROLES.md` defining the five steward roles, their capabilities, access levels, accountability requirements, and audit obligations. Stewards are the human governance layer between automated systems and external escalation. Their roles must be precisely defined so that capability grants, audit logs, and accountability structures can be implemented correctly by WS-J (console authorization) and WS-D.1 (role grants and MFA).

**Steward roles (Section 16.3):**

| Role | Role ID | Capabilities | Access level | Accountability |
|---|---|---|---|---|
| Community steward | ROLE_COMMUNITY | Organize threads, request context, merge duplicates, escalate moderation, issue soft warnings, suggest branch organization | Room-level content management; no account-level actions | Actions audited; subject to community feedback; removable by room governance or platform |
| Evidence steward | ROLE_EVIDENCE | Review evidence cards, mark primary sources, flag weak citations, verify source provenance, suggest evidence gaps | Evidence-card metadata; source-profile annotations | Actions audited; evidence decisions reviewable; no content-removal power |
| Safety moderator | ROLE_SAFETY | Enforce policy, handle reports, protect targets, issue warnings, remove content, restrict accounts (temporary), apply safety labels | Cross-room content and account actions within policy scope | All actions logged with reason codes; subject to appeal; required training |
| Appeals reviewer | ROLE_APPEALS | Review disputed moderation/account actions, overturn/uphold/modify, document reasoning | Read access to moderation history and evidence; decision authority on appeals | Decisions logged with full reasoning; independent from original moderator; periodic quality review |
| Integrity analyst | ROLE_INTEGRITY | Investigate coordination, spam, manipulation, raids, bot networks, financial-abuse patterns | Cross-room analytics, MFCI data, account patterns, financial-transaction patterns | Investigations logged; actions require documentation; sensitive-data access time-limited and audited |

**Capability → action mapping (so console authorization is unambiguous):**
The document maps each role to the specific console actions it may invoke (the action palette of WS-J.2.3) and the queues it may access (report queue, appeal queue, integrity queue). For example, only `ROLE_SAFETY` may invoke remove/restrict; only `ROLE_APPEALS` may overturn/modify; only `ROLE_INTEGRITY` may access the MFCI coordination detail and place a room-governance or treasury freeze (the latter with counsel co-approval per WS-A.1.2c).

**Audit fields (every steward action emits):**
actor identity, role, timestamp, action type, reason code (WS-A.1.2), target (content/account/room), affected distribution state, reversibility flag, and any co-approver for irreversible/high-impact actions.

**Cross-cutting requirements (Section 16.4):**
- All steward actions are logged with timestamps, reason codes, and actor identity.
- Public transparency reports summarize moderation and integrity actions in aggregate (WS-A.1.3a breakdowns).
- Stewards cannot access private attention ledgers or personal data beyond what the role requires (least privilege; privacy invariant).
- Multi-factor authentication is required for all steward accounts (SPEC 25.3).
- Steward actions are reversible where possible; irreversible actions require additional approval (pairs with WS-A.1.2c emergency/treasury rules).
- High-impact policy changes require a changelog and user notice.
- Steward roles require training completion before capability grant.

**Acceptance criteria:**
- `docs/policy/STEWARD_ROLES.md` exists and is complete.
- All five steward roles are documented with role IDs, capabilities, access levels, and accountability requirements.
- A capability→action and capability→queue mapping is present and consistent with the WS-J console (WS-J.2.3) and appeal eligibility (WS-A.1.2c).
- Audit fields and audit requirements are specified for each role.
- MFA, least-privilege, training, and irreversible-action-co-approval requirements are documented.
- Role hierarchy and escalation paths are clear and consistent with the moderation layers (WS-A.1.2b).
- The document is reviewed and approved.

**Testing:**
- Coverage check: all 5 SPEC 16.3 roles present.
- Consistency check: every action in the WS-J palette maps to at least one authorized role; no action is unassigned; overturn/modify restricted to `ROLE_APPEALS`; freezes restricted to `ROLE_INTEGRITY` (+ counsel for treasury).
- Privacy check: no role grants access to reporter identities, private attention ledgers, or minors' data beyond necessity.
- Review sign-off recorded in the changelog.

**Security/privacy:** Precise capability and access definitions are the basis for object-/action-level authorization (SPEC 25.4) in the console (WS-J.2.2b restricts financial data; user-history access is role-gated). MFA-for-stewards is mandated by SPEC 25.3. Time-limited, audited sensitive-data access for integrity analysts limits the blast radius of a compromised steward account.

**Dependencies:** WS-A.1.2 (reason codes, appeal eligibility), referenced by WS-A.1.2b (operating roles). Gates WS-J.2 (console authz), WS-D.1 (role grants, MFA), WS-O (audit-log requirements).

---

### WS-A.2.3 Privacy regulation mapping

**ID:** WS-A.2.3
**Ref:** Sections 19.1, 19.2, 19.3, 19.4, 17.10

**Description:**
Create `docs/policy/PRIVACY_REGULATION_MAP.md` mapping privacy-regulation requirements to Licio's data-handling practices by jurisdiction. This document ensures the platform's privacy controls (attention-signal handling, data retention, user rights, children's protections) comply with applicable regulations in each target jurisdiction. It is the policy source for WS-D.2 (privacy controls), WS-E.1 (event retention), and WS-N (compliance), and it must be consistent with the attention-signal handling table (SPEC 19.2) and the on-chain minimization rules (SPEC 19.5).

**Regulation coverage:**

**GDPR (EU/EEA):**
- Legal basis: legitimate interest for core social features; consent for personalized recommendations and attention-derived ranking.
- Data-subject rights: access, rectification, erasure, portability, restriction, objection.
- Data minimization: in-browser aggregation of attention signals; minimal raw event upload (SPEC 19.1, 19.2).
- Retention limits: documented retention tiers per data category; shortest feasible for raw event logs.
- DPIA: required for attention-signal processing and invariant services.
- Right to explanation: users can request meaningful information about ranking decisions (pairs with Signal Ledger, WS-I.2.6).
- Cross-border transfers: data-localization requirements and transfer mechanisms.
- DPO designation: required if processing at scale.
- Breach notification: 72-hour supervisory-authority notification.
- Children: GDPR Article 8 age thresholds (13-16 by member state).

**CCPA/CPRA (California):**
- Consumer rights: know, delete, opt-out of sale/sharing, correct, limit sensitive-personal-information use.
- Sensitive personal information: attention-derived inferences may qualify; purpose limitation applies.
- Service-provider obligations: contractual restrictions on data use.
- Financial-incentive disclosure: any feature differentiation based on data use must be disclosed (note: Licio does not differentiate ranking by payment; this is about data-use, not pay-to-rank).
- Children: COPPA for under-13; CCPA opt-in consent for 13-16.

**COPPA (US — children under 13):**
- Verifiable parental consent before collecting personal information.
- Data minimization for children's data.
- Retention limits: delete when no longer needed for purpose.
- No behavioral advertising to children (Licio never does behavioral advertising for any user; SPEC 19.1).
- Parental access and deletion rights.
- Posture: the default product is not directed to children under 13 (SPEC 19.4); any jurisdiction supporting younger users requires compliant parental consent; minors are excluded from wallet/payment/treasury/governance features (SPEC 19.4).

**Per-jurisdiction data-handling matrix:**

| Data category | GDPR handling | CCPA/CPRA handling | COPPA handling |
|---|---|---|---|
| Attention signals (dwell, scroll) | In-browser processing; aggregate upload; consent for personalization | Right to know and delete; opt-out of sharing | Not collected for children |
| Participation signals (contributions) | Legitimate interest; retention per policy | Right to know and delete | Parental consent required |
| Account data (email, credentials) | Contract performance; access/portability/erasure | Right to know, delete, correct | Verifiable parental consent |
| Wallet data (addresses, transactions) | Consent; purpose limitation; separate from social identity | Right to know and delete; sensitive PI | Not applicable (minors excluded) |
| Moderation data (reports, actions) | Legitimate interest; limited retention; access with restrictions | Right to know with restrictions | Protective defaults apply |
| Minor-specific data | Article 8 age thresholds; protective defaults | CCPA opt-in for 13-16 | Full COPPA compliance |

**User-rights operationalization (SPEC 19.3, mapped to endpoints):**
- View Signal Ledger → `GET /v1/signal-ledger` (WS-D/WS-I).
- Export account data → `POST /v1/privacy/export`.
- Delete attention history → `POST /v1/privacy/delete-attention`.
- Disable personalization / reset topic history / choose local vs server personalization / quiet hours / disable cross-device sync → `PATCH /v1/feed/preferences` and privacy settings (WS-D.2).
- Request moderation data related to one's account where legally feasible → support/privacy workflow.

**On-chain minimization (SPEC 19.5) cross-reference:**
The document restates the hard rule that attention/reading/report history, private moderation data, reporter identities, minors' data, sensitive inferences, device IDs, IPs, private messages, and account-security events are never placed on-chain; off-chain records with on-chain hash commitments are used where auditability is needed; wallet addresses are treated as personal data where applicable. This pairs with the DAO-reveal override (WS-A.1.2d).

**Acceptance criteria:**
- `docs/policy/PRIVACY_REGULATION_MAP.md` exists and is complete.
- GDPR, CCPA/CPRA, and COPPA requirements are mapped to Licio's data categories.
- The per-jurisdiction data-handling matrix is complete.
- Legal basis for each processing activity is documented.
- Children's protections are documented with age thresholds per jurisdiction, including minor exclusion from financial features.
- User rights are mapped to concrete endpoints/controls.
- The on-chain minimization rules (SPEC 19.5) are restated and cross-referenced.
- Data-retention tiers are referenced (a detailed retention schedule may be a separate counsel-approved document).
- The document is reviewed by legal counsel (marked as requiring review if not yet reviewed).

**Testing:**
- Coverage check: every data category in SPEC 19.2 appears in the handling matrix; every user right in SPEC 19.3 maps to a control/endpoint.
- Consistency check: minor exclusions match SPEC 19.4; on-chain prohibitions match SPEC 19.5 and WS-A.1.2d.
- Cross-reference check: endpoints cited exist in the API spec (SPEC 23.2).
- Legal-review status recorded in the changelog.

**Security/privacy:** This document is the compliance backbone for the "Attention surveillance — High" risk line. It binds in-browser aggregation, retention minimization, and user-controllable signals to specific regulatory obligations, and it forbids attention data sale and behavioral advertising universally, not merely for minors.

**Dependencies:** WS-A.2.1 (jurisdiction structure), WS-A.1.2d (privacy override). Gates WS-D.2 (privacy controls), WS-E.1 (retention), WS-N (compliance).

---

### WS-A.2.4 Crypto feature availability matrix

**ID:** WS-A.2.4
**Ref:** Sections 17.10, 17.11, 30.3-N

**Description:**
Create `docs/policy/CRYPTO_FEATURE_MATRIX.md` detailing which crypto and financial features are available in which jurisdictions, at which stage of the rollout, and under what conditions. This is the detailed, tier-by-tier view of the crypto columns in the jurisdiction matrix (WS-A.2.1), providing the operational detail the jurisdiction policy engine needs. It encodes the MVP-to-production gating from SPEC 17.11 so no tier is enabled before its gates are met.

**Feature tiers (from Section 17.10/17.11 — distribution posture):**

| Tier | Tier ID | Features | Default state | Enablement requirement |
|---|---|---|---|---|
| Tier 0: Education | CRYPTO_T0 | Read-only Knomosis education, governance explainers | Enabled globally | None |
| Tier 1: Simulation | CRYPTO_T1 | Simulated governance, fake-asset proposals, preview signing | Disabled by default | Product approval; no legal barrier |
| Tier 2: Testnet | CRYPTO_T2 | Wallet link (nonce/signature), testnet proposals, testnet treasury | Disabled by default | Product + security approval; test jurisdiction |
| Tier 3: Capped production | CRYPTO_T3 | Real-asset deposits, capped grants, limited room governance | Disabled by default | Legal approval, compliance controls, external audit, limited jurisdictions |
| Tier 4: Mature production | CRYPTO_T4 | Expanded governance, delegation, law-pack migration, fork/exit | Disabled by default | All Tier 3 plus operational track record, expanded legal review |

**Per-jurisdiction requirements for each tier:**

| Requirement | Tier 1 | Tier 2 | Tier 3 | Tier 4 |
|---|---|---|---|---|
| Legal review | Not required | Recommended | Required | Required |
| KYC/AML | Not required | Not required | Required where applicable | Required |
| Sanctions screening | Not required | Not required | Required | Required |
| Age verification | Not required | Required (18+) | Required (18+) | Required (18+) |
| Custody model approval | Not required | Not required | Required | Required |
| External security audit | Not required | Not required | Required | Required |
| Tax reporting setup | Not required | Not required | Required where applicable | Required |
| Consumer risk disclosures | Not required | Recommended | Required | Required |
| Transaction monitoring | Not required | Not required | Required | Required |
| Incident response plan | Not required | Recommended | Required | Required |

**Production real-funds gates (SPEC 17.11 — all required before Tier 3):**
legal sign-off per jurisdiction; custody model and partner contracts; AML/fraud/sanctions controls; tax/accounting plan; external audit of contracts and deployment config; external audit of wallet flows and backend gateways; CI validation of Knomosis Lean/Solidity/Rust cross-stack fixtures; reorg and reconciliation tests; disaster-recovery test; bug bounty live; tested incident runbook; trained financial-support and T&S teams; public risk disclosures; tested rollback/freeze controls; configured treasury limits; verified region/age feature flags; live monitoring dashboards; approved pilot-room charters. The document represents these as a per-tier gate checklist so an environment cannot be promoted with an unmet gate.

**Fail-closed behavior:**
- Jurisdiction status unknown or pending → crypto features disabled.
- Compliance check fails → crypto features disabled with user-facing explanation.
- Sanctions screening unavailable → crypto features disabled.
- Age verification unavailable → crypto features disabled for that user.
- Any kill switch engaged (wallet connect, payment-intent, action submit, treasury execution, governance voting; SPEC 25.6) → corresponding feature disabled.
- Core social product (reading, posting, discussing, reporting, blocking) always remains available regardless of crypto feature state (cross-cutting invariant 8; M6 non-crypto-usability gate).

**Acceptance criteria:**
- `docs/policy/CRYPTO_FEATURE_MATRIX.md` exists and is complete.
- All 5 feature tiers are defined with tier IDs, default states, and enablement requirements.
- Per-jurisdiction requirements are specified for each tier.
- The SPEC 17.11 production gates are represented as a per-tier checklist that blocks promotion when unmet.
- Fail-closed behavior is documented for all edge cases, including kill-switch engagement.
- The matrix is compatible with the jurisdiction-feature matrix template (WS-A.2.1) cell vocabulary.
- Core social product availability is explicitly independent of crypto features.
- The document is reviewed and approved.

**Testing:**
- Coverage check: all 5 tiers and all 10 per-tier requirements present; all SPEC 17.11 gates represented.
- Composition check: every tier's enablement requirement is expressible in the WS-A.2.1 cell vocabulary and no cell can enable a tier with an unmet gate.
- Fail-closed check: each enumerated failure path resolves to "disabled," and core social remains enabled in all of them.
- Review sign-off recorded in the changelog.

**Security/privacy:** This matrix is the operational expression of "Fail-closed crypto" (invariant 8) and a primary control for the "Regulatory noncompliance — High" and "Smart contract bug — Critical" risk lines. Tying tier promotion to the production-gate checklist prevents real-funds exposure before audits, controls, and reconciliation are in place.

**Dependencies:** WS-A.2.1 (cell vocabulary, composition). Gates WS-L/WS-M (Knomosis), WS-N (jurisdiction engine), WS-C.1.3 (default-off flags), and is referenced by WS-A.1.2d and WS-A.1.3b enablement gating.

---

## Task dependency summary

| Task | Deliverable | Depends on | Consumed by (downstream) |
|---|---|---|---|
| WS-A.1.1a | SIGNAL_MATRIX (allowlist) | — | WS-E.2, WS-A.1.1b |
| WS-A.1.1b | SIGNAL_MATRIX (denylist + tests) | WS-A.1.1a | WS-A.1.4, WS-I.2.1, WS-I.3 |
| WS-A.1.1c | SIGNAL_MATRIX (anti-signals) | WS-A.1.1a, WS-A.1.1b | WS-E.2.2, WS-H.3, WS-J.1.1d, WS-J.2.6 |
| WS-A.1.2a | MODERATION_TAXONOMY (categories) | — | WS-J.1.1a, WS-J.2.3, WS-G.4, WS-P |
| WS-A.1.2b | MODERATION_TAXONOMY (layers) | WS-A.2.2 | WS-J.2, WS-J.2.6 |
| WS-A.1.2c | MODERATION_TAXONOMY (appeals) | WS-A.1.2a, WS-A.2.2 | WS-J.1.3a-d, WS-J.2.4 |
| WS-A.1.2d | MODERATION_TAXONOMY (crypto abuse) | WS-A.2.4, WS-A.1.2a | WS-J (crypto), WS-L/WS-M, WS-N |
| WS-A.1.3a | TRANSPARENCY_DICTIONARY (product/safety) | WS-A.1.1, WS-A.1.2a | WS-P.2 |
| WS-A.1.3b | TRANSPARENCY_DICTIONARY (Knomosis) | WS-A.2.4 | WS-P.2, WS-M/WS-N |
| WS-A.1.3c | TRANSPARENCY_DICTIONARY (anti-metrics) | WS-A.1.3a, WS-A.1.3b | WS-P (experiments) |
| WS-A.1.4 | SIGNAL_TEST_MAP | WS-A.1.1b | WS-I.3 |
| WS-A.2.1 | JURISDICTION_MATRIX | WS-A.2.4 | WS-N, WS-L/WS-M, WS-D.1.7 |
| WS-A.2.2 | STEWARD_ROLES | WS-A.1.2 | WS-J.2, WS-D.1, WS-O |
| WS-A.2.3 | PRIVACY_REGULATION_MAP | WS-A.2.1, WS-A.1.2d | WS-D.2, WS-E.1, WS-N |
| WS-A.2.4 | CRYPTO_FEATURE_MATRIX | WS-A.2.1 (vocabulary) | WS-L/WS-M, WS-N, WS-C.1.3 |

Authoring order note: WS-A.2.1 and WS-A.2.4 are mutually referential (vocabulary ↔ tiers). Author the WS-A.2.1 cell vocabulary and column skeleton first, then WS-A.2.4 tiers, then reconcile WS-A.2.1 exemplar rows against the tiers. All WS-A documents may be drafted in parallel within Wave 1; the dependencies above govern *ratification* order, not drafting.

---

## Workstream definition of done

WS-A is complete when ALL of the following conditions hold:

1. **Signal matrix.** `docs/policy/SIGNAL_MATRIX.md` exists and enumerates, with stable signal IDs, every allowed attention/participation signal with its guardrail (WS-A.1.1a), every prohibited signal with a testable neutrality assertion and a mapping to its `WS-I.3.1*` suite test (WS-A.1.1b), and every anti-signal with its base-rate-conditioned response (WS-A.1.1c). Signal IDs across the three lists are disjoint. Reviewed and approved.

2. **Moderation taxonomy.** `docs/policy/MODERATION_TAXONOMY.md` exists with all 12 policy categories (severity, SLA, required evidence, escalation trigger, reason codes; WS-A.1.2a), the 6 moderation layers and escalation path with operating roles (WS-A.1.2b), the appeal-eligibility matrix consistent with WS-J.1.3a (WS-A.1.2c), and all 15 crypto-specific abuse modes with the DAO-reveal privacy override (WS-A.1.2d). A machine-readable reason-code enumeration is present. Reviewed and approved.

3. **Transparency dictionary.** `docs/policy/TRANSPARENCY_DICTIONARY.md` exists defining all 13 product-health/safety metrics with data sources, responsible workstreams, and privacy thresholds (WS-A.1.3a); all 8 Knomosis metrics with expansion-blocking semantics for pay-to-rank leakage and reconciliation gap (WS-A.1.3b); and all 11 anti-metrics plus the experimentation rules and quarterly enforcement review (WS-A.1.3c). Small-cell suppression is applied uniformly. Reviewed and approved.

4. **Signal-to-test mapping.** `docs/policy/SIGNAL_TEST_MAP.md` exists linking every prohibited signal to exactly one RNT test and to its canonical `WS-I.3.1*` suite test, with method, setup, assertion, frequency, and failure action per test, plus the four suite-level tests. The policy↔suite mapping is bijective over the 14 signals and verified against WS-I.3. Reviewed and approved.

5. **Jurisdiction template.** `docs/policy/JURISDICTION_MATRIX.md` exists with all feature-category columns, all required jurisdiction-row fields, a closed cell-value vocabulary the jurisdiction engine can consume, and the crypto-disabled fail-closed default. Composes without contradiction with the crypto-feature matrix. Reviewed and approved (populated rows marked as requiring legal review).

6. **Steward roles.** `docs/policy/STEWARD_ROLES.md` exists defining all five roles with role IDs, capabilities, access levels, accountability, audit fields, and a capability→action/queue mapping consistent with the WS-J console and the appeal-eligibility matrix. MFA, least-privilege, training, and irreversible-action co-approval are mandated. Reviewed and approved.

7. **Privacy regulation mapping.** `docs/policy/PRIVACY_REGULATION_MAP.md` exists covering GDPR, CCPA/CPRA, and COPPA, with a per-jurisdiction data-handling matrix, legal basis per activity, children's protections including minor exclusion from financial features, user rights mapped to endpoints, and the on-chain minimization rules. Reviewed by legal counsel (or explicitly marked pending review).

8. **Crypto feature matrix.** `docs/policy/CRYPTO_FEATURE_MATRIX.md` exists defining all five tiers with default states, per-jurisdiction requirements, the SPEC 17.11 production-gate checklist blocking unmet promotions, and fail-closed behavior (including kill-switch engagement) with core-social independence. Compatible with the jurisdiction matrix vocabulary. Reviewed and approved.

9. **Doctrinal consistency.** The eight cross-cutting doctrinal invariants hold across all documents: signal IDs and reason codes are unique and non-overlapping; no document contradicts another; every downstream consumer named in the Document Register has a clear, stable identifier to cite; and the no-applause, no-pay-to-rank, notice-and-appeal, published-support-contact, human-review-not-auto-removal, MFCI-base-rate-conditioning, privacy-by-design, and fail-closed-crypto invariants are each traceable to at least one document section.

10. **M0 gate alignment.** The M0 doctrine gate checklist (index: signal matrix, moderation taxonomy, transparency dictionary, jurisdiction template, steward roles; no forbidden-signal ambiguity; crypto non-blocking) is fully satisfied by the deliverables above, and each gate row maps to a specific WS-A task.

# Licio v0.4 Final: Mobile-First Social News, Knomosis L2 Payments, and DAO-Like Forum Governance

**Document status:** v0.4 final double-check, end-to-end optimization, and expanded implementation plan with Knomosis L2 integration  
**Prepared date:** June 7, 2026  
**Revision date:** June 7, 2026  
**Working product name:** Licio  
**Primary platform:** Mobile first: iOS and Android native apps, with web as a secondary companion surface  
**Core premise:** There are no traditional user-cast upvotes, likes, heart buttons, karma counts, follower-count leaderboards, or popularity badges. Public visibility is derived from privacy-preserving measures of active attention, participation depth, conversation quality, nonredundant exposure, cross-context coherence, anti-coordination checks, and recommender-safety constraints. Knomosis L2 is used only as an optional, compliance-gated payment and forum-governance substrate; cryptocurrency, wallets, treasuries, DAO-like votes, and payments never buy visibility, status, notifications, search placement, or recommendation advantage.

## Table of contents

- **0.** Revision audit and optimization summary
- **0.6.** Final v0.4 double-check and optimization verdict
- **1.** Executive summary
- **2.** Product north star
- **3.** Platform concept
- **4.** User personas and core jobs
- **5.** Rating model: Participation-Weighted Attention
- **6.** Mobile-first product requirements
- **7.** Core invariant 1: Matroid Exposure Rank Invariant (MERI)
- **8.** Core invariant 2: Markov-Fiber Coordination Invariant (MFCI)
- **9.** Core invariant 3: Gromov-Wasserstein Experience Isometry (GWEI)
- **10.** Core invariant 4: Sheaf Context Obstruction Invariant (SCOI)
- **11.** Core invariant 5: Preference Holonomy Invariant (PHI)
- **12.** Supporting invariant services
- **13.** Ranking and distribution system
- **14.** Social news aggregation model
- **15.** Forum and conversation design
- **16.** Community and governance model
- **16A.** Knomosis L2 payments and DAO-like forum governance
- **17.** Trust, safety, and moderation
- **18.** Privacy and data protection
- **19.** Mobile client architecture
- **20.** Backend architecture
- **21.** Data model
- **22.** API specification overview
- **23.** AI and machine learning specification
- **24.** Security specification
- **25.** Accessibility and inclusive design
- **26.** Monetization and incentives
- **27.** Metrics and experimentation
- **28.** Operational workflows
- **29.** Optimized end-to-end implementation plan
- **29A.** Final optimized operating implementation plan
- **29B.** Atomic task cards for complex/high-risk work
- **29C.** Final launch readiness and acceptance-gate register
- **30.** Risks and mitigations
- **31.** Best-practice checklist
- **32.** Open questions
- **33.** Appendix A: Invariant-to-product mapping
- **34.** Appendix B: Example user journeys
- **35.** Appendix C: Prioritized backlog and dependency map
- **36.** Appendix D: Reference standards and sources
- **37.** Appendix E: Final best-practice verification matrix

## Document purpose

This specification describes a novel social media application for social news aggregation, content rating, and forum discussion. It turns the strongest mathematical invariants from the prior brainstorming into concrete product mechanisms, algorithms, mobile interfaces, data structures, governance practices, and implementation milestones.

The platform is designed for a world where the most visible content should not merely be the most liked, most enraging, most gamed, or most amplified by bots. Instead, content rises when people spend meaningful attention on it, participate in conversation around it, add evidence, improve context, and create nonredundant public value.

## Standards and external baselines

This specification is not a legal compliance memo, but it is designed to align with current product, security, accessibility, privacy, platform-governance, app-store, financial-integrity, and crypto-governance best practices as of June 7, 2026. The v0.4 pass refreshes the Knomosis source assumptions and converts the build plan into smaller, dependency-aware units that are suitable for execution, audit, and launch gating. The design references WCAG 2.2 and W3C mobile accessibility guidance for native and hybrid mobile accessibility; OWASP MASVS, MASWE, and MASTG for mobile application security; OWASP smart-contract security resources for contract-facing work; NIST CSF 2.0 for cybersecurity governance; NIST Privacy Framework for privacy risk management; NIST AI RMF 1.0 and the NIST Generative AI Profile for AI risk governance; ISO/IEC 42001:2023 for AI management-system discipline; the EU Digital Services Act for online-platform transparency patterns; GDPR-style privacy principles; the EU AI Act for AI transparency, risk, literacy, and governance patterns; the FTC's 2025 COPPA rule amendments for US child privacy obligations; California CCPA/CPRA patterns for US privacy rights; Apple App Review Guidelines and Google Play policies for UGC, payments, wallets, and blockchain-based content; EIP-712/EIP-1271/EIP-4361/EIP-4337 design patterns where applicable; FinCEN, FATF, and EU MiCA materials for crypto-asset risk review; Apple Human Interface Guidelines; and Google Material Design 3.

The product should treat these as baselines, not ceilings. Each launch jurisdiction requires separate legal review, content-policy review, privacy-impact assessment, and app-store-review preparation. Features that rely on AI, profiling, minors' data, political content, health content, or public-interest news should be launch-gated by a documented risk review.

# 0. Revision audit and optimization summary

## 0.1 Audit verdict

The v0.1 specification is conceptually sound: the no-like/no-upvote premise is coherent, the five strongest invariants are useful for a social news and forum product, and the mobile-first framing is appropriate. The main issue is not mathematical correctness; it is execution risk. Several complex systems were named correctly but needed smaller work packets, clearer dependencies, explicit acceptance criteria, stronger privacy boundaries, and safer rollout gates.

The v0.2 optimization pass kept the original product concept but tightened it in five ways:

1.  **Terminology is corrected.** Users do not literally upvote. The product may internally compute a visibility lift from attention and participation, but there is no explicit vote button and no user-facing applause mechanic.
2.  **Raw attention is capped and contextualized.** Dwell time, repeated opens, and rage-reading cannot directly drive distribution. Attention becomes useful only after idle filtering, saturation, deduplication, source interaction checks, and safety constraints.
3.  **Invariants are treated as services with confidence levels.** MERI, MFCI, GWEI, SCOI, and PHI should not be shipped as black-box scores. Each output must include a time window, confidence, data coverage, explanation, and known failure modes.
4.  **Automated restrictions are separated from human sanctions.** Ranking dampening may be automated under narrow rules, but account sanctions, public labels, and content removals require policy-grounded review, logging, and appeal paths except for emergency safety cases.
5.  **The implementation plan is decomposed.** Each complex task is broken into smaller units of work with dependencies, definitions of done, quality gates, and rollout controls.


## 0.2 Correctness and optimization principles

The optimized plan follows these principles:

- **Ship vertical slices, not isolated math demos.** Each invariant must connect to a real user workflow, a moderation workflow, and a measurable acceptance test.
- **Prefer conservative ranking effects at first.** Early invariant outputs should inform explanations, dashboards, and review queues before they strongly alter distribution.
- **Make the mobile app the source of trustworthy attention instrumentation, but not a surveillance surface.** The client should compute local active-attention summaries, discard raw fine-grained interaction traces where possible, and send only minimal aggregated events.
- **Design for reversibility.** Every major ranking or moderation intervention must have a rollback plan, a feature flag, and an audit log.
- **Measure harms alongside engagement.** No experiment can be declared successful using engagement or retention alone.
- **Avoid hidden social scoring.** Reputation exists only as private capability and trust signals; it must not become a public status game.
- **Treat mathematical novelty as risk as well as advantage.** Each invariant requires synthetic tests, shadow mode, red-team evaluation, calibration, and fallback behavior.

## 0.3 Major refinements made in this revision

| Area | v0.1 issue | v0.2 refinement |
|---|---|---|
| Rating | PWA was defined, but raw attention could still be over-weighted if implemented naively. | Adds saturation, anti-compulsion filters, per-user deduplication, quality gates, and anti-sybil controls. |
| MERI | Matroid rank was conceptually correct but under-decomposed. | Breaks MERI into duplicate clustering, independence dimensions, rank approximation, UI explanation, and fairness checks. |
| MFCI | Coordination detection needed operational detail. | Adds event tables, margin choices, Markov-chain sampling, severity states, analyst review, false-positive feedback, and appeal handling. |
| GWEI | Experience fairness was abstract. | Adds cohort construction, metric-space design, sampling windows, optimal-transport approximations, dashboards, and release gates. |
| SCOI | Context obstruction needed a production approximation. | Adds local interpretation cards, overlap maps, context-patch workflow, bridge prompts, and recomputation. |
| PHI | Holonomy risk needed practical instrumentation. | Adds topic-state transport, loop detection, path-risk caps, user controls, and red-team tests. |
| Mobile | Mobile-first requirements were present but needed engineering slices. | Adds native app shell, offline drafts, source reader, bottom-sheet context, accessibility instrumentation, and performance budgets. |
| Trust and safety | Good baseline, but needed app-store and platform-policy operationalization. | Adds reporting, blocking, moderation queues, emergency escalation, transparency logs, and app-store review readiness. |
| Privacy | Strong direction, but needed attention-signal minimization. | Adds local aggregation, retention tiers, DSAR export boundaries, minors defaults, privacy-review gates, and data-map tasks. |
| Release plan | Phases were too coarse. | Replaces the phase list with a decomposed implementation plan, critical path, backlog, acceptance gates, and operational runbooks. |

## 0.4 v0.3 Knomosis L2 integration update

This v0.3 revision incorporates the user's requirement that Licio support cryptocurrency payments and DAO-like structures for forums and sub-forums through Knomosis. The integration is designed as an optional, compliance-gated layer around the existing no-like/no-upvote social news product. It must not turn Licio into a speculation-first platform, a pay-to-rank platform, a reward-for-posting platform, or a financial product without proper licensing, app-store approvals, and jurisdiction-specific review.

The v0.3 update makes eight product and architecture changes:

1.  **Knomosis becomes a proof-carrying governance and payment substrate, not the popularity engine.** Ranking remains governed by Participation-Weighted Attention, MERI, MFCI, GWEI, SCOI, PHI, and trust-and-safety gates.
2.  **Payments fund public-value work.** Cryptocurrency payments may support room treasuries, evidence bounties, journalist/source grants, moderator stipends, research reimbursements, and voluntary creator support. Payments must not directly boost posts, stories, comments, users, rooms, or search placement.
3.  **DAO-like rooms are bounded by platform policy.** Rooms may use Knomosis-backed charters, proposals, treasury disbursements, delegation, budget rules, and audit logs, but they cannot vote to override illegal-content rules, child-safety rules, privacy requirements, app-store requirements, sanctions controls, accessibility requirements, or platform-wide abuse prevention.
4.  **Wallet identity is separate from civic identity.** Users can read, discuss, submit, and report without a wallet. Wallet connection is needed only for optional payment, grant, treasury, delegation, and governance-signing actions.
5.  **On-chain data is minimized.** Sensitive social behavior, attention data, moderation reports, private messages, minors' information, safety cases, personal data, and inferred interests must stay off-chain. On-chain records should store only necessary transaction, proposal, treasury, and law-pack commitments.
6.  **Compliance is a release blocker.** Production crypto features require counsel review, jurisdiction mapping, app-store review strategy, sanctioned-region controls, AML/fraud controls where applicable, tax/accounting design, and a go/no-go decision for custodial versus non-custodial flows.
7.  **Knomosis integration is feature-flagged by jurisdiction and surface.** A room can be ordinary, simulated-governance, testnet-governance, or production-Knomosis-enabled. The mobile app should degrade gracefully when payments are unavailable.
8.  **Financial incentives are deliberately capped.** Treasury grants and bounties have spend limits, timelocks, conflict-of-interest disclosures, anti-bribery checks, MFCI monitoring, dispute paths, and public audit trails.

The integration assumption used throughout v0.3 is that Knomosis provides a proof-carrying state-transition kernel with Lean as the formal source of truth, Solidity contracts for L1 anchoring/escrow/fault-proof surfaces, and Rust host-runtime/indexing/network components. Before production launch, engineering must pin a specific Knomosis commit, deployment configuration, chain IDs, bridge contracts, host-runtime configuration, fixture corpus, and audit reports.


## 0.5 Non-negotiable launch constraints

Licio should not launch publicly until all of the following are true:

1.  Users can participate meaningfully without any like, upvote, reaction, or public karma mechanism.
2.  Mobile reporting, content reporting, user blocking, mute controls, and published support contact information are live.
3.  PWA is explainable and bounded; raw dwell time cannot independently create high distribution.
4.  MERI v1 prevents obvious duplicate amplification.
5.  MFCI v0 runs at least in shadow mode for brigading and coordinated reporting.
6.  Trust-and-safety queues, reviewer tooling, audit logs, and appeal workflows are operational.
7.  Privacy controls cover attention-derived signals, personalization, data export, deletion, and recommender reset.
8.  Accessibility testing covers screen readers, dynamic type, reduced motion, keyboard/switch access, color contrast, focus order, and touch targets.
9.  Mobile security review covers authentication, secure storage, transport security, jailbreak/root risk handling, API authorization, secret management, and abuse endpoints.
10. The team can generate a transparency report from real logs without manual reconstruction.


## 0.6 Final v0.4 double-check and optimization verdict

### 0.6.1 Final audit verdict

The end-to-end concept is coherent and implementable if Licio preserves the following architectural boundaries:

1. Participation-Weighted Attention is a salience signal, not an endorsement signal.
2. Ranking is never controlled by money, wallet connection, token holdings, treasury contributions, DAO voting, proposal outcomes, creator payments, paid memberships, or public financial status.
3. Mathematical invariants are audit services and safety constraints, not opaque automatic punishment systems.
4. Knomosis is a bounded payment/governance substrate, not a social graph, reputation graph, or popularity engine.
5. Mobile safety, privacy, accessibility, app-store compliance, and abuse controls must be treated as first-order product requirements, not post-launch hardening.
6. No irreversible real-funds or on-chain governance action launches before simulation, testnet, external review, incident drills, and user-support readiness.
7. Sub-forum DAO-like governance is scoped: local communities can manage local budgets and rules within platform policy; they cannot opt out of global legality, safety, child protection, privacy, accessibility, app-store, or ranking-integrity constraints.
8. On-chain data is minimized to receipts, commitments, treasury records, proposal state, and law-pack references. Sensitive reading behavior, attention traces, moderation reports, private safety cases, private messages, inferred interests, and minors' data stay off-chain.

The v0.4 plan is therefore optimal in the practical product sense: it keeps the novel mathematical and governance ideas, but stages the riskiest features behind progressively stronger evidence, smaller launch scopes, and explicit rollback paths.

### 0.6.2 Final corrections made in this pass

This final pass makes the previous plan more precise in eight places:

1. It turns the complex implementation plan into small, efficient work packages with explicit dependencies, artifacts, and acceptance gates.
2. It separates the MVP into three parallel tracks: core social news, invariant/ranking safety, and Knomosis simulation/testnet, so crypto does not block the non-crypto product.
3. It adds stronger no-pay-to-rank controls, including schema separation, feature deny-lists, offline leakage tests, online parity audits, and a red-team playbook.
4. It adds a more complete Knomosis due-diligence path: commit pinning, license review, Lean/Solidity/Rust build gates, law-pack registry, gateway, event indexer, reconciliation, and production allowlists.
5. It adds a production treasury model with caps, timelocks, conflict disclosures, reconciliation, accounting exports, challenge windows, emergency holds, and incident runbooks.
6. It strengthens mobile wallet UX requirements: no seed phrase capture, typed signing, chain/network display, fee and destination preview, hold-to-confirm, simulation before signing, and readable failure recovery.
7. It adds release gates for privacy, accessibility, app-store UGC handling, financial services declarations, blockchain-policy declarations, sanctions/fraud controls where applicable, and AI governance.
8. It adds final acceptance criteria that can be tested before closed alpha, public beta, capped real-funds pilot, and general availability.

### 0.6.3 Source assumptions refreshed for v0.4

Knomosis is treated as an external dependency whose exact version must be pinned before any engineering commitment. As of the v0.4 source review, the public repository describes Knomosis as a proof-carrying state-transition kernel in Lean 4 with mechanically mirrored Solidity and Rust implementations, organized around a Lean source of truth plus deployment mirrors. The README lists version v0.4.11, Lean toolchain v4.29.1, a small trusted core, explicit audit gates, and GPL-3.0-or-later licensing. Licio must not rely on floating `main` in production; it must pin a commit, archive the reviewed source, record deployment manifests, and re-run all Knomosis gates in CI.

### 0.6.4 Final non-negotiable constraints

The following constraints supersede all lower-level implementation choices:

1. Core reading, posting, commenting, reporting, blocking, appeal, privacy, accessibility, and safety features work without a wallet.
2. Payment and treasury data are not ranking features and are not eligible as model inputs except for fraud, compliance, abuse prevention, treasury accounting, or user-requested receipts.
3. Users are never paid cryptocurrency or tokenized assets for posting, reading, inviting, rating, reporting, sharing, or spending attention.
4. A payment cannot unlock higher public reach, privileged search placement, improved ranking, visible status, or moderation leniency.
5. Forum DAO-like governance cannot change global Trust and Safety policies, child-safety controls, legal compliance, privacy defaults, account security, accessibility requirements, or recommender-safety constraints.
6. Smart-contract or L2 failures must degrade the social product gracefully: threads, moderation, reporting, privacy settings, and non-crypto rooms continue operating.
7. All irreversible or financial actions require clear preview, user intent confirmation, failure recovery, audit logging, and support escalation.
8. No sensitive personal data is placed on-chain unless a specific legal basis, user disclosure, data minimization review, and deletion/impossibility review have been completed.
9. Minors are excluded from wallet, crypto payment, treasury, and governance-signing features unless a future jurisdiction-specific legal design explicitly permits a restricted youth mode.
10. The product does not market tokens, treasuries, bounties, or governance as investments or earning opportunities.

### 0.6.5 Final definition of done for the specification

This specification is ready for execution when the team can answer yes to each question below:

1. Can a mobile user understand why a story is visible without seeing likes, upvotes, karma, follower counts, token balances, or donor badges?
2. Can the backend prove that payment events are excluded from ranking features and recommendation features?
3. Can the moderation team intervene in a harmful forum even if that forum's local governance votes otherwise?
4. Can a user join, read, contribute, report, block, appeal, and leave without connecting a wallet?
5. Can every real-funds action be reconciled from product intent through Knomosis receipt to accounting export?
6. Can every launch gate fail closed without breaking the non-crypto social news experience?
7. Can security, privacy, legal, accessibility, and trust-and-safety reviewers inspect logs, decisions, and model/ranking inputs without reconstructing state manually?
8. Can the platform explain every AI summary, invariant gate, ranking dampener, payment hold, moderation action, and governance denial in user-readable form?

# 1. Executive summary

Licio is a mobile-first social news and forum platform built around a new rating primitive: **Participation-Weighted Attention**, abbreviated **PWA**. Users cannot press a like button or upvote button. Instead, the platform computes item visibility from signals such as active reading, source opening, returning to a thread, writing a substantive reply, adding evidence, asking a clarifying question, producing a useful summary, or resolving confusion between communities.

The product’s central insight is that attention is not endorsement. A story that attracts attention may be important, manipulative, tragic, confusing, entertaining, or polarizing. Therefore Licio never treats attention alone as a simple positive vote. Attention becomes rankable only when interpreted through participation, context, independence, fairness, and safety constraints.

The platform has five core invariant services:

1.  **Matroid Exposure Rank Invariant (MERI):** Measures how much of a feed, topic page, or discussion is genuinely nonredundant. It prevents ten near-identical posts from counting as ten independent signals.
2.  **Markov-Fiber Coordination Invariant (MFCI):** Detects suspiciously coordinated activity after conditioning on normal base rates such as time, topic popularity, and community activity.
3.  **Gromov-Wasserstein Experience Isometry (GWEI):** Audits whether cohorts receive structurally comparable platform experiences without requiring identical content.
4.  **Sheaf Context Obstruction Invariant (SCOI):** Measures when local community interpretations of the same content cannot be coherently glued into a shared global understanding.
5.  **Preference Holonomy Invariant (PHI):** Detects whether recommendation paths steer a user’s latent interests in path-dependent ways, especially through rabbit-hole loops.

The application also includes supporting invariants for conversational tension, cascade timing, trend turbulence, attention landscapes, counterfactual recommender defects, and mobile session wellbeing.

Licio is designed as a hybrid of social news, public forum, and civic sensemaking tool. It supports links, original posts, evidence cards, claims, live discussion threads, topic rooms, and curated community lenses. It is not a clone of Reddit, Hacker News, Twitter/X, Bluesky, Threads, or traditional feed apps. Its design avoids applause mechanics and instead rewards contributions that make the shared information environment more intelligible.


## 1.8 v0.3 crypto-governance expansion

Licio v0.3 adds a financial and governance substrate, but the product philosophy does not change: visibility is earned through useful public participation, not purchasable through money or token mechanics. Knomosis is used for verifiable state transitions, treasury accountability, payments, bounties, and room governance. It is not used as an applause counter.

The app now has three complementary planes:

1.  **Civic plane:** stories, threads, evidence, context, source inspection, constructive participation, moderation, and ranking.
2.  **Invariant plane:** MERI, MFCI, GWEI, SCOI, PHI, and supporting safety signals that keep attention-based distribution resistant to redundancy, coordination, inequitable experience, context collapse, and recommender steering.
3.  **Knomosis plane:** optional wallet-linked payments, room treasuries, law packs, proposal state machines, action budgets, audit commitments, and DAO-like governance actions.

A user's civic rights must not depend on crypto holdings. Reading, commenting, reporting, blocking, privacy controls, appeals, and basic room participation remain available without a wallet. Token ownership may gate only explicitly financial or governance-specific actions in Knomosis-enabled rooms, and even those gates must be disclosed, appealable where platform-controlled, and disabled in jurisdictions or app-store contexts where they are not allowed.

# 2. Product north star

## 2.1 North-star statement

Licio helps people discover, understand, and discuss important public information by ranking content according to meaningful attention and constructive participation rather than popularity gestures.

## 2.2 Primary product goals

1.  **Replace popularity voting with participation-weighted attention.** Users do not click like or upvote. Visibility emerges from active reading, evidence exploration, and contribution quality.
2.  **Make social news less redundant.** A topic page should surface independent sources, distinct arguments, and useful perspectives instead of repeating the same item.
3.  **Prevent engagement traps.** Rage, compulsion, and repetitive conflict should not automatically increase ranking.
4.  **Make context visible.** Users should see why a story means different things to different communities before joining the discussion.
5.  **Support mobile-first deep participation.** The phone interface should make it easy to read, annotate, ask, cite, summarize, and participate without feeling like a desktop forum squeezed into a small screen.
6.  **Audit ranking fairness structurally.** Fairness is not just equal exposure counts; it is structurally comparable experience across cohorts.
7.  **Detect manipulation without punishing authentic enthusiasm.** Coordination detection must condition on normal activity patterns.
8.  **Support better public conversation.** The product should reward clarification, evidence, synthesis, and disagreement that improves the state of the thread.

## 2.3 Non-goals

1.  Licio is not a real-time popularity contest.
2.  Licio is not an influencer platform centered on follower accumulation.
3.  Licio is not a private messaging product, though limited direct moderator/user communication may exist.
4.  Licio is not a general-purpose short video entertainment app.
5.  Licio is not an anonymous random chat app.
6.  Licio is not an ad-targeting system optimized for maximum dwell time.
7.  Licio is not a replacement for professional journalism; it is an aggregation, discussion, and sensemaking layer.

## 2.4 Product principles

| Principle                    | Requirement                                                                                                                |
|------------------------------|----------------------------------------------------------------------------------------------------------------------------|
| No applause primitives       | No likes, upvotes, hearts, public karma, public follower counts, or reaction badges may affect ranking.                    |
| Attention is not endorsement | Attention signals must be interpreted alongside participation quality, context, and safety constraints.                    |
| Conversation creates value   | Evidence, clarification, synthesis, correction, and respectful challenge are first-class contribution types.               |
| Nonredundancy matters        | A feed with ten duplicated claims should not outrank a feed with three independent, useful sources.                        |
| Context travels with content | Content crossing communities should carry origin, audience, interpretation, and disagreement context.                      |
| Mobile is primary            | Every major workflow must be usable one-handed, offline-tolerant where possible, and accessible by assistive technologies. |
| Auditability is a feature    | Ranking, moderation, and AI systems must expose meaningful explanations and internal audit logs.                           |
| Privacy by design            | Sensitive attention signals should be minimized, aggregated, protected, and user-controllable.                             |

# 3. Platform concept

## 3.1 Product metaphor

Licio is a **loom** for public knowledge. Sources, posts, claims, comments, summaries, and communities are threads. The product does not ask users to cheer for content. It asks them to help weave a more coherent public fabric.

## 3.2 Core user-facing surfaces

1.  **Front Page:** A personalized but constrained feed of important stories and discussions.
2.  **Topic Rooms:** Persistent spaces around topics such as climate, local politics, science, technology, sports, health, or city-level news.
3.  **Threads:** Structured discussion spaces attached to a story, claim, or question.
4.  **Context Cards:** Compact mobile overlays explaining source history, community interpretations, claim status, timeline, and missing context.
5.  **Evidence Drawer:** A swipe-up panel containing cited sources, primary documents, fact checks, data references, and counterevidence.
6.  **Participation Composer:** A structured mobile composer that asks what kind of contribution the user is making.
7.  **Signal Ledger:** A private user-facing explanation of what attention and participation signals were counted. It is not a public score.
8.  **Civic Map:** A visual overview of topic basins, narrative branches, and cross-community bridges.
9.  **Steward Console:** Moderator and community-steward tooling for queue review, context repair, appeals, and safety decisions.

## 3.3 Core objects

| Object            | Description                                                                                                                     |
|-------------------|---------------------------------------------------------------------------------------------------------------------------------|
| Story             | A submitted link or original item that anchors discussion.                                                                      |
| Source            | The external publisher, author, dataset, document, or media origin.                                                             |
| Claim             | A discrete proposition extracted from a story or comment.                                                                       |
| Evidence Card     | A citation, data point, document, image, transcript, or expert reference supporting or challenging a claim.                     |
| Thread            | A structured conversation space attached to a story, claim, or topic.                                                           |
| Contribution      | A user action that adds public value: question, evidence, correction, synthesis, summary, counterexample, moderation flag, etc. |
| Lens              | A community-specific interpretation frame, such as local resident, domain expert, affected group, skeptic, or beginner.         |
| Context Patch     | A reusable piece of explanation that reduces context obstruction.                                                               |
| Attention Receipt | A private, aggregated record of meaningful attention counted for the user.                                                      |
| Invariant Run     | A computation of one or more mathematical invariants over a time window, feed, thread, cohort, or topic.                        |

# 4. User personas and core jobs

## 4.1 Personas

### The careful reader

Wants to understand a story before forming an opinion. Opens sources, reads context cards, asks clarifying questions, and values summaries.

### The knowledgeable participant

Has domain expertise or direct experience. Adds evidence, corrects misconceptions, explains uncertainty, and helps others understand tradeoffs.

### The local witness

Has situational knowledge about a local issue. Wants to contribute context without becoming an influencer.

### The moderator/steward

Maintains healthy discussion norms, reviews reports, resolves context collisions, and escalates serious safety concerns.

### The casual mobile scanner

Has a few minutes on a phone. Wants an accurate, digestible view of what deserves attention without being pulled into infinite scrolling.

### The researcher/auditor

Studies platform health, fairness, manipulation, and information quality using aggregate transparency data.

## 4.2 User jobs

1.  Discover what matters today without relying on popularity counts.
2.  Understand why a story is receiving attention.
3.  Find the strongest evidence and strongest counterpoints quickly.
4.  Participate without performing for likes.
5.  See whether a discussion is coherent, fragmented, manipulated, or unresolved.
6.  Build reputation for useful contributions without chasing virality.
7.  Avoid being steered into compulsive or extreme loops.
8.  Control privacy around attention-derived signals.

# 5. Rating model: Participation-Weighted Attention

## 5.1 Design mandate

The platform has no explicit popularity votes. There is no like button, no upvote button, no heart, no reaction emoji, no public karma, and no visible follower-count leaderboard.

Instead, content receives a derived distribution score from **Participation-Weighted Attention (PWA)**. PWA estimates the degree to which a story or thread deserves distribution because people gave it meaningful attention and/or made the conversation deeper, clearer, more evidenced, or more useful.

## 5.2 Why attention alone is insufficient

Attention can come from quality, outrage, confusion, fear, novelty, coordination, deception, or harassment. Therefore attention is never a direct endorsement. The platform treats attention as a **salience signal** that must pass through filters:

1.  Was the attention active rather than accidental?
2.  Did the user inspect the source or only react to a headline?
3.  Did participation improve the thread state?
4.  Is attention nonredundant across independent users and communities?
5.  Is the activity coordinated beyond normal base rates?
6.  Does cross-community sharing create context collapse?
7.  Does recommendation create path-dependent steering risk?

## 5.3 Signal categories

### Attention signals

Attention signals are computed from deliberate interaction patterns. Raw time is never enough.

| Signal            | Positive interpretation                                                   | Required guardrail                                                    |
|-------------------|---------------------------------------------------------------------------|-----------------------------------------------------------------------|
| Active dwell      | User spends time reading with foreground focus and normal scroll cadence. | Cap per item, ignore idle time, ignore screen-on inactivity.          |
| Source open       | User opens the original article, document, dataset, or evidence.          | Do not reward clickbait if the user immediately returns.              |
| Context open      | User opens context cards, source history, or claim timeline.              | Count once per meaningful session.                                    |
| Return visit      | User returns after time away, indicating sustained interest.              | Avoid rewarding obsessive loops.                                      |
| Thread traversal  | User reads multiple branches or opposing views.                           | Weight nonredundant traversal more than repeated same-branch reading. |
| Save for later    | User privately marks content to revisit.                                  | Private by default; low rank weight.                                  |
| Share outside app | User sends link externally.                                               | Low rank weight until recipient attention or participation occurs.    |

### Participation signals

Participation signals are public actions that can improve the information environment.

| Contribution type   | Examples                                                                  | Ranking effect                                                     |
|---------------------|---------------------------------------------------------------------------|--------------------------------------------------------------------|
| Clarifying question | “What evidence supports the employment claim?”                            | Positive if it elicits useful answers or identifies ambiguity.     |
| Evidence addition   | Adds primary source, dataset, transcript, legal text, or credible report. | Strong positive if cited and relevant.                             |
| Correction          | Identifies false quote, wrong date, missing caveat, or broken link.       | Strong positive when accepted or corroborated.                     |
| Synthesis           | Summarizes multiple branches fairly.                                      | Positive when it reduces context obstruction or thread repetition. |
| Counterexample      | Adds a relevant exception or opposing case.                               | Positive when it broadens evidence base.                           |
| Domain explanation  | Explains technical, legal, scientific, or local context.                  | Positive if nonredundant and useful to readers.                    |
| Bridge comment      | Translates one community’s interpretation for another.                    | Strong positive when SCOI decreases.                               |
| Steward action      | Moderation clarification, rule reminder, merge suggestion.                | Positive for thread health, not personal fame.                     |

### Anti-signals

| Anti-signal                 | Response                                                         |
|-----------------------------|------------------------------------------------------------------|
| Rapid repetitive commenting | Damp participation weight; possible rate limit.                  |
| Coordinated bursts          | Apply MFCI penalty and review threshold.                         |
| Rage-loop behavior          | Do not convert repeated hostile returns into positive attention. |
| Low-information replies     | Count as conversation volume but not constructive participation. |
| Source-free accusation      | Requires evidence or is downweighted.                            |
| Brigading reports           | Report impact conditioned by MFCI and reporter reputation.       |
| Harassment cascade          | Freeze ranking growth, apply safety review, protect targets.     |

## 5.4 PWA scoring formula

For item `i` in context `c` during time window `t`:

    PWA_i,c,t = B_i,t
              + wA * ActiveAttention_i,c,t
              + wP * ConstructiveParticipation_i,c,t
              + wE * ExposureIndependence_i,c,t
              + wS * SourceAndEvidenceCompleteness_i,c,t
              + wC * ContextCoherenceGain_i,c,t
              - pM * CoordinationPenalty_i,c,t
              - pH * HolonomyRisk_i,c,t
              - pT * HarmfulTensionRisk_i,c,t
              - pR * RedundancyPenalty_i,c,t

Where:

- `B_i,t` is a time-sensitive baseline for freshness, source reliability state, and topic relevance.
- `ActiveAttention` is bounded, privacy-preserving, and deduplicated.
- `ConstructiveParticipation` measures contribution quality and downstream thread improvements.
- `ExposureIndependence` is derived from MERI.
- `ContextCoherenceGain` is derived partly from SCOI reduction.
- `CoordinationPenalty` is derived from MFCI and tropical cascade signals.
- `HolonomyRisk` is derived from PHI.
- `HarmfulTensionRisk` is derived from Hodge tension and safety classifiers.
- `RedundancyPenalty` prevents repeated copies from accumulating distribution power.

The product may expose only a simplified explanation, such as: “Rising because many readers opened the source, three independent evidence cards were added, and the thread has low coordination risk.”

## 5.5 Weighting philosophy

Initial default weights:

| Component                         | Initial range | Rationale                                                |
|-----------------------------------|---------------|----------------------------------------------------------|
| Active attention                  | 20-30%        | Salience matters, but attention alone must not dominate. |
| Constructive participation        | 25-40%        | The platform exists to reward depth and contribution.    |
| Exposure independence             | 10-20%        | Prevents duplicate amplification.                        |
| Evidence/source completeness      | 5-15%         | Encourages substantiation.                               |
| Context coherence gain            | 5-15%         | Rewards bridge work and clear framing.                   |
| Safety and manipulation penalties | Variable      | Penalties can dominate when risk is high.                |

Weights are not one global constant. They vary by surface, topic sensitivity, freshness, age group, jurisdiction, and risk state. For example, breaking disaster news should emphasize timeliness and verified source context, while an evergreen science discussion should emphasize evidence, synthesis, and nonredundancy.

## 5.6 User-facing rating labels

Because there are no likes or upvotes, the app uses descriptive labels:

| Label             | Meaning                                                             |
|-------------------|---------------------------------------------------------------------|
| Getting Attention | Active, non-idle reading is increasing.                             |
| Deepening         | Users are adding evidence, questions, corrections, or summaries.    |
| Well-Sourced      | The thread contains independent evidence cards and primary sources. |
| Needs Context     | Interpretations differ or key context is missing.                   |
| Under Review      | Coordination, safety, or policy signals require review.             |
| Resolved Context  | A previously ambiguous issue has a high-quality synthesis.          |
| Bridge Active     | Multiple communities are engaging with improving coherence.         |

No label should imply that a majority “likes” or “agrees” with the content.

# 6. Mobile-first product requirements

## 6.1 Mobile-first design philosophy

Licio is designed for phones first, not adapted from desktop. The user should be able to do serious public reading and contribution in small, interruptible sessions.

Mobile-first requirements:

1.  Every primary action must be reachable from the thumb zone or a predictable bottom sheet.
2.  The app must support one-handed scanning and two-handed deep composition.
3.  The default feed must use finite sections and stopping cues, not endless engagement extraction.
4.  Long threads must be navigable by semantic structure, not only chronological scrolling.
5.  Context must be available through bottom sheets and cards without losing reading position.
6.  Source opening must use an in-app reader with clear escape back to thread.
7.  Drafting must autosave locally and sync safely.
8.  Offline reading must be supported for saved stories, source snapshots where permitted, and draft contributions.
9.  Push notifications must be limited, explainable, and user-controllable.
10. All interactive targets must be designed for touch, motor accessibility, and screen readers.

## 6.2 App shell

Primary bottom navigation:

| Tab        | Purpose                                                             |
|------------|---------------------------------------------------------------------|
| Front Page | Ranked feed of stories and discussions.                             |
| Rooms      | Topic rooms, local rooms, community lenses, and subscribed areas.   |
| Submit     | Capture link, write post, add evidence, ask question, start thread. |
| Threads    | Active conversations, replies, saved drafts, participation history. |
| Profile    | Private ledger, settings, reputation, privacy, moderation notices.  |

The Submit tab is centered and persistent. It does not imply performative posting; it is a contribution entry point.

## 6.3 Front Page mobile layout

Each feed card contains:

1.  Story title.
2.  Source and origin badge.
3.  Rating label, such as “Deepening” or “Needs Context.”
4.  One-line reason: “Rising from independent source opens and evidence additions.”
5.  Context chips: “3 lenses,” “2 primary sources,” “low coordination risk,” “high debate.”
6.  Reading estimate.
7.  Thread branch preview.
8.  Swipe actions:
    - Swipe left: save for later.
    - Swipe right: open context card.
    - Long press: signal problem, mute source, adjust topic.

No card contains a like count, vote count, heart icon, public score, or reaction bar.

## 6.4 Thread mobile layout

Thread layout uses **structured branches**:

1.  **Overview:** Best current synthesis, unresolved questions, evidence status.
2.  **Questions:** Clarifying questions and answer chains.
3.  **Evidence:** Source cards, datasets, primary documents.
4.  **Challenges:** Counterarguments and fact disputes.
5.  **Local/Expert Lenses:** Community-specific context.
6.  **Chronology:** Time-ordered view for users who prefer traditional thread order.

A floating “Contribute” button opens the Participation Composer. The composer first asks: “What are you adding?” Options include question, evidence, correction, synthesis, counterexample, direct experience, explanation, or moderation concern.

## 6.5 Context cards

Context cards are compact, swipeable overlays:

1.  **What happened?** Basic factual summary.
2.  **Why it matters.** Topic and affected communities.
3.  **Where interpretations differ.** SCOI-powered context map.
4.  **Evidence status.** Source quality, primary evidence, disputed claims.
5.  **Conversation state.** Deepening, fragmented, bridged, tense, or under review.
6.  **Distribution reason.** Why this story is being shown to the user.
7.  **User controls.** See less/more, mute topic, inspect ranking signals.

## 6.6 Mobile participation composer

The composer must reduce low-information replies and encourage substantive contributions. It has structured modes:

| Mode           | Prompt                                    | Required fields                                               |
|----------------|-------------------------------------------|---------------------------------------------------------------|
| Ask            | “What would clarify this?”                | Question text, optional claim reference.                      |
| Evidence       | “What source should readers inspect?”     | Link/file/citation, relevance note, claim reference.          |
| Correction     | “What is incorrect or missing?”           | Correction text, supporting evidence, target text.            |
| Synthesis      | “What can be fairly summarized?”          | Summary, included branches, uncertainty note.                 |
| Counterexample | “What case complicates this?”             | Example, why relevant, source if factual.                     |
| Experience     | “What direct context do you have?”        | Experience scope, location/time if relevant, privacy warning. |
| Explain        | “Can you make this easier to understand?” | Explanation, assumptions, caveats.                            |
| Flag           | “What policy or safety issue exists?”     | Reason, target, urgency.                                      |

The composer should support voice dictation, citation capture from browser share sheet, image/document attachment with privacy warnings, and local draft autosave.

## 6.7 Stopping cues and wellbeing

The app should not optimize for compulsive infinite scroll. Mobile sessions include:

1.  Section endpoints: “You are caught up on high-confidence stories.”
2.  Diminishing returns prompts: “The next items are lower confidence or more repetitive.”
3.  Rage-loop dampening: repeated hostile returns do not increase PWA.
4.  User-set limits: focus mode, local-news-only mode, quiet hours.
5.  Notification budgeting: grouped notifications and daily digests by default.

# 7. Core invariant 1: Matroid Exposure Rank Invariant (MERI)

## 7.1 Purpose

MERI ensures that feed diversity and topic quality are based on nonredundant exposure rather than superficial variety. A user should not see ten versions of the same claim from near-identical sources and have that count as ten useful exposures.

## 7.2 Mathematical model

Let `E` be the set of candidate exposures in a feed, room, topic, or thread. Define an independence system where a subset `S` is independent if its members are nonredundant with respect to source lineage, claim content, evidence basis, creator network, and semantic framing.

A matroid rank function `r(S)` gives the maximum size of an independent subset. The core invariant is:

    MERI(S) = r(S) / |S|

`MERI(S) = 1` means every exposure is independent. Low MERI means the feed or topic is repetitive.

## 7.3 Product interpretation

MERI powers:

1.  Feed deduplication.
2.  Topic-page diversity.
3.  Evidence independence labels.
4.  Anti-spam ranking dampening.
5.  User-facing context: “You have seen three independent versions of this story.”
6.  Creator fairness: creators are not punished for covering the same topic, but redundant copies have bounded marginal value.

## 7.4 Independence dimensions

| Dimension        | Independence condition                                                   |
|------------------|--------------------------------------------------------------------------|
| Source lineage   | Different publisher ownership, author, wire origin, or primary document. |
| Claim content    | Adds a materially distinct claim or question.                            |
| Evidence base    | Uses independent data, witness, document, study, or expert basis.        |
| Community origin | Emerges from a distinct community or local context.                      |
| Semantic framing | Offers a distinct explanatory frame without being misleading.            |
| Temporal update  | Adds new facts after a meaningful event update.                          |

## 7.5 Algorithm sketch

1.  Embed content, claims, titles, source snippets, and evidence cards.
2.  Build similarity graph among candidate exposures.
3.  Add hard parallel classes for identical URLs, syndicated copies, or near-duplicate text.
4.  Add soft dependencies for shared source lineage, same primary evidence, and same narrative frame.
5.  Construct a partition matroid or transversal matroid approximation for production scalability.
6.  Compute greedy rank approximation for candidate set.
7.  Use marginal rank gain as a ranking feature.

Pseudo-code:

    function marginal_exposure_gain(candidate x, current feed S):
        if duplicate_url(x, S): return 0
        if same_claim_same_source_lineage(x, S): return epsilon
        if adds_new_evidence_basis(x, S): return high_gain
        if adds_new_lens_without_misinformation(x, S): return medium_gain
        return estimated_rank_gain(S union {x}) - estimated_rank_gain(S)

## 7.6 UI requirements

1.  Feed cards may show “New angle,” “Independent source,” “Duplicate context,” or “Same claim, new evidence.”
2.  Topic pages must include an “independent sources” drawer.
3.  Users can choose “show fewer repeats” or “show all updates” for specific topics.
4.  The app must never say “this is true because many outlets repeated it.” Repetition is not independence.

## 7.7 Acceptance criteria

| ID     | Requirement                                                                                 |
|--------|---------------------------------------------------------------------------------------------|
| MERI-1 | Near-identical syndicated articles do not each increase feed rank.                          |
| MERI-2 | A primary document adds more independent exposure value than ten posts quoting one another. |
| MERI-3 | Topic pages expose source lineage and evidence lineage.                                     |
| MERI-4 | Ranking experiments must report MERI distribution before launch.                            |
| MERI-5 | MERI features must be explainable in user-facing terms.                                     |

# 8. Core invariant 2: Markov-Fiber Coordination Invariant (MFCI)

## 8.1 Purpose

MFCI detects coordinated behavior while conditioning on normal base rates. It avoids punishing active communities merely for being active.

## 8.2 Mathematical model

Construct contingency tables over dimensions such as:

    user_group x topic x time_bucket x action_type x target

Fix selected margins:

1.  Total activity per group.
2.  Total activity per topic.
3.  Total activity per time bucket.
4.  Total activity per action type.
5.  Expected baseline target popularity.

The set of all tables with those margins is a **fiber**. Markov-basis moves sample plausible alternative tables inside the same fiber. MFCI estimates how extreme the observed coordination statistic is relative to this conditioned distribution.

    MFCI(X) = -log P_fiber(T(X') >= T(X))

Where `T` may measure synchrony, repeated co-action, target concentration, same-phrase repetition, or simultaneous reporting.

## 8.3 Product interpretation

MFCI powers:

1.  Anti-brigading.
2.  Coordinated reporting detection.
3.  Spam and manipulation resistance.
4.  Raid detection.
5.  Botnet detection.
6.  Protection for controversial but authentic communities.
7.  Fair enforcement: activity is suspicious only when unusual after controlling for base rates.

## 8.4 Use cases

| Scenario                                            | Naive interpretation | MFCI interpretation                                       |
|-----------------------------------------------------|----------------------|-----------------------------------------------------------|
| A large fan community discusses the same news       | Suspicious volume    | Normal if conditioned on group size and topic interest.   |
| Many new accounts report one user in two minutes    | High concern         | Extreme target concentration after fixed margins.         |
| Local residents react to a local emergency          | Sudden burst         | Not suspicious if location/topic/time margins explain it. |
| Accounts with different profiles post same phrasing | Maybe normal         | Suspicious if phrase synchronization is extreme.          |

## 8.5 Ranking integration

MFCI does not automatically remove content. It creates risk states:

| MFCI state | Ranking effect               | Moderator effect                   |
|------------|------------------------------|------------------------------------|
| Normal     | No penalty                   | None.                              |
| Elevated   | Distribution dampening       | Add to passive monitoring.         |
| High       | Freeze trend acceleration    | Review queue.                      |
| Severe     | Limit cross-community spread | Immediate safety/integrity review. |

## 8.6 Mobile user experience

Users should not see raw statistical accusations. Instead:

1.  “This thread is temporarily under integrity review.”
2.  “Reporting impact is delayed because report timing is unusual.”
3.  “This topic is receiving unusual synchronized activity. Distribution is slowed while reviewed.”

## 8.7 Acceptance criteria

| ID     | Requirement                                                                |
|--------|----------------------------------------------------------------------------|
| MFCI-1 | Large normal communities are not penalized solely for volume.              |
| MFCI-2 | Coordinated reporting has delayed enforcement impact until reviewed.       |
| MFCI-3 | Severe synchronization freezes trend acceleration within one minute.       |
| MFCI-4 | Every automated coordination action logs fixed margins and statistic used. |
| MFCI-5 | Appeals can inspect a human-readable summary of coordination rationale.    |

# 9. Core invariant 3: Gromov-Wasserstein Experience Isometry (GWEI)

## 9.1 Purpose

GWEI audits whether cohorts receive structurally comparable platform experiences. It does not require every group to see the same posts. It asks whether their experiences have similar relational geometry: diversity, source distance, novelty, discussion depth, evidence access, and topic opportunity.

## 9.2 Mathematical model

For cohort `A`, define a metric-measure space:

    X_A = items shown to cohort A
    d_A = pairwise distance between items by semantic, source, evidence, and community relation
    mu_A = impression or attention weight

For cohort `B`, define `(X_B, d_B, mu_B)`. Gromov-Wasserstein distance compares relational structure without requiring exact item identity:

    GWEI(A,B) = GW((X_A, d_A, mu_A), (X_B, d_B, mu_B))

Low distance means structurally similar experience; high distance indicates potential disparity.

## 9.3 Product interpretation

GWEI powers:

1.  Cross-language fairness audits.
2.  Regional news parity.
3.  New-user vs established-user experience comparison.
4.  Cohort safety audits for minors or vulnerable groups.
5.  Algorithm rollout comparisons.
6.  Creator opportunity analysis.

## 9.4 Experience dimensions

| Dimension          | Examples                                                                  |
|--------------------|---------------------------------------------------------------------------|
| Source diversity   | Local, national, expert, community, primary sources.                      |
| Topic diversity    | Number and distribution of topic basins.                                  |
| Evidence access    | Probability of seeing primary sources or evidence cards.                  |
| Discussion depth   | Thread quality and participation levels.                                  |
| Viewpoint geometry | Relational spread of lenses and claims.                                   |
| Novelty            | Balance of familiar and unfamiliar but relevant material.                 |
| Safety state       | Exposure to harassment, misinformation, manipulation, or graphic content. |

## 9.5 Product constraints

Ranking must respect GWEI guardrails:

1.  A new algorithm cannot launch if protected or sensitive cohorts receive structurally degraded experiences beyond threshold.
2.  Language cohorts should not receive lower evidence completeness simply because fewer moderators speak that language.
3.  Local cohorts should not be starved of local context when a story affects them directly.
4.  Minors must not receive high-holonomy or high-risk rabbit-hole paths.

## 9.6 UI and transparency

GWEI is mostly an internal audit invariant. Public transparency reports may disclose aggregate experience parity metrics, but not sensitive cohort details. Users may see:

1.  “Why am I seeing this?”
2.  “Your feed balances local, national, and topic-room context.”
3.  “You can choose a less personalized feed.”
4.  “You are currently in a source-diverse mode.”

## 9.7 Acceptance criteria

| ID     | Requirement                                                             |
|--------|-------------------------------------------------------------------------|
| GWEI-1 | Major ranking launches require cohort experience-isometry audits.       |
| GWEI-2 | Audits compare relational structure, not only item overlap.             |
| GWEI-3 | Any cohort degradation above threshold requires mitigation or sign-off. |
| GWEI-4 | GWEI dashboards are privacy-protected and access-controlled.            |
| GWEI-5 | Transparency reports publish aggregate experience parity summaries.     |

# 10. Core invariant 4: Sheaf Context Obstruction Invariant (SCOI)

## 10.1 Purpose

SCOI measures context collapse: the failure of local community interpretations to glue into a coherent global understanding. A post may mean one thing in its original community and something very different when detached and shown elsewhere.

## 10.2 Mathematical model

Let communities, topic rooms, or lenses be open sets `U_i`. Each has a local interpretation `s_i`, such as a semantic summary, stance distribution, assumed background, or local norm.

On overlaps `U_i cap U_j`, restriction maps translate local interpretations into a shared comparison space. Differences are cochains:

    delta s_ij = rho_i(s_i) - rho_j(s_j)

If differences cannot be resolved by choosing consistent local adjustments, the obstruction class is nontrivial. The product-level score is:

    SCOI(content) = normalized obstruction magnitude across community overlaps

## 10.3 Product interpretation

SCOI powers:

1.  Context cards.
2.  Cross-community sharing warnings.
3.  Ranking dampening for context-fragile content.
4.  Bridge comment rewards.
5.  Thread summary generation.
6.  Moderator triage.
7.  Community lens design.

## 10.4 Context states

| State      | Meaning                                                     | Product action                                         |
|------------|-------------------------------------------------------------|--------------------------------------------------------|
| Coherent   | Local interpretations mostly agree.                         | Normal distribution.                                   |
| Ambiguous  | Some missing background.                                    | Add context card prompt.                               |
| Split      | Communities read the item differently.                      | Show lens map before commenting.                       |
| Obstructed | Interpretations cannot be reconciled without extra context. | Slow cross-community spread; request bridge/synthesis. |
| Weaponized | Ambiguity is being used to inflame conflict.                | Review and apply safety constraints.                   |

## 10.5 UI requirements

1.  Feed card label: “Needs Context” when SCOI is elevated.
2.  Context card section: “Where interpretations differ.”
3.  Thread branch: “Bridge attempts” highlighting comments that reduce obstruction.
4.  Composer warning: “People in another room are reading this differently. Add context before replying.”
5.  Share dialog: “This item is context-sensitive. Include origin context?”

## 10.6 Ranking integration

High SCOI does not mean bad content. It means the content should travel with context. Ranking response:

| SCOI level | Ranking action                                                   |
|------------|------------------------------------------------------------------|
| Low        | Normal ranking.                                                  |
| Medium     | Require context card in feed.                                    |
| High       | Reduce cross-community amplification until context improves.     |
| Very high  | Prioritize bridge requests, expert context, or moderator review. |

## 10.7 Acceptance criteria

| ID     | Requirement                                                                   |
|--------|-------------------------------------------------------------------------------|
| SCOI-1 | Cross-community distribution must include context when SCOI is elevated.      |
| SCOI-2 | Bridge comments receive participation credit when obstruction decreases.      |
| SCOI-3 | Users can inspect major interpretation differences in plain language.         |
| SCOI-4 | Moderators can merge, annotate, or separate threads based on context state.   |
| SCOI-5 | SCOI features must be validated against human-labeled context-collapse cases. |

# 11. Core invariant 5: Preference Holonomy Invariant (PHI)

## 11.1 Purpose

PHI detects path-dependent steering in recommendation. The concern is not only what a user sees now, but how sequences of recommendations rotate the user’s latent interest representation after moving through topic loops.

## 11.2 Mathematical model

Each topic context has a local coordinate system for user preferences. Moving from context `x` to `y` applies a transport map `A_xy`. Around a closed path:

    x0 -> x1 -> ... -> xk = x0

Compute loop product:

    H(gamma) = A_x{k-1},xk ... A_x0,x1

If `H(gamma)` differs from identity, returning to the same apparent topic has changed the user representation. PHI can use norms, traces, eigenvalue summaries, or log-map approximations:

    PHI(gamma) = || log(H(gamma)) ||

## 11.3 Product interpretation

PHI powers:

1.  Rabbit-hole detection.
2.  Safe exploration limits.
3.  Minors’ feed protection.
4.  Topic-loop dampening.
5.  Recommender audit explanations.
6.  Wellbeing prompts.

## 11.4 Example

Two users both end up viewing nutrition content. One came from sports performance, cooking, and medical guidelines. Another came from conspiracy, miracle cures, and anti-institutional panic. Locally both appear interested in nutrition. PHI distinguishes the path-dependent steering that produced the state.

## 11.5 Ranking constraints

1.  No sequence should repeatedly route a user through high-risk loops without deliberate user choice.
2.  Topic transitions with high holonomy must be dampened or diversified.
3.  Sensitive topics such as self-harm, eating disorders, medical misinformation, extremist ideology, or harassment must have stricter loop thresholds.
4.  Minors receive stricter thresholds and less personalization.
5.  Users can choose chronological, source-diverse, or low-personalization modes.

## 11.6 Mobile UX requirements

1.  “Change the path” prompt: “Your recent feed has become narrow around this topic. See broader context?”
2.  Feed mode switch: “Balanced,” “Chronological,” “Source-diverse,” “Local,” “Low personalization.”
3.  Quiet notification policy for high-holonomy topics.
4.  User-accessible topic controls: mute, reset topic history, reduce personalization.

## 11.7 Acceptance criteria

| ID    | Requirement                                                               |
|-------|---------------------------------------------------------------------------|
| PHI-1 | Ranking service computes path-risk features for recommendation sequences. |
| PHI-2 | High-holonomy loops are dampened before they become dominant.             |
| PHI-3 | Sensitive topics use stricter thresholds.                                 |
| PHI-4 | Users can reset or reduce personalization without deleting their account. |
| PHI-5 | Experiments must report holonomy risk distribution.                       |

# 12. Supporting invariant services

The five core invariants are sufficient for the primary platform. The following supporting invariants add value without overcomplicating the user experience.

## 12.1 Hodge Conversation Tension Invariant

### Purpose

Measures whether conversational conflict is local, cyclical, or globally unresolved.

### Model

Represent conversation as a simplicial complex with users, claims, and replies. Edge flows encode agreement, disagreement, correction, or attention. Hodge decomposition splits flow into gradient, curl, and harmonic components:

    flow = gradient + curl + harmonic

### Product use

1.  Distinguish healthy disagreement from locked structural conflict.
2.  Route moderators to threads with high harmonic tension.
3.  Identify where a synthesis comment could reduce local cycles.
4.  Label a thread “High disagreement, low hostility” versus “Global unresolved conflict.”

## 12.2 Tropical Cascade Rank

### Purpose

Detect timing structures of spread independent of exact wording.

### Model

Use min-plus timing paths to compute earliest arrival and tropical rank of cascade matrices.

### Product use

1.  Detect coordinated link drops.
2.  Detect unnatural trend timing.
3.  Freeze unusually synchronized cascades.
4.  Complement MFCI with timing geometry.

## 12.3 Braid Agenda Dynamics

### Purpose

Analyze trend rank turbulence.

### Model

Trending topics trace strands over time. Crossings form braid words. Invariants such as crossing count and braid entropy quantify agenda turbulence.

### Product use

1.  Detect manufactured churn.
2.  Show editors/stewards when topic order is being gamed.
3.  Identify repeated attempts to keep a topic near a visibility threshold.

## 12.4 Reeb Attention Landscape

### Purpose

Map collective attention basins in semantic space.

### Model

Define a scalar function over content space, such as engagement velocity or controversy. Reeb graphs show how level-set components merge and split.

### Product use

1.  Visualize narrative basins in Civic Map.
2.  Detect topic bifurcation.
3.  Route bridge prompts when two attention basins share a fragile saddle.

## 12.5 Counterfactual Invariance Defect

### Purpose

Audit whether ranking is stable under transformations that should not matter.

### Model

For transformation group `G`, compute:

    CID(x,u) = E_g | R(gx, gu) - R(x,u) |

### Product use

1.  Detect identity-proxy bias.
2.  Test translation fairness.
3.  Verify explanations such as “shown for topic relevance” are stable.
4.  Support model release gates.

## 12.6 Path-Signature Wellbeing Invariant

### Purpose

Analyze mobile session order without reducing behavior to counts.

### Model

Session events form a path. Iterated integrals encode ordered behavior such as read -\> source -\> question, versus scroll -\> rage reply -\> repeat.

### Product use

1.  Detect unhealthy loops without reading private content.
2.  Improve stopping cues.
3.  Distinguish constructive deep dives from compulsive sessions.
4.  Optimize mobile UX for agency rather than addiction.

# 13. Ranking and distribution system

## 13.1 Ranking objectives

Licio’s ranking system is a constrained multi-objective optimizer. It should maximize:

1.  Meaningful attention.
2.  Constructive participation.
3.  Nonredundant exposure.
4.  Evidence completeness.
5.  Context coherence.
6.  Topic relevance.
7.  Civic importance.
8.  User agency.
9.  Conversation health.

Subject to constraints:

1.  Coordination risk below threshold.
2.  Holonomy risk below threshold.
3.  GWEI cohort disparity below threshold.
4.  Redundancy bounded by MERI.
5.  Context obstruction handled by context cards or dampening.
6.  Safety policy compliance.
7.  Privacy and age-appropriate limits.

## 13.2 Candidate generation

Candidate sources:

1.  User’s subscribed rooms.
2.  Local and regional news sources.
3.  Global front-page candidates.
4.  Emerging discussions with high constructive participation.
5.  Independent source additions to already-known stories.
6.  Cross-community bridge candidates.
7.  Expert explanations and high-quality summaries.
8.  Chronological catch-up items.

Candidate generation must preserve a minimum quota of fresh, independent, and local sources to prevent personalization collapse.

## 13.3 Ranking stages

| Stage                  | Description                                                                      |
|------------------------|----------------------------------------------------------------------------------|
| Ingest                 | Normalize submitted links, extract metadata, classify topics, detect duplicates. |
| Candidate retrieval    | Retrieve stories and threads relevant to user, room, and global context.         |
| Invariant feature join | Add MERI, MFCI, GWEI, SCOI, PHI, and support invariant features.                 |
| Safety filter          | Remove or restrict policy-violating content.                                     |
| Multi-objective rank   | Score with PWA and constraints.                                                  |
| Diversification        | Apply nonredundancy, source, lens, and topic balancing.                          |
| Explanation generation | Produce short user-facing distribution reason.                                   |
| Logging                | Record features, decision, and explanation for audit.                            |

## 13.4 Ranking pseudo-code

    function rank_front_page(user u, context c):
        candidates = retrieve_candidates(u, c)
        candidates = remove_policy_disallowed(candidates)

        for item in candidates:
            features[item] = join_features(item, u, c)
            features[item].pwa = compute_pwa(item, u, c)
            features[item].risk = compute_risk_constraints(item, u, c)

        feasible = filter(candidates, risk_below_hard_limits)
        ordered = constrained_optimize(
            feasible,
            maximize = [pwa, exposure_independence, evidence_completeness, relevance],
            constraints = [cohort_parity, context_requirements, holonomy_limits]
        )

        feed = diversify_with_matroid_rank(ordered)
        return attach_explanations(feed)

## 13.5 Ranking explanation examples

1.  “Shown because readers in three rooms opened the source and added independent evidence.”
2.  “Shown with context because communities are interpreting the quote differently.”
3.  “Lower in your feed because it repeats a claim you have already seen from the same source lineage.”
4.  “Shown from outside your usual topics to preserve source diversity.”
5.  “Distribution is slowed because synchronized activity is under review.”

## 13.6 Ranking prohibitions

The ranking system must not:

1.  Use likes or upvotes because they do not exist.
2.  Optimize only for total dwell time.
3.  Treat controversy as quality.
4.  Reward repeated hostile returns.
5.  Count duplicate claims as independent validation.
6.  Boost content solely because a high-reputation user posted it.
7.  Infer sensitive attributes unnecessarily.
8.  Hide all explanations behind vague terms such as “because of the algorithm.”

# 14. Social news aggregation model

## 14.1 Submission types

| Type           | Description                                              | Required metadata                                      |
|----------------|----------------------------------------------------------|--------------------------------------------------------|
| Link story     | External article, blog, report, video, podcast, dataset. | URL, topic, short reason for submission.               |
| Original brief | User-written post.                                       | Topic, title, body, disclosure if personal experience. |
| Question       | A discussion-seeking prompt.                             | Question, context, topic.                              |
| Evidence card  | Source tied to an existing claim.                        | Citation, claim reference, relevance note.             |
| Local update   | Time/place-specific update.                              | Location scope, time, source or experience disclosure. |
| Live thread    | Time-bounded event discussion.                           | Event, time, moderation mode.                          |

## 14.2 Ingestion pipeline

1.  Normalize URL and canonical source.
2.  Detect duplicates and syndicated copies.
3.  Extract metadata, author, date, publisher, and primary media type.
4.  Generate candidate claim list.
5.  Classify topic, location, language, sensitivity, and source type.
6.  Compute embedding and similarity links.
7.  Run initial safety checks.
8.  Initialize MERI, SCOI, and cascade-tracking state.
9.  Create story card and thread shell.

## 14.3 Source model

Sources have public profiles containing:

1.  Name and canonical domain.
2.  Ownership or publisher lineage when known.
3.  Typical topics.
4.  Correction history within Licio.
5.  Evidence type frequency.
6.  Community notes and context cards.
7.  Known syndication relationships.

The source model must not present simplistic “truth scores”. It should expose context and history, not pretend to replace reader judgment.

## 14.4 Story lifecycle

| Stage               | Description                                               |
|---------------------|-----------------------------------------------------------|
| Submitted           | Item exists but lacks conversation.                       |
| Gathering attention | Active reading begins.                                    |
| Deepening           | Evidence, questions, and replies accumulate.              |
| Context needed      | SCOI or evidence gaps are elevated.                       |
| Bridging            | Users add cross-community context or synthesis.           |
| Stable              | Main claims and context are reasonably summarized.        |
| Archived            | Low current activity; preserved for search and reference. |

# 15. Forum and conversation design

## 15.1 Structured contribution taxonomy

The platform should require users to classify contributions because classification improves ranking, moderation, and mobile readability. The app should make classification easy, not burdensome.

Contribution types:

1.  Question.
2.  Answer.
3.  Evidence.
4.  Correction.
5.  Synthesis.
6.  Counterexample.
7.  Explanation.
8.  Local context.
9.  Direct experience.
10. Moderation concern.
11. Meta-discussion about thread structure.

## 15.2 Conversation quality model

A conversation is considered high quality when it has:

1.  Clear claims.
2.  Independent evidence.
3.  Unanswered questions visible.
4.  Corrections accepted or disputed explicitly.
5.  Multiple lenses represented fairly.
6.  Low harassment and low manipulation.
7.  Summaries that improve as the thread grows.
8.  Thread structure that helps readers enter at different depths.

## 15.3 Thread branch scoring

Branches receive internal scores based on:

1.  Nonredundant evidence added.
2.  Questions answered.
3.  Context obstruction reduced.
4.  Harmonic tension reduced without suppressing disagreement.
5.  Corrections incorporated.
6.  Low coordination risk.
7.  Reader utility from active attention and return visits.

No branch receives score from likes.

## 15.4 Summaries

The app supports three summary layers:

1.  **Automated draft summary:** Generated from thread state, labeled as machine-generated, never final.
2.  **Community synthesis:** User-written synthesis that cites branches and evidence.
3.  **Steward summary:** Moderator/steward-approved summary for high-impact threads.

Summaries should include unresolved uncertainty and minority but relevant views.

## 15.5 Comments and replies

Comments must support:

1.  Markdown-lite formatting.
2.  Source citation cards.
3.  Claim references.
4.  Quote snippets with source attribution.
5.  Edit history for material changes.
6.  Deletion with tombstone when necessary for thread integrity.
7.  Abuse reporting.
8.  Translation with original text accessible.
9.  Accessibility labels for attachments.

## 15.6 Reputation without applause

Reputation is based on contribution outcomes, not public likes.

Possible reputation dimensions:

| Dimension            | Signal                                                                   |
|----------------------|--------------------------------------------------------------------------|
| Evidence reliability | Evidence cards remain useful and are cited by later summaries.           |
| Correction accuracy  | Corrections accepted or corroborated.                                    |
| Bridge ability       | Contributions reduce SCOI.                                               |
| Topic expertise      | Domain explanations judged useful by thread outcomes and steward review. |
| Civic conduct        | Low policy violations, constructive disagreement.                        |
| Steward reliability  | Accurate moderation and fair appeals outcomes.                           |

Reputation must be domain-specific, bounded, and not convertible into automatic ranking power.

# 16. Community and governance model

## 16.1 Rooms

Rooms are topic or locality spaces. They can be public, restricted, or expert/steward-led.

Room types:

1.  Global topic room.
2.  Local geographic room.
3.  Professional/domain room.
4.  Event room.
5.  Learning room.
6.  Steward room.

## 16.2 Lenses

A lens is an interpretation context, not a private echo chamber. Examples:

1.  Local resident lens.
2.  Beginner lens.
3.  Expert lens.
4.  Affected community lens.
5.  Skeptical lens.
6.  Policy lens.
7.  Historical lens.

SCOI uses lenses to identify where meanings diverge.

## 16.3 Steward roles

| Role              | Capabilities                                                              |
|-------------------|---------------------------------------------------------------------------|
| Community steward | Organize threads, request context, merge duplicates, escalate moderation. |
| Evidence steward  | Review evidence cards, mark primary sources, flag weak citations.         |
| Safety moderator  | Enforce policy, handle reports, protect targets.                          |
| Appeals reviewer  | Review disputed moderation or account actions.                            |
| Integrity analyst | Investigate coordination, spam, manipulation, and raids.                  |

## 16.4 Governance requirements

1.  Rules must be public and written in plain language.
2.  Moderation actions must have reason codes.
3.  Users must have notice and appeal for significant actions.
4.  Steward actions must be audited.
5.  Public transparency reports must summarize moderation and integrity actions.
6.  High-impact policy changes require changelog and user notice.


## 16.5 Knomosis-enabled room mode

A room may opt into Knomosis-enabled governance only after it passes a readiness checklist:

1.  The room has a plain-language charter.
2.  The room has at least two independent stewards and an appeals path.
3.  The room has a treasury policy with permitted spend categories.
4.  The room has conflict-of-interest rules for bounties, grants, reimbursements, and moderator compensation.
5.  The room has a minimum transparency standard for proposals and treasury events.
6.  The room has a safety override that preserves platform-wide moderation and legal compliance.
7.  The room has a fork/exit process in case of governance capture.
8.  The room's token, wallet, treasury, and governance features are enabled only in supported jurisdictions and app-store distributions.

Knomosis-enabled rooms should be introduced gradually: simulated mode, testnet mode, capped mainnet mode, then mature production mode. Ordinary rooms remain the default.


# 16A. Knomosis L2 payments and DAO-like forum governance

## 16A.1 Purpose and boundaries

Knomosis integration adds verifiable payments and governance to Licio without changing the platform's central anti-vanity premise. The purpose is to let communities fund public-interest information work, govern room-level resources, and audit treasury decisions while preserving mobile-first usability, privacy, safety, and legal compliance.

The integration must observe the following hard boundaries:

1.  **No pay-to-rank.** A payment, token purchase, treasury grant, DAO vote, NFT, stake, or bounty cannot directly raise ranking, search placement, notification priority, trend placement, recommendation eligibility, or author status.
2.  **No reward-for-posting.** Licio must not offer cryptocurrency for completing social tasks such as posting, commenting, inviting users, reacting, or spending time in the app.
3.  **No hidden financial gating.** A user can understand which features require a wallet, which require jurisdiction checks, which require app-store purchase flows, and which are unavailable.
4.  **No on-chain sensitive behavior.** Attention, reading history, report history, safety cases, account sanctions, private messages, minors' data, medical/political inferences, device identifiers, and personal data do not belong on-chain.
5.  **No DAO supremacy over safety.** Room governance is subordinate to law, app-store rules, child safety, privacy obligations, anti-abuse policy, accessibility obligations, sanctions controls, and platform-wide trust-and-safety decisions.
6.  **No unmanaged custody.** If Licio or a partner takes custody, controls user funds, transmits value, exchanges crypto, or provides regulated payment services, the feature must not launch until licensing, registrations, compliance programs, app-store approvals, and operational controls are complete.
7.  **No securities-like token design without counsel.** Governance, treasury, membership, and reward designs must avoid promising profit, passive income, tradable governance speculation, or investment-like claims unless reviewed and approved for every target jurisdiction.

## 16A.2 Source-of-truth interpretation of Knomosis

The public Knomosis repository describes Knomosis as a proof-carrying state-transition kernel with Lean 4 as the formal source of truth, mechanically mirrored Solidity and Rust implementations, and a design where accepted transitions carry machine-checkable evidence. Licio should treat those claims as engineering inputs that require production validation, not as a substitute for security audit.

For Licio, the Knomosis stack is interpreted as four integration layers:

1.  **Formal kernel layer:** law definitions, transition preconditions, invariant preservation, replay guarantees, and machine-checkable legality evidence.
2.  **Solidity settlement layer:** L1 bridge, deposit, withdrawal, state-root, dispute, fault-proof, sequencer-staking, and migration surfaces.
3.  **Rust runtime layer:** host adapter, L1 event ingestion, event subscription, storage/indexing, fault-proof observation, and network operation.
4.  **Licio application layer:** rooms, charters, proposals, treasury policies, evidence bounties, grant records, payment intents, mobile wallet UX, compliance checks, and ranking separation.

The phrase **Knomosis L2** in this spec means the deployable Licio integration around these layers: a Knomosis-backed state-transition environment for room treasury and governance actions, anchored to L1 through the available bridge and settlement components. Engineering must not assume unstated L2 properties. Any production claim about finality, throughput, settlement, withdrawal timing, fault-proof windows, supported tokens, or transaction cost must be validated against the exact deployment.

## 16A.3 Product primitives

### 16A.3.1 Wallet-linked identity

Wallet-linked identity lets a user sign payment and governance actions without making the wallet the user's primary public identity.

Requirements:

1.  Civic account creation does not require a wallet.
2.  A user may link multiple wallets to one civic account, subject to abuse limits and privacy controls.
3.  A wallet may be unlinked if no unresolved obligations, disputes, chargebacks, investigations, or active proposals depend on it.
4.  Wallet names shown in the UI are user-defined labels, not full addresses by default.
5.  Public on-chain participation must be disclosed before signing. Users should understand that wallet-linked actions can be publicly observable.
6.  Contract wallets and multisigs should be supported for stewards, room treasuries, and organizations.
7.  Signature messages must use structured typed data and domain separation so a user can see the action, room, chain, contract, expiration, nonce, and consequences.
8.  Licio must not ask for, store, transmit, or recover seed phrases or private keys.

### 16A.3.2 Crypto payments

Payment types:

1.  **Voluntary support payment:** user supports a creator, journalist, room, or public-interest pool.
2.  **Evidence bounty:** room treasury escrows funds for a specific evidence task, such as obtaining a primary document, translating a source, or summarizing a hearing.
3.  **Source acquisition grant:** treasury reimburses verified costs such as records requests, archive access, expert transcription, or field reporting.
4.  **Moderator/steward stipend:** room compensates disclosed stewardship labor under conflict-of-interest and accountability rules.
5.  **Research/data grant:** room or platform funds privacy-preserving public-interest research outputs.
6.  **Room treasury deposit:** member contributes to a room-governed pool.
7.  **Action-budget top-up:** user or room funds bounded transaction/action capacity without buying visibility.

Prohibited payment uses:

1.  Boosting feed ranking.
2.  Buying trend placement.
3.  Buying search priority.
4.  Buying moderation immunity.
5.  Paying for harassment campaigns, brigades, or coordinated report floods.
6.  Paying users to post, reply, invite, dwell, or perform social tasks.
7.  Selling minors access to financial or speculative features.
8.  Presenting token holdings as social status or public worth.

### 16A.3.3 DAO-like room governance

A Knomosis-enabled room can use DAO-like structures for bounded room-level decisions. Governance actions may include:

1.  Charter creation and amendment.
2.  Steward nomination, removal, and rotation.
3.  Treasury budget allocation.
4.  Evidence bounty creation, amendment, fulfillment, dispute, and payout.
5.  Grant approvals and reimbursements.
6.  Local rule proposals that operate below platform policy.
7.  Delegated budget top-ups for approved operational roles.
8.  Room fork, merger, archive, or migration proposals.
9.  Public audit-log attestations.
10. External partnership approvals.

Governance actions may not include:

1.  Reinstating content or accounts that platform policy or law requires to restrict.
2.  Publishing private safety reports, reporter identities, or protected personal data.
3.  Overriding child-safety, terrorism, self-harm, doxxing, or illegal-content rules.
4.  Removing accessibility, privacy, or security obligations.
5.  Using treasury assets for market manipulation, sanctions evasion, bribery, harassment, or deceptive campaigning.
6.  Altering immutable Knomosis settlement parameters unless the underlying deployment supports a documented migration or amendment process and the change has passed security/compliance review.

### 16A.3.4 Law packs and room charters

A **law pack** is a machine-readable governance policy bundle associated with a room charter. It should contain:

1.  Law-pack identifier and version.
2.  Human-readable charter summary.
3.  Allowed proposal types.
4.  Disallowed proposal types.
5.  Role definitions and signing requirements.
6.  Quorum and threshold rules.
7.  Timelock rules.
8.  Treasury spend categories and caps.
9.  Conflict-of-interest disclosure requirements.
10. Appeal and dispute rules.
11. Fork/exit rules.
12. Emergency override constraints.
13. Schema version and migration path.
14. Hash commitments to off-chain documents.
15. Test fixtures proving expected transition behavior.

Law packs should start simple. The MVP law pack should support only treasury deposits, capped grants, bounty lifecycle, steward rotation, and public audit logs. More complex delegation and migration rules should wait until the legal, security, and operational model is proven.

## 16A.4 Governance states and lifecycle

A room has a governance mode:

| Mode | Meaning | Funds at risk | User-facing status |
|---|---|---:|---|
| Ordinary | No Knomosis integration. | None | Standard room. |
| Simulated | Governance flows run off-chain for education and testing. | None | Simulation badge. |
| Testnet | Wallet and proposal flows use testnet assets. | No real funds | Testnet badge and warnings. |
| Capped production | Real assets allowed under strict limits, regions, and timelocks. | Limited | Production badge, risk disclosures. |
| Mature production | Expanded limits after audits and operating history. | Higher | Production badge, audit history. |
| Frozen | Governance paused due to incident, dispute, legal issue, or policy breach. | Locked/limited | Frozen badge and explanation. |
| Migrating | Room is moving to a new law pack or Knomosis deployment. | Controlled | Migration badge and timeline. |

Proposal lifecycle:

1.  **Draft:** proposer prepares plain-language summary, structured fields, attachments, budget impact, conflicts, jurisdiction flags, and law-pack validation.
2.  **Preflight:** system simulates the action, checks proposal type, signatures, role permissions, budget caps, policy conflicts, app-store constraints, and sanctions/fraud indicators.
3.  **Publication:** proposal appears in the room's Governance tab with a mobile-readable summary and risk labels.
4.  **Deliberation:** users discuss in a linked thread. PWA and invariants may rank discussion quality, but not vote outcomes.
5.  **Voting or attestation:** eligible participants sign votes, delegations, objections, or attestations. The eligibility basis must be transparent.
6.  **Challenge window:** users may flag conflicts, fraud, capture, legal issues, or evidence defects before execution.
7.  **Execution:** if thresholds, timelocks, and checks pass, Knomosis action is submitted.
8.  **Indexing:** event appears in the room audit log and public treasury ledger.
9.  **Appeal/dispute:** operational and governance disputes follow the charter and platform policy.
10. **Postmortem:** high-impact or disputed actions produce a structured outcome summary.

## 16A.5 Voting, delegation, and anti-capture design

Licio should avoid naive one-token-one-vote governance as the default because it encourages plutocracy, vote buying, and capture. Supported models should be configurable per room but constrained by platform policy.

Permitted governance weight models:

1.  **One verified civic account, one governance vote:** simplest for small rooms with strong anti-Sybil controls.
2.  **Reputation-bounded vote:** private reputation or steward status can add limited weight, capped and explainable.
3.  **Role-based quorum:** some decisions require distinct role classes, such as steward plus evidence steward plus ordinary members.
4.  **Quadratic or capped token voting:** only if Sybil controls, anti-bribery monitoring, and legal review are passed.
5.  **Delegated vote:** users can delegate to stewards or experts, with revocation and public delegation logs.
6.  **Multisig steward execution:** treasury actions require several independent stewards, plus timelock.

Required anti-capture controls:

1.  Maximum voting weight per account/wallet cluster.
2.  Eligibility age or contribution-history requirements for high-impact decisions.
3.  MFCI monitoring for suspicious synchronized voting, proposal floods, and bounty collusion.
4.  Conflict-of-interest disclosure before votes on grants, bounties, or stipends.
5.  Cooling-off periods for new wallets before treasury control.
6.  Fork/exit rights if a room is captured.
7.  Public audit trail for treasury actions.
8.  Emergency freeze path for exploit, compromise, sanctions risk, or legal order.

## 16A.6 Treasury architecture

Each production Knomosis-enabled room may have a treasury with these controls:

1.  Treasury address or contract reference.
2.  Accepted assets list.
3.  Jurisdiction availability map.
4.  Deposit limits per user, room, period, and asset.
5.  Spend categories and caps.
6.  Multisig or policy-controlled execution requirements.
7.  Timelocks for material disbursements.
8.  Emergency freeze and incident recovery rules.
9.  Public ledger and reconciliation reports.
10. Tax/accounting export.
11. Sanctions/fraud screening where required.
12. Reserve policy for refunds, disputes, and errors.
13. No commingling between room treasuries and platform operating funds.
14. No reuse of user assets for yield, lending, staking, rehypothecation, or market-making unless explicitly approved by legal, disclosed, and regionally permitted.

Treasury dashboard tabs:

1.  **Overview:** balance by asset, monthly inflow/outflow, active grants, pending proposals, risk status.
2.  **Proposals:** draft, active, passed, rejected, executed, disputed.
3.  **Grants and bounties:** open tasks, assigned work, completed work, payout status.
4.  **Audit log:** deposits, withdrawals, signatures, execution events, law-pack changes, freezes, migrations.
5.  **Rules:** charter, law pack, roles, limits, timelocks, conflict rules.
6.  **Disclosures:** jurisdiction limitations, risk warnings, tax note, support contact, incident history.

## 16A.7 Action budgets and gas-pool model

Licio should use Knomosis action budgets as an anti-spam and capacity-management mechanism, not as a social-status or ranking asset.

Rules:

1.  Basic civic actions remain free or platform-sponsored within abuse-resistant limits.
2.  Knomosis actions may consume budget units for proposal submission, treasury operations, law-pack changes, and execution calls.
3.  A room may fund action budgets for stewards or approved workflows.
4.  Action budgets must not be tradable in-app.
5.  Budget top-ups must not affect feed ranking.
6.  Budget consumption must be visible before signing.
7.  High-risk actions require preflight simulation and explicit confirmation.
8.  Budget grants should expire or reset only if legally and app-store compatible; users must receive clear terms.
9.  Abuse teams can freeze or rate-limit budget use under documented policy.

## 16A.8 Mobile-first wallet and governance UX

Wallet and DAO features must feel native to a phone and safe for non-expert users.

### 16A.8.1 Wallet entry points

Wallet entry points are intentionally rare:

1.  Governance tab in a Knomosis-enabled room.
2.  Treasury support button.
3.  Evidence bounty contribution flow.
4.  Grant application or payout flow.
5.  Steward console for treasury execution.
6.  Account settings wallet page.

The home feed, thread reading, source opening, commenting, reporting, blocking, and privacy controls should not push users into wallet connection.

### 16A.8.2 Transaction preview

Every mobile transaction preview must show:

1.  Plain-language action name.
2.  Room name and room ID.
3.  Recipient or contract.
4.  Asset and amount.
5.  Estimated network fee.
6.  Whether the action is reversible.
7.  Timelock or challenge period.
8.  Public visibility of the transaction.
9.  Jurisdiction and compliance status.
10. Risk label.
11. Wallet address to be used.
12. Chain ID and contract domain.
13. Expiration and nonce.
14. Link to proposal or bounty.
15. Support contact.

The primary button should say exactly what happens: **Sign proposal**, **Contribute 10 USDC**, **Execute grant payout**, or **Delegate governance role**. Avoid vague verbs such as **Continue**, **Confirm**, or **Approve** for financial actions.

### 16A.8.3 Governance tab mobile layout

A Knomosis-enabled room has a **Governance** tab with four cards:

1.  **Charter:** plain-language rules, law-pack version, steward roles, appeal path.
2.  **Treasury:** balances, limits, inflows/outflows, pending disbursements, audit log.
3.  **Proposals:** active, urgent, expiring soon, executed, disputed.
4.  **Grants and bounties:** tasks, requirements, applicants, evidence, payout state.

For mobile readability, each proposal uses a structured summary:

1.  What changes?
2.  Why now?
3.  Who benefits?
4.  Who receives funds?
5.  What are the risks?
6.  What happens if it passes?
7.  What happens if it fails?
8.  What is the deadline?
9.  What conflicts have been disclosed?
10. What platform policies constrain this proposal?

## 16A.9 Integration with ranking and invariants

Knomosis actions produce useful context but not direct ranking boosts.

Allowed ranking interactions:

1.  A funded evidence bounty can create a **Needs evidence** card in the relevant room.
2.  Completed evidence can improve a thread's evidence quality if it is independently reviewed and cited.
3.  Treasury transparency can improve user trust in a room but cannot independently raise every room post.
4.  Governance deliberation can be ranked by constructive participation, not by token votes.
5.  MFCI can detect suspicious synchronized grants, votes, or bounty completions.
6.  MERI can prevent duplicate paid evidence from inflating nonredundant exposure.
7.  SCOI can flag governance proposals that mean different things to different lenses.
8.  GWEI can audit whether crypto-enabled rooms receive disproportionate exposure compared with ordinary rooms.
9.  PHI can prevent wallet-related content loops from steering users into speculative rabbit holes.

Prohibited ranking interactions:

1.  More funds cannot mean more feed reach.
2.  More tokens cannot mean more public authority outside governance-specific UI.
3.  Higher treasury balance cannot make a room trend.
4.  Paid creator support cannot boost the creator's content.
5.  Grant recipients cannot receive automatic distribution preference.
6.  Governance participation cannot substitute for content quality, evidence quality, or safety status.

## 16A.10 Compliance and policy architecture

Licio should operate crypto features as a compliance-gated product family.

### 16A.10.1 Custody model decision

Before production launch, the company must choose and document one of these models:

1.  **Non-custodial connector model:** users connect external wallets; Licio does not custody funds, exchange assets, or control private keys. This is preferred for MVP, but still requires legal review, disclosures, fraud controls, app-store review, and regional availability controls.
2.  **Partner-custodial model:** a licensed partner provides wallet, fiat on/off-ramp, KYC/AML, transaction monitoring, tax forms, and customer support for regulated flows. Licio integrates through APIs and must clearly identify the regulated provider.
3.  **First-party custodial model:** Licio controls or transmits user assets. This is not recommended for MVP and should be blocked until licensing, compliance staffing, audits, bonding/insurance, financial controls, disaster recovery, and regulator engagement are complete.

### 16A.10.2 Jurisdiction policy engine

The app must maintain a jurisdiction policy engine with:

1.  Supported country/region list.
2.  Asset availability by region.
3.  Feature availability by region.
4.  KYC/AML trigger thresholds.
5.  Sanctions restrictions.
6.  Age restrictions.
7.  App-store storefront restrictions.
8.  Tax disclosure requirements.
9.  Consumer risk disclosures.
10. Regulator/contact mapping.
11. Disabled-region fallback UX.
12. Evidence of legal approval by release.

### 16A.10.3 App-store constraints

Mobile releases must comply with Apple and Google policies. Product rules:

1.  The iOS app must not use cryptocurrency or wallet ownership to unlock ordinary app functionality or digital content that app-store rules require to use in-app purchase.
2.  The app must not offer crypto for social tasks, posting, inviting, dwell time, or engagement.
3.  The app must not allow paid post boosts through off-platform crypto payments.
4.  Wallet functionality must be provided only under eligible developer/account structures and region-specific requirements.
5.  Any exchange, purchase, custody, or transmission flow must be offered only where licensed or through a properly approved provider.
6.  Google Play financial/blockchain declarations must be completed before releases containing financial or tokenized-asset functionality.
7.  UGC moderation, reporting, blocking, filtering, and contact flows remain mandatory and cannot be weakened by room governance.
8.  App-review notes must explain the no-pay-to-rank design, crypto feature scope, demo credentials, moderation controls, jurisdiction gating, and disabled states.

### 16A.10.4 AML, fraud, sanctions, and abuse controls

Controls required before real funds:

1.  Sanctions screening where required by the custody/payment model.
2.  Transaction monitoring for suspicious flows.
3.  Velocity limits by wallet, account, room, asset, and jurisdiction.
4.  Fraud queue for suspicious grants, bounties, deposits, and payouts.
5.  IP/device/account risk checks that do not expose private attention behavior to chain analytics providers.
6.  Manual review for high-value treasury disbursements.
7.  Treasury freezes for suspected compromise or illegal activity.
8.  Case management for fraud, scams, impersonation, bribery, and coercion.
9.  Law-enforcement request workflow.
10. SAR/STR workflow if the chosen operating model creates reporting obligations.
11. Record-retention schedule approved by counsel.
12. User support workflow for mistaken transfers, scams, wallet compromise, and lost access.

## 16A.11 Security architecture

Security requirements:

1.  Pin Knomosis commit, contracts, ABIs, runtime version, chain ID, deployment addresses, and law-pack hashes.
2.  Run Knomosis Lean, Solidity, and Rust validation gates in CI for any integration-facing change.
3.  Use typed structured-data signing, explicit domain separators, nonces, expirations, and replay protection.
4.  Treat all wallet signatures as high-risk user actions.
5.  Never request seed phrases.
6.  Support hardware wallets and contract wallets where feasible.
7.  Provide transaction simulation before signing.
8.  Maintain allowlists for production contracts.
9.  Warn on unknown chain, unknown contract, high allowance, unlimited approval, suspicious recipient, and mismatched domain.
10. Use least-privilege service accounts for indexers and gateway services.
11. Store signing keys in HSM/KMS or approved secure enclaves if any platform-side signing exists.
12. Separate bridge/operator keys, treasury keys, deployment keys, and application keys.
13. Use multisig and timelock for platform-owned treasury and upgrade/migration actions.
14. Monitor bridges, indexers, event ingestion, reorgs, dispute windows, and withdrawal queues.
15. Maintain kill switches for UI surfaces, gateway submissions, payment intents, and room treasury operations.
16. Establish bug bounty scope before mainnet funds.
17. Obtain external smart contract, mobile, backend, cryptography, and operational security audits before production funds.
18. Practice incident drills for bridge halt, indexer corruption, compromised steward, malicious proposal, sanctions hit, contract bug, and wallet-drainer campaign.

## 16A.12 Data model additions

New entities:

    WalletAccount {
      wallet_account_id
      user_id
      address_hash
      address_display_truncated
      chain_id
      wallet_type
      linked_at
      unlink_state
      risk_state
      last_used_at
    }

    KnomosisDeployment {
      deployment_id
      environment
      chain_id
      l1_bridge_address
      l2_or_runtime_endpoint
      contract_manifest_hash
      law_pack_registry_ref
      pinned_commit
      status
      created_at
    }

    RoomGovernanceProfile {
      room_id
      governance_mode
      law_pack_id
      charter_version_id
      treasury_id
      quorum_policy
      threshold_policy
      timelock_policy
      jurisdiction_policy_id
      status
    }

    LawPack {
      law_pack_id
      version
      knomosis_commit
      schema_version
      human_summary
      machine_spec_ref
      hash_commitment
      fixture_corpus_ref
      audit_state
      effective_at
    }

    RoomTreasury {
      treasury_id
      room_id
      deployment_id
      treasury_address
      accepted_assets
      balance_snapshot_ref
      deposit_limits
      spend_limits
      timelock_policy
      freeze_state
      accounting_state
    }

    GovernanceProposal {
      proposal_id
      room_id
      proposer_user_id
      proposer_wallet_ref
      proposal_type
      title
      summary
      structured_payload
      requested_amount
      recipient_ref
      conflict_disclosures
      preflight_state
      voting_state
      execution_state
      challenge_window_end
      created_at
      executed_at
    }

    GovernanceSignature {
      signature_id
      proposal_id
      user_id
      wallet_ref
      signature_type
      typed_data_hash
      signature_ref
      weight_snapshot
      eligibility_reason
      created_at
    }

    TreasuryGrant {
      grant_id
      room_id
      treasury_id
      proposal_id
      recipient_user_id_or_entity
      recipient_wallet_ref
      purpose
      amount
      asset
      milestone_state
      review_state
      payout_state
      audit_summary
    }

    PaymentIntent {
      payment_intent_id
      user_id
      room_id
      target_type
      target_id
      asset
      amount
      jurisdiction_state
      compliance_state
      quote_ref
      expiration
      execution_state
      receipt_ref
    }

    KnomosisActionRecord {
      action_record_id
      deployment_id
      action_type
      room_id
      actor_ref
      payload_hash
      signed_action_ref
      submission_state
      knomosis_event_ref
      indexed_at
      reconciliation_state
    }

    OnChainEvent {
      event_id
      deployment_id
      chain_id
      block_number
      tx_hash
      log_index
      event_type
      decoded_payload_ref
      reorg_state
      indexed_at
    }

    JurisdictionFeaturePolicy {
      policy_id
      country_or_region
      app_storefront
      feature_flags
      asset_flags
      age_gate_policy
      kyc_policy
      disclosure_refs
      legal_approval_ref
      effective_at
    }

## 16A.13 API additions

New API groups:

    POST /wallet/nonce
    POST /wallet/link
    POST /wallet/unlink/request
    GET  /wallets
    GET  /wallets/{wallet_id}/risk-state

    GET  /knomosis/deployments
    GET  /knomosis/deployments/{deployment_id}/manifest
    POST /knomosis/actions/preflight
    POST /knomosis/actions/submit
    GET  /knomosis/actions/{action_record_id}

    GET  /rooms/{room_id}/governance
    POST /rooms/{room_id}/governance/proposals
    GET  /rooms/{room_id}/governance/proposals/{proposal_id}
    POST /rooms/{room_id}/governance/proposals/{proposal_id}/sign
    POST /rooms/{room_id}/governance/proposals/{proposal_id}/challenge
    POST /rooms/{room_id}/governance/proposals/{proposal_id}/execute

    GET  /rooms/{room_id}/treasury
    POST /rooms/{room_id}/treasury/payment-intents
    GET  /rooms/{room_id}/treasury/payment-intents/{payment_intent_id}
    GET  /rooms/{room_id}/treasury/grants
    POST /rooms/{room_id}/treasury/grants
    GET  /rooms/{room_id}/treasury/audit-log

    GET  /jurisdiction/features
    POST /compliance/financial/preflight
    POST /compliance/financial/case

API requirements:

1.  All financial endpoints require idempotency keys.
2.  All write actions require anti-replay nonces and explicit expiration.
3.  API responses must include mobile-readable status, next action, and disabled-state reason.
4.  Financial actions must produce immutable audit records.
5.  Sensitive compliance fields must be access-controlled and excluded from analytics by default.
6.  Event indexing must be reorg-aware and reconciliation-safe.
7.  The API must distinguish **submitted**, **accepted**, **settled**, **finalized**, **challenged**, **reverted**, and **failed** states.

## 16A.14 Backend service additions

Additional services:

1.  **Knomosis Gateway:** validates, preflights, submits, and tracks Knomosis actions.
2.  **Wallet Identity Service:** manages wallet-link nonces, signatures, unlinking, and wallet risk states.
3.  **Treasury Service:** manages room treasury metadata, payment intents, grants, bounties, limits, and reconciliation.
4.  **Governance Service:** manages proposals, charters, law-pack mapping, voting/delegation, challenge windows, and execution readiness.
5.  **Law-Pack Registry:** stores approved law packs, hashes, fixtures, audit state, and migration history.
6.  **Compliance Gateway:** applies jurisdiction policy, KYC/AML partner status, sanctions/fraud preflight, and app-store availability rules.
7.  **On-Chain Indexer:** consumes Knomosis bridge, treasury, proposal, and event logs; handles reorgs; emits normalized events.
8.  **Ledger Reconciliation Service:** reconciles payment intents, on-chain events, Knomosis action records, and room treasury balances.
9.  **Financial Case Management:** supports fraud, scam, sanctions, chargeback-equivalent, mistaken-transfer, and legal-request workflows.
10. **Mobile Transaction Renderer:** produces exact transaction-preview payloads for native clients.

New event stream topics:

1.  `wallet.link.requested`
2.  `wallet.linked`
3.  `payment.intent.created`
4.  `payment.intent.failed`
5.  `payment.receipt.indexed`
6.  `room.governance.mode.changed`
7.  `governance.proposal.created`
8.  `governance.signature.recorded`
9.  `governance.proposal.executed`
10. `governance.proposal.challenged`
11. `treasury.deposit.indexed`
12. `treasury.grant.approved`
13. `treasury.payout.executed`
14. `knomosis.action.preflighted`
15. `knomosis.action.submitted`
16. `knomosis.event.indexed`
17. `compliance.financial.case.created`
18. `jurisdiction.feature.disabled`

## 16A.15 MVP scope for Knomosis integration

The MVP must be intentionally conservative.

Included in MVP:

1.  Read-only Knomosis documentation and room governance education.
2.  Simulated governance mode for selected pilot rooms.
3.  Testnet wallet-link and proposal signing.
4.  Testnet room treasury with fake assets.
5.  Law-pack registry v0 with fixed templates.
6.  Proposal lifecycle for charter update, bounty creation, bounty completion, and capped grant.
7.  Transaction preview and typed signing UX.
8.  Read-only audit log.
9.  Compliance feature gating by country/storefront.
10. Shadow-mode invariant monitoring of governance manipulation.

Excluded from MVP:

1.  First-party custody.
2.  In-app exchange or on/off-ramp.
3.  Speculative tokens.
4.  Token rewards for posting or engagement.
5.  Pay-to-boost.
6.  Production mainnet funds before audit.
7.  Complex programmable law packs.
8.  Permissionless DAO creation.
9.  Anonymous high-value treasury disbursement.
10. Governance control over platform-wide moderation.

## 16A.16 Production launch gates

Production real-funds launch is blocked until all gates pass:

1.  Legal sign-off for each target jurisdiction.
2.  App-store review strategy and required declarations.
3.  Custody model decision and partner contracts if applicable.
4.  AML/fraud/sanctions controls appropriate to the model.
5.  Tax/accounting plan for treasuries, grants, and fees.
6.  External audit of smart contracts and Knomosis deployment configuration.
7.  External audit of mobile wallet flows and backend gateways.
8.  CI validation of Knomosis Lean/Solidity/Rust cross-stack fixtures.
9.  Reorg and reconciliation tests.
10. Disaster recovery test.
11. Bug bounty ready.
12. Security incident runbook tested.
13. Financial support team trained.
14. Trust-and-safety team trained on crypto-enabled abuse.
15. Public risk disclosures ready.
16. Rollback and freeze controls tested.
17. Treasury limits configured.
18. Region/age/app-store feature flags verified.
19. Monitoring dashboards live.
20. Pilot room charters approved.

## 16A.17 Success metrics

Crypto/governance success must be measured by public-value outcomes, not asset volume.

Good metrics:

1.  Evidence bounties completed with accepted primary sources.
2.  Grant-funded context cards that improve thread resolution.
3.  Treasury transparency completeness.
4.  Proposal participation diversity.
5.  Low scam/fraud incident rate.
6.  Low governance capture rate.
7.  High percentage of treasury actions with clear public purpose.
8.  Low reversal/dispute rate.
9.  User comprehension of transaction previews.
10. No measurable pay-to-rank effect.

Bad metrics to avoid:

1.  Total value locked as a primary KPI.
2.  Number of tokens traded.
3.  Number of wallet connects as growth KPI.
4.  Governance vote volume without outcome quality.
5.  Treasury size as room status.
6.  Crypto revenue as the main success criterion.
7.  Speculative asset price.
8.  Engagement caused by financial hype.


## 16A.18 Final Knomosis production architecture refinements

### 16A.18.1 Knomosis dependency handling

Licio must treat Knomosis like critical financial infrastructure. The integration team should maintain a `knomosis_dependency_manifest` with these fields:

- repository URL;
- exact commit hash;
- tag or version label;
- Lean toolchain version;
- Solidity compiler and Foundry versions;
- Rust toolchain version;
- deployment manifest hash;
- law-pack hash;
- contract addresses and chain IDs;
- bridge/fault-proof configuration;
- CI gate results;
- external audit report references;
- known limitations and disabled features.

No production deployment may use an unpinned branch name. A source update requires a dependency-review ticket, reproducible builds, replay tests, fixture comparison, security review, and a migration/rollback plan.

### 16A.18.2 Custody and payment posture

The final recommended posture is:

1. **MVP:** non-custodial wallet connection or non-custodial smart-account flow only; no exchange, no fiat off-ramp, no yield, no margin, no lending, no pooled investment products, and no platform custody of user private keys.
2. **Pilot:** capped real-funds support only in approved jurisdictions, approved app builds, approved rooms, and approved assets. Treasury caps are low and manually reviewed.
3. **Future:** any custodial, brokerage, stablecoin conversion, fiat on/off-ramp, or managed treasury product requires separate legal analysis, licensing/partner strategy, consumer disclosures, compliance staffing, and app-store review.

Wallet linkage should be implemented as proof of control over an address, not as proof of legal identity, unless a separate regulated identity verification workflow is required for a specific payment or treasury action.

### 16A.18.3 Law-pack lifecycle

A law pack is the machine-checkable governance rule bundle for a room, treasury, or proposal type. Each law pack must move through these states:

1. **Draft:** written in human-readable form and mapped to Knomosis action types.
2. **Static review:** checked for scope, policy compatibility, legal concerns, terminology, and conflicts with global rules.
3. **Simulation:** executed against synthetic rooms, synthetic attacks, edge cases, bad inputs, and replay tests.
4. **Testnet:** used with test assets by approved pilot rooms.
5. **Capped production:** enabled for low-value, low-risk actions only.
6. **Standard production:** expanded after enough safe history and successful audits.
7. **Deprecated:** new proposals disabled; existing actions completed, migrated, or archived.
8. **Revoked:** disabled for safety, legality, bug, or abuse reasons.

Every law-pack upgrade requires a migration plan, backward compatibility review, user notice where applicable, and a post-deployment reconciliation check.

### 16A.18.4 Treasury-control model

A production room treasury requires these controls:

- deposit allowlist by asset, chain, jurisdiction, and room status;
- daily, weekly, and per-proposal value caps;
- mandatory timelocks for material actions;
- dual or multi-role approval above low thresholds;
- conflict-of-interest declaration before steward approval;
- independent review path for grants and bounties;
- recipient allowlist or risk screening for payouts where required;
- challenge window before irreversible execution;
- emergency hold with reason code, expiration, and appeal/review path;
- reconciliation job after every sequenced action;
- accounting export for room stewards and platform finance;
- public aggregate transparency without exposing unnecessary user-level payment history.

### 16A.18.5 Payment and governance privacy

Wallet addresses can reveal sensitive social interests. Licio should therefore default to privacy-preserving display:

1. The profile does not publicly show connected wallet addresses by default.
2. Payment receipts can show short address fragments, organization names, or privacy-preserved classes depending on law and user choice.
3. Wallet linkage is stored separately from reading, attention, moderation, and personalization data.
4. On-chain records should reference proposal IDs and commitments, not personal safety reports or private contribution details.
5. Data subject rights workflows must cover off-chain wallet-linking records; on-chain immutability must be explained before any transaction.
6. Staff tooling must separate financial compliance visibility from ordinary moderation visibility unless a case requires escalation.

### 16A.18.6 App-store-safe crypto boundaries

The mobile apps must be designed so they can be reviewed and operated with feature flags:

- iOS and Android builds can disable wallet, treasury, or payment flows by region, app-storefront, app version, account age, room risk, or compliance status.
- Crypto is never used to unlock in-app digital functionality that app-store rules require to go through native in-app purchase.
- Tips, grants, and contributions are voluntary and not exchanged for ranking, badges, stickers, premium comments, visibility, or exclusive in-app social features.
- The app does not run device cryptomining and does not encourage financial speculation, gambling, or chance-based tokenized rewards.
- The app includes UGC reporting, blocking, moderation, and contact mechanisms even in wallet-enabled rooms.
- The app-store review package must explain wallet optionality, no-pay-to-rank controls, UGC moderation controls, financial declarations, and disabled-region behavior.

### 16A.18.7 Knomosis observability and reconciliation

Knomosis integration needs three independent views of truth:

1. **User intent log:** the mobile/backend payment or proposal intent before signing.
2. **Knomosis receipt log:** sequenced action, law-pack result, event, status, and proof/commitment references.
3. **Product projection:** room treasury balance, proposal state, payout status, and visible governance history.

A reconciliation service must compare these views continuously. Mismatches enter a queue with severity, affected room, affected action, amount at risk, user-facing status, and rollback/freeze recommendation. A production system should not silently fix financial mismatches without preserving the original discrepancy record.

## 16A.19 Final DAO-like forum governance refinements

### 16A.19.1 Recommended governance launch sequence

Licio should launch governance in this order:

1. **Ordinary rooms:** no wallet and no on-chain governance.
2. **Governance simulation:** proposals, deliberation, and steward votes with no crypto value and no on-chain execution.
3. **Testnet forum commons:** wallet signing and Knomosis receipts with test assets only.
4. **Capped grant rooms:** low-value real-funds grants and bounties for public-value work.
5. **Mature commons:** broader proposal categories, delegation, law-pack migration, and audit exports.

This sequence avoids making crypto infrastructure a prerequisite for the core social news product and gives the team measurable evidence before irreversible value transfer.

### 16A.19.2 Anti-capture controls

Forum governance must assume that wealthy, coordinated, or highly motivated actors will try to capture treasuries and rules. Required controls:

- account-age thresholds for governance actions;
- contribution-quality eligibility for certain local roles;
- role diversity requirements for treasury actions;
- quorum floors and participation caps;
- cooldowns between related proposals;
- MFCI checks for synchronized votes, proposal floods, bounty farming, and collusive reviewer rings;
- public conflict disclosures for stewards and grant reviewers;
- challenge windows for high-impact proposals;
- platform veto only for defined safety, legal, privacy, app-store, security, or fraud reasons;
- appeal and transparency record for vetoes and emergency holds.

### 16A.19.3 Proposal quality requirements

A governance proposal is eligible for deliberation only if it includes:

1. purpose;
2. affected room;
3. charter authority;
4. action type;
5. requested amount, if any;
6. recipient and conflict disclosures, if any;
7. evidence or rationale;
8. risks;
9. alternatives considered;
10. success criteria;
11. rollback or failure handling;
12. timeline;
13. reviewer/steward responsibilities;
14. user-facing summary.

Low-quality proposals should be returned for revision rather than converted into public drama or attention bait.

# 17. Trust, safety, and moderation

## 17.1 Policy categories

Licio should maintain clear policies for:

1.  Illegal content.
2.  Credible threats and incitement.
3.  Harassment and targeted abuse.
4.  Hate and dehumanization.
5.  Sexual exploitation and child safety.
6.  Graphic or shocking content.
7.  Medical, civic, and crisis misinformation.
8.  Impersonation and deceptive identity.
9.  Spam and platform manipulation.
10. Privacy violations and doxxing.
11. Synthetic media disclosure.
12. Intellectual property reports.

## 17.2 Moderation layers

| Layer                   | Function                                                                   |
|-------------------------|----------------------------------------------------------------------------|
| User controls           | Mute, block, report, hide topic, reduce personalization.                   |
| Automated pre-checks    | Detect obvious spam, malware links, duplicate floods, policy-risk content. |
| Community stewardship   | Context repair, duplicate merge, branch organization, soft warnings.       |
| Professional moderation | Policy enforcement, urgent safety, appeals.                                |
| Integrity review        | Coordination, brigading, bot activity, suspicious campaigns.               |
| External escalation     | Legal, child safety, imminent harm, regulator requests.                    |

## 17.3 Moderation UX

1.  Reports must be simple from mobile long press.
2.  Report reasons must be specific.
3.  Emergency report flows must be separate from ordinary disagreement.
4.  Users must be able to block accounts immediately.
5.  Content hidden by default due to safety must show a clear state, not disappear silently when possible.
6.  Moderation notices must be readable on mobile and include appeal path.

## 17.4 DSA-inspired transparency patterns

For jurisdictions where applicable, and as a global best practice where feasible:

1.  Provide notice-and-action mechanisms.
2.  Provide statements of reasons for significant moderation decisions.
3.  Maintain transparency reporting.
4.  Explain recommender-system main parameters in user-facing language.
5.  Provide non-personalized or less-personalized feed options.
6.  Maintain internal risk assessment for systemic risks.

## 17.5 App store UGC requirements

For mobile distribution, the app must include:

1.  A mechanism to report offensive or harmful content.
2.  Timely moderation response processes.
3.  User blocking.
4.  Filtering or default hiding of objectionable material as required.
5.  Age rating and age-restriction mechanisms where applicable.
6.  Policies against bullying, threats, and abuse.


## 17.6 Crypto-enabled abuse and financial integrity

Knomosis-enabled rooms introduce new abuse modes. Trust-and-safety policy must explicitly cover:

1.  Wallet-drainer links and malicious signature prompts.
2.  Impersonation of stewards, rooms, journalists, grant recipients, and support staff.
3.  Bounty collusion and fake completion evidence.
4.  Vote buying, coercion, and bribery.
5.  Treasury capture by coordinated groups.
6.  Sanctions evasion and suspicious transaction patterns.
7.  Paid harassment, paid brigading, paid report abuse, and paid disinformation tasks.
8.  Misleading investment claims, profit promises, token-price hype, and undisclosed paid promotion.
9.  Fraudulent grants, fake charities, fake public-record requests, and fabricated invoices.
10. Attempts to use DAO votes to reveal private moderation/reporting information.

Moderation actions for crypto-enabled abuse should include link interstitials, proposal challenges, treasury freezes, room governance freezes, wallet risk labels, user sanctions, law-enforcement escalation when appropriate, and public incident notes when a room treasury is materially affected.

# 18. Privacy and data protection

## 18.1 Privacy posture

The product relies on attention signals, which can be sensitive. The platform must therefore make attention measurement privacy-preserving, bounded, transparent, and controllable.

## 18.2 Data minimization

1.  Collect only attention events needed for PWA and safety.
2.  Prefer on-device feature extraction over raw event upload.
3.  Upload aggregated attention features rather than raw scroll traces where possible.
4.  Avoid collecting precise location unless needed for explicit local features and consented.
5.  Do not sell attention data.
6.  Do not use attention data for behavioral advertising.
7.  Retain raw event logs for the shortest operational period feasible.
8.  Provide account export and deletion.

## 18.3 Attention signal privacy design

| Data                     | Default handling                                                           |
|--------------------------|----------------------------------------------------------------------------|
| Raw scroll/touch events  | Process on device; discard after feature extraction.                       |
| Active dwell estimate    | Upload aggregated per item/session with caps.                              |
| Source opens             | Upload event with item/source ID; no full browsing history outside app.    |
| Context opens            | Upload aggregate; used for ranking and UI improvement.                     |
| Draft text               | Stored locally and synced encrypted if user enables sync.                  |
| Private saves            | Private; low or no ranking effect unless user opts in to aggregate signal. |
| Sensitive topic interest | Protected; shorter retention and stricter use limitations.                 |

## 18.4 User controls

Users can:

1.  View the Signal Ledger.
2.  Disable personalized recommendations.
3.  Reset topic history.
4.  Delete attention history.
5.  Export account data.
6.  Control local personalization vs server personalization.
7.  Set notification quiet hours.
8.  Disable cross-device sync.
9.  Request moderation data related to their account where legally feasible.

## 18.5 Children and minors

The default product should not be directed to children under 13. If the product knowingly supports younger users in any jurisdiction, it must implement compliant parental consent, data minimization, retention limits, advertising restrictions, and age-appropriate design. For teens, the app should default to stricter privacy, reduced personalization, limited direct contact, safer recommendations, and stronger content filters.


## 18.6 On-chain privacy and data minimization

Knomosis integration creates a permanent public-record risk. The privacy design must assume that on-chain data can be copied, indexed, clustered, and linked to off-chain identities.

Rules:

1.  Do not place personal data on-chain unless legal review approves a specific field and retention cannot be satisfied off-chain.
2.  Do not place attention records, reading history, private moderation data, reporter identities, child/minor data, sensitive inferences, device IDs, IP addresses, private messages, or account-security events on-chain.
3.  Use off-chain records with on-chain hash commitments where auditability is needed.
4.  Show users before signing when an action is public, durable, and linkable.
5.  Keep civic profile identity separate from wallet identity by default.
6.  Allow users to hide wallet labels from their public profile even if on-chain activity remains externally observable.
7.  Provide privacy-preserving treasury views: aggregate public ledger data without exposing unnecessary user profiles.
8.  Apply small-cohort suppression to analytics that combine wallet and civic activity.
9.  Treat wallet addresses as personal data where applicable.
10. Document limits of deletion: off-chain records may be deleted or anonymized, but public chain records cannot be erased by Licio.

# 19. Mobile client architecture

## 19.1 Native-first recommendation

Build native iOS and Android applications for the core experience.

Rationale:

1.  Better accessibility integration.
2.  Better offline storage and background sync control.
3.  Safer handling of local attention features.
4.  Better platform-native notifications and privacy permissions.
5.  Better performance for long threads and context maps.
6.  Better compliance with platform review expectations.

A cross-platform UI layer can be considered only if it meets performance, accessibility, privacy, and platform-convention requirements.

## 19.2 Client components

| Component             | Responsibility                                                 |
|-----------------------|----------------------------------------------------------------|
| Feed engine           | Local caching, pagination, deduplication, state restoration.   |
| Reader                | In-app source reader, readability mode, citation capture.      |
| Thread viewer         | Branch navigation, lazy loading, semantic anchors.             |
| Composer              | Structured contribution entry, drafts, citations, attachments. |
| Signal processor      | On-device attention feature extraction and caps.               |
| Privacy manager       | Permission state, data deletion requests, local encryption.    |
| Notification manager  | Digest grouping, quiet hours, explanation of alerts.           |
| Offline store         | Saved stories, drafts, thread snapshots.                       |
| Accessibility adapter | Dynamic type, screen-reader labels, focus order, haptics.      |

## 19.3 Offline behavior

Offline-supported:

1.  Read saved stories and source snapshots where permitted.
2.  Read cached thread summaries.
3.  Compose drafts.
4.  Add citations from saved items.
5.  Queue submissions and comments.
6.  View private signal ledger snapshot.

Offline-not-supported:

1.  Final posting without sync.
2.  Moderation actions requiring current state.
3.  Real-time safety or crisis flows.
4.  External source verification.

## 19.4 Mobile performance requirements

| Requirement                   | Target                                                                        |
|-------------------------------|-------------------------------------------------------------------------------|
| Cold start to usable shell    | \<= 2.0 seconds on target midrange devices.                                   |
| Feed first meaningful content | \<= 1.5 seconds after shell.                                                  |
| Thread branch open            | \<= 500 ms for cached branch.                                                 |
| Composer open                 | \<= 300 ms.                                                                   |
| Offline draft save            | \<= 100 ms local acknowledgement.                                             |
| Feed scroll dropped frames    | \< 1% on target devices.                                                      |
| Battery impact                | No continuous background processing except permitted sync/notification tasks. |

## 19.5 Mobile accessibility requirements

1.  Dynamic type and font scaling.
2.  Screen reader labels and logical focus order.
3.  High-contrast mode.
4.  Reduced motion mode.
5.  Captions and transcripts for video/audio.
6.  Keyboard and switch-control navigation where supported.
7.  Tap targets designed for motor accessibility.
8.  No information conveyed by color alone.
9.  Error messages tied to fields.
10. Draft recovery after interruption.


## 19.6 Mobile crypto/governance client modules

The native apps add a small number of high-assurance modules:

1.  **Wallet connection sheet:** supports approved wallet connectors, passkey-compatible account flows where available, and QR/deep-link handling.
2.  **Transaction preview renderer:** renders a server-provided, signed preview payload and independently verifies chain, contract, amount, recipient, nonce, and expiration before sending to a wallet.
3.  **Governance tab:** displays charter, treasury, proposals, grants, bounties, disclosures, and audit log.
4.  **Proposal composer:** helps stewards create valid proposals using templates and preflight validation.
5.  **Financial risk interstitial:** educates users about irreversible transactions, public-chain visibility, scams, and unsupported jurisdictions.
6.  **Disabled-state renderer:** clearly explains when a feature is unavailable due to region, age, app-store distribution, room mode, compliance status, or incident freeze.

Mobile implementation requirements:

1.  Never embed private keys.
2.  Never request seed phrases.
3.  Use platform secure storage only for non-secret wallet-link metadata and local preferences.
4.  Require biometric/passcode re-authentication before high-value signing flows if supported.
5.  Avoid dark patterns: no countdown pressure, no fake scarcity, no hidden fees, no confusing approvals.
6.  Provide large, accessible buttons and screen-reader labels for all financial actions.
7.  Show exact amount, asset, and recipient in the confirmation button or immediately above it.
8.  Make cancellation easy until the wallet hands off the signed action.
9.  Cache no sensitive compliance outcome beyond what is required for UX and audit.
10. Ensure all wallet/governance flows work with dynamic type, reduced motion, voiceover/talkback, and poor connectivity.

# 20. Backend architecture

## 20.1 High-level architecture

Services:

1.  API gateway.
2.  Mobile Backend-for-Frontend (BFF).
3.  Identity and account service.
4.  Content ingestion service.
5.  Source and claim service.
6.  Conversation service.
7.  Contribution service.
8.  Ranking service.
9.  Invariant computation platform.
10. Moderation and safety service.
11. Integrity service.
12. Search and discovery service.
13. Notification service.
14. Analytics and experimentation service.
15. Transparency and audit service.
16. Admin/steward console.

## 20.2 Storage

| Store                | Use                                                        |
|----------------------|------------------------------------------------------------|
| Relational database  | Accounts, permissions, content metadata, moderation cases. |
| Graph store          | Threads, claims, evidence links, community relations.      |
| Vector store         | Embeddings for content, claims, sources, lenses.           |
| Object storage       | Attachments, snapshots, logs, exports.                     |
| Event stream         | Attention aggregates, contributions, moderation events.    |
| Feature store        | Ranking and invariant features.                            |
| OLAP warehouse       | Audits, transparency reports, experiments.                 |
| Secure secrets store | API keys, certificates, signing keys.                      |

## 20.3 Event-driven processing

Event stream topics:

1.  `content.submitted`
2.  `content.normalized`
3.  `source.opened.aggregate`
4.  `attention.aggregate`
5.  `contribution.created`
6.  `evidence.added`
7.  `claim.updated`
8.  `thread.state.changed`
9.  `moderation.case.created`
10. `integrity.signal.detected`
11. `invariant.run.completed`
12. `ranking.decision.logged`
13. `notification.sent`
14. `privacy.request.created`

## 20.4 Invariant computation platform

Each invariant service must support:

1.  Batch computation for audits.
2.  Near-real-time approximation for ranking.
3.  Feature versioning.
4.  Model/invariant cards.
5.  Reproducible runs.
6.  Access controls.
7.  Human-readable explanations.
8.  Regression tests on synthetic and labeled datasets.

## 20.5 Service boundaries

| Service      | Owns                                          | Does not own                           |
|--------------|-----------------------------------------------|----------------------------------------|
| Ranking      | Candidate scoring, constraints, explanations. | Policy enforcement decisions.          |
| Integrity    | Coordination, spam, manipulation signals.     | Final moderation for ambiguous speech. |
| Moderation   | Policy actions, reports, appeals.             | Ranking optimization.                  |
| Invariants   | Mathematical feature computation.             | Product policy thresholds.             |
| Privacy      | Consent, deletion, retention, data export.    | Feed relevance.                        |
| Conversation | Thread structure, contributions, branches.    | User identity verification.            |


## 20.6 Knomosis integration architecture

The Knomosis architecture extends the backend with a bounded financial/governance domain. The domain is isolated from ranking and social analytics to reduce abuse, compliance, and privacy risk.

Logical service boundaries:

1.  **Knomosis Gateway:** receives preflight requests, validates schemas, computes typed-data payloads, submits signed actions, and tracks finality.
2.  **Wallet Identity Service:** manages wallet-link challenges, wallet unlinking, wallet risk status, and contract-wallet metadata.
3.  **Governance Service:** owns proposals, charters, law-pack references, voting/delegation, challenge windows, and execution state.
4.  **Treasury Service:** owns room treasuries, payment intents, bounty escrows, grant payouts, limits, and reconciliation.
5.  **Law-Pack Registry:** stores approved law packs, version history, hash commitments, test fixtures, and audit status.
6.  **Compliance Gateway:** owns jurisdiction checks, feature flags, partner KYC/AML status, sanctions/fraud preflight, and release approvals.
7.  **Knomosis Indexer:** consumes L1/L2/runtime events, tracks reorgs, normalizes events, and emits application events.
8.  **Ledger Reconciliation:** reconciles expected payment intents and governance executions with indexed events.
9.  **Financial Case Management:** manages scams, disputes, mistaken transfers, suspicious activity, and legal requests.

Isolation rules:

1.  Ranking services may read only sanitized, aggregate governance context, never raw wallet wealth or payment amounts for ranking.
2.  Analytics systems may not join wallet addresses to attention histories without a formally approved privacy case.
3.  Trust-and-safety tools can see financial abuse signals under role-based access and audit logging.
4.  Compliance partner responses must not be reused for ad targeting, ranking, or personalization.
5.  Production contract addresses and law-pack hashes must be configuration-managed and deploy-gated.

# 21. Data model

## 21.1 Core entities

### User

    User {
      user_id
      handle
      display_name
      account_state
      created_at
      locale
      age_band_if_known
      privacy_settings
      personalization_settings
      reputation_summary_private
    }

### Story

    Story {
      story_id
      canonical_url
      title
      submitted_by
      source_id
      language
      topic_ids
      location_scope
      sensitivity_labels
      lifecycle_state
      created_at
      updated_at
    }

### Thread

    Thread {
      thread_id
      story_id
      room_id
      branch_index
      current_summary_id
      conversation_state
      safety_state
      created_at
    }

### Contribution

    Contribution {
      contribution_id
      thread_id
      user_id
      type
      body
      citations
      target_claim_id
      parent_contribution_id
      edit_history_ref
      moderation_state
      created_at
    }

### EvidenceCard

    EvidenceCard {
      evidence_id
      claim_id
      source_id
      submitted_by
      evidence_type
      citation_url_or_ref
      relevance_note
      verification_state
      independence_group_id
    }

### AttentionAggregate

    AttentionAggregate {
      aggregate_id
      user_id_or_privacy_bucket
      story_id
      session_bucket
      active_dwell_bucket
      source_opened
      context_opened
      branch_depth_bucket
      return_visit_count_bucket
      privacy_level
      created_at
    }

### InvariantOutput

    InvariantOutput {
      invariant_output_id
      invariant_type
      target_type
      target_id
      time_window
      version
      score_vector
      explanation_summary
      confidence
      created_at
    }

## 21.2 Relationship graph

Key edges:

1.  User contributed to thread.
2.  Story cites source.
3.  Claim supported by evidence.
4.  Claim challenged by evidence.
5.  Contribution replies to contribution.
6.  Contribution clarifies claim.
7.  Story duplicates story.
8.  Source syndicated from source.
9.  Room has lens.
10. Lens interprets story.
11. Moderator action targets contribution.

## 21.3 Data retention defaults

| Data class                    | Suggested retention                                         |
|-------------------------------|-------------------------------------------------------------|
| Account data                  | While account active plus legal retention period.           |
| Public contributions          | Until deleted, removed, or archived by policy.              |
| Raw client attention events   | Prefer not uploaded; if uploaded for debugging, \<= 7 days. |
| Aggregated attention features | 90-180 days unless needed for audit, then anonymize.        |
| Ranking decision logs         | 180-365 days with access controls.                          |
| Moderation logs               | Longer retention based on policy/legal need.                |
| Security logs                 | Based on risk and legal requirements.                       |
| Deleted-account personal data | Delete or anonymize according to policy and law.            |


## 21.4 Knomosis and treasury entities

The following entities extend the core model. They should live in a separate bounded context from feed ranking and ordinary social analytics.

### WalletAccount

    WalletAccount {
      wallet_account_id
      user_id
      address_hash
      address_truncated
      chain_id
      wallet_type
      linked_at
      unlink_state
      risk_state
      last_used_at
    }

### KnomosisDeployment

    KnomosisDeployment {
      deployment_id
      environment
      chain_id
      l1_bridge_address
      runtime_endpoint_ref
      contract_manifest_hash
      pinned_knomosis_commit
      status
      created_at
    }

### RoomGovernanceProfile

    RoomGovernanceProfile {
      room_id
      governance_mode
      law_pack_id
      charter_version_id
      treasury_id
      quorum_policy_ref
      threshold_policy_ref
      timelock_policy_ref
      jurisdiction_policy_id
      freeze_state
    }

### GovernanceProposal

    GovernanceProposal {
      proposal_id
      room_id
      proposer_user_id
      proposal_type
      title
      plain_language_summary
      structured_payload_ref
      requested_amount
      asset
      recipient_ref
      conflict_disclosures_ref
      preflight_state
      voting_state
      challenge_state
      execution_state
      created_at
      executed_at
    }

### RoomTreasury

    RoomTreasury {
      treasury_id
      room_id
      deployment_id
      treasury_address
      accepted_assets
      balance_snapshot_ref
      deposit_limits_ref
      spend_limits_ref
      freeze_state
      reconciliation_state
    }

### PaymentIntent

    PaymentIntent {
      payment_intent_id
      user_id
      room_id
      target_type
      target_id
      asset
      amount
      jurisdiction_state
      compliance_state
      quote_ref
      expiration
      execution_state
      receipt_ref
    }

### KnomosisActionRecord

    KnomosisActionRecord {
      action_record_id
      deployment_id
      action_type
      room_id
      actor_ref
      payload_hash
      typed_data_hash
      signed_action_ref
      submission_state
      indexed_event_ref
      reconciliation_state
    }

### FinancialComplianceCase

    FinancialComplianceCase {
      case_id
      user_id_or_room_id
      trigger_type
      risk_level
      partner_case_ref
      review_state
      resolution
      retention_policy
      created_at
    }

# 22. API specification overview

## 22.1 API style

Use a mobile BFF with typed contracts. Internally, services may use gRPC or event streams. Externally, mobile apps call stable REST or GraphQL endpoints through the BFF.

## 22.2 Example endpoints

| Endpoint                             | Method | Purpose                                 |
|--------------------------------------|--------|-----------------------------------------|
| `/v1/feed/front-page`                | GET    | Retrieve ranked feed with explanations. |
| `/v1/rooms`                          | GET    | List joined and recommended rooms.      |
| `/v1/stories`                        | POST   | Submit link or original story.          |
| `/v1/stories/{id}`                   | GET    | Fetch story detail and context.         |
| `/v1/threads/{id}`                   | GET    | Fetch thread overview and branch index. |
| `/v1/threads/{id}/branches/{branch}` | GET    | Fetch branch content.                   |
| `/v1/contributions`                  | POST   | Create structured contribution.         |
| `/v1/evidence`                       | POST   | Add evidence card.                      |
| `/v1/reports`                        | POST   | Report content or account.              |
| `/v1/signal-ledger`                  | GET    | Fetch private signal explanation.       |
| `/v1/privacy/export`                 | POST   | Request export.                         |
| `/v1/privacy/delete-attention`       | POST   | Delete attention history.               |
| `/v1/feed/preferences`               | PATCH  | Update personalization and feed mode.   |

## 22.3 Feed response shape

    FeedItem {
      story_id
      title
      source_summary
      rating_label
      distribution_reason
      context_chips[]
      reader_state
      thread_preview
      safety_state
      user_controls
    }

## 22.4 Contribution creation shape

    CreateContributionRequest {
      thread_id
      type
      body
      parent_id_optional
      target_claim_id_optional
      citations[]
      attachments[]
      local_draft_id
      client_integrity_token
    }

## 22.5 Ranking decision log shape

    RankingDecisionLog {
      request_id
      user_privacy_bucket
      candidate_ids
      selected_ids
      score_components
      invariant_versions
      constraints_applied
      explanation_ids
      experiment_ids
      timestamp
    }


## 22.6 Knomosis, wallet, treasury, and governance APIs

Financial and governance APIs must be versioned, idempotent, audit-logged, and separated from ordinary social APIs.

Core endpoints:

    POST /wallet/nonce
    POST /wallet/link
    POST /wallet/unlink/request
    GET  /wallets

    GET  /rooms/{room_id}/governance
    POST /rooms/{room_id}/governance/proposals
    GET  /rooms/{room_id}/governance/proposals/{proposal_id}
    POST /rooms/{room_id}/governance/proposals/{proposal_id}/sign
    POST /rooms/{room_id}/governance/proposals/{proposal_id}/challenge
    POST /rooms/{room_id}/governance/proposals/{proposal_id}/execute

    GET  /rooms/{room_id}/treasury
    POST /rooms/{room_id}/treasury/payment-intents
    GET  /rooms/{room_id}/treasury/payment-intents/{payment_intent_id}
    GET  /rooms/{room_id}/treasury/audit-log

    POST /knomosis/actions/preflight
    POST /knomosis/actions/submit
    GET  /knomosis/actions/{action_record_id}

    GET  /jurisdiction/features
    POST /compliance/financial/preflight

API best practices:

1.  Require idempotency keys for payment and execution endpoints.
2.  Require explicit nonces and expirations for signature payloads.
3.  Return disabled-state reasons and remediation paths.
4.  Distinguish pending, submitted, indexed, challenged, finalized, reverted, frozen, and failed states.
5.  Produce structured audit events for every financial action.
6.  Keep user-facing summaries and machine payloads paired by hash.
7.  Log preflight decisions without leaking unnecessary personal data into analytics.
8.  Run contract-address allowlist checks on every production action.

# 23. AI and machine learning specification

## 23.1 AI use cases

AI systems may support:

1.  Topic classification.
2.  Duplicate detection.
3.  Claim extraction.
4.  Evidence linking.
5.  Toxicity and safety triage.
6.  Thread summarization drafts.
7.  Translation.
8.  Ranking candidate retrieval.
9.  Context obstruction estimation.
10. Coordination features.
11. Accessibility alt-text suggestions.

AI systems must not be the sole authority for high-impact moderation decisions unless policy defines a narrow emergency class.

## 23.2 Responsible AI requirements

1.  Maintain model cards for ranking, safety, summarization, and invariant models.
2.  Maintain data lineage for training and evaluation datasets.
3.  Conduct bias and subgroup performance audits.
4.  Use human review for appeals and ambiguous cases.
5.  Label AI-generated summaries.
6.  Preserve source citations for generated summaries.
7.  Allow users to report bad summaries or translations.
8.  Avoid making unsupported factual claims in generated text.
9.  Log model version and prompt/configuration for audit-sensitive outputs.
10. Apply red-team testing before launch.

## 23.3 Summarization constraints

Summaries must:

1.  Cite source branches and evidence cards.
2.  Distinguish facts, claims, and interpretations.
3.  Preserve uncertainty.
4.  Identify unresolved questions.
5.  Avoid synthesizing harassment or slurs unnecessarily.
6.  Avoid presenting the majority view as truth merely because it is common.
7.  Support correction workflows.

## 23.4 Ranking ML constraints

The ranking model may learn weights, but it must obey hard constraints from safety, privacy, and invariant guardrails. It cannot override:

1.  Content removals.
2.  Severe coordination freezes.
3.  Minor safety limits.
4.  User personalization-off settings.
5.  Privacy deletion or retention states.
6.  Accessibility-critical content rendering rules.


## 23.5 AI use around Knomosis governance

AI may assist with governance clarity, but it must not replace human responsibility for financial decisions.

Permitted AI uses:

1.  Summarize proposals in plain language.
2.  Identify missing budget fields, missing citations, or unclear recipients.
3.  Compare a proposal against the room charter and law-pack template.
4.  Highlight possible conflicts of interest for steward review.
5.  Translate governance summaries.
6.  Generate accessibility-friendly explanations of treasury actions.
7.  Detect suspicious language patterns associated with scams.

Prohibited AI uses:

1.  Autonomous treasury execution.
2.  Autonomous investment advice.
3.  Personalized financial advice.
4.  Manipulative voting recommendations.
5.  Predictive profiling of user wealth or political/financial vulnerability.
6.  Rewriting proposals in ways that hide risk or recipient identity.
7.  Using wallet wealth to personalize content feeds.

Any AI-generated proposal summary must show citations to proposal fields, identify material uncertainty, and be editable or contestable by stewards.

# 24. Security specification

## 24.1 Security baseline

The mobile and backend security program should align with OWASP MASVS for mobile applications and NIST CSF 2.0 for organizational cybersecurity governance.

## 24.2 Mobile security requirements

1.  Secure local storage for tokens and drafts.
2.  Certificate pinning or equivalent risk-based network protection where appropriate.
3.  TLS for all network traffic.
4.  No sensitive secrets embedded in client binaries.
5.  Runtime tamper detection for high-risk integrity operations.
6.  Jailbreak/root risk handling without blocking accessibility tools unnecessarily.
7.  App attestation for abuse-sensitive endpoints.
8.  Secure clipboard handling for sensitive data.
9.  Protection against deep-link injection.
10. Safe WebView configuration for source reader.
11. Minimal permissions and clear permission prompts.
12. Secure push notification content.

## 24.3 Account security

1.  Passkeys as preferred authentication.
2.  Email or phone verification as fallback, depending on jurisdiction and risk.
3.  Multi-factor support for stewards and moderators.
4.  Session management and device list.
5.  Suspicious login alerts.
6.  Rate limits for credential attacks.
7.  Account recovery with abuse-resistant workflows.

## 24.4 Backend security

1.  Service-to-service authentication.
2.  Strong authorization checks.
3.  Encryption at rest for sensitive data.
4.  Secrets rotation.
5.  Audit logging.
6.  Least privilege access.
7.  Data access reviews.
8.  Vulnerability management.
9.  Dependency scanning.
10. Incident response playbooks.
11. Backup and disaster recovery.
12. Abuse-aware rate limiting.

## 24.5 Integrity threats

| Threat                     | Mitigation                                                       |
|----------------------------|------------------------------------------------------------------|
| Bot accounts               | Device/account risk, rate limits, MFCI, behavior analysis.       |
| Coordinated brigading      | MFCI, tropical cascade, report-delay mechanisms.                 |
| Duplicate spam             | MERI, URL canonicalization, source lineage.                      |
| Harassment raids           | Safety queues, target protection, distribution freeze.           |
| Source spoofing            | URL normalization, domain verification, link preview safeguards. |
| Model gaming               | Feature caps, randomized audits, adversarial testing.            |
| Screenshot context removal | Share cards with origin/context metadata.                        |
| Deep-link abuse            | Signed deep links, safe open handling.                           |


## 24.6 Wallet, smart contract, and Knomosis security

Additional security controls for Knomosis-enabled features:

1.  Use structured typed-data signing with domain separation, nonces, expirations, and chain IDs.
2.  Maintain production contract allowlists and block unknown contract interactions.
3.  Run transaction simulation and human-readable previews before signing.
4.  Never request, store, transmit, or log private keys or seed phrases.
5.  Pin Knomosis commit, ABIs, contract addresses, runtime versions, and law-pack hashes by environment.
6.  Validate Knomosis fixtures and cross-stack equivalence gates in CI before deployment.
7.  Use least-privilege keys for indexers, gateway workers, treasury operators, and deployment scripts.
8.  Store any platform signing keys in HSM/KMS with strict separation of duties.
9.  Use multisig and timelocks for room treasury execution above low thresholds.
10. Monitor event ingestion, reorgs, deposits, withdrawals, challenge windows, and suspicious contract calls.
11. Provide emergency feature flags for wallet connection, payment intent creation, action submission, treasury execution, and governance voting.
12. Run external audits before mainnet funds and after material law-pack or contract changes.
13. Include wallet-drainer phishing simulations in security testing.
14. Provide user education and just-in-time warnings for approvals, blind signing, unknown recipients, and irreversible transfers.
15. Maintain an incident-specific communications plan for financial exploits.

# 25. Accessibility and inclusive design

## 25.1 Accessibility baseline

The platform should target WCAG 2.2 AA for applicable mobile web and web companion surfaces, and equivalent native accessibility practices on iOS and Android.

## 25.2 Native accessibility requirements

1.  VoiceOver and TalkBack support.
2.  Meaningful accessibility labels for icons and chips.
3.  Semantic headings in long threads.
4.  Focus order matching visual reading order.
5.  Dynamic type support without clipped UI.
6.  Large touch targets.
7.  Reduced motion mode for thread transitions and Civic Map.
8.  Captions and transcripts.
9.  High-contrast themes.
10. Avoid color-only status labels.
11. Accessible error states in composer.
12. Plain-language summaries.

## 25.3 Cognitive accessibility

1.  Thread overview before deep branches.
2.  Summaries with unresolved questions.
3.  Progressive disclosure for mathematical/ranking explanations.
4.  Avoid jargon in user-facing labels.
5.  Provide reading estimates.
6.  Provide “explain like I am new” lens where appropriate.
7.  Allow saving and returning without losing place.

## 25.4 Internationalization

1.  Full localization pipeline for UI strings.
2.  Right-to-left language support.
3.  Language-specific tokenization and embeddings.
4.  Translation disclosure and access to original text.
5.  Region-sensitive legal and cultural policy handling.
6.  Local moderator/steward capacity before launching language communities.

# 26. Monetization and incentives

## 26.1 Recommended business model

Licio should avoid behavioral advertising that monetizes attention extraction. Recommended revenue sources:

1.  Paid supporter subscriptions.
2.  Organization/team subscriptions for research and moderation tools.
3.  Grants for public-interest information infrastructure.
4.  Contextual sponsorships with strict separation from ranking.
5.  Paid API access for aggregate, privacy-preserving research data.
6.  Optional creator/journalist support pools based on evidence and participation value, not likes.

## 26.2 Advertising constraints

If advertising exists:

1.  No behavioral microtargeting based on attention history.
2.  No political microtargeting.
3.  Clear labels.
4.  Contextual placement only.
5.  No ads in child-directed experiences.
6.  Ads cannot affect PWA ranking.
7.  Advertisers cannot access individual attention ledgers.

## 26.3 Incentive alignment

The product should reward:

1.  Useful evidence.
2.  Accurate correction.
3.  Context repair.
4.  Constructive disagreement.
5.  Synthesis.
6.  Stewardship.
7.  Source diversity.

The product should not reward:

1.  Outrage farming.
2.  Repetitive posting.
3.  Context removal.
4.  Follower accumulation.
5.  Harassment.
6.  Coordinated trend gaming.
7.  Low-information replies.


## 26.4 Cryptocurrency monetization and funding constraints

Knomosis enables payment rails and community treasuries, but monetization must preserve the civic mission.

Permitted revenue or funding paths, subject to law and app-store rules:

1.  Platform fee on optional room treasury services, disclosed before payment.
2.  Payment processing fee pass-through, disclosed before payment.
3.  Paid organizational governance/audit tooling for professional communities.
4.  Grants and philanthropic funding for public-interest infrastructure.
5.  Optional user support payments to creators or rooms where permitted.
6.  Hosted compliance, treasury accounting, and transparency report services for larger rooms.

Prohibited paths:

1.  Token sales marketed as investments.
2.  Paid boosts for posts, rooms, creators, or search placement.
3.  Revenue share tied to engagement farming.
4.  Crypto rewards for posting, commenting, inviting, or time spent.
5.  Hidden spreads or undisclosed exchange fees.
6.  Lending, yield, staking, or rehypothecation of user/room assets without explicit legal approval and user consent.
7.  Selling wallet-derived targeting segments.
8.  Selling access to private governance or financial compliance data.

## 26.5 Room treasury fee policy

Any fee must be simple, capped, and disclosed:

1.  Fee amount and recipient must be visible before payment.
2.  Fees cannot vary based on political viewpoint, story sensitivity, or creator identity.
3.  Fees cannot buy distribution advantages.
4.  Fee waivers may support public-interest rooms, local newsrooms, accessibility groups, and disaster response rooms.
5.  Treasury accounting must separate user/room assets, platform fees, payment processor fees, and gas/network fees.
6.  Refunds, failed transactions, and mistaken transfers must have documented support paths even when on-chain reversibility is impossible.

# 27. Metrics and experimentation

## 27.1 Product health metrics

| Metric                          | Definition                                                |
|---------------------------------|-----------------------------------------------------------|
| Constructive participation rate | Share of sessions producing useful contribution types.    |
| Source-open rate                | Share of story attention that includes source inspection. |
| Evidence addition rate          | Evidence cards per active thread.                         |
| Question resolution rate        | Clarifying questions answered with useful replies.        |
| MERI distribution               | Nonredundant exposure ratio across feeds.                 |
| SCOI reduction                  | Context obstruction decrease after bridge/synthesis.      |
| MFCI incidents                  | Coordination risk events by severity.                     |
| GWEI disparity                  | Cohort experience geometry distance.                      |
| PHI risk                        | Recommendation loop steering risk distribution.           |
| Harassment protection latency   | Time to protective action after target-risk detection.    |
| Appeal overturn rate            | Moderation quality indicator.                             |
| Accessibility defect rate       | Critical accessibility issues per release.                |

## 27.2 Experimentation rules

1.  No experiment may introduce likes, upvotes, public reaction counts, or follower leaderboards.
2.  Ranking experiments must include safety, MERI, MFCI, GWEI, SCOI, and PHI metrics.
3.  Experiments on minors or sensitive topics require stricter review.
4.  Experiments must have rollback switches.
5.  User-facing major changes require notice.
6.  Experiment logs must include invariant versions.
7.  Experiments optimizing attention must also monitor wellbeing and participation quality.

## 27.3 Success metrics by launch phase

### Alpha

1.  Users understand why content is shown.
2.  Structured composer does not block participation.
3.  MERI deduplication improves perceived feed quality.
4.  Source opening and evidence addition are measurable.
5.  Moderation tools handle early abuse cases.

### Beta

1.  PWA ranking outperforms chronological baseline on user-rated usefulness.
2.  Coordinated activity is detected without high false positives on active rooms.
3.  Context cards reduce misunderstanding in cross-community threads.
4.  Mobile performance targets are met.
5.  Accessibility audits pass core flows.

### General availability

1.  Public transparency report can be generated.
2.  Invariant dashboards are stable.
3.  Appeals process is operational.
4.  Ranking experiments have release gates.
5.  Security review and app-store review requirements are satisfied.


## 27.4 Knomosis governance and payment metrics

Crypto-governance metrics should prioritize safety, comprehension, and public value:

| Metric | Definition | Anti-goal guarded against |
|---|---|---|
| Public-value grant completion rate | Share of funded grants that produce accepted evidence/context outputs. | Treasury waste. |
| Transaction comprehension score | User-test success on transaction preview meaning. | Blind signing. |
| Treasury transparency completeness | Share of treasury actions with clear proposal, recipient, amount, and outcome. | Dark-money governance. |
| Governance diversity index | Participation breadth across eligible civic accounts, not wallet wealth. | Capture. |
| Proposal dispute rate | Share of proposals challenged for conflict, fraud, or policy issues. | Unaccountable execution. |
| Financial incident rate | Confirmed scams, fraud, mistaken transfers, and compromised wallets per active wallet. | Unsafe payment expansion. |
| Pay-to-rank leakage | Measured correlation between payments and ranking after controls. | Wealth-driven visibility. |
| Disabled-state clarity | User comprehension of region/app-store/age restrictions. | Confusing compliance UX. |

Do not optimize for total value locked, token trading, wallet connects, speculative price, or treasury size.


## 27.5 Knomosis and governance health metrics

Knomosis and Forum Commons metrics must measure safety, clarity, accountability, and ranking neutrality rather than financial hype.

| Metric | Purpose | Guardrail |
|--------|---------|-----------|
| Wallet-link completion clarity | Measures whether users understand wallet linking. | Track support tickets and abandonment; do not optimize through dark patterns. |
| Payment error rate | Detects failed, reverted, or confusing transactions. | Pause affected flow if errors or support burden exceed threshold. |
| Treasury reconciliation gap | Detects divergence between app ledger, Knomosis receipts, and L1 state. | Must be zero or manually explained before expansion. |
| Governance participation diversity | Detects capture by a small clique, donor group, or coordinated accounts. | Trigger review for high concentration or sudden membership surge. |
| Proposal risk-review latency | Measures whether review becomes a bottleneck. | Do not skip legal, security, or safety review to improve speed. |
| Ranking-neutrality audit pass rate | Confirms payment, wallet, and treasury data do not affect organic rank. | Must pass before and after every crypto release. |
| App-store compliance incident count | Tracks platform-review and payment-policy issues. | Serious incident pauses affected mobile flows. |
| Treasury abuse reports | Detects fraud, bribery, coercion, suspicious bounties, or unsafe payouts. | Escalate to trust, safety, legal, and security review. |
| User comprehension score | Measures whether users know that payments are not endorsements or rank boosts. | Failure blocks expansion and requires copy/UX redesign. |

Metrics explicitly prohibited as success goals:

1.  total value locked as a vanity metric;
2.  token price or speculative activity;
3.  payment volume per user as an engagement goal;
4.  governance vote frequency as an end in itself;
5.  bounty count without deliverable quality;
6.  wallet-link rate as a mandatory onboarding metric.

# 28. Operational workflows

## 28.1 New story workflow

1.  User submits link via share sheet or app Submit tab.
2.  Client captures URL, title, and optional reason.
3.  Backend normalizes URL and detects duplicates.
4.  Story shell is created or existing story is reopened.
5.  Initial thread summary and context cards are generated.
6.  Feed candidates receive baseline rank.
7.  As users read and contribute, PWA grows or dampens.
8.  Invariant services update state.
9.  Story moves through lifecycle labels.

## 28.2 New contribution workflow

1.  User opens composer.
2.  User selects contribution type.
3.  App prompts for relevant fields.
4.  Draft saved locally.
5.  Client checks obvious errors and missing citations.
6.  Backend runs safety and spam checks.
7.  Contribution appears in appropriate branch.
8.  Invariant features update.
9.  User receives private feedback in Signal Ledger if contribution meaningfully improved thread state.

## 28.3 Coordination incident workflow

1.  MFCI or tropical cascade detects unusual pattern.
2.  Integrity service assigns severity.
3.  Ranking service slows or freezes acceleration if threshold met.
4.  Integrity analyst receives case summary.
5.  Moderator may merge duplicates, label review state, restrict accounts, or clear false positive.
6.  Public thread label updated if distribution is affected.
7.  Case outcome logged for transparency report.

## 28.4 Context obstruction workflow

1.  SCOI detects split or obstructed interpretations.
2.  Feed cards show “Needs Context.”
3.  Thread requests bridge/synthesis contributions.
4.  Users in relevant lenses are invited to add context.
5.  Steward may create or approve context patch.
6.  SCOI recomputed.
7.  Distribution expands when context is sufficiently repaired.


## 28.5 Financial operations workflow

Financial operations must be treated as a specialized operating function.

Workflow units:

1.  **Payment support:** failed payment, stuck transaction, wrong chain, wrong recipient, duplicated intent, user confusion.
2.  **Wallet safety:** compromised wallet report, malicious signature report, wallet-drainer link, impersonated support.
3.  **Treasury support:** disputed grant, delayed payout, incorrect recipient, stuck timelock, room freeze.
4.  **Compliance review:** region eligibility, sanctions/fraud alert, KYC partner escalation, law-enforcement request.
5.  **Accounting:** fee reconciliation, treasury export, grant reporting, tax documentation.
6.  **Incident response:** contract bug, bridge halt, indexer corruption, malicious proposal, coordinated treasury drain.

Each workflow needs ownership, SLAs, escalation paths, user templates, audit logs, and postmortem requirements before production funds launch.


## 28.6 Wallet and payment workflow

1.  User opens Wallet Center or a treasury contribution screen.
2.  App explains that wallet use is optional and does not affect ranking.
3.  User links a wallet through a signed-message flow or continues without linking where possible.
4.  Backend verifies domain, nonce, chain ID, signature, account session, risk state, and jurisdiction availability.
5.  User requests a payment quote.
6.  App displays asset, amount, recipient, network, estimated fees, finality, refund limitations, public-ledger disclosure, and non-ranking disclosure.
7.  User signs in the external wallet or approved non-custodial account flow.
8.  Chain/Knomosis ingestion records pending status.
9.  UI shows pending, confirmed, finalized, reverted, reorged, disputed, or abandoned status.
10. Treasury reconciliation updates the Forum Commons dashboard.
11. User receives a public receipt and a private exportable receipt.
12. Support flow can handle stuck, failed, mistaken, or suspicious transactions without asking for private keys.

## 28.7 Forum Commons proposal workflow

1.  Eligible participant drafts a proposal using a mobile template.
2.  Completeness check validates title, summary, proposal type, scope, budget, conflicts, risks, requested action, and expected deliverable.
3.  Proposal enters a structured deliberation thread.
4.  Users add evidence, objections, amendments, alternatives, context cards, and minority reports.
5.  Invariant services flag coordination, redundancy, unresolved context, and high conversation tension.
6.  Platform risk review checks policy, legal, treasury, privacy, app-store, sanctions, tax, and security constraints.
7.  Ballot and execution payload are finalized; material changes restart review.
8.  Eligible participants vote, abstain, or request more context.
9.  Quorum and threshold checks run with anti-capture review.
10. Timelock starts if the proposal passes.
11. Execution worker submits allowlisted execution after final checks.
12. Chain/Knomosis receipt finalizes and the Forum Commons page publishes result, budget change, dissent notes, and remediation options.

## 28.8 Treasury incident workflow

1.  Monitoring detects suspicious treasury movement, indexer divergence, high-risk recipient, governance capture signal, or smart-contract alert.
2.  A treasury incident case opens with severity, affected forum, affected assets, current caps, pending transactions, and user impact.
3.  New deposits, proposal creation, or execution can be paused independently, scoped to affected forum/asset/action.
4.  Withdrawals or remediation paths remain available where technically and legally possible.
5.  Security, legal, trust-and-safety, and finance/accounting review the case.
6.  Reconciliation worker snapshots product DB, Knomosis receipts, and L1 observations.
7.  Users see a safe status message that avoids leaking investigative details.
8.  Incident resolves through cleared status, cap reduction, proposal cancellation, migration, remediation, or permanent feature disablement.
9.  Postmortem updates runbooks, caps, monitoring, user copy, and audit evidence.

# 29. Optimized end-to-end implementation plan

This section replaces the coarse release plan with a decomposed plan that turns the specification into smaller, efficient units of work. The goal is not to build the mathematically richest version first. The goal is to ship a safe, mobile-first social news product whose core mechanics prove the no-like/no-upvote model, then progressively strengthen the invariant services.

## 29.1 Planning model

The implementation should use four planning layers:

1.  **Product slice:** A user-visible workflow such as submitting a story, reading a thread, adding evidence, or reporting abuse.
2.  **Signal slice:** The minimal event, aggregation, and privacy logic needed to measure the workflow correctly.
3.  **Invariant slice:** The smallest useful version of MERI, MFCI, GWEI, SCOI, or PHI connected to that workflow.
4.  **Operational slice:** The review, audit, support, and rollback path required if the feature behaves incorrectly.

Every complex task should produce a thin vertical slice through all four layers before the team adds sophistication. For example, MERI v0 should not be an offline notebook only. It should take real story submissions, cluster obvious duplicates, lower redundant distribution, and explain the result in a mobile feed card.

## 29.2 Critical path

The critical path is:

1.  **No-applause product shell:** mobile app, accounts, story ingestion, threads, composer, reporting, blocking, and basic moderation.
2.  **Trustworthy event pipeline:** privacy-preserving attention and participation events, event validation, aggregation windows, abuse-resistant identity controls, and decision logs.
3.  **PWA v1:** bounded active-attention score plus constructive-participation score plus safety gates.
4.  **MERI v1:** duplicate and near-duplicate dampening for feeds and topic rooms.
5.  **MFCI v0/v1:** shadow-mode coordination detection, then limited ranking dampening with analyst review.
6.  **Context and explanation layer:** context cards, evidence drawer, signal ledger, and moderation transparency.
7.  **SCOI v0/v1:** detect high-friction cross-community interpretation splits and route context repair.
8.  **GWEI v0/v1:** cohort experience audits for launch readiness and experiment gates.
9.  **PHI v0/v1:** path-risk detection and recommender loop dampening.
10. **Public beta gates:** privacy, security, accessibility, moderation, transparency reporting, and app-store review readiness.

The optimized dependency rule is: **PWA and MERI must exist before public beta; MFCI must at least run in shadow mode before public beta; SCOI, GWEI, and PHI can start as dashboards and soft constraints before becoming stronger ranking constraints.**

## 29.3 Team workstreams

### Workstream A: Product strategy, policy, and governance

**Purpose:** Keep the product coherent, safe, and legally reviewable.

**Units of work:**

1.  Write the no-applause product charter.
2.  Define user-facing terms: "attention," "participation," "rising," "deepening," "needs context," and "under review."
3.  Create policy taxonomy for illegal content, harassment, hate, sexual content, violence, self-harm, health misinformation, election/civic integrity, spam, platform manipulation, impersonation, and privacy violations.
4.  Define moderation action ladder: no action, reduce acceleration, add context, merge duplicate, hide pending review, remove, restrict feature, suspend, ban.
5.  Define appeal rights and response categories.
6.  Create jurisdiction and minors risk matrix.
7.  Maintain feature flag register and launch risk register.

**Definition of done:** Product, policy, legal, security, privacy, and moderation leads can explain what the product does, what it refuses to do, what user signals it collects, and what actions are appealable.

### Workstream B: Mobile UX and design system

**Purpose:** Make deep social news participation work on a phone without addictive feed mechanics.

**Units of work:**

1.  Build a mobile information architecture with five bottom tabs at most: Front Page, Rooms, Submit, Ledger, Profile/Settings.
2.  Design feed cards with finite sections, source indicators, context labels, and no applause affordances.
3.  Design the in-app source reader with reading position preservation, citation capture, accessibility controls, and escape back to thread.
4.  Design thread navigation by branches: evidence, questions, corrections, synthesis, counterpoint, local witness, and moderator notes.
5.  Design the structured composer with contribution type, citation prompt, preview, local autosave, and safety nudges.
6.  Design context cards and evidence drawer as bottom sheets that never cover critical controls permanently.
7.  Design the private Signal Ledger explaining which of the user's actions contributed to visibility or thread quality.
8.  Design reporting, blocking, muting, appeals, and support flows.
9.  Build accessibility variants: dynamic type, high contrast, reduced motion, screen reader labels, switch control paths, and large touch targets.
10. Run moderated tests with casual readers, expert contributors, low-vision users, screen-reader users, and users with motor constraints.

**Definition of done:** A first-time mobile user can submit a link, read source context, add a structured contribution, report a problem, and understand why a story is visible without seeing a like/upvote concept.

### Workstream C: Native mobile clients

**Architecture choice:** Build native iOS and Android clients for core UX quality. Use SwiftUI/UIKit where needed on iOS and Jetpack Compose on Android. Share API contracts, design tokens, event schemas, and business rules, but avoid a fully shared cross-platform UI for the first release because accessibility, reader performance, offline drafts, and OS-level privacy controls are central to the product.

**Units of work:**

1.  App shell, navigation, auth session, feature flag bootstrap.
2.  Feed rendering with pagination, finite sections, source cards, and context labels.
3.  Story detail and thread branch navigation.
4.  In-app source reader with text extraction where permitted, external browser fallback, and citation capture.
5.  Structured composer with local drafts, markdown-lite support, citation attachment, edit history, and preview.
6.  Signal Ledger and privacy settings.
7.  Report/block/mute/appeal flows.
8.  Offline cache for saved stories, allowed source snapshots, context cards, and drafts.
9.  Local active-attention aggregation that emits bounded summaries, not raw scroll surveillance.
10. Push notification preferences, quiet hours, and non-addictive notification rules.
11. Accessibility instrumentation and automated UI tests.
12. Crash reporting, performance traces, privacy-safe analytics, and remote kill switches.

**Definition of done:** The app meets launch performance budgets on low-end supported devices, supports offline drafts, has no hidden applause affordance, and passes core accessibility smoke tests on both platforms.

### Workstream D: Event pipeline and privacy-preserving measurement

**Purpose:** Make PWA possible without turning the app into a surveillance product.

**Units of work:**

1.  Define canonical event schema: view_start, view_active_summary, source_open, source_return, contribution_create, contribution_edit, evidence_add, correction_accept, report_submit, block_user, mute_topic, feed_impression, ranking_explanation_open, and session_end.
2.  Define event purpose, retention tier, user visibility, and privacy classification for every event.
3.  Implement client-side idle detection and local aggregation. Do not stream raw scroll coordinates or every touch event to the server.
4.  Add event signing or integrity hints to reduce forged attention events.
5.  Build ingestion validation: schema validation, replay protection, device/session consistency, rate limits, bot heuristics, and abuse queues.
6.  Store raw events only where necessary and for short periods. Store aggregates separately from content and account identifiers where feasible.
7.  Build aggregation jobs for item-window, user-window, room-window, cohort-window, and moderation-window metrics.
8.  Build decision logs linking ranking outcomes to feature versions and aggregate signals.
9.  Build DSAR/export support that explains attention-derived data without exposing other users or anti-abuse secrets.
10. Run privacy review and threat modeling before public beta.

**Definition of done:** PWA can be recomputed from logged aggregates, users can view and control relevant settings, and raw high-sensitivity attention traces are minimized by design.

### Workstream E: Story ingestion, source handling, and search

**Units of work:**

1.  URL normalization and canonicalization.
2.  Duplicate URL detection and canonical story shell creation.
3.  Link preview extraction with robots.txt and publisher restrictions respected.
4.  Source metadata: publisher, author where available, timestamp, content type, paywall state, original/republished status, archive constraints, and language.
5.  Original post submission with structured claim and evidence fields.
6.  Search indexing for stories, rooms, claims, evidence cards, and public summaries.
7.  Source reliability state as a moderation/context field, not a simplistic universal truth score.
8.  Provenance tracking for edits, reposts, canonical merges, and context patches.
9.  DMCA/copyright intake path and source takedown workflow.
10. Abuse controls for spam domains, malware links, cloaked URLs, and mass submissions.

**Definition of done:** Users can submit links from the share sheet, duplicates are merged, canonical story pages are stable, and source context is visible without implying endorsement.

### Workstream F: Forum and conversation system

**Units of work:**

1.  Thread schema with branches rather than one flat chronological comment pile.
2.  Contribution taxonomy: evidence, question, correction, synthesis, counterpoint, local witness, explanation, moderation note, and source note.
3.  Markdown-lite parser with safe link handling, citation blocks, quote limits, and accessible formatting.
4.  Reply permissions and rate limits by trust state, room state, and safety state.
5.  Edit history and correction workflow.
6.  Thread summaries generated with strict source grounding and human/steward overrides.
7.  Branch ranking using PWA, Hodge tension, evidence quality, and recency caps.
8.  Collapse rules for low-value repetition, harassment, and off-topic branches.
9.  Local witness and expert contribution labeling without creating unverified authority badges.
10. Steward tools for merging, moving, labeling, and context patching.

**Definition of done:** A thread can deepen through evidence and synthesis rather than merely accumulate reactions or chronological replies.

## 29.4 Core invariant build plans

### 29.4.1 MERI build plan: Matroid Exposure Rank Invariant

**Goal:** Prevent duplicate or near-duplicate content from creating artificial visibility.

**Version strategy:**

- **MERI v0:** URL and text-similarity duplicate dampening.
- **MERI v1:** Multi-dimensional independence using source lineage, semantic claim, evidence base, author/network distance, and viewpoint/lens distance.
- **MERI v2:** Matroid-like rank approximation with learned independence constraints, fairness checks, and explainable nonredundancy labels.

**Decomposed units of work:**

1.  **Define independence dimensions.** Start with source, URL canonical, claim cluster, evidence cluster, author/creator lineage, room/lens, language, and time. Do not include protected attributes as rank dimensions.
2.  **Build duplicate clusters.** Use URL canonicalization, perceptual text similarity, embedding similarity, and publisher syndication signals.
3.  **Build claim clusters.** Extract central claim candidates, embed them, cluster them, and allow steward correction.
4.  **Build evidence clusters.** Group sources that rely on the same primary document, press release, study, wire article, or eyewitness media.
5.  **Create independence graph.** Mark items as parallel, dependent, partially independent, or independent.
6.  **Implement greedy rank approximation.** For a feed candidate set, select items that maximize marginal independent coverage subject to freshness, safety, and user relevance constraints.
7.  **Expose UI explanations.** Examples: "Grouped with 12 similar posts," "Adds independent source," "Same claim, new evidence," or "Different community interpretation."
8.  **Test with synthetic spam.** Generate duplicate floods, paraphrase floods, syndicated news clusters, and legitimate multi-source coverage.
9.  **Measure false dampening.** Ensure legitimate breaking-news corroboration is not suppressed as spam.
10. **Integrate with PWA.** MERI changes the exposure-independence and redundancy terms, not user reputation.

**Acceptance criteria:**

- Duplicate floods do not increase distribution linearly.
- Independent evidence can still lift a story even when the same event is widely covered.
- Mobile feed cards explain grouping decisions.
- Stewards can inspect and correct bad merges.
- MERI outputs include confidence and reason codes.

### 29.4.2 MFCI build plan: Markov-Fiber Coordination Invariant

**Goal:** Detect suspicious coordination while conditioning on normal activity levels.

**Version strategy:**

- **MFCI v0:** Shadow-mode anomaly reports using fixed margins for user group, topic, action, and time window.
- **MFCI v1:** Analyst-reviewed ranking dampening for high-confidence coordination.
- **MFCI v2:** Markov-basis or sequential Monte Carlo sampling for richer fibers, plus adversarial adaptation tests.

**Decomposed units of work:**

1.  **Define action tables.** Separate submit, source-open, contribute, report, block, mention, and reshare-like link-share events. Do not mix positive participation with abuse reports.
2.  **Choose safe grouping.** Group users by behaviorally relevant, privacy-safe cohorts such as account age bucket, room participation bucket, and trust tier. Avoid sensitive demographic grouping for enforcement.
3.  **Define margins.** Preserve total activity by time, topic, room, account-age bucket, and action type. This prevents penalizing active communities merely for being active.
4.  **Select test statistics.** Examples: synchronized action burst, repeated co-action set, target concentration, cross-room simultaneity, reciprocal amplification, and report-brigade concentration.
5.  **Build fiber sampler.** Start with permutation/Monte Carlo baselines; add Markov moves as the table structure stabilizes.
6.  **Calibrate thresholds.** Use historical benign events, synthetic coordinated attacks, load tests, and red-team campaigns.
7.  **Create severity states.** Informational, watch, dampen acceleration, freeze acceleration pending review, enforcement review, and cleared.
8.  **Build analyst case view.** Show pattern, margins preserved, comparable baselines, affected items, affected users, confidence, and recommended non-punitive action.
9.  **Prevent feedback loops.** MFCI should not learn from its own dampening as proof of coordination without correction.
10. **Add appeal and correction path.** Communities must be able to challenge public labels or distribution restrictions.

**Acceptance criteria:**

- High-volume authentic communities are not flagged solely for activity level.
- Coordinated reporting attacks are detectable before they suppress content.
- Automated actions are reversible and logged.
- Analysts can explain why a pattern is unusual under fixed margins.
- False-positive reviews update calibration data.

### 29.4.3 GWEI build plan: Gromov-Wasserstein Experience Isometry

**Goal:** Audit whether different cohorts receive structurally comparable experiences without requiring identical content.

**Version strategy:**

- **GWEI v0:** Dashboard comparing feed distributions with simpler distances and descriptive metrics.
- **GWEI v1:** Approximate Gromov-Wasserstein distance over sampled cohort experience spaces.
- **GWEI v2:** Release-gating and mitigation recommendations for ranking experiments.

**Decomposed units of work:**

1.  **Define cohorts safely.** Use jurisdiction, language, device class, accessibility settings, subscription state, new/returning status, and self-selected rooms where appropriate. Sensitive cohorts require privacy/legal review and aggregation thresholds.
2.  **Define experience points.** Each point may be a story impression, thread impression, source card, context label, or moderation label.
3.  **Define distance function.** Combine semantic distance, source lineage distance, topic distance, recency distance, evidence-completeness distance, creator-size distance, and safety-state distance.
4.  **Define measure weights.** Use impression share, attention-adjusted share, or opportunity share depending on audit purpose.
5.  **Start with simpler diagnostics.** Before GW, compute coverage, entropy, source diversity, topic exposure, evidence exposure, and context-label rates.
6.  **Implement approximate GW.** Use sampled windows and entropic regularization; track instability across seeds.
7.  **Build fairness dashboards.** Show disparity, confidence, affected surfaces, likely drivers, and example comparison sets.
8.  **Set release gates.** Ranking changes cannot ship broadly if GWEI disparity exceeds threshold without mitigation or documented exception.
9.  **Create mitigation actions.** Adjust candidate generation, source diversity, room bridges, context injection, or exploration budgets.
10. **Protect privacy.** Suppress small cells, avoid user-level cohort display, and document all sensitive cohort use.

**Acceptance criteria:**

- A ranking experiment can be compared against baseline by cohort.
- The dashboard distinguishes item difference from relational-experience difference.
- Small cohorts are protected from re-identification.
- Product teams receive actionable mitigation suggestions rather than only a red/yellow/green score.

### 29.4.4 SCOI build plan: Sheaf Context Obstruction Invariant

**Goal:** Detect when a story's meaning cannot be coherently interpreted across communities without additional context.

**Version strategy:**

- **SCOI v0:** Detect context conflicts through lens-specific summaries, disagreement labels, and steward reports.
- **SCOI v1:** Compute overlap consistency across community lenses and route bridge/context tasks.
- **SCOI v2:** Cohomology-inspired obstruction classes for persistent cross-community interpretation failures.

**Decomposed units of work:**

1.  **Define lenses.** Lenses are not demographic boxes; they are contextual communities such as local residents, domain experts, affected groups, source communities, or topic rooms.
2.  **Extract local interpretations.** Summarize what each lens appears to believe the story means, what it disputes, what evidence it cites, and what context it says is missing.
3.  **Build overlap maps.** Identify users, sources, claims, and contributions that bridge two or more lenses.
4.  **Compare restrictions.** On overlaps, test whether interpretations agree, conflict, or use incompatible assumptions.
5.  **Score obstruction.** Use severity based on disagreement persistence, safety risk, civic importance, evidence uncertainty, and cross-lens visibility.
6.  **Create context tasks.** Ask for synthesis, missing evidence, local witness, expert explanation, timeline repair, or source provenance.
7.  **Build context patch workflow.** Stewards can approve a context patch that travels with the story across feeds and rooms.
8.  **Recompute after patch.** SCOI should drop when a context patch makes local interpretations compatible or at least legible.
9.  **Expose careful UI.** "Needs Context" means interpretations differ; it must not mean false, bad, or banned.
10. **Audit for bias.** Ensure minority or local interpretations are not erased by majority-lens summaries.

**Acceptance criteria:**

- The app can identify cross-community misunderstanding before amplification worsens it.
- Users see origin and interpretation context when content crosses rooms.
- Context repair contributions are rewarded by PWA.
- SCOI labels are appealable and editable through steward workflows.

### 29.4.5 PHI build plan: Preference Holonomy Invariant

**Goal:** Detect path-dependent recommender steering, especially loops that return a user to a topic with a materially altered preference state.

**Version strategy:**

- **PHI v0:** Detect narrow repeated topic loops and compulsive session patterns.
- **PHI v1:** Estimate transport between topic contexts and dampen high-risk loops.
- **PHI v2:** Gauge-invariant holonomy diagnostics for recommender path deformation.

**Decomposed units of work:**

1.  **Define topic-state space.** Use a stable taxonomy plus embeddings for stories, rooms, claims, sources, and user intent signals.
2.  **Define local preference summaries.** Keep summaries coarse, privacy-preserving, and resettable by users.
3.  **Estimate transitions.** Learn how recommendation transitions move users between contexts without assuming every transition is harmful.
4.  **Detect loops.** Identify cycles such as topic A -> outrage frame -> adjacent identity conflict -> conspiracy frame -> topic A.
5.  **Measure deformation.** Compare the user's state before and after the loop, using invariant features rather than coordinate-specific embedding values.
6.  **Classify risk.** Separate exploration, education, breaking-news follow-up, harassment spirals, compulsive loops, and radicalizing paths.
7.  **Apply soft interventions.** Increase source diversity, insert context, slow repetition, offer a reset, or switch to chronological/followed-room mode.
8.  **Expose user controls.** Let users inspect and reset topic inferences, reduce personalization, and choose non-profiled feeds where required.
9.  **Red-team loops.** Test health panic, political outrage, celebrity harassment, financial mania, and tragedy exploitation scenarios.
10. **Prevent paternalism.** PHI should not suppress legitimate sustained interest merely because it is intense.

**Acceptance criteria:**

- Known harmful loop fixtures are dampened in staging.
- Legitimate research sessions are not dampened merely for depth.
- Users have meaningful recommender controls.
- PHI decisions are logged with reason codes and reversible gates.

## 29.5 Ranking and PWA implementation tasks

### PWA v0: Instrumented salience without distribution power

1.  Create event schemas for active attention and participation.
2.  Implement client-side aggregation and idle filtering.
3.  Compute basic item-window attention summaries.
4.  Show private Signal Ledger entries.
5.  Do not use PWA to strongly rank feeds yet.

**Done when:** The team can explain which signals were collected, users can see their own signal categories, and raw dwell time alone cannot move a story to the top.

### PWA v1: Bounded ranking input

1.  Add saturation curves per user, per item, and per time window.
2.  Add source-open and source-return weighting.
3.  Add constructive contribution weighting by type.
4.  Add anti-signals for idle loops, rage-scroll patterns, repeat refreshes, and report brigades.
5.  Connect MERI v1 redundancy dampening.
6.  Connect safety-state constraints.
7.  Produce mobile ranking explanations.

**Done when:** PWA improves usefulness over chronological ranking in offline replay and closed alpha without increasing moderation burden or session-compulsion metrics.

### PWA v2: Context-aware civic distribution

1.  Add SCOI coherence gain.
2.  Add PHI path-risk dampening.
3.  Add GWEI release gates for cohort parity.
4.  Add experimental weights by surface and topic class.
5.  Add external transparency metrics.

**Done when:** Ranking can balance timeliness, independence, context, safety, and fairness across cohorts under controlled experiments.

## 29.6 Trust, safety, and moderation implementation tasks

### Safety foundation

1.  Publish rules and contribution guidelines in plain language.
2.  Implement report content, report user, block user, mute user, mute topic, and appeal.
3.  Build moderation queues by severity and policy area.
4.  Add emergency escalation for credible threats, self-harm, child safety, and illegal content.
5.  Add moderator notes, evidence capture, and policy reason codes.
6.  Add user notices for content actions and account restrictions.
7.  Add transparency log events.
8.  Test app-store UGC checklist before submission.

**Done when:** The platform can handle objectionable UGC, respond to reports, block abusive users, and provide support contact information through the app and public website.

### Integrity foundation

1.  Add rate limits for submissions, reports, and repeated contributions.
2.  Add domain and URL abuse detection.
3.  Add account-age and trust-tier controls.
4.  Add MFCI shadow-mode dashboard.
5.  Add coordinated reporting protection.
6.  Add analyst review tooling.
7.  Add false-positive labeling and calibration.

**Done when:** Coordinated attacks can be detected, slowed, reviewed, and cleared without suppressing authentic high-volume discussion.

## 29.7 Privacy, compliance, and data governance tasks

1.  Build a data inventory before beta: event name, purpose, lawful basis or internal justification, retention, sensitivity, user control, and downstream consumers.
2.  Separate account identity, content, attention aggregates, anti-abuse signals, and audit logs with clear access policies.
3.  Implement privacy settings: personalization, attention-signal use, recommender reset, topic inference reset, export, deletion, notification controls, and sensitive topic controls.
4.  Establish default protections for minors and do not target under-13 users in the US without a dedicated COPPA program.
5.  Add small-cell suppression and aggregation thresholds for research dashboards.
6.  Create DPIA/PIA templates for ranking, AI summarization, minors, political/civic content, and health content.
7.  Create DSAR workflows for access, deletion, correction, portability, opt-out where applicable, and appeal/escalation.
8.  Create vendor review for analytics, crash reporting, AI providers, moderation tools, and cloud services.
9.  Build retention jobs and deletion verification.
10. Create privacy incident response playbook.

**Done when:** Privacy review can trace every attention-derived signal from collection to retention, user controls, ranking use, and deletion.

## 29.8 Security and reliability tasks

1.  Threat model mobile app, API, event ingestion, ranking, moderation tooling, admin systems, and AI pipelines.
2.  Implement passkeys as preferred authentication, with secure recovery and risk-based step-up.
3.  Use secure mobile storage for tokens and draft secrets.
4.  Enforce TLS, certificate-pinning decisions based on operational risk, token rotation, and replay protection.
5.  Implement API authorization at object and action level.
6.  Add abuse-specific rate limits and bot defenses.
7.  Harden moderator/admin tooling with least privilege, session logging, approval gates, and break-glass procedures.
8.  Add secrets management, dependency scanning, SAST, DAST, mobile security testing, and SBOMs.
9.  Add backups, restore drills, disaster recovery targets, and incident runbooks.
10. Build observability: traces, metrics, logs, alert thresholds, service-level objectives, and on-call rotations.

**Done when:** The product passes mobile security review, backend threat-model review, incident simulation, restore test, and launch readiness review.

## 29.9 AI and summarization tasks

1.  Define allowed AI uses: summarization, duplicate detection, claim clustering, context draft generation, moderation triage, and accessibility support.
2.  Define prohibited AI uses: final policy judgment without review, hidden persuasion optimization, sensitive attribute inference for ranking, and public truth labels without evidence.
3.  Build source-grounded summarization with citations to visible thread/source material.
4.  Add hallucination checks, quote-limit controls, and uncertainty labels.
5.  Require human/steward approval for high-impact context cards.
6.  Log prompts, model versions, source inputs, and output hashes where privacy permits.
7.  Evaluate summaries for faithfulness, balance, missing context, bias, and readability.
8.  Provide user feedback and correction path.
9.  Add AI incident playbook for harmful, false, or biased summaries.
10. Maintain AI model inventory and risk assessments.

**Done when:** AI can draft helpful context without becoming an unaccountable authority or moderation judge.

## 29.10 Phase plan with smaller units of work

### Phase -1: Governance and feasibility framing

**Goal:** Establish the product boundary before code architecture hardens.

**Units:**

1.  Finalize no-applause charter.
2.  Approve policy taxonomy.
3.  Approve data classification.
4.  Select launch jurisdictions and age posture.
5.  Select native mobile architecture.
6.  Create technical risk register.
7.  Create invariant validation strategy.
8.  Create launch-gate checklist.

**Exit gate:** Leadership can name what is in scope, what is out of scope, what data is collected, and which risks block launch.

### Phase 0: Prototype and simulation

**Goal:** Validate that users understand the product without likes/upvotes and that PWA/MERI can work on realistic data.

**Units:**

1.  Clickable mobile prototype.
2.  Story submission prototype.
3.  Thread and composer prototype.
4.  Context card prototype.
5.  Signal Ledger prototype.
6.  Synthetic event simulator.
7.  PWA offline notebook.
8.  MERI duplicate clustering notebook.
9.  MFCI synthetic coordination notebook.
10. Moderation policy tabletop.
11. Accessibility design review.
12. Security threat-model sketch.

**Exit gate:** Users can complete core flows, no-applause concept is understood, and simulations show basic anti-duplication and anti-coordination feasibility.

### Phase 1: Internal alpha

**Goal:** Build the first real vertical slice for employees and invited testers.

**Units:**

1.  Native mobile app shell.
2.  Auth and account settings.
3.  Story ingestion and canonicalization.
4.  Basic rooms.
5.  Thread creation and structured contributions.
6.  Report/block/mute.
7.  Event pipeline v0.
8.  PWA v0/v1 in limited ranking.
9.  MERI v0/v1 for duplicate grouping.
10. Manual moderation console.
11. Signal Ledger v0.
12. Observability and crash reporting.
13. Basic privacy export/delete flow.
14. App security baseline.

**Exit gate:** The app is usable daily by a small cohort, duplicate amplification is dampened, moderation works, and no critical security/privacy issue is open.

### Phase 2: Closed alpha with invited communities

**Goal:** Test real discussion dynamics while limiting blast radius.

**Units:**

1.  Invite and room management.
2.  PWA ranking experiments against chronological baseline.
3.  MERI v1 explanations.
4.  MFCI shadow-mode detection.
5.  Context cards v1.
6.  Evidence drawer v1.
7.  Steward tools v1.
8.  Appeals workflow v0.
9.  Accessibility remediation.
10. Privacy settings v1.
11. Security testing and abuse red team.
12. Initial transparency report generator.

**Exit gate:** Real users contribute constructively, PWA improves usefulness without increasing harm metrics, MFCI false positives are reviewable, and accessibility/security issues are remediated.

### Phase 3: Public beta by topic and region

**Goal:** Open limited public access with strong operational controls.

**Units:**

1.  Public onboarding with clear no-applause explanation.
2.  Scalable ranking service.
3.  MFCI v1 with analyst-reviewed dampening.
4.  SCOI v0/v1 context obstruction workflow.
5.  PHI v0 loop dampening.
6.  GWEI v0/v1 dashboards for beta cohorts.
7.  Moderator staffing and QA.
8.  Public support and appeals.
9.  Research transparency exports with privacy thresholds.
10. App-store review package for iOS and Android.
11. Incident response drill.
12. Data retention and deletion verification.

**Exit gate:** The platform can respond to abuse, explain ranking, protect privacy, meet mobile performance budgets, and produce transparency reports from live data.

### Phase 4: General availability

**Goal:** Launch broadly without sacrificing the founding constraints.

**Units:**

1.  Multi-region infrastructure readiness.
2.  Full trust-and-safety operations.
3.  Transparency portal.
4.  GWEI release gates for major ranking changes.
5.  SCOI context patching at scale.
6.  PHI recommender controls.
7.  Mature app-store compliance operations.
8.  Public API/research API beta with aggregation safeguards.
9.  Security audit and privacy review refresh.
10. Internationalization and localization workflows.

**Exit gate:** Licio can scale traffic, maintain no-applause ranking, handle UGC abuse, and govern AI/ranking risks with documented controls.

### Phase 5: Scale, research, and governance maturity

**Goal:** Improve mathematical rigor, transparency, and public accountability.

**Units:**

1.  MERI v2 rank refinement.
2.  MFCI v2 richer fibers and adversarial adaptation tests.
3.  GWEI v2 mitigation recommendations.
4.  SCOI v2 obstruction classes.
5.  PHI v2 gauge-invariant path diagnostics.
6.  Independent audits.
7.  Researcher data-access process.
8.  Civic partner program.
9.  Policy versioning and public changelogs.
10. AI management system maturity review.

**Exit gate:** The platform can support external scrutiny while preserving user privacy, safety, and product coherence.

## 29.11 Cross-functional acceptance gates

A feature cannot progress from prototype to public beta unless it passes these gates:

1.  **Product gate:** It supports the no-applause model and does not smuggle likes, reactions, popularity badges, or public karma back into the product.
2.  **Mobile gate:** It works on target low-end devices, supports interruption, and passes core accessibility checks.
3.  **Privacy gate:** It has a documented purpose, retention tier, user control, and deletion behavior.
4.  **Security gate:** It has threat-model coverage and passes relevant automated and manual tests.
5.  **Safety gate:** It has reporting, blocking, moderation review, action logging, and appeal paths.
6.  **AI gate:** AI-assisted outputs are source-grounded, logged, evaluated, and correctable.
7.  **Invariant gate:** Mathematical outputs include confidence, coverage, reason codes, and fallback behavior.
8.  **Experiment gate:** Metrics include quality, harm, privacy, fairness, and wellbeing, not only engagement.
9.  **Operations gate:** Support, moderation, incident response, and rollback are ready.
10. **Transparency gate:** The feature produces logs that can support user explanations and aggregate reporting.

## 29.12 Efficient task sizing rules

To keep work small and efficient, teams should use these sizing rules:

- A backend task should produce one schema, one API, one job, or one dashboard change, not a vague "build ranking" deliverable.
- A mobile task should complete one user journey state: empty, loading, success, error, offline, abuse/safety state, and accessibility state.
- An invariant task should define input, output, confidence, failure mode, and one product consumer.
- A moderation task should define policy reason, actor permissions, user notice, appealability, audit event, and rollback.
- A privacy task should define data element, purpose, retention, access, export behavior, deletion behavior, and legal review status.
- A release task should include feature flag, metric guardrail, owner, rollback trigger, and post-launch review date.

## 29.13 Optimized minimum viable product

The MVP should include:

1.  Native mobile apps with feed, rooms, story detail, thread branches, structured composer, source reader, Signal Ledger, settings, reporting, blocking, muting, and appeals.
2.  Story ingestion with duplicate grouping and source metadata.
3.  PWA v1 with bounded active attention, source interaction, constructive participation, safety gates, and mobile explanations.
4.  MERI v1 duplicate/nonredundancy dampening.
5.  MFCI v0 shadow mode and coordinated reporting protection.
6.  Manual moderation console with policy reason codes and audit logs.
7.  Basic context cards and evidence drawer.
8.  Privacy controls for personalization, attention signal use, export, deletion, and recommender reset.
9.  Accessibility-complete core flows.
10. Security baseline, observability, incident response, and transparency report generator.

The MVP should not include ads, public follower counts, public karma, open direct messaging, broad creator monetization, open developer API, algorithmic trending leaderboards, or unrestricted anonymous posting.

## 29.14 Post-MVP enhancements

Post-MVP enhancements should be prioritized in this order:

1.  SCOI v1 context obstruction workflows.
2.  GWEI v1 fairness dashboards and experiment gates.
3.  PHI v1 loop dampening and recommender controls.
4.  Advanced evidence graph and claim lineage.
5.  Researcher transparency portal.
6.  Internationalization and local news partnerships.
7.  Optional paid membership model.
8.  Public-interest newsroom/steward collaborations.
9.  Advanced accessibility personalization.
10. Formal external audits.


## 29.15 Knomosis L2 implementation plan

The Knomosis rollout is a separate critical path layered onto the social product. It should not delay the no-like/no-upvote MVP unless the founding product requires crypto from day one. The safest plan is to ship Licio first with simulated governance, then progressively enable Knomosis features.

### 29.15.1 Workstream K0: due diligence and integration definition

Goal: turn the Knomosis repository and deployment assumptions into a pinned integration contract.

Units of work:

1.  **Repository review:** identify exact Knomosis version, commit, Lean toolchain, Solidity contracts, Rust runtime crates, license obligations, and deployment assumptions.
2.  **Threat model:** analyze bridge, state-root submission, withdrawal, fault-proof, event ingestion, wallet signing, and room treasury risks.
3.  **Legal scoping:** classify non-custodial, partner-custodial, and first-party custodial options; map target jurisdictions.
4.  **App-store scoping:** determine which iOS/Android flows are allowed natively, require IAP, require external entitlement, or must be disabled.
5.  **Architecture decision record:** choose MVP custody model, supported assets, supported regions, chain environment, pilot room type, and feature flags.
6.  **Audit requirement definition:** list required internal and external reviews before testnet and mainnet.

Definition of done:

- Pinned Knomosis commit and deployment manifest exist.
- Custody model is chosen for MVP.
- Legal/app-store go/no-go matrix exists.
- Threat model is reviewed by security, engineering, product, trust-and-safety, and counsel.

### 29.15.2 Workstream K1: simulation mode

Goal: teach and test governance without real wallets or funds.

Units of work:

1.  Build Governance tab shell.
2.  Build proposal templates for charter change, bounty, grant, steward rotation.
3.  Build simulated treasury balances and audit log.
4.  Build proposal discussion threads linked to ordinary Licio conversations.
5.  Add MFCI shadow checks for proposal/vote coordination.
6.  Add mobile user testing for comprehension.
7.  Add room readiness checklist.

Definition of done:

- Pilot rooms can run end-to-end simulated proposals.
- Users understand that no real funds are involved.
- Governance UI passes accessibility and mobile usability tests.
- Simulation data cannot leak into production financial records.

### 29.15.3 Workstream K2: testnet wallet and Knomosis gateway

Goal: connect wallets and submit testnet Knomosis actions safely.

Units of work:

1.  Implement wallet-link nonce and signature verification.
2.  Implement typed-data transaction preview payloads.
3.  Implement Knomosis Gateway preflight endpoint.
4.  Implement action submission to testnet/runtime environment.
5.  Implement event indexing and reorg-aware reconciliation.
6.  Implement wallet unlinking and disabled-state UX.
7.  Add mobile transaction simulation and warnings.
8.  Add integration tests with mocked and testnet events.

Definition of done:

- A user can link a wallet, sign a testnet proposal, submit it, and see an indexed audit event.
- Unknown chain/contract actions are blocked.
- Reorg/replay tests pass.
- No private keys or seed phrases are handled by Licio.

### 29.15.4 Workstream K3: testnet treasury and bounty lifecycle

Goal: validate room treasury mechanics before real assets.

Units of work:

1.  Create testnet RoomTreasury entity.
2.  Create testnet PaymentIntent lifecycle.
3.  Implement bounty creation, claim, review, challenge, and payout simulation.
4.  Implement grant recipient disclosure and conflict-of-interest fields.
5.  Implement treasury dashboard and audit log.
6.  Implement financial case queue for disputed bounties.
7.  Run abuse tests for collusive bounties, fake evidence, and vote buying.

Definition of done:

- Testnet bounty can be funded, completed, reviewed, challenged, and paid out.
- Treasury reconciliation explains every balance change.
- MFCI flags synthetic collusion scenarios.
- Product support can resolve common failure states.

### 29.15.5 Workstream K4: capped production pilot

Goal: run real-funds pilot only after security, legal, app-store, and operational gates pass.

Units of work:

1.  Select limited pilot jurisdictions and pilot rooms.
2.  Enable non-custodial or partner-supported payments under legal approval.
3.  Set low per-user, per-room, and per-period limits.
4.  Enable treasury deposits and capped grants only.
5.  Disable complex law-pack changes and permissionless room creation.
6.  Monitor financial incidents, pay-to-rank leakage, support burden, and governance capture.
7.  Run weekly review board with product, legal, security, trust-and-safety, and finance.
8.  Publish pilot transparency summary.

Definition of done:

- No critical security incidents.
- No measurable ranking advantage from payments.
- Support and compliance queues remain within SLA.
- Users understand transaction previews in usability tests.
- Governance disputes have documented resolutions.

### 29.15.6 Workstream K5: mature Knomosis governance

Goal: expand after the pilot proves safety.

Units of work:

1.  Add more proposal types.
2.  Add delegated governance with revocation.
3.  Add law-pack migration flow.
4.  Add room fork/exit process.
5.  Add expanded treasury accounting exports.
6.  Add external audit portal.
7.  Add research API for aggregate governance data.
8.  Add privacy-preserving cross-room governance health dashboards.

Definition of done:

- Mature rooms can govern treasury resources without increasing abuse, ranking inequity, or support risk.
- Law-pack migrations are simulated, audited, and reversible or safely recoverable where possible.
- External auditors can reproduce governance and treasury histories from public logs plus approved off-chain records.

### 29.15.7 Dependencies

Knomosis work depends on:

1.  Core account system.
2.  Room model.
3.  Moderation/report/blocking.
4.  Event stream and audit logs.
5.  Mobile secure UX foundations.
6.  Trust-and-safety staffing.
7.  Security incident response.
8.  Legal/app-store readiness.
9.  Financial operations.
10. MFCI shadow mode for governance manipulation.

Knomosis production does not block:

1.  Story submission.
2.  Reading and discussion.
3.  PWA ranking.
4.  MERI duplicate dampening.
5.  Basic rooms.
6.  Ordinary moderation.
7.  Non-wallet user journeys.


### 29.15.8 Knomosis task decomposition matrix

| Epic | Smaller unit | Owner | Dependency | Definition of done |
|------|--------------|-------|------------|--------------------|
| Wallet | Nonce service | Identity + Wallet | Auth/session service | One-time nonce cannot be replayed or used cross-domain. |
| Wallet | Signed-message verifier | Wallet + Security | Nonce service | Validates domain, chain, address, expiration, and signature path. |
| Wallet | Revocation and privacy controls | Wallet + Privacy | WalletLink model | User can disconnect and hide wallet without support ticket. |
| Treasury | Asset allowlist | Treasury + Legal | Legal launch matrix | Unsupported assets fail closed with clear mobile copy. |
| Treasury | Payment quote | Treasury + Wallet | Asset allowlist | Quote shows amount, fees, recipient, finality, and non-ranking disclosure. |
| Treasury | Receipt timeline | Mobile + Indexer | Chain event ingest | Pending/final/reorg/reverted states render correctly on mobile. |
| Governance | Charter schema | Governance + Policy | Forum rules model | Charter defines scope, powers, prohibited actions, and appeal path. |
| Governance | Proposal template | Mobile + Governance | Charter schema | Proposal cannot enter deliberation without required fields. |
| Governance | Risk review queue | T&S + Legal + Security | Proposal template | Risk flags are resolved before vote or execution. |
| Governance | Vote/approval collection | Governance + Integrity | Eligibility policy | Votes are auditable and capture-resistant. |
| Execution | Timelock worker | Backend + Security | Passed proposal state | High-risk actions cannot execute before timelock ends. |
| Execution | Allowlisted action executor | Backend + Knomosis | Timelock worker | Executor rejects unknown calldata/action families. |
| Reconciliation | Indexer replay | Infrastructure | Knomosis event schema | Replays from checkpoint and reaches deterministic state. |
| Reconciliation | Treasury ledger check | Finance + Data | Indexer replay | App ledger and chain/Knomosis state reconcile or raise incident. |
| Compliance | Sanctions/risk gate | Legal + Risk | Wallet/address model | Blocked states prevent payments without leaking sensitive reasons. |
| Compliance | App-store review pack | Product + Legal | Final UX/copy | Review notes explain UGC, wallet, payment, and no-reward constraints. |
| Security | Smart-contract audit | Security + External auditor | Stable contracts/laws | Critical/high findings resolved before real-value beta. |
| Operations | Treasury incident runbook | SRE + T&S + Legal | Monitoring + caps | Tabletop drill completes and remediation tasks are tracked. |

### 29.15.9 Ranking-neutrality verification suite

The Knomosis integration must include automated tests proving that financial features cannot become hidden ranking inputs.

Required tests:

1.  Feed ranking replay with and without wallet links produces identical ranking except for allowed user-selected treasury surfaces.
2.  Payment amount is absent from feature-store schemas used by organic ranking.
3.  Donor identity is absent from PWA and invariant feature joins.
4.  Treasury balance does not change story rank unless a manually approved, non-amount public-interest prompt is shown in a dedicated bounty/context surface.
5.  Governance vote outcome does not change factual claim labels without evidence/steward process.
6.  Paid membership does not bypass safety, rate limits, or moderation review.
7.  Sponsored or treasury-funded content receives labels and does not enter unpaid ranking as native content.
8.  ML feature audits fail if wallet, token, payment, or treasury fields are added to organic rankers without explicit approval.
9.  Dashboards distinguish revenue/treasury metrics from product-health metrics.
10. Public explanations state that payments are support or governance actions, not endorsements.


# 29A. Final optimized operating implementation plan

## 29A.1 Operating principles

This section is the final operating plan and supersedes earlier phase descriptions where details conflict. Earlier Section 29 remains useful for context; Section 29A is the execution version.

The plan follows these principles:

1. **Build vertical slices, not isolated research artifacts.** Every complex system must ship as a small slice with mobile UI, backend service, data model, logging, safety checks, monitoring, and rollback.
2. **Shadow before ranking.** PWA, MERI, MFCI, GWEI, SCOI, and PHI run in logging/shadow mode before affecting feed visibility.
3. **Simulate before signing.** Knomosis governance runs as off-chain simulation before testnet signing and testnet before real funds.
4. **Fail closed for risky surfaces, fail open for core reading.** Crypto, governance execution, ranking boosts, AI publication, and treasury actions fail closed; reading, reporting, blocking, privacy controls, and safety access remain available.
5. **One irreversible action per release.** Do not simultaneously launch new real-funds actions, new law packs, new ranking behavior, and new AI moderation powers.
6. **No hidden ranking inputs.** Any feature capable of affecting distribution must be logged, documented, audited, and explainable.
7. **Keep mobile friction where harm is irreversible.** Payments, wallet signing, proposal execution, moderation sanctions, and privacy changes should use deliberate confirmation flows.
8. **Prefer reversible product decisions.** Release features behind server-controlled flags by region, room, user cohort, and app version.
9. **Use independent gates.** Product, security, privacy, legal/compliance, accessibility, trust-and-safety, finance, and app-store readiness each get an explicit go/no-go gate.

## 29A.2 Critical path

The critical path is:

1. Product policy and no-applause rating doctrine.
2. Mobile design system and UGC safety flows.
3. Account, identity, privacy, reporting, blocking, and moderation foundation.
4. Event pipeline for privacy-preserving attention and contribution signals.
5. Story ingestion, source model, forum threads, and structured contributions.
6. PWA shadow scoring and explanation logs.
7. MERI and MFCI shadow services.
8. Basic ranking with hard anti-abuse gates and no payment inputs.
9. Closed alpha without crypto.
10. Knomosis simulation mode and governance UX with no real funds.
11. Testnet Knomosis gateway, wallet signing, receipts, and indexer.
12. External audit, app-store/legal review, compliance controls, and incident drills.
13. Capped production Knomosis pilot in approved rooms and jurisdictions.
14. Public beta expansion only after ranking, safety, privacy, and treasury metrics pass.

No crypto production task should block steps 1 through 9. The core social news product must be valuable without wallet features.

## 29A.3 Workstream A: product doctrine, policy, and governance foundation

Objective: define the platform rules before engineering bakes in incentives.

Efficient units of work:

1. Write the no-applause doctrine: no likes, no traditional upvotes, no karma, no follower-count ranking, no donor ranking, no token ranking.
2. Define allowed signal categories: active attention, constructive participation, evidence contribution, correction, context, nonredundant exposure, and safety feedback.
3. Define prohibited signal categories: money, wallet connection, token holdings, payment amount, paid membership, treasury status, follower count, identity status outside scoped safety or governance use.
4. Draft platform-wide policy hierarchy: law, child safety, violence, harassment, abuse, privacy, IP, elections/civic integrity, financial fraud, health misinformation, spam, and local room rules.
5. Draft forum charter template and steward role definitions.
6. Draft Knomosis commons charter template with allowed governance powers and prohibited powers.
7. Create moderation escalation taxonomy and appeal states.
8. Create transparency-report taxonomy for ranking, moderation, AI, and governance.
9. Create jurisdiction/app-store feature matrix for crypto, wallet, treasury, and payment features.
10. Review all policies with legal, trust-and-safety, privacy, accessibility, and app-store owners.

Outputs:

- Product doctrine memo.
- Policy hierarchy and forum charter templates.
- Signal eligibility matrix.
- Crypto/governance feature matrix.
- Transparency-report data dictionary.

Acceptance gates:

- Engineering can implement ranking without ambiguity about forbidden inputs.
- Moderators can explain when global policy overrides local DAO-like governance.
- Wallet and payment features have disabled states for unsupported regions/builds.
- A reviewer can trace every proposed signal to an allowed product purpose.

## 29A.4 Workstream B: mobile-first UX and design system

Objective: design the native mobile experience around reading, context, contribution, safety, and deliberate financial/governance actions.

Efficient units of work:

1. Build information architecture for Front Page, Story, Thread, Room, Composer, Search, Notifications, Profile, Governance, Wallet, Safety Center, and Settings.
2. Design compact story cards with no likes, no upvotes, no karma, no donor indicators, and no follower-rank cues.
3. Design ranking explanations: why visible, context needed, coordination dampened, duplicate dampened, cross-community context attached.
4. Design thread contribution chips: question, evidence, correction, synthesis, local context, counterexample, expert note, moderation note.
5. Design context cards for source, claim, timeline, community interpretation, and SCOI warnings.
6. Design report/block/mute flows within two taps from any UGC surface.
7. Design AI-summary disclosure and correction flows.
8. Design wallet optionality screens, transaction previews, governance proposal screens, treasury dashboards, and receipt exports.
9. Design empty, loading, offline, error, blocked, restricted, and unsupported-region states.
10. Create accessibility specs: Dynamic Type, screen-reader labels, focus order, color contrast, reduced motion, captions, touch targets, and cognitive-load limits.
11. Run usability tests for reading comprehension, contribution creation, reporting, wallet signing, and proposal review.
12. Update design tokens and component specs after test findings.

Outputs:

- Native mobile design system.
- Clickable prototypes for core, safety, and wallet/governance flows.
- Accessibility annotations.
- UX research report.

Acceptance gates:

- Users can explain why a story is visible without interpreting it as liked.
- Users can report/block objectionable UGC without leaving the context.
- Users understand that wallet connection is optional.
- Users can identify asset, amount, recipient, network, fees, and irreversibility before signing.
- Accessibility review passes target contrast, font scaling, focus, and touch target requirements.

## 29A.5 Workstream C: native mobile clients

Objective: build performant, secure iOS and Android apps that treat mobile as the primary surface.

Efficient units of work:

1. Create native app shell, navigation, deeplinks, feature flags, localization hooks, and remote configuration.
2. Implement account onboarding, session management, passkeys or equivalent strong authentication, and recovery flows.
3. Implement Front Page, Story, Thread, Room, Composer, Profile, Settings, Safety Center, and Search.
4. Implement UGC reporting, content filtering, blocking, muting, appeals, and contact support.
5. Implement offline read cache, draft cache, safe retry, and background sync limits.
6. Implement attention instrumentation with local aggregation, consent boundaries, and privacy-preserving event submission.
7. Implement contribution composer with evidence attachment, source preview, claim linking, and correction flow.
8. Implement explanation cards for ranking and invariant outputs.
9. Implement wallet module behind flags: connect, sign, preview, receipt, errors, export, disconnect.
10. Implement governance module behind flags: proposal list, proposal detail, deliberation, vote/approval, delegation, treasury, disputes.
11. Implement app-store-specific behavior for IAP boundaries, crypto-disabled regions, and financial disclosures.
12. Run mobile performance profiling, battery/network tests, crash tests, accessibility tests, and security tests.

Outputs:

- iOS and Android alpha builds.
- Automated UI tests for core and safety flows.
- Feature-flag matrix.
- Mobile security and accessibility reports.

Acceptance gates:

- Feed p95 first meaningful render meets product target on mid-range devices.
- Core UGC and safety flows work offline/online with consistent recovery.
- Wallet features cannot appear in unsupported regions or unsupported builds.
- The app never requests private keys, seed phrases, or opaque signatures.
- Crash-free sessions and accessibility acceptance thresholds are met for alpha.

## 29A.6 Workstream D: identity, accounts, privacy, and consent

Objective: support civil participation while minimizing personal data and separating social identity from wallet identity.

Efficient units of work:

1. Define user identity states: anonymous reader, pseudonymous contributor, verified role, room member, steward, wallet-linked user, compliance-reviewed actor.
2. Build account service with minimal profile fields and device/session controls.
3. Build age gate and minors restrictions; disable wallet, treasury, payment, and governance signing for minors by default.
4. Build consent and privacy settings for attention-derived signals, personalization, notifications, wallet display, and data export.
5. Build wallet-link table separate from profile, attention, moderation, and ranking tables.
6. Build data retention jobs and deletion/export workflows.
7. Build staff access controls and audit logs for sensitive user, moderation, wallet, and compliance records.
8. Build privacy review workflow for new data fields.
9. Build differential privacy or aggregation-threshold policy for published analytics where applicable.
10. Test account recovery, device revocation, compromised wallet disconnect, and support escalation.

Outputs:

- Identity state machine.
- Data inventory and retention schedule.
- Privacy settings and data-rights workflows.
- Staff access audit logs.

Acceptance gates:

- Wallet linkage can be deleted/disconnected off-chain without deleting core social account history unless required by user rights workflow.
- Staff cannot casually browse wallet-compliance data from ordinary moderation tools.
- Minors cannot access wallet/payment/governance-signing features.
- Data export/deletion flows cover core social and off-chain wallet-linking records.

## 29A.7 Workstream E: event pipeline and Participation-Weighted Attention

Objective: turn attention and participation into privacy-preserving, non-endorsement salience signals.

Efficient units of work:

1. Define event schema for impressions, dwell, scroll depth, thread expansion, evidence opening, source opening, comment drafting, posting, editing, correction, report, block, share, and exit.
2. Classify each event as attention, participation, safety, quality, anti-signal, or diagnostic-only.
3. Implement local event buffering with rate limits and privacy filters.
4. Implement server event ingestion, validation, deduplication, replay protection, and data retention.
5. Implement PWA v0 in shadow mode with no ranking effect.
6. Build quality weighting for participation: evidence relevance, originality, civility, correction value, thread integration, and reviewer confidence.
7. Build anti-signals: rage loops, suspicious rapid-fire actions, low-information replies, coordinated bursts, reports from blocked actors, and likely harassment cascades.
8. Build PWA explanation logs and user-facing language that avoids implying endorsement.
9. Run offline simulations against synthetic manipulation and real alpha data.
10. Promote PWA to bounded ranking input only after safety review.

Outputs:

- Event schema registry.
- PWA scoring service.
- Privacy-preserving aggregation jobs.
- PWA dashboards and explanation logs.

Acceptance gates:

- PWA cannot be increased by passive autoplay, background time, bot loops, refresh loops, paid interactions, or wallet actions.
- Deep low-quality argument does not outrank shorter high-quality evidence contribution.
- Ranking explanations label PWA as attention/participation, not approval.
- Privacy review approves event minimization and retention.

## 29A.8 Workstream F: story ingestion, source handling, and search

Objective: support high-quality social news aggregation with provenance and context.

Efficient units of work:

1. Define submission types: link, text post, evidence card, claim, correction, local observation, live update, source archive request.
2. Build URL ingestion, canonicalization, duplicate detection, paywall handling, source metadata, archive link handling, and language detection.
3. Build source profiles with ownership, reliability notes, correction history, topic expertise, and disclosure fields where available.
4. Build claim extraction and evidence-card linking.
5. Build search indexing for stories, rooms, sources, claims, evidence, and governance proposals.
6. Build content freshness, update, correction, and merge workflows.
7. Build source appeal/correction process.
8. Build crawler safety, robots respect, copyright-aware display, and takedown intake.
9. Add MERI hooks for near-duplicate stories and sources.
10. Add SCOI hooks for context-sensitive cross-room sharing.

Outputs:

- Ingestion pipeline.
- Source registry.
- Search service.
- Duplicate/merge tools.

Acceptance gates:

- Duplicate submissions do not inflate visibility.
- Source pages distinguish platform notes from user claims.
- Search does not expose private, deleted, blocked, or restricted content.
- Copyright/IP review approves display format.

## 29A.9 Workstream G: forum and conversation system

Objective: make discussion productive without relying on applause mechanics.

Efficient units of work:

1. Build thread, reply, branch, quote, and evidence-link data models.
2. Build structured contribution taxonomy and composer affordances.
3. Build branch quality scoring separate from user popularity.
4. Build moderation annotations, context patches, and thread locks.
5. Build synthesis and summary objects with provenance.
6. Build room creation, room charter, lenses, membership, steward roles, and local rules.
7. Build role-based permissions for stewards, moderators, experts, local witnesses, and auditors.
8. Build conversation health metrics: unresolved claims, correction ratio, evidence diversity, tension, harassment risk, and source redundancy.
9. Add Hodge Conversation Tension and SCOI hooks for complex debate surfaces.
10. Add governance proposal discussion threads with stricter quality requirements.

Outputs:

- Thread/contribution service.
- Room and steward service.
- Conversation health dashboards.
- Governance discussion module.

Acceptance gates:

- A high-quality correction can improve a thread without becoming a popularity contest.
- Moderation actions are logged and appealable.
- Room rules cannot override global policy.
- Governance proposal threads are distinguishable from ordinary debate threads.

## 29A.10 Workstream H: core invariant services

Objective: implement the mathematical invariants as auditable product services.

### H1: MERI - Matroid Exposure Rank Invariant

Efficient units:

1. Define independence dimensions: source lineage, semantic content, evidence base, author network, narrative frame, language, geography, and time.
2. Build exposure item representation.
3. Build near-duplicate clustering.
4. Build independence oracle v0 with conservative false-positive handling.
5. Compute exposure rank and redundancy ratio in shadow mode.
6. Build duplicate dampening policy.
7. Build explanation text: "similar coverage already shown" or "new independent source".
8. Run A/B shadow audit for source diversity and false dampening.

Gate: MERI reduces duplicate flooding without suppressing genuinely independent reporting.

### H2: MFCI - Markov-Fiber Coordination Invariant

Efficient units:

1. Define contingency-table dimensions for user group, topic, time, room, action, target, device class, and account age.
2. Define preserved margins to avoid punishing large active communities.
3. Implement fiber sampling or approximate conditional testing.
4. Build synchrony, target concentration, repeated co-action, report brigading, and bounty-collusion statistics.
5. Run synthetic attack suite.
6. Run shadow mode on alpha traffic.
7. Build investigation queue with evidence summaries.
8. Integrate bounded dampening and manual review.

Gate: MFCI flags coordinated manipulation conditional on base rates and does not treat normal community interest as abuse.

### H3: GWEI - Gromov-Wasserstein Experience Isometry

Efficient units:

1. Define cohort experience spaces.
2. Define relational distances: topic, source, recency, language, creator size, locality, safety label, and evidence diversity.
3. Compute feed-experience sketches.
4. Run alignment/transport approximations offline.
5. Define fairness thresholds and drift alerts.
6. Audit ranking changes by cohort, region, language, and accessibility settings.
7. Build product dashboard and experiment blocker.

Gate: major ranking launches cannot materially degrade structural experience parity without documented review.

### H4: SCOI - Sheaf Context Obstruction Invariant

Efficient units:

1. Define local context spaces: room, language, region, ideology cluster, professional community, affected community, and source community.
2. Build local interpretation summaries with provenance.
3. Build restriction/translation maps between context spaces.
4. Detect inconsistent gluing across overlaps.
5. Add context-card requirements for high obstruction.
6. Test on ambiguous, satirical, translated, and crisis content.
7. Integrate into cross-room distribution constraints.

Gate: high-obstruction content receives context before broad amplification.

### H5: PHI - Preference Holonomy Invariant

Efficient units:

1. Define topic/context graph.
2. Define local preference representations and transport maps.
3. Build session-loop detection.
4. Estimate loop holonomy in shadow mode.
5. Identify steering loops and rabbit-hole transitions.
6. Add recommender dampening for unsafe path-dependent preference rotation.
7. Add user-facing reset and exploration controls.
8. Audit false positives for legitimate deep dives.

Gate: PHI reduces manipulative recommender loops without blocking intentional learning.

## 29A.11 Workstream I: ranking and distribution

Objective: rank content by public value, attention/participation quality, and invariant constraints without applause or payment signals.

Efficient units of work:

1. Define candidate generation independent of likes, follower count, wallet activity, payments, and donor status.
2. Build feature store with strict allowlist and denylist.
3. Build ranking decision log for every feed item.
4. Implement hard safety filters, legal filters, age filters, blocked/muted filters, and room restrictions.
5. Implement PWA as bounded input.
6. Implement MERI redundancy dampening.
7. Implement MFCI coordination dampening.
8. Implement SCOI context-required gating.
9. Implement PHI path-safety dampening.
10. Implement GWEI audit blocker for experiments.
11. Build ranking explanation service.
12. Build no-pay-to-rank leakage tests.
13. Build rollbacks and kill switches by ranking version.

Outputs:

- Ranking service.
- Feature allowlist/denylist registry.
- Explanation and audit logs.
- Experiment gates.

Acceptance gates:

- Payment, treasury, wallet, token, and governance tables are absent from ranking feature inputs.
- Every ranking output can be reproduced from logged inputs.
- Experiment review can block launches with poor GWEI, MFCI, or PHI outcomes.
- Users see understandable distribution explanations.

## 29A.12 Workstream J: trust, safety, moderation, and abuse operations

Objective: prevent harm while preserving discussion quality and appealability.

Efficient units of work:

1. Build policy classifier support for spam, harassment, threats, child safety, illegal content, financial scams, phishing, impersonation, and manipulated media.
2. Build human moderation queues with prioritization, assignment, notes, escalation, and SLA timers.
3. Build report, block, mute, hide, appeal, restore, and transparency-notice flows.
4. Build room-level moderation tooling and steward oversight.
5. Build coordinated abuse workflows using MFCI evidence summaries.
6. Build wallet-drainer, scam-link, fake-airdrop, fake-bounty, and impersonation detection.
7. Build governance-capture incident playbook.
8. Build child-safety and emergency escalation path.
9. Build content moderation transparency export.
10. Run red-team exercises for brigading, harassment cascades, fake evidence rings, DAO capture, bounty laundering, and pay-to-rank attempts.

Outputs:

- Moderation console.
- Safety case system.
- Red-team reports.
- Transparency reports.

Acceptance gates:

- Public UGC has report/block/moderation/contact functionality.
- Appeals are tracked and auditable.
- Crypto-enabled abuse has dedicated detection and response.
- Emergency holds are narrow, logged, time-limited, and reviewable.

## 29A.13 Workstream K: AI, summarization, and model governance

Objective: use AI to summarize and assist, not to fabricate authority or secretly govern.

Efficient units of work:

1. Define AI use cases: summarization, source clustering, duplicate detection, toxicity triage, context extraction, translation assistance, proposal summaries, support triage.
2. Define prohibited AI use: autonomous irreversible moderation, autonomous treasury decisions, undisclosed persuasion, user profiling from sensitive traits, financial advice.
3. Build prompt/model registry and evaluation harness.
4. Build provenance-preserving summaries with citations to visible platform content.
5. Build correction flow for AI summaries.
6. Build bias, hallucination, safety, and privacy tests.
7. Build AI output logging and audit review.
8. Build generated-content disclosure where required.
9. Evaluate AI around governance proposals for neutrality and missing-risk detection.
10. Launch AI summaries in limited read-only assistive mode before ranking or moderation use.

Outputs:

- AI use-case inventory.
- Evaluation suite.
- Summary service with provenance.
- AI governance log.

Acceptance gates:

- AI summaries do not replace source links or user evidence.
- Users can report or correct AI summaries.
- Governance summaries are neutral and include risks, alternatives, and proposal authority.
- No AI system can spend funds, approve proposals, or issue final sanctions without human or rule-based controls.

## 29A.14 Workstream L: Knomosis L2 gateway, wallets, and receipts

Objective: integrate Knomosis safely through a narrow gateway and observable receipt model.

Efficient units of work:

1. Pin Knomosis source commit and toolchain versions.
2. Reproduce Lean, Solidity, and Rust build/test gates in Licio CI.
3. Review license and deployment architecture with counsel.
4. Define gateway API: preflight, simulate, submit, status, receipt, reconcile, dispute, freeze.
5. Build deployment manifest service and allowlists for chain IDs, law packs, contract addresses, assets, and rooms.
6. Build wallet-link service using typed, domain-separated messages.
7. Build transaction simulation and human-readable preview.
8. Build receipt indexer and event projection service.
9. Build reconciliation service comparing user intent, Knomosis receipt, and product projection.
10. Build failure-state handling: rejected signature, wrong chain, expired deadline, reverted action, sequencer issue, indexer lag, receipt mismatch.
11. Build support tooling for wallet/payment cases.
12. Run devnet, testnet, and replay tests before real-funds pilot.

Outputs:

- Knomosis dependency manifest.
- Gateway service.
- Wallet-link service.
- Receipt indexer and reconciliation queue.
- Support runbooks.

Acceptance gates:

- No production action uses floating dependencies.
- A user can preview and understand every wallet action before signing.
- Every receipt reconciles or enters an auditable discrepancy queue.
- Wrong-chain, wrong-contract, expired, and replayed actions fail safely.

## 29A.15 Workstream M: forum commons, law packs, and treasury operations

Objective: support DAO-like room governance without allowing local communities to bypass platform obligations.

Efficient units of work:

1. Build forum commons state machine: disabled, simulation, testnet, limited live, standard live, restricted, archived.
2. Build law-pack registry and law-pack review workflow.
3. Build proposal templates for bounty, grant, steward election, charter amendment, treasury payout, dispute, emergency hold review, and source partnership.
4. Build deliberation windows, quorum, approval, challenge, timelock, execution, and archive states.
5. Build treasury ledger with asset, amount, network, recipient, proposal, purpose, fee, receipt, and accounting export status.
6. Build conflict-of-interest declarations for stewards, grant recipients, reviewers, and vendors.
7. Build role-based approvals and spending caps.
8. Build accounting exports and monthly room statements.
9. Build public transparency dashboard with privacy-preserving details.
10. Build emergency hold and appeal workflow.
11. Build MFCI capture-detection hooks for votes, proposals, bounties, and payouts.
12. Run pilot room dry-runs with fake assets and tabletop exercises.

Outputs:

- Forum commons service.
- Law-pack registry.
- Treasury ledger and dashboard.
- Proposal/governance workflow.

Acceptance gates:

- No forum can enable real funds without an approved charter, law pack, treasury caps, stewards, legal/app-store status, and security review.
- A treasury spend can be traced from proposal to approval to Knomosis receipt to accounting export.
- Global policy overrides are technically enforceable and audit logged.
- Governance capture tests are run before real-funds pilot.

## 29A.16 Workstream N: compliance, finance, and app-store readiness

Objective: prevent accidental launch of regulated or app-store-incompatible financial features.

Efficient units of work:

1. Build region and storefront policy engine for crypto, wallet, treasury, payments, bounties, grants, tips, and governance signing.
2. Decide custody model and identify whether a regulated partner is needed.
3. Map supported jurisdictions, prohibited jurisdictions, asset allowlists, sanctions controls, and tax/accounting requirements.
4. Prepare Apple review notes for UGC, crypto, no-reward-for-posting, wallet optionality, and disabled-region behavior.
5. Prepare Google Play declarations for UGC, financial services, blockchain-based content, and AI-generated content where applicable.
6. Draft user risk disclosures for wallets, volatility, irreversible transactions, fees, public-chain privacy, and scam risks.
7. Build compliance case-management workflow.
8. Build suspicious activity escalation and hold/freeze workflow where legally appropriate.
9. Build treasury accounting export and finance reconciliation.
10. Run pre-submission app-store compliance review.

Outputs:

- Compliance feature matrix.
- App-store review package.
- Financial operations runbook.
- User disclosures.

Acceptance gates:

- Unsupported financial features are impossible to access from restricted regions/builds.
- Financial declarations match actual app behavior.
- The platform does not offer exchange, custody, yield, lending, securities, gambling, or reward-for-social-task functionality unless separately approved and licensed.
- Finance can reconcile treasury balances and fees.

## 29A.17 Workstream O: security, reliability, and incident response

Objective: harden the mobile, backend, ML, and Knomosis surfaces before launch.

Efficient units of work:

1. Threat model mobile, API, event pipeline, ranking, moderation, AI, wallet, gateway, indexer, treasury, and governance systems.
2. Implement secure SDLC gates: code review, dependency scanning, secret scanning, SAST, DAST, mobile security testing, smart-contract testing, infrastructure scanning.
3. Implement mobile secure storage, certificate pinning decisions, jailbroken/rooted-device risk handling, and anti-tamper where appropriate.
4. Implement backend rate limiting, authz, audit logging, encryption, key management, and least privilege.
5. Implement smart-contract and gateway tests for access control, replay, signature validation, reentrancy, gas bounds, upgradeability, chain ID, nonce, withdrawal, and emergency controls.
6. Run external audits for mobile/backend/security and smart-contract/Knomosis integration.
7. Implement observability: logs, metrics, traces, SLOs, alerting, and user-impact dashboards.
8. Build incident runbooks for moderation crises, data incidents, ranking incidents, payment incidents, wallet scams, bridge/indexer issues, and AI summary failures.
9. Run tabletop exercises and live drills.
10. Launch bug bounty after internal hardening.

Outputs:

- Threat models.
- Security test reports.
- Incident runbooks.
- External audit reports.
- SLO dashboards.

Acceptance gates:

- Critical and high-severity findings are fixed or explicitly risk-accepted before launch.
- Payment and treasury incidents have tested freeze/recovery paths.
- Security logs preserve evidence without exposing unnecessary personal data.
- On-call teams can distinguish social, financial, AI, and infrastructure incidents.

## 29A.18 Workstream P: experimentation, metrics, and launch operations

Objective: launch deliberately and measure public value without optimizing for addiction, speculation, or popularity theater.

Efficient units of work:

1. Define launch phases: internal alpha, closed alpha, public beta without crypto, governance simulation, testnet pilot, capped real-funds pilot, broader GA.
2. Define metrics: comprehension, evidence contribution, correction rate, diversity of independent exposure, unresolved claim reduction, safety incidents, appeal quality, PWA manipulation rate, GWEI parity, PHI steering risk, MFCI coordination rate, and treasury incident rate.
3. Define anti-metrics: time-spent maximization, outrage loops, token price/TVL worship, wallet-connect growth as north star, low-quality comment volume, report brigading, donation influence.
4. Build experiment registry and launch-review process.
5. Build transparency reporting pipeline.
6. Build user research cadence and community feedback loop.
7. Build support staffing and playbooks.
8. Build rollout/rollback automation by app version, region, room, and feature.
9. Run post-launch review after every phase.
10. Maintain deprecation and archive process for unsafe features or rooms.

Outputs:

- Metrics dictionary.
- Experiment registry.
- Launch calendar and rollback playbooks.
- Transparency reports.

Acceptance gates:

- No launch uses engagement alone as success.
- Real-funds pilot does not proceed if support, compliance, security, or app-store readiness is weak.
- Every major feature can be disabled without corrupting core social state.
- Metrics can detect whether the platform is drifting toward applause, speculation, or outrage.

## 29A.19 Optimized milestone plan

### Milestone 0: governance-ready planning

Scope:

- Product doctrine.
- Policy hierarchy.
- Data inventory.
- Technical architecture.
- Knomosis dependency due diligence.
- App-store/compliance matrix.

Exit criteria:

- No forbidden signal ambiguity.
- Legal/security/privacy/product owners approve architecture direction.
- Crypto is confirmed non-blocking for core product alpha.

### Milestone 1: core mobile social news alpha

Scope:

- Native app shell.
- Account system.
- Story submission.
- Threads and structured contributions.
- Reporting/blocking/moderation.
- Basic source model.
- Event pipeline and PWA shadow.

Exit criteria:

- Users can read, submit, discuss, report, block, and appeal without wallet.
- PWA logs are generated but do not control ranking.
- UGC app-store requirements are implemented.

### Milestone 2: invariant shadow alpha

Scope:

- MERI, MFCI, SCOI, PHI, and GWEI in shadow mode.
- Ranking decision logs.
- Explanation cards.
- Synthetic abuse testing.

Exit criteria:

- Invariants produce stable, explainable outputs.
- No invariant creates hidden sanctions without review.
- Ranking feature allowlist excludes payments/wallet data.

### Milestone 3: bounded ranking beta

Scope:

- PWA as bounded input.
- MERI duplicate dampening.
- MFCI abuse queue.
- SCOI context gates.
- PHI recommender dampening.
- GWEI experiment audit.

Exit criteria:

- Ranking can be reproduced from logs.
- No-pay-to-rank tests pass.
- User comprehension and safety metrics pass.

### Milestone 4: Knomosis simulation and testnet

Scope:

- Wallet optionality screens.
- Governance simulation.
- Knomosis gateway devnet/testnet.
- Receipt indexer.
- Law-pack registry.
- Testnet treasury proposals.

Exit criteria:

- Testnet receipts reconcile.
- Users understand transaction previews.
- Law-pack migration and emergency hold tested.
- Security review finds no launch-blocking issues for testnet.

### Milestone 5: capped real-funds pilot

Scope:

- Approved rooms only.
- Approved jurisdictions and app-store builds only.
- Low treasury caps.
- Limited assets.
- Manual review above low thresholds.
- Public transparency and weekly review board.

Exit criteria:

- No critical payment/security/compliance incidents.
- No measurable ranking advantage from payments.
- Treasury records reconcile.
- Support load and dispute rate are manageable.
- App-store status remains compliant.

### Milestone 6: mature public launch

Scope:

- More rooms and regions.
- Expanded governance only after pilot evidence.
- External auditor portal.
- Stronger research and transparency APIs.
- Governance fork/archive/exit processes.

Exit criteria:

- Core social value is healthy without crypto dependence.
- Crypto/governance features remain bounded and non-speculative.
- Accessibility, safety, privacy, security, and transparency reports meet launch thresholds.

# 29B. Atomic task cards for complex/high-risk work

## 29B.1 Task-card format

Every complex task should be broken into a card with:

- owner;
- product goal;
- smallest deliverable;
- dependencies;
- implementation steps;
- telemetry required;
- privacy/security review required;
- test cases;
- failure states;
- rollback path;
- definition of done.

A good card should usually fit in one to three engineering days. Larger tasks must be split until they can be reviewed, tested, and rolled back independently.

## 29B.2 PWA task card sequence

1. Event taxonomy card.
2. Client instrumentation card.
3. Server ingestion card.
4. Event deduplication/replay-protection card.
5. Attention aggregation card.
6. Participation quality weighting card.
7. Anti-signal card.
8. PWA shadow dashboard card.
9. PWA explanation copy card.
10. Manipulation test card.
11. Privacy review card.
12. Bounded ranking integration card.

Each card must verify that PWA is not endorsement, not applause, not a like proxy, not rewardable by crypto, and not inflated by passive or automated behavior.

## 29B.3 Ranking-neutrality task card sequence

1. Feature inventory card.
2. Allowlist/denylist enforcement card.
3. Payment-table isolation card.
4. Wallet-table isolation card.
5. Experiment gate card.
6. Offline leakage test card.
7. Online parity audit card.
8. Ranking decision replay card.
9. User-facing explanation card.
10. Incident rollback card.

Definition of done: no production ranking path can read wallet connection, token balance, donation amount, treasury contribution, payment receipt, governance vote, or paid membership as a positive visibility feature.

## 29B.4 MERI task card sequence

1. Content representation card.
2. Source lineage card.
3. Semantic cluster card.
4. Evidence-base similarity card.
5. Independence oracle card.
6. Matroid rank estimator card.
7. Redundancy dashboard card.
8. False-positive review card.
9. Ranking dampener card.
10. Explanation card.

Definition of done: duplicate and near-duplicate content no longer multiplies visibility, while independent reporting remains discoverable.

## 29B.5 MFCI task card sequence

1. Margin design card.
2. Synthetic normal-community generator card.
3. Synthetic attack generator card.
4. Fiber sampling/approximation card.
5. Synchrony statistic card.
6. Report-brigade statistic card.
7. Governance-capture statistic card.
8. Bounty-collusion statistic card.
9. Investigation summary card.
10. Dampening/manual-review card.

Definition of done: the system detects coordination after conditioning on normal activity rather than punishing high-interest communities.

## 29B.6 GWEI task card sequence

1. Cohort definition card.
2. Feed metric-space card.
3. Experience sketch card.
4. Transport approximation card.
5. Fairness threshold card.
6. Experiment blocker card.
7. Dashboard card.
8. Remediation playbook card.

Definition of done: major launches include structural experience-parity checks across cohorts without forcing all cohorts to see identical content.

## 29B.7 SCOI task card sequence

1. Context map card.
2. Local interpretation summary card.
3. Overlap comparison card.
4. Obstruction score card.
5. Context card UI card.
6. Cross-room routing card.
7. Manual review card.
8. User correction card.

Definition of done: content with incompatible local interpretations is not broadly amplified without context.

## 29B.8 PHI task card sequence

1. Topic graph card.
2. Preference-state representation card.
3. Transport-map card.
4. Loop detector card.
5. Holonomy score card.
6. Recommender dampener card.
7. User reset/explore control card.
8. False-positive audit card.

Definition of done: path-dependent steering risks can be detected, explained, and dampened without blocking intentional exploration.

## 29B.9 Knomosis gateway task card sequence

1. Dependency manifest card.
2. Lean build gate card.
3. Solidity build/test gate card.
4. Rust runtime build/test gate card.
5. License review card.
6. Gateway preflight card.
7. Simulation card.
8. Submit card.
9. Receipt card.
10. Indexer card.
11. Reconciliation card.
12. Failure-state card.
13. Support tooling card.
14. Production allowlist card.

Definition of done: a testnet action can be simulated, signed, submitted, indexed, reconciled, exported, and supported without hidden state.

## 29B.10 Mobile wallet task card sequence

1. Wallet optionality education card.
2. Connect-wallet card.
3. Address privacy card.
4. Network/chain display card.
5. Asset allowlist card.
6. Transaction preview card.
7. Typed signing card.
8. Hold-to-confirm card.
9. Pending receipt card.
10. Error recovery card.
11. Disconnect card.
12. Scam warning card.
13. Accessibility card.
14. App-store disabled-state card.

Definition of done: a user never needs to paste a seed phrase, sign opaque data, or guess whether a transaction affects ranking.

## 29B.11 Forum commons and treasury task card sequence

1. Commons state machine card.
2. Charter template card.
3. Law-pack registry card.
4. Proposal template card.
5. Deliberation card.
6. Quorum/approval card.
7. Timelock card.
8. Challenge/dispute card.
9. Treasury ledger card.
10. Conflict disclosure card.
11. Spending cap card.
12. Payout card.
13. Emergency hold card.
14. Accounting export card.
15. Public transparency card.
16. Archive/refund/migration card.

Definition of done: a room can run a capped grant proposal from draft to payout while preserving policy supremacy, receipts, auditability, and user support.

## 29B.12 Trust-and-safety task card sequence

1. UGC policy card.
2. Reporting card.
3. Blocking card.
4. Moderation queue card.
5. Appeal card.
6. Transparency notice card.
7. Child-safety escalation card.
8. Financial scam card.
9. Wallet-drainer link card.
10. DAO capture card.
11. Coordinated harassment card.
12. Emergency hold review card.
13. Moderator audit card.
14. Transparency report card.

Definition of done: public UGC and crypto-enabled governance have clear reporting, action, appeal, transparency, and emergency response paths.

## 29B.13 Privacy and data-governance task card sequence

1. Data inventory card.
2. Purpose limitation card.
3. Retention schedule card.
4. Wallet/social separation card.
5. On-chain data minimization card.
6. Data export card.
7. Deletion card.
8. Staff access card.
9. Audit log card.
10. Aggregation threshold card.
11. Minors restrictions card.
12. Privacy incident card.

Definition of done: financial/governance data does not leak into ranking or public identity, and sensitive social behavior is not placed on-chain.

## 29B.14 AI governance task card sequence

1. AI use inventory card.
2. Prohibited use card.
3. Evaluation set card.
4. Provenance card.
5. Summary UI card.
6. Correction/report card.
7. Bias/safety card.
8. Governance-neutrality card.
9. Audit log card.
10. Rollback card.

Definition of done: AI assists sensemaking while preserving provenance, user correction, and human/rule-based accountability.

# 29C. Final launch readiness and acceptance-gate register

## 29C.1 Closed alpha gate

Closed alpha can launch only when:

1. UGC reporting, blocking, moderation, appeal, and contact flows are live.
2. No-like/no-upvote UI is complete.
3. PWA runs in shadow mode.
4. Basic story ingestion and threads work.
5. Privacy settings and data retention are implemented.
6. Accessibility review passes the alpha threshold.
7. Security review finds no launch-blocking account/session issues.
8. Wallet and real-funds features are disabled.

## 29C.2 Public beta gate

Public beta can launch only when:

1. PWA is bounded and explainable.
2. MERI and MFCI pass shadow evaluations and limited production gates.
3. Ranking decision logs and replay exist.
4. GWEI experiment review is operational.
5. Moderation and support teams meet SLAs.
6. AI summaries, if enabled, are provenance-preserving and reportable.
7. App-store UGC requirements are met.
8. No-pay-to-rank tests pass even though crypto remains disabled or simulated.

## 29C.3 Knomosis testnet gate

Knomosis testnet can launch only when:

1. Knomosis commit and deployment manifest are pinned.
2. Lean, Solidity, and Rust tests pass in CI.
3. Wallet UX passes usability and accessibility review.
4. Gateway simulation, submission, receipt, indexer, and reconciliation work.
5. Law-pack registry and proposal state machine are implemented.
6. Test assets cannot be mistaken for real funds.
7. App-store builds can disable wallet features if required.
8. Support has testnet wallet/payment runbooks.

## 29C.4 Capped real-funds pilot gate

A capped real-funds pilot can launch only when:

1. Legal and compliance approval covers the target jurisdictions, assets, custody model, room purposes, and payout types.
2. Apple and Google review/declaration packages are complete for the relevant builds.
3. External security review covers mobile wallet flows, backend gateway, smart-contract/L2 interactions, indexer, reconciliation, and treasury operations.
4. Production assets, contracts, chains, law packs, rooms, and limits are allowlisted.
5. Treasury caps, timelocks, conflict disclosures, challenge windows, emergency holds, and accounting exports are live.
6. Sanctions/fraud controls and financial case-management workflow are live where required.
7. Ranking-neutrality tests pass with real payment events in staging.
8. Incident drills are complete for wallet scam, stuck transaction, receipt mismatch, emergency hold, and payment support.
9. The pilot has a named cross-functional review board and weekly go/no-go process.
10. Users see clear risk disclosures and wallet optionality.

## 29C.5 General availability gate

General availability can launch only when:

1. Core social news metrics show public-value improvement, not just engagement growth.
2. Safety incident rate, appeal quality, and moderation SLAs are within target.
3. PWA, MERI, MFCI, SCOI, PHI, and GWEI are stable and auditable.
4. No-payment/no-wallet/no-token ranking neutrality is continuously tested.
5. Accessibility review passes production threshold.
6. Security and privacy high-severity risks are resolved or formally accepted.
7. Transparency reports can be generated from logs.
8. Real-funds features, if enabled, have clean reconciliation history and manageable support burden.
9. Room governance cannot override global policy in implementation or practice.
10. The product can roll back ranking, AI, governance, wallet, treasury, or payment features independently.

# 30. Risks and mitigations

## 30.1 Core product risks

| Risk                           | Description                                             | Mitigation                                                               |
|--------------------------------|---------------------------------------------------------|--------------------------------------------------------------------------|
| Attention surveillance concern | Users may distrust attention-derived ranking.           | On-device processing, private ledger, controls, deletion, clear docs.    |
| Gaming participation           | Users may write long low-quality comments to gain rank. | Contribution quality, outcomes, redundancy, steward review, caps.        |
| Mathematical opacity           | Invariants may be hard to explain.                      | User-facing labels, public methodology summaries, audit docs.            |
| False coordination positives   | Authentic communities may look coordinated.             | Markov-fiber conditioning, human review, appeals.                        |
| Context-card bias              | Context summaries could frame issues unfairly.          | Lens diversity, citations, correction workflow, steward review.          |
| Ranking conservatism           | Too many constraints may make feed stale.               | Tuned exploration quotas, user modes, freshness budgets.                 |
| Moderator overload             | Structured platform still faces abuse.                  | Queue prioritization, automation for triage, steward program.            |
| Cold start                     | New stories lack attention and participation.           | Freshness baseline, source context, room seeding, user opt-in interests. |
| Accessibility regressions      | Complex mobile UI may break screen readers.             | WCAG/native audits, automated and human tests, release gate.             |
| Legal variation                | Rules differ by jurisdiction.                           | Configurable policy layer, legal review, regional rollout.               |


## 30.2 Knomosis, crypto, and DAO-specific risks

| Risk | Description | Mitigation |
|---|---|---|
| Pay-to-rank leakage | Payments indirectly influence visibility through funded activity. | Hard ranking separation, GWEI audits, pay-to-rank leakage metric, manual review. |
| Regulatory noncompliance | Crypto payments may trigger MSB, VASP, CASP, money-transmission, tax, securities, or consumer-protection obligations. | Counsel review, jurisdiction policy engine, licensed partners, limited rollout. |
| App-store rejection | Native app crypto flows may violate IAP, wallet, exchange, or UGC rules. | App-review notes, disabled states, no crypto unlocks, no reward-for-posting, declarations. |
| Wallet compromise | Users sign malicious transactions or lose keys. | Education, typed previews, allowlists, warnings, support, no seed handling. |
| Smart-contract/bridge bug | Contract or bridge defect causes loss or stuck funds. | External audits, caps, bug bounty, timelocks, emergency freezes, staged rollout. |
| Governance capture | Wealthy or coordinated actors seize room treasury or rules. | Capped voting, role quorums, MFCI monitoring, fork/exit, challenge windows. |
| Treasury fraud | Fake grants, fake bounties, fake invoices, or collusive payouts. | Disclosures, steward review, audit logs, fraud queue, spend caps. |
| Privacy linkage | Wallet actions expose user identity or sensitive interests. | Separate wallet/civic identity, off-chain sensitive data, warnings, aggregation thresholds. |
| Sanctions/AML exposure | Payments involve restricted actors or suspicious flows. | Compliance provider, region gating, transaction monitoring, freeze/escalation workflow. |
| Speculation drift | Product culture shifts toward token hype and financial status. | No TVL KPI, no token leaderboards, no price widgets, no tradable social points. |
| DAO-policy conflict | A room votes to permit unsafe or illegal behavior. | Platform policy supremacy, law-pack constraints, emergency freeze, appeals. |
| Operational overload | Financial support exceeds team capacity. | Pilot caps, support training, clear disabled states, weekly risk review. |

# 31. Best-practice checklist

## 31.1 Product best practices

- The app has no like, upvote, heart, reaction, public karma, public follower-rank, or applause-equivalent control.
- User-facing labels describe attention and participation without implying endorsement.
- Feed sections are finite and include stopping cues.
- Ranking explanations are understandable on mobile.
- Users can switch to less-personalized and non-profiled feed modes where required.
- Contribution types are structured enough to encourage evidence, clarification, correction, and synthesis.
- The product avoids infinite-scroll compulsion patterns where possible.
- Notifications are limited, quiet-hour aware, and explainable.
- The app does not require users to perform publicly for visibility.
- The product has a written doctrine for when attention should not increase distribution.

## 31.2 Mathematical and ranking best practices

- Every invariant has an owner, version, input schema, output schema, confidence score, and known failure modes.
- Invariant services run in shadow mode before affecting production ranking.
- Exact mathematical methods are used where feasible; approximations include stability tests and confidence intervals.
- PWA uses saturation curves and cannot be driven by raw dwell time alone.
- MERI prevents duplicate amplification but preserves independent corroboration.
- MFCI conditions on base activity rates and avoids punishing authentic active communities.
- GWEI uses privacy-preserving cohort thresholds and does not expose small groups.
- SCOI labels context fragmentation without treating disagreement as policy violation.
- PHI dampens harmful loops without suppressing legitimate sustained research.
- Ranking changes are feature-flagged, replay-tested, and monitored for regressions.

## 31.3 Mobile best practices

- Core flows are optimized for phones first and then adapted to web.
- Major actions are reachable with one hand or predictable bottom sheets.
- Offline drafts and saved reading are supported.
- In-app source reading preserves context and respects publisher constraints.
- Performance budgets are defined for cold start, feed render, thread open, composer open, and source reader open.
- Battery, data, and storage usage are measured and bounded.
- App state restoration works after interruption.
- Accessibility is tested on real devices with screen readers and dynamic type.
- Error states are readable, recoverable, and non-blaming.
- App review demo accounts and review notes are maintained.

## 31.4 Privacy best practices

- Data minimization is applied before collection, not after storage.
- Client-side aggregation reduces raw attention trace collection.
- Attention-derived signals are visible and controllable in settings.
- Retention tiers are documented and enforced by jobs.
- DSAR/export/deletion workflows are tested before public beta.
- Anti-abuse data is protected from unnecessary internal access.
- Research exports use aggregation thresholds and small-cell suppression.
- Minors receive privacy-protective defaults.
- Sensitive topics and sensitive inferences require privacy review.
- Privacy incidents have a documented response playbook.

## 31.5 Trust and safety best practices

- Users can report content and users from every relevant surface.
- Users can block and mute abusive users.
- The service publishes contact information and support channels.
- Moderation decisions have reason codes, audit logs, notices, and appeal paths.
- Emergency escalations are defined for credible threats, self-harm, child safety, and illegal content.
- Coordinated reporting cannot automatically suppress a target without integrity checks.
- Moderator tools use least privilege and record reviewer actions.
- Public labels are careful, specific, and appealable.
- Moderation quality is audited for consistency and bias.
- Transparency reports can be generated from structured logs.

## 31.6 Security best practices

- Mobile security aligns with OWASP MASVS and is tested before release.
- Backend security aligns with secure SDLC, threat modeling, and least privilege.
- Authentication supports passkeys or equivalent phishing-resistant methods where feasible.
- Tokens use secure storage, rotation, and replay protection.
- API authorization is object-level and action-level.
- Admin and moderation tools require strong authentication and audit trails.
- Dependencies are scanned and SBOMs are maintained.
- Secrets are centrally managed and never stored in mobile clients.
- Backups and restore drills are tested.
- Incident response is exercised before public beta.

## 31.7 AI governance best practices

- AI uses are inventoried, risk-assessed, and versioned.
- AI-generated summaries are grounded in visible sources and thread content.
- AI cannot make final high-impact moderation decisions without human review.
- AI outputs include uncertainty and correction paths.
- Model changes are evaluated before deployment.
- Prompt, source, and output logs are retained according to privacy rules.
- AI red-team tests cover hallucination, bias, manipulation, and policy evasion.
- Users can distinguish AI-generated or AI-assisted summaries from human contributions.
- AI-generated public-interest content receives stricter review.
- AI governance is aligned with risk-management practices rather than treated as only an engineering feature.

## 31.8 Operational best practices

- Every production feature has an owner, runbook, dashboard, alert, and rollback plan.
- Launches use staged rollout and feature flags.
- Product experiments include harm, fairness, privacy, and wellbeing guardrails.
- Support and moderation staffing is sized to expected launch volume.
- App-store policy changes are monitored continuously.
- Legal/regulatory changes are reviewed before jurisdiction expansion.
- Transparency reports are generated on a schedule.
- Incident postmortems produce tracked remediation items.
- Community feedback is reviewed without turning popularity into governance.
- External audit readiness is maintained through structured evidence.


## 31.9 Knomosis, crypto, and DAO best practices

- Knomosis integration is optional and disabled by default outside approved rooms, regions, and app-store builds.
- Crypto payments do not increase ranking, search placement, notifications, trends, or creator status.
- Users are never paid cryptocurrency for posting, commenting, inviting, or spending time in the app.
- Wallet connection is not required for ordinary reading, commenting, reporting, blocking, privacy controls, or appeals.
- The app never asks for seed phrases or private keys.
- All financial actions show plain-language transaction previews with asset, amount, recipient, chain, fee, reversibility, risk, and public visibility.
- Production contracts, chain IDs, law-pack hashes, and Knomosis commits are pinned and allowlisted.
- All production mainnet flows require external security review and legal/app-store approval.
- Room treasuries use caps, timelocks, audit logs, conflict disclosures, and challenge windows.
- DAO-like governance cannot override platform-wide safety, legality, privacy, accessibility, or app-store requirements.
- Sensitive social data and moderation data are never placed on-chain.
- Wallet data is treated as personal data where applicable and isolated from ranking/personalization.
- Financial compliance outcomes are not used for ads, feed ranking, or personalization.
- Metrics prioritize public value, safety, and comprehension, not TVL, token price, or wallet-connect growth.
- Every real-funds pilot has rollback, freeze, support, reconciliation, accounting, and incident-response coverage.

# 32. Open questions

1.  What is the minimum viable version of SCOI that performs well without over-relying on language models?
2.  How much attention aggregation can be performed entirely on device while preserving ranking utility?
3.  Should source profiles be editable by community stewards, professional staff, or both?
4.  What public transparency metrics are useful without exposing manipulation defenses?
5.  How should the product support verified expertise without becoming elitist?
6.  What forms of anonymity or pseudonymity best protect vulnerable speakers while limiting abuse?
7.  How should local rooms be launched to avoid empty or captured communities?
8.  What is the right balance between chronological and invariant-constrained ranking?
9.  How should revenue be structured to avoid pressure toward attention extraction?
10. Which invariant explanations should be public, and which should remain internal for abuse resistance?


## 32.1 Knomosis and crypto-governance open questions

1.  Which exact Knomosis commit, deployment manifest, chain IDs, and contract addresses will be production-pinned?
2.  Will Licio use a non-custodial, partner-custodial, or first-party custodial model?
3.  Which assets are allowed at MVP, and which are prohibited?
4.  Which jurisdictions and app-storefronts support each crypto/governance feature?
5.  What licensing, registration, or partner requirements apply to room treasury deposits, grants, and payouts?
6.  What tax documents and accounting exports are required for room treasuries, creators, grant recipients, and the platform?
7.  Which governance weight model is safest for pilot rooms?
8.  How should room fork/exit rights interact with treasury assets?
9.  What bridge/fault-proof/finality assumptions should be shown to users in transaction previews?
10. Which Knomosis law-pack features are mature enough for production, and which remain simulated?
11. What is the emergency freeze authority, and how is it constrained and audited?
12. How should disclosures differ between iOS, Android, web, and jurisdictions?
13. What is the maximum safe pilot treasury limit?
14. Which external auditors should review contracts, mobile flows, backend, and operations?
15. What public transparency report format should include crypto-enabled governance without exposing private users?

# 33. Appendix A: Invariant-to-product mapping

| Invariant      | Product question                                           | Product surface                                   | Primary owner                  |
|----------------|------------------------------------------------------------|---------------------------------------------------|--------------------------------|
| MERI           | Is this feed nonredundant?                                 | Feed, topic page, evidence drawer.                | Ranking + Invariants.          |
| MFCI           | Is this activity unusually coordinated after base rates?   | Integrity queue, trend controls, report handling. | Integrity.                     |
| GWEI           | Are cohorts receiving structurally comparable experiences? | Audit dashboard, transparency report.             | Responsible AI + Data Science. |
| SCOI           | Will this content collapse context across communities?     | Context cards, share flow, bridge prompts.        | Conversation + Ranking.        |
| PHI            | Is the recommender steering users through risky loops?     | Feed modes, user controls, ranking constraints.   | Ranking + Safety.              |
| Hodge tension  | Is disagreement local or structurally unresolved?          | Moderator queue, thread health labels.            | Conversation Health.           |
| Tropical rank  | Is cascade timing suspicious?                              | Integrity queue, trend dampening.                 | Integrity.                     |
| Braid dynamics | Is the agenda being churned or gamed?                      | Trend dashboard.                                  | Integrity + Editorial Ops.     |
| Reeb landscape | How are attention basins forming?                          | Civic Map, topic monitoring.                      | Discovery.                     |
| CID            | Is ranking stable under irrelevant transformations?        | Model audit.                                      | Responsible AI.                |
| Path signature | Is the mobile session constructive or compulsive?          | Wellbeing prompts, UX research.                   | Client + Data Science.         |

# 34. Appendix B: Example user journeys

## 34.1 Reader opens a breaking story

1.  User sees a story card labeled “Getting Attention.”
2.  The reason says: “Readers are opening the source and local room activity is rising.”
3.  User taps card and sees source preview.
4.  Context card says evidence is preliminary.
5.  User opens source, reads, and saves for later.
6.  The app counts bounded active attention, not endorsement.
7.  User receives no public badge or score.

## 34.2 User adds a correction

1.  User sees a thread repeating an incorrect date.
2.  User taps Contribute -\> Correction.
3.  Composer asks for target text and evidence.
4.  User cites the original document.
5.  Correction is accepted by a steward and linked to the claim.
6.  The thread summary updates.
7.  User’s private ledger says: “Your correction improved evidence status for this thread.”
8.  No likes are displayed.

## 34.3 Content crosses communities

1.  A joke from one room spreads to a political room.
2.  SCOI rises because local interpretations conflict.
3.  Feed card changes to “Needs Context.”
4.  Share sheet suggests including origin context.
5.  Bridge comments are invited.
6.  A user explains the original community meaning and limits.
7.  SCOI decreases and distribution resumes with context card attached.

## 34.4 Coordinated reporting attempt

1.  Many accounts report a journalist’s post within two minutes.
2.  MFCI finds target concentration extreme after conditioning on activity margins.
3.  The reports are queued but do not automatically suppress the post.
4.  Integrity review checks account patterns.
5.  Abusive reporters are limited; valid reports remain.
6.  The journalist receives protection if targeted harassment is detected.

## 34.5 Rabbit-hole dampening

1.  User reads several high-conflict health posts.
2.  PHI detects a loop from wellness to conspiratorial medical content and back.
3.  Ranking injects broader evidence-based context.
4.  User sees prompt: “Your recent feed is narrowing around this topic. See broader sources?”
5.  User can switch to Source-diverse mode or reset topic personalization.


## 34.6 User supports a Forum Commons treasury

1.  User reads a Forum Commons treasury explainer and sees current balance, spending caps, active proposals, and risk state.
2.  User opens contribution flow and sees: "This supports the commons. It does not rank any post, user, or viewpoint higher."
3.  User links an external wallet through a signed-message flow.
4.  User previews amount, asset, network, fees, recipient treasury, public-ledger disclosure, and finality warning.
5.  User signs in the wallet.
6.  Licio shows pending status until finality.
7.  Treasury dashboard updates after reconciliation.
8.  Ranking-neutrality audit confirms no feed boost occurred.

## 34.7 Forum Commons funds a source-archiving grant

1.  A governance participant drafts a proposal to fund retrieval and archiving of local public records.
2.  Proposal includes budget, recipient, conflict disclosure, deliverable, success criteria, and legal risk notes.
3.  The Room deliberates; evidence stewards add alternatives and cost comparisons.
4.  MFCI flags no suspicious coordination; legal review finds no prohibited payment category.
5.  Eligible participants vote after reading the mobile summary, objections, and execution payload.
6.  Proposal passes, enters timelock, and executes through a capped treasury disbursement.
7.  Recipient uploads the deliverable; stewards verify completion.
8.  Forum Commons page shows receipt, deliverable, and post-grant review.

## 34.8 Governance capture attempt is blocked

1.  A newly formed cluster of wallet-linked accounts joins a Room before a high-value treasury vote.
2.  MFCI flags synchronized joining, repeated co-voting, and shared target proposal behavior after conditioning on ordinary Room activity.
3.  Proposal vote enters review rather than automatic execution.
4.  Integrity analyst sees preserved-margin comparison, account-age distribution, and timing skeleton.
5.  The Assembly can extend deliberation, reduce cap, require additional eligibility checks, or cancel the proposal with notice.
6.  Affected users receive appeal or clarification paths where appropriate.
7.  Public transparency report describes the intervention in aggregate without exposing anti-abuse details.

# 35. Appendix C: Prioritized backlog and dependency map

## 35.1 Priority 0: must exist before any real-user alpha

1.  No-applause mobile UX shell.
2.  Account creation, authentication, settings, and basic privacy controls.
3.  Story submission and URL canonicalization.
4.  Thread reading and structured contribution composer.
5.  Report, block, mute, and support contact flows.
6.  Manual moderation console.
7.  Event schema and privacy classification.
8.  Local draft storage and basic offline behavior.
9.  Basic security controls and logging.
10. Accessibility design review and first-device tests.

## 35.2 Priority 1: must exist before closed alpha with invited communities

1.  PWA v0/v1 event aggregation.
2.  Signal Ledger v0.
3.  MERI v0/v1 duplicate grouping.
4.  Evidence cards and source metadata.
5.  Moderation reason codes and appeal skeleton.
6.  MFCI v0 shadow-mode synthetic tests.
7.  Crash/performance observability.
8.  Privacy export/delete prototype.
9.  Security threat-model review.
10. App-store UGC readiness checklist.

## 35.3 Priority 2: must exist before public beta

1.  PWA v1 production ranking with conservative weights.
2.  MERI v1 production dampening and explanations.
3.  MFCI shadow mode on live data plus coordinated-reporting protection.
4.  Context cards and evidence drawer v1.
5.  Trust-and-safety staffing, QA, and escalation.
6.  Accessibility audit and remediation.
7.  Security testing and incident drill.
8.  Public support, notices, and appeals.
9.  Transparency report generator.
10. Privacy retention jobs and deletion verification.

## 35.4 Priority 3: should exist during public beta

1.  MFCI v1 analyst-reviewed dampening.
2.  SCOI v0/v1 context obstruction workflow.
3.  GWEI v0/v1 cohort experience dashboard.
4.  PHI v0 loop detection and recommender reset.
5.  AI summarization with steward review.
6.  Enhanced moderation analytics.
7.  Experiment gates with harm and fairness metrics.
8.  Research export prototype with aggregation thresholds.
9.  Internationalization foundation.
10. More robust source and claim lineage.

## 35.5 Priority 4: post-GA maturity

1.  MERI v2 advanced independence modeling.
2.  MFCI v2 richer fiber sampling.
3.  GWEI v2 automated mitigation suggestions.
4.  SCOI v2 persistent obstruction classes.
5.  PHI v2 holonomy diagnostics.
6.  Public research API.
7.  External audits.
8.  Civic partner/steward program.
9.  Formal AI management-system controls.
10. Cross-platform web companion expansion.

## 35.6 Dependency map

- PWA depends on event schema, mobile instrumentation, privacy classification, and aggregation jobs.
- MERI depends on story canonicalization, source metadata, text/claim embeddings, and duplicate merge tools.
- MFCI depends on trustworthy event ingestion, action tables, margin definitions, and analyst review tooling.
- GWEI depends on ranking decision logs, cohort definitions, feed impression logs, and privacy thresholds.
- SCOI depends on lenses, context cards, local summaries, contribution taxonomy, and steward patch tools.
- PHI depends on session summaries, topic-state transitions, recommender logs, and user reset controls.
- Transparency reporting depends on moderation reason codes, ranking decision logs, incident logs, and aggregation jobs.
- App-store readiness depends on reporting, blocking, filtering, support contact, privacy labels, demo accounts, and policy documentation.
- Public beta depends on security testing, accessibility remediation, incident response, trust-and-safety staffing, and rollback mechanisms.


## 35.7 Knomosis backlog and dependency map

### Priority K0: before any wallet UX

1.  Pin Knomosis commit and license review.
2.  Threat model bridge, runtime, wallet, treasury, proposal, and indexer flows.
3.  Decide custody model.
4.  Create jurisdiction/app-store feature matrix.
5.  Draft risk disclosures and support taxonomy.
6.  Define pilot room readiness checklist.
7.  Define law-pack MVP template.
8.  Define no-pay-to-rank enforcement tests.

### Priority K1: before testnet pilot

1.  Wallet-link nonce/signature service.
2.  Mobile transaction preview renderer.
3.  Knomosis Gateway preflight and submission stubs.
4.  Testnet event indexer and reconciliation.
5.  Simulated governance tab.
6.  Testnet proposal lifecycle.
7.  Accessibility test for wallet/governance flows.
8.  Scam/link safety detection for wallet-drainer patterns.

### Priority K2: before capped real-funds pilot

1.  Legal approval by jurisdiction.
2.  App-store review/declaration package.
3.  External security audit.
4.  Compliance provider or partner integration if needed.
5.  Treasury caps, timelocks, and emergency freeze.
6.  Financial case-management workflow.
7.  Accounting and reconciliation export.
8.  Public risk disclosures.
9.  Bug bounty and incident response drill.
10. Pilot room charter approvals.

### Priority K3: post-pilot maturity

1.  Delegated governance.
2.  Law-pack migration.
3.  Fork/exit workflows.
4.  Expanded treasury reporting.
5.  External audit portal.
6.  Cross-room governance health dashboard.
7.  Privacy-preserving research export.
8.  Advanced MFCI governance-capture detection.

Knomosis dependencies:

- Wallet UX depends on mobile security, account identity, wallet-link service, and app-store policy review.
- Governance simulation depends on rooms, proposals, conversation linking, and steward roles.
- Testnet actions depend on Knomosis Gateway, deployment manifest, law-pack registry, and event indexer.
- Real funds depend on legal approval, app-store compliance, external audits, compliance controls, support staffing, incident response, and treasury accounting.
- Production expansion depends on pilot safety metrics, financial incident rate, no-pay-to-rank audits, and governance capture monitoring.

# 36. Appendix D: Reference standards and sources

The following sources should be reviewed by product, engineering, security, privacy, trust-and-safety, and legal teams during implementation. They are included as design baselines, not as legal advice.

## 36.1 Accessibility and mobile design

- W3C, **Web Content Accessibility Guidelines (WCAG) 2.2**: https://www.w3.org/TR/WCAG22/
- W3C/WAI, **WCAG overview and compatibility notes**: https://www.w3.org/WAI/standards-guidelines/wcag/
- W3C Mobile Accessibility Task Force, **Guidance on Applying WCAG 2.2 to Mobile Applications**: https://w3c.github.io/matf/
- Apple, **Human Interface Guidelines**: https://developer.apple.com/design/human-interface-guidelines/
- Google, **Material Design 3**: https://m3.material.io/
- ETSI/CEN/CENELEC, **EN 301 549 Accessibility requirements for ICT products and services**: https://www.etsi.org/standards

## 36.2 Mobile, application, and cybersecurity

- OWASP, **Mobile Application Security Verification Standard (MASVS)**: https://mas.owasp.org/MASVS/
- OWASP, **Mobile Application Security Testing Guide (MASTG)**: https://mas.owasp.org/MASTG/
- OWASP, **Mobile Application Security Weakness Enumeration (MASWE)**: https://mas.owasp.org/MASWE/
- OWASP, **Application Security Verification Standard (ASVS)**: https://owasp.org/www-project-application-security-verification-standard/
- NIST, **Cybersecurity Framework 2.0**: https://www.nist.gov/cyberframework
- NIST, **Secure Software Development Framework SP 800-218**: https://csrc.nist.gov/publications/detail/sp/800-218/final

## 36.3 Privacy and data protection

- NIST, **Privacy Framework**: https://www.nist.gov/privacy-framework
- European Commission, **Legal framework of EU data protection / GDPR**: https://commission.europa.eu/law/law-topic/data-protection/legal-framework-eu-data-protection_en
- EUR-Lex, **Regulation (EU) 2016/679 GDPR legal text**: https://eur-lex.europa.eu/eli/reg/2016/679/oj/eng
- FTC, **Children's Online Privacy Protection Rule (COPPA)**: https://www.ftc.gov/legal-library/browse/rules/childrens-online-privacy-protection-rule-coppa
- Federal Register, **2025 COPPA final rule amendments**: https://www.federalregister.gov/documents/2025/04/22/2025-05904/childrens-online-privacy-protection-rule
- California Attorney General, **California Consumer Privacy Act (CCPA)**: https://oag.ca.gov/privacy/ccpa
- California Privacy Protection Agency, **Regulations and rulemaking**: https://cppa.ca.gov/regulations/

## 36.4 Online platform accountability and app-store UGC

- European Commission, **Digital Services Act**: https://digital-strategy.ec.europa.eu/en/policies/digital-services-act
- Apple, **App Review Guidelines, Guideline 1.2 User-Generated Content**: https://developer.apple.com/app-store/review/guidelines/#user-generated-content
- Google Play, **User Generated Content policy**: https://support.google.com/googleplay/android-developer/answer/9876937
- Google Play, **Understanding moderation requirements for UGC apps**: https://support.google.com/googleplay/android-developer/answer/12923286

## 36.5 AI governance and recommender governance

- NIST, **AI Risk Management Framework**: https://www.nist.gov/itl/ai-risk-management-framework
- NIST, **Artificial Intelligence Risk Management Framework: Generative Artificial Intelligence Profile**: https://www.nist.gov/publications/artificial-intelligence-risk-management-framework-generative-artificial-intelligence
- ISO, **ISO/IEC 42001:2023 AI management systems**: https://www.iso.org/standard/42001
- European Commission, **EU AI Act overview**: https://digital-strategy.ec.europa.eu/en/policies/regulatory-framework-ai
- EUR-Lex, **Regulation (EU) 2024/1689 AI Act legal text**: https://eur-lex.europa.eu/eli/reg/2024/1689/oj

## 36.6 Mathematical and technical references to validate during R&D

- Matroid theory and submodular optimization for nonredundant selection.
- Algebraic statistics, contingency-table fibers, Markov bases, and conditional tests for coordination detection.
- Optimal transport and Gromov-Wasserstein distances for relational experience auditing.
- Applied sheaf theory and obstruction/cohomology methods for local-to-global context consistency.
- Gauge theory, holonomy, and path-dependent transport analogies for recommender path diagnostics.
- Discrete Hodge decomposition for conversational tension and cyclic disagreement.
- Tropical algebra for cascade timing and fastest-path coordination analysis.
- Reeb graphs and level-set topology for attention landscapes.
- Rough paths/path signatures for ordered mobile session behavior.


## 36.7 Knomosis, cryptocurrency, wallets, and DAO governance references

- Knomosis, **Repository root and README**: https://github.com/hatter6822/Knomosis/tree/main
- Knomosis, **Runtime README**: https://github.com/hatter6822/Knomosis/blob/main/runtime/README.md
- Knomosis, **Solidity README**: https://github.com/hatter6822/Knomosis/blob/main/solidity/README.md
- Knomosis, **Genesis Plan**: https://github.com/hatter6822/Knomosis/blob/main/docs/GENESIS_PLAN.md
- Apple, **App Review Guidelines - User-Generated Content, Payments, and Cryptocurrencies**: https://developer.apple.com/app-store/review/guidelines/
- Google Play, **User Generated Content policy**: https://support.google.com/googleplay/android-developer/answer/9876937
- Google Play, **Blockchain-based Content policy**: https://support.google.com/googleplay/android-developer/answer/13607354
- Google Play, **Financial Services policy**: https://support.google.com/googleplay/android-developer/answer/9876821
- FinCEN, **Application of FinCEN's Regulations to Certain Business Models Involving Convertible Virtual Currencies**: https://www.fincen.gov/resources/statutes-regulations/guidance/application-fincens-regulations-certain-business-models
- FATF, **Updated Guidance for a Risk-Based Approach to Virtual Assets and VASPs**: https://www.fatf-gafi.org/en/publications/Fatfrecommendations/Guidance-rba-virtual-assets-2021.html
- European Commission, **Crypto-assets and MiCA overview**: https://finance.ec.europa.eu/digital-finance/crypto-assets_en
- Ethereum Improvement Proposals, **EIP-712 Typed structured data hashing and signing**: https://eips.ethereum.org/EIPS/eip-712
- Ethereum Improvement Proposals, **EIP-1271 Standard Signature Validation Method for Contracts**: https://eips.ethereum.org/EIPS/eip-1271
- Ethereum Improvement Proposals, **EIP-4361 Sign-In with Ethereum**: https://eips.ethereum.org/EIPS/eip-4361
- Ethereum Improvement Proposals, **EIP-4337 Account Abstraction**: https://eips.ethereum.org/EIPS/eip-4337


## 36.8 v0.4 source-review notes

- Knomosis repository source review date: June 7, 2026.
- The reviewed README describes Knomosis as a Lean 4 proof-carrying state-transition kernel with Solidity and Rust mirrors, a small trusted core, fixture-based cross-stack determinism discipline, and audit gates.
- The reviewed README lists version v0.4.11 and Lean toolchain v4.29.1. Licio must pin a specific commit before implementation because branch state can change.
- OWASP MASVS is the mobile security baseline; OWASP SCSVS/SCSTG and Smart Contract Top 10 are the smart-contract security baselines.
- NIST CSF 2.0, NIST Privacy Framework, NIST AI RMF 1.0, and NIST Generative AI Profile are governance baselines.
- WCAG 2.2 and W3C mobile accessibility guidance are accessibility baselines.
- Apple App Review Guideline 1.2 and Google Play UGC policy are UGC baselines; Apple App Review Guideline 3.1.5 and Google Play Blockchain-based Content/Financial Services policies are crypto/app-store baselines.
- GDPR, DSA, EU AI Act, COPPA/FTC guidance, FATF virtual-asset guidance, and jurisdiction-specific financial-services rules require legal review before launch; this specification is not legal advice.

## 36.9 Legal and policy note

This document is a product and technical specification. It is not legal advice, does not guarantee compliance with any jurisdiction or app store, and should be reviewed by qualified counsel and subject-matter experts before production launch. The legal and standards landscape for social media, minors, AI, app stores, privacy, accessibility, and platform accountability changes frequently; the team should refresh this appendix at every major release gate.


# 37. Appendix E: Final best-practice verification matrix

## 37.1 Product and incentive integrity

- No likes, traditional upvotes, reaction counters, public karma, follower-count ranking, donor badges, token leaderboards, or pay-to-rank mechanics.
- Participation signals measure attention and contribution depth; they do not claim approval or truth.
- Low-quality high-volume participation is capped or dampened.
- Ranking explanations are user-readable and avoid manipulative certainty.
- Anti-metrics explicitly block optimization toward outrage, compulsive use, speculation, or vanity status.

## 37.2 Mobile-first quality

- Native iOS and Android are primary surfaces.
- Key actions fit one-handed use but irreversible actions require deliberate friction.
- Offline states, bad-network states, and feature-disabled states are designed, not accidental.
- Wallet, governance, and reporting flows are accessible from small screens without hiding material information.
- Performance, battery, crash, and accessibility budgets are release gates.

## 37.3 Accessibility and inclusive design

- WCAG 2.2 and mobile accessibility guidance inform contrast, font scaling, screen reader labels, focus order, reduced motion, captions, target sizes, and error recovery.
- AI summaries and governance proposals have plain-language views without removing access to source detail.
- Color is never the only indicator of safety, rank, status, or transaction outcome.
- Transaction previews and governance decisions remain readable with large text and assistive technology.

## 37.4 Privacy and data protection

- Data minimization, purpose limitation, retention, export, deletion, and access controls are built into the architecture.
- Attention data is aggregated and protected from unnecessary staff exposure.
- Wallet identity is separated from social identity.
- Sensitive social data, moderation cases, private messages, minors' data, and inferred interests are not placed on-chain.
- Staff tools are role-scoped and audit logged.

## 37.5 Trust, safety, and UGC governance

- Public UGC has report, block, moderation, appeal, and contact mechanisms.
- Global platform policy overrides local room governance for safety, legality, privacy, minors, accessibility, app-store, and security reasons.
- Moderation actions have reason codes, notices, and appeal paths where appropriate.
- Coordinated abuse is evaluated conditionally through MFCI and reviewed by humans for material interventions.
- Crypto-specific abuse such as wallet drainers, fake airdrops, bounty laundering, and governance capture has dedicated playbooks.

## 37.6 Security and secure development

- OWASP MASVS guides mobile security; OWASP SCSVS/SCSTG and smart-contract attack catalogs guide contract-facing work.
- Secure SDLC includes threat modeling, code review, dependency scanning, secret scanning, SAST, DAST, mobile testing, infrastructure testing, and external audits.
- Wallet signing uses readable, typed, domain-separated prompts where possible.
- The app never requests seed phrases, private keys, or opaque signatures.
- Production dependencies, contracts, chain IDs, assets, law packs, and Knomosis commits are pinned and allowlisted.

## 37.7 AI governance

- AI is used for assistive summarization, triage, clustering, and context support, not autonomous irreversible enforcement.
- AI outputs preserve provenance and can be reported or corrected.
- Model changes are evaluated for hallucination, bias, privacy leakage, safety, and governance neutrality.
- Governance proposal summaries include authority, risks, alternatives, and treasury impact.
- AI systems cannot approve funds, execute proposals, or issue final sanctions without defined human/rule-based control.

## 37.8 Financial, crypto, and DAO-like governance

- Knomosis is optional and feature-flagged by jurisdiction, room, app version, and compliance status.
- No payment, token, treasury action, wallet connection, governance vote, or donor status can buy or influence ranking.
- Crypto is not awarded for posting, commenting, inviting, reporting, reading, or spending attention.
- Non-custodial, no-exchange, no-yield, no-lending, no-gambling, no-investment-marketing is the MVP posture.
- Real-funds pilots require legal/compliance approval, app-store readiness, external security review, caps, timelocks, reconciliation, accounting exports, and incident drills.
- Forum commons govern local budgets and rules only within global platform constraints.

## 37.9 Operations and transparency

- Every high-risk feature has a named owner, dashboards, alerts, runbooks, and rollback path.
- Transparency reports can be generated from logged moderation, ranking, AI, and governance events.
- Incident response distinguishes content, account, ranking, AI, wallet, treasury, and infrastructure incidents.
- Launch reviews are cross-functional and evidence-based.
- Unsafe rooms, law packs, or payment features can be restricted, archived, or disabled without corrupting the core social product.

## 37.10 Final reviewer checklist

Before any production launch, reviewers should confirm:

1. The user can use the social news product without a wallet.
2. The platform can prove payments are excluded from ranking.
3. The platform can moderate harmful UGC regardless of local governance votes.
4. The platform can explain ranking and invariant decisions.
5. The platform can reconcile every financial action.
6. The platform can disable crypto by region/build/room/account state.
7. The platform can satisfy app-store UGC and blockchain/financial declarations.
8. The platform can support accessibility, privacy, data rights, security, and incident response.
9. The platform can avoid optimizing for speculation, outrage, or vanity engagement.
10. The platform can publish transparency reports that users, auditors, and stewards can understand.


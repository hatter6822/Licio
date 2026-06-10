# Licio v0.6: A Progressive-Web-App Social News, Knomosis L2 Payments, and DAO-Like Forum Governance Platform

**Document status:** v0.6 — PWA-only delivery, consolidated and optimized end-to-end rewrite
**Prepared date:** June 7, 2026
**Revision date:** June 7, 2026
**Working product name:** Licio
**Primary platform:** A mobile-first **Progressive Web App (PWA)** served over HTTPS and installable to the home screen on iOS, Android, and desktop. Licio ships **no native app-store binaries**. Because a web app is not "distributed" through Apple App Review or Google Play, this delivery model resolves both the GPL-3.0/App-Store license conflict and the app-store crypto-policy restrictions identified in earlier revisions.
**Core premise:** There are no traditional user-cast upvotes, likes, heart buttons, karma counts, follower-count leaderboards, or popularity badges. Public visibility is derived from privacy-preserving measures of active attention, participation depth, conversation quality, nonredundant exposure, cross-context coherence, anti-coordination checks, and recommender-safety constraints. Knomosis L2 is an optional, compliance-gated payment and forum-governance substrate; cryptocurrency, wallets, treasuries, DAO-like votes, and payments never buy visibility, status, notifications, search placement, or recommendation advantage.

## Note on two abbreviations

This revision reserves **PWA** for **Progressive Web App** (the delivery platform). The core rating primitive, previously abbreviated "PWA," is renamed **Participation-Weighted Attention (PWAtt)** to remove the collision. Wherever older material said "PWA scoring/ranking," read **PWAtt**.

## Table of contents

- **0.** Revision history, audit verdict, and launch constraints
- **1.** Executive summary
- **2.** Product north star
- **3.** Platform concept
- **4.** User personas and core jobs
- **5.** Rating model: Participation-Weighted Attention (PWAtt)
- **6.** Progressive Web App: requirements and client architecture
- **7.** Core invariant 1: Matroid Exposure Rank Invariant (MERI)
- **8.** Core invariant 2: Markov-Fiber Coordination Invariant (MFCI)
- **9.** Core invariant 3: Gromov-Wasserstein Experience Isometry (GWEI)
- **10.** Core invariant 4: Sheaf Context Obstruction Invariant (SCOI)
- **11.** Core invariant 5: Preference Holonomy Invariant (PHI)
- **12.** Supporting invariant services
- **13.** Ranking and distribution system
- **14.** Social news aggregation model
- **15.** Forum and conversation design
- **16.** Community, rooms, lenses, and governance
- **17.** Knomosis L2 payments and DAO-like forum governance
- **18.** Trust, safety, and moderation
- **19.** Privacy and data protection
- **20.** Distribution, delivery, and update architecture
- **21.** Backend architecture
- **22.** Data model
- **23.** API specification
- **24.** AI and machine learning specification
- **25.** Security specification
- **26.** Accessibility and inclusive design
- **27.** Monetization and incentives
- **28.** Metrics and experimentation
- **29.** Operational workflows
- **30.** Implementation plan
- **31.** Risks and mitigations
- **32.** Best-practice and launch-readiness checklist
- **33.** Open questions
- **34.** Appendix A: Invariant-to-product mapping
- **35.** Appendix B: Example user journeys
- **36.** Appendix C: Prioritized backlog and dependency map
- **37.** Appendix D: Reference standards and sources

## Document purpose and standards baselines

This specification describes a social news aggregation, content-rating, and forum-discussion platform that turns a set of mathematical invariants into concrete product mechanisms, algorithms, web interfaces, data structures, governance practices, and implementation milestones. The most visible content should not be the most liked, most enraging, most gamed, or most amplified by bots; content rises when people spend meaningful attention on it, participate in conversation, add evidence, improve context, and create nonredundant public value.

The design treats the following as baselines, not ceilings: WCAG 2.2 for accessibility; OWASP ASVS for web-application security and OWASP MASVS-style discipline for the installed PWA surface; OWASP smart-contract security resources for contract-facing work; Core Web Vitals for performance; NIST CSF 2.0, the NIST Privacy Framework, NIST AI RMF 1.0, and the NIST Generative AI Profile for governance; ISO/IEC 42001 for AI-management discipline; the EU Digital Services Act for platform transparency; GDPR-style privacy principles; the EU AI Act for AI transparency and risk; the FTC COPPA rule for US child privacy; CCPA/CPRA for US privacy rights; EIP-712/EIP-1271/EIP-4361/EIP-6963/EIP-4337 for wallet interaction; and FinCEN, FATF, and EU MiCA materials for crypto-asset risk. Each launch jurisdiction requires separate legal, content-policy, privacy-impact, and financial-services review. This document is a product and technical specification, not legal advice.

# 0. Revision history, audit verdict, and launch constraints

## 0.1 What Licio is

Licio is a mobile-first Progressive Web App for social news and forum discussion built around a single rating primitive: **Participation-Weighted Attention (PWAtt)**. Users cannot like or upvote. Visibility is derived from active reading, source inspection, returning to a thread, substantive replies, added evidence, clarifying questions, useful summaries, and resolved cross-community confusion — always interpreted through participation, context, independence, fairness, and safety constraints, never treated as raw endorsement.

## 0.2 Revision history

| Version | Change |
|---|---|
| v0.1 | Original concept: no-like/no-upvote social news; five mathematical invariants; mobile framing. |
| v0.2 | Optimization: terminology corrected, raw attention capped, invariants treated as confidence-bearing services, automated restrictions separated from human sanctions, implementation decomposed. |
| v0.3 | Added the Knomosis L2 payment and DAO-like governance substrate as an optional, compliance-gated layer that never buys visibility. |
| v0.4 | End-to-end optimization; smaller work packages, parallel tracks, stronger no-pay-to-rank controls, Knomosis due-diligence path, treasury model, wallet UX, release gates. |
| v0.4.1 | Deep audit: corrected the mathematics of MERI, MFCI, GWEI, SCOI, and PHI; operationalized EIP-1271; flagged the GPL-3.0/App-Store conflict; fixed internal inconsistencies. |
| v0.5 | Independent multi-channel distribution (PWA + F-Droid + sideloading) to escape app-store gatekeeping. |
| **v0.6** | **PWA-only delivery** (native binaries dropped), which fully resolves the license and crypto app-store blockers; the document is consolidated and optimized end-to-end; the rating primitive is renamed **PWAtt** to free "PWA" for Progressive Web App. |

## 0.3 Audit verdict and corrections carried forward

The product concept, the invariants-as-audit-services architecture, the no-pay-to-rank boundaries, and the staged Knomosis rollout are sound. The v0.4.1 mathematical corrections are now stated canonically in Sections 7–11 (no separate correction log is needed):

- **MERI** is modeled as a genuine matroid (partition/transversal), so rank is well-defined and greedy is exact; the general similarity-graph view is acknowledged as the NP-hard maximum-independent-set problem and used only as a reported approximation.
- **MFCI** samples the conditional (log-linear / generalized-hypergeometric) distribution on the fiber given fixed margins via Metropolis–Hastings over a Markov basis, and reports `MFCI = −log p̂` with the add-one p-value estimator so the score is always finite.
- **GWEI** uses normalized probability measures, the order-2 Gromov–Wasserstein distance, and the property `GW = 0` iff measure-preserving isometry.
- **SCOI** scores the normalized Dirichlet energy of local interpretations under the sheaf Laplacian (distance from globally consistent sections); a genuine cohomological obstruction (nontrivial `H1`) is reserved for the structural SCOI v2.
- **PHI** models transport as invertible, metric-preserving (orthogonal) maps so the loop holonomy `H(γ)` lies in `O(n)` and `log(H)` is well-defined, and uses a gauge-invariant norm.
- **PWAtt** normalizes its positive-value weights to sum to 100% per ranking profile; penalties are separate nonnegative terms.

Security and licensing carried forward: wallet signatures are verified over both ECDSA `ecrecover` (externally owned accounts) and EIP-1271 `isValidSignature` (contract wallets/multisigs); the network-served code is **AGPL-3.0-or-later** (Knomosis-compatible).

## 0.4 The PWA-only decision

Earlier revisions assumed native iOS/Android distribution and built elaborate machinery to satisfy Apple App Review and Google Play. Two blockers made that path untenable: (1) the GPL-3.0 license is incompatible with Apple App Store distribution terms, and (2) wallet/treasury/DAO features collide with Apple Guideline 3.1.5 and Google Play's Financial Services / Blockchain-based Content policies. v0.6 resolves both by delivering Licio as a **PWA served over the web**:

1. A web app is not submitted to or reviewed by an app store, so there is no app-store license conflict and no app-store crypto-policy chokepoint.
2. Distribution is continuous deployment to Licio's own servers; "install" is the browser's add-to-home-screen, and "update" is a normal deploy.
3. The platform reaches iOS, Android, and desktop from one codebase.
4. The honest trade-offs (iOS web-storage eviction, constrained background execution, push only for installed web apps on iOS 16.4+) are designed around explicitly in Section 6.
5. Native binaries, app stores, F-Droid, sideloading, and notarization are **out of scope**; the only delivery surface is the PWA.

## 0.5 Non-negotiable launch constraints

Licio must not launch publicly until all of the following hold:

1. Users can participate meaningfully without any like, upvote, reaction, or public karma mechanism.
2. Reporting, blocking, muting, and published support contact are live in the PWA.
3. PWAtt is explainable and bounded; raw dwell time cannot independently create high distribution.
4. MERI v1 prevents obvious duplicate amplification; MFCI runs at least in shadow mode for brigading and coordinated reporting.
5. Trust-and-safety queues, reviewer tooling, audit logs, and appeals are operational.
6. Privacy controls cover attention-derived signals, personalization, export, deletion, and recommender reset.
7. Accessibility testing covers screen readers, dynamic type/zoom, reduced motion, keyboard/switch access, color contrast, focus order, and target size, against WCAG 2.2 AA.
8. Web security review covers authentication, session and token handling, transport security, XSS/Trusted Types/CSP, API authorization, secret management, and abuse endpoints.
9. The team can generate a transparency report from real logs without manual reconstruction.
10. Crypto features are disabled by default and fail closed; the core social product works with no wallet.

The following constraints supersede all lower-level choices: ranking is never controlled by money, wallet connection, token holdings, treasury contributions, DAO votes, proposal outcomes, creator payments, paid memberships, or public financial status; mathematical invariants are audit services and safety constraints, not opaque automatic punishment; Knomosis is a bounded payment/governance substrate, not a social or reputation graph; safety, privacy, accessibility, and abuse controls are first-order requirements; no irreversible real-funds action launches before simulation, testnet, external review, incident drills, and support readiness; sub-forum governance cannot opt out of global legality, safety, child protection, privacy, accessibility, or ranking-integrity constraints; and sensitive behavior stays off-chain.

## 0.6 Definition of done for the specification

The specification is execution-ready when the team can answer yes to each: Can a user understand why a story is visible without likes, upvotes, karma, follower counts, token balances, or donor badges? Can the backend prove payment events are excluded from ranking and recommendation features? Can moderators intervene in a harmful forum even if its local governance votes otherwise? Can a user join, read, contribute, report, block, appeal, and leave without a wallet? Can every real-funds action be reconciled from product intent through Knomosis receipt to accounting export? Can every launch gate fail closed without breaking the non-crypto experience? Can reviewers inspect logs, decisions, and model/ranking inputs without reconstructing state by hand? Can the platform explain every AI summary, invariant gate, ranking dampener, payment hold, moderation action, and governance denial in user-readable form?

# 1. Executive summary

Licio is a Progressive Web App for social news and forum discussion built around **Participation-Weighted Attention (PWAtt)**. There is no like button and no upvote button. Item visibility is computed from signals such as active reading, source opening, returning to a thread, writing a substantive reply, adding evidence, asking a clarifying question, producing a useful summary, or resolving confusion between communities.

The central insight is that **attention is not endorsement**. A story that attracts attention may be important, manipulative, tragic, confusing, entertaining, or polarizing. Attention becomes rankable only when interpreted through participation, context, independence, fairness, and safety constraints.

The platform has five core invariant services:

1. **Matroid Exposure Rank Invariant (MERI):** how much of a feed, topic page, or discussion is genuinely nonredundant; prevents ten near-identical posts from counting as ten independent signals.
2. **Markov-Fiber Coordination Invariant (MFCI):** detects coordinated activity after conditioning on normal base rates (time, topic popularity, community activity).
3. **Gromov-Wasserstein Experience Isometry (GWEI):** audits whether cohorts receive structurally comparable experiences without requiring identical content.
4. **Sheaf Context Obstruction Invariant (SCOI):** measures when local community interpretations of the same content cannot be coherently glued into a shared understanding.
5. **Preference Holonomy Invariant (PHI):** detects path-dependent steering of a user's latent interests, especially rabbit-hole loops.

Supporting invariants cover conversational tension, cascade timing, trend turbulence, attention landscapes, counterfactual recommender defects, and session wellbeing.

Licio is a hybrid of social news, public forum, and civic sensemaking tool: links, original posts, evidence cards, claims, live discussion threads, topic rooms, and curated community lenses. It avoids applause mechanics and rewards contributions that make the shared information environment more intelligible. The optional **Knomosis** plane adds verifiable, compliance-gated payments and room treasuries with DAO-like governance, used for accountability — not as an applause counter. A user's civic rights never depend on crypto holdings.

# 2. Product north star

## 2.1 North-star statement

Licio helps people discover, understand, and discuss important public information by ranking content according to meaningful attention and constructive participation rather than popularity gestures.

## 2.2 Primary product goals

1. **Replace popularity voting with participation-weighted attention.** Visibility emerges from active reading, evidence exploration, and contribution quality.
2. **Make social news less redundant.** Surface independent sources, distinct arguments, and useful perspectives instead of repeating the same item.
3. **Prevent engagement traps.** Rage, compulsion, and repetitive conflict do not automatically increase ranking.
4. **Make context visible.** Users see why a story means different things to different communities before joining the discussion.
5. **Support deep participation on a phone.** Reading, annotating, asking, citing, summarizing, and participating must feel native to mobile, not like a desktop forum squeezed onto a small screen.
6. **Audit ranking fairness structurally.** Fairness is structurally comparable experience across cohorts, not equal exposure counts.
7. **Detect manipulation without punishing authentic enthusiasm.** Coordination detection conditions on normal activity patterns.
8. **Support better public conversation.** Reward clarification, evidence, synthesis, and disagreement that improves the state of the thread.

## 2.3 Non-goals

Licio is not a real-time popularity contest, an influencer platform built on follower accumulation, a private messaging product (limited moderator/user communication aside), a short-video entertainment app, an anonymous random-chat app, an ad-targeting system optimized for dwell time, or a replacement for professional journalism. It is an aggregation, discussion, and sensemaking layer.

## 2.4 Product principles

| Principle | Requirement |
|---|---|
| No applause primitives | No likes, upvotes, hearts, public karma, public follower counts, or reaction badges may affect ranking. |
| Attention is not endorsement | Attention is interpreted alongside participation quality, context, and safety constraints. |
| Conversation creates value | Evidence, clarification, synthesis, correction, and respectful challenge are first-class contributions. |
| Nonredundancy matters | A feed with ten duplicated claims should not outrank three independent, useful sources. |
| Context travels with content | Content crossing communities carries origin, audience, interpretation, and disagreement context. |
| Mobile is primary | Every major workflow is usable one-handed, offline-tolerant where possible, and accessible to assistive technology. |
| Auditability is a feature | Ranking, moderation, and AI systems expose meaningful explanations and internal audit logs. |
| Privacy by design | Sensitive attention signals are minimized, aggregated, protected, and user-controllable. |
| Open by default | The platform is open-source (AGPL-3.0 for the served app), delivered without a gatekeeper. |

# 3. Platform concept

## 3.1 Product metaphor

Licio is a **loom** for public knowledge. Sources, posts, claims, comments, summaries, and communities are threads. The product does not ask users to cheer for content; it asks them to help weave a more coherent public fabric.

## 3.2 Core user-facing surfaces

1. **Front Page:** a personalized but constrained feed of important stories and discussions.
2. **Topic Rooms:** persistent spaces around topics such as climate, local politics, science, technology, health, or city-level news.
3. **Threads:** structured discussion spaces attached to a story, claim, or question.
4. **Context Cards:** compact overlays explaining source history, community interpretations, claim status, timeline, and missing context.
5. **Evidence Drawer:** a swipe-up panel of cited sources, primary documents, fact checks, data references, and counterevidence.
6. **Participation Composer:** a structured composer that asks what kind of contribution the user is making.
7. **Signal Ledger:** a private, user-facing explanation of what attention and participation signals were counted — never a public score.
8. **Civic Map:** a visual overview of topic basins, narrative branches, and cross-community bridges.
9. **Steward Console:** moderator and community-steward tooling for queue review, context repair, appeals, and safety decisions.
10. **Governance & Treasury (optional):** the Knomosis surface for charters, proposals, treasuries, and receipts in enabled rooms.

## 3.3 Core objects

| Object | Description |
|---|---|
| Story | A submitted link or original item that anchors discussion. |
| Source | The external publisher, author, dataset, document, or media origin. |
| Claim | A discrete proposition extracted from a story or comment. |
| Evidence Card | A citation, data point, document, image, transcript, or expert reference supporting or challenging a claim. |
| Thread | A structured conversation space attached to a story, claim, or topic. |
| Contribution | A value-adding user action: question, evidence, correction, synthesis, summary, counterexample, moderation flag, etc. |
| Lens | A community-specific interpretation frame: local resident, domain expert, affected group, skeptic, beginner. |
| Context Patch | A reusable piece of explanation that reduces context obstruction. |
| Attention Receipt | A private, aggregated record of meaningful attention counted for the user. |
| Invariant Run | A computation of one or more invariants over a time window, feed, thread, cohort, or topic. |

# 4. User personas and core jobs

## 4.1 Personas

- **The careful reader** wants to understand a story before forming an opinion: opens sources, reads context cards, asks clarifying questions, values summaries.
- **The knowledgeable participant** has expertise or direct experience: adds evidence, corrects misconceptions, explains uncertainty and tradeoffs.
- **The local witness** has situational knowledge about a local issue and wants to contribute context without becoming an influencer.
- **The moderator/steward** maintains healthy norms, reviews reports, resolves context collisions, escalates safety concerns.
- **The casual scanner** has a few minutes on a phone and wants an accurate, digestible view without infinite scrolling.
- **The researcher/auditor** studies platform health, fairness, manipulation, and information quality using aggregate transparency data.

## 4.2 User jobs

Discover what matters today without popularity counts; understand why a story is receiving attention; find the strongest evidence and counterpoints quickly; participate without performing for likes; see whether a discussion is coherent, fragmented, manipulated, or unresolved; build reputation for useful contributions without chasing virality; avoid being steered into compulsive or extreme loops; and control privacy around attention-derived signals.

# 5. Rating model: Participation-Weighted Attention (PWAtt)

## 5.1 Design mandate

There is no like button, upvote button, heart, reaction emoji, public karma, or visible follower-count leaderboard. Content receives a derived distribution score from **Participation-Weighted Attention (PWAtt)**, which estimates the degree to which a story or thread deserves distribution because people gave it meaningful attention and/or made the conversation deeper, clearer, more evidenced, or more useful.

## 5.2 Why attention alone is insufficient

Attention can come from quality, outrage, confusion, fear, novelty, coordination, deception, or harassment. Attention is therefore a **salience signal** that must pass filters: Was it active rather than accidental? Did the user inspect the source or only react to a headline? Did participation improve the thread state? Is attention nonredundant across independent users and communities? Is the activity coordinated beyond normal base rates? Does cross-community sharing create context collapse? Does recommendation create path-dependent steering risk?

## 5.3 Signal categories

### Attention signals (raw time is never sufficient)

| Signal | Positive interpretation | Required guardrail |
|---|---|---|
| Active dwell | Reading with foreground focus and normal scroll cadence. | Cap per item; ignore idle time and screen-on inactivity. |
| Source open | Opening the original article, document, dataset, or evidence. | Do not reward clickbait if the user immediately returns. |
| Context open | Opening context cards, source history, or claim timeline. | Count once per meaningful session. |
| Return visit | Returning after time away, indicating sustained interest. | Avoid rewarding obsessive loops. |
| Thread traversal | Reading multiple branches or opposing views. | Weight nonredundant traversal above repeated same-branch reading. |
| Save for later | Privately marking content to revisit. | Private by default; low rank weight. |
| Share outside app | Sending a link externally. | Low rank weight until recipient attention or participation occurs. |

### Participation signals (public actions that can improve the environment)

| Contribution type | Examples | Ranking effect |
|---|---|---|
| Clarifying question | "What evidence supports the employment claim?" | Positive if it elicits useful answers or identifies ambiguity. |
| Evidence addition | Adds primary source, dataset, transcript, legal text, credible report. | Strong positive if cited and relevant. |
| Correction | Identifies false quote, wrong date, missing caveat, broken link. | Strong positive when accepted or corroborated. |
| Synthesis | Summarizes multiple branches fairly. | Positive when it reduces context obstruction or repetition. |
| Counterexample | Adds a relevant exception or opposing case. | Positive when it broadens the evidence base. |
| Domain explanation | Explains technical, legal, scientific, or local context. | Positive if nonredundant and useful to readers. |
| Bridge comment | Translates one community's interpretation for another. | Strong positive when SCOI decreases. |
| Steward action | Moderation clarification, rule reminder, merge suggestion. | Positive for thread health, not personal fame. |

### Anti-signals

| Anti-signal | Response |
|---|---|
| Rapid repetitive commenting | Damp participation weight; possible rate limit. |
| Coordinated bursts | Apply MFCI penalty and review threshold. |
| Rage-loop behavior | Do not convert repeated hostile returns into positive attention. |
| Low-information replies | Count as conversation volume but not constructive participation. |
| Source-free accusation | Requires evidence or is downweighted. |
| Brigading reports | Report impact conditioned by MFCI and reporter reputation. |
| Harassment cascade | Freeze ranking growth, apply safety review, protect targets. |

## 5.4 PWAtt scoring formula

For item `i` in context `c` during time window `t`:

    PWAtt_i,c,t = B_i,t
                + wA * ActiveAttention_i,c,t
                + wP * ConstructiveParticipation_i,c,t
                + wE * ExposureIndependence_i,c,t
                + wS * SourceAndEvidenceCompleteness_i,c,t
                + wC * ContextCoherenceGain_i,c,t
                - pM * CoordinationPenalty_i,c,t
                - pH * HolonomyRisk_i,c,t
                - pT * HarmfulTensionRisk_i,c,t
                - pR * RedundancyPenalty_i,c,t

Where `B_i,t` is a time-sensitive baseline (freshness, source-reliability state, topic relevance); `ActiveAttention` is bounded, privacy-preserving, and deduplicated; `ConstructiveParticipation` measures contribution quality and downstream thread improvements; `ExposureIndependence` is derived from MERI; `ContextCoherenceGain` is derived partly from SCOI reduction; `CoordinationPenalty` is derived from MFCI and tropical cascade signals; `HolonomyRisk` from PHI; `HarmfulTensionRisk` from Hodge tension combined with safety classifiers; and `RedundancyPenalty` prevents repeated copies from accumulating distribution power.

The product exposes only a simplified explanation, such as: "Rising because many readers opened the source, three independent evidence cards were added, and the thread has low coordination risk."

## 5.5 Weighting philosophy

| Component | Initial range | Rationale |
|---|---|---|
| Active attention (`wA`) | 20–30% | Salience matters, but attention alone must not dominate. |
| Constructive participation (`wP`) | 25–40% | The platform exists to reward depth and contribution. |
| Exposure independence (`wE`) | 10–20% | Prevents duplicate amplification. |
| Evidence/source completeness (`wS`) | 5–15% | Encourages substantiation. |
| Context coherence gain (`wC`) | 5–15% | Rewards bridge work and clear framing. |
| Safety/manipulation penalties | Variable | Penalties can dominate when risk is high. |

The five positive-value weights (`wA, wP, wE, wS, wC`) are **normalized to sum to 100%** per ranking profile; the ranges are per-component guardrails, and a deployed profile must choose shares within those ranges that sum to 100% (jointly satisfiable, e.g. 30/40/15/10/5). The penalties (`pM, pH, pT, pR`) are **not** part of this convex combination: they are separate nonnegative coefficients on the risk terms, so a high-risk item's penalties can drive its score below any positive contribution. The baseline `B_i,t` is on the same scale as the normalized positive score. Weights are not one global constant; they vary by surface, topic sensitivity, freshness, age group, jurisdiction, and risk state. Breaking disaster news emphasizes timeliness and verified source context; evergreen science discussion emphasizes evidence, synthesis, and nonredundancy.

## 5.6 User-facing rating labels

Because there are no likes or upvotes, the app uses descriptive labels, none of which imply a majority "likes" or "agrees" with the content:

| Label | Meaning |
|---|---|
| Getting Attention | Active, non-idle reading is increasing. |
| Deepening | Users are adding evidence, questions, corrections, or summaries. |
| Well-Sourced | The thread contains independent evidence cards and primary sources. |
| Needs Context | Interpretations differ or key context is missing. |
| Under Review | Coordination, safety, or policy signals require review. |
| Resolved Context | A previously ambiguous issue has a high-quality synthesis. |
| Bridge Active | Multiple communities are engaging with improving coherence. |

# 6. Progressive Web App: requirements and client architecture

## 6.1 PWA-first design philosophy

Licio is a single Progressive Web App, designed for phones first and adapted upward to tablets and desktop. The user can do serious public reading and contribution in small, interruptible sessions. The PWA is installable (add-to-home-screen on iOS, WebAPK install on Android, browser install on desktop), works offline for cached content and drafts, and updates by ordinary deployment with no store review.

Requirements:

1. Every primary action is reachable from the thumb zone or a predictable bottom sheet.
2. One-handed scanning and two-handed deep composition are both supported.
3. The default feed uses finite sections and stopping cues, not endless engagement extraction.
4. Long threads are navigable by semantic structure, not only chronological scrolling.
5. Context is available through bottom sheets and cards without losing reading position.
6. Source opening uses an in-app reader (sandboxed `iframe`/reader view) with a clear escape back to the thread.
7. Drafting autosaves locally (IndexedDB) and syncs safely when online.
8. Offline reading is supported for saved stories, permitted source snapshots, and draft contributions.
9. Push notifications are limited, explainable, and user-controllable (Web Push; on iOS only for installed home-screen web apps, iOS 16.4+).
10. All interactive targets are designed for touch, motor accessibility, and screen readers.

## 6.2 App shell and navigation

Primary bottom navigation (at most five surfaces):

| Tab | Purpose |
|---|---|
| Front Page | Ranked feed of stories and discussions. |
| Rooms | Topic rooms, local rooms, community lenses, subscribed areas. |
| Submit | Capture link, write post, add evidence, ask a question, start a thread. |
| Threads | Active conversations, replies, saved drafts, participation history. |
| Profile | Private Signal Ledger, settings, reputation, privacy, moderation notices, and (where enabled) wallet/governance. |

The Submit tab is centered and persistent; it is a contribution entry point, not a "post for applause" prompt. The Signal Ledger lives inside Profile, not as a separate tab.

## 6.3 Front Page layout

Each feed card contains: story title; source and origin badge; rating label (e.g. "Deepening," "Needs Context"); one-line reason ("Rising from independent source opens and evidence additions"); context chips ("3 lenses," "2 primary sources," "low coordination risk"); reading estimate; thread-branch preview; and swipe actions (left to save, right to open context card, long-press to signal problem / mute source / adjust topic). No card contains a like count, vote count, heart icon, public score, or reaction bar.

## 6.4 Thread layout

Threads use **structured branches**: Overview (best current synthesis, unresolved questions, evidence status); Questions; Evidence; Challenges (counterarguments and disputes); Local/Expert Lenses; and Chronology (time-ordered view for users who prefer it). A floating "Contribute" button opens the Participation Composer, which first asks: "What are you adding?"

## 6.5 Context cards

Compact, swipeable overlays: What happened? Why it matters; Where interpretations differ (SCOI-powered); Evidence status; Conversation state (deepening, fragmented, bridged, tense, under review); Distribution reason (why this is shown to the user); and User controls (see less/more, mute topic, inspect ranking signals).

## 6.6 Participation composer

The composer reduces low-information replies and encourages substance. Structured modes:

| Mode | Prompt | Required fields |
|---|---|---|
| Ask | "What would clarify this?" | Question text, optional claim reference. |
| Evidence | "What source should readers inspect?" | Link/file/citation, relevance note, claim reference. |
| Correction | "What is incorrect or missing?" | Correction text, supporting evidence, target text. |
| Synthesis | "What can be fairly summarized?" | Summary, included branches, uncertainty note. |
| Counterexample | "What case complicates this?" | Example, why relevant, source if factual. |
| Experience | "What direct context do you have?" | Experience scope, location/time if relevant, privacy warning. |
| Explain | "Can you make this easier to understand?" | Explanation, assumptions, caveats. |
| Flag | "What policy or safety issue exists?" | Reason, target, urgency. |

It supports voice dictation (Web Speech where available), citation capture from the browser share target, image/document attachment with privacy warnings, and local draft autosave.

## 6.7 Stopping cues and wellbeing

The app does not optimize for compulsive infinite scroll: section endpoints ("You are caught up on high-confidence stories"); diminishing-returns prompts ("The next items are lower confidence or more repetitive"); rage-loop dampening (repeated hostile returns do not increase PWAtt); user-set limits (focus mode, local-news-only mode, quiet hours); and notification budgeting (grouped notifications and daily digests by default).

## 6.8 PWA client architecture

| Component | Responsibility |
|---|---|
| App shell | Route handling, navigation, feature-flag bootstrap, install prompt. |
| Service worker | Offline caching strategy, background sync (where supported), push handling, update lifecycle. |
| Feed engine | Local caching, pagination, deduplication, scroll-position restoration. |
| Reader | Sandboxed in-app source reader, readability mode, citation capture. |
| Thread viewer | Branch navigation, lazy loading, semantic anchors. |
| Composer | Structured contribution entry, drafts, citations, attachments. |
| Signal processor | On-device (in-browser) attention feature extraction and caps. |
| Privacy manager | Permission state, deletion requests, local encryption of drafts. |
| Notification manager | Digest grouping, quiet hours, alert explanations. |
| Offline store | Saved stories, drafts, thread snapshots (Cache API + IndexedDB). |
| Accessibility adapter | Dynamic type/zoom, ARIA semantics, focus management on route change, reduced motion. |
| Wallet module (optional) | EIP-1193 / EIP-6963 injected-provider discovery and WalletConnect v2 sessions. |

Implementation notes: a service worker provides app-shell caching (cache-first for static assets, network-first with cached fallback for data); the install experience uses the Web App Manifest with maskable icons; cross-device sync is opt-in and end-to-end where feasible; no secret or signing key is ever embedded in the JavaScript bundle.

## 6.9 Offline behavior

Offline-supported: read saved stories and permitted source snapshots; read cached thread summaries; compose drafts; add citations from saved items; queue submissions and comments for background sync; view a private Signal Ledger snapshot. Offline-not-supported: final posting without sync; moderation actions requiring current state; real-time safety/crisis flows; external source verification. Because iOS may evict web storage under pressure, the client must detect eviction, resync from server state, and never silently lose a queued contribution or a pending transaction record.

## 6.10 Performance budgets

Targets are expressed in web terms and enforced as release gates:

| Metric | Target |
|---|---|
| Largest Contentful Paint (LCP) | ≤ 2.5 s at p75 on target mid-range mobile and 4G. |
| Interaction to Next Paint (INP) | ≤ 200 ms at p75. |
| Cumulative Layout Shift (CLS) | ≤ 0.1 at p75. |
| Thread branch open (cached) | ≤ 500 ms. |
| Composer open | ≤ 300 ms. |
| Offline draft save | ≤ 100 ms local acknowledgment. |
| Initial JS payload | Budgeted and code-split; route-level lazy loading; server-side rendering or streaming for first paint. |
| Battery/data | No continuous background processing beyond permitted sync/notification tasks. |

## 6.11 PWA capability boundaries (honest trade-offs)

PWA-only delivery trades some native control for universal, gatekeeper-free reach. The design accounts for: (1) **iOS storage eviction** — Cache/IndexedDB data is best-effort; design for resync and request persistent storage where the API exists. (2) **Background execution limits** — attention aggregation and sync run opportunistically; the server treats client aggregates as hints, never as the sole source of truth. (3) **Push on iOS** — only for installed home-screen web apps (iOS 16.4+); the onboarding flow guides install before relying on push. (4) **Wallet integration** — via WalletConnect v2 (mobile wallets over QR/deep link) and injected EIP-1193 providers discovered through EIP-6963 (desktop extensions); there is no native wallet SDK and Licio never handles seed phrases. (5) **No device attestation** — abuse defense relies on server-side behavioral analysis, proof-of-work/turnstile-style challenges, account-age and trust tiers, and WebAuthn, not native attestation APIs.

## 6.12 Client and full-stack TypeScript technology stack

This section specifies the TypeScript-based development stack for the Licio PWA and its backend-for-frontend (BFF). Every choice is evaluated primarily on **security posture** — minimizing attack surface, dependency count, and default-unsafe behavior — followed by TypeScript type safety, PWA capability, performance, and accessibility support. For a UGC platform that connects wallets, a single XSS injection can drain funds (Section 25.2); the stack is chosen so the secure path is the default path at every layer.

### 6.12.1 Design principles for stack selection

1. **Minimize XSS attack surface.** The dominant threat for a UGC + wallet platform is script injection (Section 25.2). Every rendering layer must auto-escape by default; unsafe rendering must require an explicit, reviewable opt-in.
2. **Enable strict CSP and Trusted Types without workarounds.** The build toolchain must emit no inline scripts and no inline styles, so that `default-src 'self'`, `script-src` with nonces or hashes, and `require-trusted-types-for 'script'` work out of the box — not as afterthoughts requiring patches or escape hatches.
3. **Reduce supply-chain risk.** Fewer transitive dependencies means fewer packages to audit, fewer maintainers to trust, and fewer vectors for dependency-confusion or install-script attacks. The stack targets the smallest auditable dependency tree that meets requirements.
4. **Support reproducible builds.** The build pipeline must produce deterministic output suitable for Subresource Integrity hashes, signed provenance attestations, and a transparency log (Section 20.2).
5. **Maintain explicit client-server boundaries.** No framework magic should blur which code runs in the browser and which runs on the server. Blurred boundaries create accidental data-exposure and privilege-escalation risks that are difficult to audit.
6. **Provide end-to-end TypeScript type safety.** A type error at any point from database schema to UI rendering is a compile-time failure, eliminating entire classes of data-handling bugs (missing fields, wrong types, null dereference) that in weaker stacks become runtime vulnerabilities.

### 6.12.2 Language, package manager, and build tooling

**TypeScript 5.x in strict mode** (`strict: true`, `noUncheckedIndexedAccess: true`, `exactOptionalPropertyTypes: true`) is the project language. Strict mode catches null-safety violations, type-coercion bugs, and unchecked property access at compile time; it is non-negotiable for a security-critical application.

**pnpm** is the package manager. pnpm enforces strict dependency resolution: a package cannot `import` a transitive dependency it did not explicitly declare (phantom dependencies). This closes a supply-chain attack vector that npm and Yarn classic leave open. pnpm's content-addressable store deduplicates disk usage and its lockfile is integrity-enforced. **lockfile-lint** validates the pnpm lockfile against declared registries on every CI run, preventing lockfile-poisoning attacks.

**Vite 6** (Rollup-based production builds) is the build tool. Vite is chosen over Next.js, Webpack, and other bundlers for specific security reasons:

- **No inline scripts.** Vite produces clean JavaScript files with no injected inline `<script>` blocks, fully compatible with the strict CSP (`default-src 'self'`, no `'unsafe-inline'`) and `require-trusted-types-for 'script'` required by Section 25.2. No nonce or hash workaround is needed for framework-injected hydration data.
- **Small, auditable dependency tree.** Vite's transitive dependency count is an order of magnitude smaller than Next.js, directly reducing supply-chain attack surface. Fewer packages means each can be reviewed, and the risk of a compromised transitive dependency reaching the production bundle is proportionally lower.
- **Deterministic output.** Rollup produces stable, content-hashed output suitable for reproducible builds, Subresource Integrity, and signed provenance (Section 20.2).
- **Explicit client-server boundary.** Vite builds the client; the BFF is a separate process with its own entry point. There is no framework-level blurring of which code runs where, preventing accidental data exposure across security domains.
- **Route-level code splitting and tree-shaking** support the initial JS payload budget and lazy-loading requirements (Section 6.10).

### 6.12.3 UI framework

**React 19 with TypeScript** is the UI framework. React is chosen for security and ecosystem maturity:

- **JSX auto-escaping.** React's JSX interpolation auto-escapes all values by default. A developer must explicitly invoke `dangerouslySetInnerHTML` to render raw HTML, making unsafe rendering a visible, reviewable decision in every code review. This is the strongest built-in XSS defense of any major UI framework.
- **Trusted Types compatibility.** React's internal DOM rendering pipeline is compatible with Trusted Types policies; when `require-trusted-types-for 'script'` is enforced, React does not trigger violations for its own DOM mutations.
- **Largest security-audit community.** React is deployed on more security-critical surfaces than any other frontend framework. Vulnerabilities are discovered and patched rapidly by a large, attentive community and a dedicated security team.
- **Well-understood DOM model.** React's reconciliation model has well-documented, predictable DOM interaction patterns. There is no template-compilation step that could introduce injection vectors, and no implicit two-way data binding that could cause unexpected state mutations.
- **Mature accessibility primitives.** React's component model supports ARIA patterns, ref-based focus management for SPA route changes (Section 26.2), and integration with `@axe-core/playwright` for automated accessibility regression testing.

### 6.12.4 Routing, state management, and data fetching

**TanStack Router** provides fully type-safe file-based routing with built-in code splitting. Route parameters, search params, and route loaders are type-checked end-to-end, eliminating parameter-injection and type-confusion bugs at the routing layer. There is no server-side routing complexity.

**TanStack Query v5** manages server state with built-in offline support (critical for PWA offline behavior, Section 6.9), request deduplication, stale-while-revalidate caching, and background refetching. Every API response is validated through `zod` schemas before entering the query cache, ensuring malformed or injected data from the server or a compromised network path is rejected at the boundary.

**Zustand** manages client-side state. At approximately 1 KB, it has the smallest footprint of any production-quality state library. There is no proxy magic, no implicit reactivity system, and no middleware attack surface; state is explicit and predictable.

### 6.12.5 PWA infrastructure

**vite-plugin-pwa** (Workbox 7) provides mature, well-audited service worker lifecycle management:

- **Precaching** with revision-hashed manifests for app-shell assets (cache-first strategy for static assets).
- **Runtime caching** with network-first-with-cached-fallback for API data and stale-while-revalidate for non-critical assets.
- **Background sync** for queued contributions, drafts, and pending submissions (Section 6.9).
- **Web App Manifest generation** with maskable icons, splash screens, theme color, and standalone display mode (Section 20.1).
- **Update lifecycle** management with user-facing activation prompts for new versions.

The service worker scope is locked down per Section 25.2; no remote code evaluation occurs within the worker; cache partitioning prevents cross-origin data poisoning.

### 6.12.6 Styling

**Tailwind CSS 4** is the styling solution. It is chosen over CSS-in-JS alternatives for a specific security reason: Tailwind compiles entirely to static CSS files at build time, producing **zero JavaScript runtime** for styling.

- **No CSS-in-JS attack surface.** Libraries like styled-components and Emotion inject `<style>` tags at runtime, requiring `'unsafe-inline'` in the CSP `style-src` directive or complex SSR extraction. Tailwind eliminates this attack surface entirely — there is no runtime style evaluation, no dynamic `style` tag injection, and no `'unsafe-inline'` requirement.
- **Strict CSP compatibility.** All styles are static CSS loaded via `<link>` tags with integrity hashes, fully compatible with the strictest CSP configuration.
- **Design-token-based theming** supports high-contrast, dark, and reduced-motion modes (Section 26.2) through CSS custom properties and media-query variants.
- **Responsive utility classes** support the mobile-first, thumb-zone-reachable layout (Section 6.1) without writing per-breakpoint CSS that drifts from the design system.

### 6.12.7 UGC sanitization and schema validation

**DOMPurify** is the HTML sanitizer for all user-generated content. It is the most battle-tested sanitizer in the JavaScript ecosystem, Trusted Types compatible (`DOMPurify.sanitize()` returns a `TrustedHTML` value when configured with `RETURN_TRUSTED_TYPE: true`), and allow-list-based: only permitted tags, attributes, and URL schemes pass; `javascript:`, `data:` URLs, event-handler attributes, and raw HTML are stripped by default. UGC Markdown-lite (Section 15.5) is parsed to a safe AST by a strict parser, then passed through DOMPurify before rendering — defense in depth so that a bug in either layer alone cannot produce an injection.

**zod** provides runtime schema validation at every system boundary:

- API responses are validated before entering the client, catching malformed or injected payloads.
- Form inputs are validated before submission, producing type-safe error states for the accessible composer (Section 26.2).
- Environment variables and configuration are validated at startup.
- Schemas are co-located with TypeScript types, so runtime and compile-time contracts cannot silently diverge.

### 6.12.8 Backend-for-frontend (BFF)

The BFF is the thin, security-critical gateway between the PWA and internal services (Sections 21.1, 23.1). It is a separate TypeScript process — not a framework-embedded server layer — with its own deployment, scaling, and security boundary.

**Hono** is the BFF framework. It is chosen for its minimal attack surface and TypeScript-native design:

- **Ultra-lightweight (~14 KB).** Hono's small codebase is auditable by a single engineer. This contrasts with Express (effectively unmaintained; minimal security updates; no built-in TypeScript support; middleware ordering is error-prone for security headers) and NestJS (large decorator-based surface area with many implicit behaviors).
- **Built-in security middleware** for security headers (CSP, HSTS, X-Content-Type-Options, X-Frame-Options, Permissions-Policy), CORS, rate limiting, IP restrictions, CSRF protection, and request-size limits — configured once at the application root, not scattered across middleware files.
- **Web Standards based** (Request/Response API) — portable across Node.js LTS, Bun, and Deno runtimes without runtime-specific adapter code.
- **Hono RPC** provides end-to-end type-safe client-server communication without code generation: the PWA client imports route types directly from the BFF, so API calls are compile-time checked against server contracts. A mismatched request shape, missing field, or wrong parameter type is a build failure, not a runtime bug.

**Drizzle ORM** is the relational database layer. It is SQL-first: queries map directly and transparently to SQL statements, making them auditable for injection, performance, and access-control correctness. There is no implicit query generation, lazy loading, or magic relation traversal that could produce unexpected database access patterns. Schema-as-code with migration generation ensures the database schema and TypeScript types stay synchronized.

**Node.js LTS** is the production runtime, with the `--experimental-permission` flag for filesystem and network permission restrictions where the deployment supports it. Structured logging (pino) supports the audit-trail requirements of Section 21.4.

### 6.12.9 End-to-end type-safe data path

The full data path from database schema to rendered UI is type-checked at compile time:

    Drizzle schema (DB) → Hono route handler → zod response schema → Hono RPC client → TanStack Query → React component props

A type error at any point in this chain is a compile-time failure. This eliminates entire classes of data-handling bugs — missing fields, wrong types, null dereference, shape mismatches — that in loosely-typed or runtime-validated stacks become production vulnerabilities.

### 6.12.10 Testing and quality infrastructure

| Tool | Role | Security relevance |
|---|---|---|
| **Vitest** | Vite-native unit and integration test runner; TypeScript-first with no separate compilation step. | Tests run against the same build pipeline as production, ensuring CSP and Trusted Types behavior is tested, not mocked. |
| **Playwright** | Cross-browser end-to-end testing including PWA install, offline, service-worker lifecycle, and wallet-flow scenarios. | Tests verify that strict CSP is enforced in real browsers; accessibility regression tests use `@axe-core/playwright` against WCAG 2.2 AA. |
| **Biome** | Fast linter and formatter with security-focused rules. | Flags `eval`, `dangerouslySetInnerHTML`, `innerHTML` assignment, `document.write`, and other injection-risk patterns; violations block CI. |
| **lockfile-lint** | Validates pnpm lockfile integrity against declared registries. | Prevents lockfile-poisoning supply-chain attacks where a dependency is silently redirected to a malicious registry. |
| **Dependency scanning** | Automated PR checks for known vulnerabilities and suspicious package behavior. | Detects install scripts, obfuscated code, unexpected network access, and known CVEs in direct and transitive dependencies. |

### 6.12.11 Security properties of the chosen stack

| Threat (Section 25) | Stack defense |
|---|---|
| XSS → wallet drain | React JSX auto-escaping (default) + DOMPurify with Trusted Types + strict CSP with no inline scripts (Vite) + no CSS-in-JS runtime (Tailwind) + Biome lint rules blocking unsafe DOM access. |
| Supply-chain compromise | pnpm strict resolution (no phantom deps) + minimal dependency tree (Vite ~80 vs Next.js ~300+ transitive deps; Hono ~14 KB vs Express ecosystem) + lockfile-lint + SRI on all assets + reproducible builds with signed provenance. |
| CSP bypass | Vite emits no inline scripts or styles; Tailwind compiles to static CSS; React hydration works without inline data scripts; Hono sets CSP headers at the BFF, not in client-side meta tags. |
| Trusted Types violation | React DOM pipeline is Trusted Types compatible; DOMPurify returns `TrustedHTML`; no other code path creates DOM nodes from strings; Biome flags `innerHTML` and `document.write`. |
| Serialization / type confusion | End-to-end TypeScript strict mode + zod runtime validation at API boundaries + Hono RPC compile-time route contracts + Drizzle type-safe SQL. |
| Clickjacking | Hono security-headers middleware (`frame-ancestors 'self'`); wallet and signing flows set `X-Frame-Options: DENY`. |
| Service-worker poisoning | vite-plugin-pwa revision-hashed precache manifest; locked scope; integrity-verified updates; no `importScripts` from external origins; no remote code evaluation within the worker. |
| Phishing / blind signing | Typed-data previews rendered by React with auto-escaping; contract-address allowlists enforced at the BFF before any signing request reaches the client. |
| CSRF | Hono CSRF middleware with `SameSite=Strict` cookies for session tokens; anti-replay nonces on state-changing requests; wallet-signing requests use EIP-712 domain separation with chain ID, contract address, and expiration. |
| SQL injection | Drizzle ORM parameterized queries — all user input is bound as parameters, never interpolated into SQL strings. |

### 6.12.12 Dependency budget

The client bundle targets fewer than **15 direct production dependencies**. The BFF targets fewer than **20 direct production dependencies**. Every addition requires a security review covering: maintainer trust and track record, transitive dependency count, install scripts (must have none), license compatibility with AGPL-3.0-or-later, and whether the functionality can be achieved with platform Web APIs or existing dependencies. Additions that exceed the budget require sign-off from the security owner and an explanation of why the existing stack is insufficient.

### 6.12.13 Stack summary

| Layer | Technology | Primary security rationale |
|---|---|---|
| Language | TypeScript 5.x strict | Compile-time null safety, type safety, and unchecked-access prevention. |
| Package manager | pnpm | Strict resolution prevents phantom dependencies; lockfile integrity. |
| Build | Vite 6 (Rollup) | No inline scripts; small dep tree; deterministic output; explicit client-server boundary. |
| UI framework | React 19 | JSX auto-escaping; Trusted Types compatible; largest security-audit community. |
| Routing | TanStack Router | Type-safe route params; no server-side routing complexity. |
| Server state | TanStack Query v5 | Offline support; zod-validated responses at API boundary. |
| Client state | Zustand | ~1 KB; no implicit reactivity; minimal attack surface. |
| PWA | vite-plugin-pwa (Workbox 7) | Mature SW lifecycle; revision-hashed precache; locked scope. |
| Styling | Tailwind CSS 4 | Zero JS runtime; no `'unsafe-inline'` styles; static CSS output. |
| UGC sanitization | DOMPurify | Trusted Types compatible; allow-list sanitizer; defense-in-depth with Markdown AST. |
| Validation | zod | Runtime schema enforcement at every system boundary. |
| BFF framework | Hono | ~14 KB; built-in security headers; Hono RPC type-safe contracts. |
| ORM | Drizzle | SQL-first; parameterized queries; no implicit behaviors; type-safe schema. |
| Runtime | Node.js LTS | Permission model; structured logging; LTS security patches. |
| Test runner | Vitest | Vite-native; tests run against production build pipeline. |
| E2E testing | Playwright | Real-browser CSP/Trusted Types/accessibility/PWA verification. |
| Linter | Biome | Security-focused rules blocking injection-risk patterns. |

### 6.12.14 Rejected alternatives and rationale

| Alternative | Rejection rationale |
|---|---|
| **Next.js** | Injects inline scripts for hydration data (`__NEXT_DATA__`, flight data), breaking strict CSP and Trusted Types without per-request nonce workarounds; large transitive dependency tree (~300+ packages) widens supply-chain surface; Server Components and Server Actions blur the client-server security boundary, making accidental data exposure difficult to audit; historical security vulnerabilities (e.g., middleware-bypass CVE-2025-29927) demonstrate the risk of a large framework surface; its built-in SSR is redundant given the separate BFF architecture. |
| **Angular** | Smaller security-audit community for wallet-connected UGC platforms; heavier framework with more internal surface area; zone.js monkey-patches browser APIs (timers, events, promises), widening the trusted-code surface; decorator-based patterns add runtime metadata complexity; strict CSP requires specific Angular CLI configuration and a custom webpack builder. |
| **SvelteKit** | Compiler-based approach has a smaller security-audit community; Svelte's template syntax uses `{@html ...}` for raw HTML, which is less obviously dangerous than React's `dangerouslySetInnerHTML` and easier to misuse in review; fewer battle-tested security libraries in the ecosystem; SSR complexity is redundant with the BFF. |
| **Express.js** | Effectively unmaintained with minimal security updates; no built-in TypeScript support; middleware ordering is error-prone for security-critical headers (a misordered middleware can silently skip CSRF or CSP enforcement); large middleware ecosystem with inconsistent security posture and many abandoned packages. |
| **Prisma** | Larger runtime footprint (requires a separate query-engine binary); the engine binary increases supply-chain surface and complicates reproducible builds; implicit behaviors (auto-include, lazy loading) can produce unexpected data access patterns that are hard to audit; less SQL-auditable than Drizzle's direct SQL mapping. |
| **CSS-in-JS (styled-components, Emotion, Stitches)** | Requires `'unsafe-inline'` in `style-src` or complex SSR style extraction to avoid FOUC; runtime style injection is an additional attack surface; conflicts with the strict CSP required by Section 25.2; adds JavaScript bundle weight for functionality that static CSS handles with zero runtime cost. |
| **Webpack** | Larger, more complex configuration surface than Vite; slower builds reduce security-iteration velocity; output is less deterministic by default; HMR implementation is more complex with more edge cases; Vite's Rollup-based production pipeline produces cleaner, more auditable output. |

# 7. Core invariant 1: Matroid Exposure Rank Invariant (MERI)

## 7.1 Purpose

MERI ensures feed diversity and topic quality are based on nonredundant exposure rather than superficial variety. A user should not see ten versions of the same claim from near-identical sources and have that count as ten useful exposures.

## 7.2 Mathematical model

Let `E` be the set of candidate exposures in a feed, room, topic, or thread, and let `S` be a subset of `E`. Nonredundancy is modeled by a **matroid** `M = (E, I)` whose independent sets `I` are the nonredundant subsets with respect to source lineage, claim content, evidence basis, creator network, and semantic framing. The rank function

    r(S) = max { |T| : T subset of S, T in I }

returns the size of the largest nonredundant subset of `S`. The core invariant is the normalized rank:

    MERI(S) = r(S) / |S|,   with 0 < MERI(S) <= 1

`MERI(S) = 1` means every exposure is independent; low MERI means the feed or topic is repetitive.

**Correctness note on the matroid model.** If nonredundancy is defined only by pairwise similarity, the independent sets form a general *independence system* (a downward-closed family), not necessarily a matroid. In that general case, computing the largest nonredundant subset is the maximum-independent-set problem, which is NP-hard and is *not* computed exactly by greedy selection. Licio therefore models redundancy as a genuine matroid, so that rank is well-defined and the greedy procedure in Section 7.5 is exact:

- **Partition matroid.** Partition exposures into near-duplicate, shared-source-lineage, and shared-primary-evidence classes (Section 7.5, steps 3–4). A subset is independent if it takes at most a bounded number of items from each class; the rank equals the number of classes represented, up to the per-class bound.
- **Transversal matroid.** Independence is the existence of a system of distinct representatives matching exposures to distinct evidence bases or distinct primary documents.

Matroid rank functions are monotone and submodular, so the marginal gain `r(S union {x}) - r(S)` is a diminishing-returns feature and greedy maximization of nonredundant coverage is optimal for the matroid (with the standard `1 - 1/e` cardinality and `1/2` matroid-constraint guarantees when balanced against the other ranking objectives). Where production must fall back to the general similarity-graph view, MERI is reported as a greedy *approximation* of rank, with that limitation recorded in the invariant card (Section 21.4).

## 7.3 Product interpretation

MERI powers feed deduplication; topic-page diversity; evidence-independence labels; anti-spam ranking dampening; user-facing context ("You have seen three independent versions of this story"); and creator fairness (creators are not punished for covering the same topic, but redundant copies have bounded marginal value).

## 7.4 Independence dimensions

| Dimension | Independence condition |
|---|---|
| Source lineage | Different publisher ownership, author, wire origin, or primary document. |
| Claim content | Adds a materially distinct claim or question. |
| Evidence base | Uses independent data, witness, document, study, or expert basis. |
| Community origin | Emerges from a distinct community or local context. |
| Semantic framing | Offers a distinct explanatory frame without being misleading. |
| Temporal update | Adds new facts after a meaningful event update. |

## 7.5 Algorithm sketch

1. Embed content, claims, titles, source snippets, and evidence cards.
2. Build a similarity graph among candidate exposures.
3. Add hard parallel classes for identical URLs, syndicated copies, near-duplicate text.
4. Add soft dependencies for shared source lineage, same primary evidence, same narrative frame.
5. Construct a partition or transversal matroid for production scalability.
6. Compute the greedy rank for the candidate set (exact for the matroid).
7. Use marginal rank gain as a ranking feature.

Pseudo-code:

    function marginal_exposure_gain(candidate x, current feed S):
        if duplicate_url(x, S): return 0
        if same_claim_same_source_lineage(x, S): return epsilon
        if adds_new_evidence_basis(x, S): return high_gain
        if adds_new_lens_without_misinformation(x, S): return medium_gain
        return rank(S union {x}) - rank(S)

## 7.6 UI requirements

Feed cards may show "New angle," "Independent source," "Duplicate context," or "Same claim, new evidence." Topic pages include an "independent sources" drawer. Users can choose "show fewer repeats" or "show all updates" per topic. The app must never say "this is true because many outlets repeated it" — repetition is not independence.

## 7.7 Acceptance criteria

| ID | Requirement |
|---|---|
| MERI-1 | Near-identical syndicated articles do not each increase feed rank. |
| MERI-2 | A primary document adds more independent exposure value than ten posts quoting one another. |
| MERI-3 | Topic pages expose source lineage and evidence lineage. |
| MERI-4 | Ranking experiments report MERI distribution before launch. |
| MERI-5 | MERI features are explainable in user-facing terms. |

# 8. Core invariant 2: Markov-Fiber Coordination Invariant (MFCI)

## 8.1 Purpose

MFCI detects coordinated behavior while conditioning on normal base rates, so active communities are not punished merely for being active.

## 8.2 Mathematical model

Construct contingency tables over dimensions such as:

    user_group x topic x time_bucket x action_type x target

Fix selected margins: total activity per group, per topic, per time bucket, per action type, and expected baseline target popularity.

The set of all nonnegative integer tables sharing those margins is the **fiber** of the observed table `X`. Under a log-linear null model (independence / quasi-independence of the conditioned dimensions), the fixed margins are the sufficient statistics, so the correct reference distribution is the **conditional distribution on the fiber given those margins** — the generalized hypergeometric induced by the null, not the uniform distribution over the fiber's lattice points. A Markov basis (Diaconis–Sturmfels) connects every table in the fiber by integer moves that preserve all fixed margins; a Metropolis–Hastings sampler proposes such moves and accepts them so that its stationary distribution is exactly that conditional distribution. MFCI then measures how extreme the observed coordination statistic `T` is relative to this conditioned reference:

    MFCI(X) = -log p_hat,   p_hat = (1 + #{ sampled X' : T(X') >= T(X) }) / (N + 1)

Here `p_hat` is the one-sided conditional p-value estimated from `N` Markov-chain samples, using the add-one estimator so that `p_hat > 0` always and `MFCI(X)` is finite even when no sampled table is as extreme as `X`. Larger MFCI means stronger evidence of coordination beyond the conditioned base rates. `T` may measure synchrony, repeated co-action, target concentration, same-phrase repetition, or simultaneous reporting.

**Latency note.** The full conditional test runs in the near-real-time and batch tiers. The sub-minute "freeze trend acceleration" path (MFCI-3) is driven by cheap, conservative synchrony and target-concentration statistics with precomputed null calibrations; the exact fiber test then confirms or clears the freeze and feeds the analyst case (Sections 8.5, 29.3).

## 8.3 Product interpretation

MFCI powers anti-brigading, coordinated-reporting detection, spam and manipulation resistance, raid detection, botnet detection, protection for controversial-but-authentic communities, and fair enforcement (activity is suspicious only when unusual after controlling for base rates).

## 8.4 Use cases

| Scenario | Naive interpretation | MFCI interpretation |
|---|---|---|
| A large fan community discusses the same news | Suspicious volume | Normal if conditioned on group size and topic interest. |
| Many new accounts report one user in two minutes | High concern | Extreme target concentration after fixed margins. |
| Local residents react to a local emergency | Sudden burst | Not suspicious if location/topic/time margins explain it. |
| Accounts with different profiles post the same phrasing | Maybe normal | Suspicious if phrase synchronization is extreme. |

## 8.5 Ranking integration

MFCI does not automatically remove content; it creates risk states:

| MFCI state | Ranking effect | Moderator effect |
|---|---|---|
| Normal | No penalty | None. |
| Elevated | Distribution dampening | Add to passive monitoring. |
| High | Freeze trend acceleration | Review queue. |
| Severe | Limit cross-community spread | Immediate safety/integrity review. |

## 8.6 User experience

Users do not see raw statistical accusations; they see, e.g., "This thread is temporarily under integrity review," "Reporting impact is delayed because report timing is unusual," or "This topic is receiving unusual synchronized activity. Distribution is slowed while reviewed."

## 8.7 Acceptance criteria

| ID | Requirement |
|---|---|
| MFCI-1 | Large normal communities are not penalized solely for volume. |
| MFCI-2 | Coordinated reporting has delayed enforcement impact until reviewed. |
| MFCI-3 | Severe synchronization freezes trend acceleration within one minute. |
| MFCI-4 | Every automated coordination action logs fixed margins and the statistic used. |
| MFCI-5 | Appeals can inspect a human-readable summary of coordination rationale. |

# 9. Core invariant 3: Gromov-Wasserstein Experience Isometry (GWEI)

## 9.1 Purpose

GWEI audits whether cohorts receive structurally comparable experiences. It does not require every group to see the same posts; it asks whether their experiences have similar relational geometry: diversity, source distance, novelty, discussion depth, evidence access, and topic opportunity.

## 9.2 Mathematical model

For cohort `A`, define a metric-measure space:

    X_A  = items shown to cohort A
    d_A  = pairwise distance between items by semantic, source, evidence, and community relation
    mu_A = a probability measure over X_A (normalized impression or attention share, sum = 1)

`d_A` is a (pseudo)metric: a nonnegative-weighted sum of the per-relation (pseudo)metrics, symmetric and zero on the diagonal. `mu_A` is normalized so couplings with prescribed marginals exist. For cohort `B`, define `(X_B, d_B, mu_B)` the same way. The order-2 Gromov–Wasserstein distance compares relational structure without requiring exact item identity:

    GWEI(A,B) = GW_2((X_A,d_A,mu_A),(X_B,d_B,mu_B))
              = ( inf over pi in Pi(mu_A,mu_B) of
                  sum_{i,j,k,l} |d_A(i,k) - d_B(j,l)|^2 * pi(i,j) * pi(k,l) )^{1/2}

where `Pi(mu_A, mu_B)` is the set of couplings with marginals `mu_A` and `mu_B`. `GW_2` is a pseudometric on isomorphism classes of metric-measure spaces, and `GWEI(A,B) = 0` exactly when the two experiences are measure-preserving isometric — which justifies the word "isometry." Low distance means structurally comparable experience; high distance indicates potential disparity, regardless of whether the cohorts saw identical items.

Exact GW is a non-convex quadratic assignment problem (NP-hard in general), so production uses sampled cohort windows and **entropic-regularized** GW. Runs report stability across random seeds and regularization strength, and the invariant card records the approximation and its confidence interval (Sections 9.7, 30.4).

## 9.3 Product interpretation

GWEI powers cross-language fairness audits, regional news parity, new-user vs established-user comparison, cohort safety audits for minors or vulnerable groups, algorithm rollout comparisons, and creator-opportunity analysis.

## 9.4 Experience dimensions

Source diversity; topic diversity; evidence access (probability of seeing primary sources/evidence cards); discussion depth; viewpoint geometry (relational spread of lenses and claims); novelty (balance of familiar and unfamiliar-but-relevant material); and safety state (exposure to harassment, misinformation, manipulation, or graphic content).

## 9.5 Product constraints

A new algorithm cannot launch if protected or sensitive cohorts receive structurally degraded experiences beyond threshold; language cohorts must not receive lower evidence completeness because fewer moderators speak that language; local cohorts must not be starved of local context when a story affects them directly; minors must not receive high-holonomy or high-risk rabbit-hole paths.

## 9.6 UI and transparency

GWEI is mostly an internal audit invariant. Public transparency reports may disclose aggregate experience-parity metrics, not sensitive cohort details. Users may see "Why am I seeing this?", "Your feed balances local, national, and topic-room context," "You can choose a less personalized feed," or "You are currently in a source-diverse mode."

## 9.7 Acceptance criteria

| ID | Requirement |
|---|---|
| GWEI-1 | Major ranking launches require cohort experience-isometry audits. |
| GWEI-2 | Audits compare relational structure, not only item overlap. |
| GWEI-3 | Any cohort degradation above threshold requires mitigation or sign-off. |
| GWEI-4 | GWEI dashboards are privacy-protected and access-controlled. |
| GWEI-5 | Transparency reports publish aggregate experience-parity summaries. |

# 10. Core invariant 4: Sheaf Context Obstruction Invariant (SCOI)

## 10.1 Purpose

SCOI measures context collapse: the failure of local community interpretations to glue into a coherent global understanding. A post may mean one thing in its original community and something very different when detached and shown elsewhere.

## 10.2 Mathematical model

Model the communities, topic rooms, or lenses as the cells of a **cellular sheaf** over the nerve of their overlaps. Each lens `U_i` carries a stalk (a vector space of admissible interpretations) and a local interpretation `s_i` in that stalk — a semantic summary, stance distribution, assumed background, or local norm encoded as a vector. The collection `s = (s_i)` is a 0-cochain. For each overlap `U_i cap U_j`, restriction maps `rho_i, rho_j` carry `s_i, s_j` into a shared comparison space, and the coboundary operator `d0` records their disagreement:

    (d0 s)_ij = rho_i(s_i) - rho_j(s_j)   on each overlap U_i cap U_j

The product-level score is the **normalized Dirichlet energy** of `s` under the sheaf Laplacian `L0 = d0^T d0`:

    SCOI(content) = ( s^T L0 s ) / normalizer
                  = ( sum over overlaps ij of || rho_i(s_i) - rho_j(s_j) ||^2 ) / normalizer

normalized to [0, 1] by the energy of a maximally-disagreeing configuration on the same overlap graph. `SCOI = 0` exactly when the local interpretations already agree on all overlaps and therefore glue into a single global section (the sheaf gluing axiom); higher SCOI means the local readings cannot be reconciled across overlaps without added context. Equivalently, SCOI is the squared distance of `s` from the space of globally consistent sections `H0 = ker d0`.

**Correctness note on the obstruction.** The raw cochain `(d0 s)_ij = rho_i(s_i) - rho_j(s_j)` is by construction a *coboundary*, so it is always exact and its Cech cohomology class is trivial; it is the *magnitude* (Dirichlet energy) of this discrepancy, not its cohomology class, that quantifies context collapse for a given set of readings. A genuinely cohomological obstruction arises only at the structural level — when the restriction maps themselves admit no consistent global gluing for any choice of local readings, i.e. when the first sheaf cohomology `H1` of the overlap diagram is nontrivial. That structural obstruction is the target of SCOI v2 (Section 30.4), where persistent cross-community interpretation failures are summarized by the norm of the harmonic representative (the Hodge-minimal cochain) of the nontrivial class.

## 10.3 Product interpretation

SCOI powers context cards, cross-community sharing warnings, ranking dampening for context-fragile content, bridge-comment rewards, thread-summary generation, moderator triage, and community-lens design.

## 10.4 Context states

| State | Meaning | Product action |
|---|---|---|
| Coherent | Local interpretations mostly agree. | Normal distribution. |
| Ambiguous | Some missing background. | Add context-card prompt. |
| Split | Communities read the item differently. | Show lens map before commenting. |
| Obstructed | Interpretations cannot be reconciled without extra context. | Slow cross-community spread; request bridge/synthesis. |
| Weaponized | Ambiguity is used to inflame conflict. | Review and apply safety constraints. |

## 10.5 UI requirements

Feed-card label "Needs Context" when SCOI is elevated; context-card section "Where interpretations differ"; thread branch "Bridge attempts"; composer warning "People in another room are reading this differently. Add context before replying."; share dialog "This item is context-sensitive. Include origin context?". "Needs Context" means interpretations differ — never false, bad, or banned.

## 10.6 Ranking integration

High SCOI does not mean bad content; it means the content should travel with context:

| SCOI level | Ranking action |
|---|---|
| Low | Normal ranking. |
| Medium | Require context card in feed. |
| High | Reduce cross-community amplification until context improves. |
| Very high | Prioritize bridge requests, expert context, or moderator review. |

## 10.7 Acceptance criteria

| ID | Requirement |
|---|---|
| SCOI-1 | Cross-community distribution includes context when SCOI is elevated. |
| SCOI-2 | Bridge comments receive participation credit when obstruction decreases. |
| SCOI-3 | Users can inspect major interpretation differences in plain language. |
| SCOI-4 | Moderators can merge, annotate, or separate threads based on context state. |
| SCOI-5 | SCOI features are validated against human-labeled context-collapse cases. |

# 11. Core invariant 5: Preference Holonomy Invariant (PHI)

## 11.1 Purpose

PHI detects path-dependent steering in recommendation. The concern is not only what a user sees now, but how sequences of recommendations rotate the user's latent interest representation after moving through topic loops.

## 11.2 Mathematical model

Each topic context has a local coordinate system (a frame) for the user's latent-preference space. Moving from context `x` to `y` applies a transport map `A_xy`. Because transport should preserve the geometry of preference space (lengths and angles), the maps are modeled as **invertible and metric-preserving** — orthogonal maps `A_xy in O(n)`, i.e. a metric connection — so that their composition around a loop stays in `O(n)` and the loop holonomy is well-defined. Around a closed path

    x0 -> x1 -> ... -> xk = x0

the holonomy is the ordered product

    H(gamma) = A_{x_{k-1}, x_k} ... A_{x_1, x_2} A_{x_0, x_1}

If `H(gamma)` differs from the identity, returning to the same apparent topic has rotated the user's preference representation — path-dependent steering. The risk score is the magnitude of that rotation:

    PHI(gamma) = || log( H(gamma) ) ||_F

`PHI(gamma) = 0` exactly when `H(gamma) = I` (flat, path-independent transport). For `H in SO(n)` the principal matrix logarithm `log(H)` is a real skew-symmetric matrix whose Frobenius norm equals `sqrt( 2 * sum_k theta_k^2 )` in the loop's rotation angles `theta_k`, giving a direct "total rotation" reading.

**Correctness and gauge-invariance notes.** The matrix logarithm is well-defined when `H` has no eigenvalue on the negative real axis; modeling transports as orthogonal keeps the eigenvalues of `H` on the unit circle, so this holds except at isolated rotation-by-pi configurations, where `|| log(H) ||` is still finite and the robust fallback `|| H - I ||` is used. Holonomy is defined only up to a choice of basepoint and frame (conjugation `H -> Q H Q^T`), so PHI must use a conjugation-invariant summary — the Frobenius norm of `log(H)`, the rotation angles, or other eigenvalue/trace summaries — never coordinate-specific embedding values. This is the gauge-invariant requirement made explicit in the PHI v2 build plan (Section 30.4).

## 11.3 Product interpretation

PHI powers rabbit-hole detection, safe-exploration limits, minors' feed protection, topic-loop dampening, recommender-audit explanations, and wellbeing prompts.

## 11.4 Example

Two users both end up viewing nutrition content. One arrived via sports performance, cooking, and medical guidelines; the other via conspiracy, miracle cures, and anti-institutional panic. Locally both appear interested in nutrition; PHI distinguishes the path-dependent steering that produced the state.

## 11.5 Ranking constraints

No sequence should repeatedly route a user through high-risk loops without deliberate user choice; high-holonomy transitions are dampened or diversified; sensitive topics (self-harm, eating disorders, medical misinformation, extremist ideology, harassment) have stricter loop thresholds; minors receive stricter thresholds and less personalization; users can choose chronological, source-diverse, or low-personalization modes.

## 11.6 UX requirements

"Change the path" prompt ("Your recent feed has become narrow around this topic. See broader context?"); feed-mode switch ("Balanced," "Chronological," "Source-diverse," "Local," "Low personalization"); quiet notification policy for high-holonomy topics; user-accessible topic controls (mute, reset topic history, reduce personalization).

## 11.7 Acceptance criteria

| ID | Requirement |
|---|---|
| PHI-1 | Ranking computes path-risk features for recommendation sequences. |
| PHI-2 | High-holonomy loops are dampened before they become dominant. |
| PHI-3 | Sensitive topics use stricter thresholds. |
| PHI-4 | Users can reset or reduce personalization without deleting their account. |
| PHI-5 | Experiments report holonomy-risk distribution. |

# 12. Supporting invariant services

The five core invariants suffice for the primary platform. These supporting invariants add value without overcomplicating the user experience; each ships as a confidence-bearing service with the same discipline (Section 21.4).

## 12.1 Hodge Conversation Tension Invariant

Represent a conversation as a simplicial complex of users, claims, and replies; edge flows encode agreement, disagreement, correction, or attention. The discrete Hodge (Helmholtz) decomposition splits the flow into orthogonal components:

    flow = gradient + curl + harmonic

The **gradient** part is a globally consistent ranking/ordering; **curl** is local cyclic inconsistency; **harmonic** is global, irreducible cyclic conflict. Product use: distinguish healthy disagreement from locked structural conflict; route moderators to threads with high harmonic tension; identify where a synthesis comment could cancel local cycles; label a thread "High disagreement, low hostility" versus "Global unresolved conflict." The `HarmfulTensionRisk` penalty in PWAtt combines harmonic tension with hostility/safety classifiers — harmonic tension alone never penalizes legitimate sustained disagreement.

## 12.2 Tropical Cascade Rank

Use the min-plus (tropical) semiring to compute earliest-arrival times along spread paths; earliest arrival is exact in min-plus. Cascade structure is summarized by tropical-rank-style features of the timing matrix (the chosen feature is fixed and documented, since several inequivalent notions of tropical rank exist). Product use: detect coordinated link drops and unnatural trend timing; freeze unusually synchronized cascades; complement MFCI with timing geometry.

## 12.3 Braid Agenda Dynamics

Trending topics trace strands over time; crossings as strands swap rank form a braid word. Invariants such as crossing number and braid (topological) entropy quantify agenda turbulence. Product use: detect manufactured churn; show stewards when topic order is being gamed; identify repeated attempts to keep a topic near a visibility threshold.

## 12.4 Reeb Attention Landscape

Define a scalar function over content space (e.g. engagement velocity or controversy); the Reeb graph tracks how level-set components merge and split. Product use: visualize narrative basins in the Civic Map; detect topic bifurcation; route bridge prompts when two attention basins share a fragile saddle.

## 12.5 Counterfactual Invariance Defect (CID)

For a transformation group `G` that should not change ranking, compute the expected deviation:

    CID(x,u) = E_g | R(g.x, g.u) - R(x,u) |

Product use: detect identity-proxy bias; test translation fairness; verify that explanations such as "shown for topic relevance" are stable; support model-release gates.

## 12.6 Path-Signature Wellbeing Invariant

Session events form a path; iterated integrals (the path signature) encode ordered behavior such as read → source → question versus scroll → rage-reply → repeat, without reading private content. Product use: detect unhealthy loops; improve stopping cues; distinguish constructive deep dives from compulsive sessions; optimize UX for agency rather than addiction.

# 13. Ranking and distribution system

## 13.1 Objectives and constraints

Ranking is a constrained multi-objective optimizer. It maximizes meaningful attention, constructive participation, nonredundant exposure, evidence completeness, context coherence, topic relevance, civic importance, user agency, and conversation health — subject to constraints: coordination risk below threshold (MFCI), holonomy risk below threshold (PHI), GWEI cohort disparity below threshold, redundancy bounded by MERI, context obstruction handled by context cards or dampening (SCOI), safety-policy compliance, and privacy/age-appropriate limits.

## 13.2 Candidate generation

Sources: subscribed rooms; local and regional news; global front-page candidates; emerging discussions with high constructive participation; independent source additions to known stories; cross-community bridge candidates; expert explanations and high-quality summaries; chronological catch-up. Candidate generation must preserve a minimum quota of fresh, independent, and local sources to prevent personalization collapse. Candidate generation is independent of likes, follower counts, wallet activity, payments, and donor status.

## 13.3 Ranking stages

| Stage | Description |
|---|---|
| Ingest | Normalize links, extract metadata, classify topics, detect duplicates. |
| Candidate retrieval | Retrieve stories/threads relevant to user, room, and global context. |
| Invariant feature join | Add MERI, MFCI, GWEI, SCOI, PHI, and support-invariant features. |
| Safety filter | Remove or restrict policy-violating content. |
| Multi-objective rank | Score with PWAtt and constraints. |
| Diversification | Apply nonredundancy, source, lens, and topic balancing. |
| Explanation generation | Produce a short user-facing distribution reason. |
| Logging | Record features, decision, and explanation for audit. |

## 13.4 Ranking pseudo-code

    function rank_front_page(user u, context c):
        candidates = retrieve_candidates(u, c)
        candidates = remove_policy_disallowed(candidates)
        for item in candidates:
            features[item] = join_features(item, u, c)        # excludes payment/wallet fields
            features[item].pwatt = compute_pwatt(item, u, c)
            features[item].risk  = compute_risk_constraints(item, u, c)
        feasible = filter(candidates, risk_below_hard_limits)
        ordered  = constrained_optimize(
            feasible,
            maximize    = [pwatt, exposure_independence, evidence_completeness, relevance],
            constraints = [cohort_parity, context_requirements, holonomy_limits]
        )
        feed = diversify_with_matroid_rank(ordered)
        return attach_explanations(feed)

## 13.5 Explanation examples

"Shown because readers in three rooms opened the source and added independent evidence." "Shown with context because communities are interpreting the quote differently." "Lower in your feed because it repeats a claim you have already seen from the same source lineage." "Shown from outside your usual topics to preserve source diversity." "Distribution is slowed because synchronized activity is under review."

## 13.6 Ranking prohibitions

The ranking system must not: use likes or upvotes (they do not exist); optimize only for total dwell time; treat controversy as quality; reward repeated hostile returns; count duplicate claims as independent validation; boost content solely because a high-reputation user posted it; infer sensitive attributes unnecessarily; read wallet connection, token balance, donation amount, treasury contribution, payment receipt, governance vote, or paid membership as a positive visibility feature; or hide explanations behind vague terms such as "because of the algorithm." A continuously enforced ranking-neutrality test suite (Section 30.6) proves the financial-feature exclusion.

# 14. Social news aggregation model

## 14.1 Submission types

| Type | Description | Required metadata |
|---|---|---|
| Link story | External article, blog, report, video, podcast, dataset. | URL, topic, short reason for submission. |
| Original brief | User-written post. | Topic, title, body, disclosure if personal experience. |
| Question | A discussion-seeking prompt. | Question, context, topic. |
| Evidence card | Source tied to an existing claim. | Citation, claim reference, relevance note. |
| Local update | Time/place-specific update. | Location scope, time, source or experience disclosure. |
| Live thread | Time-bounded event discussion. | Event, time, moderation mode. |

## 14.2 Ingestion pipeline

Normalize URL and canonical source; detect duplicates and syndicated copies; extract metadata, author, date, publisher, primary media type; generate a candidate claim list; classify topic, location, language, sensitivity, source type; compute embeddings and similarity links; run initial safety checks; initialize MERI, SCOI, and cascade-tracking state; create the story card and thread shell. Crawling respects robots.txt and publisher restrictions; copyright-aware display and a takedown intake path are mandatory.

## 14.3 Source model

Source profiles contain: name and canonical domain; ownership/publisher lineage when known; typical topics; correction history within Licio; evidence-type frequency; community notes and context cards; known syndication relationships. The source model must not present simplistic "truth scores"; it exposes context and history, not a substitute for reader judgment.

## 14.4 Story lifecycle

Submitted → Gathering attention → Deepening → Context needed (SCOI or evidence gaps elevated) → Bridging → Stable → Archived (low activity; preserved for search and reference).

# 15. Forum and conversation design

## 15.1 Structured contribution taxonomy

Contributions are classified because classification improves ranking, moderation, and readability; the app makes classification easy, not burdensome. Types: question; answer; evidence; correction; synthesis; counterexample; explanation; local context; direct experience; moderation concern; meta-discussion about thread structure.

## 15.2 Conversation quality model

A conversation is high quality when it has clear claims; independent evidence; visible unanswered questions; corrections explicitly accepted or disputed; multiple lenses represented fairly; low harassment and manipulation; summaries that improve as the thread grows; and structure that lets readers enter at different depths.

## 15.3 Thread branch scoring

Branches receive internal scores from nonredundant evidence added, questions answered, context obstruction reduced (SCOI), harmonic tension reduced without suppressing disagreement (Hodge), corrections incorporated, low coordination risk (MFCI), and reader utility from active attention and return visits. No branch receives score from likes.

## 15.4 Summaries

Three layers: an **automated draft summary** (generated, labeled machine-generated, never final); a **community synthesis** (user-written, citing branches and evidence); and a **steward summary** (moderator-approved, for high-impact threads). Summaries include unresolved uncertainty and relevant minority views (Section 24.3).

## 15.5 Comments and replies

Comments support Markdown-lite formatting (rendered through a strict sanitizer and Trusted Types, Section 25); source-citation cards; claim references; quote snippets with attribution; edit history for material changes; deletion with a tombstone when needed for thread integrity; abuse reporting; translation with original text accessible; and accessibility labels for attachments.

## 15.6 Reputation without applause

Reputation is based on contribution outcomes, not public likes: evidence reliability (cards stay useful and are cited by later summaries); correction accuracy (accepted/corroborated); bridge ability (reduces SCOI); topic expertise (judged by thread outcomes and steward review); civic conduct (low violations, constructive disagreement); steward reliability (accurate moderation, fair appeals). Reputation is domain-specific, bounded, private, and not convertible into automatic ranking power.

# 16. Community, rooms, lenses, and governance

## 16.1 Rooms

Rooms are topic or locality spaces, public, restricted, or expert/steward-led. Types: global topic room; local geographic room; professional/domain room; event room; learning room; steward room.

## 16.2 Lenses

A lens is an interpretation context, not a private echo chamber: local resident, beginner, expert, affected community, skeptical, policy, historical. SCOI uses lenses to identify where meanings diverge.

## 16.3 Steward roles

| Role | Capabilities |
|---|---|
| Community steward | Organize threads, request context, merge duplicates, escalate moderation. |
| Evidence steward | Review evidence cards, mark primary sources, flag weak citations. |
| Safety moderator | Enforce policy, handle reports, protect targets. |
| Appeals reviewer | Review disputed moderation or account actions. |
| Integrity analyst | Investigate coordination, spam, manipulation, raids. |

## 16.4 Governance requirements

Rules are public and in plain language; moderation actions have reason codes; users have notice and appeal for significant actions; steward actions are audited; public transparency reports summarize moderation and integrity actions; high-impact policy changes require a changelog and user notice.

## 16.5 Knomosis-enabled room readiness

A room may opt into Knomosis-enabled governance (Section 17) only after a readiness checklist: a plain-language charter; at least two independent stewards and an appeals path; a treasury policy with permitted spend categories; conflict-of-interest rules for bounties, grants, reimbursements, and compensation; a minimum transparency standard for proposals and treasury events; a safety override preserving platform-wide moderation and legal compliance; a fork/exit process against capture; and enablement only in supported jurisdictions. Knomosis-enabled rooms are introduced gradually (simulated → testnet → capped mainnet → mature); ordinary rooms remain the default.

# 17. Knomosis L2 payments and DAO-like forum governance

## 17.1 Purpose and hard boundaries

Knomosis integration adds verifiable, compliance-gated payments and governance without changing Licio's anti-vanity premise. It lets communities fund public-interest information work, govern room resources, and audit treasury decisions. It observes hard boundaries:

1. **No pay-to-rank.** No payment, token purchase, treasury grant, DAO vote, NFT, stake, or bounty can raise ranking, search placement, notification priority, trend placement, recommendation eligibility, or author status.
2. **No reward-for-posting.** Licio never offers cryptocurrency for posting, commenting, inviting, reacting, or spending time.
3. **No hidden financial gating.** Users can see which features need a wallet, which need jurisdiction checks, and which are unavailable.
4. **No on-chain sensitive behavior.** Attention, reading/report history, safety cases, sanctions, private messages, minors' data, sensitive inferences, device IDs, and personal data never go on-chain.
5. **No DAO supremacy over safety.** Room governance is subordinate to law, child safety, privacy, anti-abuse, accessibility, sanctions controls, and platform-wide trust-and-safety.
6. **No unmanaged custody.** Custodial, value-transmission, or exchange functions do not launch until licensing, registrations, compliance programs, and operational controls are complete.
7. **No securities-like token design without counsel.** No promises of profit, passive income, tradable governance speculation, or investment-like claims unless reviewed and approved per jurisdiction.

## 17.2 Source-of-truth interpretation of Knomosis

The Knomosis repository describes a proof-carrying state-transition kernel with Lean 4 as the formal source of truth and mechanically mirrored Solidity and Rust implementations. Licio treats these as engineering inputs requiring production validation, not a substitute for security audit. The stack is interpreted as four layers: a **formal kernel** (law definitions, transition preconditions, invariant preservation, replay, legality evidence); a **Solidity settlement layer** (L1 bridge, deposit/withdrawal, state-root, dispute, fault-proof, sequencer-staking, migration); a **Rust runtime layer** (host adapter, L1 event ingestion, storage/indexing, fault-proof observation, networking); and the **Licio application layer** (rooms, charters, proposals, treasuries, bounties, grants, payment intents, wallet UX, compliance checks, ranking separation). "Knomosis L2" means the deployable Licio integration around these layers; engineering must not assume unstated finality, throughput, settlement, withdrawal-timing, fault-proof-window, supported-token, or cost properties — each must be validated against the exact pinned deployment.

## 17.3 Product primitives

### 17.3.1 Wallet-linked identity

Wallet linkage lets a user sign payment and governance actions without making the wallet their primary public identity. Civic account creation needs no wallet; a user may link multiple wallets subject to abuse limits; a wallet may be unlinked if no unresolved obligations depend on it; the UI shows user-defined labels, not full addresses, by default; public on-chain participation is disclosed before signing; contract wallets and multisigs are supported for stewards/treasuries/organizations (verified via EIP-1271); signing uses structured typed data with domain separation so the user sees action, room, chain, contract, expiration, nonce, and consequences; and **Licio never asks for, stores, transmits, or recovers seed phrases or private keys.**

### 17.3.2 Crypto payments

Payment types: voluntary support payment; evidence bounty (escrowed for a specific evidence task); source-acquisition grant (reimburses verified costs); moderator/steward stipend (disclosed labor under COI rules); research/data grant; room-treasury deposit; action-budget top-up. Prohibited uses: boosting ranking; buying trend placement or search priority; buying moderation immunity; paying for harassment, brigades, or report floods; paying users to post/reply/invite/dwell; selling minors access to financial features; presenting holdings as social status.

### 17.3.3 DAO-like room governance

Permitted governance actions: charter creation/amendment; steward nomination/removal/rotation; treasury budget allocation; bounty lifecycle; grant approvals/reimbursements; local rules below platform policy; delegated budget top-ups; room fork/merge/archive/migration; public audit-log attestations; external-partnership approvals. Prohibited: reinstating content/accounts that policy or law requires restricted; publishing private safety reports or protected data; overriding child-safety, terrorism, self-harm, doxxing, or illegal-content rules; removing accessibility/privacy/security obligations; using treasury for market manipulation, sanctions evasion, bribery, harassment, or deceptive campaigning; altering immutable settlement parameters absent a documented, reviewed migration.

### 17.3.4 Law packs and charters

A **law pack** is a machine-readable governance bundle for a charter, containing: identifier and version; human-readable summary; allowed and disallowed proposal types; role definitions and signing requirements; quorum and threshold rules; timelock rules; treasury spend categories and caps; conflict-of-interest requirements; appeal/dispute rules; fork/exit rules; emergency-override constraints; schema version and migration path; hash commitments to off-chain documents; and test fixtures proving expected transition behavior. The MVP law pack supports only treasury deposits, capped grants, bounty lifecycle, steward rotation, and public audit logs; complex delegation/migration waits until the legal, security, and operational model is proven.

## 17.4 Governance states and lifecycle

Room governance mode: Ordinary (no Knomosis), Simulated (off-chain, educational), Testnet (test assets), Capped production (real assets, strict limits/timelocks), Mature production (expanded after audits), Frozen (paused for incident/dispute/legal/policy), Migrating (moving law pack or deployment).

Proposal lifecycle: Draft (plain-language summary, structured fields, budget impact, conflicts, jurisdiction flags, law-pack validation) → Preflight (simulate action; check type, signatures, role permissions, caps, policy conflicts, distribution constraints, sanctions/fraud) → Publication (Governance tab, mobile-readable summary, risk labels) → Deliberation (linked thread; PWAtt/invariants may rank discussion quality, never vote outcomes) → Voting/attestation (eligibility basis transparent) → Challenge window (flag conflicts/fraud/capture/legal/evidence defects) → Execution (if thresholds/timelocks/checks pass) → Indexing (audit log and public ledger) → Appeal/dispute (per charter and platform policy) → Postmortem (structured outcome summary for high-impact or disputed actions).

## 17.5 Voting, delegation, and anti-capture

Licio avoids naive one-token-one-vote (it encourages plutocracy and capture). Permitted weight models, configurable per room within platform policy: one verified civic account, one vote (small rooms with strong anti-Sybil); reputation-bounded vote (capped, explainable); role-based quorum (distinct role classes); quadratic or capped token voting (only if Sybil controls, anti-bribery monitoring, and legal review pass); delegated vote (revocable, public logs); multisig steward execution (several independent stewards plus timelock). Required anti-capture controls: maximum voting weight per account/wallet cluster; eligibility age or contribution-history requirements for high-impact decisions; MFCI monitoring for synchronized voting, proposal floods, and bounty collusion; conflict-of-interest disclosure before votes on grants/bounties/stipends; cooling-off periods for new wallets before treasury control; fork/exit rights; public audit trail; emergency-freeze path for exploit, compromise, sanctions risk, or legal order.

## 17.6 Treasury architecture

A production room treasury has: a treasury address/contract reference; an accepted-assets list; a jurisdiction-availability map; deposit limits per user/room/period/asset; spend categories and caps; multisig or policy-controlled execution; timelocks for material disbursements; emergency-freeze and incident-recovery rules; a public ledger and reconciliation reports; tax/accounting export; sanctions/fraud screening where required; a reserve policy for refunds/disputes/errors; no commingling between room treasuries and platform operating funds; and no reuse of user assets for yield, lending, staking, rehypothecation, or market-making unless explicitly approved by legal, disclosed, and regionally permitted. Material actions require dual/multi-role approval, COI declaration, an independent review path for grants/bounties, recipient screening where required, a challenge window before irreversible execution, a reconciliation job after every sequenced action, and accounting export.

## 17.7 Action budgets

Knomosis action budgets are an anti-spam and capacity mechanism, never a social-status or ranking asset: basic civic actions remain free within abuse-resistant limits; Knomosis actions may consume budget for proposal submission, treasury operations, law-pack changes, and execution; a room may fund budgets for stewards/workflows; budgets are not tradable in-app; top-ups do not affect ranking; consumption is visible before signing; high-risk actions require preflight and explicit confirmation; abuse teams can freeze or rate-limit budget use under documented policy.

## 17.8 PWA wallet and governance UX

Wallet entry points are intentionally rare (Governance tab in an enabled room; treasury-support button; bounty contribution; grant/payout; steward console; account-settings wallet page). The home feed, reading, source opening, commenting, reporting, blocking, and privacy controls never push wallet connection. Every transaction preview shows: plain-language action name; room name and ID; recipient/contract; asset and amount; estimated network fee; reversibility; timelock/challenge period; public visibility; jurisdiction/compliance status; risk label; wallet address used; chain ID and contract domain; expiration and nonce; link to proposal/bounty; support contact. The primary button states exactly what happens ("Sign proposal," "Contribute 10 USDC," "Execute grant payout"), never vague verbs. Wallet connection uses WalletConnect v2 and injected EIP-1193 providers discovered via EIP-6963; biometric/WebAuthn re-authentication is requested before high-value signing where available; no countdown pressure, fake scarcity, hidden fees, or confusing approvals; all flows work with dynamic type, reduced motion, screen readers, and poor connectivity (Section 26).

## 17.9 Integration with ranking and invariants

Allowed: a funded evidence bounty creates a "Needs evidence" card; completed, independently-reviewed-and-cited evidence improves a thread's evidence quality; treasury transparency improves trust in a room but cannot raise every room post; governance deliberation is ranked by constructive participation, not token votes; MFCI detects suspicious synchronized grants/votes/completions; MERI prevents duplicate paid evidence from inflating exposure; SCOI flags proposals that mean different things to different lenses; GWEI audits whether crypto-enabled rooms get disproportionate exposure; PHI prevents wallet-content loops from steering users into speculative rabbit holes. Prohibited: more funds → more reach; more tokens → more authority outside governance UI; higher treasury balance → trending; paid creator support → content boost; grant recipients → automatic distribution preference; governance participation as a substitute for content/evidence/safety quality.

## 17.10 Compliance, custody, and distribution posture

**Custody model** (chosen and documented before production): non-custodial connector (preferred MVP; users connect external wallets, Licio custodies nothing); partner-custodial (a licensed partner provides wallet, on/off-ramp, KYC/AML, monitoring, tax forms, support); first-party custodial (not recommended; blocked until licensing, staffing, audits, bonding/insurance, controls, and regulator engagement are complete). **Jurisdiction policy engine:** supported regions; asset availability by region; feature availability by region; KYC/AML triggers; sanctions restrictions; age restrictions; tax-disclosure requirements; consumer risk disclosures; regulator mapping; disabled-region fallback UX; evidence of legal approval by release. **Distribution constraints (PWA):** because Licio is a web app, there is no app-store crypto-policy gate and no in-app-purchase requirement; voluntary contributions flow directly through the wallet, still fully subject to law and the compliance engine; crypto features are feature-flagged by region and fail closed. **AML/fraud/sanctions controls before real funds:** sanctions screening where required; transaction monitoring; velocity limits; a fraud queue; risk checks that do not expose private attention behavior to chain-analytics providers; manual review of high-value disbursements; treasury freezes for suspected compromise; case management for fraud/scams/impersonation/bribery/coercion; a law-enforcement-request workflow; SAR/STR workflow if the model creates reporting obligations; a counsel-approved retention schedule; and a support workflow for mistaken transfers, scams, wallet compromise, and lost access.

## 17.11 MVP scope and production gates

**MVP includes:** read-only Knomosis education; simulated governance for pilot rooms; testnet wallet-link and proposal signing; testnet room treasury with fake assets; law-pack registry v0 with fixed templates; proposal lifecycle for charter update, bounty creation/completion, and capped grant; transaction preview and typed signing; read-only audit log; compliance feature gating by region; shadow-mode invariant monitoring of governance manipulation. **MVP excludes:** first-party custody; in-app exchange/on-off-ramp; speculative tokens; token rewards for posting/engagement; pay-to-boost; production mainnet funds before audit; complex programmable law packs; permissionless DAO creation; anonymous high-value disbursement; governance control over platform-wide moderation. **Production real-funds gates** (all required): legal sign-off per jurisdiction; custody model and partner contracts; AML/fraud/sanctions controls; tax/accounting plan; external audit of contracts and deployment config; external audit of wallet flows and backend gateways; CI validation of Knomosis Lean/Solidity/Rust cross-stack fixtures; reorg and reconciliation tests; disaster-recovery test; bug bounty live; tested incident runbook; trained financial-support and T&S teams; public risk disclosures; tested rollback/freeze controls; configured treasury limits; verified region/age feature flags; live monitoring dashboards; approved pilot-room charters.

## 17.12 Success metrics

Measure public value, not asset volume. **Good:** evidence bounties completed with accepted primary sources; grant-funded context cards that improve thread resolution; treasury-transparency completeness; proposal-participation diversity; low scam/fraud rate; low governance-capture rate; high share of treasury actions with clear public purpose; low reversal/dispute rate; user comprehension of transaction previews; no measurable pay-to-rank effect. **Avoid as goals:** total value locked; tokens traded; wallet connects as growth KPI; vote volume without outcome quality; treasury size as status; crypto revenue as the main criterion; speculative price; hype-driven engagement.

# 18. Trust, safety, and moderation

## 18.1 Policy categories

Clear policies for: illegal content; credible threats and incitement; harassment and targeted abuse; hate and dehumanization; sexual exploitation and child safety; graphic or shocking content; medical, civic, and crisis misinformation; impersonation and deceptive identity; spam and platform manipulation; privacy violations and doxxing; synthetic-media disclosure; intellectual-property reports.

## 18.2 Moderation layers

| Layer | Function |
|---|---|
| User controls | Mute, block, report, hide topic, reduce personalization. |
| Automated pre-checks | Detect obvious spam, malware links, duplicate floods, policy-risk content. |
| Community stewardship | Context repair, duplicate merge, branch organization, soft warnings. |
| Professional moderation | Policy enforcement, urgent safety, appeals. |
| Integrity review | Coordination, brigading, bot activity, suspicious campaigns. |
| External escalation | Legal, child safety, imminent harm, regulator requests. |

## 18.3 Moderation UX and transparency

Reports are simple from a long-press; report reasons are specific; emergency report flows are separate from ordinary disagreement; users can block accounts immediately; safety-hidden content shows a clear state rather than disappearing silently where possible; moderation notices are readable and include an appeal path. Following DSA-style patterns where applicable and as best practice elsewhere: notice-and-action mechanisms; statements of reasons for significant decisions; transparency reporting; user-facing explanation of recommender main parameters; non-personalized/less-personalized feed options; and internal systemic-risk assessment.

## 18.4 UGC safety requirements (channel-independent)

Mandatory in the PWA and required by law for a user-content platform (e.g. EU DSA), independent of any store: a mechanism to report offensive/harmful content; timely moderation; user blocking; filtering or default hiding of objectionable material as required; age assurance and a Licio-published self-declared content rating (no app store supplies one); and policies against bullying, threats, and abuse.

## 18.5 Crypto-enabled abuse and financial integrity

Knomosis-enabled rooms introduce new abuse modes. T&S policy explicitly covers: wallet-drainer links and malicious signature prompts; impersonation of stewards, rooms, journalists, grant recipients, and support; bounty collusion and fake completion evidence; vote buying, coercion, bribery; treasury capture; sanctions evasion and suspicious transaction patterns; paid harassment/brigading/report-abuse/disinformation; misleading investment claims and undisclosed paid promotion; fraudulent grants, fake charities, fabricated invoices; and attempts to use DAO votes to reveal private moderation/reporting information. Responses include link interstitials, proposal challenges, treasury freezes, room-governance freezes, wallet risk labels, user sanctions, law-enforcement escalation where appropriate, and public incident notes when a treasury is materially affected.

# 19. Privacy and data protection

## 19.1 Posture and data minimization

**Absolute data-minimization default (project-wide).** Licio collects the
absolute minimum information necessary to operate, and this is the default for
**every** workstream — not only attention handling. In particular, the platform
**never records, persists, logs, or even reads user IP addresses or any
geolocation**, including coarse country-level location. The application layer
does not read the client network address at all — not transiently, not hashed:
no code path reads the forwarded-address headers or the socket remote address
(enforced by a static test). Abuse and rate-limiting defense is therefore
**identity-free by construction**: per-account progressive lockouts (keyed by a
non-reversible ref of the account under attack — first-party data), per-target
cooldowns (e.g. at most one email per mailbox per window, keyed by the protected
resource), and global per-endpoint budgets (one process-wide counter that
distinguishes no one). Connection-level flood fairness is the edge/gateway's
concern, where packet routing already requires addresses; that information stays
outside the application boundary. No persisted data structure contains an IP or
a location field. There is no geolocation lookup of any kind (no MaxMind or
equivalent IP-to-country database). "Local" content features, where offered, are
driven by an explicit user-chosen region preference (a content topic), never by
detecting or inferring where the user physically is. This default may not be
weakened by a later feature without an explicit, documented privacy-review
exception (Section 32.4).

Attention signals are sensitive, so attention measurement is privacy-preserving,
bounded, transparent, and controllable. Collect only attention events needed for
PWAtt and safety; prefer in-browser feature extraction over raw event upload;
upload aggregated attention features rather than raw scroll traces where
possible; **never collect a user's geolocation** (a story may carry a *content*
location describing where a news event happened — a property of the event, not
of the reader); never sell attention data or use it for behavioral advertising;
retain raw event logs for the shortest feasible period; provide account export
and deletion.

## 19.2 Attention-signal handling

| Data | Default handling |
|---|---|
| Raw scroll/touch events | Process in the browser; discard after feature extraction. |
| Active dwell estimate | Upload aggregated per item/session with caps. |
| Source opens | Upload event with item/source ID; no full browsing history outside the app. |
| Context opens | Upload aggregate; used for ranking and UI improvement. |
| Draft text | Stored locally (IndexedDB); synced encrypted if the user enables sync. |
| Private saves | Private; low/no ranking effect unless the user opts into an aggregate signal. |
| Sensitive-topic interest | Protected; shorter retention and stricter use limits. |

## 19.3 User controls

Users can view the Signal Ledger; disable personalized recommendations; reset topic history; delete attention history; export account data; choose local vs server personalization; set notification quiet hours; disable cross-device sync; and request moderation data related to their account where legally feasible.

## 19.4 Children and minors

The default product is not directed to children under 13. Any jurisdiction supporting younger users requires compliant parental consent, data minimization, retention limits, advertising restrictions, and age-appropriate design. Teens default to stricter privacy, reduced personalization, limited direct contact, safer recommendations, and stronger filters. Minors are excluded from wallet, payment, treasury, and governance-signing features.

## 19.5 On-chain privacy and data minimization

On-chain data can be copied, indexed, clustered, and linked to off-chain identities. Therefore: do not place personal data on-chain unless legal review approves a specific field and retention cannot be satisfied off-chain; never place attention/reading/report history, private moderation data, reporter identities, minors' data, sensitive inferences, device IDs, IPs, private messages, or account-security events on-chain; use off-chain records with on-chain hash commitments where auditability is needed; show users before signing when an action is public, durable, and linkable; keep civic identity separate from wallet identity by default; let users hide wallet labels even though on-chain activity remains externally observable; provide privacy-preserving treasury views; apply small-cohort suppression to analytics combining wallet and civic activity; treat wallet addresses as personal data where applicable; and document that off-chain records can be deleted/anonymized but public chain records cannot be erased by Licio.

# 20. Distribution, delivery, and update architecture

## 20.1 Delivery model

Licio is delivered as a single Progressive Web App served over HTTPS from Licio's own infrastructure. There is no native binary and no app store. This is the optimal model given the constraints: a web app is not subject to Apple/Google review, so the GPL-3.0/App-Store license conflict does not arise and the app-store crypto-policy restrictions do not apply.

1. **Reach.** One responsive codebase serves iOS (Safari), Android (Chromium and others), and desktop browsers.
2. **Install.** The Web App Manifest enables add-to-home-screen on iOS, WebAPK install on Android, and desktop install; maskable icons, splash, theme color, and standalone display are provided.
3. **Update.** Updates are ordinary deployments; the service worker manages cache versioning and prompts for activation. There is no review latency and no store-approval risk; rollback is a redeploy.
4. **Offline and capability boundaries** are handled per Sections 6.9 and 6.11.

## 20.2 Trust and integrity without a store

Because no store vouches for the code, Licio assumes the integrity role explicitly — critical for a UGC + wallet app, where a single compromised bundle could drain wallets:

1. **Transport and content security.** HSTS, TLS, a strict Content-Security-Policy with `require-trusted-types-for 'script'`, `frame-ancestors` to prevent clickjacking, Subresource Integrity for any third-party asset, and a minimal, pinned dependency set.
2. **Supply-chain integrity.** Reproducible builds of the web bundle; published build provenance (Sigstore/cosign signatures plus in-toto attestations) recorded in an append-only transparency log, so a backdoored or targeted bundle cannot be served without public evidence.
3. **Subresource and worker integrity.** The service worker scope is locked down; no remote code evaluation; third-party scripts are avoided or SRI-pinned.
4. **Authentication.** WebAuthn/passkeys as the preferred, phishing-resistant credential (Section 25.3).
5. **Anti-impersonation.** Licio publishes its canonical domain prominently; onboarding and the wallet risk interstitial warn against look-alike domains, phishing PWAs, and fake "Licio" installs — the web equivalent of the repackaged-build threat.

## 20.3 Discovery, onboarding, and age assurance

Without store search: invest in web discovery (the Licio site; shareable story/thread links that render as installable pages); first-run guidance on installing safely and enabling notifications, with explicit "this is the official source" cues; and Licio's own age gating plus a self-declared content rating, since no store supplies one. Minors remain excluded from wallet/payment/treasury/governance-signing by default.

## 20.4 Licensing posture

1. **Network-served code: AGPL-3.0-or-later.** Because the PWA and backend are delivered over a network, GPL-3.0 alone would not require sharing modifications with remote users (the network/SaaS gap); AGPL-3.0 closes it, matches the project's open-source values, and is explicitly compatible with GPL-3.0 and with Knomosis's GPL-3.0-or-later terms.
2. There are no app-store distribution terms to conflict with copyleft, which is precisely why PWA-only delivery resolves the original blocker. The license decision is re-reviewed whenever the dependency graph changes; an SBOM cross-check confirms compatibility with all third-party licenses.

## 20.5 Out of scope

Native iOS/Android binaries, the Apple App Store, Google Play, F-Droid, sideloading, alternative marketplaces, and notarization are out of scope. A native wrapper (e.g. Capacitor/Tauri) is not part of this plan and would reintroduce the licensing/crypto-policy analysis it is designed to avoid; it would require a separate, reviewed decision.

# 21. Backend architecture

## 21.1 Services

API gateway; web BFF (backend-for-frontend) for the PWA; identity and account; content ingestion; source and claim; conversation; contribution; ranking; invariant computation platform; moderation and safety; integrity; search and discovery; notification (Web Push/VAPID); analytics and experimentation; transparency and audit; admin/steward console; and the Knomosis domain services (gateway, wallet identity, treasury, governance, law-pack registry, compliance gateway, on-chain indexer, ledger reconciliation, financial case management).

## 21.2 Storage

| Store | Use |
|---|---|
| Relational database | Accounts, permissions, content metadata, moderation cases. |
| Graph store | Threads, claims, evidence links, community relations. |
| Vector store | Embeddings for content, claims, sources, lenses. |
| Object storage | Attachments, snapshots, logs, exports. |
| Event stream | Attention aggregates, contributions, moderation events. |
| Feature store | Ranking and invariant features (payment/wallet fields excluded). |
| OLAP warehouse | Audits, transparency reports, experiments. |
| Secure secrets store | API keys, certificates, signing keys (never in the client bundle). |

## 21.3 Event-driven processing

Core topics: `content.submitted`, `content.normalized`, `source.opened.aggregate`, `attention.aggregate`, `contribution.created`, `evidence.added`, `claim.updated`, `thread.state.changed`, `moderation.case.created`, `integrity.signal.detected`, `invariant.run.completed`, `ranking.decision.logged`, `notification.sent`, `privacy.request.created`. Knomosis topics: `wallet.link.requested`, `wallet.linked`, `payment.intent.created`, `payment.intent.failed`, `payment.receipt.indexed`, `room.governance.mode.changed`, `governance.proposal.created`, `governance.signature.recorded`, `governance.proposal.executed`, `governance.proposal.challenged`, `treasury.deposit.indexed`, `treasury.grant.approved`, `treasury.payout.executed`, `knomosis.action.preflighted`, `knomosis.action.submitted`, `knomosis.event.indexed`, `compliance.financial.case.created`, `jurisdiction.feature.disabled`.

## 21.4 Invariant computation platform

Each invariant service supports batch computation for audits; near-real-time approximation for ranking; feature versioning; model/invariant cards (owner, version, input/output schema, confidence, coverage, known failure modes); reproducible runs; access controls; human-readable explanations; and regression tests on synthetic and labeled datasets.

## 21.5 Service boundaries and Knomosis isolation

| Service | Owns | Does not own |
|---|---|---|
| Ranking | Candidate scoring, constraints, explanations. | Policy-enforcement decisions. |
| Integrity | Coordination, spam, manipulation signals. | Final moderation for ambiguous speech. |
| Moderation | Policy actions, reports, appeals. | Ranking optimization. |
| Invariants | Mathematical feature computation. | Product policy thresholds. |
| Privacy | Consent, deletion, retention, export. | Feed relevance. |
| Conversation | Thread structure, contributions, branches. | Identity verification. |

Knomosis is an isolated bounded context: ranking services read only sanitized, aggregate governance context, never wallet wealth or payment amounts; analytics may not join wallet addresses to attention histories without an approved privacy case; T&S sees financial-abuse signals under role-based access with audit logging; compliance-partner responses are never reused for ranking/personalization/ads; production contract addresses and law-pack hashes are configuration-managed and deploy-gated.

# 22. Data model

## 22.1 Core entities

    User { user_id, handle, display_name, account_state, created_at, locale,
           age_band_if_known, privacy_settings, personalization_settings,
           reputation_summary_private }

    Story { story_id, canonical_url, title, submitted_by, source_id, language,
            topic_ids, location_scope, sensitivity_labels, lifecycle_state,
            created_at, updated_at }

    Thread { thread_id, story_id, room_id, branch_index, current_summary_id,
             conversation_state, safety_state, created_at }

    Contribution { contribution_id, thread_id, user_id, type, body, citations,
                   target_claim_id, parent_contribution_id, edit_history_ref,
                   moderation_state, created_at }

    EvidenceCard { evidence_id, claim_id, source_id, submitted_by, evidence_type,
                   citation_url_or_ref, relevance_note, verification_state,
                   independence_group_id }

    AttentionAggregate { aggregate_id, user_id_or_privacy_bucket, story_id,
                         session_bucket, active_dwell_bucket, source_opened,
                         context_opened, branch_depth_bucket,
                         return_visit_count_bucket, privacy_level, created_at }

    InvariantOutput { invariant_output_id, invariant_type, target_type, target_id,
                      time_window, version, score_vector, explanation_summary,
                      confidence, created_at }

## 22.2 Knomosis and treasury entities

These live in a separate bounded context from feed ranking and ordinary social analytics (Section 21.5).

    WalletAccount { wallet_account_id, user_id, address_hash, address_truncated,
                    chain_id, wallet_type, linked_at, unlink_state, risk_state,
                    last_used_at }

    KnomosisDeployment { deployment_id, environment, chain_id, l1_bridge_address,
                         runtime_endpoint_ref, contract_manifest_hash,
                         pinned_knomosis_commit, status, created_at }

    RoomGovernanceProfile { room_id, governance_mode, law_pack_id,
                            charter_version_id, treasury_id, quorum_policy_ref,
                            threshold_policy_ref, timelock_policy_ref,
                            jurisdiction_policy_id, freeze_state }

    LawPack { law_pack_id, version, knomosis_commit, schema_version, human_summary,
              machine_spec_ref, hash_commitment, fixture_corpus_ref, audit_state,
              effective_at }

    RoomTreasury { treasury_id, room_id, deployment_id, treasury_address,
                   accepted_assets, balance_snapshot_ref, deposit_limits_ref,
                   spend_limits_ref, freeze_state, reconciliation_state }

    GovernanceProposal { proposal_id, room_id, proposer_user_id, proposal_type,
                         title, plain_language_summary, structured_payload_ref,
                         requested_amount, asset, recipient_ref,
                         conflict_disclosures_ref, preflight_state, voting_state,
                         challenge_state, execution_state, created_at, executed_at }

    GovernanceSignature { signature_id, proposal_id, user_id, wallet_ref,
                          signature_type, typed_data_hash, signature_ref,
                          weight_snapshot, eligibility_reason, created_at }

    TreasuryGrant { grant_id, room_id, treasury_id, proposal_id,
                    recipient_user_id_or_entity, recipient_wallet_ref, purpose,
                    amount, asset, milestone_state, review_state, payout_state,
                    audit_summary }

    PaymentIntent { payment_intent_id, user_id, room_id, target_type, target_id,
                    asset, amount, jurisdiction_state, compliance_state, quote_ref,
                    expiration, execution_state, receipt_ref }

    KnomosisActionRecord { action_record_id, deployment_id, action_type, room_id,
                           actor_ref, payload_hash, typed_data_hash,
                           signed_action_ref, submission_state, indexed_event_ref,
                           reconciliation_state }

    OnChainEvent { event_id, deployment_id, chain_id, block_number, tx_hash,
                   log_index, event_type, decoded_payload_ref, reorg_state,
                   indexed_at }

    JurisdictionFeaturePolicy { policy_id, country_or_region, feature_flags,
                                asset_flags, age_gate_policy, kyc_policy,
                                disclosure_refs, legal_approval_ref, effective_at }

    FinancialComplianceCase { case_id, user_id_or_room_id, trigger_type, risk_level,
                              partner_case_ref, review_state, resolution,
                              retention_policy, created_at }

## 22.3 Relationship graph

Key edges: User contributed to Thread; Story cites Source; Claim supported-by / challenged-by Evidence; Contribution replies-to Contribution; Contribution clarifies Claim; Story duplicates Story; Source syndicated-from Source; Room has Lens; Lens interprets Story; Moderator-action targets Contribution.

## 22.4 Data retention defaults

| Data class | Suggested retention |
|---|---|
| Account data | While active plus legal retention period. |
| Public contributions | Until deleted, removed, or archived by policy. |
| Raw client attention events | Prefer not uploaded; if uploaded for debugging, ≤ 7 days. |
| Aggregated attention features | 90–180 days unless needed for audit, then anonymize. |
| Ranking decision logs | 180–365 days with access controls. |
| Moderation logs | Longer retention based on policy/legal need. |
| Security logs | Based on risk and legal requirements. |
| Deleted-account personal data | Delete or anonymize per policy and law. |

# 23. API specification

## 23.1 Style

A web BFF (Hono, Section 6.12.8) with end-to-end type-safe contracts (Hono RPC for the PWA client; OpenAPI for external consumers). Internally, services use gRPC or event streams; the PWA calls stable endpoints through the BFF over HTTPS, with short-lived tokens, secure `SameSite=Strict` cookies with CSRF protection (Hono CSRF middleware), and object-/action-level authorization. Every request and response payload is validated at runtime by `zod` schemas that are co-located with the TypeScript route types, so compile-time and runtime contracts cannot silently diverge (Section 6.12.9).

## 23.2 Core endpoints

| Endpoint | Method | Purpose |
|---|---|---|
| `/v1/feed/front-page` | GET | Ranked feed with explanations. |
| `/v1/rooms` | GET | List joined and recommended rooms. |
| `/v1/stories` | POST | Submit link or original story. |
| `/v1/stories/{id}` | GET | Story detail and context. |
| `/v1/threads/{id}` | GET | Thread overview and branch index. |
| `/v1/threads/{id}/branches/{branch}` | GET | Branch content. |
| `/v1/contributions` | POST | Create structured contribution. |
| `/v1/evidence` | POST | Add evidence card. |
| `/v1/reports` | POST | Report content or account. |
| `/v1/signal-ledger` | GET | Private signal explanation. |
| `/v1/privacy/export` | POST | Request export. |
| `/v1/privacy/delete-attention` | POST | Delete attention history. |
| `/v1/feed/preferences` | PATCH | Update personalization and feed mode. |

## 23.3 Representative payload shapes

    FeedItem { story_id, title, source_summary, rating_label, distribution_reason,
               context_chips[], reader_state, thread_preview, safety_state,
               user_controls }

    CreateContributionRequest { thread_id, type, body, parent_id_optional,
                                target_claim_id_optional, citations[], attachments[],
                                local_draft_id, client_integrity_token }

    RankingDecisionLog { request_id, user_privacy_bucket, candidate_ids,
                         selected_ids, score_components, invariant_versions,
                         constraints_applied, explanation_ids, experiment_ids,
                         timestamp }

## 23.4 Knomosis, wallet, treasury, and governance endpoints

Financial/governance APIs are versioned, idempotent, audit-logged, and separated from social APIs.

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

## 23.5 API requirements

Financial and execution endpoints require idempotency keys; write actions require anti-replay nonces and explicit expirations; wallet-link verification accepts both ECDSA `ecrecover` (EOAs) and EIP-1271 `isValidSignature` (contract wallets), authenticated with EIP-4361 over EIP-712 typed data, validating domain, chain ID, address, expiration, and nonce; responses include mobile-readable status, next action, and disabled-state reason; financial actions produce immutable audit records; sensitive compliance fields are access-controlled and excluded from analytics by default; event indexing is reorg-aware and reconciliation-safe; user-facing summaries and machine payloads are paired by hash; contract-address allowlist checks run on every production action; and the API distinguishes **submitted, accepted, settled, finalized, challenged, reverted, frozen,** and **failed** states.

# 24. AI and machine learning specification

## 24.1 Use cases and limits

AI may support topic classification, duplicate detection, claim extraction, evidence linking, toxicity/safety triage, thread-summarization drafts, translation, ranking candidate retrieval, context-obstruction estimation, coordination features, and accessibility alt-text suggestions. AI is never the sole authority for high-impact moderation unless policy defines a narrow emergency class, and AI never autonomously spends funds, approves proposals, or issues final sanctions.

## 24.2 Responsible-AI requirements

Maintain model cards for ranking, safety, summarization, and invariant models; maintain data lineage for training/evaluation; conduct bias and subgroup audits; use human review for appeals and ambiguous cases; label AI-generated summaries; preserve source citations for generated summaries; allow users to report bad summaries/translations; avoid unsupported factual claims; log model version and prompt/configuration for audit-sensitive outputs; apply red-team testing before launch; and maintain an AI inventory with risk assessments aligned to the NIST AI RMF and ISO/IEC 42001.

## 24.3 Summarization constraints

Summaries must cite source branches and evidence cards; distinguish facts, claims, and interpretations; preserve uncertainty; identify unresolved questions; avoid synthesizing harassment or slurs unnecessarily; avoid presenting the majority view as truth merely because it is common; and support correction workflows.

## 24.4 Ranking-ML constraints

The ranking model may learn weights but must obey hard constraints from safety, privacy, and invariant guardrails. It cannot override content removals, severe coordination freezes, minor-safety limits, user personalization-off settings, privacy deletion/retention states, or accessibility-critical rendering rules. Wallet, token, payment, and treasury fields are excluded from organic ranking features by schema and verified by audit (Section 30.6).

## 24.5 AI around Knomosis governance

Permitted: summarize proposals in plain language; identify missing budget fields, citations, or unclear recipients; compare a proposal against the charter and law-pack template; highlight possible conflicts of interest for steward review; translate governance summaries; generate accessible explanations of treasury actions; detect scam-associated language patterns. Prohibited: autonomous treasury execution; investment or personalized financial advice; manipulative voting recommendations; predictive profiling of user wealth or financial vulnerability; rewriting proposals to hide risk or recipient identity; using wallet wealth to personalize feeds. Any AI proposal summary shows citations to proposal fields, flags material uncertainty, and is editable/contestable by stewards.

# 25. Security specification

## 25.1 Baseline

The PWA security program aligns with OWASP ASVS for the web application, OWASP MASVS-style controls for the installed home-screen surface, and NIST CSF 2.0 for organizational governance. The threat model treats the browser as a shared, hostile-adjacent environment and treats every wallet signature as a high-risk action.

## 25.2 Web and PWA security

XSS is the dominant risk for a UGC platform that also connects wallets — a single injection could trigger a malicious signature and drain funds — so defense-in-depth against it is paramount:

1. **Output safety:** all user content is rendered through a strict, allow-list sanitizer; **Trusted Types** (`require-trusted-types-for 'script'`) are enforced where supported, with a strict CSP (`default-src 'self'`, no inline scripts, nonce/hash-based scripts, `object-src 'none'`, `base-uri 'self'`) as the cross-browser backstop.
2. **Markdown-lite** is parsed to a safe AST; raw HTML, `javascript:`/`data:` URLs, and event-handler attributes are stripped; links are normalized and interstitialed for wallet-drainer patterns.
3. **Clickjacking:** `frame-ancestors 'self'`; wallet and signing flows are never embeddable.
4. **Transport:** HSTS preload, TLS, secure cookies (`HttpOnly`, `Secure`, `SameSite=Strict` or `Lax` with CSRF tokens for cross-site posts).
5. **Service worker:** locked scope, integrity-verified updates, no remote code evaluation, careful cache partitioning so one origin's data cannot poison another.
6. **Supply chain:** minimal pinned dependencies, SRI for any third-party asset, SBOM, dependency and secret scanning, reproducible bundle builds with published provenance (Section 20.2).
7. **No secrets in the client:** no API secret, signing key, or seed phrase is ever embedded in or handled by the bundle.
8. **Storage:** drafts and tokens use the most protected browser storage available; sensitive values are encrypted at rest in the browser where feasible; the client assumes storage may be evicted or inspected and never persists secrets.

## 25.3 Account security

WebAuthn/passkeys as the preferred, phishing-resistant authentication. **Authentication is passwordless: Licio uses no passwords and has no password-reset flow.** The fallbacks -- for devices/browsers without a platform authenticator, and offered depending on jurisdiction and risk -- are a single-use one-time code sent to a verified email and, for adults who opt in, Sign-In with Ethereum (EIP-4361, verified per Section 25.6); SMS/phone codes are deliberately not used as a factor (SIM-swap and privacy concerns). The authentication-wallet credential is kept domain-separated from the financial wallet identity so logging in with a wallet does not link it to payments/governance (Section 19.5). Multi-factor (TOTP) for stewards and moderators; session management and a device list labelled by a coarse device descriptor only (never an IP or location, Section 19.1); **new-device sign-in alerts** (the security-alert feature compares only a coarse device descriptor, never an IP, country, or any geolocation — there is no geo-IP lookup); rate limits for credential attacks that are identity-free by construction (per-account lockouts, per-target cooldowns, and global budgets — the application never reads the client address, Section 19.1); abuse-resistant account recovery via remaining enrolled factors rather than any resettable shared secret.

## 25.4 Backend security

Service-to-service authentication; strong object-/action-level authorization; encryption at rest for sensitive data; secret rotation; audit logging; least privilege; data-access reviews; vulnerability management; dependency scanning; incident-response playbooks; backups and disaster recovery; abuse-aware rate limiting.

## 25.5 Integrity threats and abuse defense (no device attestation)

Because a PWA cannot use native attestation, abuse defense is server-side and behavioral:

| Threat | Mitigation |
|---|---|
| Bot/sock accounts | Account-age and trust tiers, behavioral analysis, proof-of-work/turnstile challenges, MFCI, WebAuthn. |
| Coordinated brigading | MFCI, tropical cascade, report-delay mechanisms. |
| Duplicate spam | MERI, URL canonicalization, source lineage. |
| Harassment raids | Safety queues, target protection, distribution freeze. |
| Source spoofing | URL normalization, domain verification, link-preview safeguards. |
| Model gaming | Feature caps, randomized audits, adversarial testing. |
| Screenshot context removal | Share cards with origin/context metadata. |
| Forged attention events | Server-side validation, replay protection, rate limits, integrity tokens; client aggregates treated as hints, never sole truth. |
| Phishing PWA / look-alike domain | Canonical-domain education, anti-impersonation onboarding, signed provenance (Section 20.2). |

## 25.6 Wallet, smart-contract, and Knomosis security

Use EIP-712 typed-data signing with domain separation, nonces, expirations, and chain IDs; authenticate linkage with EIP-4361 and verify both ECDSA `ecrecover` (EOAs) and EIP-1271 `isValidSignature` (contract wallets/multisigs); maintain production contract allowlists and block unknown contract interactions; run transaction simulation and human-readable previews before signing; never request, store, transmit, or log private keys or seed phrases; pin the Knomosis commit, ABIs, contract addresses, runtime versions, and law-pack hashes per environment; validate Knomosis Lean/Solidity/Rust cross-stack fixtures in CI before deployment; use least-privilege keys for indexers, gateway workers, treasury operators, and deployment scripts; store any platform signing keys in HSM/KMS with separation of duties; use multisig and timelocks for treasury execution above low thresholds; monitor event ingestion, reorgs, deposits, withdrawals, challenge windows, and suspicious calls; provide emergency feature flags for wallet connection, payment-intent creation, action submission, treasury execution, and governance voting; run external audits before mainnet funds and after material law-pack/contract changes; include wallet-drainer phishing simulations in security testing; provide just-in-time warnings for approvals, blind signing, unknown recipients, and irreversible transfers; and maintain an incident-specific communications plan for financial exploits.

# 26. Accessibility and inclusive design

## 26.1 Baseline

Target WCAG 2.2 AA across the PWA on mobile and desktop. Because the app is the web, accessibility is achieved through correct semantic HTML, ARIA where needed, and full keyboard/screen-reader support — and is a release gate, since for many iOS users the PWA is the only surface.

## 26.2 Requirements

Screen-reader support (VoiceOver, TalkBack, NVDA, JAWS) via semantic landmarks and labels; logical focus order; **focus management on single-page-app route changes** (move focus to the new view's heading, announce changes via live regions); semantic headings in long threads; dynamic type and browser zoom to 200% without loss of content or function (reflow); large touch targets (target-size minimum); reduced-motion mode for thread transitions and the Civic Map; captions and transcripts for media; high-contrast themes and non-color-only status; accessible composer error states tied to fields; draft recovery after interruption; and accessible transaction previews and governance decisions that remain readable with large text and assistive technology.

## 26.3 Cognitive accessibility

Thread overview before deep branches; summaries with unresolved questions; progressive disclosure for mathematical/ranking explanations; plain-language labels; reading estimates; an "explain like I am new" lens where appropriate; and saving/returning without losing place.

## 26.4 Internationalization

Full localization pipeline for UI strings; right-to-left support; language-specific tokenization and embeddings; translation disclosure with access to original text; region-sensitive legal/cultural policy handling; and local moderator/steward capacity before launching language communities.

# 27. Monetization and incentives

## 27.1 Business model

Licio avoids behavioral advertising that monetizes attention extraction. Revenue sources: paid supporter subscriptions; organization/team subscriptions for research and moderation tools; grants for public-interest information infrastructure; contextual sponsorships strictly separated from ranking; paid API access for aggregate, privacy-preserving research data; and optional creator/journalist support pools based on evidence and participation value, not likes. As an AGPL-licensed product, Licio can also pursue hosted-service, support, and open-source-grant funding without proprietary lock-in. Not using app-store in-app purchase removes the 15–30% platform commission and the IAP requirement, so voluntary support and treasury flows occur directly.

## 27.2 Advertising constraints

If advertising exists: no behavioral microtargeting based on attention history; no political microtargeting; clear labels; contextual placement only; no ads in child-directed experiences; ads cannot affect PWAtt ranking; advertisers cannot access individual attention ledgers.

## 27.3 Incentive alignment

Reward useful evidence, accurate correction, context repair, constructive disagreement, synthesis, stewardship, and source diversity. Do not reward outrage farming, repetitive posting, context removal, follower accumulation, harassment, coordinated trend gaming, or low-information replies.

## 27.4 Crypto monetization and treasury fees

Permitted (subject to law): a disclosed platform fee on optional room-treasury services; disclosed payment-processing pass-through; paid organizational governance/audit tooling; grants and philanthropic funding; optional user support payments where permitted; hosted compliance/accounting/transparency services for larger rooms. Prohibited: token sales marketed as investments; paid boosts for posts/rooms/creators/search; revenue share tied to engagement farming; crypto rewards for posting/commenting/inviting/time; hidden spreads or undisclosed exchange fees; lending/yield/staking/rehypothecation of user/room assets without explicit legal approval and consent; selling wallet-derived targeting segments; selling access to private governance or compliance data. Any fee must be simple, capped, and disclosed before payment; fees cannot vary by viewpoint, story sensitivity, or creator identity, and cannot buy distribution; treasury accounting separates user/room assets, platform fees, processor fees, and network fees; refunds, failed transactions, and mistaken transfers have documented support paths even when on-chain reversibility is impossible.

# 28. Metrics and experimentation

## 28.1 Product-health metrics

Constructive-participation rate; source-open rate; evidence-addition rate; question-resolution rate; MERI distribution; SCOI reduction after bridge/synthesis; MFCI incidents by severity; GWEI cohort disparity; PHI steering-risk distribution; harassment-protection latency; appeal-overturn rate; accessibility-defect rate; and Core Web Vitals (LCP, INP, CLS) at p75.

## 28.2 Experimentation rules

No experiment may introduce likes, upvotes, public reaction counts, or follower leaderboards; ranking experiments must include safety, MERI, MFCI, GWEI, SCOI, and PHI metrics; experiments on minors or sensitive topics require stricter review; experiments have rollback switches; major user-facing changes require notice; experiment logs include invariant versions; and experiments optimizing attention must also monitor wellbeing and participation quality. No launch uses engagement alone as a success criterion.

## 28.3 Knomosis governance and payment metrics

| Metric | Definition | Guards against |
|---|---|---|
| Public-value grant completion | Funded grants producing accepted evidence/context outputs. | Treasury waste. |
| Transaction comprehension | User-test success on transaction-preview meaning. | Blind signing. |
| Treasury-transparency completeness | Treasury actions with clear proposal/recipient/amount/outcome. | Dark-money governance. |
| Governance diversity | Participation breadth across eligible civic accounts (not wallet wealth). | Capture. |
| Proposal-dispute rate | Proposals challenged for conflict/fraud/policy. | Unaccountable execution. |
| Financial-incident rate | Confirmed scams/fraud/mistaken transfers/compromise per active wallet. | Unsafe expansion. |
| Pay-to-rank leakage | Measured correlation between payments and ranking after controls. | Wealth-driven visibility. |
| Treasury-reconciliation gap | Divergence between app ledger, Knomosis receipts, and L1 state. | Must be zero or explained before expansion. |

Do not optimize for total value locked, tokens traded, wallet connects, speculative price, or treasury size.

## 28.4 Success metrics by phase

**Alpha:** users understand why content is shown; the structured composer does not block participation; MERI dedup improves perceived feed quality; source-opening and evidence-addition are measurable; moderation tools handle early abuse. **Beta:** PWAtt outperforms chronological on user-rated usefulness; coordinated activity is detected without high false positives; context cards reduce cross-community misunderstanding; Core Web Vitals targets are met; accessibility audits pass core flows. **GA:** transparency reports generate from live data; invariant dashboards are stable; appeals are operational; ranking experiments have release gates; security and accessibility reviews pass.

# 29. Operational workflows

## 29.1 New story

User submits a link via the browser share target or the Submit tab → client captures URL, title, optional reason → backend normalizes URL and detects duplicates → story shell created or existing story reopened → initial thread summary and context cards generated → feed candidates receive a baseline rank → as users read and contribute, PWAtt grows or dampens → invariant services update state → the story moves through lifecycle labels.

## 29.2 New contribution

User opens the composer → selects a contribution type → app prompts for relevant fields → draft saved locally → client checks obvious errors and missing citations → backend runs safety and spam checks → contribution appears in the appropriate branch → invariant features update → user receives private feedback in the Signal Ledger if the contribution meaningfully improved thread state.

## 29.3 Coordination incident

MFCI or tropical cascade detects an unusual pattern → integrity service assigns severity → ranking slows or freezes acceleration if the threshold is met (sub-minute path uses cheap statistics; exact fiber test confirms) → an integrity analyst receives a case summary with preserved margins and baselines → a moderator may merge duplicates, label review state, restrict accounts, or clear a false positive → the public thread label updates if distribution is affected → the case outcome is logged for the transparency report.

## 29.4 Context obstruction

SCOI detects split/obstructed interpretations → feed cards show "Needs Context" → the thread requests bridge/synthesis contributions → users in relevant lenses are invited → a steward creates or approves a context patch → SCOI is recomputed → distribution expands when context is sufficiently repaired.

## 29.5 Wallet and payment

User opens a treasury contribution screen → app explains wallet use is optional and does not affect ranking → user links a wallet via a signed-message flow (or continues without where possible) → backend verifies domain, nonce, chain ID, signature path (ECDSA or EIP-1271), session, risk state, and jurisdiction availability → user requests a quote → app shows asset, amount, recipient, network, fees, finality, refund limits, public-ledger disclosure, and the non-ranking disclosure → user signs in the external wallet → ingestion records pending status → UI shows pending/confirmed/finalized/reverted/reorged/disputed/abandoned → treasury reconciliation updates the dashboard → user receives a public receipt and a private exportable receipt → support can handle stuck/failed/mistaken/suspicious transactions without ever asking for private keys.

## 29.6 Governance proposal

An eligible participant drafts a proposal from a template → a completeness check validates title, summary, type, scope, budget, conflicts, risks, requested action, and expected deliverable → the proposal enters a structured deliberation thread → users add evidence, objections, amendments, alternatives, and minority reports → invariant services flag coordination, redundancy, unresolved context, and high tension → platform risk review checks policy, legal, treasury, privacy, distribution, sanctions, tax, and security constraints → the ballot and execution payload are finalized (material changes restart review) → eligible participants vote → quorum/threshold checks run with anti-capture review → a timelock starts if the proposal passes → an allowlisted executor submits after final checks → the Knomosis receipt finalizes and the room publishes the result, budget change, dissent notes, and remediation options.

## 29.7 Treasury incident

Monitoring detects suspicious treasury movement, indexer divergence, a high-risk recipient, a governance-capture signal, or a contract alert → a treasury incident case opens with severity, affected room, assets, caps, pending transactions, and user impact → new deposits/proposals/executions can be paused independently and scoped → withdrawals/remediation remain available where technically and legally possible → security, legal, T&S, and finance review → a reconciliation worker snapshots the product DB, Knomosis receipts, and L1 observations → users see a safe status message that avoids leaking investigative detail → the incident resolves via cleared status, cap reduction, proposal cancellation, migration, remediation, or permanent feature disablement → a postmortem updates runbooks, caps, monitoring, copy, and audit evidence.

# 30. Implementation plan

This single plan replaces the earlier coarse phase list and the redundant duplicate plans of prior revisions. The goal is not the mathematically richest version first; it is a safe PWA that proves the no-like/no-upvote model, then progressively strengthens the invariant services, with Knomosis staged separately so crypto never blocks the core product.

## 30.1 Planning model

Every complex task ships as a thin vertical slice through four layers before sophistication is added: a **product slice** (a user-visible workflow), a **signal slice** (the minimal event/aggregation/privacy logic to measure it), an **invariant slice** (the smallest useful version of an invariant connected to that workflow), and an **operational slice** (the review, audit, support, and rollback path if it misbehaves).

## 30.2 Critical path

1. Product policy and the no-applause rating doctrine.
2. PWA design system and UGC safety flows.
3. Account, identity, privacy, reporting, blocking, and moderation foundation.
4. Privacy-preserving event pipeline for attention and contribution signals.
5. Story ingestion, source model, forum threads, structured contributions.
6. PWAtt shadow scoring and explanation logs.
7. MERI and MFCI shadow services.
8. Bounded ranking with hard anti-abuse gates and no payment inputs.
9. Closed alpha without crypto.
10. Knomosis simulation mode and governance UX with no real funds.
11. Testnet Knomosis gateway, wallet signing, receipts, and indexer.
12. External audit, legal review, compliance controls, and incident drills.
13. Capped production Knomosis pilot in approved rooms and jurisdictions.
14. Public expansion only after ranking, safety, privacy, and treasury metrics pass.

No crypto task blocks steps 1–9. The rule is: **PWAtt and MERI exist before public beta; MFCI runs at least in shadow before public beta; SCOI, GWEI, and PHI begin as dashboards/soft constraints before becoming strong ranking constraints; shadow before ranking; simulate before signing.**

## 30.3 Workstreams

- **A — Doctrine, policy, governance:** no-applause doctrine; allowed/prohibited signal matrix (prohibited: money, wallet connection, token holdings, payment amount, paid membership, treasury status, follower count); policy hierarchy; charter templates; moderation-escalation taxonomy; transparency-report data dictionary; jurisdiction/feature matrix.
- **B — PWA UX and design system:** information architecture; story cards with no applause affordances; ranking explanations; contribution chips; context cards; two-tap report/block/mute; AI-summary disclosure; wallet/governance screens; empty/loading/offline/error/restricted states; accessibility specs; usability testing.
- **C — PWA client:** app shell, routing, service worker, install, feature flags; auth/passkeys; core surfaces; UGC reporting/blocking/appeals; offline cache and background sync; in-browser attention aggregation; composer; explanation cards; optional wallet/governance modules behind flags; performance, accessibility, and security testing.
- **D — Identity, accounts, privacy:** identity states; minimal-profile account service that records **no IP address and no location** (Section 19.1); age gate (minors excluded from wallet/governance); consent and privacy settings; new-device sign-in alerts using a coarse device descriptor only (no IP, no geolocation, no geo-IP lookup); wallet-link table isolated from profile/attention/ranking; retention/deletion/export jobs; staff access controls and audit logs that contain no IPs or locations; privacy-review workflow.
- **E — Event pipeline and PWAtt:** event schema and classification; in-browser buffering with privacy filters; server ingestion/validation/replay protection/retention; PWAtt v0 shadow; participation-quality weighting; anti-signals; explanation logs; offline manipulation simulations; promotion to bounded ranking only after safety review.
- **F — Ingestion, source, search:** URL canonicalization and duplicate detection; source profiles; claim extraction and evidence linking; search indexing; freshness/correction/merge workflows; crawler safety and copyright handling; MERI and SCOI hooks.
- **G — Forum and conversation:** thread/branch/quote/evidence models; contribution taxonomy and composer; branch-quality scoring separate from popularity; moderation annotations and context patches; provenance-bearing summaries; rooms/lenses/steward roles; conversation-health metrics; Hodge and SCOI hooks; governance-discussion threads.
- **H — Core invariant services:** Section 30.4.
- **I — Ranking and distribution:** like/follower/wallet-independent candidate generation; feature store with allowlist/denylist; per-item decision logs; hard safety/legal/age/block filters; PWAtt as bounded input; MERI/MFCI/SCOI/PHI integration; GWEI experiment blocker; explanation service; ranking-neutrality tests (30.6); rollbacks and kill switches.
- **J — Trust, safety, abuse ops:** policy classifiers; moderation queues with SLAs; report/block/mute/appeal/restore/notice flows; room-level tooling; coordinated-abuse workflows using MFCI evidence; wallet-drainer/scam detection; governance-capture playbook; child-safety escalation; red-team exercises.
- **K — AI/model governance:** use-case and prohibited-use inventories; prompt/model registry and evaluation harness; provenance-preserving summaries; correction flow; bias/hallucination/safety/privacy tests; output logging; generated-content disclosure; governance-summary neutrality checks.
- **L — Knomosis gateway/wallets/receipts and M — forum-commons/law-packs/treasury:** Section 30.7.
- **N — Compliance, finance, distribution readiness:** region/feature policy engine; custody-model decision; jurisdiction/asset/sanctions/tax mapping; reproducible-build provenance and published signing keys; Licio-published financial-risk disclosures and content rating; compliance case management; suspicious-activity escalation; treasury accounting export; pre-release integrity review.
- **O — Security, reliability, incident response:** threat models; secure SDLC gates (review, dependency/secret scanning, SAST/DAST, web security testing, smart-contract testing, infra scanning); web hardening (CSP/Trusted Types/SRI); backend authz/encryption/key management; contract/gateway tests (access control, replay, signature validation, reentrancy, chain ID, nonce, withdrawal, emergency controls); external audits; observability/SLOs; incident runbooks; tabletop drills; bug bounty.
- **P — Experimentation, metrics, launch ops:** launch phases; quality/harm/fairness/wellbeing metrics; anti-metrics; experiment registry and launch review; transparency pipeline; rollout/rollback automation by region/room/flag/version; post-launch reviews; deprecation/archive process.

## 30.4 Core invariant build plans

Each invariant ships v0 → v2; all run in shadow before affecting ranking, and each output carries confidence, coverage, reason codes, and fallback behavior.

- **MERI:** v0 URL/text-similarity dedup; v1 multi-dimensional independence (source lineage, claim, evidence base, author network, lens, language, time); v2 matroid rank with learned independence constraints and explainable nonredundancy labels. *Gate:* reduces duplicate flooding without suppressing genuinely independent reporting.
- **MFCI:** v0 shadow anomaly reports with fixed margins; v1 analyst-reviewed dampening for high-confidence coordination; v2 Markov-basis/SMC sampling of the conditional fiber distribution plus adversarial-adaptation tests. *Gate:* flags coordination conditional on base rates; does not treat normal community interest as abuse; logs margins and statistics.
- **GWEI:** v0 descriptive cohort dashboards; v1 entropic-regularized GW over sampled cohort spaces with seed-stability reporting; v2 release-gating and mitigation recommendations. *Gate:* major launches cannot materially degrade structural experience parity without documented review; small cohorts are protected.
- **SCOI:** v0 lens-summary disagreement labels and steward reports; v1 sheaf-Laplacian Dirichlet-energy obstruction and bridge/context routing; v2 cohomological obstruction classes (nontrivial `H1`, harmonic representative) for persistent failures. *Gate:* high-obstruction content receives context before broad amplification; "Needs Context" never means false/banned.
- **PHI:** v0 narrow-loop/compulsive-session detection; v1 orthogonal transport estimation with high-risk-loop dampening; v2 gauge-invariant holonomy diagnostics. *Gate:* dampens manipulative loops without blocking intentional deep research; uses gauge-invariant summaries; logs reason codes and reversible gates.

## 30.5 PWAtt staging

**v0 (instrumented salience, no distribution power):** event schemas; in-browser aggregation and idle filtering; item-window summaries; private Signal Ledger; PWAtt does not rank yet. **v1 (bounded ranking input):** per-user/item/window saturation curves; source-open/return weighting; contribution-type weighting; anti-signals; MERI v1 redundancy dampening; safety-state constraints; mobile explanations. **v2 (context-aware civic distribution):** SCOI coherence gain; PHI path-risk dampening; GWEI release gates; experimental weights by surface/topic class; external transparency metrics. PWAtt can never be increased by passive autoplay, background time, bot loops, refresh loops, paid interactions, or wallet actions.

## 30.6 Ranking-neutrality verification suite

Automated tests prove financial features cannot become hidden ranking inputs: feed replay with and without wallet links yields identical ranking except for user-selected treasury surfaces; payment amount is absent from organic feature schemas; donor identity is absent from PWAtt and invariant joins; treasury balance does not change story rank except via a manually approved, non-amount public-interest prompt in a dedicated surface; governance vote outcomes do not change factual claim labels without evidence/steward process; paid membership does not bypass safety, rate limits, or moderation; sponsored/treasury-funded content is labeled and does not enter unpaid ranking; ML feature audits fail if wallet/token/payment/treasury fields are added to organic rankers without explicit approval; dashboards separate revenue/treasury metrics from product-health metrics; and public explanations state that payments are support/governance actions, not endorsements. The suite runs before and after every crypto release and must pass with real payment events in staging before any real-funds pilot.

## 30.7 Knomosis implementation plan

A separate critical path layered onto the social product. **K0 due diligence:** pin commit/toolchains/contracts; threat-model bridge/runtime/wallet/treasury/indexer; legal custody scoping; architecture-decision record; audit-requirement definition; license/copyleft analysis (AGPL/GPL). **K1 simulation:** governance tab, proposal templates, simulated treasury and audit log, MFCI shadow checks, comprehension testing, room-readiness checklist. **K2 testnet gateway:** wallet-link nonce/signature (ECDSA + EIP-1271); typed-data previews; gateway preflight/submit; reorg-aware indexing/reconciliation; unlink and disabled-state UX; integration tests. **K3 testnet treasury/bounty:** treasury entity and payment-intent lifecycle; bounty create/claim/review/challenge/payout; grant disclosure and COI fields; dashboard and audit log; financial case queue; abuse tests for collusion/fake-evidence/vote-buying. **K4 capped production pilot:** limited jurisdictions/rooms; non-custodial or partner payments under legal approval; low limits; deposits and capped grants only; monitoring for incidents, pay-to-rank leakage, support burden, capture; weekly review board; public transparency summary. **K5 mature governance:** more proposal types; delegated governance with revocation; law-pack migration; fork/exit; expanded accounting exports; external-audit portal; aggregate governance-research API; privacy-preserving cross-room health dashboards. Knomosis depends on the account system, room model, moderation, event stream/audit logs, secure UX foundations, T&S staffing, security incident response, legal readiness, financial operations, and MFCI shadow mode; Knomosis production never blocks story submission, reading/discussion, PWAtt ranking, MERI dedup, basic rooms, ordinary moderation, or non-wallet journeys.

## 30.8 Atomic task-card format

Each complex task is a card with: owner; product goal; smallest deliverable; dependencies; implementation steps; telemetry; privacy/security review required; test cases; failure states; rollback path; definition of done. A card should fit in one to three engineering days; larger tasks split until independently reviewable, testable, and reversible. Sizing rules: a backend task produces one schema/API/job/dashboard; a client task completes one user-journey state (empty, loading, success, error, offline, abuse/safety, accessibility); an invariant task defines input/output/confidence/failure-mode/one consumer; a moderation task defines policy reason/permissions/notice/appealability/audit event/rollback; a privacy task defines data element/purpose/retention/access/export/deletion/legal status; a release task includes feature flag/metric guardrail/owner/rollback trigger/review date.

## 30.9 Cross-functional acceptance gates

A feature cannot reach public beta unless it passes each gate: **Product** (supports no-applause; smuggles in no likes/reactions/karma); **PWA/Mobile** (works on target mid-range devices and 4G, supports interruption, passes core accessibility); **Privacy** (documented purpose, retention, control, deletion); **Security** (threat-model coverage; passes web and relevant automated/manual tests); **Safety** (reporting, blocking, review, action logging, appeals); **AI** (source-grounded, logged, evaluated, correctable); **Invariant** (confidence, coverage, reason codes, fallback); **Experiment** (quality/harm/privacy/fairness/wellbeing metrics, not only engagement); **Operations** (support, moderation, incident response, rollback ready); **Transparency** (logs support user explanations and aggregate reporting).

## 30.10 Phase and milestone plan

| Milestone | Scope | Exit criteria |
|---|---|---|
| M0 Planning | Doctrine, policy hierarchy, data inventory, architecture, Knomosis due diligence, jurisdiction matrix. | No forbidden-signal ambiguity; owners approve direction; crypto confirmed non-blocking for core alpha. |
| M1 Core social alpha | PWA shell, accounts, story submission, threads, structured contributions, reporting/blocking/moderation, source model, event pipeline, PWAtt shadow. | Read/submit/discuss/report/block/appeal without a wallet; PWAtt logs but does not rank; UGC safety implemented. |
| M2 Invariant shadow | MERI/MFCI/SCOI/PHI/GWEI in shadow; ranking decision logs; explanation cards; synthetic abuse testing. | Invariants produce stable, explainable outputs; no hidden sanctions; ranking allowlist excludes payments/wallet data. |
| M3 Bounded ranking beta | PWAtt bounded input; MERI dampening; MFCI abuse queue; SCOI context gates; PHI dampening; GWEI experiment audit. | Ranking reproducible from logs; ranking-neutrality tests pass; comprehension and safety metrics pass. |
| M4 Knomosis sim + testnet | Wallet optionality screens; governance simulation; gateway devnet/testnet; receipt indexer; law-pack registry; testnet treasury proposals. | Testnet receipts reconcile; users understand previews; law-pack migration and emergency hold tested; no launch-blocking security issues. |
| M5 Capped real-funds pilot | Approved rooms/jurisdictions; low treasury caps; limited assets; manual review above low thresholds; public transparency; weekly review board. | No critical payment/security/compliance incidents; no measurable ranking advantage from payments; records reconcile; manageable support/dispute load. |
| M6 Mature launch | More rooms/regions; expanded governance after evidence; auditor portal; research/transparency APIs; fork/archive/exit. | Core social value healthy without crypto; crypto/governance bounded and non-speculative; accessibility/safety/privacy/security/transparency thresholds met. |

## 30.11 Launch-readiness gate register

- **Closed alpha:** UGC reporting/blocking/moderation/appeal/contact live; no-like/no-upvote UI complete; PWAtt shadow; basic ingestion and threads; privacy settings and retention; accessibility passes the alpha threshold; web security review finds no launch-blocking account/session/XSS issues; wallet and real-funds disabled; the served bundle has reproducible-build provenance and a strict CSP.
- **Public beta:** PWAtt bounded and explainable; MERI and MFCI pass shadow and limited production gates; ranking decision logs and replay exist; GWEI experiment review operational; moderation/support meet SLAs; AI summaries (if enabled) provenance-preserving and reportable; channel-independent UGC safety met; Core Web Vitals targets met; no-pay-to-rank tests pass even though crypto is disabled or simulated.
- **Knomosis testnet:** commit and deployment manifest pinned; Lean/Solidity/Rust tests pass in CI; wallet UX passes usability and accessibility review; gateway simulation/submission/receipt/indexer/reconciliation work; law-pack registry and proposal state machine implemented; test assets cannot be mistaken for real funds; wallet features can be disabled by flag; support has testnet runbooks.
- **Capped real-funds pilot:** legal/compliance approval for jurisdictions/assets/custody/room purposes/payout types; external security review of wallet flows, gateway, contract/L2 interactions, indexer, reconciliation, treasury; production assets/contracts/chains/law packs/rooms/limits allowlisted; treasury caps/timelocks/COI/challenge windows/emergency holds/accounting live; sanctions/fraud controls and case management live where required; ranking-neutrality tests pass with real payment events in staging; incident drills complete; named cross-functional review board with weekly go/no-go; clear risk disclosures and wallet optionality.
- **General availability:** core social metrics show public-value improvement, not just engagement; safety-incident rate, appeal quality, and moderation SLAs within target; PWAtt/MERI/MFCI/SCOI/PHI/GWEI stable and auditable; ranking neutrality continuously tested; accessibility passes the production threshold; security/privacy high-severity risks resolved or formally accepted; transparency reports generate from logs; real-funds features (if enabled) have clean reconciliation and manageable support; room governance cannot override global policy in implementation or practice; ranking/AI/governance/wallet/treasury/payment features each roll back independently.

# 31. Risks and mitigations

## 31.1 Core product risks

| Risk | Description | Mitigation |
|---|---|---|
| Attention-surveillance concern | Users may distrust attention-derived ranking. | In-browser processing, private ledger, controls, deletion, clear docs. |
| Gaming participation | Long low-quality comments to gain rank. | Contribution quality, outcomes, redundancy, steward review, caps. |
| Mathematical opacity | Invariants hard to explain. | User-facing labels, public methodology summaries, audit docs. |
| False coordination positives | Authentic communities look coordinated. | Markov-fiber conditioning, human review, appeals. |
| Context-card bias | Summaries could frame issues unfairly. | Lens diversity, citations, correction workflow, steward review. |
| Ranking conservatism | Too many constraints make the feed stale. | Tuned exploration quotas, user modes, freshness budgets. |
| Moderator overload | Structured platform still faces abuse. | Queue prioritization, triage automation, steward program. |
| Cold start | New stories lack attention and participation. | Freshness baseline, source context, room seeding, opt-in interests. |
| Accessibility regressions | Complex UI breaks screen readers. | WCAG audits, automated and human tests, release gate. |
| Legal variation | Rules differ by jurisdiction. | Configurable policy layer, legal review, regional rollout. |

## 31.2 PWA-delivery risks

| Risk | Description | Mitigation |
|---|---|---|
| Storage eviction (iOS) | Drafts/cache may be evicted under pressure. | Persistent-storage requests, resync from server, never lose queued contributions/tx records. |
| Discovery without a store | No store search or ranking. | Web discovery, shareable installable links, civic-partner/newsroom referrals, onboarding. |
| Phishing PWA / look-alike domain | Fake "Licio" installs to steal credentials or trigger malicious signatures. | Canonical-domain education, anti-impersonation onboarding, signed bundle provenance, transaction previews. |
| XSS → wallet drain | A single injection could trigger a malicious signature. | Strict CSP, Trusted Types, allow-list sanitizer, no inline scripts, SRI, signing previews and allowlists. |
| Capability gaps vs native | Background limits, push caveats on iOS. | Design around limits (Section 6.11); server treats client aggregates as hints; guide install before relying on push. |

## 31.3 Knomosis, crypto, and DAO risks

| Risk | Description | Mitigation |
|---|---|---|
| Pay-to-rank leakage | Payments indirectly influence visibility through funded activity. | Hard ranking separation, GWEI audits, pay-to-rank-leakage metric, manual review. |
| Regulatory noncompliance | Crypto may trigger MSB/VASP/CASP/money-transmission/tax/securities/consumer-protection obligations. | Counsel review, jurisdiction engine, licensed partners, limited rollout. |
| Wallet compromise | Users sign malicious transactions or lose keys. | Education, typed previews, allowlists, warnings, support, no seed handling. |
| Smart-contract/bridge bug | Defect causes loss or stuck funds. | External audits, caps, bug bounty, timelocks, emergency freezes, staged rollout. |
| Governance capture | Wealthy/coordinated actors seize a treasury or rules. | Capped voting, role quorums, MFCI monitoring, fork/exit, challenge windows. |
| Treasury fraud | Fake grants/bounties/invoices, collusive payouts. | Disclosures, steward review, audit logs, fraud queue, spend caps. |
| Privacy linkage | Wallet actions expose identity or sensitive interests. | Separate wallet/civic identity, off-chain sensitive data, warnings, aggregation thresholds. |
| Sanctions/AML exposure | Restricted actors or suspicious flows. | Compliance provider, region gating, transaction monitoring, freeze/escalation. |
| Speculation drift | Culture shifts toward token hype. | No TVL KPI, no token leaderboards, no price widgets, no tradable social points. |
| DAO-policy conflict | A room votes for unsafe/illegal behavior. | Platform-policy supremacy, law-pack constraints, emergency freeze, appeals. |

The v0.5/v0.6 distribution risk "app-store rejection" is **resolved** by PWA-only delivery: there is no app store to reject the app, and the GPL-3.0 conflict and crypto app-review restrictions no longer apply. The residual delivery risks are in Section 31.2.

# 32. Best-practice and launch-readiness checklist

This single checklist consolidates the prior best-practice and verification matrices.

## 32.1 Product and incentive integrity

No likes, traditional upvotes, reaction counters, public karma, follower-count ranking, donor badges, token leaderboards, or pay-to-rank; participation signals measure attention and contribution depth, never approval or truth; low-quality high-volume participation is capped or dampened; ranking explanations are user-readable and avoid manipulative certainty; anti-metrics block optimization toward outrage, compulsion, speculation, or vanity status; users can switch to less-personalized/non-profiled feeds where required.

## 32.2 Mathematical and ranking integrity

Every invariant has an owner, version, input/output schema, confidence, and known failure modes, and runs in shadow before ranking; exact methods are used where feasible and approximations carry stability tests and confidence intervals; MERI is a true matroid (greedy exact) with the similarity-graph fallback flagged as an approximation; MFCI conditions on base rates via the conditional fiber distribution with an add-one p-value; GWEI uses normalized measures and reports seed stability; SCOI scores Dirichlet energy (data-level) and reserves `H1` for structural obstruction; PHI uses orthogonal transport and gauge-invariant norms; PWAtt uses saturation curves, normalizes positive weights to 100%, and cannot be driven by raw dwell alone; ranking changes are feature-flagged, replay-tested, and monitored.

## 32.3 PWA, performance, and accessibility

The PWA is the universal surface; it is installable, offline-tolerant, and updates without store review; performance is gated on Core Web Vitals (LCP ≤ 2.5 s, INP ≤ 200 ms, CLS ≤ 0.1 at p75) plus bundle budgets; offline, bad-network, and feature-disabled states are designed; WCAG 2.2 AA is a release gate including SPA focus management, zoom/reflow to 200%, target size, reduced motion, captions, contrast, and non-color-only status; transaction previews and governance decisions remain readable with assistive technology; AI summaries and proposals have plain-language views without removing access to source detail.

## 32.4 Privacy and data protection

Data minimization before collection; **no IP or location is ever recorded, persisted, logged, or read** (the application never reads the client address — rate limiting is per-account, per-target, and global identity-free budgets; there is no geo-IP lookup — Section 19.1); in-browser aggregation reduces raw traces; attention-derived signals are visible and controllable; retention tiers are enforced by jobs; DSAR/export/deletion are tested before public beta; anti-abuse data is protected from unnecessary internal access; research exports use aggregation thresholds and small-cell suppression; minors get protective defaults; wallet identity is separated from social identity; sensitive social/moderation/minors/inference data and private messages never go on-chain; staff tools are role-scoped and audit-logged.

## 32.5 Trust, safety, and UGC governance

Report/block/moderation/appeal/contact from every relevant surface; published support channels; reason codes, audit logs, notices, and appeal paths for moderation; emergency escalations for credible threats, self-harm, child safety, and illegal content; coordinated reporting cannot auto-suppress a target without integrity checks; global platform policy overrides local room governance for safety, legality, privacy, minors, accessibility, and security; crypto-specific abuse (wallet drainers, fake airdrops, bounty laundering, governance capture) has dedicated playbooks; transparency reports generate from structured logs.

## 32.6 Security and secure development

Web security aligns with OWASP ASVS; strict CSP, Trusted Types, SRI, and sanitization defend the UGC+wallet surface against XSS; WebAuthn/passkeys preferred; tokens use protected storage, rotation, and replay protection; API authorization is object- and action-level; admin/moderation tools require strong auth and audit trails; dependencies are scanned and an SBOM maintained; no secrets in the client bundle; reproducible builds with published provenance and a transparency log; backups and restore drills tested; incident response exercised before public beta; wallet signing is typed, domain-separated, allowlisted, and verified over ECDSA and EIP-1271; the app never requests seed phrases or opaque signatures; production dependencies, contracts, chain IDs, assets, law packs, and Knomosis commits are pinned.

## 32.7 AI governance

AI is assistive (summarization, triage, clustering, context, translation), not autonomous irreversible enforcement; outputs preserve provenance and are reportable/correctable; model changes are evaluated for hallucination, bias, privacy leakage, safety, and governance neutrality; governance summaries include authority, risks, alternatives, and treasury impact; no AI system spends funds, approves proposals, or issues final sanctions without defined human/rule-based control; AI use is inventoried and risk-assessed.

## 32.8 Financial, crypto, and DAO governance

Knomosis is optional and feature-flagged by jurisdiction/room/compliance status and disabled by default; no payment/token/treasury action/wallet/vote/donor status buys or influences ranking; crypto is never awarded for posting/commenting/inviting/reporting/reading/attention; non-custodial, no-exchange, no-yield, no-lending, no-gambling, no-investment-marketing is the MVP posture; real-funds pilots require legal/compliance approval, external security review, caps, timelocks, reconciliation, accounting exports, and incident drills; rooms govern only local budgets and rules within global constraints.

## 32.9 Operations and transparency

Every high-risk feature has an owner, dashboards, alerts, runbooks, and a rollback path; launches use staged rollout and flags; experiments include harm/fairness/privacy/wellbeing guardrails; support and moderation staffing match expected volume; legal/regulatory changes are reviewed before jurisdiction expansion; transparency reports are scheduled; postmortems produce tracked remediation; unsafe rooms/law packs/payment features can be restricted, archived, or disabled without corrupting the core social product.

## 32.10 Final reviewer checklist

Before any production launch, confirm: the user can use the social product without a wallet; the platform can prove payments are excluded from ranking; the platform can moderate harmful UGC regardless of local governance votes; ranking and invariant decisions are explainable; every financial action reconciles; crypto can be disabled by region/room/account state and fails closed; the PWA is served with reproducible-build provenance, a strict CSP, and Trusted Types; accessibility, privacy, data-rights, security, and incident response are satisfied; the platform avoids optimizing for speculation, outrage, or vanity engagement; and transparency reports are understandable to users, auditors, and stewards.

# 33. Open questions

1. What is the minimum viable SCOI that performs well without over-relying on language models?
2. How much attention aggregation can run entirely in the browser while preserving ranking utility, given storage-eviction limits?
3. Should source profiles be editable by community stewards, professional staff, or both?
4. What public transparency metrics are useful without exposing manipulation defenses?
5. How should the product support verified expertise without becoming elitist?
6. What forms of pseudonymity best protect vulnerable speakers while limiting abuse?
7. How should local rooms launch to avoid empty or captured communities?
8. What is the right balance between chronological and invariant-constrained ranking?
9. How should revenue be structured to avoid pressure toward attention extraction?
10. Which invariant explanations should be public, and which remain internal for abuse resistance?
11. Which exact Knomosis commit, deployment manifest, chain IDs, and contract addresses will be production-pinned?
12. Non-custodial, partner-custodial, or first-party custodial for real funds, and in which jurisdictions?
13. Which assets are allowed at MVP, and which governance weight model is safest for pilot rooms?
14. How should room fork/exit rights interact with treasury assets?
15. What bridge/fault-proof/finality assumptions should transaction previews disclose to users?

# 34. Appendix A: Invariant-to-product mapping

| Invariant | Product question | Surface | Primary owner |
|---|---|---|---|
| MERI | Is this feed nonredundant? | Feed, topic page, evidence drawer. | Ranking + Invariants. |
| MFCI | Is this activity unusually coordinated after base rates? | Integrity queue, trend controls, report handling. | Integrity. |
| GWEI | Are cohorts receiving structurally comparable experiences? | Audit dashboard, transparency report. | Responsible AI + Data Science. |
| SCOI | Will this content collapse context across communities? | Context cards, share flow, bridge prompts. | Conversation + Ranking. |
| PHI | Is the recommender steering users through risky loops? | Feed modes, user controls, ranking constraints. | Ranking + Safety. |
| Hodge tension | Is disagreement local or structurally unresolved? | Moderator queue, thread-health labels. | Conversation Health. |
| Tropical rank | Is cascade timing suspicious? | Integrity queue, trend dampening. | Integrity. |
| Braid dynamics | Is the agenda being churned or gamed? | Trend dashboard. | Integrity + Editorial Ops. |
| Reeb landscape | How are attention basins forming? | Civic Map, topic monitoring. | Discovery. |
| CID | Is ranking stable under irrelevant transformations? | Model audit. | Responsible AI. |
| Path signature | Is the session constructive or compulsive? | Wellbeing prompts, UX research. | Client + Data Science. |

# 35. Appendix B: Example user journeys

## 35.1 Reader opens a breaking story

Sees a card labeled "Getting Attention"; the reason reads "Readers are opening the source and local room activity is rising"; taps to see the source preview; the context card says evidence is preliminary; opens the source, reads, and saves for later; the app counts bounded active attention, not endorsement; no public badge or score appears.

## 35.2 User adds a correction

Sees a thread repeating an incorrect date; taps Contribute → Correction; the composer asks for target text and evidence; cites the original document; a steward accepts the correction and links it to the claim; the thread summary updates; the private ledger says "Your correction improved evidence status for this thread"; no likes are displayed.

## 35.3 Content crosses communities

A joke from one room spreads to a political room; SCOI rises because local interpretations conflict; the card changes to "Needs Context"; the share sheet suggests including origin context; bridge comments are invited; a user explains the original meaning and limits; SCOI decreases and distribution resumes with a context card attached.

## 35.4 Coordinated reporting attempt

Many accounts report a journalist's post within two minutes; MFCI finds target concentration extreme after conditioning on activity margins; the reports are queued but do not auto-suppress the post; integrity review checks account patterns; abusive reporters are limited while valid reports remain; the journalist receives protection if targeted harassment is detected.

## 35.5 Rabbit-hole dampening

A user reads several high-conflict health posts; PHI detects a loop from wellness to conspiratorial medical content and back; ranking injects broader evidence-based context; the user sees "Your recent feed is narrowing around this topic. See broader sources?"; the user switches to Source-diverse mode or resets topic personalization.

## 35.6 Supporting a Forum Commons treasury

A user reads a treasury explainer showing balance, caps, active proposals, and risk state; opens the contribution flow and sees "This supports the commons. It does not rank any post, user, or viewpoint higher"; links an external wallet via a signed message; previews amount, asset, network, fees, recipient treasury, public-ledger disclosure, and finality; signs in the wallet; Licio shows pending status until finality; the dashboard updates after reconciliation; the ranking-neutrality audit confirms no feed boost occurred.

## 35.7 Governance capture attempt is blocked

A newly formed cluster of wallet-linked accounts joins a room before a high-value vote; MFCI flags synchronized joining and co-voting after conditioning on ordinary room activity; the vote enters review rather than auto-execution; an analyst sees preserved-margin comparisons, account-age distribution, and timing skeleton; the room can extend deliberation, reduce the cap, require additional eligibility, or cancel with notice; affected users receive appeal paths; the transparency report describes the intervention in aggregate without exposing anti-abuse detail.

# 36. Appendix C: Prioritized backlog and dependency map

## 36.1 Priority 0 (before any real-user alpha)

No-applause PWA shell; account creation/auth/settings/basic privacy; story submission and URL canonicalization; thread reading and structured composer; report/block/mute/support-contact; manual moderation console; event schema and privacy classification; local draft storage and basic offline; web security baseline (CSP, Trusted Types, sanitizer) and logging; accessibility design review and first-device tests.

## 36.2 Priority 1 (before closed alpha)

PWAtt v0/v1 aggregation; Signal Ledger v0; MERI v0/v1 duplicate grouping; evidence cards and source metadata; moderation reason codes and appeal skeleton; MFCI v0 shadow synthetic tests; Core Web Vitals/crash observability; privacy export/delete prototype; security threat-model review; reproducible-build and provenance pipeline.

## 36.3 Priority 2 (before public beta)

PWAtt v1 production ranking with conservative weights; MERI v1 dampening and explanations; MFCI shadow on live data plus coordinated-reporting protection; context cards and evidence drawer v1; T&S staffing/QA/escalation; accessibility audit and remediation; security testing and incident drill; public support/notices/appeals; transparency-report generator; privacy retention jobs and deletion verification.

## 36.4 Priority 3 (during public beta)

MFCI v1 analyst-reviewed dampening; SCOI v0/v1 context-obstruction workflow; GWEI v0/v1 cohort dashboards; PHI v0 loop detection and recommender reset; AI summarization with steward review; enhanced moderation analytics; experiment gates with harm/fairness metrics; research export prototype with aggregation thresholds; internationalization foundation; richer source/claim lineage.

## 36.5 Priority 4 (post-GA maturity)

MERI v2; MFCI v2; GWEI v2 mitigation suggestions; SCOI v2 obstruction classes; PHI v2 holonomy diagnostics; public research API; external audits; civic partner/steward program; formal AI-management controls.

## 36.6 Knomosis backlog

K0 (before any wallet UX): pin commit and license/copyleft review; threat-model bridge/runtime/wallet/treasury/indexer; decide custody; jurisdiction/feature matrix; risk disclosures and support taxonomy; pilot-room readiness checklist; law-pack MVP template; no-pay-to-rank enforcement tests. K1 (before testnet): wallet-link nonce/signature service; transaction-preview renderer; gateway preflight/submission; testnet indexer and reconciliation; simulated governance tab; testnet proposal lifecycle; accessibility test for wallet/governance flows; scam/wallet-drainer link detection. K2 (before capped real funds): legal approval by jurisdiction; external security audit; compliance partner if needed; treasury caps/timelocks/emergency freeze; financial case management; accounting/reconciliation export; public risk disclosures; bug bounty and incident drill; pilot-room charter approvals. K3 (post-pilot): delegated governance; law-pack migration; fork/exit; expanded treasury reporting; external-audit portal; cross-room governance-health dashboard; privacy-preserving research export; advanced MFCI capture detection.

## 36.7 Dependency map

PWAtt depends on event schema, in-browser instrumentation, privacy classification, and aggregation jobs. MERI depends on canonicalization, source metadata, embeddings, and merge tools. MFCI depends on trustworthy event ingestion, action tables, margin definitions, and analyst tooling. GWEI depends on ranking decision logs, cohort definitions, impression logs, and privacy thresholds. SCOI depends on lenses, context cards, local summaries, taxonomy, and steward patch tools. PHI depends on session summaries, topic-state transitions, recommender logs, and user reset controls. Transparency depends on moderation reason codes, ranking decision logs, incident logs, and aggregation jobs. Public beta depends on web security testing, accessibility remediation, incident response, T&S staffing, and rollback mechanisms. Wallet UX depends on web security, account identity, the wallet-link service, and the distribution-integrity pipeline. Governance simulation depends on rooms, proposals, conversation linking, and steward roles. Testnet actions depend on the Knomosis gateway, deployment manifest, law-pack registry, and event indexer. Real funds depend on legal approval, external audits, compliance controls, support staffing, incident response, and treasury accounting.

# 37. Appendix D: Reference standards and sources

These are design baselines for product, engineering, security, privacy, trust-and-safety, and legal review during implementation, not legal advice.

## 37.1 Accessibility and design

- W3C, **WCAG 2.2**: https://www.w3.org/TR/WCAG22/
- W3C/WAI, **WCAG overview**: https://www.w3.org/WAI/standards-guidelines/wcag/
- W3C, **ARIA Authoring Practices**: https://www.w3.org/WAI/ARIA/apg/

## 37.2 Web platform, PWA, and performance

- W3C, **Web Application Manifest** (installable PWAs): https://www.w3.org/TR/appmanifest/
- W3C, **Service Workers**: https://www.w3.org/TR/service-workers/
- web.dev, **Core Web Vitals** (LCP, INP, CLS): https://web.dev/articles/vitals
- W3C, **Push API** and **Web Push** (VAPID): https://www.w3.org/TR/push-api/

## 37.3 Web and application security

- OWASP, **Application Security Verification Standard (ASVS)**: https://owasp.org/www-project-application-security-verification-standard/
- OWASP, **Mobile Application Security Verification Standard (MASVS)** (for the installed surface): https://mas.owasp.org/MASVS/
- W3C, **Content Security Policy** and **Trusted Types**: https://www.w3.org/TR/CSP3/ , https://www.w3.org/TR/trusted-types/
- OWASP, **Top Ten** and **Cheat Sheets** (XSS, CSP, clickjacking): https://owasp.org/www-project-top-ten/
- NIST, **Cybersecurity Framework 2.0**: https://www.nist.gov/cyberframework
- NIST, **Secure Software Development Framework SP 800-218**: https://csrc.nist.gov/publications/detail/sp/800-218/final
- Reproducible Builds: https://reproducible-builds.org/ ; Sigstore: https://www.sigstore.dev/

## 37.4 Privacy and data protection

- NIST, **Privacy Framework**: https://www.nist.gov/privacy-framework
- EUR-Lex, **GDPR (Regulation (EU) 2016/679)**: https://eur-lex.europa.eu/eli/reg/2016/679/oj/eng
- FTC, **COPPA Rule** (incl. 2025 amendments): https://www.ftc.gov/legal-library/browse/rules/childrens-online-privacy-protection-rule-coppa
- California, **CCPA/CPRA**: https://oag.ca.gov/privacy/ccpa ; https://cppa.ca.gov/regulations/

## 37.5 Platform accountability, AI, and licensing

- European Commission, **Digital Services Act**: https://digital-strategy.ec.europa.eu/en/policies/digital-services-act
- NIST, **AI Risk Management Framework** and **Generative AI Profile**: https://www.nist.gov/itl/ai-risk-management-framework
- ISO/IEC **42001:2023** (AI management systems): https://www.iso.org/standard/42001
- EUR-Lex, **EU AI Act (Regulation (EU) 2024/1689)**: https://eur-lex.europa.eu/eli/reg/2024/1689/oj
- GNU, **AGPL-3.0** (network-served code): https://www.gnu.org/licenses/agpl-3.0.html ; **GPL-3.0**: https://www.gnu.org/licenses/gpl-3.0.html

## 37.6 Mathematical references to validate during R&D

Matroid theory and submodular optimization (nonredundant selection); algebraic statistics, contingency-table fibers, Markov bases, and conditional tests (coordination detection); optimal transport and Gromov–Wasserstein distance (relational experience auditing); applied/cellular sheaf theory, sheaf Laplacians, and cohomology (local-to-global context consistency); gauge theory, holonomy, and metric connections (recommender path diagnostics); discrete Hodge decomposition (conversational tension); tropical algebra (cascade timing); Reeb graphs and level-set topology (attention landscapes); rough paths and path signatures (ordered session behavior).

## 37.7 Knomosis, cryptocurrency, wallets, and DAO governance

- Knomosis, **Repository and README**: https://github.com/hatter6822/Knomosis/tree/main
- Knomosis, **Runtime README**: https://github.com/hatter6822/Knomosis/blob/main/runtime/README.md
- Knomosis, **Solidity README**: https://github.com/hatter6822/Knomosis/blob/main/solidity/README.md
- Knomosis, **Genesis Plan**: https://github.com/hatter6822/Knomosis/blob/main/docs/GENESIS_PLAN.md
- OWASP, **Smart Contract Security (SCSVS/SCSTG) and Smart Contract Top 10**: https://owasp.org/
- FinCEN CVC guidance: https://www.fincen.gov/resources/statutes-regulations/guidance/application-fincens-regulations-certain-business-models
- FATF, **Risk-Based Approach to Virtual Assets and VASPs**: https://www.fatf-gafi.org/en/publications/Fatfrecommendations/Guidance-rba-virtual-assets-2021.html
- European Commission, **Crypto-assets / MiCA**: https://finance.ec.europa.eu/digital-finance/crypto-assets_en
- EIPs: **712** (typed data) https://eips.ethereum.org/EIPS/eip-712 ; **1271** (contract signatures) https://eips.ethereum.org/EIPS/eip-1271 ; **4361** (Sign-In with Ethereum) https://eips.ethereum.org/EIPS/eip-4361 ; **6963** (injected provider discovery) https://eips.ethereum.org/EIPS/eip-6963 ; **4337** (account abstraction) https://eips.ethereum.org/EIPS/eip-4337

## 37.8 Source-review notes and legal disclaimer

The Knomosis repository (reviewed June 7, 2026) describes a Lean 4 proof-carrying state-transition kernel with Solidity and Rust mirrors, a small trusted core, fixture-based cross-stack determinism, and audit gates; the README lists version v0.4.11, Lean toolchain v4.29.1, and GPL-3.0-or-later licensing. Licio must pin a specific commit before implementation because branch state changes. This document is a product and technical specification, not legal advice; it does not guarantee compliance with any jurisdiction. The legal and standards landscape for social media, minors, AI, privacy, accessibility, financial services, and platform accountability changes frequently; refresh this appendix at every major release gate.






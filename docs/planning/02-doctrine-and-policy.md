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

---

## WS-A.1 No-applause doctrine

### WS-A.1.1 Signal allowlist/denylist

**ID:** WS-A.1.1
**Spec reference:** Sections 5.3, 13.6, 30.3-A, 30.6, 2.4

**Description:**
Create `docs/policy/SIGNAL_MATRIX.md` defining the complete taxonomy of signals that the platform recognizes, prohibits, and penalizes. This is the foundational policy document for Licio's no-applause architecture. Every ranking, recommendation, and distribution decision must be traceable to this matrix. The document establishes a hard, auditable boundary between signals that may influence visibility and signals that must never influence visibility. The ranking-neutrality verification suite (Section 30.6) tests against this matrix.

**Allowed positive signals (Section 5.3 -- attention signals):**

These signals may contribute positively to PWAtt ranking, subject to guardrails:

| Signal | Description | Guardrail |
|---|---|---|
| Active dwell | Reading with foreground focus and normal scroll cadence | Capped per item; ignore idle time and screen-on inactivity |
| Source open | Opening the original article, document, dataset, or evidence | Do not reward clickbait if the user immediately returns |
| Context open | Opening context cards, source history, or claim timeline | Count once per meaningful session |
| Return visit | Returning after time away, indicating sustained interest | Avoid rewarding obsessive loops |
| Thread traversal | Reading multiple branches or opposing views | Weight nonredundant traversal above repeated same-branch reading |
| Save for later | Privately marking content to revisit | Private by default; low rank weight |
| Share outside app | Sending a link externally | Low rank weight until recipient attention or participation occurs |

**Allowed positive signals (Section 5.3 -- participation signals):**

These public actions may contribute positively to PWAtt ranking based on quality and downstream thread improvement:

| Signal | Description | Ranking effect |
|---|---|---|
| Clarifying question | Asks what evidence supports a claim, identifies ambiguity | Positive if it elicits useful answers or identifies ambiguity |
| Evidence addition | Adds primary source, dataset, transcript, legal text, credible report | Strong positive if cited and relevant |
| Correction | Identifies false quote, wrong date, missing caveat, broken link | Strong positive when accepted or corroborated |
| Synthesis | Summarizes multiple branches fairly | Positive when it reduces context obstruction or repetition |
| Counterexample | Adds a relevant exception or opposing case | Positive when it broadens the evidence base |
| Domain explanation | Explains technical, legal, scientific, or local context | Positive if nonredundant and useful to readers |
| Bridge comment | Translates one community's interpretation for another | Strong positive when SCOI decreases |
| Steward action | Moderation clarification, rule reminder, merge suggestion | Positive for thread health, not personal fame |

**Prohibited signals (Section 13.6 -- must NEVER affect ranking):**

These signals are absolutely prohibited from influencing ranking, recommendation, search placement, notification priority, trend placement, recommendation eligibility, or author status. Each must have a corresponding ranking-neutrality test case in the verification suite (Section 30.6):

| Prohibited signal | Rationale | Test requirement |
|---|---|---|
| Likes | Do not exist in the platform; no like button | Feed replay test: adding a hypothetical like field produces identical ranking |
| Upvotes | Do not exist in the platform; no upvote button | Feed replay test: adding a hypothetical upvote field produces identical ranking |
| Hearts / reactions | Applause mechanics that measure popularity, not quality | Verify no reaction counter exists in any ranking feature schema |
| Public karma | Aggregate reputation scores create gaming incentives | Verify no karma field is readable by ranking services |
| Follower counts | Popularity metric that rewards celebrity, not contribution | Verify follower count is absent from PWAtt and invariant joins |
| Donor badges | Financial status signal that creates pay-to-rank | Verify donor status is absent from organic feature schemas |
| Token balances | Crypto wealth signal | Verify token balance is absent from PWAtt feature inputs |
| Payment amounts | Financial transaction data | Verify payment amount is absent from organic ranking features |
| Treasury contributions | Room financial contributions | Verify treasury contribution is absent from story rank computation |
| DAO votes | Governance participation | Verify DAO vote outcomes do not change factual claim labels without evidence/steward process |
| Wallet connection status | Whether a user has linked a wallet | Feed replay test: wallet-linked vs non-linked users get identical ranking |
| Paid membership | Subscription status | Verify paid membership does not bypass safety, rate limits, or moderation |
| NFT ownership | Token ownership status | Verify NFT ownership is absent from all ranking and recommendation features |
| Governance vote outcomes | DAO proposal results (without evidence process) | Verify governance outcomes require evidence/steward review before any ranking effect |

**Anti-signals (Section 5.3 -- signals that reduce or penalize ranking):**

These patterns are detected and result in ranking dampening, rate limiting, or safety review:

| Anti-signal | Response |
|---|---|
| Rapid repetitive commenting | Damp participation weight; possible rate limit |
| Coordinated bursts | Apply MFCI penalty and review threshold |
| Rage-loop behavior | Do not convert repeated hostile returns into positive attention |
| Low-information replies | Count as conversation volume but not constructive participation |
| Source-free accusation | Requires evidence or is downweighted |
| Brigading reports | Report impact conditioned by MFCI and reporter reputation |
| Harassment cascade | Freeze ranking growth, apply safety review, protect targets |

**Format requirements:**
- Each signal category is a table with clear columns.
- Every prohibited signal has a specific, testable ranking-neutrality assertion.
- The document includes a version number and changelog section.
- Cross-references to spec sections are inline.

**Acceptance criteria:**
- `docs/policy/SIGNAL_MATRIX.md` exists and is complete.
- All 7 attention signals from Section 5.3 are listed with guardrails.
- All 8 participation signals from Section 5.3 are listed with ranking effects.
- All 14 prohibited signals from Section 13.6 are listed with test requirements.
- All 7 anti-signals from Section 5.3 are listed with responses.
- Every prohibited signal maps to a specific ranking-neutrality test assertion.
- Document is reviewed and approved by at least one project maintainer.

---

### WS-A.1.2 Moderation-escalation taxonomy

**ID:** WS-A.1.2
**Spec reference:** Sections 18.1, 18.2, 18.3, 18.4, 18.5

**Description:**
Create `docs/policy/MODERATION_TAXONOMY.md` defining all 12 policy categories, severity levels, escalation paths, response SLAs, machine-readable reason codes, appeal eligibility, and crypto-specific abuse modes. This document is the operational reference for all moderation decisions. Every moderation action must reference a category and reason code from this taxonomy. The taxonomy must be enumerable and machine-readable so that moderation tooling, transparency reports, and audit logs can reference it programmatically.

**12 policy categories (Section 18.1):**

Each category includes: definition, severity levels (minor/moderate/severe/critical), examples, required evidence, escalation trigger, response SLA, appeal eligibility, and machine-readable reason codes.

| # | Category | Description | Severity range |
|---|---|---|---|
| 1 | Illegal content | Content violating applicable law in the jurisdiction of the viewer or poster | Severe -- Critical |
| 2 | Credible threats and incitement | Direct threats of violence, incitement to imminent lawless action | Critical |
| 3 | Harassment and targeted abuse | Targeted, sustained hostility against individuals or small groups | Minor -- Severe |
| 4 | Hate and dehumanization | Content attacking people based on protected characteristics | Moderate -- Critical |
| 5 | Sexual exploitation and child safety | CSAM, grooming, sextortion, non-consensual intimate imagery | Critical |
| 6 | Graphic or shocking content | Gratuitous violence, gore, self-harm instruction or promotion | Moderate -- Severe |
| 7 | Medical, civic, and crisis misinformation | Provably false claims about health, voting, emergencies causing imminent harm | Moderate -- Severe |
| 8 | Impersonation and deceptive identity | Pretending to be another person, organization, or official entity | Moderate -- Severe |
| 9 | Spam and platform manipulation | Automated posting, fake engagement, coordinated inauthentic behavior | Minor -- Severe |
| 10 | Privacy violations and doxxing | Publishing private information without consent | Moderate -- Critical |
| 11 | Synthetic-media disclosure | AI-generated or manipulated media presented without disclosure | Minor -- Severe |
| 12 | Intellectual-property reports | Copyright, trademark, or other IP infringement claims | Minor -- Moderate |

**Moderation layers and escalation path (Section 18.2):**

| Layer | Function | Escalation trigger |
|---|---|---|
| User controls | Mute, block, report, hide topic, reduce personalization | User initiates report |
| Automated pre-checks | Detect obvious spam, malware links, duplicate floods, policy-risk content | Automated flag exceeds threshold |
| Community stewardship | Context repair, duplicate merge, branch organization, soft warnings | Steward cannot resolve; policy violation suspected |
| Professional moderation | Policy enforcement, urgent safety, appeals | Severity >= severe; legal risk; cross-room pattern |
| Integrity review | Coordination, brigading, bot activity, suspicious campaigns | MFCI flag; multi-account pattern; financial fraud signal |
| External escalation | Legal, child safety, imminent harm, regulator requests | Imminent physical danger; CSAM; law enforcement request |

**Severity levels and SLA targets:**

| Severity | Response SLA | Examples |
|---|---|---|
| Minor | 72 hours | Low-information spam, minor formatting abuse, unintentional duplicate |
| Moderate | 24 hours | Harassment (isolated), impersonation attempt, undisclosed synthetic media |
| Severe | 4 hours | Sustained harassment, hate speech, privacy violation, coordinated manipulation |
| Critical | 1 hour | Credible threat to life, CSAM, child grooming, imminent harm, illegal content |

**Appeal eligibility by action type:**
- Content removal: appealable (except CSAM, imminent threat)
- Temporary suspension: appealable after cooling period
- Permanent ban: appealable once, reviewed by appeals reviewer
- Shadow action (reduced distribution): appealable; user must be notified
- Room governance freeze: appealable to integrity analyst
- Treasury freeze: appealable; requires documented review

**Crypto-specific abuse modes (Section 18.5):**

Knomosis-enabled rooms introduce abuse modes that require dedicated detection, response, and escalation. Each mode has specific indicators, response playbook, and audit requirements:

| Abuse mode | Description | Response |
|---|---|---|
| Wallet-drainer links | Links to malicious dApps that drain connected wallets | Link interstitials, URL blocklist, immediate removal, user notification |
| Malicious signature prompts | Tricking users into signing harmful transactions | Signing preview enforcement, allowlist validation, account action |
| Impersonation (financial) | Impersonating stewards, rooms, journalists, grant recipients, support | Identity verification, content removal, account suspension |
| Bounty collusion | Fake completion evidence, coordinated false verification | Steward review requirement, MFCI monitoring, payout hold |
| Vote buying and coercion | Purchasing or coercing governance votes | MFCI detection, proposal challenge, governance freeze |
| Bribery | Offering payments for specific moderation or governance outcomes | Audit trail review, account action, law enforcement if warranted |
| Treasury capture | Wealthy or coordinated actors seizing room treasury control | Capped voting power, role quorums, fork/exit provisions, challenge windows |
| Sanctions evasion | Restricted actors using the platform for financial transactions | Compliance provider screening, region gating, transaction monitoring, freeze |
| Paid harassment/brigading | Using financial incentives to coordinate harassment campaigns | MFCI detection, target protection, treasury freeze, law enforcement |
| Paid report abuse | Paying users to file false reports | Report-quality analysis, reporter reputation, integrity review |
| Paid disinformation | Undisclosed paid promotion or coordinated influence campaigns | Disclosure requirements, MFCI detection, content labeling, account action |
| Misleading investment claims | Presenting crypto features as investment opportunities | Content labeling, risk disclosures, removal if fraudulent |
| Fraudulent grants | Fake charities, fabricated invoices, phantom evidence | Steward review, audit log, fraud queue, treasury freeze |
| Fabricated invoices | False financial claims against room treasuries | Multi-steward approval, evidence verification, challenge window |
| DAO vote to reveal private info | Using governance votes to expose private moderation/reporting data | Platform-policy override; DAO supremacy does not extend to privacy |

**Format requirements:**
- Machine-readable reason codes (e.g., `MOD_HARASS_001`, `MOD_CRYPTO_DRAIN_001`)
- Each category has a unique namespace for reason codes
- Version number and changelog
- Cross-references to spec sections

**Acceptance criteria:**
- `docs/policy/MODERATION_TAXONOMY.md` exists and is complete.
- All 12 policy categories are defined with severity levels, examples, SLAs, and reason codes.
- All 6 moderation layers are documented with escalation triggers.
- All 15 crypto-specific abuse modes from Section 18.5 are documented with responses.
- Appeal eligibility is defined for every action type.
- Reason codes are machine-readable and follow a consistent naming convention.
- SLA targets are defined for each severity level.
- Document is reviewed and approved.

---

### WS-A.1.3 Transparency-report data dictionary

**ID:** WS-A.1.3
**Spec reference:** Sections 28.1, 28.2, 28.3, 28.4

**Description:**
Create `docs/policy/TRANSPARENCY_DICTIONARY.md` defining all metrics that appear in public transparency reports, their data sources, aggregation thresholds for privacy protection, report cadence, and the anti-metrics that must never be optimized for. This dictionary ensures that transparency reporting is consistent, privacy-preserving, and aligned with the no-applause doctrine.

**Product-health metrics (Section 28.1):**

Each metric includes: definition, data source, responsible workstream, aggregation method, privacy threshold (minimum count before publishing), and report cadence.

| Metric | Definition | Data source | Privacy threshold |
|---|---|---|---|
| Constructive-participation rate | Fraction of contributions classified as constructive (evidence, correction, synthesis, bridge, question) | Contribution classifier | Min 100 contributions per period |
| Source-open rate | Fraction of story views where the user opened the original source | Attention event pipeline | Min 1000 views per period |
| Evidence-addition rate | Rate at which evidence cards are added per active thread | Evidence card submissions | Min 50 threads per period |
| Question-resolution rate | Fraction of clarifying questions that receive a substantive answer | Thread state tracker | Min 50 questions per period |
| MERI distribution | Distribution of nonredundancy scores across feeds and topics | MERI service | Aggregate only; no per-user scores |
| SCOI reduction after bridge/synthesis | Change in SCOI obstruction score after bridge or synthesis contributions | SCOI service | Min 20 bridge events per period |
| MFCI incidents by severity | Count and severity distribution of coordination-detection incidents | MFCI service | Aggregate only; no individual cases |
| GWEI cohort disparity | Structural experience parity across defined cohorts | GWEI service | Min 5 cohorts; no cohort < 100 users |
| PHI steering-risk distribution | Distribution of path-dependency risk scores | PHI service | Aggregate only; no per-user scores |
| Harassment-protection latency | Time from harassment report to target protection | Safety queue logs | Aggregate; no individual case timing |
| Appeal-overturn rate | Fraction of appeals resulting in action reversal | Appeals system | Min 20 appeals per period |
| Accessibility-defect rate | Rate of accessibility regression defects per release | QA tracking | Per release |
| Core Web Vitals (LCP, INP, CLS) | Performance metrics at p75 across real users | RUM / field data | Min 1000 page loads per period |

**Knomosis governance and payment metrics (Section 28.3):**

| Metric | Definition | Guards against |
|---|---|---|
| Public-value grant completion | Funded grants producing accepted evidence/context outputs | Treasury waste |
| Transaction comprehension | User-test success on transaction-preview meaning | Blind signing |
| Treasury-transparency completeness | Treasury actions with clear proposal/recipient/amount/outcome | Dark-money governance |
| Governance diversity | Participation breadth across eligible civic accounts (not wallet wealth) | Capture |
| Proposal-dispute rate | Proposals challenged for conflict/fraud/policy | Unaccountable execution |
| Financial-incident rate | Confirmed scams/fraud/mistaken transfers/compromise per active wallet | Unsafe expansion |
| Pay-to-rank leakage | Measured correlation between payments and ranking after controls | Wealth-driven visibility |
| Treasury-reconciliation gap | Divergence between app ledger, Knomosis receipts, and L1 state | Must be zero or explained before expansion |

**Anti-metrics (Section 28.2, 28.3 -- NEVER optimize for these):**

These metrics must never be used as success criteria, growth KPIs, or optimization targets. They represent the engagement-trap and speculation-drift patterns that Licio explicitly rejects:

| Anti-metric | Why prohibited |
|---|---|
| Outrage engagement | Optimizing for emotional reactions rewards divisive content over informative content |
| Compulsion metrics | Session length, return frequency, or notification click-through as growth drivers create addiction patterns |
| Speculation metrics | Token price, trading volume, or speculative activity as platform health indicators |
| Vanity engagement | Follower counts, like counts, reaction counts, or public karma as success metrics |
| Total value locked (TVL) | Treating TVL as a success metric incentivizes accumulation over public value |
| Tokens traded | Trading volume is a speculation metric, not a public-value metric |
| Wallet connects as growth KPI | Wallet connections measure crypto adoption, not social product value |
| Speculative price | Token or asset price as a platform health indicator incentivizes hype |
| Treasury size as status | Large treasuries are not inherently better; public-value output matters |
| Vote volume without outcome quality | Raw governance participation without measuring decision quality |
| Engagement alone as success criterion | No launch may use engagement as the sole success metric (Section 28.2) |

**Experimentation rules (Section 28.2):**
- No experiment may introduce likes, upvotes, public reaction counts, or follower leaderboards.
- Ranking experiments must include safety, MERI, MFCI, GWEI, SCOI, and PHI metrics alongside any engagement metric.
- Experiments on minors or sensitive topics require stricter review.
- All experiments have rollback switches.
- Major user-facing changes require notice.
- Experiment logs include invariant versions.

**Report cadence:**
- Product-health metrics: monthly
- Safety and moderation metrics: monthly (weekly internal review)
- Knomosis governance metrics: monthly (if Knomosis enabled)
- Core Web Vitals: continuous monitoring, monthly report
- Anti-metrics: reviewed quarterly to confirm they are not being optimized

**Format requirements:**
- Every metric maps to a data source and responsible workstream.
- Aggregation thresholds are specified to prevent re-identification.
- Small-cell suppression rules: suppress any cell with fewer than the privacy threshold.
- Version number and changelog.

**Acceptance criteria:**
- `docs/policy/TRANSPARENCY_DICTIONARY.md` exists and is complete.
- All 13 product-health metrics from Section 28.1 are defined with data sources and privacy thresholds.
- All 8 Knomosis metrics from Section 28.3 are defined.
- All 11 anti-metrics are listed with rationale for prohibition.
- Experimentation rules from Section 28.2 are documented.
- Report cadence is specified for each metric category.
- Aggregation thresholds and small-cell suppression rules are documented.
- Every metric maps to a responsible workstream.
- Document is reviewed and approved.

---

### WS-A.1.4 Signal-to-test mapping document

**ID:** WS-A.1.4
**Spec reference:** Sections 13.6, 30.6

**Description:**
Create `docs/policy/SIGNAL_TEST_MAP.md` that maps every prohibited signal from WS-A.1.1 to a specific, implementable ranking-neutrality test case. This document is the contract between the policy team and the engineering team: for every signal that must not affect ranking, there is a precise test specification that can be implemented as an automated test in WS-I.3 (ranking-neutrality verification suite, Section 30.6).

The ranking-neutrality verification suite must prove that financial features cannot become hidden ranking inputs. This document defines what "prove" means for each prohibited signal.

**Test case structure for each prohibited signal:**

Each entry includes:
- **Signal name** -- the prohibited signal from WS-A.1.1
- **Test ID** -- unique identifier (e.g., `RNT-001`)
- **Test type** -- feed replay, schema audit, feature inspection, or integration test
- **Setup** -- preconditions and test data
- **Assertion** -- what the test checks, in precise terms
- **Frequency** -- when the test runs (CI, pre-release, post-release)
- **Failure action** -- what happens when the test fails (block release, alert, etc.)

**Required test cases (one per prohibited signal from Section 13.6):**

| Test ID | Prohibited signal | Test method | Assertion |
|---|---|---|---|
| RNT-001 | Likes | Feed replay | Feed replay with and without hypothetical like field yields identical ranking order |
| RNT-002 | Upvotes | Feed replay | Feed replay with and without hypothetical upvote field yields identical ranking order |
| RNT-003 | Hearts / reactions | Schema audit | No reaction counter field exists in any ranking feature schema |
| RNT-004 | Public karma | Schema audit + feature inspection | No karma field is readable by ranking services; karma is absent from PWAtt inputs |
| RNT-005 | Follower counts | Feature inspection | Follower count is absent from PWAtt and all invariant joins |
| RNT-006 | Donor badges | Feature inspection | Donor status/badge is absent from all organic feature schemas |
| RNT-007 | Token balances | Feature inspection | Token balance field is absent from PWAtt feature inputs |
| RNT-008 | Payment amounts | Feature inspection | Payment amount is absent from all organic ranking features |
| RNT-009 | Treasury contributions | Integration test | Treasury contribution amount does not change story rank except via manually approved public-interest prompt in dedicated surface |
| RNT-010 | DAO votes | Integration test | Governance vote outcomes do not change factual claim labels without evidence/steward process |
| RNT-011 | Wallet connection status | Feed replay | Feed replay for wallet-linked vs non-linked users yields identical ranking except for user-selected treasury surfaces |
| RNT-012 | Paid membership | Integration test | Paid membership does not bypass safety, rate limits, or moderation |
| RNT-013 | NFT ownership | Feature inspection | NFT ownership is absent from all ranking and recommendation feature schemas |
| RNT-014 | Governance vote outcomes | Integration test | Governance outcomes require evidence/steward review before any ranking effect |

**Additional suite-level tests (Section 30.6):**
- ML feature audit: fails if wallet/token/payment/treasury fields are added to organic rankers without explicit approval
- Dashboard separation: revenue/treasury metrics are separated from product-health metrics
- Sponsored content labeling: sponsored/treasury-funded content is labeled and does not enter unpaid ranking
- Public explanation audit: explanations state that payments are support/governance actions, not endorsements

**Acceptance criteria:**
- `docs/policy/SIGNAL_TEST_MAP.md` exists and is complete.
- Every prohibited signal from WS-A.1.1 has exactly one corresponding test case with a unique test ID.
- Each test case specifies the test method, setup, assertion, frequency, and failure action.
- Suite-level tests from Section 30.6 are documented.
- The document is structured so that engineering can implement each test case without ambiguity.
- Test IDs follow a consistent naming convention (RNT-NNN).
- Document is reviewed and approved.

---

## WS-A.2 Jurisdiction and feature matrix

### WS-A.2.1 Jurisdiction-feature matrix template

**ID:** WS-A.2.1
**Spec reference:** Sections 17.10, 30.3-N

**Description:**
Create `docs/policy/JURISDICTION_MATRIX.md` as a template for mapping features, asset types, and capabilities to jurisdictions. This matrix is the operational input for the jurisdiction policy engine (Section 17.10) that controls feature availability by region. The default posture is crypto features disabled and fail-closed: any jurisdiction not explicitly approved has crypto features turned off.

**Matrix dimensions:**

**Rows (jurisdictions):** Template rows for major regulatory regimes. Each jurisdiction entry includes:
- Region/country code (ISO 3166-1)
- Regulatory framework references (e.g., EU MiCA, US state-level MSB, Singapore PSA)
- Legal review status: pending, in-progress, approved, blocked
- Legal review date and reviewer
- Notes and conditions

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

**Default posture per feature category:**
- Core social: enabled globally (subject to content law)
- PWAtt ranking: enabled globally
- Wallet connection: disabled by default; enabled per approved jurisdiction
- Testnet transactions: enabled in approved test jurisdictions
- Production payments: disabled by default; enabled only after legal approval
- Treasury operations: disabled by default; enabled only after legal approval
- Governance: disabled by default for financial governance; enabled for non-financial room governance
- Age-gated: requires age verification where applicable

**Acceptance criteria:**
- `docs/policy/JURISDICTION_MATRIX.md` exists with the template structure.
- All feature categories are represented as columns.
- Default posture (disabled, fail-closed) is documented for crypto features.
- All cells requiring legal review are clearly marked with status (pending/approved/blocked).
- The template includes fields for legal reviewer, review date, and conditions.
- KYC/AML trigger conditions are documented per feature tier.
- Sanctions restrictions are included as a column or annotation.

---

### WS-A.2.2 Steward roles and capabilities

**ID:** WS-A.2.2
**Spec reference:** Section 16.3, 16.4

**Description:**
Create `docs/policy/STEWARD_ROLES.md` defining the five steward roles, their capabilities, access levels, accountability requirements, and audit obligations. Stewards are the human governance layer between automated systems and external escalation. Their roles must be precisely defined so that capability grants, audit logs, and accountability structures can be implemented correctly.

**Steward roles (Section 16.3):**

| Role | Capabilities | Access level | Accountability |
|---|---|---|---|
| Community steward | Organize threads, request context, merge duplicates, escalate moderation, issue soft warnings, suggest branch organization | Room-level content management; no account-level actions | Actions audited; subject to community feedback; removable by room governance or platform |
| Evidence steward | Review evidence cards, mark primary sources, flag weak citations, verify source provenance, suggest evidence gaps | Evidence card metadata; source profile annotations | Actions audited; evidence decisions are reviewable; no content removal power |
| Safety moderator | Enforce policy, handle reports, protect targets, issue warnings, remove content, restrict accounts (temporary), apply safety labels | Cross-room content and account actions within policy scope | All actions logged with reason codes; subject to appeal; required training |
| Appeals reviewer | Review disputed moderation or account actions, overturn or uphold decisions, document reasoning | Read access to moderation history and evidence; decision authority on appeals | Decisions logged with full reasoning; independent from original moderator; periodic quality review |
| Integrity analyst | Investigate coordination, spam, manipulation, raids, bot networks, financial abuse patterns | Cross-room analytics, MFCI data, account patterns, financial transaction patterns | Investigations logged; actions require documentation; sensitive data access is time-limited and audited |

**Cross-cutting requirements (Section 16.4):**
- All steward actions are logged with timestamps, reason codes, and actor identity.
- Public transparency reports summarize moderation and integrity actions in aggregate.
- Stewards cannot access private attention ledgers or personal data beyond what is necessary for their role.
- Multi-factor authentication required for all steward accounts.
- Steward actions are reversible where possible; irreversible actions require additional approval.
- High-impact policy changes require a changelog and user notice.
- Steward roles require training completion before capability grant.

**Acceptance criteria:**
- `docs/policy/STEWARD_ROLES.md` exists and is complete.
- All five steward roles are documented with capabilities, access levels, and accountability requirements.
- Audit requirements are specified for each role.
- Training requirements are documented.
- Multi-factor authentication requirement is documented.
- Role hierarchy and escalation paths are clear.
- Document is reviewed and approved.

---

### WS-A.2.3 Privacy regulation mapping

**ID:** WS-A.2.3
**Spec reference:** Sections 19.1, 19.2, 19.3, 19.4, 17.10

**Description:**
Create `docs/policy/PRIVACY_REGULATION_MAP.md` mapping privacy regulation requirements to Licio's data handling practices by jurisdiction. This document ensures that the platform's privacy controls (attention signal handling, data retention, user rights, children's protections) comply with applicable regulations in each target jurisdiction.

**Regulation coverage:**

**GDPR (EU/EEA):**
- Legal basis for processing: legitimate interest for core social features; consent for personalized recommendations and attention-derived ranking
- Data subject rights: access, rectification, erasure, portability, restriction, objection
- Data minimization: in-browser aggregation of attention signals; minimal raw event upload
- Retention limits: documented retention tiers per data category
- Data Protection Impact Assessment (DPIA): required for attention-signal processing and invariant services
- Right to explanation: users can request meaningful information about ranking decisions
- Cross-border transfers: data localization requirements and transfer mechanisms
- DPO designation: required if processing at scale
- Breach notification: 72-hour supervisory authority notification
- Children: GDPR Article 8 age thresholds (13-16 depending on member state)

**CCPA/CPRA (California):**
- Consumer rights: know, delete, opt-out of sale/sharing, correct, limit sensitive personal information use
- Sensitive personal information: attention-derived inferences may qualify; requires purpose limitation
- Service provider obligations: contractual restrictions on data use
- Financial incentive disclosure: any feature differentiation based on data use must be disclosed
- Children: COPPA compliance for under-13; CCPA opt-in consent for 13-16

**COPPA (US -- children under 13):**
- Verifiable parental consent before collecting personal information
- Data minimization for children's data
- Retention limits: delete when no longer needed for purpose
- No behavioral advertising to children
- Parental access and deletion rights
- Licio's posture: default product is not directed to children under 13 (Section 19.4); any jurisdiction supporting younger users requires compliant parental consent

**Per-jurisdiction data handling matrix:**

| Data category | GDPR handling | CCPA/CPRA handling | COPPA handling |
|---|---|---|---|
| Attention signals (dwell, scroll) | In-browser processing; aggregate upload; consent for personalization | Right to know and delete; opt-out of sharing | Not collected for children |
| Participation signals (contributions) | Legitimate interest; retention per policy | Right to know and delete | Parental consent required |
| Account data (email, credentials) | Contract performance; access/portability/erasure | Right to know, delete, correct | Verifiable parental consent |
| Wallet data (addresses, transactions) | Consent; purpose limitation; separate from social identity | Right to know and delete; sensitive PI | Not applicable (minors excluded) |
| Moderation data (reports, actions) | Legitimate interest; limited retention; access with restrictions | Right to know with restrictions | Protective defaults apply |
| Minor-specific data | Article 8 age thresholds; protective defaults | CCPA opt-in for 13-16 | Full COPPA compliance |

**Acceptance criteria:**
- `docs/policy/PRIVACY_REGULATION_MAP.md` exists and is complete.
- GDPR, CCPA/CPRA, and COPPA requirements are mapped to Licio's data categories.
- Per-jurisdiction data handling matrix is complete.
- Legal basis for each data processing activity is documented.
- Children's protections are documented with age thresholds per jurisdiction.
- Data retention tiers are referenced (detailed retention schedule may be a separate document).
- Document is reviewed by legal counsel (marked as requiring review if not yet reviewed).

---

### WS-A.2.4 Crypto feature availability matrix

**ID:** WS-A.2.4
**Spec reference:** Sections 17.10, 17.11, 30.3-N

**Description:**
Create `docs/policy/CRYPTO_FEATURE_MATRIX.md` detailing which crypto and financial features are available in which jurisdictions, at which stage of the rollout, and under what conditions. This is a more detailed view of the crypto-specific columns in the jurisdiction matrix (WS-A.2.1), providing the operational detail needed for the jurisdiction policy engine.

**Feature tiers (from Section 17.10 -- distribution posture):**

| Tier | Features | Default state | Enablement requirement |
|---|---|---|---|
| Tier 0: Education | Read-only Knomosis education, governance explainers | Enabled globally | None |
| Tier 1: Simulation | Simulated governance, fake-asset proposals, preview signing | Disabled by default | Product approval; no legal barrier |
| Tier 2: Testnet | Wallet link (nonce/signature), testnet proposals, testnet treasury | Disabled by default | Product and security approval; test jurisdiction |
| Tier 3: Capped production | Real-asset deposits, capped grants, limited room governance | Disabled by default | Legal approval, compliance controls, external audit, limited jurisdictions |
| Tier 4: Mature production | Expanded governance, delegation, law-pack migration, fork/exit | Disabled by default | All Tier 3 plus operational track record, expanded legal review |

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

**Fail-closed behavior:**
- If jurisdiction status is unknown or pending: crypto features disabled
- If compliance check fails: crypto features disabled with user-facing explanation
- If sanctions screening unavailable: crypto features disabled
- If age verification unavailable: crypto features disabled for that user
- Core social product (reading, posting, discussing, reporting, blocking) always remains available regardless of crypto feature state

**Acceptance criteria:**
- `docs/policy/CRYPTO_FEATURE_MATRIX.md` exists and is complete.
- All 5 feature tiers are defined with default states and enablement requirements.
- Per-jurisdiction requirements are specified for each tier.
- Fail-closed behavior is documented for all edge cases.
- The matrix is compatible with the jurisdiction-feature matrix template (WS-A.2.1).
- Core social product availability is explicitly documented as independent of crypto features.
- Document is reviewed and approved.

## Workstream definition of done

WS-A is complete when ALL of the following conditions hold:

1. **Signal matrix:** The signal matrix document exists, enumerates every tracked signal with its privacy classification, and is reviewed and approved.

2. **Moderation taxonomy:** The moderation taxonomy document exists with violation categories, severity levels, and escalation paths, and is reviewed and approved.

3. **Transparency dictionary:** The transparency dictionary document exists defining all user-facing terms for algorithmic and moderation processes, and is reviewed and approved.

4. **Jurisdiction template:** The jurisdiction-feature matrix template exists with per-jurisdiction crypto-feature enablement rules, and is reviewed and approved.

5. **Steward roles:** The steward roles and responsibilities document exists defining capabilities, obligations, and accountability structures, and is reviewed and approved.

6. **Signal-to-test mapping:** The signal-to-test mapping document exists linking every signal to its validation test, and is reviewed and approved.

7. **Privacy regulation mapping:** The privacy regulation mapping document exists covering GDPR, CCPA, and other applicable frameworks with per-requirement compliance notes, and is reviewed and approved.

8. **Crypto feature matrix:** The crypto feature matrix document exists defining all five feature tiers with default states, enablement requirements, per-jurisdiction rules, and fail-closed behavior, and is reviewed and approved.

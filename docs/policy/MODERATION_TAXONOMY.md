# Licio Moderation Taxonomy

> Operational reference for **every** moderation decision in the product. Each
> moderation action anywhere in Licio references a category and reason code defined
> here. The taxonomy is enumerable and machine-readable so moderation tooling,
> transparency reports, and audit logs reference it programmatically rather than by
> parsing prose.

| Field | Value |
|---|---|
| **Document ID** | `MODERATION_TAXONOMY` |
| **Produced by** | WS-A.1.2a (categories), WS-A.1.2b (layers), WS-A.1.2c (appeals), WS-A.1.2d (crypto abuse) |
| **Version** | 1.1.0 |
| **Owner** | Licio Maintainers — Doctrine & Policy Working Group |
| **Effective date** | 2026-06-19 |
| **Status** | Ratified by maintainer (hatter6822) — 2026-06-08 (M0 doctrine gate); amended 2026-06-19 (AI-governed-rooms redesign) |
| **SPEC references** | §16.3, §16.4, §16.6, §17.10, §18.1–§18.5, §24.6, §25.6, §29.3 |
| **Primary consumers** | WS-J (T&S), WS-G.4 (UGC safety), WS-P (transparency), WS-N (compliance) |

**Reason-code convention.** Machine-readable reason codes use the form
`MOD_<NAMESPACE>_NNN` (three-digit suffix). Each category owns a unique namespace.
Crypto-specific abuse modes extend the taxonomy under the `MOD_CRYPTO_*` namespace.
The canonical machine-readable enumeration at the end of this document is the source
of truth; the prose tables must agree with it.

---

## WS-A.1.2a — Policy categories, severity, SLA, reason codes

### Severity levels and SLA targets (SPEC §18.3)

| Severity | Response SLA | Illustrative examples |
|---|---|---|
| `minor` | 72 hours | Low-information spam, minor formatting abuse, unintentional duplicate |
| `moderate` | 24 hours | Harassment (isolated), impersonation attempt, undisclosed synthetic media |
| `severe` | 4 hours | Sustained harassment, hate speech, privacy violation, coordinated manipulation |
| `critical` | 1 hour | Credible threat to life, CSAM, child grooming, imminent harm, illegal content |

Every severity level has exactly one SLA target; every reason code carries a default
severity drawn from this table and inherits that severity's SLA.

### The 12 policy categories (SPEC §18.1)

| # | Category ID | Category | Description | Severity range | Required evidence | Escalation trigger | Illustrative examples |
|---|---|---|---|---|---|---|---|
| 1 | `MOD_ILLEGAL` | Illegal content | Content violating applicable law in the jurisdiction of viewer or poster | severe – critical | Identification of the violated law and the viewer/poster jurisdiction | Routes to external escalation; law-enforcement or court order | Sale of contraband; sanctioned-party transactions; content under a valid court-removal order |
| 2 | `MOD_THREAT` | Credible threats and incitement | Direct threats of violence; incitement to imminent lawless action | critical | The threatening statement and its target; assessment of credibility/imminence | Imminent danger → external escalation; safety lead + counsel | "I will kill you at \<address\>"; calls to storm a venue now |
| 3 | `MOD_HARASS` | Harassment and targeted abuse | Targeted, sustained hostility against individuals or small groups | minor – severe | Pattern of targeting, target identification, prior-warning history | Sustained pattern or cross-room targeting → professional moderation | Coordinated pile-on; repeated unwanted contact; off-platform-organized targeting |
| 4 | `MOD_HATE` | Hate and dehumanization | Attacks on people based on protected characteristics | moderate – critical | The attacking content and the protected characteristic targeted | Incitement to violence → external escalation | Dehumanizing slurs; "\<group\> are vermin"; calls for violence against a protected class |
| 5 | `MOD_CSE` | Sexual exploitation and child safety | CSAM, grooming, sextortion, non-consensual intimate imagery | critical | Reviewer confirmation under strict handling; no copies retained beyond legal need | **Immediate** external escalation (child-safety + law enforcement) | Child sexual abuse material; grooming messages; sextortion |
| 6 | `MOD_GRAPHIC` | Graphic or shocking content | Gratuitous violence, gore, self-harm instruction or promotion | moderate – severe | The content and context (gratuitous vs. newsworthy); self-harm intent | Self-harm instruction/promotion → professional moderation + safety resources | Gratuitous gore; pro-self-harm content; self-harm method instructions |
| 7 | `MOD_MISINFO` | Medical, civic, and crisis misinformation | Provably false claims about health, voting, emergencies causing imminent harm | moderate – severe | The false claim, the authoritative counter-source, and an imminent-harm assessment | Imminent-harm criteria met → professional moderation; crisis protocol | "Bleach cures X"; false polling-place closures during an election; fake evacuation orders |
| 8 | `MOD_IMPERS` | Impersonation and deceptive identity | Pretending to be another person, organization, or official entity | moderate – severe | Comparison to the impersonated person/organization/official entity | Official-entity or high-risk impersonation → professional moderation | Fake "official" account; cloned journalist profile; spoofed support handle |
| 9 | `MOD_SPAM` | Spam and platform manipulation | Automated posting, fake engagement, coordinated inauthentic behavior | minor – severe | Volume/velocity/similarity signals; coordination evidence | Coordinated inauthentic behavior → integrity review (MFCI) | Bot-posted link floods; purchased fake activity; sock-puppet rings |
| 10 | `MOD_PRIVACY` | Privacy violations and doxxing | Publishing private information without consent | moderate – critical | The published private information and absence of consent | Sensitive data (medical, minor, security) → severe/critical, professional moderation | Posting someone's home address; leaking medical records; non-consensual contact details |
| 11 | `MOD_SYNTH` | Synthetic-media disclosure | AI-generated/manipulated media presented without disclosure | minor – severe | The media, the absence of disclosure, and deceptive/harmful intent | Non-consensual synthetic intimate imagery → severe, professional moderation | Undisclosed deepfake; manipulated video presented as real; synthetic "quote" |
| 12 | `MOD_IP` | Intellectual-property reports | Copyright, trademark, or other IP infringement claims | minor – moderate | A rights claim and identification of the protected work | Repeat infringement or counter-notice dispute → professional moderation | DMCA-style copyright claim; trademark misuse; repeat infringement |

### Representative reason codes per namespace (≥ 3 per category)

| Category | Reason codes (code — meaning — default severity) |
|---|---|
| `MOD_ILLEGAL` | `MOD_ILLEGAL_001` illegal goods/contraband — severe · `MOD_ILLEGAL_002` terrorism/violent-extremism content — critical · `MOD_ILLEGAL_003` court-ordered/legally-mandated removal — severe |
| `MOD_THREAT` | `MOD_THREAT_001` direct threat of violence (imminent) — critical · `MOD_THREAT_002` incitement to imminent lawless action — critical · `MOD_THREAT_003` conditional/veiled threat — severe |
| `MOD_HARASS` | `MOD_HARASS_001` targeted insults — moderate · `MOD_HARASS_002` sustained pile-on — severe · `MOD_HARASS_003` off-platform-coordinated harassment — severe |
| `MOD_HATE` | `MOD_HATE_001` dehumanizing slur — moderate · `MOD_HATE_002` protected-class attack — severe · `MOD_HATE_003` genocidal/violent incitement against a group — critical |
| `MOD_CSE` | `MOD_CSE_001` CSAM — critical · `MOD_CSE_002` grooming — critical · `MOD_CSE_003` sextortion / non-consensual intimate imagery of a minor — critical |
| `MOD_GRAPHIC` | `MOD_GRAPHIC_001` gratuitous gore/violence — moderate · `MOD_GRAPHIC_002` self-harm promotion — severe · `MOD_GRAPHIC_003` self-harm instruction — severe |
| `MOD_MISINFO` | `MOD_MISINFO_001` health misinformation with imminent harm — severe · `MOD_MISINFO_002` voting/civic-process misinformation — severe · `MOD_MISINFO_003` crisis/emergency misinformation — moderate |
| `MOD_IMPERS` | `MOD_IMPERS_001` individual impersonation — moderate · `MOD_IMPERS_002` organization/official-entity impersonation — severe · `MOD_IMPERS_003` deceptive identity / fake affiliation — moderate |
| `MOD_SPAM` | `MOD_SPAM_001` automated posting — minor · `MOD_SPAM_002` fake engagement — moderate · `MOD_SPAM_003` coordinated inauthentic behavior — severe |
| `MOD_PRIVACY` | `MOD_PRIVACY_001` doxxing (contact/address) — moderate · `MOD_PRIVACY_002` publication of private information without consent — severe · `MOD_PRIVACY_003` exposure of sensitive data (medical/minor/security) — critical |
| `MOD_SYNTH` | `MOD_SYNTH_001` undisclosed synthetic/AI media — minor · `MOD_SYNTH_002` deceptive deepfake — moderate · `MOD_SYNTH_003` non-consensual synthetic intimate imagery — severe |
| `MOD_IP` | `MOD_IP_001` copyright infringement claim — minor · `MOD_IP_002` trademark infringement claim — minor · `MOD_IP_003` repeat/willful infringement — moderate |

---

## WS-A.1.2b — Moderation layers and escalation path (SPEC §18.2)

| Layer | Function | Operated by | Escalation trigger |
|---|---|---|---|
| User controls | Mute, block, report, hide topic, reduce personalization | End user | User initiates report |
| Automated pre-checks | Detect obvious spam, malware links, duplicate floods, policy-risk content | System (WS-J.2.6) | Automated flag exceeds threshold; **policy-risk flag routes to a human, never auto-removed** |
| Community stewardship | Context repair, duplicate merge, branch organization, soft warnings | `ROLE_COMMUNITY`, `ROLE_EVIDENCE` | Steward cannot resolve; policy violation suspected |
| Professional moderation | Policy enforcement, urgent safety, appeals | `ROLE_SAFETY`, `ROLE_APPEALS` | Severity ≥ `severe`; legal risk; cross-room pattern |
| Integrity review | Coordination, brigading, bot activity, suspicious campaigns | `ROLE_INTEGRITY` | MFCI flag; multi-account pattern; financial-fraud signal |
| External escalation | Legal, child safety, imminent harm, regulator requests | Safety lead + counsel | Imminent physical danger; CSAM; law-enforcement request |

**Escalation-path requirements.**
- Each transition names the **minimum role** authorized to act at the receiving layer,
  consistent with `STEWARD_ROLES.md` (WS-A.2.2).
- The automated pre-check layer **never auto-removes policy-risk content**; it flags and
  prioritizes for the human layers (cross-cutting invariant 5; SPEC §18.2). Only two
  exceptions are auto-blocked: **high-confidence spam** (WS-J.2.6a) and **malware links**
  (WS-J.2.6b).
- The integrity-review layer follows the coordination-incident workflow (SPEC §29.3),
  stage for stage: **detect → assign severity → slow/freeze acceleration if threshold met
  → analyst case with preserved margins/baselines → moderator action or false-positive
  clear → public label update if distribution affected → log for transparency.**
- External escalation actions are frequently **irreversible** and therefore require
  additional approval (pairs with WS-A.2.2 irreversible-action co-approval and the
  emergency/treasury rules in WS-A.1.2c).
- **In-room AI moderation (SPEC §24.6, §16.6).** A Knomosis-enabled room may adopt a
  community-approved, member-downloadable AI agent that moderates **in-room** content within
  the room's voted law-pack. The agent operates *within* the layers above (an automated,
  room-scoped mechanism that sits **beneath** the platform legal floor), and every action it
  takes is logged, explainable, and **appealable to the human platform floor** (`ROLE_APPEALS`);
  `ROLE_SAFETY` removes illegal content over any room model and `ROLE_INTEGRITY` can
  `room-governance-freeze` the agent at any time. The agent **cannot** countermand a platform
  safety action, reinstate floor-removed content, or act on the floor-reserved categories
  (illegal content, legal/compliance duties, cross-room abuse). The platform automated
  pre-check rule that **platform**-policy-risk content is never auto-removed (invariant 5) is
  unchanged: it governs the platform floor, while bounded in-room auto-moderation is a
  per-room, member-ratified delegation beneath that floor.

---

## WS-A.1.2c — Appeal-eligibility matrix (SPEC §16.4, §18.3)

This matrix is the policy source that **WS-J.1.3a** implements; the two must agree
exactly, row for row.

| Action type | Appealable | Condition | Reviewed by |
|---|---|---|---|
| Warn | Yes | Immediately after action | `ROLE_APPEALS` |
| Hide (content) | Yes | Immediately after action | `ROLE_APPEALS` |
| Remove (content) | Yes | Immediately after action; **except CSAM and imminent threat** | `ROLE_APPEALS` |
| Restrict (account, temporary) | Yes | Immediately after action | `ROLE_APPEALS` |
| Shadow action (reduced distribution) | Yes | **User must be notified the action occurred**, then appealable | `ROLE_APPEALS` |
| Temporary suspension | Yes | After a cooling period | `ROLE_APPEALS` |
| Permanent ban | Yes | Once, after a cooldown (default 24h) | `ROLE_APPEALS` (senior) |
| Emergency restriction | No (deferred) | Not appealable until the emergency review completes; the resulting action is then appealable | `ROLE_SAFETY` → `ROLE_APPEALS` |
| Room governance freeze | Yes | Appealable to integrity analyst | `ROLE_INTEGRITY` |
| Treasury freeze | Yes | Requires documented review | `ROLE_INTEGRITY` (+ counsel) |

**Notice-and-appeal requirements.**
- Every significant action produces a **readable statement of reasons** including the
  reason code and, where appealable, the appeal path and any cooldown.
- A **support contact is published and reachable without authentication from every
  screen** (SPEC §18.3, §18.4; cross-cutting invariant 4), including in every statement of
  reasons and the public-incident-note template.
- **No silent sanctions:** shadow/reduced-distribution actions notify the user, satisfying
  the notice-and-appeal invariant.
- Ineligible-appeal states display **why** the appeal is unavailable and **when** it
  becomes available.
- The only non-appealable states are the enumerated exceptions: **CSAM**, **imminent
  threat**, and **in-flight emergency review** (which becomes appealable once the review
  completes).

---

## WS-A.1.2d — Crypto-specific abuse modes (SPEC §18.5, §17.10, §25.6)

Abuse modes introduced by Knomosis-enabled rooms. Each mode has indicators, a response
playbook drawing on the wallet/contract security controls (SPEC §25.6), the responsible
layer/role, and audit requirements. These modes extend the taxonomy with crypto-specific
reason codes under the `MOD_CRYPTO_*` namespace.

| Mode ID | Abuse mode | Indicators | Response (controls invoked) |
|---|---|---|---|
| `MOD_CRYPTO_DRAIN` | Wallet-drainer links | Links to malicious dApps that drain connected wallets | Link interstitials, URL blocklist, immediate removal, user notification |
| `MOD_CRYPTO_SIG` | Malicious signature prompts | Tricking users into signing harmful transactions | Signing-preview enforcement (EIP-712), allowlist validation, account action |
| `MOD_CRYPTO_IMPERS` | Impersonation (financial) | Impersonating stewards, rooms, journalists, grant recipients, support | Identity verification, content removal, account suspension |
| `MOD_CRYPTO_BOUNTY` | Bounty collusion | Fake completion evidence, coordinated false verification | Steward-review requirement, MFCI monitoring, payout hold |
| `MOD_CRYPTO_VOTEBUY` | Vote buying and coercion | Purchasing or coercing governance votes | MFCI detection, proposal challenge, governance freeze |
| `MOD_CRYPTO_BRIBE` | Bribery | Offering payment for specific moderation/governance outcomes | Audit-trail review, account action, law enforcement if warranted |
| `MOD_CRYPTO_CAPTURE` | Treasury capture | Wealthy/coordinated actors seizing treasury control | Capped voting power, role quorums, fork/exit provisions, challenge windows |
| `MOD_CRYPTO_SANCTION` | Sanctions evasion | Restricted actors transacting on the platform | Compliance screening, region gating, transaction monitoring, freeze |
| `MOD_CRYPTO_PAIDHARASS` | Paid harassment/brigading | Financial incentives coordinating harassment | MFCI detection, target protection, treasury freeze, law enforcement |
| `MOD_CRYPTO_PAIDREPORT` | Paid report abuse | Paying users to file false reports | Report-quality analysis, reporter reputation, integrity review |
| `MOD_CRYPTO_PAIDDISINFO` | Paid disinformation | Undisclosed paid promotion/coordinated influence | Disclosure requirements, MFCI detection, content labeling, account action |
| `MOD_CRYPTO_INVEST` | Misleading investment claims | Presenting crypto features as investment opportunities | Content labeling, risk disclosures, removal if fraudulent |
| `MOD_CRYPTO_GRANTFRAUD` | Fraudulent grants | Fake charities, fabricated invoices, phantom evidence | Steward review, audit log, fraud queue, treasury freeze |
| `MOD_CRYPTO_INVOICE` | Fabricated invoices | False financial claims against room treasuries | Multi-steward approval, evidence verification, challenge window |
| `MOD_CRYPTO_DAOREVEAL` | DAO vote to reveal private info | Using governance votes to expose private moderation/reporting data | **Platform-policy override; DAO supremacy does not extend to privacy** |

Representative reason codes (one per mode shown; namespaces extend as needed):
`MOD_CRYPTO_DRAIN_001`, `MOD_CRYPTO_SIG_001`, `MOD_CRYPTO_IMPERS_001`,
`MOD_CRYPTO_BOUNTY_001`, `MOD_CRYPTO_VOTEBUY_001`, `MOD_CRYPTO_BRIBE_001`,
`MOD_CRYPTO_CAPTURE_001`, `MOD_CRYPTO_SANCTION_001`, `MOD_CRYPTO_PAIDHARASS_001`,
`MOD_CRYPTO_PAIDREPORT_001`, `MOD_CRYPTO_PAIDDISINFO_001`, `MOD_CRYPTO_INVEST_001`,
`MOD_CRYPTO_GRANTFRAUD_001`, `MOD_CRYPTO_INVOICE_001`, `MOD_CRYPTO_DAOREVEAL_001`.

**Cross-cutting crypto-abuse requirements.**
- **Public incident note** — required when a treasury is **materially affected** (SPEC
  §18.5). *Trigger threshold:* any confirmed loss, freeze, or unauthorized disbursement
  affecting room-treasury funds, or any treasury freeze lasting longer than the
  challenge window. *Note template:* `{incident_id, room_id, affected_assets,
  detection_time, action_taken, current_status, reversibility, next_update_time,
  support_contact}` — published without leaking investigative detail or reporter identity.
- **DAO-reveal override** (`MOD_CRYPTO_DAOREVEAL`) is a **hard, unconditional
  platform-policy override**: no governance vote can compel disclosure of reporter
  identities, private moderation data, or minors' data (SPEC §19.5; privacy invariant 7).
  This is the doctrinal counterpart of the **M6 moderation-override gate**.
- All crypto-abuse actions are logged with the standard audit fields (see
  `STEWARD_ROLES.md`) plus the affected treasury/room and any on-chain reference
  (off-chain record with on-chain hash commitment where auditability is needed; SPEC §19.5).
- Financial-integrity responses (freezes, holds, challenge windows) are
  **reversible-where-possible and audited**.

---

## Canonical machine-readable enumeration

> Source of truth for severities, categories, reason codes, crypto modes, and appeal
> eligibility. Validated by `scripts/check-policy.ts`: counts (12 categories, 15 crypto
> modes), reason-code uniqueness and namespace conformance, severity→SLA consistency,
> and appeal-reviewer role references.

```json
{
  "document": "MODERATION_TAXONOMY",
  "version": "1.0.0",
  "severities": [
    { "severity": "minor", "sla_target": "72h" },
    { "severity": "moderate", "sla_target": "24h" },
    { "severity": "severe", "sla_target": "4h" },
    { "severity": "critical", "sla_target": "1h" }
  ],
  "categories": [
    { "category_id": "MOD_ILLEGAL", "namespace": "MOD_ILLEGAL_*", "severity_range": ["severe", "critical"] },
    { "category_id": "MOD_THREAT", "namespace": "MOD_THREAT_*", "severity_range": ["critical", "critical"] },
    { "category_id": "MOD_HARASS", "namespace": "MOD_HARASS_*", "severity_range": ["minor", "severe"] },
    { "category_id": "MOD_HATE", "namespace": "MOD_HATE_*", "severity_range": ["moderate", "critical"] },
    { "category_id": "MOD_CSE", "namespace": "MOD_CSE_*", "severity_range": ["critical", "critical"] },
    { "category_id": "MOD_GRAPHIC", "namespace": "MOD_GRAPHIC_*", "severity_range": ["moderate", "severe"] },
    { "category_id": "MOD_MISINFO", "namespace": "MOD_MISINFO_*", "severity_range": ["moderate", "severe"] },
    { "category_id": "MOD_IMPERS", "namespace": "MOD_IMPERS_*", "severity_range": ["moderate", "severe"] },
    { "category_id": "MOD_SPAM", "namespace": "MOD_SPAM_*", "severity_range": ["minor", "severe"] },
    { "category_id": "MOD_PRIVACY", "namespace": "MOD_PRIVACY_*", "severity_range": ["moderate", "critical"] },
    { "category_id": "MOD_SYNTH", "namespace": "MOD_SYNTH_*", "severity_range": ["minor", "severe"] },
    { "category_id": "MOD_IP", "namespace": "MOD_IP_*", "severity_range": ["minor", "moderate"] }
  ],
  "reason_codes": [
    { "category_id": "MOD_ILLEGAL", "reason_code": "MOD_ILLEGAL_001", "severity_default": "severe", "appealable": true, "sla_target": "4h" },
    { "category_id": "MOD_ILLEGAL", "reason_code": "MOD_ILLEGAL_002", "severity_default": "critical", "appealable": true, "sla_target": "1h" },
    { "category_id": "MOD_ILLEGAL", "reason_code": "MOD_ILLEGAL_003", "severity_default": "severe", "appealable": true, "sla_target": "4h" },
    { "category_id": "MOD_THREAT", "reason_code": "MOD_THREAT_001", "severity_default": "critical", "appealable": false, "sla_target": "1h" },
    { "category_id": "MOD_THREAT", "reason_code": "MOD_THREAT_002", "severity_default": "critical", "appealable": false, "sla_target": "1h" },
    { "category_id": "MOD_THREAT", "reason_code": "MOD_THREAT_003", "severity_default": "severe", "appealable": true, "sla_target": "4h" },
    { "category_id": "MOD_HARASS", "reason_code": "MOD_HARASS_001", "severity_default": "moderate", "appealable": true, "sla_target": "24h" },
    { "category_id": "MOD_HARASS", "reason_code": "MOD_HARASS_002", "severity_default": "severe", "appealable": true, "sla_target": "4h" },
    { "category_id": "MOD_HARASS", "reason_code": "MOD_HARASS_003", "severity_default": "severe", "appealable": true, "sla_target": "4h" },
    { "category_id": "MOD_HATE", "reason_code": "MOD_HATE_001", "severity_default": "moderate", "appealable": true, "sla_target": "24h" },
    { "category_id": "MOD_HATE", "reason_code": "MOD_HATE_002", "severity_default": "severe", "appealable": true, "sla_target": "4h" },
    { "category_id": "MOD_HATE", "reason_code": "MOD_HATE_003", "severity_default": "critical", "appealable": false, "sla_target": "1h" },
    { "category_id": "MOD_CSE", "reason_code": "MOD_CSE_001", "severity_default": "critical", "appealable": false, "sla_target": "1h" },
    { "category_id": "MOD_CSE", "reason_code": "MOD_CSE_002", "severity_default": "critical", "appealable": false, "sla_target": "1h" },
    { "category_id": "MOD_CSE", "reason_code": "MOD_CSE_003", "severity_default": "critical", "appealable": false, "sla_target": "1h" },
    { "category_id": "MOD_GRAPHIC", "reason_code": "MOD_GRAPHIC_001", "severity_default": "moderate", "appealable": true, "sla_target": "24h" },
    { "category_id": "MOD_GRAPHIC", "reason_code": "MOD_GRAPHIC_002", "severity_default": "severe", "appealable": true, "sla_target": "4h" },
    { "category_id": "MOD_GRAPHIC", "reason_code": "MOD_GRAPHIC_003", "severity_default": "severe", "appealable": true, "sla_target": "4h" },
    { "category_id": "MOD_MISINFO", "reason_code": "MOD_MISINFO_001", "severity_default": "severe", "appealable": true, "sla_target": "4h" },
    { "category_id": "MOD_MISINFO", "reason_code": "MOD_MISINFO_002", "severity_default": "severe", "appealable": true, "sla_target": "4h" },
    { "category_id": "MOD_MISINFO", "reason_code": "MOD_MISINFO_003", "severity_default": "moderate", "appealable": true, "sla_target": "24h" },
    { "category_id": "MOD_IMPERS", "reason_code": "MOD_IMPERS_001", "severity_default": "moderate", "appealable": true, "sla_target": "24h" },
    { "category_id": "MOD_IMPERS", "reason_code": "MOD_IMPERS_002", "severity_default": "severe", "appealable": true, "sla_target": "4h" },
    { "category_id": "MOD_IMPERS", "reason_code": "MOD_IMPERS_003", "severity_default": "moderate", "appealable": true, "sla_target": "24h" },
    { "category_id": "MOD_SPAM", "reason_code": "MOD_SPAM_001", "severity_default": "minor", "appealable": true, "sla_target": "72h" },
    { "category_id": "MOD_SPAM", "reason_code": "MOD_SPAM_002", "severity_default": "moderate", "appealable": true, "sla_target": "24h" },
    { "category_id": "MOD_SPAM", "reason_code": "MOD_SPAM_003", "severity_default": "severe", "appealable": true, "sla_target": "4h" },
    { "category_id": "MOD_PRIVACY", "reason_code": "MOD_PRIVACY_001", "severity_default": "moderate", "appealable": true, "sla_target": "24h" },
    { "category_id": "MOD_PRIVACY", "reason_code": "MOD_PRIVACY_002", "severity_default": "severe", "appealable": true, "sla_target": "4h" },
    { "category_id": "MOD_PRIVACY", "reason_code": "MOD_PRIVACY_003", "severity_default": "critical", "appealable": true, "sla_target": "1h" },
    { "category_id": "MOD_SYNTH", "reason_code": "MOD_SYNTH_001", "severity_default": "minor", "appealable": true, "sla_target": "72h" },
    { "category_id": "MOD_SYNTH", "reason_code": "MOD_SYNTH_002", "severity_default": "moderate", "appealable": true, "sla_target": "24h" },
    { "category_id": "MOD_SYNTH", "reason_code": "MOD_SYNTH_003", "severity_default": "severe", "appealable": true, "sla_target": "4h" },
    { "category_id": "MOD_IP", "reason_code": "MOD_IP_001", "severity_default": "minor", "appealable": true, "sla_target": "72h" },
    { "category_id": "MOD_IP", "reason_code": "MOD_IP_002", "severity_default": "minor", "appealable": true, "sla_target": "72h" },
    { "category_id": "MOD_IP", "reason_code": "MOD_IP_003", "severity_default": "moderate", "appealable": true, "sla_target": "24h" },
    { "category_id": "MOD_CRYPTO_DRAIN", "reason_code": "MOD_CRYPTO_DRAIN_001", "severity_default": "critical", "appealable": true, "sla_target": "1h" },
    { "category_id": "MOD_CRYPTO_SIG", "reason_code": "MOD_CRYPTO_SIG_001", "severity_default": "severe", "appealable": true, "sla_target": "4h" },
    { "category_id": "MOD_CRYPTO_IMPERS", "reason_code": "MOD_CRYPTO_IMPERS_001", "severity_default": "severe", "appealable": true, "sla_target": "4h" },
    { "category_id": "MOD_CRYPTO_BOUNTY", "reason_code": "MOD_CRYPTO_BOUNTY_001", "severity_default": "moderate", "appealable": true, "sla_target": "24h" },
    { "category_id": "MOD_CRYPTO_VOTEBUY", "reason_code": "MOD_CRYPTO_VOTEBUY_001", "severity_default": "severe", "appealable": true, "sla_target": "4h" },
    { "category_id": "MOD_CRYPTO_BRIBE", "reason_code": "MOD_CRYPTO_BRIBE_001", "severity_default": "severe", "appealable": true, "sla_target": "4h" },
    { "category_id": "MOD_CRYPTO_CAPTURE", "reason_code": "MOD_CRYPTO_CAPTURE_001", "severity_default": "severe", "appealable": true, "sla_target": "4h" },
    { "category_id": "MOD_CRYPTO_SANCTION", "reason_code": "MOD_CRYPTO_SANCTION_001", "severity_default": "critical", "appealable": true, "sla_target": "1h" },
    { "category_id": "MOD_CRYPTO_PAIDHARASS", "reason_code": "MOD_CRYPTO_PAIDHARASS_001", "severity_default": "severe", "appealable": true, "sla_target": "4h" },
    { "category_id": "MOD_CRYPTO_PAIDREPORT", "reason_code": "MOD_CRYPTO_PAIDREPORT_001", "severity_default": "moderate", "appealable": true, "sla_target": "24h" },
    { "category_id": "MOD_CRYPTO_PAIDDISINFO", "reason_code": "MOD_CRYPTO_PAIDDISINFO_001", "severity_default": "severe", "appealable": true, "sla_target": "4h" },
    { "category_id": "MOD_CRYPTO_INVEST", "reason_code": "MOD_CRYPTO_INVEST_001", "severity_default": "moderate", "appealable": true, "sla_target": "24h" },
    { "category_id": "MOD_CRYPTO_GRANTFRAUD", "reason_code": "MOD_CRYPTO_GRANTFRAUD_001", "severity_default": "severe", "appealable": true, "sla_target": "4h" },
    { "category_id": "MOD_CRYPTO_INVOICE", "reason_code": "MOD_CRYPTO_INVOICE_001", "severity_default": "severe", "appealable": true, "sla_target": "4h" },
    { "category_id": "MOD_CRYPTO_DAOREVEAL", "reason_code": "MOD_CRYPTO_DAOREVEAL_001", "severity_default": "critical", "appealable": false, "sla_target": "1h" }
  ],
  "crypto_modes": [
    { "mode_id": "MOD_CRYPTO_DRAIN", "name": "Wallet-drainer links" },
    { "mode_id": "MOD_CRYPTO_SIG", "name": "Malicious signature prompts" },
    { "mode_id": "MOD_CRYPTO_IMPERS", "name": "Impersonation (financial)" },
    { "mode_id": "MOD_CRYPTO_BOUNTY", "name": "Bounty collusion" },
    { "mode_id": "MOD_CRYPTO_VOTEBUY", "name": "Vote buying and coercion" },
    { "mode_id": "MOD_CRYPTO_BRIBE", "name": "Bribery" },
    { "mode_id": "MOD_CRYPTO_CAPTURE", "name": "Treasury capture" },
    { "mode_id": "MOD_CRYPTO_SANCTION", "name": "Sanctions evasion" },
    { "mode_id": "MOD_CRYPTO_PAIDHARASS", "name": "Paid harassment/brigading" },
    { "mode_id": "MOD_CRYPTO_PAIDREPORT", "name": "Paid report abuse" },
    { "mode_id": "MOD_CRYPTO_PAIDDISINFO", "name": "Paid disinformation" },
    { "mode_id": "MOD_CRYPTO_INVEST", "name": "Misleading investment claims" },
    { "mode_id": "MOD_CRYPTO_GRANTFRAUD", "name": "Fraudulent grants" },
    { "mode_id": "MOD_CRYPTO_INVOICE", "name": "Fabricated invoices" },
    { "mode_id": "MOD_CRYPTO_DAOREVEAL", "name": "DAO vote to reveal private info" }
  ],
  "layers": [
    { "layer": "User controls", "operated_by": ["end-user"], "escalation_trigger": "User initiates report" },
    { "layer": "Automated pre-checks", "operated_by": ["system"], "escalation_trigger": "Automated flag exceeds threshold; policy-risk routes to a human (never auto-removed)" },
    { "layer": "Community stewardship", "operated_by": ["ROLE_COMMUNITY", "ROLE_EVIDENCE"], "escalation_trigger": "Steward cannot resolve; policy violation suspected" },
    { "layer": "Professional moderation", "operated_by": ["ROLE_SAFETY", "ROLE_APPEALS"], "escalation_trigger": "Severity >= severe; legal risk; cross-room pattern" },
    { "layer": "Integrity review", "operated_by": ["ROLE_INTEGRITY"], "escalation_trigger": "MFCI flag; multi-account pattern; financial-fraud signal" },
    { "layer": "External escalation", "operated_by": ["safety-lead", "counsel"], "escalation_trigger": "Imminent physical danger; CSAM; law-enforcement request" }
  ],
  "appeal_eligibility": [
    { "action_type": "Warn", "appealable": true, "role_id": "ROLE_APPEALS" },
    { "action_type": "Hide (content)", "appealable": true, "role_id": "ROLE_APPEALS" },
    { "action_type": "Remove (content)", "appealable": true, "role_id": "ROLE_APPEALS", "exceptions": ["MOD_CSE", "imminent-threat"] },
    { "action_type": "Restrict (account, temporary)", "appealable": true, "role_id": "ROLE_APPEALS" },
    { "action_type": "Shadow action (reduced distribution)", "appealable": true, "role_id": "ROLE_APPEALS", "requires_user_notice": true },
    { "action_type": "Temporary suspension", "appealable": true, "role_id": "ROLE_APPEALS" },
    { "action_type": "Permanent ban", "appealable": true, "role_id": "ROLE_APPEALS", "senior": true },
    { "action_type": "Emergency restriction", "appealable": false, "role_id": "ROLE_SAFETY", "then_role_id": "ROLE_APPEALS", "deferred": true },
    { "action_type": "Room governance freeze", "appealable": true, "role_id": "ROLE_INTEGRITY" },
    { "action_type": "Treasury freeze", "appealable": true, "role_id": "ROLE_INTEGRITY", "co_approver": "counsel" }
  ]
}
```

---

## Changelog

| Version | Date | Author | Change | Sign-off |
|---|---|---|---|---|
| 1.0.0 | 2026-06-08 | Doctrine & Policy WG | Initial ratified taxonomy: 12 policy categories with description/examples/severity/SLA/evidence/escalation/reason codes (WS-A.1.2a), 6 moderation layers and SPEC §29.3-aligned escalation path (WS-A.1.2b), 10-row appeal-eligibility matrix (WS-A.1.2c), 15 crypto abuse modes with the DAO-reveal privacy override (WS-A.1.2d). Machine-readable enumeration with 51 reason codes plus layers; categories, layers, and crypto modes cross-validated against SPEC §18.1/§18.2/§18.5. | Reviewed and ratified by hatter6822 (maintainer), 2026-06-08 |
| 1.1.0 | 2026-06-19 | Doctrine & Policy WG | AI-governed-rooms redesign (SPEC §16.6, §24.6): documented **in-room AI moderation** as a per-room, member-ratified, law-pack-bounded delegation that operates *within* the existing 6 layers and *beneath* the platform legal floor — logged, explainable, and appealable to `ROLE_APPEALS`, overridable by `ROLE_SAFETY`/`ROLE_INTEGRITY`, and barred from the floor-reserved categories. The 12 categories, 6 layers, 15 crypto modes, and 51 reason codes are unchanged (gate set-equality with SPEC §18.2 preserved); the platform "never auto-remove policy-risk" rule (invariant 5) is unchanged for the floor. | Pending maintainer ratification (redesign Stage 0) |

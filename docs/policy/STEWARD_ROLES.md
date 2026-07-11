# Licio Steward Roles and Capabilities

> Stewards are the human governance layer between automated systems and external
> escalation. Their roles are defined precisely so capability grants, audit logs, and
> accountability structures can be implemented correctly by WS-J (console authorization)
> and WS-D.1 (role grants and MFA).

| Field | Value |
|---|---|
| **Document ID** | `STEWARD_ROLES` |
| **Produced by** | WS-A.2.2 |
| **Version** | 1.1.0 |
| **Owner** | Licio Maintainers — Doctrine & Policy Working Group |
| **Effective date** | 2026-06-19 |
| **Status** | Ratified by maintainer (hatter6822) — 2026-06-08 (M0 doctrine gate); amended 2026-06-19 (AI-governed-rooms redesign) |
| **SPEC references** | §16.3, §16.4, §16.6, §24.6, §25.3, §25.4 |
| **Primary consumers** | WS-J.2 (console authz), WS-D.1 (role grants, MFA), WS-O (audit) |

**Role-ID convention.** `ROLE_*`. The canonical machine-readable enumeration at the end
is the source of truth. Role IDs referenced by `MODERATION_TAXONOMY.md` (layers and
appeal-eligibility reviewers) must resolve to a role defined here.

---

## The five steward roles (SPEC §16.3)

| Role | Role ID | Capabilities | Access level | Accountability |
|---|---|---|---|---|
| Community steward | `ROLE_COMMUNITY` | Organize threads, request context, merge duplicates, escalate moderation, issue soft warnings, suggest branch organization | Room-level content management; **no account-level actions** | Actions audited; subject to community feedback; removable by room governance or platform |
| Evidence steward | `ROLE_EVIDENCE` | Review sourced comments and their citations, mark primary sources, flag weak citations, verify source provenance, suggest evidence gaps | Citation metadata; source-profile annotations | Actions audited; evidence decisions reviewable; **no content-removal power** |
| Safety moderator | `ROLE_SAFETY` | Enforce policy, handle reports, protect targets, issue warnings, remove content, restrict accounts (temporary), apply safety labels | Cross-room content and account actions within policy scope | All actions logged with reason codes; subject to appeal; **required training** |
| Appeals reviewer | `ROLE_APPEALS` | Review disputed moderation/account actions, overturn/uphold/modify, document reasoning | Read access to moderation history and evidence; decision authority on appeals | Decisions logged with full reasoning; **independent from the original moderator**; periodic quality review |
| Integrity analyst | `ROLE_INTEGRITY` | Investigate coordination, spam, manipulation, raids, bot networks, financial-abuse patterns; place room-governance/treasury freezes | Cross-room analytics, MFCI data, account patterns, financial-transaction patterns | Investigations logged; actions require documentation; **sensitive-data access time-limited and audited** |

---

## The platform legal floor and the elected room steward (SPEC §16.6, §24.6)

The **AI-governed-rooms redesign** (SPEC §16.6, §24.6; `docs/planning/22-ai-governed-rooms.md`)
partitions room authority into three precedence-ordered layers. These five `ROLE_*` roles are
the **platform legal floor** — the cross-room, **non-overridable** human layer — and a new
per-room governance seat sits at the room-sovereignty layer below them.

**The five `ROLE_*` roles are the platform legal floor (Layer 3).** They operate **above every
room** and no room, elected room steward, AI model, prompt, or governance vote can countermand
them. The floor's reserved duties are **illegal content** (CSAM, terrorism, sanctioned actors),
**legal/compliance duties** (mandatory reporting, sanctions, age/jurisdiction gating), and
**cross-room abuse** (raids, ban evasion, platform-wide manipulation), plus **appeals of last
resort**. Every in-room AI moderation action (Layer 2) is appealable to `ROLE_APPEALS`;
`ROLE_SAFETY` removes illegal content over any room model; `ROLE_INTEGRITY` owns the cross-room
surface and can `room-governance-freeze`/`treasury-freeze` any room's agent. This is the
existing SPEC §17.1 boundary 5 ("No DAO supremacy over safety"), made load-bearing.

**The elected room steward (`ELECTED_ROOM_STEWARD`) — a per-room seat, not a platform role.**
Distinct from the five platform `ROLE_*` roles, every room has exactly one elected steward seat
(identified as `ELECTED_ROOM_STEWARD`; deliberately **outside** the platform `ROLE_*` namespace
because it is not a platform role and holds no platform capabilities). It is bootstrapped to the
room's first member at creation and re-elected yearly by a **Knomosis governance vote** of the
room's members. It holds **exactly two powers**, and **neither takes effect without a member
vote**:

| Seat | Identifier | The two powers (both member-ratified by Knomosis vote) | What it explicitly is **not** | Accountability |
|---|---|---|---|---|
| Elected room steward | `ELECTED_ROOM_STEWARD` | (1) propose a community-approved, hash-pinned, member-downloadable governance/moderation AI model; (2) propose the in-room prompt for it | **No** direct moderation, treasury, account, or lawmaking authority; **no** platform `ROLE_*` capability; **cannot** countermand the platform legal floor | Yearly Knomosis election; both powers require a member ratifying vote; the approved model + prompt are member-downloadable and reproducible; removable by the platform floor |

Because the steward only *proposes* (members ratify, the kernel enforces, the floor overrides),
capturing the seat confers agenda-setting only — not rule. The **approved AI agent** (SPEC §24.6),
not the steward, exercises in-room moderation/treasury/lawmaking, and only within community-voted,
kernel-enforced bounds while holding no keys. Until a room approves a model + prompt, it runs on
the platform moderation baseline (`MODERATION_TAXONOMY.md` layers) plus this floor.

---

## Capability → action mapping (so console authorization is unambiguous)

Each role maps to the specific console actions it may invoke (the WS-J.2.3 action
palette) and the queues it may access. The mapping is consistent with the
appeal-eligibility matrix in `MODERATION_TAXONOMY.md` (WS-A.1.2c).

| Action (WS-J.2.3 palette) | Authorized role(s) | Notes |
|---|---|---|
| `warn` | `ROLE_SAFETY` | Soft warnings also issuable by `ROLE_COMMUNITY` within a room |
| `hide` | `ROLE_SAFETY` | |
| `remove` | `ROLE_SAFETY` | Reason code required |
| `restrict` (temporary) | `ROLE_SAFETY` | Account-level, time-bounded |
| `shadow` (reduced distribution) | `ROLE_SAFETY` | **User notified** (no silent sanction) |
| `suspend` (temporary) | `ROLE_SAFETY` | |
| `ban` (permanent) | `ROLE_SAFETY` (senior) | Appealable to `ROLE_APPEALS` (senior) |
| `overturn` / `uphold` / `modify` | `ROLE_APPEALS` **only** | Decision authority on appeals |
| `merge-duplicates` / `request-context` / `organize-branches` | `ROLE_COMMUNITY` | Thread-health actions |
| `mark-primary-source` / `flag-citation` | `ROLE_EVIDENCE` | Evidence metadata only |
| `room-governance-freeze` | `ROLE_INTEGRITY` **only** | |
| `treasury-freeze` | `ROLE_INTEGRITY` **only** | **Requires counsel co-approval** (WS-A.1.2c) |
| `mfci-coordination-detail` (read) | `ROLE_INTEGRITY` **only** | Time-limited, audited |

**Queue access.**

| Queue | Roles with access |
|---|---|
| Report queue | `ROLE_SAFETY`, `ROLE_COMMUNITY` (room scope) |
| Appeal queue | `ROLE_APPEALS` |
| Integrity queue (MFCI/coordination) | `ROLE_INTEGRITY` |
| Evidence queue | `ROLE_EVIDENCE` |

Only `ROLE_SAFETY` may invoke remove/restrict; only `ROLE_APPEALS` may overturn/modify;
only `ROLE_INTEGRITY` may access MFCI coordination detail and place a room-governance or
treasury freeze (the latter with counsel co-approval).

---

## Audit fields (every steward action emits)

`actor_identity`, `role`, `timestamp`, `action_type`, `reason_code` (from
`MODERATION_TAXONOMY.md`), `target` (content / account / room), `affected_distribution_state`,
`reversibility_flag`, and `co_approver` (for irreversible/high-impact actions).

---

## Cross-cutting requirements (SPEC §16.4, §25.3, §25.4)

- All steward actions are logged with timestamps, reason codes, and actor identity.
- Public transparency reports summarize moderation and integrity actions **in aggregate**
  (`TRANSPARENCY_DICTIONARY.md` breakdowns).
- **Least privilege:** stewards cannot access private attention ledgers, reporter
  identities, or personal data beyond what the role requires (privacy invariant).
- **MFA is required for all steward accounts** (SPEC §25.3).
- Steward actions are **reversible where possible**; **irreversible actions require
  additional approval** (pairs with the WS-A.1.2c emergency/treasury rules).
- High-impact policy changes require a **changelog and user notice**.
- Steward roles require **training completion before capability grant**.

**Role hierarchy / escalation.** Consistent with the moderation layers
(`MODERATION_TAXONOMY.md`, WS-A.1.2b): `ROLE_COMMUNITY`/`ROLE_EVIDENCE` operate the
community-stewardship layer; `ROLE_SAFETY`/`ROLE_APPEALS` operate the professional-
moderation layer; `ROLE_INTEGRITY` operates the integrity-review layer; external
escalation is handled by the safety lead + counsel.

---

## Canonical machine-readable enumeration

> Validated by `scripts/check-policy.ts`: 5 roles, `ROLE_*` naming, uniqueness, and that
> every role referenced by `MODERATION_TAXONOMY.md` resolves here.

```json
{
  "document": "STEWARD_ROLES",
  "version": "1.0.0",
  "roles": [
    {
      "role_id": "ROLE_COMMUNITY",
      "name": "Community steward",
      "actions": ["warn", "merge-duplicates", "request-context", "organize-branches"],
      "queues": ["report-queue"],
      "account_level_actions": false
    },
    {
      "role_id": "ROLE_EVIDENCE",
      "name": "Evidence steward",
      "actions": ["mark-primary-source", "flag-citation"],
      "queues": ["evidence-queue"],
      "account_level_actions": false
    },
    {
      "role_id": "ROLE_SAFETY",
      "name": "Safety moderator",
      "actions": ["warn", "hide", "remove", "restrict", "shadow", "suspend", "ban"],
      "queues": ["report-queue"],
      "account_level_actions": true
    },
    {
      "role_id": "ROLE_APPEALS",
      "name": "Appeals reviewer",
      "actions": ["overturn", "uphold", "modify"],
      "queues": ["appeal-queue"],
      "account_level_actions": true
    },
    {
      "role_id": "ROLE_INTEGRITY",
      "name": "Integrity analyst",
      "actions": ["room-governance-freeze", "treasury-freeze", "mfci-coordination-detail"],
      "queues": ["integrity-queue"],
      "account_level_actions": true
    }
  ]
}
```

---

## Changelog

| Version | Date | Author | Change | Sign-off |
|---|---|---|---|---|
| 1.0.1 | 2026-07-11 | Maintainer | Evidence-steward scope rebased on comment-centric sourcing (sourced comments and citations) after the EvidenceCard entity was removed; role ids, capabilities, and queues unchanged. | Directed by hatter6822 (maintainer), 2026-07-11 |
| 1.0.0 | 2026-06-08 | Doctrine & Policy WG | Initial ratified roles: 5 steward roles with role IDs, capabilities, access levels, accountability, audit fields, and a capability→action/queue mapping consistent with the WS-J console and WS-A.1.2c appeal eligibility. MFA, least-privilege, training, and irreversible-action co-approval mandated; role set cross-validated against SPEC §16.3. | Reviewed and ratified by hatter6822 (maintainer), 2026-06-08 |
| 1.1.0 | 2026-06-19 | Doctrine & Policy WG | AI-governed-rooms redesign (SPEC §16.6, §24.6): reframed the five `ROLE_*` roles as the **platform legal floor** (cross-room, non-overridable) and added the per-room **elected room steward** (`ELECTED_ROOM_STEWARD`) — a seat with exactly two member-ratified powers (propose an AI model; propose its prompt), holding no platform capability and unable to countermand the floor. The canonical 5-role enumeration is unchanged (gate set-equality with SPEC §16.3 preserved); the new seat is documented as a distinct room-sovereignty-layer role. | Pending maintainer ratification (redesign Stage 0) |

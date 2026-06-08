# Licio Steward Roles and Capabilities

> Stewards are the human governance layer between automated systems and external
> escalation. Their roles are defined precisely so capability grants, audit logs, and
> accountability structures can be implemented correctly by WS-J (console authorization)
> and WS-D.1 (role grants and MFA).

| Field | Value |
|---|---|
| **Document ID** | `STEWARD_ROLES` |
| **Produced by** | WS-A.2.2 |
| **Version** | 1.0.0 |
| **Owner** | Licio Maintainers — Doctrine & Policy Working Group |
| **Effective date** | 2026-06-08 |
| **Status** | Ratified by maintainer (hatter6822) — 2026-06-08 (M0 doctrine gate) |
| **SPEC references** | §16.3, §16.4, §25.3, §25.4 |
| **Primary consumers** | WS-J.2 (console authz), WS-D.1 (role grants, MFA), WS-O (audit) |

**Role-ID convention.** `ROLE_*`. The canonical machine-readable enumeration at the end
is the source of truth. Role IDs referenced by `MODERATION_TAXONOMY.md` (layers and
appeal-eligibility reviewers) must resolve to a role defined here.

---

## The five steward roles (SPEC §16.3)

| Role | Role ID | Capabilities | Access level | Accountability |
|---|---|---|---|---|
| Community steward | `ROLE_COMMUNITY` | Organize threads, request context, merge duplicates, escalate moderation, issue soft warnings, suggest branch organization | Room-level content management; **no account-level actions** | Actions audited; subject to community feedback; removable by room governance or platform |
| Evidence steward | `ROLE_EVIDENCE` | Review evidence cards, mark primary sources, flag weak citations, verify source provenance, suggest evidence gaps | Evidence-card metadata; source-profile annotations | Actions audited; evidence decisions reviewable; **no content-removal power** |
| Safety moderator | `ROLE_SAFETY` | Enforce policy, handle reports, protect targets, issue warnings, remove content, restrict accounts (temporary), apply safety labels | Cross-room content and account actions within policy scope | All actions logged with reason codes; subject to appeal; **required training** |
| Appeals reviewer | `ROLE_APPEALS` | Review disputed moderation/account actions, overturn/uphold/modify, document reasoning | Read access to moderation history and evidence; decision authority on appeals | Decisions logged with full reasoning; **independent from the original moderator**; periodic quality review |
| Integrity analyst | `ROLE_INTEGRITY` | Investigate coordination, spam, manipulation, raids, bot networks, financial-abuse patterns; place room-governance/treasury freezes | Cross-room analytics, MFCI data, account patterns, financial-transaction patterns | Investigations logged; actions require documentation; **sensitive-data access time-limited and audited** |

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
| 1.0.0 | 2026-06-08 | Doctrine & Policy WG | Initial ratified roles: 5 steward roles with role IDs, capabilities, access levels, accountability, audit fields, and a capability→action/queue mapping consistent with the WS-J console and WS-A.1.2c appeal eligibility. MFA, least-privilege, training, and irreversible-action co-approval mandated; role set cross-validated against SPEC §16.3. | Reviewed and ratified by hatter6822 (maintainer), 2026-06-08 |

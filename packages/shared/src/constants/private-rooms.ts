// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-S.0.2/0.3 — the SINGLE SOURCE of the mandatory Private P2P room honest-
// limits copy (PRIVATE_SPEC §6, §20.2, §20.5) and the Appendix E privacy
// matrix.  These are BLOCKING copy, not advisory: the creation wizard
// (WS-S.7.1) cannot proceed without all five acknowledgments, and the matrix is
// referenced from each room class's creation/info surface.  Keeping them here
// (locale-ready constants) means the UI, the docs, and the support copy share
// ONE wording that the prohibited-language copy-lint test pins — no UI string
// may promise impossible recovery/moderation or a false "secure"/"deleted
// everywhere".
//
// Naming discipline (§20.1): "Private" UNQUALIFIED is reserved for `private_p2p`
// rooms.  A WS-Q server-hosted restricted room is a "Members-only server room",
// NEVER simply "private".

/** §6 — the mandatory creation disclosure (shown + acknowledged before any key
 *  is generated, WS-S.7.1).  Verbatim from PRIVATE_SPEC §6. */
export const PRIVATE_ROOM_CREATION_DISCLOSURE =
  "This is a Private P2P room. Licio does not host the room's content and cannot " +
  'read, moderate, recover, or add members to it. The room is available only ' +
  "while enough members' devices or member-operated encrypted pins keep copies. " +
  'Removed members may keep content they already received. Members can still copy ' +
  'or disclose content. Keep a recovery kit if you cannot afford to lose access.';

/** §20.5 — the removal dialog disclosure (non-retroactive: future reading only). */
export const PRIVATE_ROOM_REMOVAL_DISCLOSURE =
  'This stops the member from reading future room updates after keys rotate. It ' +
  'cannot delete or recall content they already downloaded or copied.';

/** §20.2 — the five mandatory creation acknowledgments.  Creation is BLOCKED
 *  until every one is checked (WS-S.7.1).  Each has a stable id + exact label. */
export const PRIVATE_ROOM_CREATION_ACKNOWLEDGMENTS = [
  { id: 'cannot_recover', label: 'Licio cannot read or recover this room.' },
  { id: 'keys_lost_permanent', label: 'If keys are lost, access can be lost permanently.' },
  { id: 'members_can_copy', label: 'Members can copy or disclose content.' },
  {
    id: 'removal_not_deletion',
    label: 'Removing a member does not delete content they already received.',
  },
  {
    id: 'availability_device_dependent',
    label: 'Availability depends on member devices or member-operated pins.',
  },
] as const;

export type PrivateRoomAcknowledgmentId =
  (typeof PRIVATE_ROOM_CREATION_ACKNOWLEDGMENTS)[number]['id'];

/** Every acknowledgment id that MUST be checked before creation proceeds. */
export const REQUIRED_PRIVATE_ROOM_ACKNOWLEDGMENT_IDS: readonly PrivateRoomAcknowledgmentId[] =
  PRIVATE_ROOM_CREATION_ACKNOWLEDGMENTS.map((a) => a.id);

/** §20.1 — the canonical UI labels for the three room classes (Appendix E
 *  columns).  Server-hosted restricted rooms are NEVER labelled simply
 *  "private". */
export const ROOM_CLASS_UI_LABELS = {
  public_server: 'Public room',
  restricted_server: 'Members-only server room',
  private_p2p: 'Private P2P room',
} as const;

/** One privacy-matrix question with its answer per room class (Appendix E). */
export interface PrivacyMatrixRow {
  question: string;
  public_server: string;
  restricted_server: string;
  private_p2p: string;
}

/** Appendix E — the required user-facing privacy matrix (verbatim answers). */
export const PRIVATE_ROOM_PRIVACY_MATRIX: readonly PrivacyMatrixRow[] = [
  {
    question: 'Can Licio host content?',
    public_server: 'Yes',
    restricted_server: 'Yes',
    private_p2p: 'No',
  },
  {
    question: 'Can Licio admins technically access content?',
    public_server: 'Yes',
    restricted_server: 'Yes',
    private_p2p: 'No',
  },
  {
    question: 'Can content be globally ranked?',
    public_server: 'Yes',
    restricted_server: 'No, except server-local surfaces',
    private_p2p: 'No',
  },
  {
    question: 'Can Licio recover lost access?',
    public_server: 'Account-dependent',
    restricted_server: 'Account-dependent',
    private_p2p: 'No',
  },
  {
    question: 'Can members leak content?',
    public_server: 'Yes',
    restricted_server: 'Yes',
    private_p2p: 'Yes',
  },
  {
    question: 'Can removed members read old downloaded content?',
    public_server: 'Yes',
    restricted_server: 'Yes',
    private_p2p: 'Yes',
  },
  {
    question: 'Does availability depend on member devices?',
    public_server: 'No',
    restricted_server: 'No',
    private_p2p: 'Yes',
  },
  {
    question: 'Are public IPFS gateways used?',
    public_server: 'Maybe for public content if ever added',
    restricted_server: 'No need',
    private_p2p: 'Forbidden',
  },
];

// ---------------------------------------------------------------------------
// WS-S.9 — server→private migration (PRIVATE_SPEC §24).  A Members-only server
// room is NEVER silently upgraded: migration creates a NEW P2P room and
// optionally re-imports history through a member's client.  This copy is the
// SSOT for the migration wizard (pinned by the prohibited-language copy-lint —
// it must never imply migration retroactively erases past server access).
// ---------------------------------------------------------------------------

/** §24.3 — the verbatim, blocking migration warning shown before any import. */
export const PRIVATE_ROOM_MIGRATION_WARNING =
  'This migration improves privacy from this point forward. Imported history was ' +
  'previously stored on Licio servers, so migration cannot make past server access ' +
  'impossible. You may start fresh instead.';

/** The §24.2 Phase-3 import modes, each with its honest leakage disclosure. */
export const PRIVATE_ROOM_IMPORT_MODES = [
  {
    id: 'fresh',
    label: 'Fresh start',
    description: 'No old content is imported.',
    disclosure: 'Best privacy going forward — nothing previously on the server is carried over.',
  },
  {
    id: 'selected',
    label: 'Selected import',
    description: 'You select threads/posts to re-encrypt locally.',
    disclosure:
      'The items you import were previously server-hosted; importing them does not undo that.',
  },
  {
    id: 'full',
    label: 'Full import',
    description: 'The client fetches all old room content and re-encrypts it into the P2P room.',
    disclosure:
      'Highest convenience, but NOT retroactive privacy — all imported history was previously on the server.',
  },
  {
    id: 'redacted',
    label: 'Redacted import',
    description: 'Titles/summaries only.',
    disclosure:
      'Lower leakage of old content, but the imported titles/summaries were still previously server-hosted.',
  },
] as const;

export type PrivateRoomImportModeId = (typeof PRIVATE_ROOM_IMPORT_MODES)[number]['id'];

/** §24.2 — the ordered migration phases (the wizard step model). */
export const PRIVATE_ROOM_MIGRATION_PHASES = [
  {
    id: 'rename_disclose',
    label: 'Rename & disclose',
    detail: 'The old room is relabelled a Members-only server room.',
  },
  {
    id: 'create_destination',
    label: 'Create P2P destination',
    detail: 'A new P2P room — keys + manifest generated on your device.',
  },
  {
    id: 'choose_import',
    label: 'Choose import mode',
    detail: 'Fresh / Selected / Full / Redacted, each with its leakage disclosure.',
  },
  {
    id: 'reinvite_members',
    label: 'Re-invite members',
    detail: 'Server membership does not grant P2P access; members rejoin via P2P invites.',
  },
  {
    id: 'freeze_old',
    label: 'Freeze old room',
    detail: 'The old server room becomes read-only, pointing to the P2P replacement.',
  },
  {
    id: 'purge_minimize',
    label: 'Purge / minimize',
    detail: 'Where policy + law permit, old server data is purged or minimized.',
  },
] as const;

export type PrivateRoomMigrationPhaseId = (typeof PRIVATE_ROOM_MIGRATION_PHASES)[number]['id'];

/**
 * §15.3.1 — the bounded rendezvous poll response size, as a WIRE limit.
 *
 * A two-party contract: the server enforces it
 * (`apps/api/src/private-rendezvous/service.ts`) and the peer validates against
 * it (`apps/web/src/private-p2p/rendezvous-client.ts`), so it must have exactly
 * ONE spelling.  Raised on the server alone, valid responses stop parsing on the
 * client; lowered on the server alone, the client accepts more than the contract
 * allows.  It briefly had three spellings — the constant was deleted as
 * unreferenced while two `.max(256)` literals stayed — which is the "two
 * spellings of a live value" case `check:dead-exports` warns about, resolved the
 * wrong way round.
 *
 * It lives in `@licio/shared` rather than `@licio/private-p2p` because
 * PRIV-API-RENDEZVOUS-1 forbids `apps/api` from importing the protocol package
 * at all; shared is the only package BOTH planes may reach.
 */
export const RENDEZVOUS_MAX_RECORDS_PER_POLL = 256;

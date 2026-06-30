// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-S.3.1a — the MINIMAL reviewed MLS wrapper (PRIVATE_SPEC §10.2; RFC 9420).
// One private room = one MLS group; one member device = one MLS client; one MLS
// epoch = one room key epoch.  This is the ONLY file in `@licio/private-p2p`
// that imports the MLS library (`ts-mls`); every other module uses this surface,
// so the MLS implementation can be swapped behind it (the `check:p2p-mls-wrapper`
// gate forbids a deep `ts-mls` import elsewhere).
//
// The cipher suite is PINNED to MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519
// (RFC 9420 suite 1) — the X25519/AES-128-GCM/SHA-256/Ed25519 family that aligns
// with the §10.7 signature choice and the §10.3 HPKE suite.  It is NEVER a
// runtime "library default": a module-load assertion fails closed if the
// library's registry no longer maps the pinned name to the pinned id, and
// `resolveSuite` re-checks the resolved suite's name.
//
// Library note: `ts-mls` is a type-safe, immutable, RFC-9420-conformant pure-TS
// implementation (official MLS test vectors in its CI) but is NOT YET formally
// security-audited (its own disclaimer).  The wrapper isolates it so an audited
// implementation (e.g. an OpenMLS WASM build) can replace it without touching
// callers; this residual is tracked in docs/private-p2p/README.md.

import {
  type CiphersuiteImpl,
  type ClientState,
  type Credential,
  ciphersuites,
  createCommit,
  decodeGroupState,
  decodeMlsMessage,
  defaultAuthenticationService,
  defaultCapabilities,
  defaultKeyPackageEqualityConfig,
  defaultKeyRetentionConfig,
  defaultLifetime,
  defaultLifetimeConfig,
  defaultPaddingConfig,
  emptyPskIndex,
  encodeGroupState,
  encodeMlsMessage,
  getCiphersuiteFromName,
  getCiphersuiteImpl,
  type IncomingMessageCallback,
  joinGroup,
  type KeyPackage,
  type MLSMessage,
  type MlsPrivateMessage,
  type MlsPublicMessage,
  createGroup as mlsCreateGroup,
  createProposal as mlsCreateProposal,
  mlsExporter,
  generateKeyPackage as mlsGenerateKeyPackage,
  type PrivateKeyPackage,
  type Proposal,
  processMessage,
  type RatchetTree,
  type Welcome,
  zeroOutUint8Array,
} from 'ts-mls';

export type { KeyPackage, MLSMessage, RatchetTree, Welcome } from 'ts-mls';

/** The pinned MLS cipher suite name (§10.2 / §10.7). */
export const MLS_CIPHERSUITE_NAME = 'MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519' as const;
/** The pinned MLS cipher suite id (RFC 9420 IANA registry). */
export const MLS_CIPHERSUITE_ID = 1;

/** The §10.2 MLS-Exporter label for the room epoch secret. */
export const ROOM_EPOCH_EXPORTER_LABEL = 'licio.private-room.v1.epoch';

/** The room epoch secret length (§10.2). */
export const ROOM_EPOCH_SECRET_LENGTH = 32;

// Fail closed at module load if the library's suite registry drifts from the pin.
if (ciphersuites[MLS_CIPHERSUITE_NAME] !== MLS_CIPHERSUITE_ID) {
  throw new Error(
    `MLS cipher-suite pin drift: ${MLS_CIPHERSUITE_NAME} is no longer id ${MLS_CIPHERSUITE_ID}`,
  );
}

let cachedSuite: Promise<CiphersuiteImpl> | undefined;

/** Resolve (and cache) the pinned cipher-suite implementation, asserting it is
 *  exactly the pinned suite (never a library default). */
function resolveSuite(): Promise<CiphersuiteImpl> {
  if (!cachedSuite) {
    const suite = getCiphersuiteFromName(MLS_CIPHERSUITE_NAME);
    if (suite.name !== MLS_CIPHERSUITE_NAME) {
      throw new Error(`unexpected MLS cipher suite: ${suite.name}`);
    }
    cachedSuite = getCiphersuiteImpl(suite);
  }
  return cachedSuite;
}

/** A member device's MLS key package: the public package to publish + the
 *  private package to retain (its private keys join the group). */
export interface KeyPackageBundle {
  readonly publicPackage: KeyPackage;
  readonly privatePackage: PrivateKeyPackage;
}

/**
 * A room's MLS group handle.  Opaque to the rest of the package: callers pass it
 * back into the wrapper, never reach into `.state`.  `ClientState` is immutable
 * in `ts-mls`, so every transition returns a NEW handle.
 */
export interface MlsGroup {
  readonly state: ClientState;
  readonly cs: CiphersuiteImpl;
}

/** The result of a committing transition: the new group + the commit message and
 *  (for adds) the Welcome that admits the new device. */
export interface CommitOutcome {
  readonly group: MlsGroup;
  readonly commit: MLSMessage;
  readonly welcome: Welcome | undefined;
}

/** Generate a member device's MLS key package under the pinned suite. */
export async function generateMemberKeyPackage(identity: Uint8Array): Promise<KeyPackageBundle> {
  const cs = await resolveSuite();
  const credential: Credential = { credentialType: 'basic', identity };
  const { publicPackage, privatePackage } = await mlsGenerateKeyPackage(
    credential,
    defaultCapabilities(),
    defaultLifetime,
    [],
    cs,
  );
  return { publicPackage, privatePackage };
}

/** Create a new MLS group (a new private room) with `founder` as the first member. */
export async function createGroup(
  groupId: Uint8Array,
  founder: KeyPackageBundle,
): Promise<MlsGroup> {
  const cs = await resolveSuite();
  const state = await mlsCreateGroup(
    groupId,
    founder.publicPackage,
    founder.privatePackage,
    [],
    cs,
  );
  return { state, cs };
}

/** Commit a set of proposals, advancing the epoch.  Consumed key material is
 *  zeroed for forward-secrecy hygiene. */
export async function commitProposals(
  group: MlsGroup,
  proposals: Proposal[],
): Promise<CommitOutcome> {
  const result = await createCommit(
    { state: group.state, cipherSuite: group.cs },
    { extraProposals: proposals, ratchetTreeExtension: true },
  );
  result.consumed.forEach(zeroOutUint8Array);
  return {
    group: { state: result.newState, cs: group.cs },
    commit: result.commit,
    welcome: result.welcome,
  };
}

/** Add a device/member (an MLS Add commit → new epoch + a Welcome, §10.9). */
export function addMember(group: MlsGroup, keyPackage: KeyPackage): Promise<CommitOutcome> {
  return commitProposals(group, [{ proposalType: 'add', add: { keyPackage } }]);
}

/** Remove a device/member by leaf index (an MLS Remove commit → new epoch, §10.9). */
export function removeMember(group: MlsGroup, leafIndex: number): Promise<CommitOutcome> {
  return commitProposals(group, [{ proposalType: 'remove', remove: { removed: leafIndex } }]);
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * Find the MLS leaf index of the device whose KeyPackage basic-credential
 * identity matches `identity` (the bytes passed to `generateMemberKeyPackage`),
 * or `undefined` if no such leaf exists.  Leaves occupy EVEN array slots in the
 * RFC 9420 left-balanced tree, so the leaf index is `arrayIndex / 2` — the value
 * `removeMember` expects.  Keeping this in the wrapper isolates ts-mls's tree
 * shape from the rest of the package.
 */
export function findDeviceLeafIndex(group: MlsGroup, identity: Uint8Array): number | undefined {
  const tree = group.state.ratchetTree;
  for (let i = 0; i < tree.length; i += 2) {
    const node = tree[i];
    if (node?.nodeType !== 'leaf') continue;
    const credential = node.leaf.credential;
    if (credential.credentialType === 'basic' && bytesEqual(credential.identity, identity)) {
      return i / 2;
    }
  }
  return undefined;
}

/**
 * Resolve an MLS `leafIndex` (the committer's leaf) to the ROOM device id carried in its basic
 * credential — the inverse of {@link findDeviceLeafIndex}.  Leaves occupy EVEN array slots, so leaf
 * `n` is `ratchetTree[n * 2]`.  Returns `undefined` for an absent / non-basic leaf, which the
 * authority predicate treats as unauthorized (fail-closed).
 */
function leafDeviceId(group: MlsGroup, leafIndex: number | undefined): string | undefined {
  if (leafIndex === undefined) return undefined;
  const node = group.state.ratchetTree[leafIndex * 2];
  if (node?.nodeType !== 'leaf') return undefined;
  const credential = node.leaf.credential;
  if (credential.credentialType !== 'basic') return undefined;
  return new TextDecoder().decode(credential.identity);
}

/**
 * The §11.3 authority verdict for a received MLS commit (PRIV-CRYPTO-1): given the COMMITTER's room
 * device id (resolved from its MLS leaf's basic credential), decide whether the commit may advance
 * THIS member's epoch.  RFC 9420 has NO native admin role — `processMessage` only checks the
 * committer is SOME group member — so the room-layer caller supplies this predicate over its reduced
 * §11.3 capability state (an admin-only check for membership changes).  `undefined` ⇒ unauthorized.
 */
export type CommitAuthorization = (committerDeviceId: string | undefined) => boolean;

/** Process a Welcome message, admitting this device into the group at the
 *  committing epoch (the MLS join path). */
export async function processWelcome(
  welcome: Welcome,
  bundle: KeyPackageBundle,
  ratchetTree?: RatchetTree,
): Promise<MlsGroup> {
  const cs = await resolveSuite();
  const state = await joinGroup(
    welcome,
    bundle.publicPackage,
    bundle.privatePackage,
    emptyPskIndex,
    cs,
    ratchetTree,
  );
  return { state, cs };
}

/** The current MLS epoch (the room key epoch). */
export function currentEpoch(group: MlsGroup): bigint {
  return group.state.groupContext.epoch;
}

/** The epoch authenticator — a public commitment to the current group state
 *  (RFC 9420 §8.2), usable as a safety-number basis. */
export function epochAuthenticator(group: MlsGroup): Uint8Array {
  return group.state.keySchedule.epochAuthenticator;
}

/** The current ratchet tree (needed to admit a new device via a Welcome). */
export function ratchetTree(group: MlsGroup): RatchetTree {
  return group.state.ratchetTree;
}

/**
 * The MLS exporter over the current epoch's exporter secret (RFC 9420 §8.5):
 * the basis for `room_epoch_secret` (§10.2).  `context` is the canonical-encoded
 * `[room_id_commitment, epoch, manifest_commitment]` (built by WS-S.3.1b).  Two
 * devices at the same epoch with the same context derive the identical secret.
 */
export function mlsRoomEpochSecret(group: MlsGroup, context: Uint8Array): Promise<Uint8Array> {
  return mlsExporter(
    group.state.keySchedule.exporterSecret,
    ROOM_EPOCH_EXPORTER_LABEL,
    context,
    ROOM_EPOCH_SECRET_LENGTH,
    group.cs,
  );
}

/** Serialize a group's state for at-rest persistence (the key store wraps it).
 *  The `clientConfig` is static policy (not serialized); deserialize re-attaches
 *  the default config every Licio group is created with. */
export function serializeGroupState(group: MlsGroup): Uint8Array {
  return encodeGroupState(group.state);
}

/** The default client config every Licio group is created with (reconstructed
 *  from the library's exported config defaults — the composite
 *  `defaultClientConfig` is not re-exported from the package root). */
const DEFAULT_CLIENT_CONFIG = {
  keyRetentionConfig: defaultKeyRetentionConfig,
  lifetimeConfig: defaultLifetimeConfig,
  keyPackageEqualityConfig: defaultKeyPackageEqualityConfig,
  paddingConfig: defaultPaddingConfig,
  authService: defaultAuthenticationService,
} as const;

/** Restore a group handle from serialized state, re-attaching the default
 *  client config (the only config Licio groups use). */
export async function deserializeGroupState(bytes: Uint8Array): Promise<MlsGroup> {
  const decoded = decodeGroupState(bytes, 0);
  if (!decoded) throw new Error('failed to decode MLS group state');
  const cs = await resolveSuite();
  return { state: { ...decoded[0], clientConfig: DEFAULT_CLIENT_CONFIG }, cs };
}

/**
 * Serialize a bare `KeyPackage` by wrapping it in an MLSMessage of wireformat
 * `mls_key_package` — the RFC 9420 §6 container for a key package on the wire.
 * A device publishes this (e.g. in a §12.1 `member.add` op's `mls_key_package`
 * field) so an inviter/joiner can recover it via `decodeKeyPackage` and admit the
 * device with `addMember`.
 */
export function encodeKeyPackage(keyPackage: KeyPackage): Uint8Array {
  return encodeMlsMessage({ wireformat: 'mls_key_package', version: 'mls10', keyPackage });
}

/** Inverse of `encodeKeyPackage`; fail-closed if the bytes are not a key-package
 *  MLSMessage (wrong wireformat, trailing bytes, or undecodable). */
export function decodeKeyPackage(bytes: Uint8Array): KeyPackage {
  const decoded = decodeMlsMessage(bytes, 0);
  // Reject undecodable bytes OR trailing bytes after a complete message (a
  // ts-mls decoder returns [value, bytesConsumed]) — no silent suffix.
  if (!decoded || decoded[1] !== bytes.length) {
    throw new Error('decodeKeyPackage: not a single complete MLSMessage');
  }
  const message = decoded[0];
  if (message.wireformat !== 'mls_key_package') {
    throw new Error('decodeKeyPackage: not an mls_key_package MLSMessage');
  }
  return message.keyPackage;
}

// --- §10.9 commit/welcome processing on EXISTING members + wire codecs ----------------
//
// `commitProposals`/`addMember`/`removeMember` are the COMMITTER side (they advance the
// committer's own group and emit the commit + Welcome).  The functions below complete
// the membership protocol for the OTHER participants: an existing member APPLIES a
// received commit to advance to the new epoch (`applyCommit`), and both the commit and
// the Welcome get serialized for transport so the live carrier (WS-S.4.3) can deliver
// the new epoch key after a §12.1 add / §10.9 remove.

/**
 * Apply a received MLS Commit to an EXISTING member's group, advancing it to the
 * committer's new epoch (RFC 9420 §12.4 — the non-committer transition).
 *
 * §11.3 AUTHORITY GATE (PRIV-CRYPTO-1): RFC 9420 has no native admin role, so MLS validates only
 * that the committer is SOME group member.  Without a higher-layer check, any member could commit an
 * Add of a ghost reader device (which would then derive the new `content_wrap_key`) or a Remove of an
 * honest admin, and other members would blindly advance their epoch.  `authorize` is therefore
 * REQUIRED: it receives the committer's ROOM device id (resolved from its leaf credential) and the
 * caller (room-manager) decides per its reduced §11.3 capability state (membership commits require the
 * committer hold `admin`).  A `reject` means `processMessage` does NOT apply the commit, so the epoch
 * does not advance — caught here and surfaced as a typed error.  Fail-closed: a non-handshake message,
 * an unauthorized committer, or any non-epoch-advancing transition throws, and the caller must NOT
 * install epoch keys for a thrown commit.
 */
export async function applyCommit(
  group: MlsGroup,
  commit: MLSMessage,
  authorize: CommitAuthorization,
): Promise<MlsGroup> {
  if (commit.wireformat !== 'mls_public_message' && commit.wireformat !== 'mls_private_message') {
    throw new Error(`applyCommit: expected a handshake message, got ${commit.wireformat}`);
  }
  const message: MlsPublicMessage | MlsPrivateMessage = commit;
  // The §11.3 gate as the ts-mls `IncomingMessageCallback`.  A COMMIT is authorized by its
  // committer's device id (resolved from the leaf credential); a bare PROPOSAL is let through so the
  // epoch-advance guard below still rejects it as "not a commit" (a proposal advances nothing and
  // cannot grant access on its own — a later commit that applies it is itself authorized here).
  const authorizeCommit: IncomingMessageCallback = (incoming) =>
    incoming.kind !== 'commit'
      ? 'accept'
      : authorize(leafDeviceId(group, incoming.senderLeafIndex))
        ? 'accept'
        : 'reject';
  const result = await processMessage(
    message,
    group.state,
    emptyPskIndex,
    authorizeCommit,
    group.cs,
  );
  if (result.kind !== 'newState') {
    throw new Error(`applyCommit: expected a newState transition, got ${result.kind}`);
  }
  if (result.actionTaken === 'reject') {
    // The committer is not authorized for this membership change: the group is UNADVANCED, so a
    // non-admin's forged Add (ghost reader) / Remove (admin eviction) can never grant or revoke
    // epoch-key access for honest members.
    throw new Error(
      'applyCommit: commit REJECTED — its committer is not authorized for this change (§11.3)',
    );
  }
  // Fail-closed: a real Commit advances EXACTLY one epoch.  A bare Proposal is also
  // delivered as a handshake message (same wireformat) and `processMessage` returns a
  // `newState` for it too — but at the SAME epoch (it is only stored in
  // `unappliedProposals`).  Reject the proposal-as-commit so the documented "the epoch
  // has advanced on success" contract holds at THIS boundary, not only in callers.
  if (result.newState.groupContext.epoch !== group.state.groupContext.epoch + 1n) {
    throw new Error(
      `applyCommit: message did not advance the epoch (not a commit): ` +
        `${group.state.groupContext.epoch} -> ${result.newState.groupContext.epoch}`,
    );
  }
  return { state: result.newState, cs: group.cs };
}

/**
 * Create a bare Add PROPOSAL (NOT a Commit): a member proposes adding a device, but the
 * epoch does NOT advance until an admin COMMITS it.  A proposal is the SAME handshake
 * wireformat as a commit, so an existing member that received one (or an attacker that
 * relays one in an `mls_commit` slot) must NOT mistake it for an epoch advance — this is
 * the constructor `applyCommit`'s fail-closed epoch-advance guard is tested against.
 */
export async function proposeAdd(group: MlsGroup, keyPackage: KeyPackage): Promise<MLSMessage> {
  const result = await mlsCreateProposal(
    group.state,
    true, // a public handshake message (the same wireformat `applyCommit` accepts)
    { proposalType: 'add', add: { keyPackage } },
    group.cs,
  );
  result.consumed.forEach(zeroOutUint8Array);
  return result.message;
}

/** Serialize a commit MLSMessage for the wire (the §10.9 epoch-rotation broadcast). */
export function encodeCommit(commit: MLSMessage): Uint8Array {
  if (commit.wireformat !== 'mls_public_message' && commit.wireformat !== 'mls_private_message') {
    throw new Error(`encodeCommit: not a handshake message (${commit.wireformat})`);
  }
  return encodeMlsMessage(commit);
}

/** Inverse of `encodeCommit`; fail-closed (undecodable / trailing bytes / non-handshake). */
export function decodeCommit(bytes: Uint8Array): MLSMessage {
  const decoded = decodeMlsMessage(bytes, 0);
  if (!decoded || decoded[1] !== bytes.length) {
    throw new Error('decodeCommit: not a single complete MLSMessage');
  }
  const message = decoded[0];
  if (message.wireformat !== 'mls_public_message' && message.wireformat !== 'mls_private_message') {
    throw new Error(`decodeCommit: not a handshake MLSMessage (${message.wireformat})`);
  }
  return message;
}

/** Serialize a Welcome for the wire (wrapped as an `mls_welcome` MLSMessage, §6). */
export function encodeWelcomeMessage(welcome: Welcome): Uint8Array {
  return encodeMlsMessage({ wireformat: 'mls_welcome', version: 'mls10', welcome });
}

/** Inverse of `encodeWelcomeMessage`; fail-closed if not a single `mls_welcome` message. */
export function decodeWelcomeMessage(bytes: Uint8Array): Welcome {
  const decoded = decodeMlsMessage(bytes, 0);
  if (!decoded || decoded[1] !== bytes.length) {
    throw new Error('decodeWelcomeMessage: not a single complete MLSMessage');
  }
  const message = decoded[0];
  if (message.wireformat !== 'mls_welcome') {
    throw new Error(`decodeWelcomeMessage: not an mls_welcome MLSMessage (${message.wireformat})`);
  }
  return message.welcome;
}

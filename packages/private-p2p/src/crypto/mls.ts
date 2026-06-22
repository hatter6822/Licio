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
  joinGroup,
  type KeyPackage,
  type MLSMessage,
  createGroup as mlsCreateGroup,
  mlsExporter,
  generateKeyPackage as mlsGenerateKeyPackage,
  type PrivateKeyPackage,
  type Proposal,
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
  const message = decoded?.[0];
  if (message?.wireformat !== 'mls_key_package') {
    throw new Error('decodeKeyPackage: not an mls_key_package MLSMessage');
  }
  return message.keyPackage;
}

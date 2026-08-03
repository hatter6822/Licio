// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-S.1.2 / §21.1–§21.4 — the directory-stub store for a Private P2P room.
//
// A stub is the ONLY durable server record a P2P room may have besides the
// (deliberately unlinkable) rendezvous rows: a bootstrap pointer carrying
// cryptographic COMMITMENTS, a rendezvous policy, and — for a `listed` room
// only — public display metadata.  The §8.1 forbiddance list is the column
// denylist for `private_room_stubs`, so nothing here may carry content, a
// private CID, an operation head, a member list, activity state, or key
// material.  `packages/db`'s `checkPrivateServerTables()` pins that
// structurally; these wire schemas pin the same boundary at the edge, so a
// forbidden field is rejected before it can reach a column that does not exist.
//
// Like `private-rendezvous/stores.ts`, this deliberately does NOT import
// `@licio/private-p2p`: the server verifies no room signature and holds no room
// key (PRIV-API-RENDEZVOUS-1).  It stores the client's `signed_stub` +
// `stub_signature` VERBATIM so members can verify authorship themselves — the
// server is a courier for them, never a validator of them.
import { z } from 'zod';

/** A base64url commitment / public key / blind id — bounded, never decrypting
 *  material (§8.2). */
const commitmentSchema = z
  .string()
  .min(1)
  .max(512)
  .regex(/^[A-Za-z0-9_-]+$/, 'expected a base64url commitment');

/** Public display metadata — `listed` rooms only, and bounded for DoS. */
const displayNameSchema = z.string().min(1).max(120);
const displayDescriptionSchema = z.string().min(1).max(2_000);

/** A PUBLIC avatar CID (§8.2 explicitly allows this one; a PRIVATE CID never
 *  reaches the server). Bounded and charset-restricted to a CIDv1 alphabet. */
const publicCidSchema = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9]+$/, 'expected a base32/base58 CIDv1');

/** §8.2 bootstrap policy — HOW peers find each other, never WHO they are. */
export const rendezvousPolicySchema = z.enum(['licio_blind', 'member_rendezvous', 'manual_only']);
export type RendezvousPolicy = z.infer<typeof rendezvousPolicySchema>;

/**
 * A bootstrap hint: a relay/rendezvous POINTER, never a peer identity — and now
 * a closed format per kind rather than a free string.
 *
 * `value` was `z.string().max(1024)`, which is the same defect `signed_stub` was
 * closed for, one field along: a strict OUTER object around an unrestricted
 * value channel. An authenticated client could put a message, a member id, key
 * material, or chunked room content in each of sixteen hints, and both stores
 * persisted and re-served it verbatim — through a column the §8.2 allowlist
 * permits precisely because a POINTER is not content.
 *
 * So each kind names what it can be:
 *
 *   • `licio_blind`   — a §15.3 blind id: base64url, nothing else.
 *   • `member_relay`  — a transport endpoint: `https://` or `wss://` only, and
 *                       no credentials, query or fragment, which is where a
 *                       payload would otherwise ride a legitimate-looking URL.
 *   • `manual`        — an out-of-band exchange code, NOT prose. Free text here
 *                       would re-open the channel under the one kind whose name
 *                       invites it.
 *
 * A discriminated union rather than a refinement, so the shape itself carries
 * the rule and a new kind cannot be added without choosing a format for it.
 */
const blindHintValueSchema = z
  .string()
  .min(1)
  .max(512)
  .regex(/^[A-Za-z0-9_-]+$/, 'expected base64url (no padding)');

const relayHintValueSchema = z
  .string()
  .min(1)
  .max(512)
  .refine((value) => {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      return false;
    }
    return (
      (url.protocol === 'https:' || url.protocol === 'wss:') &&
      url.username === '' &&
      url.password === '' &&
      url.search === '' &&
      url.hash === ''
    );
  }, 'expected an https:// or wss:// endpoint with no credentials, query or fragment');

const bootstrapHintSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('licio_blind'), value: blindHintValueSchema }).strict(),
  z.object({ kind: z.literal('member_relay'), value: relayHintValueSchema }).strict(),
  z.object({ kind: z.literal('manual'), value: blindHintValueSchema }).strict(),
]);
export type BootstrapHint = z.infer<typeof bootstrapHintSchema>;

/** At most this many hints per stub (bounded row size). */
export const MAX_BOOTSTRAP_HINTS = 16;

/**
 * The client-signed §8.2 stub body — a CLOSED set of known commitment fields.
 *
 * This was `.passthrough()`, reasoning that the signature covers the whole
 * object so stripping an unknown key would break verification. That reasoning
 * was about KEYS and missed VALUES entirely: a payload like
 * `{ bootstrap_blind_id: "…", x: "<a private message or a member list>" }`
 * satisfied every key-level check and was persisted verbatim into the server's
 * jsonb — a direct bypass of the no-server-content boundary, through the one
 * field the column allowlist cannot see into.
 *
 * "Signed by the room" is not a safety property here. The server holds no room
 * key, so it cannot distinguish a stub the members intended from one a
 * compromised client emitted; and §8.2 does not permit arbitrary signed data,
 * it permits COMMITMENTS. So the shape is `.strict()` and versioned: only the
 * fields below may appear, unknown keys are rejected outright, and the client
 * signs exactly this canonical set (`directoryStubPayload()` emits it).
 * Widening it is then a deliberate, reviewable schema change rather than
 * something a client can do unilaterally.
 */
/**
 * The §8.2 signed body: a CLOSED set of PUBLIC commitments and nothing else.
 *
 * "Public" is load-bearing, not descriptive. A jsonb blob is projected wholesale
 * or not at all, so any secret placed in here is disclosed everywhere the body
 * is disclosed anywhere — and a `listed` room's bootstrap read is open. The
 * §21.2 capability therefore lives in its OWN column and is never projected;
 * putting it back here would re-open a leak no projection guard can close for
 * an endpoint that has not been written yet.
 */
const signedStubSchema = z
  .object({
    /** Pins the field set this body was signed under. */
    schema: z.literal('licio.private.directory_stub.v2'),
    /** The room's published verification key (base64url) — a commitment. */
    room_public_key: commitmentSchema,
    /** A commitment to the manifest key; never decrypting material. */
    manifest_key_commitment: commitmentSchema,
  })
  .strict();

/**
 * §8.1 key classes that may never appear in `signed_stub`, at any depth.
 *
 * The column allowlist cannot help here — `signed_stub` is one jsonb column, so
 * everything inside it is invisible to a column-level guard.  This is that
 * guard's counterpart for the free-form field, and it is a PREFIX/segment scan
 * for the same reason `FORBIDDEN_PRIVATE_COLUMN_SEGMENTS` is: an exact-name list
 * is evaded by a suffix.
 */
export const FORBIDDEN_SIGNED_STUB_SEGMENTS: readonly string[] = [
  'plaintext',
  'op_head',
  'op_id',
  'operation',
  'story',
  'thread',
  'contribution',
  'member',
  'unread',
  'activity',
  'private_cid',
  'private_key',
  'root_key',
  'key_material',
  'secret',
  'invite',
  'recovery',
  'media',
  'attachment',
  'body',
  'title',
  'search',
  'embedding',
  // A CAPABILITY is not content, but it is the one other thing this body must
  // never carry: `signed_stub` is projected wholesale to anonymous readers of a
  // `listed` room, so a secret inside it is disclosed to everyone. The closed
  // schema already rejects the field; this is the second lock, for a caller
  // that reaches the service without it.
  'blind_id',
];

/**
 * The deepest object nesting a signed stub may carry.
 *
 * The bound exists so the scan below terminates on a hostile payload, but a
 * depth bound and a SCAN bound must not be the same thing: an earlier cut of
 * this simply stopped descending past the limit, which meant a forbidden key
 * placed at depth 17 of an otherwise-valid sub-8-KiB object was reported clean
 * and persisted. Bounded recursion that silently stops looking is not a guard.
 * So exceeding the depth is now itself a REJECTION — the scan never returns
 * "clean" for a region it did not read.
 */
export const MAX_SIGNED_STUB_DEPTH = 16;

/** Sentinel for "this object nests deeper than the scan will read". */
export const SIGNED_STUB_TOO_DEEP = '__too_deep__';

/** Every object key in `value`, at any depth (arrays are walked, not keyed).
 *  Returns false when the value nests past {@link MAX_SIGNED_STUB_DEPTH}. */
function collectKeys(value: unknown, out: string[], depth = 0): boolean {
  if (value === null || typeof value !== 'object') return true;
  if (depth > MAX_SIGNED_STUB_DEPTH) return false;
  if (Array.isArray(value)) {
    for (const item of value) {
      if (!collectKeys(item, out, depth + 1)) return false;
    }
    return true;
  }
  for (const [key, child] of Object.entries(value)) {
    out.push(key);
    if (!collectKeys(child, out, depth + 1)) return false;
  }
  return true;
}

/**
 * The forbidden §8.1 segments present in a signed stub (empty ⇒ clean).
 *
 * A stub nesting past the depth bound yields {@link SIGNED_STUB_TOO_DEEP},
 * which callers treat exactly like a forbidden key: the server refuses what it
 * cannot fully read, rather than persisting it on the strength of a partial
 * scan.
 */
export function forbiddenSignedStubKeys(signedStub: unknown): string[] {
  const keys: string[] = [];
  if (!collectKeys(signedStub, keys)) return [SIGNED_STUB_TOO_DEEP];
  const hits = new Set<string>();
  for (const key of keys) {
    const lower = key.toLowerCase();
    for (const segment of FORBIDDEN_SIGNED_STUB_SEGMENTS) {
      if (lower.includes(segment)) hits.add(key);
    }
  }
  return [...hits].sort();
}

/**
 * §21.1 — create a directory stub (and the P2P room shell it points at).
 *
 * `.strict()` is the enforcement of the §21.1 validation list: a request
 * carrying a private CID, an operation head, or a member list is rejected
 * because no such key exists in the shape, not because a handler remembered to
 * check for one.  `detached` is absent from the enum on purpose — a detached
 * room stores NO stub at all (§8.2, and the `private_room_stubs_not_detached`
 * CHECK), so there is nothing for this endpoint to create.
 */
export const privateRoomCreateStubRequestSchema = z
  .object({
    directory_mode: z.enum(['listed', 'unlisted']),
    display_name: displayNameSchema.optional(),
    display_description: displayDescriptionSchema.optional(),
    display_avatar_public_cid: publicCidSchema.optional(),
    rendezvous_policy: rendezvousPolicySchema,
    bootstrap_hints: z.array(bootstrapHintSchema).max(MAX_BOOTSTRAP_HINTS).optional(),
    signed_stub: signedStubSchema,
    stub_signature: commitmentSchema,
    /**
     * §21.2 — the bootstrap capability, sent ALONGSIDE the signed body rather
     * than inside it, and stored in its own never-projected column.
     */
    bootstrap_blind_id: commitmentSchema,
  })
  .strict();

/*
 * `room_public_key` and `manifest_key_commitment` are DELIBERATELY absent from
 * the request.
 *
 * They used to be sent separately AND signed, so a client could publish one pair
 * and sign another: the bootstrap response then served unsigned commitments
 * beside a signature that verifies over different ones, and a member checking
 * the signature would conclude the record was authentic before bootstrapping
 * from material the room never stood behind. Comparing them at the two write
 * sites would fix the two write sites. Deriving the columns from the signed body
 * means there is only ever one value, so the third write site cannot get it
 * wrong either.
 */
export type PrivateRoomCreateStubRequest = z.infer<typeof privateRoomCreateStubRequestSchema>;

/**
 * The signed body as a TYPE, so the two commitments the columns derive from are
 * statically present.  `Record<string, unknown>` would have made the derivation
 * a lookup that can miss; this makes it a field access that cannot.
 */
export type SignedStubBody = z.infer<typeof signedStubSchema>;

/**
 * §21.3 — the ONLY mutable stub fields.  Everything §21.3 forbids (member list,
 * private CIDs, op heads, content metadata, activity timestamps, unread counts)
 * is absent from the shape and refused by `.strict()`.
 *
 * `directory_mode` is NOT updatable here: widening `unlisted → listed` would
 * publish a room's display metadata through a PATCH, so promotion is a create-
 * time decision and demotion is the explicit §21.4 `delist` action.
 */
export const privateRoomStubUpdateRequestSchema = z
  .object({
    display_name: displayNameSchema.nullable().optional(),
    display_description: displayDescriptionSchema.nullable().optional(),
    display_avatar_public_cid: publicCidSchema.nullable().optional(),
    rendezvous_policy: rendezvousPolicySchema.optional(),
    bootstrap_hints: z.array(bootstrapHintSchema).max(MAX_BOOTSTRAP_HINTS).optional(),
    latest_manifest_commitment: commitmentSchema.nullable().optional(),
    signed_stub: signedStubSchema.optional(),
    stub_signature: commitmentSchema.optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, { message: 'no updatable field supplied' })
  // The stub body and its signature are ONE fact. Patching either alone leaves
  // the bootstrap endpoint serving a body/signature pair that cannot verify —
  // a record that looks authentic to the server and fails for every member.
  .refine((value) => (value.signed_stub === undefined) === (value.stub_signature === undefined), {
    message: 'signed_stub and stub_signature must be replaced together',
    path: ['stub_signature'],
  });
export type PrivateRoomStubUpdateRequest = z.infer<typeof privateRoomStubUpdateRequestSchema>;

/** A stored directory stub — the §8.2 allowed fields and nothing else. */
export interface StoredPrivateRoomStub {
  readonly stubId: string;
  readonly roomServerId: string;
  readonly directoryMode: 'listed' | 'unlisted';
  readonly displayName: string | null;
  readonly displayDescription: string | null;
  readonly displayAvatarPublicCid: string | null;
  readonly roomPublicKey: string;
  readonly manifestKeyCommitment: string;
  readonly latestManifestCommitment: string | null;
  readonly rendezvousPolicy: RendezvousPolicy;
  readonly bootstrapHints: readonly BootstrapHint[];
  readonly signedStub: Record<string, unknown>;
  readonly stubSignature: string;
  /** §21.2 — NEVER projected; compared in constant time against `?token=`. */
  readonly bootstrapBlindId: string;
  readonly createdByAccountId: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** The fields a create writes (ids/timestamps are the store's to mint). */
export interface PrivateRoomStubInsertInput {
  readonly stubId: string;
  readonly roomServerId: string;
  readonly directoryMode: 'listed' | 'unlisted';
  readonly displayName: string | null;
  readonly displayDescription: string | null;
  readonly displayAvatarPublicCid: string | null;
  readonly rendezvousPolicy: RendezvousPolicy;
  readonly bootstrapHints: readonly BootstrapHint[];
  readonly signedStub: SignedStubBody;
  readonly stubSignature: string;
  readonly bootstrapBlindId: string;
  readonly createdByAccountId: string | null;
}

/*
 * No `roomPublicKey`/`manifestKeyCommitment` here either: the store DERIVES
 * both columns from `signedStub`, which is typed to carry them. That is what
 * makes "the columns agree with the signature" a property of the type rather
 * than of two remembered comparisons.
 */

/** The patchable subset, already normalised to storage shape. */
export interface PrivateRoomStubPatch {
  readonly displayName?: string | null;
  readonly displayDescription?: string | null;
  readonly displayAvatarPublicCid?: string | null;
  readonly rendezvousPolicy?: RendezvousPolicy;
  readonly bootstrapHints?: readonly BootstrapHint[];
  readonly latestManifestCommitment?: string | null;
  /** Replacing the body re-derives the commitment columns (see the insert). */
  readonly signedStub?: SignedStubBody;
  readonly stubSignature?: string;
}

/**
 * The durable boundary for the stub service.  An in-memory adapter ships here;
 * the gated Postgres adapter over `rooms` + `private_room_stubs` lives in
 * `drizzle-store.ts`.
 *
 * `create` writes the P2P room SHELL and its stub as ONE unit: the shell exists
 * only to give the stub a `room_server_id` to reference (the §8.3-allowed
 * shell ⇄ room link), and a shell with no stub would be an orphan the directory
 * can never reach or clean up.
 */
export interface PrivateRoomStubStore {
  /** Mint the p2p room shell + its stub atomically. */
  create(input: PrivateRoomStubInsertInput): Promise<StoredPrivateRoomStub>;
  /** The stub for a room server id, or null when there is none. */
  getByRoomId(roomServerId: string): Promise<StoredPrivateRoomStub | null>;
  /**
   * Apply a §21.3 patch; null when the stub is gone — OR when
   * `requireListed` was asked for and the record is no longer `listed`.
   *
   * `requireListed` exists because the mode check and the write are separate
   * moments. A patch that SETS display metadata is legal only on a `listed`
   * record, and a delist can commit in between: Postgres then rejects the write
   * on `private_room_stubs_listed_display_only` (a 500 from a legal request)
   * while the in-memory adapter cheerfully produced an `unlisted` record
   * carrying a public name — the invariant broken in dev, and a crash in
   * production, from the same race. Carrying the mode into the WHERE clause
   * makes both adapters answer the same thing: the patch simply does not apply.
   */
  update(
    roomServerId: string,
    patch: PrivateRoomStubPatch,
    options?: { readonly requireListed?: boolean },
  ): Promise<StoredPrivateRoomStub | null>;
  /**
   * §21.4 delist — demote `listed → unlisted` and DROP the display metadata,
   * keeping the bootstrap record itself so existing members can still resolve
   * it.  Idempotent on an already-`unlisted` stub.  Null when there is no stub.
   */
  delist(
    roomServerId: string,
    options?: { readonly requireListed?: boolean },
  ): Promise<StoredPrivateRoomStub | null>;
  /**
   * Drop the stub AND the room shell it points at.  Member-held content is
   * untouched — the server never had any (§21.4) — and removing the shell is
   * what keeps the deletion honest: a surviving shell row would still assert
   * "this account created a private room at time T", a §8.1 activity trace
   * outliving the action taken to erase the server's record.  Returns false
   * when there was no stub to remove.
   */
  remove(roomServerId: string): Promise<boolean>;
  /** The account that created the stub, for the §21.3/§21.4 owner check. */
  ownerOf(roomServerId: string): Promise<string | null>;
  /**
   * Remove every stub (and its room shell) an account created — the hard-
   * deletion purge. Returns how many were removed.
   *
   * Needed because deletion TOMBSTONES the users row rather than deleting it,
   * so the `created_by_account_id` FK action never fires and the record would
   * survive its creator carrying display metadata and timestamps.
   */
  purgeForAccount(accountId: string): Promise<number>;
  /**
   * The stubs an account created — the DSAR (Art. 15) READ counterpart of
   * `purgeForAccount`, and the recovery lookup behind `GET /mine`.
   *
   * PAGED, on the same `(createdAt, stubId)` keyset the directory uses. An
   * account's stub count grows without bound (the creation limit is per hour,
   * not per lifetime), and each row carries bounded-but-large display fields and
   * bootstrap hints — so an unpaged read is a database, heap and response
   * amplification path on an endpoint a client may poll. Omitting `options`
   * returns everything, which the export uses by iterating pages to completion:
   * an Art. 15 archive that truncates is not an archive.
   *
   * Deletion and disclosure are the same obligation seen from two sides: a
   * record the purge knows how to remove is a record the export must know how
   * to disclose. Without this the archive silently omitted the one durable
   * server row a private-room creator has.
   */
  /**
   * ONE stub this account created, addressed by room id or by the room's own
   * signing key — the indexed answer to "do I own this record".
   *
   * `roomPublicKey` is how a client identifies a record whose SERVER id it never
   * learned (a create whose response was lost): the key is the room's, it is in
   * the record, and the client has it locally.
   */
  findForAccount(
    accountId: string,
    target: { readonly roomServerId?: string; readonly roomPublicKey?: string },
  ): Promise<StoredPrivateRoomStub | null>;
  listForAccount(
    accountId: string,
    options?: {
      readonly limit: number;
      readonly cursor?: { readonly createdAt: string; readonly stubId: string };
    },
  ): Promise<StoredPrivateRoomStub[]>;
  /**
   * §4.2 — one page of `listed` stubs for the public room directory, newest
   * first.
   *
   * `listed` is the mode whose whole definition is "the room directory can show
   * the room shell", so a `listed` stub that nothing can enumerate is a mode
   * that does not exist. `unlisted` is excluded by the query, not by a caller
   * filter — an unlisted room's existence is exactly what must not be
   * enumerable.
   *
   * Keyset pagination on `(createdAt, stubId)`: an offset would skip or repeat
   * rows as stubs are created and delisted underneath the reader.
   */
  listListed(options: {
    readonly limit: number;
    readonly cursor?: { readonly createdAt: string; readonly stubId: string };
  }): Promise<StoredPrivateRoomStub[]>;
}

/** The in-memory stub store (local/dev default, and the unit-test substrate). */
export class InMemoryPrivateRoomStubStore implements PrivateRoomStubStore {
  readonly #stubs = new Map<string, StoredPrivateRoomStub>();

  constructor(private readonly now: () => number = () => Date.now()) {}

  create(input: PrivateRoomStubInsertInput): Promise<StoredPrivateRoomStub> {
    const at = new Date(this.now()).toISOString();
    const stub: StoredPrivateRoomStub = {
      ...input,
      bootstrapHints: [...input.bootstrapHints],
      // DERIVED from the signed body — see `PrivateRoomStubInsertInput`.
      roomPublicKey: input.signedStub.room_public_key,
      manifestKeyCommitment: input.signedStub.manifest_key_commitment,
      latestManifestCommitment: null,
      createdAt: at,
      updatedAt: at,
    };
    this.#stubs.set(input.roomServerId, stub);
    return Promise.resolve(stub);
  }

  getByRoomId(roomServerId: string): Promise<StoredPrivateRoomStub | null> {
    return Promise.resolve(this.#stubs.get(roomServerId) ?? null);
  }

  update(
    roomServerId: string,
    patch: PrivateRoomStubPatch,
    options: { readonly requireListed?: boolean } = {},
  ): Promise<StoredPrivateRoomStub | null> {
    const current = this.#stubs.get(roomServerId);
    if (!current) return Promise.resolve(null);
    // The same predicate the Drizzle adapter puts in its WHERE clause — so a
    // patch that races a delist is refused identically in both.
    if (options.requireListed === true && current.directoryMode !== 'listed') {
      return Promise.resolve(null);
    }
    const next: StoredPrivateRoomStub = {
      ...current,
      ...(patch.displayName !== undefined ? { displayName: patch.displayName } : {}),
      ...(patch.displayDescription !== undefined
        ? { displayDescription: patch.displayDescription }
        : {}),
      ...(patch.displayAvatarPublicCid !== undefined
        ? { displayAvatarPublicCid: patch.displayAvatarPublicCid }
        : {}),
      ...(patch.rendezvousPolicy !== undefined ? { rendezvousPolicy: patch.rendezvousPolicy } : {}),
      ...(patch.bootstrapHints !== undefined ? { bootstrapHints: [...patch.bootstrapHints] } : {}),
      ...(patch.latestManifestCommitment !== undefined
        ? { latestManifestCommitment: patch.latestManifestCommitment }
        : {}),
      ...(patch.signedStub !== undefined
        ? {
            signedStub: patch.signedStub,
            // The columns move WITH the body they are derived from.
            roomPublicKey: patch.signedStub.room_public_key,
            manifestKeyCommitment: patch.signedStub.manifest_key_commitment,
          }
        : {}),
      ...(patch.stubSignature !== undefined ? { stubSignature: patch.stubSignature } : {}),
      updatedAt: new Date(this.now()).toISOString(),
    };
    this.#stubs.set(roomServerId, next);
    return Promise.resolve(next);
  }

  delist(
    roomServerId: string,
    options: { readonly requireListed?: boolean } = {},
  ): Promise<StoredPrivateRoomStub | null> {
    const current = this.#stubs.get(roomServerId);
    if (!current) return Promise.resolve(null);
    if (options.requireListed === true && current.directoryMode !== 'listed') {
      return Promise.resolve(null);
    }
    const next: StoredPrivateRoomStub = {
      ...current,
      directoryMode: 'unlisted',
      displayName: null,
      displayDescription: null,
      displayAvatarPublicCid: null,
      updatedAt: new Date(this.now()).toISOString(),
    };
    this.#stubs.set(roomServerId, next);
    return Promise.resolve(next);
  }

  remove(roomServerId: string): Promise<boolean> {
    return Promise.resolve(this.#stubs.delete(roomServerId));
  }

  ownerOf(roomServerId: string): Promise<string | null> {
    return Promise.resolve(this.#stubs.get(roomServerId)?.createdByAccountId ?? null);
  }

  purgeForAccount(accountId: string): Promise<number> {
    let removed = 0;
    for (const [roomServerId, stub] of this.#stubs) {
      if (stub.createdByAccountId === accountId) {
        this.#stubs.delete(roomServerId);
        removed += 1;
      }
    }
    return Promise.resolve(removed);
  }

  findForAccount(
    accountId: string,
    target: { readonly roomServerId?: string; readonly roomPublicKey?: string },
  ): Promise<StoredPrivateRoomStub | null> {
    if (target.roomServerId === undefined && target.roomPublicKey === undefined) {
      return Promise.resolve(null);
    }
    const found = [...this.#stubs.values()].find(
      (stub) =>
        stub.createdByAccountId === accountId &&
        (target.roomServerId === undefined || stub.roomServerId === target.roomServerId) &&
        (target.roomPublicKey === undefined || stub.roomPublicKey === target.roomPublicKey),
    );
    return Promise.resolve(found ?? null);
  }

  listForAccount(
    accountId: string,
    options?: {
      readonly limit: number;
      readonly cursor?: { readonly createdAt: string; readonly stubId: string };
    },
  ): Promise<StoredPrivateRoomStub[]> {
    const all = [...this.#stubs.values()]
      .filter((stub) => stub.createdByAccountId === accountId)
      .sort(byNewestFirst);
    if (options === undefined) return Promise.resolve(all);
    const { cursor } = options;
    return Promise.resolve(
      all
        .filter((stub) => cursor === undefined || isAfterCursor(stub, cursor))
        .slice(0, options.limit),
    );
  }

  listListed(options: {
    readonly limit: number;
    readonly cursor?: { readonly createdAt: string; readonly stubId: string };
  }): Promise<StoredPrivateRoomStub[]> {
    const { cursor } = options;
    const page = [...this.#stubs.values()]
      .filter((stub) => stub.directoryMode === 'listed')
      .sort(byNewestFirst)
      .filter((stub) => cursor === undefined || isAfterCursor(stub, cursor))
      .slice(0, options.limit);
    return Promise.resolve(page);
  }
}

/** Newest first, `stubId` descending as the tiebreak — the same total order the
 *  Drizzle adapter's `ORDER BY` produces, so a cursor means one thing. */
function byNewestFirst(a: StoredPrivateRoomStub, b: StoredPrivateRoomStub): number {
  return b.createdAt.localeCompare(a.createdAt) || b.stubId.localeCompare(a.stubId);
}

/** Strictly past the cursor row in that same descending order. */
function isAfterCursor(
  stub: StoredPrivateRoomStub,
  cursor: { readonly createdAt: string; readonly stubId: string },
): boolean {
  if (stub.createdAt !== cursor.createdAt) return stub.createdAt < cursor.createdAt;
  return stub.stubId < cursor.stubId;
}

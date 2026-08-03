// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-S.1.2 / §21.1–§21.4 — the directory-stub service.
//
// What the server is here: a courier for a signed, member-authored bootstrap
// record.  What it is NOT: an authority over the room.  It verifies no room
// signature (it holds no room key — PRIV-API-RENDEZVOUS-1), decides no
// membership, and learns nothing about the room's contents.  The §11.4 rule
// holds verbatim — no platform role can read, add members to, moderate, recover,
// or unlock a P2P room; the only thing staff can do here is DELIST a listed
// directory record.
//
// Three server-side bounds the design requires regardless of client input:
//
//   • Display metadata is `listed`-ONLY.  An `unlisted` room that shipped a
//     name would defeat its own mode, so the service refuses the request rather
//     than silently dropping the field — a silent drop would leave the client
//     believing a name it can see locally is also what the directory serves.
//   • `unlisted` bootstrap requires the §21.2 invite-derived blind token, and a
//     token mismatch is INDISTINGUISHABLE from an unknown room (the §15.3.1
//     no-existence-oracle property, applied to the directory).
//   • The §8.1 forbidden key classes are refused inside `signed_stub`, the one
//     free-form field a column allowlist cannot see into.
import { createDbClient } from '@licio/db';
import { createLogger } from '../lib/logger.js';
import { pgNoticeLogLevel } from '../lib/pg-notices.js';
import { DrizzlePrivateRoomStubStore } from './drizzle-store.js';
import {
  forbiddenSignedStubKeys,
  InMemoryPrivateRoomStubStore,
  type PrivateRoomCreateStubRequest,
  type PrivateRoomStubStore,
  type PrivateRoomStubUpdateRequest,
  type StoredPrivateRoomStub,
} from './stores.js';

/** The rendezvous endpoints a bootstrapping peer needs (§21.1 response). */
export const BOOTSTRAP_ENDPOINTS: readonly string[] = [
  '/v1/private-rendezvous/announce',
  '/v1/private-rendezvous/poll',
  '/v1/private-rendezvous/signal',
  '/v1/private-rendezvous/signal/poll',
];

/** Why a stub operation was refused.  `not_found` is deliberately reused for a
 *  bad bootstrap token (no existence oracle). */
export type StubFailure =
  | 'not_found'
  | 'forbidden'
  | 'display_requires_listed'
  | 'forbidden_stub_field'
  | 'unlisted_requires_token';

export type StubResult<T> = { ok: true; value: T } | { ok: false; reason: StubFailure };

/** The §21.1 create response. */
export interface CreateStubResponse {
  readonly room_server_id: string;
  readonly stub_id: string;
  readonly bootstrap_endpoints: readonly string[];
  readonly created_at: string;
}

/** The §21.2 bootstrap projection.  Display fields appear only for a `listed`
 *  room; everything else is a commitment or a bootstrap policy. */
export interface BootstrapResponse {
  readonly room_server_id: string;
  readonly directory_mode: 'listed' | 'unlisted';
  readonly display_name: string | null;
  readonly display_description: string | null;
  readonly display_avatar_public_cid: string | null;
  readonly room_public_key: string;
  readonly manifest_key_commitment: string;
  readonly latest_manifest_commitment: string | null;
  readonly rendezvous_policy: string;
  readonly bootstrap_hints: readonly { kind: string; value: string }[];
  readonly bootstrap_endpoints: readonly string[];
  readonly signed_stub: Record<string, unknown>;
  readonly stub_signature: string;
  readonly created_at: string;
  readonly updated_at: string;
}

/**
 * Does this signed stub carry the §21.2 bootstrap capability?
 *
 * Exported so it can be unit-tested directly: the wire schema now REQUIRES the
 * field, so this guard is unreachable through a validated request and would
 * otherwise be untestable. It stays as defence in depth for any non-HTTP caller
 * (a future job, a migration) that reaches the service without the schema.
 */
export function hasBootstrapToken(signedStub: Record<string, unknown>): boolean {
  return typeof signedStub['bootstrap_blind_id'] === 'string';
}

/**
 * Constant-time string comparison for the §21.2 bootstrap token.
 *
 * A length-then-`===` compare leaks the shared prefix through timing, which for
 * a capability check is the difference between guessing a token and deriving it
 * byte by byte.  Both operands are bounded base64url by the wire schema, so the
 * fixed-length XOR fold below is exact.
 */
function constantTimeEquals(a: string, b: string): boolean {
  const max = Math.max(a.length, b.length);
  let diff = a.length ^ b.length;
  for (let i = 0; i < max; i += 1) {
    diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return diff === 0;
}

/**
 * §4.2 — one row of the public room directory.
 *
 * DELIBERATELY not the §21.2 bootstrap projection. A browse surface needs the
 * display metadata a `listed` room chose to publish and nothing else: the
 * commitments, hints, and above all the `signed_stub` (which carries the
 * `bootstrap_blind_id` capability) stay behind `GET /bootstrap`. Listing them
 * here would hand every anonymous reader the token that gates unlisted records,
 * for every room that ever gets delisted.
 */
export interface DirectoryEntry {
  readonly room_server_id: string;
  readonly display_name: string | null;
  readonly display_description: string | null;
  readonly display_avatar_public_cid: string | null;
  readonly created_at: string;
}

/** A page of the §4.2 directory. `next_cursor` is null at the end. */
export interface DirectoryPage {
  readonly entries: readonly DirectoryEntry[];
  readonly next_cursor: string | null;
}

/** The largest page the directory will serve, and its default. */
export const DIRECTORY_MAX_LIMIT = 50;
export const DIRECTORY_DEFAULT_LIMIT = 20;

/** One DSAR row: what the server holds about a stub this account created. */
export interface AccountStubExport {
  readonly room_server_id: string;
  readonly stub_id: string;
  readonly directory_mode: 'listed' | 'unlisted';
  readonly display_name: string | null;
  readonly display_description: string | null;
  readonly display_avatar_public_cid: string | null;
  readonly room_public_key: string;
  readonly manifest_key_commitment: string;
  readonly latest_manifest_commitment: string | null;
  readonly rendezvous_policy: string;
  readonly bootstrap_hints: readonly { kind: string; value: string }[];
  readonly signed_stub: Record<string, unknown>;
  readonly stub_signature: string;
  readonly created_at: string;
  readonly updated_at: string;
}

/** Aggregate-only counters — no room, account, or token identity (§27.2). */
export interface PrivateRoomStubMetrics {
  created: number;
  bootstrapReads: number;
  bootstrapRefusals: number;
  updated: number;
  delisted: number;
  removed: number;
}

export class PrivateRoomStubService {
  readonly #metrics: PrivateRoomStubMetrics = {
    created: 0,
    bootstrapReads: 0,
    bootstrapRefusals: 0,
    updated: 0,
    delisted: 0,
    removed: 0,
  };

  constructor(
    private readonly store: PrivateRoomStubStore,
    private readonly newId: () => string = () => crypto.randomUUID(),
  ) {}

  /** §21.1 — mint the P2P room shell + its directory stub. */
  async create(
    request: PrivateRoomCreateStubRequest,
    accountId: string,
  ): Promise<StubResult<CreateStubResponse>> {
    const hasDisplay =
      request.display_name !== undefined ||
      request.display_description !== undefined ||
      request.display_avatar_public_cid !== undefined;
    if (request.directory_mode !== 'listed' && hasDisplay) {
      return { ok: false, reason: 'display_requires_listed' };
    }
    if (forbiddenSignedStubKeys(request.signed_stub).length > 0) {
      return { ok: false, reason: 'forbidden_stub_field' };
    }
    // EVERY stub commits to a bootstrap token, not just one created `unlisted`.
    //
    // Gating this on the create-time mode was wrong in two directions: a
    // `listed` stub could omit the token and then be DELISTED, and an unlisted
    // stub could PATCH `signed_stub` to drop it. Either way `bootstrap()`
    // afterwards returns `not_found` for every token, which silently breaks the
    // §21.4 guarantee that delisting keeps the record resolvable for existing
    // members. A listed room can always become unlisted, so the token is a
    // property of HAVING a stub, not of the mode it was born in.
    if (!hasBootstrapToken(request.signed_stub)) {
      return { ok: false, reason: 'unlisted_requires_token' };
    }

    const stub = await this.store.create({
      stubId: this.newId(),
      roomServerId: this.newId(),
      directoryMode: request.directory_mode,
      displayName: request.display_name ?? null,
      displayDescription: request.display_description ?? null,
      displayAvatarPublicCid: request.display_avatar_public_cid ?? null,
      roomPublicKey: request.room_public_key,
      manifestKeyCommitment: request.manifest_key_commitment,
      rendezvousPolicy: request.rendezvous_policy,
      bootstrapHints: request.bootstrap_hints ?? [],
      signedStub: request.signed_stub,
      stubSignature: request.stub_signature,
      createdByAccountId: accountId,
    });
    this.#metrics.created += 1;
    return {
      ok: true,
      value: {
        room_server_id: stub.roomServerId,
        stub_id: stub.stubId,
        bootstrap_endpoints: BOOTSTRAP_ENDPOINTS,
        created_at: stub.createdAt,
      },
    };
  }

  /**
   * §21.2 — read a bootstrap record.  `listed` is open; `unlisted` requires the
   * invite-derived blind token, and a wrong or missing token yields the SAME
   * `not_found` an unknown room does, so the endpoint is not an oracle for
   * which room ids exist.
   */
  async bootstrap(
    roomServerId: string,
    token: string | undefined,
  ): Promise<StubResult<BootstrapResponse>> {
    const stub = await this.store.getByRoomId(roomServerId);
    if (!stub) {
      this.#metrics.bootstrapRefusals += 1;
      return { ok: false, reason: 'not_found' };
    }
    if (stub.directoryMode === 'unlisted') {
      const expected = stub.signedStub['bootstrap_blind_id'];
      if (typeof expected !== 'string' || token === undefined) {
        this.#metrics.bootstrapRefusals += 1;
        return { ok: false, reason: 'not_found' };
      }
      if (!constantTimeEquals(expected, token)) {
        this.#metrics.bootstrapRefusals += 1;
        return { ok: false, reason: 'not_found' };
      }
    }
    this.#metrics.bootstrapReads += 1;
    return { ok: true, value: this.#project(stub) };
  }

  /** §21.3 — patch the mutable stub fields (creator only). */
  async update(
    roomServerId: string,
    request: PrivateRoomStubUpdateRequest,
    accountId: string,
  ): Promise<StubResult<BootstrapResponse>> {
    const stub = await this.store.getByRoomId(roomServerId);
    if (!stub) return { ok: false, reason: 'not_found' };
    if (stub.createdByAccountId !== accountId) return { ok: false, reason: 'forbidden' };
    const setsDisplay =
      (request.display_name !== undefined && request.display_name !== null) ||
      (request.display_description !== undefined && request.display_description !== null) ||
      (request.display_avatar_public_cid !== undefined &&
        request.display_avatar_public_cid !== null);
    if (stub.directoryMode !== 'listed' && setsDisplay) {
      return { ok: false, reason: 'display_requires_listed' };
    }
    if (request.signed_stub !== undefined && forbiddenSignedStubKeys(request.signed_stub).length) {
      return { ok: false, reason: 'forbidden_stub_field' };
    }
    // A PATCH may REPLACE the signed stub, so it may also drop the capability
    // the bootstrap read is gated on. Refuse: a stub that loses its token
    // answers `not_found` for every token afterwards, which is indistinguishable
    // from deletion for every member holding an invite.
    if (request.signed_stub !== undefined && !hasBootstrapToken(request.signed_stub)) {
      return { ok: false, reason: 'unlisted_requires_token' };
    }
    const next = await this.store.update(roomServerId, {
      ...(request.display_name !== undefined ? { displayName: request.display_name } : {}),
      ...(request.display_description !== undefined
        ? { displayDescription: request.display_description }
        : {}),
      ...(request.display_avatar_public_cid !== undefined
        ? { displayAvatarPublicCid: request.display_avatar_public_cid }
        : {}),
      ...(request.rendezvous_policy !== undefined
        ? { rendezvousPolicy: request.rendezvous_policy }
        : {}),
      ...(request.bootstrap_hints !== undefined ? { bootstrapHints: request.bootstrap_hints } : {}),
      ...(request.latest_manifest_commitment !== undefined
        ? { latestManifestCommitment: request.latest_manifest_commitment }
        : {}),
      ...(request.signed_stub !== undefined ? { signedStub: request.signed_stub } : {}),
      ...(request.stub_signature !== undefined ? { stubSignature: request.stub_signature } : {}),
    });
    if (!next) return { ok: false, reason: 'not_found' };
    this.#metrics.updated += 1;
    return { ok: true, value: this.#project(next) };
  }

  /**
   * §21.4 — demote a `listed` record to `unlisted` and drop its display fields.
   *
   * The creator may always delist their own record. PLATFORM STAFF may also
   * delist ANY listed record, and that is not an oversight in the ownership
   * check — §11.4 grants staff exactly one power over a P2P room, and this is
   * it. A listed stub publishes a name, description and avatar to anyone with
   * the id; if the creator will not remove abusive display metadata, nobody
   * else could either, since no other delist path exists. Note the shape of the
   * power: staff can stop the room ADVERTISING itself, and can do nothing to
   * the room — no content, no membership, no keys, and the record stays
   * resolvable for the members who already hold its token.
   */
  async delist(
    roomServerId: string,
    accountId: string,
    options: { readonly staff?: boolean } = {},
  ): Promise<StubResult<BootstrapResponse>> {
    const stub = await this.store.getByRoomId(roomServerId);
    if (!stub) return { ok: false, reason: 'not_found' };
    const owner = stub.createdByAccountId === accountId;
    if (!owner && options.staff !== true) return { ok: false, reason: 'forbidden' };
    // A STAFF caller may only act on a LISTED record.
    //
    // Delist is idempotent for the owner, which is right — but for staff that
    // idempotence was a capability bypass: an admin who merely KNEW an
    // unlisted `room_server_id` could call this and receive the full bootstrap
    // projection (signed stub, hints, commitments) that §21.2 gates behind the
    // blind token they do not hold. §11.4 gives staff power over the PUBLIC
    // directory listing, not over the record. So a non-owner staff caller
    // targeting an already-unlisted stub gets the same `not_found` an unknown
    // room does — no oracle, no projection.
    if (!owner && stub.directoryMode !== 'listed') return { ok: false, reason: 'not_found' };
    const next = await this.store.delist(roomServerId);
    if (!next) return { ok: false, reason: 'not_found' };
    this.#metrics.delisted += 1;
    return { ok: true, value: this.#project(next) };
  }

  /**
   * §21.4 — remove the directory record.  This deletes LICIO'S BOOTSTRAP RECORD
   * and nothing else: member devices keep every byte of the room, because the
   * server never held any.  The route's copy says exactly that.
   */
  async remove(roomServerId: string, accountId: string): Promise<StubResult<{ removed: true }>> {
    const stub = await this.store.getByRoomId(roomServerId);
    if (!stub) return { ok: false, reason: 'not_found' };
    if (stub.createdByAccountId !== accountId) return { ok: false, reason: 'forbidden' };
    const removed = await this.store.remove(roomServerId);
    if (!removed) return { ok: false, reason: 'not_found' };
    this.#metrics.removed += 1;
    return { ok: true, value: { removed: true } };
  }

  /**
   * §21.4 — remove every directory record an account created (hard deletion).
   *
   * Called by the WS-D purge, not by a route: there is no user-facing "delete
   * all my stubs" action. Returns how many were removed.
   */
  async purgeForAccount(accountId: string): Promise<number> {
    const removed = await this.store.purgeForAccount(accountId);
    this.#metrics.removed += removed;
    return removed;
  }

  /**
   * §4.2 — a page of the public directory of `listed` rooms.
   *
   * The cursor is `<createdAt>|<stubId>`, opaque to the client and rejected
   * fail-closed: a malformed cursor starts from the beginning rather than
   * throwing, because a browse surface must not 500 on a mangled link.
   */
  async listDirectory(options: {
    readonly limit?: number;
    readonly cursor?: string;
  }): Promise<DirectoryPage> {
    const limit = Math.min(
      Math.max(1, Math.trunc(options.limit ?? DIRECTORY_DEFAULT_LIMIT)),
      DIRECTORY_MAX_LIMIT,
    );
    const cursor = parseDirectoryCursor(options.cursor);
    // One row past the page decides whether there is a next cursor, without a
    // second COUNT query that could disagree with the page it describes.
    const rows = await this.store.listListed({
      limit: limit + 1,
      ...(cursor ? { cursor } : {}),
    });
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return {
      entries: page.map((stub) => ({
        room_server_id: stub.roomServerId,
        display_name: stub.displayName,
        display_description: stub.displayDescription,
        display_avatar_public_cid: stub.displayAvatarPublicCid,
        created_at: stub.createdAt,
      })),
      next_cursor: rows.length > limit && last ? `${last.createdAt}|${last.stubId}` : null,
    };
  }

  /**
   * Art. 15 — every directory record this account created.
   *
   * The mirror of `purgeForAccount`: the export discloses exactly the rows the
   * purge removes. It is the account's OWN data, so the full stub is included —
   * including `signed_stub`, which the account's own device authored.
   */
  async exportForAccount(accountId: string): Promise<AccountStubExport[]> {
    const stubs = await this.store.listForAccount(accountId);
    return stubs.map((stub) => ({
      room_server_id: stub.roomServerId,
      stub_id: stub.stubId,
      directory_mode: stub.directoryMode,
      display_name: stub.displayName,
      display_description: stub.displayDescription,
      display_avatar_public_cid: stub.displayAvatarPublicCid,
      room_public_key: stub.roomPublicKey,
      manifest_key_commitment: stub.manifestKeyCommitment,
      latest_manifest_commitment: stub.latestManifestCommitment,
      rendezvous_policy: stub.rendezvousPolicy,
      bootstrap_hints: stub.bootstrapHints.map((h) => ({ kind: h.kind, value: h.value })),
      signed_stub: stub.signedStub,
      stub_signature: stub.stubSignature,
      created_at: stub.createdAt,
      updated_at: stub.updatedAt,
    }));
  }

  /** A snapshot of the aggregate-only counters (no room identity). */
  metrics(): PrivateRoomStubMetrics {
    return { ...this.#metrics };
  }

  #project(stub: StoredPrivateRoomStub): BootstrapResponse {
    return {
      room_server_id: stub.roomServerId,
      directory_mode: stub.directoryMode,
      display_name: stub.displayName,
      display_description: stub.displayDescription,
      display_avatar_public_cid: stub.displayAvatarPublicCid,
      room_public_key: stub.roomPublicKey,
      manifest_key_commitment: stub.manifestKeyCommitment,
      latest_manifest_commitment: stub.latestManifestCommitment,
      rendezvous_policy: stub.rendezvousPolicy,
      bootstrap_hints: stub.bootstrapHints.map((h) => ({ kind: h.kind, value: h.value })),
      bootstrap_endpoints: BOOTSTRAP_ENDPOINTS,
      signed_stub: stub.signedStub,
      stub_signature: stub.stubSignature,
      created_at: stub.createdAt,
      updated_at: stub.updatedAt,
    };
  }
}

/** Split `<iso>|<stubId>`; anything else is treated as no cursor at all. */
function parseDirectoryCursor(
  cursor: string | undefined,
): { createdAt: string; stubId: string } | undefined {
  if (cursor === undefined) return undefined;
  const at = cursor.indexOf('|');
  if (at <= 0) return undefined;
  const createdAt = cursor.slice(0, at);
  const stubId = cursor.slice(at + 1);
  if (stubId.length === 0 || Number.isNaN(Date.parse(createdAt))) return undefined;
  return { createdAt, stubId };
}

function buildStore(): PrivateRoomStubStore {
  const dbUrl = process.env['DATABASE_URL'];
  if (!dbUrl) return new InMemoryPrivateRoomStubStore();
  // `onNotice` for the same reason every other store passes one: the db wrapper
  // always installs its own handler, so omitting the sink DISCARDS every notice
  // from this store rather than falling back to postgres.js's console default.
  const logger = createLogger(process.env['LOG_LEVEL'] ?? 'info');
  return new DrizzlePrivateRoomStubStore(
    createDbClient(dbUrl, {
      onNotice: (notice) =>
        logger[pgNoticeLogLevel(notice.severity)](
          { pgNotice: notice },
          'postgres notice (private room stubs)',
        ),
    }),
  );
}

let service: PrivateRoomStubService | undefined;

/** The process-wide stub service (created lazily; Postgres when configured). */
export function getPrivateRoomStubService(): PrivateRoomStubService {
  if (!service) service = new PrivateRoomStubService(buildStore());
  return service;
}

/** Replace the singleton (tests / an explicit binding). */
export function setPrivateRoomStubService(next: PrivateRoomStubService): void {
  service = next;
}

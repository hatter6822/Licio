// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-S.1.2b — the client for the PRIVATE_SPEC §21.1–§21.4 directory-stub API.
//
// This lives in `lib/`, NOT in `private-p2p/`, on purpose. The private plane's
// own modules ride a bare injected `fetch` (see `private-p2p/rendezvous-client.ts`)
// so the code-split crypto chunk never pulls the API client in and blows its
// bundle budget. Stub writes, though, are ORDINARY authenticated mutations —
// they need the session cookie and the serialized single-use CSRF token that
// `apiFetch` provides — so they belong on this side of the split, called from a
// component rather than from inside the lazy chunk.
//
// What crosses this boundary is deliberately thin: commitments the room already
// publishes, a rendezvous policy, and (only if the room chose to be listed) a
// public name. No content, no private CID, no operation head, no member list —
// the server has no column for any of them.
import { z } from 'zod';
import { API_BASE, apiFetch, parseResponse } from './api.js';

/** §4.2 — how discoverable the room's EXISTENCE is. `detached` is not offered
 *  here: such a room stores no stub at all, so there is nothing to create. */
export const DIRECTORY_MODES = ['listed', 'unlisted'] as const;
export type DirectoryMode = (typeof DIRECTORY_MODES)[number];

const bootstrapHintSchema = z.object({
  kind: z.enum(['licio_blind', 'member_relay', 'manual']),
  value: z.string(),
});

/** The §21.1 create response. */
export const createStubResponseSchema = z.object({
  room_server_id: z.string(),
  stub_id: z.string(),
  bootstrap_endpoints: z.array(z.string()),
  created_at: z.string(),
});
export type CreateStubResponse = z.infer<typeof createStubResponseSchema>;

/** The §21.2 bootstrap projection. Display fields are null unless `listed`. */
export const bootstrapStubSchema = z.object({
  room_server_id: z.string(),
  directory_mode: z.enum(DIRECTORY_MODES),
  display_name: z.string().nullable(),
  display_description: z.string().nullable(),
  display_avatar_public_cid: z.string().nullable(),
  room_public_key: z.string(),
  manifest_key_commitment: z.string(),
  latest_manifest_commitment: z.string().nullable(),
  rendezvous_policy: z.string(),
  bootstrap_hints: z.array(bootstrapHintSchema),
  bootstrap_endpoints: z.array(z.string()),
  /** PUBLIC commitments only — the §21.2 capability is never projected. */
  signed_stub: z.record(z.string(), z.unknown()),
  stub_signature: z.string(),
  created_at: z.string(),
  updated_at: z.string(),
});
export type BootstrapStub = z.infer<typeof bootstrapStubSchema>;

/** §4.2 — one public directory row. Display metadata only: the commitments and
 *  the signed stub (which carries the bootstrap capability) stay behind
 *  `GET /bootstrap`, so browsing never hands out a token. */
export const directoryEntrySchema = z.object({
  room_server_id: z.string(),
  display_name: z.string().nullable(),
  display_description: z.string().nullable(),
  display_avatar_public_cid: z.string().nullable(),
  created_at: z.string(),
});
export type DirectoryEntry = z.infer<typeof directoryEntrySchema>;

export const directoryPageSchema = z.object({
  entries: z.array(directoryEntrySchema),
  next_cursor: z.string().nullable(),
});
export type DirectoryPage = z.infer<typeof directoryPageSchema>;

const deleteStubResponseSchema = z.object({
  removed: z.literal(true),
  removed_what: z.string(),
  message: z.string(),
});

export interface CreateStubRequest {
  readonly directoryMode: DirectoryMode;
  /** `listed` rooms only — the server REFUSES these on an `unlisted` room
   *  rather than silently dropping them. */
  readonly displayName?: string;
  readonly displayDescription?: string;
  readonly displayAvatarPublicCid?: string;
  readonly rendezvousPolicy: 'licio_blind' | 'member_rendezvous' | 'manual_only';
  readonly bootstrapHints?: ReadonlyArray<z.infer<typeof bootstrapHintSchema>>;
  /** The room-signed stub body: PUBLIC commitments only. The server derives the
   *  `room_public_key`/`manifest_key_commitment` columns from it, so they are
   *  not sent separately — two copies of one commitment can disagree. */
  readonly signedStub: Record<string, unknown>;
  readonly stubSignature: string;
  /** §21.2 — the capability, sent beside the signed body rather than inside it.
   *  The server stores it in a column it never projects. */
  readonly bootstrapBlindId: string;
}

/** §21.1 — register the directory stub for a room this device just created. */
export async function createPrivateRoomStub(
  request: CreateStubRequest,
): Promise<CreateStubResponse> {
  const response = await apiFetch(`${API_BASE}/v1/private-rooms`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      directory_mode: request.directoryMode,
      ...(request.displayName !== undefined ? { display_name: request.displayName } : {}),
      ...(request.displayDescription !== undefined
        ? { display_description: request.displayDescription }
        : {}),
      ...(request.displayAvatarPublicCid !== undefined
        ? { display_avatar_public_cid: request.displayAvatarPublicCid }
        : {}),
      rendezvous_policy: request.rendezvousPolicy,
      ...(request.bootstrapHints !== undefined ? { bootstrap_hints: request.bootstrapHints } : {}),
      signed_stub: request.signedStub,
      stub_signature: request.stubSignature,
      bootstrap_blind_id: request.bootstrapBlindId,
    }),
  });
  return await parseResponse(response, createStubResponseSchema);
}

/**
 * §21.2 — read a room's bootstrap record.
 *
 * `token` is the invite-derived blind id, required for an `unlisted` room. A
 * wrong token, a missing one, and an unknown room all answer with the same 404,
 * so a failure here says only "no record you can reach", never "that room
 * exists but you lack the token".
 */
export async function fetchPrivateRoomBootstrap(
  roomServerId: string,
  token?: string,
): Promise<BootstrapStub> {
  const query = token !== undefined ? `?token=${encodeURIComponent(token)}` : '';
  const response = await apiFetch(
    `${API_BASE}/v1/private-rooms/${encodeURIComponent(roomServerId)}/bootstrap${query}`,
  );
  return await parseResponse(response, bootstrapStubSchema);
}

export interface UpdateStubRequest {
  readonly displayName?: string | null;
  readonly displayDescription?: string | null;
  readonly displayAvatarPublicCid?: string | null;
  readonly rendezvousPolicy?: 'licio_blind' | 'member_rendezvous' | 'manual_only';
  readonly bootstrapHints?: ReadonlyArray<z.infer<typeof bootstrapHintSchema>>;
  readonly latestManifestCommitment?: string | null;
  readonly signedStub?: Record<string, unknown>;
  readonly stubSignature?: string;
}

/** §21.3 — patch the mutable stub fields (creator only, server-enforced). */
export async function updatePrivateRoomStub(
  roomServerId: string,
  request: UpdateStubRequest,
): Promise<BootstrapStub> {
  const response = await apiFetch(
    `${API_BASE}/v1/private-rooms/${encodeURIComponent(roomServerId)}`,
    {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        ...(request.displayName !== undefined ? { display_name: request.displayName } : {}),
        ...(request.displayDescription !== undefined
          ? { display_description: request.displayDescription }
          : {}),
        ...(request.displayAvatarPublicCid !== undefined
          ? { display_avatar_public_cid: request.displayAvatarPublicCid }
          : {}),
        ...(request.rendezvousPolicy !== undefined
          ? { rendezvous_policy: request.rendezvousPolicy }
          : {}),
        ...(request.bootstrapHints !== undefined
          ? { bootstrap_hints: request.bootstrapHints }
          : {}),
        ...(request.latestManifestCommitment !== undefined
          ? { latest_manifest_commitment: request.latestManifestCommitment }
          : {}),
        ...(request.signedStub !== undefined ? { signed_stub: request.signedStub } : {}),
        ...(request.stubSignature !== undefined ? { stub_signature: request.stubSignature } : {}),
      }),
    },
  );
  return await parseResponse(response, bootstrapStubSchema);
}

/**
 * §4.2 — a page of the public directory of `listed` rooms.
 *
 * Only rooms whose creator explicitly chose `listed` appear. Being in the
 * directory is not a way IN: a P2P room is invite-only, so what this buys a
 * reader is knowing the room exists and whom to ask — which is exactly what
 * `listed` was chosen for.
 */
export async function listPrivateRoomDirectory(options?: {
  readonly limit?: number;
  readonly cursor?: string;
}): Promise<DirectoryPage> {
  const params = new URLSearchParams();
  if (options?.limit !== undefined) params.set('limit', String(options.limit));
  if (options?.cursor !== undefined) params.set('cursor', options.cursor);
  const query = params.size > 0 ? `?${params.toString()}` : '';
  const response = await apiFetch(`${API_BASE}/v1/private-rooms/directory${query}`);
  return await parseResponse(response, directoryPageSchema);
}

const myStubSchema = z.object({
  room_server_id: z.string(),
  stub_id: z.string(),
  directory_mode: z.enum(DIRECTORY_MODES),
  room_public_key: z.string(),
  signed_stub: z.record(z.string(), z.unknown()),
});
export type MyStub = z.infer<typeof myStubSchema>;

const myStubsSchema = z.object({
  stubs: z.array(myStubSchema),
  next_cursor: z.string().nullable(),
});

/**
 * §21.1 — the directory records this account created.
 *
 * The recovery read. A create whose POST commits but whose RESPONSE is lost
 * leaves a server record the client never learned the id of; without a way to
 * ask, that record is unreachable forever — publicly enumerable, if it was
 * listed. Matching on `room_public_key` (the room's own founder signing key,
 * which the local session knows) is how a device identifies its own record
 * among them.
 */
export async function listMyPrivateRoomStubs(): Promise<MyStub[]> {
  // Every page, not the first one: both callers ask a yes/no question about a
  // SPECIFIC room ("do I own this record", "is my orphan out there"), and a
  // first-page answer would be wrong for an account whose room sits deeper.
  const stubs: MyStub[] = [];
  let cursor: string | null = null;
  do {
    const query = cursor === null ? '' : `?cursor=${encodeURIComponent(cursor)}`;
    const response = await apiFetch(`${API_BASE}/v1/private-rooms/mine${query}`);
    const page = await parseResponse(response, myStubsSchema);
    stubs.push(...page.stubs);
    cursor = page.next_cursor;
  } while (cursor !== null);
  return stubs;
}

/** §21.4 — stop advertising a listed room (it stays resolvable for members). */
export async function delistPrivateRoomStub(roomServerId: string): Promise<BootstrapStub> {
  const response = await apiFetch(
    `${API_BASE}/v1/private-rooms/${encodeURIComponent(roomServerId)}/delist`,
    { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' },
  );
  return await parseResponse(response, bootstrapStubSchema);
}

/**
 * §21.4 — remove Licio's directory record.
 *
 * This does NOT delete the room. Member devices keep every byte, because the
 * server never held any; the response's `message` is the wording the UI must
 * use rather than "delete private room for everyone".
 */
export async function deletePrivateRoomStub(
  roomServerId: string,
): Promise<{ removed: true; removed_what: string; message: string }> {
  const response = await apiFetch(
    `${API_BASE}/v1/private-rooms/${encodeURIComponent(roomServerId)}`,
    { method: 'DELETE' },
  );
  return await parseResponse(response, deleteStubResponseSchema);
}

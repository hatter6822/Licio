<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
# WS-S — Private P2P Rooms (E2EE): implementation reference

This is the per-card implementation reference for **WS-S** (Part II of the
Decentralized Data Plane, `docs/planning/19-decentralized-data-plane.md`;
source spec `docs/PRIVATE_SPEC.md`).  WS-S makes a third room class —
`private_p2p` — whose content, threads, comments, media, membership internals,
and search state are **end-to-end encrypted and hosted by members' devices**,
behind a **structural server non-storage contract**: platform staff can never
read, alter, recover, moderate, add members to, or delete it because the server
never possesses content, keys, heads, or authoritative membership.

WS-S and WS-R (LCAP) are deliberately separated planes over one content-
addressed substrate.  They **share no keys** and **pin different crypto suites
on purpose** — Ed25519 + MLS (RFC 9420) + HPKE (RFC 9180) here; ES256/P-256 in
LCAP — and compose only at the single ciphertext-carrying seam (WS-R.16.1 ↔
WS-S.6.5).  `@licio/private-p2p` depends on `@licio/shared` **only** (never
`@licio/db`, never `@licio/lcap`).

## Implementation status

The **foundation is shipped** — the room-class model, the server non-storage
contract (the keystone), and the private schemas + canonical encoding — landed
**ahead of** the crypto/P2P stack exactly as the plan prescribes ("the
defensive server gates ship first, so a partially-built P2P client can never
accidentally write server content").

### WS-S.0 — Terminology, room-class model, product framing

| Card | What shipped | Where |
|---|---|---|
| **WS-S.0.1** | The three §4.1 axes — `storage_mode`/`authority_model`/`directory_mode` (z.enums + types) + the `roomAxesSchema` coherence refinement (the SSOT the DB CHECKs mirror) + `roomClassOf` (the §4 three-class mapping) + `DEFAULT_P2P_DIRECTORY_MODE='unlisted'` | `packages/shared/src/schemas/room.ts` |
| **WS-S.0.2 / 0.3** (copy SSOT) | The §6 mandatory creation/removal disclosures, the five §20.2 acknowledgments (stable ids), the §20.1 room-class UI labels ("Members-only server room"), and the Appendix E privacy matrix — locale-ready BLOCKING copy, pinned by a prohibited-language copy-lint (no false "secure"/"deleted everywhere"). The UI render (creation wizard / matrix component / restricted-room rename) lands with WS-S.7/9.1 | `packages/shared/src/constants/private-rooms.ts` |

### WS-S.1 — Server schema and hard non-storage gates (the keystone)

| Card | What shipped | Where |
|---|---|---|
| **WS-S.1.1** | The `rooms` axes columns (`storage_mode` NOT NULL DEFAULT `server`, `authority_model`, `directory_mode`, `p2p_stub_id`) + the six §23.2 coherence CHECKs (storage↔authority, p2p⇒directory/private/invite, server⇒no-stub, server⇒no-directory) mirroring the shared `roomAxesSchema`. Migration `0043` (additive, expand pattern). `RoomRecord.storageMode` threaded through the in-memory + Drizzle forum stores | `packages/db/src/schema/room.ts`, `packages/db/drizzle/0043_*.sql`, `apps/api/src/forum/{stores,drizzle-forum-stores}.ts` |
| **WS-S.1.2** | `private_room_stubs` + `private_rendezvous_records` — the ONLY two server tables a P2P room may touch, with a strict §8.2 column ALLOWLIST (the §8.1 forbiddance list is the denylist). The rendezvous record has NO FK to `rooms` (un-linkable, §15.3.1). Migration `0044`. The structural guard `checkPrivateServerTables()` (allowlist + forbidden-segment scan) | `packages/db/src/schema/private-room.ts`, `packages/db/src/private-room-guard.ts`, `packages/db/drizzle/0044_*.sql` |
| **WS-S.1.3** | The endpoint rejection guards: `POST /v1/stories` → `409 p2p_room_requires_client_sync` BEFORE any side effect; the contribution path → `404` (defense in depth); `GET /v1/rooms/:id/feed` → `409 p2p_room_local_only`. Server uploads can only attach via the now-guarded submission/contribution flows (no direct upload→room path). The server room-create route hard-codes `storage_mode='server'` | `apps/api/src/ingestion/submission.ts`, `apps/api/src/forum/contributions.ts`, `apps/api/src/routes/{v1,rooms,stories}.ts` |
| **WS-S.1.4** | Every ranking retriever (the global predicate + the room-surface scoper) predicates `roomStorageMode === 'server'`; server search (in-memory + the Drizzle SQL `storage_mode = 'server'` join) excludes p2p docs; the event router refuses to publish any content event referencing a p2p room (`p2pRoomEventsRejected` counter), wired by the forum boot | `apps/api/src/ranking/{retrievers,services}.ts`, `apps/api/src/ingestion/{search,services,drizzle-ingestion-stores}.ts`, `apps/api/src/events/router.ts`, `apps/api/src/forum/services.ts` |
| **WS-S.1.5** | The seven §23.10 CI gates: `check:no-p2p-server-content` (umbrella), `check:no-private-cid-egress` (public-gateway scan), `check:private-rendezvous-schema` (column denylist), `check:private-bundle-transparency` (no dynamic remote code), `check:p2p-endpoint-rejections`, `check:p2p-ranking-exclusion`, `check:p2p-search-exclusion` — proven to BITE on injected fixtures. `check:no-applause`/`check:no-raw-egress` extended over `packages/private-p2p` | `scripts/private-p2p-gates.ts` + the seven `scripts/check-*.ts`, `.github/workflows/ci.yml` |

### WS-S.2 — Private schemas and canonical encoding

| Card | What shipped | Where |
|---|---|---|
| **WS-S.2.1** | The `@licio/private-p2p` workspace scaffold (TS strict, SPDX, depends on `@licio/shared` only) + the gate registrations: `scripts/check-workspace-deps.ts` (all four maps; allowed deps `['@licio/shared']`), root `tsconfig.json`/`vitest.config.ts`, and the **dedicated private-chunk bundle budget** in `scripts/check-bundle-size.ts` (the lazy private chunk is measured against its own ceiling, excluded from the core 320 KiB total) | `packages/private-p2p/`, `scripts/check-{workspace-deps,bundle-size}.ts` |
| **WS-S.2.2** | `canonical(...)` / `decodeCanonical(...)` — the ONE DAG-CBOR deterministic profile (RFC 8949 §4.2.1; matches LCAP's LDC rules but a separate zero-dependency impl): shortest-form integers, definite-length only, bytewise-encoded-key map order, optional-omit, UTF-8/NFC, fail-closed reject matrix + §27 resource caps. Pinned by the P1/P2/P3 determinism + integer-boundary + bomb-abort suite | `packages/private-p2p/src/crypto/canonical.ts` |
| **WS-S.2.3** | Every strict (`.strict()`) private schema: the §10.4 `PrivateEncryptedEnvelopeV1` (EXTENDED with `capability_root_at_seq`/`chunk_index`/`chunk_total` so a verifier reconstructs both §10.5 AADs entirely from the envelope — `BODY_AAD_ENVELOPE_FIELDS`/`WRAP_AAD_ENVELOPE_FIELDS` are the single source); the §13.1 manifest; the §13.2 op envelope + all op bodies (membership/role/story/thread/contribution/summary/attachment/snapshot/recovery); the §10.3 invite + §12.3 join; the §13.6 attachment manifest; the §13.7 search shard; the §19.4 report package. **Contribution ops reuse the shipped WS-G constants** (`CONTRIBUTION_BODY_LIMITS`, `MAX_CITATIONS`, `citationSchema`, the type/thread enums) so the typed rules cannot drift | `packages/private-p2p/src/schemas/` |

## Tests

| Suite | Coverage |
|---|---|
| `packages/shared` | the §4.1 coherence accept/reject matrix + `roomClassOf`; the disclosure/matrix copy-lint |
| `packages/db` | the DB↔shared enum mirror; the §8.1 column denylist (allowlist exactness + a forbidden-column fixture that BITES; rendezvous has no room FK) |
| `packages/private-p2p` | the canonical determinism/reject/bomb suite (P1/P2/P3 + integer-boundary table); the strict-schema accept/reject + WS-G contribution parity + envelope↔AAD alignment; every op-body type validated (≈97% coverage) |
| `apps/api` | the server-gate suite: submission 409 (+ no row created), contribution 404, feed `p2p_room_local_only`, the ranking room-surface exclusion, the search filter, the event-pipeline gate |
| `scripts` | the seven CI gates proven to bite (clean vs violating fixtures) + the live-source marker regression catch |

## Residuals (the next slices)

The crypto/P2P/UI plane is the next work, gated by the foundation above:

- **WS-S.3 — cryptographic foundation** (MLS group keying, the epoch exporter →
  HKDF-Expand-Label key schedule, the body/key-wrap AEAD, HPKE invite bootstrap,
  Ed25519 signatures, the local key store + recovery): needs an audited MLS/HPKE
  TS/WASM library + a memory-hard KDF, declared in `@licio/private-p2p` and
  code-split.  The cipher suites are pinned in `docs/PRIVATE_SPEC.md` §10.7.
- **WS-S.4 — Helia/libp2p private profile** (disabled public routing, the CIDv1
  ciphertext profile + IndexedDB blockstore, the membership-gated block-exchange
  protocols, the public-gateway rejection guard).
- **WS-S.5 — the operation log + deterministic Lamport-ordered reducer**
  (3-stage op validation, the byte-identical fold, the conflict table, snapshots,
  local moderation overlays, local-only encrypted search).
- **WS-S.6 — P2P sync + rendezvous** (blind-id derivation, encrypted signaling,
  the membership-proving handshake, head/block exchange, offline CAR — the
  WS-R.16.1 ↔ WS-S.6.5 seam — and the server rendezvous endpoints).
- **WS-S.7/8/9 — the UI, media pipeline, and migration** (the creation wizard
  consuming the WS-S.0.3 copy, the room shell/composer/invite panels, encrypted
  media, and the "new P2P room, never an in-place upgrade" migration).
- **WS-S.10 — the hardened update channel** (the reproducible signed private
  bundle in a transparency log; `check:private-bundle-transparency` EXTENDS to
  assert the SW pin + the room-lock-on-unverified path; the Tier-3 local key
  agent).
- **WS-S.11 — audit/test/launch** (the network request-capture suite, the
  Appendix D `assertNoP2PServerContent(roomId)` post-E2E DB assertion + the
  multi-peer sync correctness matrix, the update-channel tests, and the external
  cryptography/storage/metadata/red-team reviews).

The single composition seam with LCAP (WS-R.16.1 / WS-R.11.5 / WS-S.6.5) lands
late and optionally; LCAP carries only WS-S ciphertext + opaque hints and never
sees plaintext, keys, op-heads, or real private-room ids.  Where the two
disagree for private-room content, **`PRIVATE_SPEC` wins**.

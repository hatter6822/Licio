# WS-S: Private P2P Rooms (End-to-End Encrypted)

**Milestone:** Post-M3 privacy extension (a separate storage/sync/trust/authority plane; not launch-blocking for the core social product) | **Priority:** P3 | **Dependencies:** WS-C (PWA shell, service worker, IndexedDB), WS-D (account login, sessions, identity-free rate limiting), WS-G (the eleven-type contribution taxonomy + UGC pipeline, mirrored locally), WS-Q (room model + binary visibility — extended with new axes), WS-O (reproducible builds, CSP/Trusted Types, transparency log — for the update channel) — all complete; optional reuse of WS-R (LCAP) packs for offline transport | **Source spec:** `docs/PRIVATE_SPEC.md` | **Wave:** 11 (parallelizable with WS-R; independent except the optional LCAP-pack CAR reuse) | **Estimated duration:** 18-24 weeks | **Task count:** 56 atomic cards

---

## Overview

WS-S implements **Private P2P rooms** (`docs/PRIVATE_SPEC.md`): rooms whose content, threads, comments, media, membership internals, and private search state are **end-to-end encrypted and hosted by members' devices**, not by the Licio main server. This is a *separate storage, sync, trust, and authority plane* — **not** a stronger flag on the existing server-hosted private-room model (which WS-Q calls a "restricted/members-only server room"). Platform staff cannot read, alter, recover, moderate, add members to, or delete private-room content because the platform never possesses content, keys, heads, or authoritative membership state.

Three room classes coexist (PRIVATE_SPEC §4):

| Internal class | UI label | Storage | Authority | Server reads? | Ranks/searches? |
|---|---|---|---|---:|---:|
| `public_server` | Public room | Licio server | Platform + room roles | Yes | Yes |
| `restricted_server` | Members-only server room | Licio server | Platform + room roles | Yes | Server-local only |
| `private_p2p` | **Private P2P room** | Member devices / encrypted pins | **Room keys only** | **No** | **No** |

The keystone is the **server non-storage contract** (PRIVATE_SPEC §8): for `storage_mode = 'p2p'` the server MUST NOT store or derive any private content, private CID, operation head, story/thread/contribution id, member list, activity state, search/ranking data, push content, or key/invite/recovery secret — only (optionally) a minimal directory stub and blind rendezvous records. Three security tiers (§3.2) set honest expectations: Tier 1 (PWA private) protects against passive server-storage compromise and ordinary administration but **not** a malicious Licio web update; Tier 2 (hardened PWA, update pinning) and Tier 3 (local key agent) reduce update-channel risk.

WS-S is **mostly net-new code** in a new shared workspace + a lazily code-split web module, plus tightly-scoped *defensive* guards on existing server surfaces so a P2P room id can never create server content.

### Verified integration points (current code)

| Concern | Symbol / file | WS-S change |
|---|---|---|
| Room axes (wire) | `roomVisibilitySchema`/`roomCreateRequestSchema` / `packages/shared/src/schemas/room.ts` | add `storage_mode`, `authority_model`, `directory_mode`; coherence `superRefine`; `can_post` false/omitted for p2p server projections |
| Room axes (storage) | `rooms` / `packages/db/src/schema/room.ts` | `storage_mode`/`authority_model`/`directory_mode`/`p2p_stub_id` columns + coherence CHECKs (PRIVATE_SPEC §23.2) |
| New server tables | `packages/db/src/schema/private-room.ts` (new) | `private_room_stubs`, `private_rendezvous_records` (strict field allowlists; §8.1 denylist as column denylist) |
| Submission guard | `apps/api/src/ingestion/submission.ts` | reject `storage_mode = 'p2p'` BEFORE auto-join/visibility derivation → `409 p2p_room_requires_client_sync` |
| Contribution guard | `apps/api/src/forum/contributions.ts` (+ routes) | reject p2p thread/room ids (defense in depth; p2p ids never exist server-side) |
| Ranking retrievers | eight retrievers + `RoomSurfaceRetriever` / `apps/api/src/ranking/retrievers.ts` | every retriever predicates `rooms.storage_mode = 'server'`; p2p never retrieved |
| Search | `SearchIndex` / `apps/api/src/ingestion/search.ts` | index + query only `storage_mode = 'server'` rooms |
| Event pipeline | `licioEventSchema`/router / `apps/api/src/events/` | validation gate: an event referencing a p2p room → reject + security metric |
| Uploads | `apps/api/src/forum/safety.ts` upload path | server uploads never attach to p2p content; client hides server-upload UI in p2p rooms |
| New API routes | `apps/api/src/routes/private-rooms.ts`, `private-rendezvous.ts` (new) | `/v1/private-rooms/*`, `/v1/private-rendezvous/*` (stubs + blind signaling only) |
| New shared package | `packages/private-p2p/` (new) | schemas, crypto (MLS/HPKE/AEAD/KDF/signatures/canonical), IPLD/CID/CAR, reducer, sync |
| New web module | `apps/web/src/private-p2p/` (new, lazily code-split) | Helia/libp2p node, key store/agent, sync engine, room DB + reducer worker, UI |
| Update channel | WS-O reproducible build + transparency log; `apps/web/public/sw-push.js` | sign/hash-pin the private-mode bundle; SW update pinning; lock private rooms on unverified bundle |
| CI gates | `scripts/` + `package.json` | `check:no-p2p-server-content`, `check:no-private-cid-egress`, `check:private-rendezvous-schema`, `check:private-bundle-transparency`, `check:p2p-endpoint-rejections`, `check:p2p-ranking-exclusion`, `check:p2p-search-exclusion` |

### Relationship to other specs and workstreams

- **WS-R / `docs/OFFLINE_SPEC.md` (LCAP).** WS-S owns the *authority and confidentiality* plane; WS-R is a complementary *availability and transport* substrate. WS-S MAY reuse the LCAP `.licio-bundle` pack as its encrypted CAR (§15.9), the lane scheduler so membership/control material outruns media, and LCAP liveness/trust labelling — but LCAP only ever sees ciphertext + opaque room hints for private rooms. The planes pin different suites on purpose (Ed25519/MLS here; ES256 in LCAP) and never share keys.
- **WS-Q.** WS-S adds the `private_p2p` class as a third room class orthogonal to WS-Q's binary public/private *server* visibility; WS-Q's "private room" is renamed "members-only server room" so "private" in the strong sense is reserved for `private_p2p` (§20.1).
- **WS-D / Section 19.1.** Rendezvous and stub-creation rate limiting key on a non-reversible account reference, never an IP, matching the shipped identity-free posture.
- **WS-G.** Private contribution validation mirrors the shipped WS-G typed rules (body caps, citations for evidence/corrections, answer→question parent, depth cap, lens-belongs-to-room) — locally, on decrypted state.

### Conventions for this workstream

- **Server non-knowledge (ABSOLUTE, §8).** The §8.1 forbiddance list is enforced structurally: a column denylist on the stub/rendezvous tables, endpoint rejection guards, retriever/search predicates, an event-pipeline gate, and seven CI checks. Any path that could place private content/CIDs/heads/member-lists/keys on the server is a release-blocking violation.
- **Encrypt before content-address (ABSOLUTE, §9.1).** A plaintext CID MUST never exist for private-room content; the CID always identifies ciphertext. The render path MUST reject any attempt to construct a public-gateway URL for a private CID.
- **No custom group crypto (ABSOLUTE, §10.3).** Group keying is MLS (RFC 9420); invite bootstrap is HPKE (RFC 9180); no hand-rolled ratchet. WebCrypto is wrapped behind small, reviewed modules; primitives are audited libraries.
- **Canonical encoding pinned (§10.1.1).** Every structure that is hashed into a CID, fed to an AEAD as AAD, signed, or compared for reducer determinism uses the one DAG-CBOR deterministic profile in `packages/private-p2p/src/crypto/canonical.ts`, pinned by stability tests.
- **Honest non-goals (ABSOLUTE, §6).** The UI states the limits everywhere they matter: members can copy/leak content; removal is not retroactive deletion; availability depends on member devices/pins; Licio cannot recover lost keys; Tier 1 does not defend against a malicious web update. Support docs MUST NOT promise impossible recovery/moderation.
- **No platform-role authority (§11.4).** No platform role (`admin`, `steward`) and no support/emergency key can read, add members to, moderate, recover, or unlock a P2P room. Platform staff may only delist a listed directory stub or suspend a Licio account's access to Licio-hosted services.
- **Dependency-budget isolation (§9.8).** Helia/libp2p/MLS/HPKE/Argon2 live in `packages/private-p2p` (workspace, excluded from the `apps/web` < 15 direct-dep count) and a dynamically-imported route chunk loaded only on first private-room use; the core PWA's initial-bundle gate (< 200 KB gz) MUST NOT regress.
- **Naming discipline (§20.1).** "Public room" / "Members-only server room" / "Private P2P room." Server-hosted restricted rooms are never called "private" without a qualifier; only `private_p2p` is "private" in the strong sense.
- **Fail-closed.** Unknown ops, unverified bundles, unauthorized signers, missing parents, and undecryptable envelopes all fail closed; quarantined/unsupported ops never render.
- **Task sizing (Section 30.8).** Every card is one deliverable — one schema, one crypto module, one op type, one guard, one endpoint, one UI panel — reviewable, testable, and reversible in ≤ 1-3 engineering days. Sub-area headers map to PRIVATE_SPEC §28's WS-P2P-0…11; the dependency graph at the end fixes their order.

---

## WS-S.0 Terminology, room-class model, and product framing

### WS-S.0.1 Three-room-class model + shared room axes
**ID:** WS-S.0.1 | **Ref:** PRIVATE_SPEC §4, §4.1; WS-P2P-0

**Description:** In `packages/shared/src/schemas/room.ts` add the three axes as `z.enum`s — `ROOM_STORAGE_MODES = ['server','p2p']`, `ROOM_AUTHORITY_MODELS = ['platform','room_keys']`, `ROOM_DIRECTORY_MODES = ['listed','unlisted','detached']` — with inferred types, and a `superRefine` enforcing the §4.1 coherence: `storage='server' ⇒ authority='platform'`; `storage='p2p' ⇒ authority='room_keys' ∧ visibility='private' ∧ join_model='invite'`; for p2p, `posting_policy` is advisory UI only (real posting is capability-gated). Default `directory_mode='unlisted'` for p2p. Server room projections set `can_post=false`/omit it for p2p (posting is local).

**Acceptance criteria:**
- The coherence refinement accepts every legal triple and rejects each illegal one (e.g. `p2p`+`platform`, `p2p`+`public`).
- Default directory mode for p2p is `unlisted`; `listed` requires explicit action.
- No applause/financial field appears on any room shape (existing denylist tests stay green).

**Testing:** Unit — coherence accept/reject matrix; default-application; `expectTypeOf` for the new fields.

**Dependencies:** WS-Q (binary room visibility) complete.

---

### WS-S.0.2 Restricted-server-room rename + privacy promise matrix
**ID:** WS-S.0.2 | **Ref:** PRIVATE_SPEC §20.1, Appendix E

**Description:** Rename the WS-Q server-hosted "private" room to **"Members-only server room"** across UI copy and docs (the storage/authority model is unchanged — this is a labelling correction). Add the §Appendix E user-facing privacy matrix (Public / Members-only server / Private P2P across: can Licio host? can admins access? can content be globally ranked? can Licio recover? can members leak? can removed members read old content? does availability depend on member devices? are public gateways used?). "Private" without a qualifier is reserved for `private_p2p`.

**Acceptance criteria:**
- No server-hosted restricted room is labelled simply "private" anywhere in UI or docs.
- The privacy matrix renders and is referenced from each room class's creation/info surface.

**Testing:** Unit — copy-lint that "private" is qualified for server rooms; matrix render snapshot. E2E (axe) — matrix accessibility.

**Dependencies:** WS-S.0.1.

---

### WS-S.0.3 Mandatory creation/removal/limit disclosure copy
**ID:** WS-S.0.3 | **Ref:** PRIVATE_SPEC §6, §20.2, §20.5

**Description:** Add the §6 honest-limits copy as i18n-catalog entries: the mandatory creation disclosure ("Licio does not host the room's content and cannot read, moderate, recover, or add members… removed members may keep content… members can copy… keep a recovery kit"), the removal disclosure ("stops future reading after keys rotate; cannot delete/recall content already downloaded"), and the five mandatory creation acknowledgment checkboxes. These are blocking copy, not advisory.

**Acceptance criteria:**
- Creation cannot proceed without all five acknowledgments; the disclosure text matches §6 exactly.
- Removal dialog shows the non-retroactive-deletion disclosure.
- All copy is locale-ready and passes the prohibited-language scan (no false "secure"/"deleted everywhere").

**Testing:** Unit — gating on acknowledgments; copy presence. E2E — creation/removal disclosure flow.

**Dependencies:** WS-S.0.2.

---

## WS-S.1 Server schema and hard non-storage gates

### WS-S.1.1 Room axes DB migration + coherence CHECKs
**ID:** WS-S.1.1 | **Ref:** PRIVATE_SPEC §23.2; WS-P2P-1

**Description:** In `packages/db/src/schema/room.ts` add `room_storage_mode`/`room_authority_model`/`room_directory_mode` enums and the `storage_mode` (NOT NULL DEFAULT `'server'`), `authority_model` (NOT NULL DEFAULT `'platform'`), `directory_mode` (nullable), `p2p_stub_id` (nullable) columns, with the §23.2 CHECK constraints enforcing coherence structurally: storage↔authority coherence, `p2p ⇒ directory_mode NOT NULL`, `p2p ⇒ visibility='private'`, `server ⇒ p2p_stub_id IS NULL`. The migration is additive (defaulted columns) following the WS-Q expand pattern; existing rooms remain `server`/`platform`.

**Acceptance criteria:**
- Migration is additive + idempotent with a clean down path; no existing row is rewritten.
- The four CHECKs reject every incoherent row (p2p+platform, p2p+public, server-with-stub, p2p without directory).
- DB enums mirror the shared enums exactly (storage-layer defense in depth).

**Testing:** Gated integration (Postgres) — apply/rollback; CHECK-violation cases. Unit — DB↔shared enum mirror.

**Dependencies:** WS-S.0.1.

---

### WS-S.1.2 `private_room_stubs` + `private_rendezvous_records` tables
**ID:** WS-S.1.2 | **Ref:** PRIVATE_SPEC §8.2, §15.3, §23.2

**Description:** Add `packages/db/src/schema/private-room.ts`: `private_room_stubs` carrying ONLY the §8.2 allowed fields (stub id, room_server_id, directory_mode, listed-only display name/description/avatar public CID, room public key, manifest/latest-manifest commitments, rendezvous policy, bootstrap hints, signed stub + signature, creator account, timestamps) and `private_rendezvous_records` (room_blind_id, peer_blind_id, encrypted_announcement, expires_at). The §8.1 forbiddance list is the **column denylist** for both tables — no content/CID/op-head/member/activity/key/secret column may exist. Short TTL + size caps on rendezvous rows.

**Acceptance criteria:**
- Neither table has any column that could hold private content/CIDs/heads/member lists/keys; a schema test asserts the denylist.
- For `detached` rooms, no stub row is created; `unlisted` stores only the opaque stub.
- Rendezvous rows carry only blind ids + ciphertext + TTL and auto-expire.

**Testing:** Gated integration — table shape + TTL expiry. Unit — column-denylist assertion (`check:private-rendezvous-schema`).

**Dependencies:** WS-S.1.1.

---

### WS-S.1.3 Endpoint rejection guards (submission / contribution / upload)
**ID:** WS-S.1.3 | **Ref:** PRIVATE_SPEC §21.6, §23.3, §23.4, §23.8

**Description:** Add the defensive guards: in `apps/api/src/ingestion/submission.ts`, **before** auto-join/visibility derivation, reject `room.storageMode === 'p2p'` with `409 p2p_room_requires_client_sync`; in the forum contribution routes/services, reject p2p thread/room ids (defense in depth — p2p ids should never exist server-side); in the upload path, refuse to attach uploads to p2p content and hide server-upload UI inside p2p rooms. `GET /v1/rooms/:id/feed` for a p2p room returns the `p2p_room_local_only` response; `GET /v1/search` never returns p2p content.

**Acceptance criteria:**
- A `POST /v1/stories`/`/v1/contributions` with a p2p room/thread id returns the documented 409 and creates no row.
- The p2p feed endpoint returns local-only guidance; server upload attach to p2p is rejected.
- The guard runs before any side effect (no thread shell, no event emission).

**Testing:** Gated integration — each endpoint's p2p rejection (`check:p2p-endpoint-rejections`); no-row-created assertion.

**Dependencies:** WS-S.1.1.

---

### WS-S.1.4 Retriever / search / event-pipeline exclusion
**ID:** WS-S.1.4 | **Ref:** PRIVATE_SPEC §23.5, §23.6, §23.7

**Description:** Predicate every ranking retriever (the eight organic + the room-surface scoper) and the search index/query on `rooms.storage_mode = 'server'` so p2p content can never enter global/topic/room surfaces or search. Add an event-pipeline validation gate: an event payload referencing a p2p room → reject + security metric (private-room events should never be emitted, so the gate catches bugs).

**Acceptance criteria:**
- No retriever or search path can return p2p content; the predicate is on every candidate source.
- An event referencing a p2p room is rejected with a security metric, never processed.
- The ranking-neutrality + containment suites extend to assert p2p exclusion.

**Testing:** Gated integration — retriever/search exclusion (`check:p2p-ranking-exclusion`, `check:p2p-search-exclusion`); event-gate rejection.

**Dependencies:** WS-S.1.1.

---

### WS-S.1.5 Server non-storage CI gates + DB assertion suite
**ID:** WS-S.1.5 | **Ref:** PRIVATE_SPEC §23.10, §26.4, Appendix D

**Description:** Add the seven §23.10 CI gates (`check:no-p2p-server-content`, `check:no-private-cid-egress`, `check:private-rendezvous-schema`, `check:private-bundle-transparency`, `check:p2p-endpoint-rejections`, `check:p2p-ranking-exclusion`, `check:p2p-search-exclusion`) and the Appendix D `assertNoP2PServerContent(roomId)` post-E2E DB assertion (stories/threads/search/ranking-candidates/events-payload/uploads all count 0 for a p2p room). `check:no-private-cid-egress` scans server logs/source for private CID/op-id/invite-fragment patterns.

**Acceptance criteria:**
- All seven gates run in CI; each fails on an injected violation fixture.
- After a full P2P E2E run, the DB assertion proves zero private content rows for the room.
- Server logs exclude private CIDs/op ids/invite fragments/member lists/thread titles/bodies/exact activity (§27.1).

**Testing:** The gates themselves (positive + negative fixtures); Appendix D assertion after the WS-S.11.3 E2E.

**Dependencies:** WS-S.1.2, WS-S.1.3, WS-S.1.4.

---

## WS-S.2 Private schemas and canonical encoding

### WS-S.2.1 `packages/private-p2p` scaffold + dependency-budget isolation
**ID:** WS-S.2.1 | **Ref:** PRIVATE_SPEC §9.8, §22.1

**Description:** Create the `@licio/private-p2p` workspace with the §22.1 source tree (`schemas/`, `crypto/`, `ipld/`, `reducer/`, `sync/`, `testing/`), TS strict, SPDX headers, depends on `@licio/shared` only (never `@licio/db`). All heavy dependencies (Helia, libp2p + transports, the chosen MLS lib, HPKE lib, Argon2/curve fallback) are declared **here**, not in `apps/web` — the workspace is excluded from the `apps/web` < 15 direct-dep count. Document the dedicated `check:deps` allowance and confirm the web consumer is a dynamically-imported chunk (§9.8).

**Acceptance criteria:**
- `pnpm --filter @licio/private-p2p build/test` run standalone; `check:workspace-deps` passes (no `@licio/db` import).
- `apps/web` direct-dep budget and initial-bundle size gate are unchanged (heavy deps are in the workspace + lazy chunk).
- Each dependency passes the CLAUDE.md review (maintained, install-script-free, AGPL-compatible); choices tracked in §30.1–§30.2.

**Testing:** CI — workspace-boundary + dep-budget + bundle-size gates green; export smoke test.

**Dependencies:** none (new workspace; depends on `@licio/shared`).

---

### WS-S.2.2 Canonical DAG-CBOR encoder + stability tests
**ID:** WS-S.2.2 | **Ref:** PRIVATE_SPEC §10.1.1, §9.4

**Description:** Implement `packages/private-p2p/src/crypto/canonical.ts`: the DAG-CBOR deterministic profile (RFC 8949 §4.2.1 core determinism — shortest-form integers, definite-length only, bytewise-lexicographic map-key order, no duplicate keys, no floats, omit-not-null optionals, UTF-8/NFC text), matching LCAP's LDC rules. This is the single `canonical(...)` referenced by every AAD, signature, CID, and reducer comparison. Pin it with stability vectors.

**Acceptance criteria:**
- `canonical(value)` is byte-stable and equals committed vectors; two encoders agree.
- Non-deterministic input (unsorted/duplicate keys, indefinite length, floats) is rejected on decode.
- The encoder is shared by the IPLD/CID layer (§9.4) so ciphertext-block CIDs are reproducible.

**Testing:** Unit — encode/decode/reject matrix; stability-vector replay; "equal value ⇒ equal bytes" property.

**Dependencies:** WS-S.2.1.

---

### WS-S.2.3 Envelope + object schemas
**ID:** WS-S.2.3 | **Ref:** PRIVATE_SPEC §10.4, §13

**Description:** Define the strict zod schemas in `packages/private-p2p/src/schemas/`: `PrivateEncryptedEnvelopeV1` (§10.4), the plaintext manifest (§13.1), the op envelope + the eleven op bodies (membership/role/story/thread/contribution/summary/attachment/snapshot, §13.2–13.6), invite secret (§10.3), join request (§12.3), attachment manifest (§13.6), local search shard (§13.7), and the voluntary report package (§19.4). Private contribution validation mirrors the WS-G typed rules (body caps, citations for evidence/corrections, answer→question parent, depth cap, lens-belongs-to-room) on decrypted state.

**Acceptance criteria:**
- Every schema is `.strict()`; unknown fields reject; forward compat is by schema-version bump.
- Contribution ops enforce the same typed requirements as the shipped WS-G server schema.
- The envelope's authenticated metadata matches the AAD inputs (WS-S.3.3) exactly.

**Testing:** Unit — accept/reject per schema; WS-G-parity matrix for contribution ops; envelope↔AAD field alignment.

**Dependencies:** WS-S.2.2.

---

## WS-S.3 Cryptographic foundation

### WS-S.3.1 MLS integration + exporter + epoch secret
**ID:** WS-S.3.1 | **Ref:** PRIVATE_SPEC §10.2, §30.1

**Description:** Integrate the chosen audited TypeScript/WASM MLS implementation (RFC 9420) behind `packages/private-p2p/src/crypto/mls.ts`, mapping one room = one MLS group, one device = one MLS client, room epoch = MLS epoch, add/remove/commit/welcome to membership transitions. Derive `room_epoch_secret = MLS-Exporter("licio.private-room.v1.epoch", canonical([room_id_commitment, epoch, manifest_commitment]), 32)` (§8.5). Pin the cipher suite from audited library defaults and test with official MLS vectors where available.

**Acceptance criteria:**
- Add/remove/commit produce a new epoch with a fresh exporter secret; Welcome admits a new device.
- `room_epoch_secret` is reproducible from the exporter and bound to the epoch; cipher suite is pinned.
- MLS library vectors pass where available; the wrapper exposes only the minimal reviewed surface.

**Testing:** Unit/gated — MLS add/remove/commit across simulated devices; exporter determinism; official-vector replay.

**Dependencies:** WS-S.2.3.

---

### WS-S.3.2 HKDF-Expand-Label key schedule
**ID:** WS-S.3.2 | **Ref:** PRIVATE_SPEC §10.2

**Description:** Implement `HKDF-Expand-Label(secret, label, context, length)` (HKDF-SHA256, RFC 5869, TLS-1.3/MLS style: `HKDF-Expand(secret, encode(length, "licio-priv1 "||label, context), length)`, no separate Extract since the exporter secret is uniform) and derive the per-purpose keys from `room_epoch_secret`: `content_wrap_key`, `sync_topic_key`, `rendezvous_key`, `snapshot_key`, `report_key` — each with its label, `context = room_id_commitment`, length 32. One MLS Commit rotates all of them.

**Acceptance criteria:**
- Each derived key is reproducible, domain-separated by the `"licio-priv1 "`+label prefix, and 32 bytes.
- `context` is canonical-encoded, never ad-hoc concatenation; the five keys are mutually independent.
- A new epoch yields five new keys atomically.

**Testing:** Unit — derivation vectors; domain-separation independence; epoch rotation rotates all keys.

**Dependencies:** WS-S.3.1.

---

### WS-S.3.3 Object-body + key-wrap AEAD with canonical AAD
**ID:** WS-S.3.3 | **Ref:** PRIVATE_SPEC §10.4, §10.5, §10.6

**Description:** Implement the two-layer AEAD: a fresh per-object content key encrypts the plaintext (AES-256-GCM or XChaCha20-Poly1305, fresh nonce) under the §10.5 `body_aad` (canonical fixed-shape array binding envelope version, room_id_commitment, epoch, object_type, plaintext_schema, sorted parent_op_ids, author_device_id_blind, author_seq, capability_root_at_seq, chunk_index/total); the object key is wrapped under `content_wrap_key` with a fresh `wrap_nonce` and the `wrap_aad` (binding wrapping_epoch, room_id_commitment, object_type). Enforce the §10.6 rules: fresh object key + nonce per object, no nonce reuse (fatal), no deterministic/convergent encryption, compression-before-encryption forbidden across the secret/attacker boundary (pad instead, §25.4).

**Acceptance criteria:**
- Both AADs are canonical-encoded; reconstructing them from envelope metadata + local epoch is the only way to open.
- A fresh object key + nonce is used per object; a nonce-reuse attempt is a hard error (assertion in tests).
- `wrapping_epoch` binding prevents replaying an object key into an envelope claiming another epoch.
- Contribution/op bodies are never compressed; padding to a size bucket is applied instead.

**Testing:** Unit — encrypt/open round-trip; AAD-mismatch rejection; nonce-reuse fatal; no-compression-on-secret assertion.

**Dependencies:** WS-S.3.2.

---

### WS-S.3.4 HPKE invite bootstrap
**ID:** WS-S.3.4 | **Ref:** PRIVATE_SPEC §10.3, §12.2

**Description:** Implement HPKE (RFC 9180) invite sealing in `packages/private-p2p/src/crypto/hpke.ts` for one-to-one bootstrap before the recipient joins the MLS group: seal `InviteSecretV1` (room stub ref, room public key, invite id/secret, expiry, max uses, granted role, approval flag) to the recipient. The invite URL carries the sealed secret in the **fragment** (`…/private/join#invite=<base64url-sealed>`) so ordinary HTTP never transmits it to the server. Pin the HPKE suite + library and test with official vectors.

**Acceptance criteria:**
- The invite secret is HPKE-sealed; only the intended recipient opens it; the secret lives in the URL fragment only.
- Invite expiry/max-uses/role/approval are authenticated; a tampered invite fails to open.
- Official HPKE vectors pass; the suite is pinned.

**Testing:** Unit — seal/open round-trip; fragment-only assertion; vector replay; tamper rejection.

**Dependencies:** WS-S.3.1.

---

### WS-S.3.5 Ed25519 signatures + WebCrypto/fallback
**ID:** WS-S.3.5 | **Ref:** PRIVATE_SPEC §10.7, §30.5

**Description:** Implement room-scoped (or room-epoch-scoped, to reduce linkability) Ed25519 device signing over the canonical-encoded envelope + all public metadata. Use WebCrypto `Ed25519`/`X25519` where `crypto.subtle` advertises support; otherwise fall back to an audited curve library (e.g. `@noble/curves` or libsodium-WASM) loaded **inside the lazily code-split private-p2p chunk**, never the core bundle. Final algorithm/suite pinned before implementation.

**Acceptance criteria:**
- Every op/envelope is Ed25519-signed over the canonical bytes + public metadata; signature verifies cross-runtime.
- WebCrypto is used where available; the fallback loads only in the private chunk and matches WebCrypto output on vectors.
- Device keys are room/epoch-scoped to reduce cross-room linkability.

**Testing:** Unit — sign/verify; WebCrypto↔fallback vector parity; linkability-scope assertion.

**Dependencies:** WS-S.2.2.

---

### WS-S.3.6 Local key store (tiers) + recovery kit + threshold recovery
**ID:** WS-S.3.6 | **Ref:** PRIVATE_SPEC §10.8, §16.2, §12.6, §12.6.1

**Description:** Implement the `LocalPrivateKeyRecord` store with the four protection tiers (passphrase-Argon2id / WebCrypto non-extractable wrap / passkey-assisted / local key agent) and Argon2id (RFC 9106) or a similarly-reviewed memory-hard KDF for passphrase exports. Implement the recovery kit (encrypted member/device recovery capability) and **capability-based threshold recovery** (§12.6.1: M distinct admin-signed RecoveryAuthorize ops → MLS Add + epoch rotation; NOT secret-sharing the root key by default). Lost-all-keys is unrecoverable — no false recovery path (§12.7).

**Acceptance criteria:**
- Keys are protected at the configured tier; passphrase exports use Argon2id; high-risk rooms require the local agent or strict update pinning.
- The recovery kit is strong-passphrase/hardware-bound; threshold recovery counts M distinct admin authorizations via signed ops, not reconstructed key material.
- Support is never offered a recovery path for a fully-lost room.

**Testing:** Unit — per-tier protect/unlock; recovery-kit round-trip; threshold-count enforcement; lost-all-keys is terminal.

**Dependencies:** WS-S.3.1, WS-S.3.5.

---

### WS-S.3.7 Crypto vectors, fuzzing, and nonce-uniqueness assertions
**ID:** WS-S.3.7 | **Ref:** PRIVATE_SPEC §26.2, §10.6

**Description:** Assemble `packages/private-p2p/src/testing/vectors.ts`: official HPKE vectors, MLS library vectors where available, canonical-encoding differential tests, envelope encrypt/decrypt vectors, signature vectors, and property tests — unauthorized ops never render; removed members cannot decrypt future-epoch test objects; nonce/object-key uniqueness holds under generated workloads (nonce reuse is asserted impossible). Fuzz malformed envelopes/ops.

**Acceptance criteria:**
- All official vectors pass; differential canonical-encoding tests pass.
- The "removed member cannot decrypt future epoch" and "unauthorized op never renders" properties hold.
- A nonce-reuse assertion runs across generated encryption workloads and is never violated.

**Testing:** Property + fuzz suite; vector replay; nonce/key-uniqueness invariant.

**Dependencies:** WS-S.3.3, WS-S.3.4, WS-S.3.5.

---

## WS-S.4 Helia / libp2p private profile

### WS-S.4.1 Private Helia node + disabled public routing
**ID:** WS-S.4.1 | **Ref:** PRIVATE_SPEC §9.2, §9.3, §9.5

**Description:** Configure a separate Helia/libp2p node/namespace for private rooms (`LicioPrivateHeliaProfile`, §9.3) that DISABLES public DHT routing, public gateway fallback, delegated routing, IPNI advertisement, public Bitswap with unknown peers, public provider records, automatic reproviding of private CIDs, and permanent cross-room PeerIDs; mDNS off (or local-only-explicit); relay mode `direct_allowed|relay_preferred|relay_only`; PeerID scoped to room-epoch. The private node is fully isolated from any public-content Helia usage.

**Acceptance criteria:**
- Every public-routing surface is disabled in the private profile; a config test asserts each flag false.
- PeerIDs are room-epoch-scoped and rotate; no permanent cross-room identity exists.
- The private node shares no routing/announcement with public content.

**Testing:** Unit — profile-flag assertions (all public routing off). Gated — two private nodes connect only via the private profile.

**Dependencies:** WS-S.2.1.

---

### WS-S.4.2 CIDv1 ciphertext profile + IndexedDB blockstore
**ID:** WS-S.4.2 | **Ref:** PRIVATE_SPEC §9.1, §9.4, §16.1

**Description:** Implement the §9.4 CIDv1 ciphertext profile (cid v1, base32, sha2-256, dag-cbor small-object codec over ciphertext metadata, raw codec for large encrypted chunks, 256 KiB small / 1–4 MiB large chunk sizes) over the §16.1 IndexedDB-backed blockstore/datastore (`licio_private_blocks`/`_ops`/`_heads`/`_keys`/`_snapshots`/`_local_search`/`_outbox`/`_replication`/`_rooms`). The CID always identifies **ciphertext**; a plaintext CID for private content must never exist (the encrypt→pad→encrypt→chunk→CID pipeline of §9.1).

**Acceptance criteria:**
- Every private CID is over ciphertext; the pipeline encrypts before content-addressing; no plaintext CID is produced.
- The IDB blockstore stores/retrieves encrypted blocks by CID; large media chunks use the raw codec.
- The private stores are separate from public content and the WS-R `lcap_v2` DB.

**Testing:** Unit (`fake-indexeddb`) — store/retrieve by CID; ciphertext-only-CID assertion; chunk-size selection.

**Dependencies:** WS-S.3.3, WS-S.4.1.

---

### WS-S.4.3 Private libp2p block-exchange protocols + membership gating
**ID:** WS-S.4.3 | **Ref:** PRIVATE_SPEC §9.6, §15.5, §15.7

**Description:** Implement the Licio-specific libp2p protocols (`/licio/private/handshake/1`, `/heads/1`, `/block-request/1`, `/block-response/1`, `/snapshot/1`, `/range/1`, `/health/1`). Only peers that prove current-epoch room membership (WS-S.6.3 handshake) may speak these protocols for a room; public libp2p peers cannot request arbitrary private CIDs. All returned blocks are verified by CID + signature + AEAD before use.

**Acceptance criteria:**
- A non-member peer cannot open the private protocols or fetch any private CID.
- Block responses are verified (CID + signature + AEAD) before storage; a wrong-block-for-CID is rejected.
- The protocols carry only ciphertext; private CIDs are never announced to public routing.

**Testing:** Gated — member vs non-member protocol access; wrong-block/invalid-op rejection; no-public-announcement assertion.

**Dependencies:** WS-S.4.1, WS-S.6.3.

---

### WS-S.4.4 Public-gateway rejection guard
**ID:** WS-S.4.4 | **Ref:** PRIVATE_SPEC §9.5

**Description:** Add a render-path guard (and CI check) that REJECTS any private-room render path attempting to construct a public-gateway URL or perform a public DHT/delegated/IPNI/Bitswap lookup for a private CID. `check:no-private-cid-egress` statically scans the private-p2p trees for `ipfs.io`/public-gateway/public-routing patterns.

**Acceptance criteria:**
- Constructing a public-gateway URL for a private CID throws and is unreachable in any private render path.
- The static gate fails on any public-gateway/public-routing reference in the private trees.
- The guard runs at runtime AND in CI.

**Testing:** Unit — gateway-URL construction throws. CI — `check:no-private-cid-egress` positive/negative fixtures.

**Dependencies:** WS-S.4.2.

---

## WS-S.5 Operation log and deterministic reducer

### WS-S.5.1 Membership / role / capability ops + epoch enforcement
**ID:** WS-S.5.1 | **Ref:** PRIVATE_SPEC §11.3, §12, §13.2

**Description:** Implement the membership/authority ops — `member.add`/`member.remove`/`device.remove`/`role.grant`/`role.revoke`/`member.invite.create` — and the capability model (`read|post|invite|moderate|summarize|admin|rotate_keys|recover`) with the suggested role→capability mapping. Each op is signed and authorized by room capability state, not platform roles (§11.4). Add/remove drive MLS commits (WS-S.3.1) and epoch rotation; the manifest's `membership_change` policy (`admin|threshold`) gates who may commit.

**Acceptance criteria:**
- Every membership/role op is capability-checked; no platform role can authorize one.
- Add/remove produce an MLS commit + new epoch + new manifest commitment + rotated topics/blind-ids.
- Threshold rooms require the configured M distinct admin authorizations (WS-S.3.6).

**Testing:** Unit — capability gate per op; epoch-rotation-on-membership-change; threshold enforcement.

**Dependencies:** WS-S.2.3, WS-S.3.1.

---

### WS-S.5.2 Content ops (story / thread / contribution / summary / attachment)
**ID:** WS-S.5.2 | **Ref:** PRIVATE_SPEC §13.3, §13.4, §13.5, §13.6

**Description:** Implement the content ops mirroring Licio's taxonomy locally: `story.create`/`story.edit`/`story.tombstone` (eight submission types incl. `image_post`/`video_post`; local canonical-URL normalization — never the server normalizer/safety service); `thread.state` (conversation/safety states, room-local, not platform decisions); `contribution.create`/`edit`/`tombstone` (eleven types with typed body caps, citations, parent validation, depth cap, lens-in-room, `client_draft_id` dedup); `summary.create`; `attachment.add`. All validated on decrypted state against the WS-S.2.3 schemas.

**Acceptance criteria:**
- Content ops enforce the same typed rules as shipped WS-G/WS-Q, locally; private link normalization is local-only.
- Room-local thread/safety states are clearly NOT platform moderation decisions in the model and UI.
- `client_draft_id` provides idempotent per-device dedup.

**Testing:** Unit — per-op-type validation parity with WS-G; local-normalization (no server call); draft dedup.

**Dependencies:** WS-S.5.1.

---

### WS-S.5.3 Operation validation pipeline
**ID:** WS-S.5.3 | **Ref:** PRIVATE_SPEC §14.2

**Description:** Implement the §14.2 thirteen-step per-op validation: CID present in blockstore → envelope decodes under the private CID profile → envelope signature verifies → AEAD opens under an authorized epoch key → plaintext schema validates strictly → `room_id` matches → epoch valid for the op type → author device existed and was not removed at the op epoch → author sequence monotonic per device → parents present or queued as missing deps → capability check for the op type → type-specific semantic validation → insert into the accepted DAG or quarantine with reason. Quarantined ops MUST NOT render.

**Acceptance criteria:**
- Every step runs in order; failure routes to quarantine with a reason, never a silent accept or render.
- An op from a since-removed device at a post-removal epoch is rejected; a non-monotonic author sequence is rejected.
- Missing parents queue as dependencies and resolve when the parent arrives.

**Testing:** Unit — per-step accept/reject; removed-device-at-epoch rejection; missing-parent queue/resolve.

**Dependencies:** WS-S.5.2, WS-S.3.3.

---

### WS-S.5.4 Deterministic reducer (Lamport total order)
**ID:** WS-S.5.4 | **Ref:** PRIVATE_SPEC §14.3

**Description:** Implement the pure fold over accepted ops in the §14.3 canonical total order: validate `lamport` (decimal-string non-negative integer; strictly greater than every parent, else reject) so the Lamport order is a linear extension of causality, then sort ascending by `(lamport as big integer, created_at_bucket, author_device_id, op_id)` and fold through the per-type transitions, producing room/story/thread/contribution/member/overlay/replication state. The fold MUST NOT depend on wall-clock, arrival order, map iteration order, or floating point; "latest valid author edit wins" is decided by total-order position.

**Acceptance criteria:**
- An op whose `lamport` ≤ a parent's is rejected; the sort + fold is deterministic and byte-identical across devices.
- Two devices with the same accepted set produce identical state regardless of delivery order (property test).
- Canonical encoding governs every hashed/compared structure.

**Testing:** Unit/property — shuffled-delivery byte-identical state; lamport-monotonicity enforcement; LWW-by-order.

**Dependencies:** WS-S.5.3, WS-S.2.2.

---

### WS-S.5.5 Conflict policy
**ID:** WS-S.5.5 | **Ref:** PRIVATE_SPEC §14.4

**Description:** Implement the §14.4 conflict table: two same-author story edits → latest valid author edit wins (history retained); concurrent unauthorized edits → rejected; moderator tombstone vs author edit → tombstone hides display, history retained encrypted; member removed while posting → post-removal-epoch ops rejected; same `client_draft_id` twice → idempotent dedup; missing parent → queue, don't render; invalid/tombstoned parent → tombstone policy / reject child unless orphan display allowed; unknown future op schema → store encrypted block, don't render, show "unsupported room update".

**Acceptance criteria:**
- Each conflict class resolves per the table; encrypted history is always retained.
- A post-removal-epoch op is rejected; an unknown-schema op stores but never renders.
- Resolution is a function of the deterministic order (WS-S.5.4), not timestamps.

**Testing:** Unit — conflict-class matrix; history retention; unknown-schema non-render.

**Dependencies:** WS-S.5.4.

---

### WS-S.5.6 Snapshots
**ID:** WS-S.5.6 | **Ref:** PRIVATE_SPEC §14.5, §25.6

**Description:** Implement `snapshot.commit` (snapshot id, includes-ops-up-to heads, state Merkle root, snapshot body CID, author) as an optimization hint — trusted only if signed by an authorized role AND verified against accepted ops; clients MAY prune old decrypted derived state but retain encrypted op history unless room policy + enough members agree to compaction. Snapshot cadence: every ~1,000 accepted ops or 7 days, after large import, after membership churn, plus a manual "optimize room storage" action.

**Acceptance criteria:**
- A snapshot is used only after role-signature + accepted-ops verification; it is never authority on its own.
- Encrypted op history is retained by default; compaction requires policy + member agreement.
- The cadence triggers fire and bound replay cost.

**Testing:** Unit — snapshot verify-before-use; retain-history default; cadence triggers.

**Dependencies:** WS-S.5.4.

---

### WS-S.5.7 Local moderation overlays
**ID:** WS-S.5.7 | **Ref:** PRIVATE_SPEC §14.6, §19.1, §19.2

**Description:** Implement room-local moderator ops (contribution tombstone, thread restriction, member warning, member removal, media-hide recommendation, room-rule update, summary/steward note) — these are private-room operations, NOT platform moderation decisions — and per-member local-only overlays (`hidden_members`/`hidden_contributions`/`muted_threads`/`blocked_media`) that are not synced unless the user explicitly exports/imports their preferences.

**Acceptance criteria:**
- Room-local moderation ops are signed, capability-gated, and clearly distinguished from platform moderation.
- Local overlays stay device-local by default; sync only on explicit user export/import.
- A member can always leave, delete local data, hide/mute/block locally, and disable media auto-fetch.

**Testing:** Unit — moderation-op capability gate; overlay locality (no sync by default).

**Dependencies:** WS-S.5.2.

---

### WS-S.5.8 Local-only encrypted search
**ID:** WS-S.5.8 | **Ref:** PRIVATE_SPEC §13.7, §18.1, §25.7

**Description:** Implement local-only search over decrypted content in a worker: build incremental index shards (`title|body|citation|attachment_alt`), encrypt shards at rest (`PrivateLocalSearchShardPlainV1`), rebuild on schema upgrade or snapshot-verification failure. Server full-text/embeddings/query-logs/suggestions are FORBIDDEN (§18.1). Cross-member search-index sync is not required; same-member cross-device shard sync MAY be supported but must not leak metadata.

**Acceptance criteria:**
- Search runs entirely locally over decrypted content; index shards are encrypted at rest.
- No server search/index/embedding/query path is reachable from a private room.
- Local sorting (unread/recent/pinned/thread-state/filters) is explainable and creates no global distribution signal (§18.2).

**Testing:** Unit — local index build/query; encrypted-at-rest assertion; no-server-search assertion.

**Dependencies:** WS-S.5.4.

---

## WS-S.6 P2P sync and rendezvous

### WS-S.6.1 Blind rendezvous (derivation + records + authz + metadata)
**ID:** WS-S.6.1 | **Ref:** PRIVATE_SPEC §15.2, §15.3, §15.3.1, §15.3.2

**Description:** Implement blind rendezvous: `room_blind_id = HMAC(rendezvous_key, canonical(["room", epoch, time_bucket]))`, `peer_blind_id = HMAC(rendezvous_key, canonical(["peer", device_id, epoch, time_bucket]))` (inputs canonical-encoded, never `||`). Knowledge of `rendezvous_key` IS the rendezvous capability (only current-epoch members can derive/poll; removed members lose it at the next epoch). Implement the §15.3.2 metadata mitigations: coarse time buckets, per-peer announcement jitter, optional cover traffic for high-risk rooms, and the choice of `member_rendezvous`/`manual` discovery to avoid Licio seeing even approximate size.

**Acceptance criteria:**
- Only current-epoch members can compute a room's blind id; a removed member cannot after rotation.
- Polling an unknown blind id is not a room-existence oracle for outsiders.
- The residual-metadata mitigations (buckets/jitter/cover/member-rendezvous) are implemented and documented.

**Testing:** Unit — blind-id derivation determinism + member-only; removed-member-loses-access; no-existence-oracle property.

**Dependencies:** WS-S.3.2.

---

### WS-S.6.2 Encrypted WebRTC signaling + relay-only mode
**ID:** WS-S.6.2 | **Ref:** PRIVATE_SPEC §15.4

**Description:** Implement WebRTC signaling where messages are E2E-encrypted before reaching the server (the server routes only opaque `EncryptedSignal` blobs: room/sender/recipient blind ids + ciphertext + expiry). Implement relay-only transport mode so members who do not want to reveal IP addresses to one another route through relays; ICE candidates (which reveal network info) are suppressed in relay-only mode.

**Acceptance criteria:**
- Signaling payloads are E2E-encrypted; the server routes opaque blobs and cannot read SDP/ICE.
- Relay-only mode hides peer IPs from other members; direct mode is opt-in per room policy.
- Signaling is bound to room/epoch to prevent cross-room confusion.

**Testing:** Unit — signal encryption (server sees ciphertext only); relay-only IP suppression. Gated — two peers connect via encrypted signaling.

**Dependencies:** WS-S.6.1.

---

### WS-S.6.3 Membership-proving handshake
**ID:** WS-S.6.3 | **Ref:** PRIVATE_SPEC §15.5

**Description:** Implement the private libp2p handshake: transport connect → exchange protocol version + ephemeral peer keys → each peer proves membership by signing a challenge with a room-valid device key → derive a pairwise session key from current epoch material + ephemeral ECDH → exchange encrypted head summaries → request missing blocks. The transcript MUST be bound to room-id commitment, epoch, protocol version, and peer ephemeral keys to prevent replay/cross-room confusion.

**Acceptance criteria:**
- A peer that cannot sign a challenge with a current-epoch device key is rejected before any block exchange.
- The pairwise session key is fresh per connection (ephemeral ECDH) and epoch-bound.
- The transcript binding defeats replay and cross-room confusion.

**Testing:** Unit/gated — member handshake succeeds, non-member fails; transcript-binding replay rejection.

**Dependencies:** WS-S.3.5, WS-S.6.1.

---

### WS-S.6.4 Head announcement + missing-block protocol + sync priority
**ID:** WS-S.6.4 | **Ref:** PRIVATE_SPEC §15.6, §15.7, §15.8

**Description:** Implement the encrypted `HeadAnnouncementPlainV1` (known heads, latest snapshot, op-count bucket, want-ranges) on the pairwise channel (never to the main server); the `BlockRequestV1`/`BlockResponseV1` protocol (priority `manifest|ops|thread|media|snapshot`, max-bytes, refuse-large/backoff) with every returned block verified by CID+signature+AEAD; and the §15.8 fetch order (manifest → membership/capabilities → heads/ancestors → thread/story index → visible text → summaries → media manifests → media chunks on demand → archives/snapshots).

**Acceptance criteria:**
- Head announcements are encrypted and peer-only; the main server never sees heads.
- Block responses are verified before use; peers may refuse/throttle large requests.
- The fetch order delivers a usable thread list before media; media is lazy.

**Testing:** Unit — head-exchange + missing-ancestor fetch; verify-before-use; fetch-order priority.

**Dependencies:** WS-S.6.3, WS-S.5.3.

---

### WS-S.6.5 Offline CAR exchange (+ optional LCAP bundle)
**ID:** WS-S.6.5 | **Ref:** PRIVATE_SPEC §15.9

**Description:** Implement encrypted CAR export/import (export selected encrypted blocks → CAR → share via USB/AirDrop/manual → import → verify → reduce). The container MAY be a standard IPLD CAR or the WS-R LCAP `.licio-bundle` pack (streaming parse under caps, dependency-first ordering, range resume, quarantine-before-render). CAR exports contain **ciphertext only**; the importer re-runs the full WS-S.5.3 validation before any block renders. Export UI distinguishes encrypted member backup / decrypted personal archive / voluntary report package.

**Acceptance criteria:**
- CAR/bundle exports are ciphertext-only; import re-validates every block (no container-conferred trust).
- The three export kinds are clearly distinguished; decrypted export carries a strong warning.
- The optional LCAP-bundle path interoperates with WS-R's reader and is gated to ciphertext for private rooms.

**Testing:** Unit — CAR/bundle export/import round-trip; ciphertext-only assertion; re-validation-on-import.

**Dependencies:** WS-S.5.3 (optional: WS-R.4.2).

---

### WS-S.6.6 Server rendezvous endpoints + abuse controls
**ID:** WS-S.6.6 | **Ref:** PRIVATE_SPEC §21.5, §27.2

**Description:** Implement `POST /v1/private-rendezvous/announce|poll|signal` with opaque payloads only (blind ids + ciphertext + short TTL); limits: short TTL, bounded payload size, blind-ID rate limiting, aggregate-only abuse metrics (no room identity), no content inspection, no long-term storage. Rate limiting keys on a non-reversible account reference or account-scoped blind token, never an IP (Section 19.1). Optional proof-of-work/account-scoped tokens if abuse warrants.

**Acceptance criteria:**
- Endpoints accept only opaque blobs; the server cannot map a record to room/content/members/CIDs for unlisted/detached rooms.
- TTL/size/rate limits are enforced; metrics are aggregate-only and unlinkable to room identity.
- Rate limiting reads no client IP; records auto-expire and are deleted.

**Testing:** Gated integration — opaque-only enforcement; TTL/size/rate limits; aggregate-only-metrics assertion; no-IP-read assertion.

**Dependencies:** WS-S.1.2, WS-S.6.1.

---

## WS-S.7 Private room UI

### WS-S.7.1 Creation wizard + mandatory disclosures
**ID:** WS-S.7.1 | **Ref:** PRIVATE_SPEC §12.1, §20.2; Appendix A

**Description:** Implement `PrivateRoomCreate.tsx` running the §12.1 / Appendix A sequence: show + require the §6 disclosure and the five acknowledgments (WS-S.0.3); verify the private-mode bundle signature/hash (WS-S.10.2) BEFORE generating keys; generate device signing + HPKE keys; create the MLS group; derive epoch-0 secrets; create the encrypted manifest + first membership op; store encrypted blocks locally; optionally create the server stub (no content/CIDs/heads); start blind rendezvous if policy allows; render from local reducer state. Creation fields: name, directory mode (unlisted default), transport mode (relay-preferred default), replication target, allow-blind-push (off default), require-admin-approval (on default), recovery-kit (now/later).

**Acceptance criteria:**
- Creation is blocked until acknowledgments are checked AND the bundle is verified; the server never receives manifest plaintext/member list/op heads.
- Defaults match §20.2 (unlisted, relay-preferred, blind-push off, admin-approval on).
- The room opens from local reducer state immediately after local creation.

**Testing:** E2E (Playwright + axe) — full creation flow incl. acknowledgment gating + bundle-verify gate; no-server-content request assertion.

**Dependencies:** WS-S.5.4, WS-S.3.6, WS-S.10.2.

---

### WS-S.7.2 Room shell + header status + trust indicators
**ID:** WS-S.7.2 | **Ref:** PRIVATE_SPEC §19.5, §20.3

**Description:** Implement `PrivateRoomShell.tsx` with the compact §20.3 header status ("Private P2P · Unlisted · Relay preferred · 3/3 replicas · Backup created · Safety number verified") expandable to detail, and the §19.5 trust indicators (verified/unverified member devices, recent membership changes, room-safety-number-changed warning, update-channel trust state, replication/backup health, transport mode, blind-push state). The shell renders from local decrypted reducer state, never from `/v1/stories|threads|contributions`.

**Acceptance criteria:**
- The header shows the honest compact status; all §19.5 indicators are present and expandable.
- The shell never calls server content endpoints for a p2p room; it reads local reducer state.
- A changed safety number surfaces a clear warning.

**Testing:** Unit — status/indicator rendering from reducer state. E2E (axe) — shell accessibility + no server-content fetch.

**Dependencies:** WS-S.5.4, WS-S.7.4.

---

### WS-S.7.3 Composer + thread view (local reducer state)
**ID:** WS-S.7.3 | **Ref:** PRIVATE_SPEC §13, §18.2; WS-G composer

**Description:** Implement `PrivateComposer.tsx` and `PrivateThreadView.tsx` reusing the WS-G 11-mode structured-composer UX but producing **signed encrypted ops** into the local log (not server contributions). Thread view renders contribution trees from the reducer with local-only sorting (unread/recent/pinned/thread-state/filters, §18.2) — explainable, creating no global distribution signal. UGC bodies pass through the existing `licio-ugc` DOMPurify/Trusted Types sink.

**Acceptance criteria:**
- Posting creates a signed encrypted op locally; nothing hits server content endpoints.
- Thread rendering is deterministic from the reducer; local sorting is explainable and non-global.
- UGC is sanitized through the single sanctioned sink (no new `dangerouslySetInnerHTML`).

**Testing:** Unit — op creation from composer; local-sort determinism. E2E (axe) — compose/post/reply + UGC sanitization.

**Dependencies:** WS-S.5.2, WS-S.7.2.

---

### WS-S.7.4 Invite + member panels + safety-number verification
**ID:** WS-S.7.4 | **Ref:** PRIVATE_SPEC §11.5, §12.2, §20.4; Appendix B

**Description:** Implement `PrivateInvitePanel.tsx` (role granted, expiration, max uses, approval requirement, paste-warning, copy/QR/export, revoke) and `PrivateMemberPanel.tsx` with §11.5 safety-number verification (`room_safety_number = HASH(room_public_key || mls_epoch_authenticator || sorted(active_device_public_keys) || manifest_policy_hash)`) comparable via QR/short-authentication-string out of band. Drive the Appendix B invite sequence (sealed-fragment invite → join request → MLS Add → Welcome → sync).

**Acceptance criteria:**
- Invites show role/expiry/uses/approval + a not-in-public warning; revoke works; the secret stays in the URL fragment.
- Safety-number compare (QR/SAS) shows verified/changed/unverified; a changed number warns prominently.
- The full invite→join→Add→Welcome→verify flow completes across two clients.

**Testing:** E2E (Playwright + axe) — invite/join/verify across two contexts; revoke; safety-number-changed warning.

**Dependencies:** WS-S.3.4, WS-S.5.1.

---

### WS-S.7.5 Replication/backup health + update-trust UX
**ID:** WS-S.7.5 | **Ref:** PRIVATE_SPEC §16.3, §16.4, §20.6

**Description:** Implement `PrivateReplicationHealth.tsx` + `PrivateBackupPanel.tsx` showing the §16.4 replication health ("2/3 recommended copies online recently", last full sync, missing blocks by class, backup state, transport mode) against the §16.3 replication targets, without exposing exact peer identities unless the user opens a detail panel. Implement the §20.6 update-trust lock UX: if the private-mode bundle is unsigned / not in the transparency log / hash-mismatched, private rooms lock with the exact §20.6 message and keys are NOT unlocked.

**Acceptance criteria:**
- Replication/backup health is honest and per-class; peer identities are hidden by default.
- An unverified bundle locks private rooms with the §20.6 copy before any key unlock.
- Backup-not-created and low-replica states prompt clearly.

**Testing:** Unit — health rendering vs targets; lock-on-unverified-bundle. E2E (axe) — health panel + lock screen.

**Dependencies:** WS-S.7.2, WS-S.10.2.

---

## WS-S.8 Media and attachments

### WS-S.8.1 Local media pipeline (sniff / strip / chunk / encrypt / manifest)
**ID:** WS-S.8.1 | **Ref:** PRIVATE_SPEC §17.1, §17.2, §13.6

**Description:** Implement the local-only media pipeline in a worker (no server scan gate / object storage): file selection → local MIME sniff + size checks → local metadata stripping (reuse the WS-G byte-level EXIF stripper + video container neutralization) → optional local thumbnail/poster → required alt text (image) / captions (video) → chunk → encrypt (WS-S.3.3, per-chunk) → encrypted `PrivateAttachmentManifestPlainV1` → P2P block sync. If a type cannot be safely stripped, show the §17.2 warning.

**Acceptance criteria:**
- Media is stripped + chunked + encrypted locally; no server upload/scan endpoint is touched.
- The attachment manifest carries encrypted-chunk CIDs + plaintext/ciphertext hashes + a `metadata_stripped` flag + size class (exact small sizes hidden via padding).
- Unstrippable types warn the user before send.

**Testing:** Unit — sniff/strip/chunk/encrypt/manifest; no-server-call assertion; padding hides small exact sizes.

**Dependencies:** WS-S.3.3, WS-S.5.2.

---

### WS-S.8.2 Encrypted streaming (range chunks, MediaSource)
**ID:** WS-S.8.2 | **Ref:** PRIVATE_SPEC §17.4, §25.8

**Description:** Implement lazy encrypted streaming: media manifest → chunk index → fetch encrypted chunks lazily → decrypt locally → stream to a media element via MediaSource where supported, prefetching only the next few chunks (never auto-fetching full large videos). Support pause/resume. Deduplicate identical encrypted chunks only within the same object (never convergent cross-user dedup, §25.8).

**Acceptance criteria:**
- Large media streams chunk-by-chunk with bounded prefetch; full videos are not auto-fetched.
- Decryption is local; pause/resume works; no autoplay.
- Cross-object/cross-user convergent dedup is not used (no equality leakage).

**Testing:** Unit — lazy chunk fetch + bounded prefetch; no-autoplay; no-convergent-dedup assertion. E2E — stream play/pause/resume.

**Dependencies:** WS-S.8.1.

---

### WS-S.8.3 Local media safety controls + accessibility
**ID:** WS-S.8.3 | **Ref:** PRIVATE_SPEC §17.3, §17.5

**Description:** Implement the §17.3 local controls (never auto-download large media; blur unknown media by default; hide media from unverified members; block file types locally; per-member media mute; report/export package for selected media; optional client-side perceptual-hash warning against the user's own blocked library — no server lookup) and the §17.5 accessibility (required alt text for image posts; captions for video via encrypted caption attachments/inline text — alt/captions are private content, encrypted like everything else).

**Acceptance criteria:**
- All local media controls function without any server scan/lookup; the perceptual-hash check is local-only.
- Image posts require alt text; video supports captions; both are encrypted.
- Unverified-member media is hidden/blurred per the user's settings.

**Testing:** Unit — each control; alt-required/caption-support; local-only perceptual hash. E2E (axe) — media a11y.

**Dependencies:** WS-S.8.1.

---

## WS-S.9 Migration from existing server-private rooms

### WS-S.9.1 Restricted-room disclosure + rename (Phase 1)
**ID:** WS-S.9.1 | **Ref:** PRIVATE_SPEC §24.1, §24.2 (Phase 1)

**Description:** Implement Phase 1: rename existing server "private"/restricted rooms in UI to "Members-only server room" with the explanation "visible only to members in the app, but hosted on Licio servers." Establish the core migration rule: existing server-hosted rooms cannot be silently upgraded into real private rooms — their history already existed on the server; migration creates a NEW P2P room and optionally imports history through a member's client.

**Acceptance criteria:**
- All restricted rooms are relabelled and explained; none implies E2EE.
- The "no silent upgrade" rule is enforced — there is no in-place "make private" toggle that pretends to retroactively protect history.

**Testing:** Unit — relabel copy + no-in-place-upgrade guard. E2E (axe) — restricted-room info surface.

**Dependencies:** WS-S.0.2.

---

### WS-S.9.2 Migration wizard + import modes (Phases 2-4)
**ID:** WS-S.9.2 | **Ref:** PRIVATE_SPEC §24.2 (Phases 2-4), §24.3

**Description:** Implement the migration wizard: create the P2P destination (keys/manifest local; server stores only a stub if unlisted/listed); choose an import mode (Fresh start / Selected import / Full import / Redacted import) with the §24.3 disclosure that imported history was previously server-hosted and migration cannot make past server access impossible; re-invite members through P2P invites (server subscriptions do not grant P2P access).

**Acceptance criteria:**
- The wizard creates a P2P room locally + an optional stub; the four import modes work and disclose their leakage honestly.
- Members are re-invited via P2P; old server subscriptions confer no P2P access.
- The §24.3 "improves privacy from this point forward" copy is shown before any import.

**Testing:** Unit — import-mode behavior + disclosure. E2E — create-destination + selected-import + re-invite.

**Dependencies:** WS-S.7.1, WS-S.7.4.

---

### WS-S.9.3 Freeze + purge/minimize old server room (Phases 5-6)
**ID:** WS-S.9.3 | **Ref:** PRIVATE_SPEC §24.2 (Phases 5-6)

**Description:** Implement Phase 5 (old server room becomes read-only with a banner pointing to the P2P replacement) and Phase 6 (where policy/law permit, purge or minimize old server data — stories, threads, contributions, uploads, search docs, ranking candidates, content events, review queues, derived summaries, caches), disclosing any retained legal/audit records as server-retained historical artifacts (not private P2P content).

**Acceptance criteria:**
- The old room freezes read-only with a clear pointer; no new server content is accepted.
- Purge/minimize removes the enumerated server artifacts where permitted; retained legal/audit records are disclosed as such.
- Purge is reversible-safe (idempotent, audited) and does not touch member-held P2P content.

**Testing:** Gated integration — freeze + purge across the enumerated tables; retained-record disclosure. E2E — frozen-room banner.

**Dependencies:** WS-S.9.2.

---

## WS-S.10 Hardened trust and the update channel

### WS-S.10.1 Reproducible private-mode bundle + signed manifest
**ID:** WS-S.10.1 | **Ref:** PRIVATE_SPEC §1, §3.2; WS-O reproducible-build reuse

**Description:** Make the lazily code-split private-p2p chunk (WS-S.2.1) a **reproducible build** with a deterministic output hash, and produce a signed release manifest (maintainer signatures over the chunk hash) reusing the WS-O reproducible-build + provenance machinery. This is the well-bounded artifact the transparency log and SW pinning attest. Tier 1 protects against passive server-storage compromise + ordinary administration; this card is the foundation for the Tier 2/3 update-channel protections.

**Acceptance criteria:**
- The private-mode chunk builds reproducibly to a stable hash across environments; the manifest is signed by the required maintainers.
- The artifact boundary is exactly the private chunk (not the whole app), keeping attestation tractable.
- The Tier 1 limitation (no defense against malicious web update) is documented honestly in-product.

**Testing:** CI — reproducible-build hash stability; manifest signature verification.

**Dependencies:** WS-S.2.1.

---

### WS-S.10.2 Transparency log + SW update pinning + room lock
**ID:** WS-S.10.2 | **Ref:** PRIVATE_SPEC §20.6, §22.4, §27.5

**Description:** Implement the code-transparency log of signed private-mode bundle hashes and the service-worker update pinning that verifies the running private chunk against the pinned, signed, logged hash before unlocking room keys. If the bundle is unsigned / not in the log / hash-mismatched, private rooms LOCK before any key unlock with the §20.6 message; CSP/Trusted Types/no-dynamic-remote-code stay enforced. Add `check:private-bundle-transparency` to CI. On a verified-safe client after an incident, rotate room keys (§27.5).

**Acceptance criteria:**
- Room keys never unlock until the running private chunk matches a signed, transparency-logged hash.
- An unverified/mismatched bundle locks private rooms (keys stay sealed) with the exact §20.6 copy.
- The SW cannot silently load dynamic remote private code; `check:private-bundle-transparency` runs in CI.

**Testing:** Unit — verify-before-unlock; lock-on-mismatch. E2E — unsigned/mismatched bundle locks the room; CSP blocks inline/eval (WS-S.11.4).

**Dependencies:** WS-S.10.1.

---

### WS-S.10.3 Local key agent (Tier 3)
**ID:** WS-S.10.3 | **Ref:** PRIVATE_SPEC §10.8, §22.5, §30.3

**Description:** Specify and (scope-permitting) prototype the Tier 3 local key agent holding room keys **outside** the web origin, exposing `POST http://127.0.0.1:<random>/licio/private/{sign,decrypt-key,mls-commit,export-recovery}`. The agent authenticates the web origin, shows user approval for sensitive operations, and never exposes raw room keys to web JavaScript — the strongest defense against a malicious web update. v1-launch scope (full agent vs Tier 1/2 + documented limitation) is open question §30.3.

**Acceptance criteria:**
- The agent signs/decrypts/commits without ever returning raw keys to web JS; it authenticates the origin and prompts for sensitive ops.
- The web app degrades gracefully to Tier 1/2 when no agent is present.
- The v1 scope decision (agent vs documented Tier-1 limitation) is recorded in §30.3.

**Testing:** Unit/contract — agent API contract; no-raw-key-egress; origin auth. (Full E2E only if shipped in v1.)

**Dependencies:** WS-S.3.6, WS-S.10.2.

---

## WS-S.11 Audit, test plan, and launch

### WS-S.11.1 Unit + crypto-vector + fuzz suite
**ID:** WS-S.11.1 | **Ref:** PRIVATE_SPEC §26.1, §26.2

**Description:** Implement the §26.1/§26.2 suites: strict zod schema tests for every private type; canonical-encoding stability; KDF domain separation; nonce uniqueness; envelope encrypt/decrypt; signature verification; capability-validation matrix; reducer determinism; conflict resolution; snapshot verification; official HPKE + MLS vectors; differential canonical encodings; malformed-envelope/op fuzz; the "unauthorized ops never render" and "removed members cannot decrypt future epoch" properties.

**Acceptance criteria:**
- All listed unit/vector/property/fuzz tests pass; coverage meets the 80% gate for the workspace.
- Official HPKE and MLS vectors pass; nonce-uniqueness and removed-member-cannot-decrypt properties hold.

**Testing:** The suite itself (Vitest + property + fuzz).

**Dependencies:** WS-S.3.7, WS-S.5.5.

---

### WS-S.11.2 Network/privacy request-capture tests
**ID:** WS-S.11.2 | **Ref:** PRIVATE_SPEC §26.3

**Description:** Implement Playwright request-capture tests over the full flow (create room → invite → post story → comment → attach media → sync → remove member → create future content) asserting that NO outbound HTTP/WebSocket request contains a private title/body, private URL, private CID, op id, thread id, contribution id, member list, invite fragment, plaintext key, or exact room id for unlisted/detached rooms.

**Acceptance criteria:**
- Across the whole flow, no captured request carries any forbidden value; the assertion enumerates each.
- The test runs in CI (BFF-in-the-loop harness extension) and fails on any leak.

**Testing:** Playwright request-capture suite; CI wiring.

**Dependencies:** WS-S.7.4, WS-S.6.6, WS-S.8.1.

---

### WS-S.11.3 Server DB no-content + P2P sync correctness tests
**ID:** WS-S.11.3 | **Ref:** PRIVATE_SPEC §26.4, §26.5; Appendix D

**Description:** Implement the §26.4 DB assertions (after P2P activity: stories/threads/event-payload/search/ranking-candidates all 0 for the room — Appendix D `assertNoP2PServerContent`) and the §26.5 sync-correctness matrix (two peers online; offline edits on both → conflict merge; missing-parent fetch; media partial fetch; snapshot restore; CAR export/import; relay-only mode; rendezvous unavailable; malicious peer sends invalid op / wrong block for CID / replays old epoch op; removed peer attempts sync).

**Acceptance criteria:**
- The DB assertion proves zero private content rows after a full E2E run.
- Every sync-correctness scenario passes, including each malicious-peer case (rejected, not rendered) and removed-peer (cannot sync future).
- Conflict merges are deterministic and identical across the two peers.

**Testing:** Gated integration (Postgres) — Appendix D assertion; multi-peer sync simulation suite.

**Dependencies:** WS-S.1.5, WS-S.6.4, WS-S.5.5.

---

### WS-S.11.4 Update-channel tests
**ID:** WS-S.11.4 | **Ref:** PRIVATE_SPEC §26.6

**Description:** Implement the §26.6 update-channel tests: an unsigned private-mode bundle locks the room; a transparency-log mismatch locks the room; the service worker cannot silently load dynamic remote private code; CSP blocks inline/eval paths; private keys are not unlocked before bundle verification; the local key agent refuses an unverified origin/bundle.

**Acceptance criteria:**
- Each scenario produces the correct lock/refusal; keys never unlock before verification.
- CSP/Trusted-Types/no-dynamic-code enforcement is asserted; the SW pinning is exercised.

**Testing:** E2E + unit — lock-on-unsigned/mismatch; CSP-blocks-eval; key-agent-refuses-unverified.

**Dependencies:** WS-S.10.2, WS-S.10.3.

---

### WS-S.11.5 Incident runbooks + operational controls
**ID:** WS-S.11.5 | **Ref:** PRIVATE_SPEC §27

**Description:** Author the §27 operational controls + incident runbooks: the allowed/forbidden operational-log lists (§27.1); rendezvous abuse controls (§27.2); and the three incident playbooks — leaked invite (revoke capability, rotate epoch if used, review members, show changes since invite; server may rate-limit invite spam / delist a stub but cannot remove private members), compromised device (remove device, rotate epoch, new recovery kit, mark compromised, optionally tombstone suspicious ops; disclose that content already on the device may be exposed), and malicious client update (transparency log detects/prevents, rooms lock before unlock, signed incident notice, rotate keys after a verified-safe client, encourage local key agent).

**Acceptance criteria:**
- The allowed/forbidden log lists are codified and enforced by `check:no-private-cid-egress`.
- Each incident playbook has concrete user + server actions and honest disclosure copy.
- Support runbooks never promise impossible recovery/moderation.

**Testing:** Doc review gate + `check:no-private-cid-egress`; a tabletop incident-drill checklist (§26.7).

**Dependencies:** WS-S.1.5, WS-S.3.6.

---

### WS-S.11.6 External audits, launch checklist, docs/index/version
**ID:** WS-S.11.6 | **Ref:** PRIVATE_SPEC §26.7, §29; Documentation rules (CLAUDE.md)

**Description:** Gate launch on the §26.7 manual review (external cryptography review; browser storage/key-management review; rendezvous metadata review; red-team malicious-server-update; malicious-member scenario; leaked-invite + compromised-device drills; recovery-warning usability study) and the §29 launch checklist (product/UX, server non-storage, crypto, P2P/IPFS, trust/update-channel, safety). In the same change set, add `docs/private-p2p/README.md`, register WS-S in `docs/planning/00-index.md`, update the `CLAUDE.md`/`AGENTS.md` roadmap row (byte-identical), and bump the root `package.json` PATCH version. No `claude.ai/code/session_*` URL in any doc or PR body.

**Acceptance criteria:**
- Every §29 launch-checklist item is satisfied or explicitly waived with rationale; the external audits are complete and tracked.
- The master index lists WS-S; `CLAUDE.md ≡ AGENTS.md` (empty `diff`); version bumped; no session URL anywhere.
- No support doc promises impossible recovery/moderation.

**Testing:** `pnpm check:policy`; CLAUDE.md ≡ AGENTS.md assertion; the §29 checklist sign-off.

**Dependencies:** all WS-S implementation cards (lands with them).

---

## Dependency graph (within WS-S)

```
S.0.1 ─ S.0.2 ─ S.0.3
S.0.1 ─ S.1.1 ─┬─ S.1.2 ─┐
               ├─ S.1.3  ├─ S.1.5            (server non-storage gates)
               └─ S.1.4 ─┘
S.2.1 ─ S.2.2 ─ S.2.3
S.2.3 ─ S.3.1 ─ S.3.2 ─ S.3.3 ; S.3.1 ─ S.3.4 ; S.2.2 ─ S.3.5 ; S.3.1/3.5 ─ S.3.6 ; S.3.3/3.4/3.5 ─ S.3.7
S.2.1 ─ S.4.1 ─ S.4.2 ─ S.4.4 ; S.4.1 + S.6.3 ─ S.4.3
S.2.3/S.3.1 ─ S.5.1 ─ S.5.2 ─ S.5.3 ─ S.5.4 ─┬─ S.5.5 ─ S.5.6
                                              ├─ S.5.7
                                              └─ S.5.8
S.3.2 ─ S.6.1 ─┬─ S.6.2 ; S.3.5/S.6.1 ─ S.6.3 ─ S.6.4 ; S.5.3 ─ S.6.5 ; S.1.2/S.6.1 ─ S.6.6
S.5.4/S.3.6/S.10.2 ─ S.7.1 ; S.7.4 ─ S.7.2 ─ S.7.3 ; S.3.4/S.5.1 ─ S.7.4 ; S.7.2/S.10.2 ─ S.7.5
S.3.3/S.5.2 ─ S.8.1 ─ S.8.2 ; S.8.1 ─ S.8.3
S.0.2 ─ S.9.1 ; S.7.1/S.7.4 ─ S.9.2 ─ S.9.3
S.2.1 ─ S.10.1 ─ S.10.2 ─ S.10.3
S.3.7/S.5.5 ─ S.11.1 ; S.7.4/S.6.6/S.8.1 ─ S.11.2 ; S.1.5/S.6.4 ─ S.11.3 ; S.10.2/S.10.3 ─ S.11.4 ; S.1.5/S.3.6 ─ S.11.5 ; (all) ─ S.11.6
```

Cross-stream order: **S.0** (model/terminology) and **S.1** (server non-storage gates — landable immediately, independent of the crypto/P2P stack) come first; **S.2** (schemas/canonical) gates **S.3** (crypto) and **S.5** (ops/reducer); **S.4** (Helia/libp2p) and **S.6** (sync/rendezvous) build the transport on the crypto + reducer; **S.7** (UI) and **S.8** (media) ride the validated local state; **S.9** (migration) follows the UI; **S.10** (update channel) is foundational for **S.7.1**'s create-time bundle gate and lands alongside the UI; **S.11** (audit/tests/launch) runs continuously and gates the close. **S.1 can ship and harden well before the rest of WS-S** — defensive server gates first, so a partially-built P2P client can never accidentally write server content.

## Milestone gate additions

| Gate | Cards | Requirement |
|---|---|---|
| Server non-storage | S.1.3, S.1.4, S.1.5 | P2P rooms cannot create server stories/contributions/uploads, never enter ranking/search, emit no content events; DB assertion proves zero rows after E2E. |
| Encrypt-before-CID | S.4.2, S.4.4 | Every private CID is over ciphertext; no plaintext CID; public-gateway URL construction for a private CID is unreachable. |
| Group-key authority | S.3.1, S.5.1 | MLS add/remove rotates the epoch; no platform role authorizes any private-room op; removed devices cannot decrypt future epochs. |
| Canonical determinism | S.2.2, S.5.4 | One DAG-CBOR profile pins AAD/signatures/CIDs/reducer; reducer output is byte-identical across shuffled delivery. |
| AAD/nonce discipline | S.3.3, S.3.7 | AADs are canonical fixed-shape; fresh object key + nonce per object; nonce reuse is impossible (asserted). |
| No metadata egress | S.11.2 | No outbound request carries private title/body/URL/CID/op-id/thread-id/member-list/invite-fragment/key/exact-unlisted-room-id. |
| Update-channel trust | S.10.1, S.10.2 | Reproducible signed private bundle in a transparency log; keys never unlock on an unverified bundle; rooms lock. |
| Honest non-goals | S.0.3, S.7.5 | Creation/removal disclosures + Tier-1 limitation + replication/recovery honesty shown in-product. |
| Dependency budget | S.2.1 | Heavy P2P deps isolated to the workspace + lazy chunk; `apps/web` budget and initial-bundle gate unchanged. |
| Docs byte-identical | S.11.6 | CLAUDE.md ≡ AGENTS.md; README + index updated; version bumped; no session URL. |

## Definition of done (workstream)

- Private P2P rooms are a separate, end-to-end-encrypted storage/sync/trust/authority plane: room content/threads/comments/media/membership/search are encrypted on members' devices, and platform staff cannot read, alter, recover, moderate, add members to, or delete them.
- The server non-storage contract is enforced structurally — a column denylist on the stub/rendezvous tables, endpoint rejection guards, retriever/search predicates, an event-pipeline gate, and seven CI checks — and a post-E2E DB assertion proves zero private content rows; server logs exclude private CIDs/op-ids/invite-fragments/member-lists/titles/bodies/exact activity.
- Group keying is MLS, invite bootstrap is HPKE, signatures are Ed25519, and every key is derived from the per-epoch exporter via the labeled HKDF schedule; one MLS commit rotates all operational keys and removed devices cannot decrypt future epochs; no custom group crypto exists.
- Every private object is encrypt-before-content-address (CID over ciphertext), wrapped with a fresh per-object key + nonce under canonical fixed-shape AADs; the private Helia/libp2p profile disables all public DHT/gateway/delegated-routing/IPNI/reprovide, and a public-gateway URL for a private CID is unreachable at runtime and in CI.
- The deterministic Lamport-ordered reducer produces byte-identical state across devices regardless of delivery order; the op-validation pipeline quarantines (never renders) unauthorized/removed-device/missing-parent/unknown-schema ops; conflicts resolve by total order with full encrypted history retained.
- Blind rendezvous, encrypted signaling, the membership-proving handshake, head/block exchange, relay-only mode, and offline CAR/`.licio-bundle` import all carry ciphertext + opaque hints only; rendezvous is member-capability-gated, metadata-minimized, and not a room-existence oracle.
- The UI states every honest limit (members can copy; removal is not retroactive; availability depends on member devices; Licio cannot recover; Tier-1 does not stop a malicious web update); the update channel ships a reproducible, signed, transparency-logged private bundle and locks rooms before unlocking keys on any unverified build; an optional Tier-3 local key agent never exposes raw keys to web JS.
- Migration creates a NEW P2P room (never an in-place upgrade), discloses that imported history was server-hosted, re-invites members via P2P, freezes and minimizes the old server room, and never promises retroactive privacy.
- The unit/crypto-vector/fuzz, network request-capture, server-DB-no-content, multi-peer sync, and update-channel suites pass; external cryptography/storage/metadata/red-team reviews are complete; the §29 launch checklist is satisfied.
- `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm lint:security`, `pnpm check:deps`, `pnpm check:workspace-deps`, `pnpm check:no-applause`, `pnpm check:no-raw-egress`, the seven `check:*p2p*`/`check:*private*` gates, and `pnpm check:policy` all pass; the heavy P2P stack is isolated to the workspace + lazy chunk (core budget/bundle unchanged); docs are updated in the same change set and the PATCH version is bumped.

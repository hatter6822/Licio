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

The **entire WS-S.3 cryptographic foundation is shipped** on top of that
foundation (all in `packages/private-p2p/src/crypto/`): the §10.2 MLS group
keying + epoch→key-schedule bridge, the HKDF five-key schedule, the §10.5 two-
layer object AEAD, the §10.3 HPKE invite bootstrap, §10.7 Ed25519 device
signatures, the §10.8 four-tier key store + §12.6/§12.7 recovery kit, and the
§12.6.1 threshold recovery — every primitive a thin, **RFC-vector-pinned**
wrapper over WebCrypto (or, for MLS, an audited library behind a one-file
wrapper).  All of WS-S.3 (3.1–3.7) is complete.

The **§9.4 private content-addressing and the §14.3 deterministic reducer are
also shipped** (the maintainer-chosen lighter-transport path — no Helia): the
dependency-free CIDv1-over-ciphertext profile (`crypto/cid.ts`, WS-S.4.2) and
the operation-log reducer (`reducer/`, WS-S.5.1–5.5) — the Lamport clock +
canonical total order, the room/capability state, the pure authority-enforcing
fold + §14.4 conflict policy, and the structural §14.2 pre-pass — with the
§14.3.3/§26.1 byte-identical-across-shuffles determinism property pinned.

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
| **WS-S.1.3b** | The §8.3 **database guard** — the deepest, code-path-independent defense below the service-layer 409/404: a `BEFORE INSERT OR UPDATE` trigger on EVERY room-referencing table EXCEPT the §8.2 stub/rendezvous (`stories` + `threads` — the content roots, transitively covering contributions/uploads/summaries — plus the non-content `room_stewards` / `room_subscriptions` / `lenses`, which a room-keys-only p2p room can never have) rejects any row whose `room_id` resolves to `storage_mode = 'p2p'` (`check_violation`, message names the table + room); a server room is unaffected. Mirrors the `enforce_thread_room_consistency` pattern (0018). Migration `0045` (additive, trigger-only). Gated harness proves it bites on all five tables (and that server rows succeed) + that the 0043 coherence CHECKs reject each incoherent axis tuple by name | `packages/db/drizzle/0045_*.sql`, `packages/db/src/__tests__/migration-harness.test.ts` |
| **WS-S.1.4** | Every ranking retriever (the global predicate + the room-surface scoper) predicates `roomStorageMode === 'server'`; server search (in-memory + the Drizzle SQL `storage_mode = 'server'` join) excludes p2p docs; the event router refuses to publish any content event referencing a p2p room (`p2pRoomEventsRejected` counter), wired by the forum boot | `apps/api/src/ranking/{retrievers,services}.ts`, `apps/api/src/ingestion/{search,services,drizzle-ingestion-stores}.ts`, `apps/api/src/events/router.ts`, `apps/api/src/forum/services.ts` |
| **WS-S.1.5** | The seven §23.10 CI gates: `check:no-p2p-server-content` (umbrella), `check:no-private-cid-egress` (public-gateway scan), `check:private-rendezvous-schema` (column denylist), `check:private-bundle-transparency` (no dynamic remote code), `check:p2p-endpoint-rejections`, `check:p2p-ranking-exclusion`, `check:p2p-search-exclusion` — proven to BITE on injected fixtures. `check:no-applause`/`check:no-raw-egress` extended over `packages/private-p2p` | `scripts/private-p2p-gates.ts` + the seven `scripts/check-*.ts`, `.github/workflows/ci.yml` |

### WS-S.2 — Private schemas and canonical encoding

| Card | What shipped | Where |
|---|---|---|
| **WS-S.2.1** | The `@licio/private-p2p` workspace scaffold (TS strict, SPDX, depends on `@licio/shared` only) + the gate registrations: `scripts/check-workspace-deps.ts` (all four maps; allowed deps `['@licio/shared']`), root `tsconfig.json`/`vitest.config.ts`, and the **dedicated private-chunk bundle budget** in `scripts/check-bundle-size.ts` (the lazy private chunk is measured against its own ceiling, excluded from the core 320 KiB total) | `packages/private-p2p/`, `scripts/check-{workspace-deps,bundle-size}.ts` |
| **WS-S.2.2** | `canonical(...)` / `decodeCanonical(...)` — the ONE DAG-CBOR deterministic profile (RFC 8949 §4.2.1; matches LCAP's LDC rules but a separate zero-dependency impl): shortest-form integers, definite-length only, bytewise-encoded-key map order, optional-omit, UTF-8/NFC, fail-closed reject matrix + §27 resource caps. The encoder **fails closed on any exotic object** (`Date`/`Map`/`Set`/`RegExp`/typed arrays/class instances — non-plain protos): they have an empty `Object.keys`, so a permissive path would silently encode them as an EMPTY MAP — a forgery/collision vector for a signed/hashed structure — and the schemas carry `z.unknown()` fields (`submission_metadata`, `location_scope`, `metadata`, `terms`) that reach `canonical`. Pinned by the P1/P2/P3 determinism + integer-boundary + bomb-abort + exotic-object suite | `packages/private-p2p/src/crypto/canonical.ts` |
| **WS-S.2.3** | Every strict (`.strict()`) private schema: the §10.4 `PrivateEncryptedEnvelopeV1` (EXTENDED with `capability_root_at_seq`/`chunk_index`/`chunk_total` so a verifier reconstructs both §10.5 AADs entirely from the envelope — `BODY_AAD_ENVELOPE_FIELDS`/`WRAP_AAD_ENVELOPE_FIELDS` are the single source); the §13.1 manifest; the §13.2 op envelope + all op bodies (membership/role/story/thread/contribution/summary/attachment/snapshot/recovery); the §10.3 invite + §12.3 join; the §13.6 attachment manifest; the §13.7 search shard; the §19.4 report package. Every binary field is bounded for §27 DoS: small fields (nonce/sig/key/commitment) ≤ 16 KiB, an inline ciphertext body ≤ ~1 MiB (`ciphertextBase64Schema` — a padded op body exceeds the small bound), the Lamport decimal-string ≤ 40 digits. **Contribution ops reuse the shipped WS-G constants** (`CONTRIBUTION_BODY_LIMITS` incl. the edit-op `.comment` cap, `MAX_CITATIONS`, `citationSchema`, the type/thread enums) so the typed rules cannot drift | `packages/private-p2p/src/schemas/` |

### WS-S.3 — Cryptographic foundation

Every primitive is a thin, **vector-pinned** wrapper over WebCrypto (§10.1
principle 10), so correctness is proven against official RFC test vectors rather
than trusted blindly.  All in `packages/private-p2p/src/crypto/`.

| Card | What shipped | Where |
|---|---|---|
| **WS-S.3.1a** | The minimal reviewed MLS wrapper over `ts-mls` (RFC 9420): `createGroup`/`generateMemberKeyPackage`/`addMember`/`removeMember`/`commitProposals`/`processWelcome`/`currentEpoch`/`epochAuthenticator` + group-state (de)serialization.  The cipher suite is PINNED to `MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519` (suite 1) — a module-load assertion fails closed on registry drift, never a runtime default.  The `check:p2p-mls-wrapper` gate forbids a deep `ts-mls` import anywhere else (proven to bite), keeping the library swappable | `crypto/mls.ts`, `scripts/check-mls-wrapper.ts` |
| **WS-S.3.1b** | The epoch bridge: `room_epoch_secret = MLS-Exporter("licio.private-room.v1.epoch", canonical([room_id_commitment, epoch, manifest_commitment]), 32)` → the §10.2 five-key schedule.  `deriveEpochState` is a pure function of the current epoch, so a commit rotates all five keys atomically (§10.9); a forked manifest yields a different secret (cross-fork content unreadable) | `crypto/epoch.ts` |
| **WS-S.3.2** | `HKDF-Expand` (RFC 5869 over WebCrypto HMAC) + the TLS-1.3/MLS `HKDF-Expand-Label` + the five per-purpose room keys (`content_wrap`/`sync_topic`/`rendezvous`/`snapshot`/`report`).  Pinned by the RFC 5869 Appendix-A vectors (incl. the empty-salt case HPKE needs) | `crypto/hkdf.ts` |
| **WS-S.3.3a/b** | The §10.5 two-layer object AEAD (AES-256-GCM): the per-object body seal under the canonical `body_aad`, the object-key wrap under the epoch `content_wrap_key` with the canonical `wrap_aad` (the `wrapping_epoch`-bound replay defense), §25.4 size-bucket padding, and the §10.6 pad-not-compress rule | `crypto/aead.ts` |
| **WS-S.3.4** | HPKE base-mode invite bootstrap (RFC 9180 suite A.1, DHKEM(X25519,HKDF-SHA256)/HKDF-SHA256/AES-128-GCM), URL-fragment-only invites.  Hand-rolled over WebCrypto X25519 + HKDF + AES-GCM; `openBase` pinned against an `@hpke/core`-sealed ciphertext (cross-implementation conformance); X25519 DH pinned to RFC 7748 §6.1 | `crypto/hpke.ts` |
| **WS-S.3.5** | Ed25519 device signatures over the canonical envelope (§10.7), WebCrypto-native, room/epoch-scoped.  Pinned by KATs cross-validated against `@noble/curves` (an independent RFC 8032 impl — byte-identical deterministic output) | `crypto/signatures.ts` |
| **WS-S.3.6a** | The §10.8 four-tier local key store for a room's `RoomKeyMaterial`: (1) Argon2id-passphrase (OWASP-2024 params), (2) WebCrypto non-extractable wrap, (3) passkey PRF, (4) local-key-agent (no local secret).  Material bound to room id + tier via the AEAD AAD; `assertTierAllowedForRoom` enforces the high-risk-tier rule.  At-rest crypto only; the IndexedDB persistence is the client's concern (WS-S.7) | `crypto/key-store.ts` |
| **WS-S.3.6b** | The portable, passphrase-bound recovery kit (stronger Argon2id) that re-derives access on a new device with NO platform involvement (`importRecoveryKit` is pure — no `fetch`).  §12.7 terminality: the `check:no-p2p-server-content` umbrella now forbids any server-side private-room recovery endpoint (`scanNoServerRoomRecovery`, scoped so WS-D account recovery is never flagged) | `crypto/recovery.ts`, `scripts/private-p2p-gates.ts` |
| **WS-S.3.6c** | §12.6.1 capability-based threshold recovery: `evaluateRecoveryThreshold` counts DISTINCT recover-capable admins (not devices) who signed `recovery.authorize` ops — M-of-N, room-configured.  NOT secret-sharing (the op carries only ids; a smuggled key field is `.strict()`-rejected); a successful recovery is an ordinary `member.add` = MLS Add + epoch rotation | `reducer/recovery-threshold.ts` |
| **WS-S.3.7** | The crypto property + fuzz suite: the full two-AEAD pipeline, the §10.9 forward-secrecy property (a removed member cannot decrypt a future epoch), nonce/object-key uniqueness across generated workloads, and fail-closed fuzz of every open/decode path | `__tests__/crypto-properties.test.ts` |

### WS-S.4.2 / WS-S.5 — Content-addressing + the deterministic reducer

The maintainer-chosen **lighter-transport path**: the §9.4 content-addressing and
the §14.3 reducer ship dependency-free (no Helia); the membership-gated block
exchange will ride the existing `@licio/lcap-p2p` WebRTC carrier (WS-S.6).

| Card | What shipped | Where |
|---|---|---|
| **WS-S.4.2** | The §9.4 CIDv1-over-ciphertext profile (CIDv1 / base32 / sha2-256; dag-cbor `0x71` for metadata, raw `0x55` for media chunks), hand-rolled to avoid the multiformats/Helia tree.  A private CID is ALWAYS over ciphertext (§9.1).  Pinned byte-for-byte to `multiformats`-generated CIDs + RFC 4648 §10 base32 vectors | `crypto/cid.ts` |
| **WS-S.5.4a** | The Lamport clock (decimal strings, exact beyond 2^53) + the §14.3.2 canonical total order `(lamport, created_at_bucket, author_device_id, op_id)` + the §14.3.1 causality rule | `reducer/order.ts` |
| **WS-S.5.1** | The §11.3 capability model (room capabilities, never a platform role, §11.4) + the role→capability table + the per-op-type required capability | `reducer/capabilities.ts` |
| **WS-S.5.4b / 5.5** | The pure deterministic fold (PRIVATE_SPEC §14.3): authority enforced against EVOLVING room state, the §14.4 conflict policy (latest-edit-wins by order position, moderator-tombstone-hides, removed-member rejection, `client_draft_id` dedup, orphan rejection, founder genesis) + `roomStateCommitment` (the §14.3.3 device-convergence commitment) | `reducer/{state,reduce}.ts` |
| **WS-S.5.3** | The structural §14.2 pre-pass (room match, missing-dependency quarantine, Lamport-after-parents, per-device monotonic sequence / device-fork catch, duplicate op id) — produces the accepted set the fold consumes (the crypto wire-intake steps 1–5 land with WS-S.6 sync) | `reducer/validate.ts` |

**Dependencies added** (vetted against §6.12.12, all MIT, no install scripts, in
the code-split private chunk — excluded from the web `<15` budget): `ts-mls`
(RFC-9420 MLS, 4-package tree), its `@noble/ciphers`/`@noble/curves` peers (the
X25519/Ed25519 suite), and `@noble/hashes` (Argon2id).  `ts-mls` is not yet
formally security-audited (its own disclaimer); the one-file wrapper isolates it
for a future swap to an audited WASM build (tracked residual).

## Tests

| Suite | Coverage |
|---|---|
| `packages/shared` | the §4.1 coherence accept/reject matrix + `roomClassOf`; the disclosure/matrix copy-lint |
| `packages/db` | the DB↔shared enum mirror; the §8.1 column denylist (allowlist exactness + a forbidden-column fixture that BITES; rendezvous has no room FK); the **gated** Postgres harness: the §8.3 no-p2p-content trigger rejects p2p stories/threads (server rows succeed) + each §4.1 coherence CHECK rejects its incoherent axis tuple by name |
| `packages/private-p2p` | the canonical + strict-schema suites; the **WS-S.3 crypto suites** — RFC 5869 HKDF vectors, the AEAD round-trip/AAD-flip/replay/nonce-uniqueness suite, the Ed25519 KATs + RFC 9180 HPKE interop + RFC 7748 X25519, the MLS multi-device/epoch/manifest-fork suite, the four-tier key store + recovery kit + threshold recovery, and the forward-secrecy/fuzz properties; **and the WS-S.4.2/5 suites** — the CIDv1 multiformats/RFC-4648 pins, the Lamport/canonical-order tests, the reducer genesis/capability/conflict matrix, the §14.3.3 25-shuffle determinism property, and the structural validation pre-pass (280 tests; crypto + reducer both ≳ 92% coverage) |
| `apps/api` | the server-gate suite: submission 409 (+ no row created), contribution 404, feed `p2p_room_local_only`, the ranking room-surface exclusion, the search filter, the event-pipeline gate |
| `scripts` | the seven §23.10 CI gates + the `check:p2p-mls-wrapper` deep-import gate + the §12.7 no-server-recovery scan, all proven to bite (clean vs violating fixtures) + the live-source marker regression catch |

## Residuals (the next slices)

The P2P-transport / sync / UI plane is the next work, gated by the foundation +
the WS-S.3 crypto + the WS-S.5 reducer above:

- **WS-S.4.1/4.3 — the P2P transport.**  `docs/PRIVATE_SPEC.md` §9.2 recommends a
  Helia/libp2p stack, but vetting it against §6.12.12 found **580 transitive
  packages** — a supply-chain surface the LCAP plane (WS-R) deliberately rejected
  in favour of a dependency-free WebRTC + IPFS-gateway bridge.  Per the maintainer
  decision, the §9.4 content-addressing (WS-S.4.2, **shipped** dependency-free)
  and the reducer (WS-S.5, **shipped**) land first; the membership-gated **block
  exchange** will ride the existing `@licio/lcap-p2p` WebRTC carrier (the
  WS-R.16.1 ↔ WS-S.6.5 ciphertext seam) plus an IndexedDB blockstore, rather than
  a fresh libp2p stack.  The §9.4 IDB blockstore (the client persistence half of
  WS-S.4.2) lands with the WS-S.7 client surface.
  rather than a fresh libp2p stack.  **The full-Helia-vs-lighter-transport
  decision is a maintainer call before any P2P dependency is added.**
- **WS-S.5 core — shipped** (the Lamport order, the deterministic fold + §14.4
  conflict policy, the capability model, and the structural §14.2 pre-pass).  The
  remaining WS-S.5 sub-cards are follow-ups: **5.6** snapshot verification/replay,
  **5.7** local moderation overlays, **5.8** local-only encrypted search, and the
  crypto wire-intake (§14.2 steps 1–5: decode → signature → AEAD-open against the
  device registry), which integrates with WS-S.6 sync.
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

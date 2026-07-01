<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
# WS-S — Private P2P Rooms: security review (offline-buildable scope)

This is the WS-S.11 security review of the Private P2P (E2EE) rooms plane **as
built without a live transport / radio**.  It records the threat model, the
implemented mitigations (with file pointers), and the residual risks that move to
the on-device (network/radio) session.  It complements `docs/private-p2p/README.md`
(per-card status) and `docs/PRIVATE_SPEC.md` (the design).

Scope reviewed: `packages/private-p2p` (canonical encoding, schemas, crypto,
reducer, sync-decision cores, engine, lifecycle, media, snapshots), the server
non-storage contract (`packages/db` + `apps/api`), and the `apps/web` client
(persistence, manager, UI).  **Out of scope** (device session): the live WebRTC
block-exchange carrier, two-browser convergence E2E, and native radio transports.

## 1. Server non-storage contract (the keystone)

**Claim.** Platform staff cannot read, alter, recover, moderate, add members to,
or delete a private room, because the server never holds content, keys, heads, or
authoritative membership.

**Mitigations.**
- The only two server tables a p2p room may touch are `private_room_stubs` +
  `private_rendezvous_records`, under a strict §8.2 column ALLOWLIST
  (`packages/db/src/private-room-guard.ts`); the rendezvous record has no FK to
  `rooms` (§15.3.1, un-linkable).
- A `BEFORE INSERT OR UPDATE` trigger (migration `0045`) on every room-referencing
  content table rejects any row whose `room_id` resolves to `storage_mode='p2p'`
  — a code-path-independent backstop below the service-layer 409/404.
- Endpoint guards reject p2p rooms on submission/contribution/feed; ranking
  retrievers + server search predicate `storage_mode='server'`; the event router
  refuses content events for p2p rooms.
- Seven CI gates (`check:no-p2p-server-content`, `check:no-private-cid-egress`,
  `check:private-rendezvous-schema`, `check:private-bundle-transparency`,
  `check:p2p-endpoint-rejections`, `check:p2p-ranking-exclusion`,
  `check:p2p-search-exclusion`) are proven to bite on injected fixtures.
- The server-blind rendezvous endpoint stores opaque blind ids + ciphertext +
  a clamped TTL only, has no existence oracle (`poll` always returns a bounded
  list), uses IP-free rate limits, and does NOT import `@licio/private-p2p`.

**Residual.** The rendezvous endpoint sees coarse traffic timing/volume (per
§15.3.2 this is mitigated client-side by bucketing/jitter/cover records, which the
live transport exercises). No content/membership exposure.

## 2. Cryptographic posture

- Suites are PINNED and fail-closed: MLS `MLS_128_DHKEMX25519_AES128GCM_SHA256_
  Ed25519` (a module-load assertion + `check:p2p-mls-wrapper`), HPKE RFC 9180
  suite A.1, Ed25519 (§10.7), AES-256-GCM object AEAD (§10.5).  Every primitive
  is a thin wrapper pinned to RFC test vectors (5869/7748/8032/9180 + an
  `@hpke/core` interop vector + `@noble` KATs).
- The two decentralization planes (WS-R/LCAP vs WS-S) share no keys and pin
  different suites on purpose; `@licio/private-p2p` never imports `@licio/lcap`.
- No hand-rolled primitives (§10.1 principle 10); `ts-mls` is isolated behind a
  one-file wrapper so an audited MLS implementation can replace it.

**Residual.** `ts-mls` is RFC-9420-conformant (official vectors in its CI) but
not yet formally security-audited (its own disclaimer) — tracked in the README.

## 3. Confidentiality, integrity, forward secrecy

- **Two-layer AEAD** (§10.5): a per-object key seals the body; it is wrapped under
  the epoch content-wrap key.  Both AADs are canonical, bind room/epoch/object-
  type/chunk position, and are reconstructed on open — a flipped AAD field, wrong
  key, or tampered ciphertext fails closed (`aead.ts`, `validate-op.ts`).
- **Verify-before-use** (§8.3): every envelope — including one re-read from local
  storage on load and one arriving in an offline archive — is re-verified through
  `openOp` (signature → AEAD-open → schema → plaintext-vs-signed-metadata cross-
  check) before it contributes to state; the unresolved remainder is quarantined,
  never rendered.  Storage and container membership confer NO trust.
- **Structural pre-pass enforced in the fold** (§14.2 steps 6/9/10, §14.3.1):
  `openOp` proves WHO authored an op; the engine then runs `validateStructure`
  before `reduceRoom`, so a device fork (two ops at the same `author_seq`), a
  non-causal `lamport`, a genuinely missing parent, a duplicate `op_id`, or a room
  mismatch never reaches state even though its envelope opened cryptographically.
  The check is compaction-aware (a §14.5 base seeds it with every covered op id →
  its RETAINED `lamport` + the per-device seq floor) so a pruned parent's causality
  check uses its exact lamport — a compacted device makes the IDENTICAL accept/
  reject decision as an uncompacted peer (a too-low-lamport op against a pruned
  parent is rejected on both, never silently accepted on the compacted side);
  crypto-valid-but-structurally-invalid ops are retained as §15 fork evidence but
  excluded from `currentState`.
- **Device-fork convergence** (§15): two valid envelopes with the same `op_id` but
  different content do NOT resolve order-dependently ("first one wins").  The engine
  keeps the bytewise-smaller envelope signature — a deterministic, content-derived
  choice — so every peer converges on the SAME variant regardless of arrival order,
  and the loser is surfaced as `duplicate_op_id` fork evidence (storage is
  last-write-wins on the winner).  Proven by an opposite-delivery-order convergence
  test.
- **Forward secrecy at removal** (§10.9): `removeDeviceFromRoom` commits an MLS
  Remove that advances the epoch; the evicted device cannot derive the new epoch
  key, proven by a test where its engine quarantines post-removal content.
- **Determinism + cross-device compaction**: the reducer fold is byte-identical
  across delivery orders (§14.3.3, 25-shuffle property).  §14.5 compaction is an
  IN-BAND, admin-signed `snapshot.commit` op (carrying the state root + covered
  heads + the sealed body's CID): the snapshot body — the full reduced state PLUS
  the structural metadata an importer needs (every covered op's lamport, the covered
  heads, the Lamport ceiling, the seq floor) — is AEAD-sealed under the epoch key
  and content-addressed.  A compacted room therefore stays convergent with an
  uncompacted one AND EXPORTS: a fresh device imports the sealed snapshot, opens it
  under the held epoch key (proving member authorship), and adopts it ONLY if the
  in-band commit verifies (signed by an `admin` in the body, root matches the body,
  CID matches the sealed bytes) — a tampered snapshot is NOT adopted (§8.3), proven
  by a CID-flip test.  Compaction covers ONLY the structurally-accepted prefix, so a
  crypto-opened-but-structurally-invalid op is never pruned (it resolves when its
  dependency arrives).  The snapshot serializes each member's FULL capability set
  verbatim (not re-derived from role), so an individually granted/revoked capability
  survives the round trip and the post-compaction state root stays stable.  The
  head announcement is base-aware, so a compacted room still advertises its retained
  frontier (§15.6).

**Note on the membership model.** History is RETAINED by default (§14.5); a new
member is granted the historical epoch keys, so forward secrecy is a property of
**removal**, not of join.  This is the intended model, surfaced honestly in the
creation disclosure ("Removed members may keep content they already received").

## 4. Metadata privacy

- **Blind rendezvous** (§15.3): blind ids are `HMAC(rendezvous_key, …)` over
  canonical messages; "the key IS the capability" (§15.3.1) — no separate ACL.
- **Blind device ids** (§10.4): the per-epoch author pseudonym is an HKDF/HMAC
  derivation, so the same device is unlinkable across epochs to a non-member.  It
  is an unlinkability pseudonym, NOT an inter-member authenticator (it derives from
  the shared epoch secret); authorship among members is bound separately — see the
  author-identity binding in §5.
- **Size privacy**: op bodies pad to §25.4 buckets; media chunks pad to ONE
  uniform ciphertext length so the wire reveals only the chunk count; the
  attachment manifest carries a coarse `byte_size_class`.
- **Identity-free**: no IP/location/attention field may appear in any private
  schema (`check:lcap-schema-egress` + the no-raw-egress gate extended over
  `packages/private-p2p`); rate limits are IP-free.
- **Invite unlinkability** (§12.3): a join request blinds the invite id, so a
  relay cannot link it to a room without the invite secret.

## 5. Membership + capability authority

- The §11.3 capability model gates the fold; an op is applied only if its author
  holds the capability (e.g., only an admin's `member.add`/`snapshot.commit`).
- **Author-identity binding (impersonation defense).** The reducer keys authority
  off an op's plaintext `author_device_id`, but the §10.4 blind that resolves the
  signature-verification key derives from the SHARED epoch secret — so any member
  can compute any device's blind, and a valid signature proves only WHO SIGNED.
  `openOp` therefore pins `author_device_id` to the device the blind resolves to
  (`buildOpIntakeContext.deviceIdForBlind`); without it a member could sign under
  their own blind yet claim a higher-privilege device's id and have the reducer
  apply the op as that device.  Proven by an end-to-end reject test (a low-
  privilege member's forged-author op → `metadata_mismatch`, never reduced).
- §12.3 join: the invitee proves invite-secret knowledge over a transcript bound
  to its KeyPackage + coarse time (no replay with a different key); the admin
  verifies expiry, `max_uses`, the blind id, and the proof in constant time.
- §12.6.1 recovery is capability-based threshold (M distinct recover-capable
  admins), NOT secret-sharing — the recovery op carries no key.

## 6. Key management

- Device signing + HPKE private keys are NON-extractable `CryptoKey`s; they are
  persisted by structured-clone into a dedicated, isolated `licio_private_p2p`
  IndexedDB (raw bytes never serialize), mirroring the WS-C draft-key pattern.
- The §10.8 four-tier key store + the §12.6/§12.7 portable recovery kit are
  implemented; `check:no-p2p-server-content` forbids a server recovery endpoint.

## 7. Honest-limits disclosure

The creation/removal disclosures + the five mandatory acknowledgments + the
Appendix E privacy matrix are a prohibited-language-linted SSOT
(`packages/shared/src/constants/private-rooms.ts`); the creation wizard BLOCKS
creation until every acknowledgment is checked.  The UI can never promise
"secure"/"deleted everywhere"; restricted server rooms are never labelled simply
"private".

## 8. Residual risks → on-device (network/radio) session

These require a live transport / second device to exercise and verify; the
offline cores they consume are implemented + tested:

1. **Live WebRTC block-exchange carrier** (WS-S.4.3) — consumes the shipped
   §15.4/§15.5/§15.6 signaling/handshake/head-sync cores.  Security review of the
   live ICE/relay posture (§26.4) belongs here.
2. **Two-browser convergence E2E** — Playwright across real browsers (the jsdom
   component + node convergence proofs stand in for now).
3. **Membership delivery** — the invite→join→admit→welcome blobs (the crypto is
   done + tested) need either the transport or a copy-paste UI; content sync of an
   existing room wants the transport.
4. **Server→private migration** (WS-S.9) — the server-export half needs the
   server/DB.
5. **Update channel** (WS-S.10) — depends on WS-O.

The apps/web §14.5 snapshot persistence is now SHIPPED (WS-S.7) as the IN-BAND
sealed `snapshot.commit` (compact-on-cadence → author the admin-signed commit +
seal the body → prune IndexedDB envelopes → reload-from-base), so it is no longer a
residual AND it is cross-device-correct: the sealed snapshot body is exported in
the §15.9 archive and a fresh device imports it under verify-before-use (it adopts
the base only if the in-band commit verifies — §8.3, never on container trust).
The reload base is the device's own previously-verified computation, trusted as
local state like the at-rest epoch secrets; peer-received content is always
re-verified through `openOp`.

## 9. CI gates protecting these properties

`check:no-p2p-server-content`, `check:no-private-cid-egress`,
`check:private-rendezvous-schema`, `check:private-bundle-transparency`,
`check:p2p-endpoint-rejections`, `check:p2p-ranking-exclusion`,
`check:p2p-search-exclusion`, `check:private-p2p-split`, `check:p2p-mls-wrapper`,
plus `check:no-applause` / `check:no-raw-egress` / `check:lcap-schema-egress`
extended over the private trees.

## 10. Risk register (PRIVATE_SPEC §38-equivalent)

Symmetric with `docs/OFFLINE_SPEC.md` §38 (the LCAP transport/radio register), this
indexes the WS-S-specific risks so a regression names the risk it reopens.  Each row
is Risk → Impact → implemented Mitigation (+ residual where the mitigation is partial).

| Risk | Impact | Mitigation (implemented) | Residual |
|------|--------|--------------------------|----------|
| **ts-mls is not formally audited** | A flaw in the MLS library could weaken group keying / forward secrecy | Suite-pinned (`MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519`) behind a one-file wrapper; `check:p2p-mls-wrapper` forbids deep imports; RFC-9420 vectors + a multi-device/epoch/manifest-fork suite pin behaviour; the epoch→key-schedule bridge is independently HKDF-vector-pinned | Tracked: a future swap to an audited/WASM build (`docs/lcap/README.md`) |
| **Rendezvous traffic-timing leak** | A global observer correlates announce/poll timing to infer co-membership | Blind ids over canonical messages (the server sees no room id); §15.3.2 coarse time-bucketing + jitter + cover records + high-risk steering; IP-free rate limits; `poll` is never an existence oracle | Timing correlation by a global passive adversary is out of scope (documented honest limit) |
| **Blind-device-id linkability** | Linking a device's ops across epochs / de-pseudonymizing the author | Per-epoch HKDF-derived device blind (`deriveAuthorDeviceIdBlind`); `openOp` BINDS the signed `author_device_id` to the resolved blind (prevents higher-privilege-device impersonation), proven by a reject test | Linkability WITHIN one epoch is inherent (members share the epoch secret) — by design |
| **Removal-vs-join forward-secrecy asymmetry** | An evicted device reads post-removal content; a fresh joiner reads pre-join history | MLS Remove rotates the epoch (evicted device cannot derive the new key — quarantine test); a joiner gets ONLY the current-epoch snapshot via the grant (no historical keys) — both directions tested | — |
| **Recovery-threshold trustee compromise** | M colluding recover-capable admins re-admit an attacker | §12.6.1 threshold recovery is capability-based, NOT secret-sharing — the op carries no key; recovery is an ordinary authority-checked MLS Add; M distinct admins required | Trustee collusion ≥ M is the documented trust assumption |
| **Snapshot-authority escalation (§14.5, CRITICAL)** | The §14.5 snapshot body is sealed only under the per-epoch content key EVERY member holds, so a non-admin member could forge a body naming itself admin + author a self-validating `snapshot.commit` and escalate privilege on an importer (amplified by the live snapshot fetch) | `verifySnapshotCommit` anchors the commit author's `admin` authority on the importer's OWN trusted reduced state (`this.currentState`) when it has members; only a FRESH `completeJoin` (snapshot delivered in a §10.3-authenticated grant from the inviting admin) falls back to the body. The forged-admin escalation is rejected by an established importer — catch-proof regression in `reaudit-fixes.test.ts` (verified to FAIL when the anchor is reverted) | Fresh-importer safety rests on `completeJoin` authenticating the grant (trust-by-delivery, documented) |
| **Snapshot tamper (compaction / bootstrap)** | A forged §14.5 snapshot injects false state into a bootstrapping device | Verify-before-use: the sealed body opens only under the epoch key, and is adopted ONLY if its in-band `snapshot.commit` verifies (admin-signed, `state_merkle_root` matches the recomputed root, covered heads match); the full reduced state — incl. `displayName` + the attachment `epoch` — round-trips so the root is reproducible | — |
| **Op metadata splice** | A member re-seals an op's plaintext to diverge from the signed/authenticated envelope metadata | `openOp` cross-checks EVERY authenticated field (epoch, author_seq, schema, **created_at_bucket**, object_type, the blind→device-id binding, parents, room) between the plaintext and the signed envelope; a mismatch is `metadata_mismatch` | — |
| **Invite leak** | A leaked invite admits an attacker | Invite secret is HPKE-sealed to the invitee + delivered in a URL fragment (server-blind); the join request proves invite knowledge over a transcript bound to the KeyPackage + the proof-bound device signing key (a relay cannot substitute either); `max_uses` + expiry enforced constant-time | A leaked-BEFORE-use invite within its budget is the holder's responsibility (honest limit) |
| **Joiner-chosen device id** | A joiner picks a `device_id` that desyncs the reducer from MLS or mis-targets a §10.9 removal | `admitJoinRequest` DERIVES the reducer device id from the proof-bound signing key (`base64url(SHA-256(pubkey))`) and rejects a KeyPackage whose credential identity ≠ the derived id OR collides with an existing device (`malformed_key_package`) — catch-proof regression in `admit-device-id.test.ts` | — |
| **Live-carrier metadata to a DTLS-terminating relay** | A malicious TURN reads sync metadata (op ids, head structure) | Post-handshake op frames AEAD-sealed under the §15.5 step-4 pairwise session key (over per-op AEAD + DTLS); relay-only mode sets `iceTransportPolicy:'relay'` (no host-IP gather) | — |
| **Rendezvous signal-queue flood (§27, DoS)** | A current-epoch peer floods a victim's signal queue to evict the connection-bootstrapping offer | Per-SENDER sub-cap (`MAX_SIGNALS_PER_SENDER`) so one `sender_blind_id` cannot fill the queue + ALWAYS-ADMIT with UNIFORM-RANDOM eviction so a fragmented forged flood has NO deterministic power to evict a specific honest signal.  (A prior "evict the biggest sender" rule inverted this — an honest offerer sends its SDP offer + every trickled ICE candidate under ONE `sender_blind_id`, so it was the biggest sender and the flood targeted it; a hog threshold cannot distinguish it because a legit burst can reach the per-sender cap — PRIV-API-RENDEZVOUS-7.)  Tested at the store level (both adapters) | Probabilistic degradation under a SUSTAINED flood is fundamental without the Tier-2 cap; random-drop still penalizes a genuine hog proportionally, and WebRTC retransmission + repeated polls carry an honest offer through |
| **Rendezvous presence flood (§27, DoS)** | A member floods a room blind id with opaque presence records to crowd honest peers out of the `poll` window | **Tier-1 (implemented):** `poll` returns a UNIFORM RANDOM SAMPLE of the live records (both adapters) instead of the storage-order front, so a flood cannot DETERMINISTICALLY evict an honest record — each appears with probability `limit/live` per poll and is discovered across the client's repeated polls; plus the per-room cap, the global IP-free rate limit (bounds the flood rate), and the member-only rendezvous key.  A genuine per-announcer cap is impossible to enforce *server-side* because `peer_blind_id = HMAC(rendezvous_key, …, device_id, …)` and the server holds no key (it cannot verify the id derives from a REAL device), so a member can mint arbitrary blind-ids | **Tier-2 (crypto SHIPPED — design + status in [`TIER2-RENDEZVOUS-CAP.md`](TIER2-RENDEZVOUS-CAP.md)):** the anonymous-credential cap is implemented in `packages/private-p2p/src/crypto/bbs` + `src/rendezvous-cap` (31 tests): IETF-byte-exact-vector-pinned base BBS + a per-verifier pseudonym nullifier + BLIND issuance (admin-unlinkable, composition-anchored to the vetted base). The cap is enforced **PEER-SIDE ONLY** — the SERVER-side verification was REMOVED (**PRIV-API-RENDEZVOUS-1**): server-side ZK verification intrinsically requires the server to hold the per-`(room,epoch)` issuer key, which is a stable, bucket-spanning linking handle that would let an honest-but-curious server re-link a room's bucket-rotated blind ids across an entire epoch — breaking §15.3 cross-bucket unlinkability.  There is no way to keep server-side dedup AND that unlinkability, so the server stores the announcement opaquely and runs ONLY the §27 Tier-1 sample-poll; the cap rides SEALED INSIDE the announcement (`RendezvousAnnouncement.cap`, opened only by a member holding the rendezvous key) and a polling MEMBER verifies + dedups by the canonical pseudonym (`filterVerifiedPresence`), fail-open to Tier-1 throughout.  The CLIENT wiring is SHIPPED (`apps/web/src/private-p2p/rendezvous-cap-manager.ts` + `connect-peer.ts`: publish→install→issue over the MLS op log, the sealed-cap announce, and the poll-side skip-invalid), so an enrolled room runs Tier-2 peer-side while an un-enrolled one runs Tier-1, a strict superset |
| **Public-gateway publish of non-public content (Gate-19)** | A steward publishes a `room_only` / p2p-room block to the public IPFS DHT by asserting `visibility:'public'` | The publish path now DERIVES visibility/storage-mode SERVER-SIDE from the content model (`publish-eligibility.ts`): publishable ONLY if EVERY content target resolves to a `public` item in a `server`-storage room; the caller's visibility signals are IGNORED, an absent resolver is fail-closed, and the §22.7 review gate remains the primary control. Tested (room_only / p2p / fail-closed refusals) | — |

### Transport-layer audit round (2026-06)

A dedicated deep audit of BOTH decentralization transport planes (LCAP public + private
P2P).  Each row is a confirmed finding → the shipped fix.

| Risk | Impact | Mitigation (implemented) |
|------|--------|--------------------------|
| **Large media / snapshot never crossed the LIVE carrier (PRIV-SYNC-FRAGMENT)** | The private WebRTC carrier did ONE `dc.send` per sealed frame (no fragmentation) and `decodeSyncMessage` capped at 4 MiB, so a §13.6 media `block_response` / §14.5 `snapshot_response` above the SCTP message limit silently failed — §13.6/§14.5 non-functional at realistic sizes | The carrier now FRAGMENTS the sealed frame into ≤16 KiB fragments (`sync/fragment.ts`, `PrivateFragmentReassembler`, fail-closed reassembly + a 16 MiB §27 reassembly cap), reassembles+opens on receive (opStash included), with SCTP backpressure + single-flight sends; the sync-message decode cap is raised to a coherent 16 MiB; a snapshot too large for one live message is DECLINED gracefully (→ the §15.9 offline CAR path) rather than throwing.  Wire bumped to `HANDSHAKE_PROTOCOL_VERSION` 3 (a skew is rejected at the handshake).  Fragment fail-closed matrix + a 200 KiB multi-fragment carrier round-trip tested |
| **Client signal-dedup unbounded (untrusted server)** | A malicious/compromised rendezvous server returns signals with a far-future `expires_at`, defeating the client's expiry-based prune of `seenSignalCiphertexts` → unbounded renderer memory | The client now REJECTS a signal whose `expires_at` exceeds the legit bound (`now + ttl + skew`) — the server cannot pin a dedup entry past the prune — keys on a compact ciphertext prefix, and hard-caps the set with oldest-first eviction (PRIV-CARRIER-DEDUP-BOUND) |
| **Answerer stranded on offerer vanish; teardown relied on `pc.close()`→`dc.onclose`** | On a hard offerer drop (no DTLS close_notify) the answerer never tore down (leaked session + mesh slot); ICE-restart exhaustion teardown assumed `pc.close()` fires `dc.onclose`, which browsers do not guarantee | BOTH roles now run the bounded recovery/give-up loop (only the offerer re-offers; the answerer gives up after the budget), and `cleanup()` fires the session close-notification DETERMINISTICALLY via a registered notifier (PRIV-CARRIER-TEARDOWN) — no reliance on `pc.close()`→`dc.onclose` — so `maintainConnection`/`maintainMesh` always re-dial + prune |
| **Responder leg lacked the public-only carriage gate** | The courier + WebRTC responders enqueued a reply with no `transportMayCarry`/label check — asymmetric with the request-leg fix; a regression in content selection could leak a non-public reply over a public carrier | A shared `responsePrivacyLabel` gate (fail-closed on undecodable/non-public) is applied on BOTH responder legs before the reply leaves; the response budget is clamped to the §27 per-exchange ceiling (PUB-RESPONDER-PUBLIC-ONLY / PUB-WEB-CARRIERS-*) |
| **Rendezvous announcement length leak** | Sealed announcements were unpadded, so cover records (fixed length) were length-distinguishable from real records and a real record's length leaked has-hints/has-cap | Announcements are §25.4-padded to a fixed bucket before sealing (constant sealed length); cover records land under the room's REAL blind id with a length-matched random blob, so the server cannot tell a cover from a real device or read a per-device length bit (PRIV-RENDEZVOUS-PAD/COVER) |
| **`/api/lcap/v2/p2p/signal` unbounded body (DoS)** | The only LCAP POST route without a stream body cap buffered the whole (chunked/absent-length) request before the 32 KiB blob check — an unauthenticated OOM | `lcapBodyLimit(DEFAULT_SIGNAL_CONFIG.maxBlobBytes)` + the declared-length fast-path now bound the stream, matching every sibling POST |
| **Graceful `bye` lost on close** | `close()` fired the §15.4 `bye` fire-and-forget then synchronously closed the channel; the async AEAD seal lost the race, so every deliberate leave looked like a network drop → the peer re-dialed the leaver | `close()` now AWAITS the bye's seal+send (enqueued into the SCTP buffer, flushed by close) before closing (PRIV-SESSION-BYE) |
| **Unbounded `requested` set + snapshot-bootstrap stall** | A `head_announcement` flood grew `requested` without bound; and the §14.5 snapshot bootstrap fired only on a fully-empty response, so a compacted peer's PARTIAL serve stranded a lagging member | The request-tracking sets are §27-capped (oldest-first eviction); the snapshot request now fires whenever the walk is STUCK (no fresh request yet still missing deps OR ops held pending behind a pruned prefix) (PRIV-SESSION-REQ-BOUND / SNAPSHOT-STUCK) |
| **Archive encode byte-unbounded** | `encodeBlockArchive` bounded only the envelope COUNT while decode caps at 64 MiB, so the app could write an offline backup it could never re-import | `encodeBlockArchive` now rejects (typed) an archive whose encoded size exceeds the re-import cap (PRIV-ARCHIVE-ENCODE-BOUND) |
| **Code-split gate re-export bypass** | `check:{lcap,private}-p2p-split` matched only `import`, so an `export … from '@licio/…-p2p'` barrel would pull the crypto/protocol core into the initial bundle undetected | Both gates now also detect static `export … from` / `export * from` re-exports (allowing erased `export type`), with negative tests |
| **Egress denylist asymmetry** | The private plane's network/location field denylist was strictly weaker than the LCAP schema gate | `check-no-raw-egress` gains the missing tokens and `check-lcap-schema-egress` now scans the private schema surface (incl. `coordinates`, enforced where no EC-key code lives) so both planes get the stronger list (PRIV-EGRESS-PARITY) |

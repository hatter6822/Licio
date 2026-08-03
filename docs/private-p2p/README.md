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
the **complete** operation-log reducer (`reducer/`, WS-S.5.1–5.8) — the Lamport
clock + canonical total order, the room/capability state, the pure authority-
enforcing fold + §14.4 conflict policy, the structural §14.2 pre-pass, the §14.2
stage-1 op wire-codec (`sealOp`/`openOp`), the §14.5 verify-before-use snapshots,
the §14.6 device-local moderation overlays, and the §13.7 local-only encrypted
search — with the §14.3.3/§26.1 byte-identical-across-shuffles determinism
property pinned.

The **WS-S.6 P2P sync-decision plane is shipped as a pure, transport-independent
core** (`sync/`, WS-S.6.1–6.6) AND the **WS-S.4.3 live WebRTC carrier is now wired on
top** (`apps/web/src/private-p2p/connect-peer.ts` `connectPrivatePeer` → a
membership-proven `PeerChannel` → `PrivateSyncSession`, converging two real engines):
the §15.2/§15.3 blind rendezvous (derivation, sealed
announcements, the §15.3.1 authorization property, the §15.3.2 metadata
mitigations), the §15.4 encrypted signaling + relay-only ICE suppression, the
§15.5 membership-proving handshake, the §15.6/§15.7/§15.8 head announcement +
frontier-first reconciliation + fetch-order priority, the §15.9 offline
encrypted-archive (CAR) exchange with re-validating import, and the **§29
server-blind rendezvous endpoint** (`apps/api`, WS-S.6.6).

The **client-side `PrivateRoomEngine` is shipped** (`engine/`): the pure
orchestration that composes the §14.2 wire-intake (`openOp`), the §10.4
device-blind resolution (`buildOpIntakeContext`), the §14.3 fold (`reduceRoom`),
and the author path (`sealOp`) behind a storage port — so a UI or a transport
drives one object.  It runs the bounded open→fold fixpoint (an out-of-order
causal batch converges), re-verifies every envelope on load (§8.3 — storage
confers no trust), quarantines what cannot open, and exposes the §15.6 sync
surface (`headAnnouncement`/`wantedFrom`) + the §15.9 offline archive
(`exportArchive`/`importArchive`) — so two engines holding the same room keys
**converge to byte-identical state by exchanging an archive, with no live
transport** (proven by a two-engine test).  `openOp` BINDS the plaintext
`author_device_id` (which the reducer trusts for authority) to the resolved
device of the §10.4 blind (`buildOpIntakeContext` exposes `deviceIdForBlind`):
because the blind derives from the SHARED epoch secret any member can compute it,
so the signature alone proves only WHO SIGNED — without the binding a member could
sign under their own blind yet claim a higher-privilege device's id
(impersonation).  The binding is proven by an end-to-end reject test.  After
`openOp`, the engine runs the §14.2 structural pre-pass (`validateStructure`,
compaction-base-aware) before `reduceRoom`, so a device fork (same `author_seq`), a
non-causal `lamport`, a missing parent, a duplicate `op_id`, or a room mismatch
never reaches state — proven by runtime-enforcement tests.

The **room-creation + membership orchestration is shipped** (`engine/room-lifecycle.ts`):
`createPrivateRoom` ties the §10.2 MLS group keying, the epoch→five-key bridge,
the §13.1 manifest (+ its `manifest_commitment`), and the §12.1 founder genesis
op into ONE node-testable call — every value REAL crypto (a real Ed25519 device
key, a real X25519 HPKE invite key, and a real serialized MLS KeyPackage via the
new `encodeKeyPackage`/`decodeKeyPackage` MLS-message wrapper).  `inviteDevice`
(an MLS Add → commit + Welcome), `joinRoom` (process a Welcome → derive the
joined epoch's keys), and `buildMemberAddOp` (author the §12 add op under the new
epoch) complete the membership flow.  The headline test runs the **full two-device
dance with no transport**: Alice founds the room, admits Bob's device, Bob joins
from the Welcome and **independently derives byte-identical epoch-1 keys**, then
an archive exchange converges both engines to the same membership state — the real
E2EE join, end-to-end, on real MLS/HPKE/Ed25519.

Content authoring rides the same path: `buildRoomOp` is the single op-author core
(membership AND content — `buildMemberAddOp` is a thin wrapper over it), and the
engine's `nextLamport()` / `nextAuthorSeq(deviceId)` compute an op's causal
metadata from the local DAG, so a member posts a story or a comment with a
correct `parents`/`lamport`/`author_seq` and the §11.3 capability check in the
reducer decides whether they may.

Removal closes the loop with forward secrecy: `removeDeviceFromRoom` resolves a
device's MLS leaf (`findDeviceLeafIndex`, kept inside the wrapper so ts-mls's tree
shape never leaks) and commits an MLS Remove that advances the epoch — a removed
device cannot derive the new epoch's keys, proven by a test where the evicted
device's engine **quarantines** (cannot open) content authored after its removal.

The §10.3 invite + §12.3 join flow is shipped (WS-S.7.2, `engine/invite.ts`):
`createRoomInvite` mints an `InviteSecret` (HPKE-sealed to the invitee by the
existing `sealInvite`, delivered in a URL fragment the server never sees);
`buildJoinRequest` blinds the invite id (`HMAC(invite_secret, invite_id)` — a relay
cannot link it to a room) and proves invite knowledge over the request transcript
(bound to the offered KeyPackage + coarse time, so the proof can't be replayed);
`verifyJoinRequest` checks expiry, the `max_uses` budget, the blind id, and the
proof (all constant-time) before decoding the KeyPackage the admin hands to
`inviteDevice`.  The full mint→seal→open→prove→admit→join→converge path is tested
end-to-end with every rejection (expired / exhausted / proof / blind-id /
malformed-package) — no transport.

Media completes the content model (WS-S.8, `crypto/attachment.ts`): `encryptAttachment`
splits a blob into uniform §25.4-padded chunks, AEAD-seals each under one attachment
object key BOUND by `chunk_index`/`chunk_total` in its `body_aad` (so a chunk cannot
be reordered, dropped, or spliced across attachments), and builds the §13.6 manifest
(every CID over CIPHERTEXT; a coarse `byte_size_class`; the object key wrapped under
the epoch key).  The `attachment.add` op carries that `wrapped_object_key` ALONGSIDE
the manifest CID (and the reducer records it in attachment state), so a peer fetching
the sealed manifest by CID holds the distributed key material to unwrap + open it —
without it the manifest would be undecryptable.  `decryptAttachment` verifies the
ciphertext CID + hash before decryption, opens each chunk under its AAD, checks the
plaintext commitment, and reassembles — failing closed on any tamper, missing chunk,
or cross-attachment splice.  All chunks seal to one uniform ciphertext length, so the
wire reveals only the chunk count.

Snapshots + compaction are shipped (WS-S.5.9, §14.5/§25.6) as an IN-BAND, admin-signed
`snapshot.commit`: `serializeReducerState`/`deserializeReducerState` round-trip the
COMPLETE reduced state — including each member's FULL capability set verbatim, NOT
re-derived from role (a `role.grant`/`role.revoke` may grant/revoke an individual
capability independent of role, §11.3; `roomStateCommitment` hashes the full set, so
re-deriving from role alone would silently drop a grant and diverge a compacted
device's state root from an uncompacted one).  `engine.commitSnapshot()` seals the
snapshot body (the full state PLUS the structural metadata an importer needs — every
covered op's lamport, the covered heads, the Lamport ceiling, the seq floor) under
the epoch key, content-addresses it, and authors an admin `snapshot.commit` op
carrying the state root + covered heads + that body CID; it then PRUNES only the
structurally-accepted covered prefix (a crypto-opened-but-structurally-invalid op is
never pruned — it resolves when its dependency arrives).  A compacted engine stays
**byte-identical to an uncompacted device that folded the same ops**, keeps authored
Lamport/seq monotonic across the prune, and reuses every covered op's RETAINED lamport
for the §14.3.1 causality check (so a too-low-lamport op against a pruned parent is
rejected identically on both — no divergence).  A device FORK (two valid envelopes,
same `op_id`, different content) is resolved deterministically (keep the bytewise-
smaller signature; the loser is `duplicate_op_id` evidence), so peers converge
regardless of arrival order.  The head announcement is base-aware (a compacted room
still advertises its retained frontier, §15.6).  The apps/web client PERSISTS the
SEALED base: `PrivateRoomSession` compacts on the §25.6 cadence (`maybeCompact` →
`exportBase`), persists the sealed base into the session, and DROPS the covered
envelopes from IndexedDB; on reload the engine opens the sealed base under the held
epoch key and re-verifies ONLY the post-snapshot envelopes.  Crucially, compaction is
CROSS-DEVICE-CORRECT: `exportArchive` ships the sealed snapshot body, and a fresh
device's `importArchive` bootstraps from it under verify-before-use — adopting the
base ONLY if the in-band commit verifies (signed by an `admin` in the body, root
matches the body, CID matches the bytes); a tampered snapshot is NOT adopted (§8.3).
Proven by node convergence/lamport/fork tests, a CID-flip tamper test, an
export→import-on-a-fresh-device test, and a jsdom compact→prune→reload round-trip.

The **WS-S.7 apps/web client is shipped** (`apps/web/src/private-p2p/`): the
IndexedDb `PrivateRoomStorage` adapter (a dedicated, isolated `licio_private_p2p`
database) + the persisted `room_sessions` store (the local device's NON-extractable
keys, MLS group state, epoch keys, and manifest — what lets a local-only room
survive a reload) + the `PrivateRoomSession` manager: `create` / `load` / `list` /
`leave`, plus `postStory` / `postComment` / `authorOp` (deriving op metadata from
the local DAG).  A jsdom test founds a room, posts content, RELOADS it (a fresh
engine over the stored keys/group/epochs), and authors AGAIN — proving the
persisted non-extractable signing key + epoch keys work after reload.  Bytes are
normalized to same-realm `Uint8Array`s at the storage-read boundary (defensive
against structured-clone quirks).  `@licio/private-p2p` is a `workspace:*` dep of
apps/web loaded by `import()` ONLY — the `check:private-p2p-split` gate forbids a
static value import, and the production build confirms the crypto/protocol core
stays out of the initial bundle (a separate lazy chunk).

The **WS-S.7.4 client UI is shipped** (`apps/web/src/components/private-rooms/` +
the `/private` + `/private/$roomId` routes, linked from Profile): the
`CreatePrivateRoomWizard` renders the §20.2 disclosure + the five mandatory
acknowledgments from the SSOT and BLOCKS creation until all are checked; the
`PrivateRoomView` loads a local session and renders members + stories + comments
with a composer.  Both are jsdom + axe tested; the production build confirms the
crypto plane stays a lazy chunk (initial JS 144.5 KB, the ~100 KB crypto core
excluded via the `private-p2p` `manualChunks`).

The WS-S.7.4 **membership + verification surfaces** are also shipped (behind the
room view's "Manage members & verify devices" toggle, all jsdom + axe tested):
- The member list and comment author lines render the §12.3 / §14.3.3
  NON-cryptographic `displayName` clearly subordinate to the cryptographic member
  id (`Alice · a1b2c3d4…`), never using the name for any logic; they fall back to
  the short id when no name is set.
- `SafetyNumberPanel` (the §15.5 / §20.4 SAS) computes the symmetric safety number
  for the local ⇄ a chosen member's device (over the long-term signing keys, via
  `PrivateRoomSession.computeMemberSafetyNumber` → the shipped `computeSafetyNumber`
  crypto — never reimplemented), renders the 12 five-digit groups for out-of-band
  comparison, and persists a per-device "verified" toggle LOCALLY (a localStorage
  set keyed by room + device, sent nowhere, conferring no authority).  The copy
  makes the trusted-channel requirement explicit.
- `InvitePanel` (admin) seals a §10.3 invite to an invitee key and renders the
  URL-fragment-only link to copy (the server never sees it) + the invite record
  to keep; `JoinPanel` covers both the joiner side (`PrivateRoomSession.prepareJoinRequest`
  → a recipient key to share + a join-request blob from a pasted invite) and the
  admin admit side (`admitJoinRequest`: `verifyJoinRequest` → `inviteDevice` (MLS
  Add) → `buildMemberAddOp` carrying `proposed_display_name`, persisting the
  advanced group + new epoch keys), surfacing every rejection
  (expired/exhausted/invite-id/proof/key-package) honestly.  The §10.3 SEALED
  invite also CARRIES the §21 directory capability (`room_stub_ref` + the
  epoch-0-derived `bootstrap_blind_id`), which is the only way a member admitted
  at a later epoch can resolve the room's directory record at all — it cannot
  re-derive a token bound to an epoch key it never held.  It rides the invite
  and NOT the §12.3 grant: a grant is copy-pasted plaintext apart from its
  Welcome and archive, and this token does not rotate, so an observer of that
  channel would keep a handle resolving an `unlisted` record forever.  The
  joiner retains it from the invite it opened.
- `DirectoryRecordPanel` (§21.1–§21.4) reads that record with the stored
  capability and, for the OWNING ACCOUNT (resolved through
  `GET /v1/private-rooms/mine`, never from a room role or a device-local flag),
  refreshes its manifest commitment, delists it, removes it — or REGISTERS one
  where there is none, which is what makes a `detached` room reachable by id and
  what gives a removed record a way back.  It renders
  NOTHING for a room with no stub (a `detached` room has nothing to manage), and
  the removal confirmation reads back the server's own wording, because
  "removed Licio's record" quietly becoming "deleted the room" is exactly the
  §21.4 failure mode.  A room has ONE record — the uniqueness key is the room's
  founder signing key, not `(account, room)` — so registration ADOPTS the
  caller's own record and REFUSES a room another account already registered
  (`room_already_registered`).  Two things make that key an identity rather than
  a string: a REGISTRATION PROOF over `(room key, manifest commitment, account)`,
  verified and discarded, so the public stub signature cannot simply be replayed
  under another account; and CANONICAL base64url on every fixed-size field
  (`isCanonicalBase64Url`, `@licio/shared`), because a 32-byte key has four
  spellings that decode identically — and uniqueness is enforced on the TEXT
  while possession is proved against the BYTES, so without it one room is four
  rows, each provable by the same holder.  The panel correspondingly treats a `/mine` miss
  as "this account owns none", never as "the room has none", and offers
  registration only where absence is KNOWN (no stored handle, or a removal this
  device performed).  An unreadable record can be forgotten explicitly on this
  device, which is how the owner of a record another device removed gets back
  to a registerable state without the read having to guess.  The device's
  stored capability is dropped ONLY by a removal this device performed (a `404` from that DELETE means the record is
  already gone, so a retry repairs a failed local clear): a failed read cannot
  prove absence, and neither can an account-scoped `/mine` lookup — a joined
  member on their own account owns no record while the creator's stands, and
  clearing there would destroy the only copy of a token a member admitted after
  epoch 0 cannot re-derive.
- `PrivateRoomDirectory` (§4.2, on `/private`) browses the PUBLIC directory of
  `listed` rooms: display metadata only, keyset-paged, and with no join
  affordance — a P2P room is invite-only, so the honest offer is "this room
  exists, ask a member".

These panels are the COPY-PASTE membership path (the §15.5 live-transport delivery
of the MLS Welcome that finishes a remote joiner's session is the device-session
slice below).

### Tracked residual — cross-device directory capability (WS-S.1.2b)

`attachDirectoryStub` writes the §21 handle to the LOCAL `StoredRoomSession`
only. It authors no room operation, so a room whose record is re-registered on
one device leaves every other member device holding the previous
`room_server_id` — which 404s — and `createInvite()` on those devices keeps
emitting the stale reference until each is re-invited or re-registers itself.

Two things bound the damage today. The capability itself is derived from the
GENESIS epoch, so a re-registration produces the same `bootstrap_blind_id` and
only the server id moves; and registration is offered only on a device that
holds that epoch, which is the device that registered originally in the common
single-founder case.

Closing it properly needs a `directory.set` room operation — a new op body in
`schemas/ops.ts`, a reducer field, and a §11.3 capability rule for who may
author it — so that the handle rides the room's own encrypted state like every
other shared fact. That is a protocol addition rather than a fix, and it is
deferred to the WS-S.1.2b follow-up rather than approximated with a broadcast.

## Remaining work

The single-device room (create / author / read / persist / reload) is complete
and verified **offline**, and the **multi-device convergence plane is now shipped
as a pure, transport-independent core**:

- **The §15.7 op-exchange wire protocol** (`sync/op-exchange.ts`): the
  `head_announcement` / `op_request` / `op_response` message union + the canonical
  codec, plus `PrivateRoomEngine.missingDependencies()` (the frontier-first ancestor
  walk) and `serveOps()` (serve held envelopes by op id).  A fresh peer **converges
  to byte-identical reduced state by walking the DAG** through head/want/serve —
  proven in `room-engine.test.ts` end-to-end through the wire codec.
- **The event-driven `PrivateSyncSession`** (`apps/web/src/private-p2p/sync-session.ts`):
  drives announce → want → serve → ingest → re-announce-on-progress over an abstract
  post-handshake `PeerChannel`, terminating once both peers hold the union; tested for
  bidirectional convergence, request chunking, and fail-closed decode.
- **The §15.5 safety number (SAS)** (`crypto/safety-number.ts`) + **the member
  display-name mapping** (the `member.add` op + reduced `MemberState`, authority-
  invariant, §14.3.3-converged) — both shipped + tested, with the WS-S.7.4 verify/
  invite/join UI on top.
- **Real WebRTC works on the host:** the LCAP `connectWebrtc` live establishment is
  shipped (`@licio/lcap-p2p`, RTCPeerConnection offer/answer/ICE over the sealed
  rendezvous), and a real-Chromium-WebRTC datachannel loopback E2E
  (`apps/web/e2e/webrtc-loopback.spec.ts`) confirms the datachannel + byte path.

**The WS-S.4.3 live private-p2p WebRTC carrier is now shipped** — the device-session
slice is closed on the convergence side:
- `connectPrivatePeer` (`apps/web/src/private-p2p/connect-peer.ts`) composes the
  shipped pure cores into a real `RTCPeerConnection` → a post-handshake `PeerChannel`
  (the private plane's OWN driver — it shares no crypto with the LCAP carrier, by
  doctrine): the §15.2/§15.3 blind rendezvous derives the room/peer blind ids,
  signaling is X25519-ECDH SEALED before it reaches the server (`sealSignal`/
  `openSignal`, relay-only ICE suppression applied per-candidate), and the §15.5
  membership-proving handshake verifies the remote device is REGISTERED + ACTIVE at
  the epoch BEFORE any op frame is served (a `MessageInbox` queues so a fast peer's
  first frame is never dropped; a failed handshake tears the connection down and
  rejects — no op is ever served first).
- **The §15.4 signalling identity is DEVICE-SECRET.**  `deriveSignalingKeyPair`
  seeds the X25519 private scalar from `SHA-256(Ed25519-Sign(device_signing_key,
  canonical(["signal-key", room_id_commitment, device_id, epoch, time_bucket])))`
  — never from the rendezvous key, which every current member holds alongside a
  sealed announcement carrying the device id, epoch and bucket, and which
  therefore let ANY member recompute another device's signalling private key and
  decrypt, forge, or consume its deliver-once SDP/ICE before the §15.5 handshake
  ran.  Ed25519 determinism (RFC 8032 §5.1.6) keeps ONE identity per `(room,
  epoch, bucket)` with nothing stored — the announcement-fan-out property — and
  the room commitment in the transcript stops a member of two rooms linking a
  device across them.  The public half still rides in the sealed announcement,
  so discovery is unchanged.
- The Tier-2 rendezvous cap is bound to the announcement's DIAL-CRITICAL fields
  (`dialBinding`: the signalling key AND the claimed `peer_device_id`,
  length-prefixed).  Binding the key alone left a targeted eviction: a member
  could open an honest announcement, keep its signalling key so the proof still
  verified, swap the device id, and re-seal with a later expiry — the dial then
  reached the honest peer, failed the §15.5 claimed-device check, and cooled down
  that device's (now deterministic) key.
- The carrier VERIFIES CAPS BEFORE deduplicating, and deduplicates WITHIN each
  tier.  `selectFreshestCandidates` resolves a key collision by
  `record.expires_at`, which the ANNOUNCER chooses, so running it across a mixed
  set was itself the eviction primitive: a forgery keeping an honest signalling key
  won the slot regardless of the binding, and was then dropped for failing
  verification — leaving the honest capped device in NEITHER set and never dialled.
  Binding and ordering were two separate holes.
- The dial tier is the VERIFIED cap, never a present one.  `ann.cap` is bounded
  base64url and nothing else, so partitioning on presence let any current-epoch
  member choose their own tier and put an honest uncapped peer outside the pool
  entirely.  The verified tier also YIELDS on alternate rounds: owning every round
  lets a capped member refresh a valid cap under a new signalling key after each
  failed dial and consume the whole deadline.
- Dial selection ALTERNATES between the freshest candidate and the most starved
  one (`pickDialCandidate`).  The failed-dial cooldown is keyed by the record's
  ephemeral key, so a member rotating it puts a fresh spoof at the head of every
  re-polled sample; freshest-first alone would hand it every attempt until the
  connect deadline.  Alternating bounds a flooder to every other dial, so an
  honest candidate is reached within two rounds.
- `apps/web/src/private-p2p/rendezvous-client.ts` (`httpRendezvousTransport`) is the
  zod-validated fetch transport over `POST /v1/private-rendezvous/{announce,poll,
  signal,signal/poll}` (blind ids + ciphertext + clamped TTL only; `poll` is never an
  existence oracle).  `PrivateRoomSession.connect()` derives the epoch keys, builds
  the transport + a `resolveDevice` over `engine.state().devices`, calls
  `connectPrivatePeer`, and hands the channel to `PrivateSyncSession` (the §15.7
  op-exchange) so two REAL engines **converge to byte-identical reduced state by
  walking the DAG**.  A "Connect & sync with members" control in `PrivateRoomView`
  drives it (`session.connect(...)` with live `idle/connecting/connected/error`
  status).  A node integration test converges two real engines over the real
  op-exchange codec; the carrier node test converges two engines over a fake-RTC pair
  + in-memory rendezvous AND covers the fail-closed handshake-reject case.
- The live carrier now converges across the FULL lifecycle, not a single static epoch:
  - **§10.9 epoch rotation** — `admitJoinRequest`/`removeMember` broadcast the MLS commit
    over an `mls_commit` sync message to every connected member; each applies it
    (`applyCommit` → derive + install the new epoch keys → `retryPending`), so
    post-membership-change content opens instead of quarantining `no_epoch_key`.  The
    engine RETAINS (does not drop) an op awaiting an epoch key and re-opens it when the
    key arrives (the self-heal), and the session's request guard means a served-but-
    unopenable op never livelocks.
  - **§12.3 `completeJoin`** — `admitJoinRequest` returns a GRANT (the MLS Welcome + the
    current device roster + a §14.5 snapshot sealed under the new epoch); the joiner
    `completeJoin`s it into a usable `PrivateRoomSession` that sees the existing
    members/devices/content WITHOUT the historical keys it never held (forward secrecy),
    and authors with its own proof-bound device signing key.
  - **§13.6 media** — `block_request`/`block_response` carry CID-addressed attachment
    blocks; the session lazily fetches the manifest then its chunks after op convergence
    and `decryptAttachment`s them (re-verifying every CID before storing).
  - **§14.5 live snapshot fetch** — a compacted/lagging member that cannot fetch the
    pruned prefix op-by-op requests the peer's snapshot archive over
    `snapshot_request`/`snapshot_response` and bootstraps from it; the request now fires
    whenever the walk is STUCK (a compacted peer's PARTIAL serve, or ops held pending behind
    a pruned prefix), not only on a fully-empty response.  A snapshot too large for one live
    message is declined gracefully (→ the §15.9 offline CAR path) rather than stalling.
  - **Datachannel fragmentation (`HANDSHAKE_PROTOCOL_VERSION` 3, `sync/fragment.ts`)** — a
    large sealed sync message (a media `block_response`, a `snapshot_response`) is split into
    ≤16 KiB fragments and reassembled fail-closed (a 16 MiB §27 reassembly cap, SCTP
    backpressure + single-flight sends), so media/snapshot at realistic sizes actually cross
    the carrier instead of silently failing the SCTP message limit.  The sync-message decode
    cap is a coherent 16 MiB; a version skew is rejected at the handshake.
  - **Deterministic teardown + both-role give-up** — `cleanup()` fires the session
    close-notification directly (never relying on `pc.close()`→`dc.onclose`, which browsers do
    not guarantee), and BOTH roles run the bounded ICE-restart give-up loop (only the offerer
    re-offers), so a VANISHED offerer no longer strands the answerer's session + mesh slot —
    `maintainConnection`/`maintainMesh` re-dial + prune on every drop.
- **Tracked residuals (closure target: physical-radio field confirmation).**
  - **Real-browser carrier convergence** (WP-9 / finding 13) is **shipped**:
    `apps/web/e2e/private-carrier.realwebrtc.spec.ts` runs the REAL `connectPrivatePeer`
    carrier over a real Chromium `RTCPeerConnection` (against the Vite dev server, via the
    `e2e-carrier-harness` re-export).  It now proves THREE legs over real WebRTC: two members
    complete the §15.5 handshake + exchange a frame through the session-key-sealed channel; a
    FRESH member walks the §15.7 DAG to **byte-identical** reduced state (`roomStateCommitment`
    parity); and a real **§15.4 ICE-restart** re-offer keeps the channel alive (a frame still
    flows afterwards — the data channel + session key survived).  It earlier surfaced + fixed a
    live-ICE bug (the signaling payload dropped `sdpMid`/`sdpMLineIndex`, which a real
    `addIceCandidate` rejects).
  - **Full two-browser join+converge over the LIVE rendezvous** (WS-S launch gate) is now
    **shipped**: `apps/web/e2e/private-room-bff.realwebrtc.spec.ts` runs the ACTUAL
    `PrivateRoomSession` manager across TWO independent browser CONTEXTS (isolated IndexedDB ⇒ two
    genuinely-distinct devices) — founder A mints an HPKE-sealed §10.3 invite, joiner B opens it +
    builds a §12.3 join request, A admits it (MLS Add → the §14.5 grant), B `completeJoin`s, then
    BOTH `connect()` over the REAL server-blind rendezvous endpoint (`POST /v1/private-rendezvous/*`,
    dev-proxied to the in-memory API — no in-page bridge, no shared epoch keys) and a real Chromium
    `RTCPeerConnection`, complete the §15.5 handshake, and converge to **byte-identical**
    `roomStateCommitment` after each authors a story.  The realwebrtc config now boots the
    in-memory API alongside the Vite dev server, and the harness (`e2e-room-harness.ts`) re-exports
    the real manager.  Stable across repeats + the whole realwebrtc suite.
  - **Carrier resilience** (§15.4) is **shipped**: ICE-restart recovers a TRANSIENT path
    failure IN PLACE on the live `RTCPeerConnection` — a connection/ICE-state watcher debounces
    a `disconnected` blip (and restarts immediately on `failed`), the OFFERER re-offers with
    `iceRestart` over the still-live sealed signaling (calling `pc.restartIce()` when available)
    while the answerer renegotiates, the SAME data channel + the membership-proven session key
    are preserved (no re-handshake), restart attempts are BOUNDED per episode and reset on
    recovery, and on exhaustion the channel drops → `maintainConnection` re-dials.  The
    deterministic state machine is unit-covered (`src/private-p2p/__tests__/ice-restart.test.ts`:
    in-place recovery, bounded retries, offerer-initiates, disabled).
  - **Multi-peer mesh** (WP-7 / finding 14): the implementation is **shipped + unit-proven**
    (`maintainMesh` + `PrivateRoomSession.connectMesh` — fill-to-`maxPeers`, remove-on-drop,
    re-poll; `connectPrivatePeer` skips already-connected peers + returns the verified peer id).
    What REMAINS: the end-to-end multi-browser mesh proof under real loss (the unit tests cover
    the logic; the live 3-peer fan-out is part of the physical-radio field slice).
  - Mounting the grant-delivery + media affordances on the room UI beyond the copy-paste
    `InvitePanel`/`JoinPanel`.
  - **Reducer contribution-tree parity (WS-S.5.3c).**  `contribution.create` now enforces the
    same-thread-parent rule (`parent_thread_mismatch`) and the depth ≤ `MAX_CONTRIBUTION_DEPTH`
    cap (`max_depth_exceeded`) that the WS-G server enforces, computed deterministically by
    walking the converged `parentContributionId` chain (`reducer/reduce.ts`).  **Deferred (tracked
    debt):** the `lens-in-room` clause named in `schemas/ops.ts` is NOT yet enforceable — the
    private-room protocol has no lens op or lens registry state, so a `contribution.create`'s
    optional `lens_id` cannot be validated against a room lens set.  **Closure target:** model
    lenses in the private plane (a `lens.create` op + a `lenses` map in `RoomReducerState`, both
    folded into `roomStateCommitment`) and validate `lens_id` membership in the reducer, mirroring
    the WS-G.2.2 steward-lens surface.  Until then the reducer accepts any `lens_id`.
  - **Threshold recovery M-of-N enforcement (WS-S.3.6c).**  `evaluateRecoveryThreshold`
    (`reducer/recovery-threshold.ts`) is the COMPLETE, determinism-preserving decision function —
    it counts distinct still-active `recover`-capable admins for a recovery request — but nothing
    CONSUMES it to gate a re-admit yet.  **Deferred (tracked debt):** the reducer's `applyMemberAdd`
    has neither the room-configured threshold M nor a linkage from `member.add` to the recovery
    request whose authorizations it should check, so the §12.6.1 gate is NOT enforced.  **Closure
    target:** (a) thread the manifest membership policy (`threshold.required`, `threshold.eligible_role`)
    into the deterministic fold (seed it at genesis / pass the verified manifest into `reduceRoom`) so
    every peer evaluates the same M; (b) add a recovery linkage to the re-admit op (a
    `recovery_request_id` on `member.add` or a dedicated re-admit op); (c) reject the re-admit in
    `applyMemberAdd` unless `evaluateRecoveryThreshold(...).authorized` AND the recovering member
    matches; (d) widen the counting basis to the `admin` capability when `eligible_role === 'admin'`.
    Until then WS-S.3.6c is NOT shipped-enforced.

**WS-S.10 — the hardened update channel + WS-O substrate — is shipped:**
- `packages/shared/src/update/` is the PURE, fail-closed verify-before-unlock core
  (`verifyUpdateManifest` / `decideUpdateActivation`): a private room activates ONLY
  when the running bundle is maintainer-Ed25519-SIGNED over a body whose
  `bundle_digest` equals the SHA-256 of the RUNNING bytes, PRESENT in the append-only
  transparency log (proven by an RFC 9162 inclusion proof against a log-signed
  checkpoint), and NOT stale (anti-rollback).  Anything else — unsigned, untrusted
  signer, digest mismatch, bad checkpoint signature, a proof that does not reconstruct
  the signed root, or any read/crypto failure — yields a typed UNTRUSTED verdict that
  LOCKS the rooms.  There is no soft pass and no "unknown ⇒ allow" branch.
- `apps/web/src/update/` is the client gate (`assertPrivateBundleTrusted` hashes the
  running bundle, verifies, and locks on failure with the §20.6 copy) + the SW pinning
  that refuses a silent takeover by an unverified bundle.  The new `check:update-channel`
  CI gate proves that wiring stays present.  `ensurePrivateBundleTrusted()` is wired
  into `PrivateRoomSession.{create,load}` and `loadPrivateRoomEngine`, engaged only
  when a signer set is build-pinned.

**WS-S.9 — server→private migration — is now functional end-to-end:**
- The §24 copy SSOT + the `planMigration` decision core (Fresh/Selected/Full/Redacted
  + honest leakage disclosures) were already shipped; now the server-export half + the
  wizard are wired.  `apps/api/src/forum/migration-export.ts`
  (`exportRoomForMigration` / `freezeRoomForMigration` / `purgeRoomForMigration`) is
  steward-gated (404-over-403, never a membership oracle) and refuses p2p rooms; a
  server-enforced read-only freeze (migration `0047`, a `frozen` flag) gates purge
  fail-closed (freeze-before-purge, so the §8 disclosure stays honest), with
  `purge`/`anonymize` modes.  `POST /v1/rooms/:roomId/migration/{export,freeze,purge}`
  expose it.
- The 6-phase `MigrationWizard` (`apps/web/src/components/migration/`, the
  `/private/migrate` route): disclose → create the P2P destination → choose import
  mode → re-invite members → freeze the old room → purge/minimize.
  `apps/web/src/private-p2p/migrate.ts` (`reauthorIntoPrivateRoom`) runs `planMigration`
  over the export and re-authors each planned item into the destination session via
  `postStory`/`postComment` (which ENCRYPT as they author — the server never sees the
  re-encrypted content).

**WS-S.11 — the audit suite — is shipped** (`packages/private-p2p` +
`apps/api/src/__tests__`): a 3+-peer convergence matrix (star / chain-relay /
concurrent-author / out-of-order+duplicate topologies, asserting identical
`roomStateCommitment`), the no-server-content umbrella audit (the §8.1/§8.2 column
denylist + the endpoint 409/404/feed-409 rejections + the gated §8.3-trigger leg),
and the rendezvous-privacy audit (opaque-only storage, `.strict()` identity-field
rejection, the §8.2 allowlist, the TTL upper bound, transient signals) — which fixed a
latent `DrizzleRendezvousStore.poll` Date-bind bug (it now binds `gt(expiresAt,
new Date(nowMs))` as a proper param, mirroring the cleanup `lte`).  A pinned
known-answer **SAS (safety number)** vector locks `computeSafetyNumber` against drift.

See `docs/private-p2p/SECURITY-REVIEW.md` (WS-S.11) for the threat model +
mitigations + residual-risk map.

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
| **WS-S.1.2b** | The §21.1–§21.4 **directory-stub API** the `private_room_stubs` table existed for: `POST /v1/private-rooms` (mints the P2P room shell + its stub in one transaction, all four §4.1 axes set together so the coherence CHECKs decide validity, not the call site), `GET /directory` (the §4.2 public browse of `listed` rooms — display metadata only, keyset-paged, `unlisted` filtered in the QUERY so existence is never enumerable), `GET /:id/bootstrap`, `PATCH /:id`, `POST /:id/delist`, `DELETE /:id`. Doctrine carried by the surface rather than by review: the strict wire schemas make a private CID / op head / member list *unrepresentable*; display metadata is `listed`-only and an `unlisted` request carrying it is REFUSED (never silently stripped); `signed_stub` — the one free-form field a column allowlist cannot see into — is scanned for the §8.1 classes at any depth; an `unlisted` bootstrap read needs the invite-derived blind token and a wrong token returns the SAME 404 as an unknown room (§15.3.1 applied to the directory, constant-time compared); the room shell's `name`/`slug` are opaque so a private room's title never reaches the generated `search_vector`; `DELETE` says it removed *Licio's directory record*, not the room. Writes are session-authenticated and budgeted PER ACCOUNT (§19.1 — no client address is ever read); the bootstrap read is open, because an invitee may hold no Licio account. `roomVisibleToUser` now excludes p2p shells from `GET /v1/rooms` — listing them would publish the existence of every `unlisted` room | `apps/api/src/routes/private-rooms.ts`, `apps/api/src/private-rooms/{stores,drizzle-store,service}.ts`, `apps/api/src/forum/rooms.ts`, `apps/api/src/__tests__/private-rooms-stub.test.ts` |
| **WS-S.1.3** | The endpoint rejection guards: `POST /v1/stories` → `409 p2p_room_requires_client_sync` BEFORE any side effect; the contribution path → `404` (defense in depth); `GET /v1/rooms/:id/feed` → the UNKNOWN-ROOM `404` (the distinctive 409 was itself an existence oracle; the refusal now lives in `roomContentVisibleToUser`, ahead of every visibility rule, so every content surface inherits it). Server uploads can only attach via the now-guarded submission/contribution flows (no direct upload→room path). The server room-create route hard-codes `storage_mode='server'` | `apps/api/src/ingestion/submission.ts`, `apps/api/src/forum/contributions.ts`, `apps/api/src/routes/{v1,rooms,stories}.ts` |
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
| **WS-S.5.3 / 5.3a** | The structural §14.2 pre-pass (room match, missing-dependency quarantine, Lamport-after-parents, per-device monotonic sequence / device-fork catch, duplicate op id) AND the §14.2 stage-1 op wire-codec (`sealOp`/`openOp`): seal a `PrivateRoomOp` into a signed `PrivateEncryptedEnvelope`, and reverse it fail-closed (signature → AEAD-open → schema → plaintext-vs-signed-metadata cross-check), one shared object-type map + AAD construction so the two cannot drift | `reducer/{validate,validate-op}.ts` |
| **§10.4 device blind + intake composition** | `deriveAuthorDeviceIdBlind` — the per-epoch device pseudonym the spec names but leaves underivable: `HMAC-SHA256(HKDF-Expand-Label(room_epoch_secret, "author-device-blind.v1", room_id_commitment), canonical(["author-device", device_id, epoch]))` (the §10.2 labeled-HKDF + §15.3 HMAC-blind patterns; deterministic + per-epoch unlinkable).  `buildOpIntakeContext` composes reduced state + held epoch keys into the `openOp` context — recomputing every known device's blind id from its recorded `signing_public_key` — so `sealOp`/`openOp` round-trip against REAL room state, closing the wire-intake composition the §14.2 pipeline needs | `crypto/device-blind.ts`, `reducer/intake-context.ts` |
| **WS-S.5.6** | §14.5/§25.6 snapshots: `computeStateRoot` (SHA-256 over the canonical reduced-state commitment, order-independent) + `verifySnapshotRoot` (verify-before-use — a forged/stale root never substitutes for replay) + the §25.6 cadence predicate + `mayCompactHistory` (encrypted history retained by default; compaction needs policy + member agreement) | `reducer/snapshot.ts` |
| **WS-S.5.7** | §14.6/§19.2 per-member DEVICE-LOCAL moderation overlays (`hidden_members`/`hidden_contributions`/`muted_threads`/`blocked_media`): `projectVisibleView` (removes tombstoned content + the local hides/mutes/blocks, sorted) + deterministic `exportOverlay`/`importOverlay` (the only way an overlay leaves the device) — distinct from signed room moderation ops and from platform moderation (which can never touch a P2P room) | `reducer/overlay.ts` |
| **WS-S.5.8** | §13.7/§18.1/§25.7 local-only encrypted search: a local inverted index over decrypted reduced state (titles + bodies) with AND-semantics querying + `indexExtraText` (citation/attachment-alt) + the at-rest shard AEAD (`aeadSeal`/`aeadOpen`).  NO server FTS/embedding/query path for a private room | `reducer/search.ts` |

### WS-S.6 — P2P sync + rendezvous (the pure decision plane)

The transport-independent, server-blind discovery + reconciliation logic.  The
live WebRTC carrier (over the existing `@licio/lcap-p2p`) and the §29 server
rendezvous endpoint (WS-S.6.6) build on this pure core.

| Card | What shipped | Where |
|---|---|---|
| **WS-S.6.1a/6.1b** | §15.2/§15.3 blind rendezvous: `room_blind_id`/`peer_blind_id` = HMAC-SHA256 over a CANONICAL message (never `||`); the §15.3.1 authorization property (the `rendezvous_key` IS the capability; a removed member loses it at the next epoch); sealed announcements (AEAD AAD-bound to the record); the §15.3.2 mitigations (coarse buckets + clamped 5–30 min TTL, per-peer jitter, cover records, high-risk discovery steering) | `sync/rendezvous.ts` |
| **WS-S.6.2** | §15.4 encrypted signaling: `sealSignal`/`openSignal` carry SDP/ICE E2E-encrypted inside an opaque `EncryptedSignal` (the server routes blobs, reads no SDP/ICE); the AAD binds the routing fields; relay-only transport mode suppresses IP-revealing ICE candidate types | `sync/signaling.ts`, `crypto/ecdh.ts`, `sync/secure-channel.ts` |
| **WS-S.6.3** | §15.5 membership-proving handshake: `HandshakeHello` exchange → device-key proof over a transcript binding room/epoch/version + both ephemeral keys + nonces → `verifyPeerHandshake` (fail-closed admission BEFORE block exchange) → `deriveHandshakeSessionKey` (epoch-bound ephemeral ECDH) | `sync/handshake.ts` |
| **WS-S.6.4** | §15.6/§15.7/§15.8 head-sync: `computeHeads` (accepted-DAG frontier) + coarse op-count bucket; frontier-first reconciliation (`wantedHeads` → `missingParents` to causal closure); the §15.8 fetch order + the §15.7 block request/response + `decideBlockServe` (refuse-large) + capped backoff | `sync/head-sync.ts` |
| **WS-S.6.5** | §15.9 offline encrypted-archive (CAR): a ciphertext-only, per-room container of encrypted envelopes; `importBlockArchive` re-runs the §14.2 stage-1 validation on EVERY envelope (no container-conferred trust) before any reduce | `sync/archive.ts` |
| **WS-S.6.6** (server) | §15.3/§15.4/§21.5/§27.2 the server-blind rendezvous endpoints `POST /v1/private-rendezvous/{announce,poll,signal,signal/poll}`: opaque-only (blind ids + ciphertext + TTL, no room/account map), the server-side TTL clamp + bounded body/field sizes, the §15.3.1 no-existence-oracle (`poll` always returns a bounded list, never 404), aggregate-only metrics, IP-free global rate limits, CSRF-exempt (sessionless).  Presence persists to the migration-`0044` `private_rendezvous_records` table (gated Postgres adapter); signals are transient (in-memory mailbox).  This is server-side and deliberately does NOT import `@licio/private-p2p` (the server is blind) | `apps/api/src/private-rendezvous/{stores,service,drizzle-store}.ts`, `apps/api/src/routes/private-rendezvous.ts` |

The pairwise secure channel (`sync/secure-channel.ts`) is the substrate shared by
§15.4 signaling and the §15.5 handshake: `deriveChannelKey` =
`HKDF-Expand-Label(HKDF-Extract(0, X25519-ECDH), label, transcript, 32)`, bound to
the protocol version, room-id commitment, epoch, and both (sorted) ephemeral
public keys — fresh per connection, epoch-bound, replay/cross-room-proof.

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
| `packages/private-p2p` | the canonical + strict-schema suites; the **WS-S.3 crypto suites** — RFC 5869 HKDF vectors, the AEAD round-trip/AAD-flip/replay/nonce-uniqueness suite, the Ed25519 KATs + RFC 9180 HPKE interop + RFC 7748 X25519 + RFC 4231 HMAC KATs, the MLS multi-device/epoch/manifest-fork suite, the four-tier key store + recovery kit + threshold recovery, and the forward-secrecy/fuzz properties; the **WS-S.4.2/5 reducer suites** — the CIDv1 multiformats/RFC-4648 pins, the Lamport/canonical-order tests, the reducer genesis/capability/conflict matrix, the §14.3.3 25-shuffle determinism property, the structural pre-pass + the §14.2 stage-1 op-codec seal→open→reduce matrix, and the §14.5/§14.6/§13.7 snapshot/overlay/search suites; **and the WS-S.6 sync suites** — blind rendezvous derivation/authorization/mitigations, the X25519 ECDH agreement, the transcript-bound channel-key separation, signaling seal/open + relay-only ICE filtering, the handshake success + reject matrix, head-sync reconciliation-to-closure + fetch-order, and the offline-archive re-validating import, plus the §10.4 device-blind derivation + the buildOpIntakeContext seal→open-against-state composition, and the PrivateRoomEngine lifecycle + the §15.6 sync surface + the §15.9 two-engine archive convergence + the WS-S.7.1 room-lifecycle (createPrivateRoom/inviteDevice/joinRoom/buildMemberAddOp + the MLS KeyPackage codec) with the full two-device invite→join→converge membership flow + content authoring + the §10.9 removal-with-forward-secrecy flow + the §13.6 chunked-media encrypt/decrypt + the §10.3/§12.3 invite+join flow + §14.5 snapshots+compaction (452 tests; crypto + reducer + sync all ≳ 92% coverage) |
| `apps/api` | the server-gate suite: submission 409 (+ no row created), contribution 404, feed 404-identical-to-unknown, the ranking room-surface exclusion, the search filter, the event-pipeline gate; **and the WS-S.6.6 rendezvous suite** — the TTL clamp, the §15.3.1 no-existence-oracle (poll never 404s), re-announce-replaces, the signal queue/drain round-trip, aggregate-only metrics, the sweep, route shape-validation/oversized rejection, and the full-app CSRF-exempt mount |
| `scripts` | the seven §23.10 CI gates + the `check:p2p-mls-wrapper` deep-import gate + the §12.7 no-server-recovery scan, all proven to bite (clean vs violating fixtures) + the live-source marker regression catch |

## Protocol-evolution note — the §13.5 op.v1 vocabulary is frozen

A private room's log is IMMUTABLE SIGNED history: server rows and client
drafts get migrations, but a sealed `licio.private.op.v1` entry can never be
rewritten.  When the WS-G-era write taxonomy was removed, op.v1 therefore
KEPT its historical wire vocabulary (`opV1ContributionTypeSchema` /
`opV1SubmissionTypeSchema` in `schemas/ops.ts` — frozen protocol constants,
deliberately independent of the living shared taxonomy): every
historically-valid value still parses, and retired values NORMALIZE to the
live model at parse time (retired contribution types → `comment`, retired
submission types → `original_brief` — the same maps server migration 0076
applies to mutable rows), so replay/convergence can never diverge across
version skew.  New writes emit live values only (the shipped `room-manager`
never produced the retired ones).  This matches LCAP's §12.1 retention
choice; a future op.v2 may narrow the wire vocabulary itself behind a
`schema` literal bump.

## Residuals (the next slices)

The pure protocol core is complete through WS-S.6.5; the remaining work is the
I/O integration (the live transport, the server rendezvous endpoint, the client
persistence + UI):

- **WS-S.5 — complete** (5.1–5.8: the Lamport order, the deterministic fold +
  §14.4 conflict policy, the capability model, the structural §14.2 pre-pass, the
  §14.2 stage-1 op wire-codec, the §14.5 snapshots, the §14.6 local overlays, and
  the §13.7 local search).
- **WS-S.6.1–6.6 — shipped.**  The pure, transport-independent core (blind
  rendezvous, encrypted signaling + relay-only mode, the membership-proving
  handshake, head/block reconciliation + fetch-order, and the offline encrypted
  archive) **plus the server-blind rendezvous endpoint** (`POST
  /v1/private-rendezvous/{announce,poll,signal,signal/poll}`, opaque-only, the
  server-side TTL clamp, blind-id-only with no client IP, aggregate-only metrics,
  the no-existence-oracle bounded response, CSRF-exempt) over the migration-`0044`
  `private_rendezvous_records` table (gated Postgres adapter; transient signals).
- **WS-S.4.1/4.3 — the P2P transport.**  `docs/PRIVATE_SPEC.md` §9.2 recommends a
  Helia/libp2p stack, but vetting it against §6.12.12 found **580 transitive
  packages** — a supply-chain surface the LCAP plane (WS-R) deliberately rejected
  in favour of a dependency-free WebRTC + IPFS-gateway bridge.  Per the maintainer
  decision, the membership-gated **block exchange** will ride the existing
  `@licio/lcap-p2p` WebRTC carrier (the WS-R.16.1 ↔ WS-S.6.5 ciphertext seam) plus
  an IndexedDB blockstore (WS-S.4.2's client persistence half), rather than a
  fresh libp2p stack.  The live `RTCPeerConnection` wiring that consumes the
  WS-S.6.2/6.3 pure cores lands with the WS-S.7 client surface.
- **WS-S.4.4 — the public-gateway rejection guard** (a private CID must never be
  published to a public IPFS gateway) — partially covered by the shipped
  `check:no-private-cid-egress` CI gate; the runtime guard lands with the
  transport.
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

### Deep-audit follow-ups (2026-07) — dedicated slices required

Three confirmed findings from the 2026-07 deep audit are recorded here because
each needs its own protocol-design slice with a convergence/behaviour test
matrix; rushing them into a broad remediation would risk launch-blocking room
convergence.  (The tractable sibling findings — op_id binding, genesis founder
pin, NFC authoring normalization, base64url key-record pinning, the tier-3 PRF
short-output guard — were fixed in that pass.)

- **Snapshot-stability compaction (`reducer/reduce.ts`, §14.5).**  A late-arriving
  op whose canonical Lamport position sorts INSIDE an already-compacted snapshot's
  covered range is folded post-snapshot on a compacted device but in-position on an
  uncompacted one → the two states diverge.  Fix direction: the engine must only
  compact a STABLE prefix (a Lamport frontier every device has observed), so no
  future op can sort before the snapshot boundary; alternatively the validator must
  quarantine an op that sorts into a compacted range.
- **Eviction frontier (`reducer/reduce.ts` + `schemas/ops.ts`, §12/§14).**  The
  reducer rejects ops from a removed device via `device.removed`, but that flag is
  set only when the removal op is folded; an evicted device can author a NEW op with
  a Lamport BELOW its removal (and the next `author_seq`), so it sorts first and is
  accepted.  Fix direction: `member.remove`/`device.remove` must capture the removed
  device's seq/Lamport frontier (a schema addition) so any op beyond it is rejected
  regardless of fold order.
- **At-rest room-key protection (`crypto/key-store.ts`, `apps/web/.../session-store.ts`).**
  The §10.8 tiered key-store + §12.6 recovery kit are implemented + tested but have
  no runtime consumer; the session-store persists epoch secrets + MLS state as raw
  bytes (asymmetric keys are already non-extractable CryptoKeys).  This is a
  deliberate SPEC §6.9 availability-over-confidentiality default — wrapping the
  symmetric material under a non-extractable key would trade room-loss-on-eviction
  for disk-theft resistance.  The proper slice is the OPT-IN high-risk-room flow
  (passphrase/passkey unlock UX + recovery-kit import), a maintainer decision on the
  availability tradeoff — not a forced default change.

The single composition seam with LCAP (WS-R.16.1 / WS-R.11.5 / WS-S.6.5) lands
late and optionally; LCAP carries only WS-S ciphertext + opaque hints and never
sees plaintext, keys, op-heads, or real private-room ids.  Where the two
disagree for private-room content, **`PRIVATE_SPEC` wins**.

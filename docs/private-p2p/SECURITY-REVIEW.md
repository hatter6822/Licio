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
  The check is compaction-aware (a §14.5 base's covered op ids + per-device seq
  floor seed it) so a pruned parent / cross-snapshot seq is not spuriously
  quarantined; crypto-valid-but-structurally-invalid ops are retained as §15 fork
  evidence but excluded from `currentState`.
- **Forward secrecy at removal** (§10.9): `removeDeviceFromRoom` commits an MLS
  Remove that advances the epoch; the evicted device cannot derive the new epoch
  key, proven by a test where its engine quarantines post-removal content.
- **Determinism**: the reducer fold is byte-identical across delivery orders
  (§14.3.3, 25-shuffle property); compaction preserves convergence (a compacted
  and an uncompacted device produce identical state) with monotonic Lamport/seq.
  A §14.5 snapshot serializes each member's FULL capability set verbatim (not
  re-derived from role): a `role.grant`/`role.revoke` may grant/revoke an
  individual capability independent of the role, and the state root hashes the
  full set, so re-deriving from role alone would drop an individual grant and
  diverge a compacted device's authority decisions from an uncompacted one — a
  regression test pins the post-compaction state root to the snapshot's.

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

The apps/web §14.5 snapshot persistence (compact-on-cadence → prune IndexedDB
envelopes → reload-from-base) is now SHIPPED (WS-S.7), so it is no longer a
residual — the base is the device's own previously-verified computation, trusted
as local state like the at-rest epoch secrets, while peer-received content is
always re-verified through `openOp` (§8.3).

## 9. CI gates protecting these properties

`check:no-p2p-server-content`, `check:no-private-cid-egress`,
`check:private-rendezvous-schema`, `check:private-bundle-transparency`,
`check:p2p-endpoint-rejections`, `check:p2p-ranking-exclusion`,
`check:p2p-search-exclusion`, `check:private-p2p-split`, `check:p2p-mls-wrapper`,
plus `check:no-applause` / `check:no-raw-egress` / `check:lcap-schema-egress`
extended over the private trees.

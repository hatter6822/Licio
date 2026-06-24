<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# Tier-2 — Verifiable per-announcer rendezvous cap

**Status:** design proposal (not implemented). Closure target for the
"Rendezvous presence flood" row of the WS-S §38 risk register
(`SECURITY-REVIEW.md` §10). Supersedes the "infeasible" framing: a real
per-announcer cap *is* achievable without breaking server-blindness, at the
cost of an anonymous-credential layer specified here.

**Relationship to Tier-1.** Tier-1 (the implemented sample-poll,
`apps/api/src/private-rendezvous`) *dilutes* a flood probabilistically; it does
not *cap* it. Tier-2 caps each device to one rendezvous slot per
`(epoch, time-bucket)` so a single member cannot occupy more than one slot in
any poll window. Tier-2 is layered ON TOP of Tier-1 — the sample-poll remains
the fail-open floor (see §6.10).

## 0. Implementation status

**The cryptographic credential layer is SHIPPED** (`packages/private-p2p/src/crypto/bbs/`
+ `src/rendezvous-cap/`, 31 tests). Built as a THIN layer over `@noble/curves`'s vetted
BLS12-381 (no re-implemented pairing arithmetic):

| Layer | Module | Verification |
|-------|--------|--------------|
| Base BBS (KeyGen/Sign/Verify, ProofGen/ProofVerify) | `bbs/suite,signature,proof` | **IETF byte-exact vector-pinned** — `BBS_BLS12381G1_XMD:SHA-256_SSWU_RO_`, the `decentralized-identity/bbs-signature` fixtures (`P1`, generators, signature001, proof001/003 incl. the intermediate trace). Fully interoperable. |
| Per-verifier pseudonym (the nullifier) | `bbs/pseudonym` | Standard Schnorr extension on the vetted base; verified by determinism + cross-context unlinkability + soundness properties (the `-per-verifier-linkability` draft publishes no fixtures). |
| Blind issuance (admin-unlinkable) | `bbs/blind` | Pedersen commitment + Schnorr PoK; the finalized credential **verifies under the vetted base** (`bbsVerifyScalars` — the composition anchor) + structural blindness (the `-bbs-blind-signatures` draft's vectors are "TBD"). |
| Rendezvous-cap credential | `rendezvous-cap/credential` | The full cap: request→issue→prove→verify, revocation via epoch rotation, the §6.7 granularity policy. |

**Honest verification caveat.** The BASE BBS is byte-exact IETF-interop. The pseudonym +
blind layers have **no published test vectors** (their drafts mark them TBD), so they are
verified by composition with the vetted base + behavioural properties (round-trip,
soundness, unlinkability, blindness) — the strongest available short of fixtures. Re-pin to
official vectors when the drafts publish them. A `check:p2p-bbs-wrapper` gate (mirroring the
MLS one) should fence deep `@noble/curves/bls12-381` imports to `bbs/`.

**The SERVER-SIDE cap is also SHIPPED + ENFORCED** (`apps/api/src/private-rendezvous`,
7 tests). The announce gains an optional `cap` proof; a Tier-2 `peer_blind_id` IS the
base64url pseudonym, so **no new persisted column / migration was needed** (the §8.2
allowlist is unchanged — the proof is verified then discarded; the pseudonym reuses the
existing slot key). The service verifies the ZK proof via an injected verifier port
(`cap-verifier.ts`, importing only the blindness-preserving `rendezvous-cap` subpath),
keys the slot by the pseudonym (dedup = the cap), and FAILS OPEN to Tier-1 on an absent
proof / unverifiable record / no verifier. SOUNDNESS additions over the bare design: the
time bucket is validated against the server clock (a flooder cannot mint a fresh bucket ⇒
fresh pseudonym ⇒ fresh slot), and the per-`(room, epoch)` issuer key is first-seen-pinned
(verify runs against the pin, so a self-issued credential fails; a wrong pin only degrades
to Tier-1, §8 net-zero).

**The CLIENT-SIDE cap is also SHIPPED** (`src/rendezvous-cap`, 15 tests). Two pieces:
- **Client-side verified-dedup** (`poll-filter.ts`, §6.8) — `filterVerifiedPresence(...)`: a
  polling member keeps ONLY records whose proof verifies under the room issuer key, deduped
  by the verified pseudonym, bounded to its OWN clock's bucket. The relay is NOT trusted for
  the cap — the member enforces it locally, so even a malicious relay cannot crowd a client's
  view or make it connect to an unverifiable record (the "serverless cap"). Soundness tested
  against the real slot-multiplication attack (a real proof re-presented with fake pseudonyms
  fails at *verification*, not the parser).
- **Session orchestration** (`session.ts`) — `RendezvousIssuer` (the per-epoch admin:
  blind-signs a device's published commitment, exposes the public key) + `RendezvousMember`
  (a device: holds `nid` + one commitment, installs per-epoch credentials, builds announces,
  exposes the issuer key for filtering).

**The MLS DISTRIBUTION (reducer ops) is also SHIPPED** (10 tests). Credential distribution
rides the §14.3 op log with a MINIMAL converged footprint:
- `rendezvous.request` (read-capable, self-service) — a device publishes its blind
  commitment; folds to one converged field `DeviceState.rendezvousCommitment` (snapshotted),
  so any admin can issue from state + it survives compaction.
- `rendezvous.issue` (admin-only) — carries the per-epoch issuer key + each device's blind
  signature as an authenticated, authority-checked op-log EVENT with NO converged content
  state; the ephemeral cap material is extracted device-locally.
- `coordinator.ts` bridges the ops ↔ the session: `buildIssuanceOpBody` (admin) +
  `installFromIssuances` (device). The engine exposes `rendezvousCommitments()` /
  `rendezvousIssuances()` so the carrier drives it over the live engine. All convergent +
  authority-tested (a non-admin issue is rejected; the fold is order-independent).

**The apps/web CARRIER hookup is also SHIPPED** — the cap now runs in the live room:
- The §15.3 rendezvous announcement carries an OPTIONAL `cap` ({proof, pseudonym}) sealed
  INSIDE the announcement (`sync/rendezvous.ts`), so only a member who opens it sees the cap;
  the relay never does. `buildAnnouncementCap`/`verifyAnnouncementCap` are the carrier glue
  (epoch + bucket come from the record context, so announce + verify agree by construction).
- `connect-peer.ts` takes optional `rendezvousCap` hooks — the announce seals the cap, and the
  poll SKIPS any opened announcement whose cap is present-but-invalid (a fake flood record) while
  a cap-less peer rides Tier-1 (the §15.5 handshake remains the membership auth).
- `RendezvousCapManager` (apps/web) loads the `rendezvous-cap` subpath LAZILY (split-gate clean),
  holds the device's `RendezvousMember` (nid persisted) + the admin's issuer SEED (persisted;
  `RendezvousIssuer.fromSeed` derives a STABLE per-epoch issuer key), and drives publish →
  install → issue over the engine reads. `PrivateRoomSession.syncCap` advances the cap after
  every ingest + before each dial (connect AND mesh re-dial) and passes the hooks into
  `connectPrivatePeer` — fail-open to Tier-1 throughout. Proven end-to-end: a real session
  authors its `rendezvous.request` on ingest (folds into device state), idempotently.
- The nid + issuer seed persist in a v4 `cap_secrets` store in the private-p2p IndexedDB (per
  `(roomId, field)`) — the SAME trust boundary as the room epoch keys, off origin-wide
  localStorage (round-trip + cross-room isolation tested).
- The **flood adversary is tested through the real carrier**: a flooder enrolled under a
  DIFFERENT issuer publishes 20 well-formed-but-unverifiable cap announcements; with the cap
  hooks `connectPrivatePeer` skips every one and never reaches the dial path (`rtcFactory`
  count 0), while without the cap a fake is dialed — the cap demonstrably protects the dial
  budget.

**Remaining (residual): two refinements + a live-browser run** — drive enrollment continuously
during live sync (the `PrivateSyncSession`'s own ingests, not only on connect/explicit ingest);
and confirm the cap on a two-browser WebRTC convergence run on real radios (the same real-device
residual the rest of the WS-S carrier carries — the node carrier test already exercises the full
code path). The server-side enforcement remains an available second layer (the announce can
additionally carry the §6.7 server `cap` fields). Throughout, unenrolled clients and the server
ride Tier-1 (a strict superset).
This slice modifies the security-critical reducer/op model, so it is scoped as its own
focused pass (the crypto + server enforcement + client dedup + session it builds on are all
shipped + tested).

---

## 1. Problem & goal

The server-blind rendezvous (`PRIVATE_SPEC` §15.3) lets a room's members find
each other to set up P2P links. A peer announces a presence record under a
per-epoch-per-bucket pseudonym:

```
peer_blind_id = HMAC-SHA256(rendezvous_key, canonical(["peer", device_id, epoch, time_bucket]))
```

The server stores opaque records keyed by `room_blind_id`; `poll` returns up to
`maxRecordsPerPoll` live records. The server holds **no `rendezvous_key`**, so
it **cannot verify** a submitted `peer_blind_id` derives from a real device — a
member (who holds the key) feeds arbitrary `device_id` strings into the HMAC and
mints unlimited valid-looking blind-ids, flooding the poll window.

**Goal.** Let the server **enforce** "≤ 1 presence slot per device per
`(epoch, bucket)`" — rejecting a member's extra fabricated records — **without**
the server learning any durable room / device / account identity and **without**
weakening the existing unlinkability of the blind-id across buckets and epochs.

## 2. Threat model & trust boundaries

| Party | Trust | What it must NOT be able to do |
|-------|-------|--------------------------------|
| **Server** (rendezvous relay) | Untrusted-but-available (honest-but-curious; may log everything; will not selectively withhold to honest peers beyond protocol) | Link a record to a real room / device / account; link two records to the same device across buckets or epochs; learn membership beyond per-epoch set *size* |
| **Network observer** | Untrusted, may be global passive | Same as the server, plus traffic-analysis (covered by existing §15.3.2 jitter/cover-records, out of scope here) |
| **Member** (holds `rendezvous_key`) | Semi-trusted (inside the room) | Occupy more than one slot per `(epoch, bucket)`; produce a record that verifies but is not theirs |
| **Removed device** | Untrusted after removal | Announce in any epoch after its removal |
| **Issuing admin** (the per-epoch committer) | Semi-trusted authority | **Even the admin must not** link a pseudonym to a device (see §7) |

**Baseline already assumed by the system.** A member holds `rendezvous_key` and
the device roster, so a member can ALREADY compute every other member's
`peer_blind_id` for any bucket — i.e. a *member–server collusion* can already
deanonymize the current rendezvous. Tier-2 MUST NOT make this worse, and SHOULD
improve it (a member learns the *blind-id* but, under §6.3, not the *pseudonym
secret*, so it cannot link Tier-2 pseudonyms either).

## 3. Invariants Tier-2 must preserve

1. **Server-blindness (§15.3.1).** The server learns no durable identity; every
   value it stores or verifies against is a per-epoch *pseudonym* (no more
   revealing than today's `room_blind_id`).
2. **Cross-bucket + cross-epoch unlinkability (§15.3.2).** The server cannot link
   two announces to the same device across buckets or epochs.
3. **No proof-of-work (§27.4), no client network address (§19.1).** Both are
   doctrine-excluded — they would cap a flood but violate the identity-free /
   no-PoW posture.
4. **Fail-open availability.** A missing/garbled credential, a server without the
   verification key, or any verification fault MUST degrade to Tier-1
   (sample-poll), never lock an honest member out of the rendezvous.
5. **Lean.** No trusted setup; no general-purpose SNARK prover in the browser
   bundle; thin wrappers over a vetted, suite-pinned primitive; minimal new
   server state and O(1) per-record verification.
6. **No new trusted party.** The cap must rest on the room's *existing* authority
   (the MLS committer), not a third-party issuer or accumulator operator.

## 4. Why the easy approaches fail (impossibility argument)

- **Server-side cap by counting blind-ids.** Impossible — the server cannot tell
  a member's many fabricated blind-ids from many honest devices (it has no key).
- **Shared-secret MAC on the announce.** Any value derived from a *shared* key
  (the `rendezvous_key` / epoch secret) is forgeable by *any* member, so it
  cannot bound one member. A cap needs a credential tied to the device's OWN
  secret.
- **Revealing a stable per-device token each bucket.** Caps, but the *same*
  token across buckets is LINKABLE to the server → breaks invariant 2.
- **One issued token per bucket.** Unlinkable (different token each bucket) but
  the number of buckets per epoch is unbounded (an epoch lasts until the next
  membership change), so the issuer cannot pre-issue.

⇒ The only construction satisfying {bounded issuance, *unlimited* unlinkable
shows, a per-bucket cap} is an **anonymous credential with per-context
pseudonyms**: issue ONE credential per device per epoch; derive an unlimited
sequence of unlinkable per-bucket pseudonyms; the server dedups by pseudonym.

## 5. Design space

| Primitive | Issuance | Unlinkable shows | Trusted setup | Browser cost | Maturity | Verdict |
|-----------|----------|------------------|---------------|--------------|----------|---------|
| **BBS+ with per-verifier pseudonyms** | 1 / device / epoch (non-interactive, rides MLS) | Unlimited | None (BLS12-381) | Medium (pairings; ~point ops) | IRTF CFRG draft (maturing) | **Recommended** |
| ZK set-membership + nullifier (Semaphore) | None (membership IS the credential) | Unlimited | Groth16: yes / Halo2: no | High (SNARK prover, MBs) | Battle-tested (Groth16) | Alternative (§10) |
| Blind tokens / VOPRF (Privacy Pass, RFC 9474/9497) | N / device / epoch (interactive) | N (one per token) | None | Low | RFC-standard | Rejected: per-bucket re-issuance unbounded; interactive |
| Light revealed Ed25519 tokens | N / device / epoch (non-interactive) | N, but LINKABLE | None | None (reuses Ed25519) | n/a | Rejected: breaks invariant 2 |

The recommended primitive is **BBS signatures** (`draft-irtf-cfrg-bbs-signatures`)
with two extensions: **blind issuance** over a committed message
(`draft-irtf-cfrg-bbs-blind-signatures`, so the issuer signs `Commit(nsk)`
without learning `nsk`) and **per-verifier-linkable pseudonyms**
(`draft-irtf-cfrg-bbs-per-verifier-linkability` / "BBS pseudonyms", the
per-context nullifier). Together they uniquely give bounded (single)
non-interactive issuance + unlimited unlinkable shows + a per-context nullifier,
with no trusted setup, over BLS12-381 (already reachable via `@noble/curves`).

## 6. Recommended design — BBS+ per-epoch credential + per-bucket pseudonym

### 6.0 End-to-end at a glance

```
JOIN (once):     device → room: ncommit = Commit(nsk)          [in member.add]
EPOCH ROTATE:    admin  → device: cred = BlindBBS.Sign(isk_e, ncommit, epoch)   [in the MLS commit]
                 (admin learns ncommit, never nsk → cannot compute nym)
ANNOUNCE (per bucket):
  device:  ctx = H(room_blind_id, "rendezvous", epoch, bucket)
           nym = BBS.Pseudonym(nsk, ctx)
           π   = BBS.ProveShow(cred, ipk_e, ctx, nym)          [reveals only nym]
           → server: {room_blind_id, peer_blind_id, encrypted_announcement,
                      presence_nym = nym, presence_proof = π, ipk_e, expires_at}
  server:  pin ipk_e for (room_blind_id, epoch) on first sight;
           BBS.VerifyShow(π, ipk_e, ctx, nym) ? store under key nym : reject;
           (no ipk_e / verify-fault ⇒ FAIL-OPEN to Tier-1 sample-poll)
POLL:      server returns a Tier-1 uniform sample of the live (now-credentialed) records
REMOVE:    next epoch rotation does not re-issue the device ⇒ its π fails vs ipk_{e+1}
```

### 6.1 Roles & keys

- **Issuer = the per-epoch MLS committer (an admin).** Each MLS commit rotates
  the epoch (`room_epoch_secret`, §epoch bridge). The committing admin holds a
  per-epoch BBS **issuer secret key** `isk_e`, derived deterministically from
  *its own* admin key + the epoch (so a removed/old committer cannot issue for a
  new epoch). The matching `ipk_e` is the public verification key.
- **Server** holds only `ipk_e` for the current epoch (and a short grace window
  of recent epochs), published as an opaque per-epoch value — privacy-equivalent
  to `room_blind_id`.
- **Device** holds a long-lived **pseudonym secret** `nsk` committed once at join
  (§6.2), and a per-epoch BBS credential over `(commit(nsk), epoch)`.

### 6.2 Issuance (non-interactive, over MLS)

1. At **join** (§12.3 `member.add`), the device generates `nsk` and publishes a
   hiding commitment `ncommit = Commit(nsk)` as a new device-record field
   (alongside `signing_public_key`). The admin never learns `nsk`.
2. At **each epoch rotation** (every add/remove commit), the committing admin
   blind-BBS-signs, for every current device, the messages `(ncommit_d, epoch_e)`
   under `isk_e`, and delivers each device its credential `cred_{d,e}` inside the
   MLS-protected commit payload (one-directional; no round-trip). The credential
   is valid for the **whole lifetime of epoch `e`** — a stable room (no
   membership change) needs exactly ONE issuance, with **no liveness burden** and
   no periodic re-issue.
3. *(Optional hardening, off by default.)* A high-risk room (§33 mode) MAY bound
   a leaked credential's damage window independently of the epoch via a coarse
   `rendezvous.reissue` op; this is a policy choice, NOT a correctness or
   availability requirement.

Issuance is **blind**: the admin signs a hiding commitment `ncommit` (published
once at join, §6.2.1), never `nsk`. Since the pseudonym (§6.3) is a function of
`nsk`, **even the issuing admin cannot compute a device's pseudonym** — issuance
reveals the credential↔device mapping to the admin but NOT the pseudonym↔device
mapping, so an admin–server collusion still cannot link pseudonyms (§7).

### 6.3 Per-bucket pseudonym (the nullifier)

For context `ctx = canonical([room_blind_id_e_b, "rendezvous", epoch, bucket])`
(the same `(epoch, bucket)` granularity as today's `peer_blind_id`), the device
derives the BBS **pseudonym**

```
nym = Pseudonym(nsk, ctx)          // deterministic in (nsk, ctx); unlinkable across ctx
```

`nym` is stable within a bucket (a refresh re-announce reuses the same slot) and
independent across buckets and epochs (BBS-pseudonym unlinkability).

### 6.4 The announce proof

The device produces a BBS **proof** `π` that:

- it holds a credential `cred` valid under `ipk_e` over messages
  `(ncommit, epoch)` with `epoch = current`, AND
- `nym = Pseudonym(nsk, ctx)` for the opening `nsk` of `ncommit`,

revealing **nothing else** (not `ncommit`, not the device, not `nsk`). `π` is a
sigma-protocol-style proof (no SNARK), a few BLS12-381 elements.

### 6.5 Wire format & §8.2 allowlist extension

The announce gains exactly two opaque fields, added to the §8.2 ALLOWLIST
(`packages/db/src/private-room-guard.ts`) and the server-local zod schema:

| Field | Type | Meaning |
|-------|------|---------|
| `presence_proof` | bounded base64 (≤ ~2 KiB) | the BBS proof `π` (opaque to the server) |
| `presence_nym` | base64 (fixed) | the pseudonym `nym` (the dedup key) |

`peer_blind_id` is RETAINED (the announcement remains AAD-bound to it); `nym`
becomes the slot key. The §8.1 DENYLIST (no IP / account / CID / member) is
unchanged; the new fields are pseudonymous proofs, not identity.

**Issuer-key distribution (no extra admin write).** `ipk_e` is the BBS public key
for the epoch; every member receives it in the same MLS commit that issues the
credential, so it is NOT secret. The server learns it WITHOUT a dedicated admin
publication: the first announce of an epoch carries `ipk_e`, and the server PINS
the first value it sees for that `(room_blind_id, epoch)` and verifies all later
announces of that epoch against the pin (swept on epoch change). This keeps the
server a dumb relay (no privileged "publish key" endpoint, no room linkage beyond
the existing per-epoch `room_blind_id`). A malicious member who races a WRONG
`ipk_e` into the pin makes honest proofs fail-verify → the room **degrades to
Tier-1** (§6.10) — it does NOT lock anyone out, and that member could flood Tier-1
anyway, so the attack is net-zero (§8). A room wanting to remove even this
downgrade vector MAY have the admin pin `ipk_e` out-of-band via a one-time
per-epoch write (the §11 hardened variant).

### 6.6 Server verification & dedup

On `announce`:

1. Look up `ipk_e` for the announce's referenced epoch (current or within the
   grace window §9); absent ⇒ **fail-open** (§6.10).
2. Verify `π` against `ipk_e` and the reconstructed `ctx`. Invalid ⇒ reject the
   record (do NOT store).
3. Key the presence slot by `nym`: `perRoom.set(nym, record)` (replacing the
   existing per-`peer_blind_id` keying). A refresh overwrites; a *different*
   `nym` is a *different* device → a different slot.

Verification is O(1) per record (a fixed number of pairings). The per-room cap +
sample-poll (Tier-1) still apply on the now-credentialed set.

### 6.7 Cap parameterization & analysis

- **Cap = 1 slot per device per `(epoch, bucket)`.** A device has exactly one
  `nym` per `ctx`; the server dedups by it. A member with one device cannot
  exceed one slot in the current bucket's poll. A member with `k` devices gets
  `k` slots — bounded by membership (the roster), which is the intended trust
  boundary.
- **Across buckets:** different `nym` ⇒ no cross-bucket linkage (invariant 2).
- A flooder cannot fabricate extra `nym`s: producing a valid `π` for an unseen
  `nym` requires a credential, which requires `isk_e` (the admin's) or a second
  committed `nsk` (a second roster device).

**Granularity is a room policy (manifest flag), default `per-bucket`:**

| Policy | `ctx` binds | Cap | Unlinkability | Use |
|--------|-------------|-----|---------------|-----|
| `per-bucket` (default) | `(epoch, bucket)` | 1 slot / device / bucket | full (no cross-bucket linkage) | preserves §15.3.2; recommended |
| `per-epoch` | `(epoch)` | 1 slot / device / epoch (stronger) | the server links a device's announces WITHIN an epoch (same `nym`) | only a low-unlinkability-risk room that wants the tighter cap |

`per-bucket` is the default because it preserves the existing §15.3.2 property;
`per-epoch` is offered only as an explicit, documented trade.

### 6.8 Client poll

`poll` is unchanged on the wire; the client receives the (Tier-1-sampled)
records and MAY additionally re-verify `π` locally (defence-in-depth) and ignore
unverifiable ones. The pseudonyms carry no information the client needs to
correlate (it dials by the sealed announcement, §15.4).

### 6.9 Revocation & forward secrecy

- A **removed device** is not re-issued at the next rotation (the admin signs
  only current devices), so it holds no credential for the new epoch; its proof
  fails against the new `ipk_e`. Removal ⇒ epoch rotation ⇒ exclusion, riding the
  existing MLS forward-secrecy machinery.
- **Epoch rotation** invalidates all old credentials (new `isk_e`/`ipk_e`); the
  grace window (§9) covers the brief transition only.

### 6.10 Fail-open degradation (best practice)

Availability dominates the cap. The system MUST degrade gracefully:

- A server with **no `ipk_e`** for the room (Tier-2 not provisioned, or a stale
  epoch beyond the grace window) accepts records WITHOUT proof and falls back to
  the **Tier-1 sample-poll** — never rejecting honest members.
- A client that **cannot build a proof** (issuance not yet received, a library
  fault) announces WITHOUT a proof; such records are sampled by Tier-1 (they just
  do not benefit from the cap).
- Tier-2 is a per-room **opt-in** (a manifest flag); a room that has not enabled
  it runs exactly as today. This is a strict superset — never a regression.

## 7. Privacy analysis

- **Server-blindness:** the server stores `nym`, `π`, the existing opaque fields,
  and per-epoch `ipk_e` — all pseudonymous, none mapping to a real room/device.
- **Unlinkability:** BBS-pseudonym unlinkability gives independent `nym` per
  `ctx` ⇒ no cross-bucket/epoch linkage (preserves §15.3.2). The proof `π` is
  zero-knowledge beyond `nym`.
- **Admin collusion:** the admin learns `cred↔device` at issuance but not
  `nsk` (it signed a commitment), so it cannot compute `nym` ⇒ an admin–server
  collusion cannot link pseudonyms. This is STRICTLY better than the status quo,
  where a member can compute every `peer_blind_id`.
- **Set-size leakage:** the server learns the count of distinct `nym`s per
  `(room_blind_id, bucket)` (≈ online-member count, already inferable today from
  distinct `peer_blind_id`s — mitigated by the existing §15.3.2 cover records).

## 8. Security analysis

- **Soundness (non-members excluded):** a valid `π` requires a credential under
  `isk_e`; a non-member has none. BBS unforgeability (BLS12-381, the pinned
  suite) is the assumption.
- **Cap bound:** one `nym` per `(device, ctx)`; forging a second requires `isk_e`
  or a second roster device. ✔
- **Malicious admin:** can over-issue to sock-puppet devices, but those are
  visible roster members — bounded by, and accountable through, the existing
  membership model (an admin can already grief a room). Out of Tier-2's scope.
- **Replay / nym-grinding:** `ctx` binds `(epoch, bucket)`; a replayed proof
  yields the SAME `nym` (one slot, refresh) — no amplification. A proof from
  another room verifies under a different `ipk_e` ⇒ rejected.
- **Downgrade (net-zero):** an attacker can disable Tier-2 for a room only by
  (a) stripping `presence_proof` — its record then rides the fail-open Tier-1
  path with NO cap exemption, or (b) racing a WRONG `ipk_e` into the server's
  first-seen pin so honest proofs fail-verify → the room falls to Tier-1. Either
  way the WORST outcome is "the room runs as Tier-1," which an inside attacker
  could already do by flooding. Downgrade buys nothing beyond the status quo, and
  availability is never harmed. (The §11 hardened `ipk_e` pin removes vector (b).)
- **Cap-abuse / junk slots:** a member's ONE permitted slot may carry a junk
  sealed announcement. The cap bounds this to one junk record per device per
  bucket — the polling peer simply fails to connect to it and tries the next,
  exactly as today; no amplification.
- **Nym uniqueness vs. collisions:** `nym` is a BBS pseudonym over a
  collision-resistant context; two honest devices derive distinct `nym`s
  (distinct `nsk`), so no honest device evicts another's slot.

## 9. Operational concerns

- **Issuance liveness:** issuance rides the MLS commit (no extra round-trip), and
  a credential is valid for its epoch's WHOLE lifetime, so a stable room needs NO
  periodic re-issue and imposes NO admin-liveness burden (the §6.2.3 reissue is
  optional hardening only). The admin is involved exactly when it already is — at
  add/remove (which is also precisely when revocation is needed). If a brand-new
  device's credential never arrives (a faulty issuer), that device simply rides
  Tier-1 (fail-open) — availability is never lost.
- **Grace window:** the server accepts `ipk_{e}` and `ipk_{e-1}` for a bounded
  skew so a member mid-rotation is not rejected.
- **Server state:** `+1` per-epoch issuer key per room-pseudonym + the existing
  per-record storage; swept on epoch change. O(1) verification.
- **Dependency / bundle budget:** BBS over BLS12-381 via `@noble/curves`
  (already a transitive dep of the WS-S crypto). The BBS proof protocol is the
  new code; it loads in the LAZY private-p2p chunk (no initial-bundle impact) and
  is suite-pinned (`BLS12-381-SHAKE-256` or `-SHA-256`, per the pinned draft) with
  downgrade resistance, matching the project's thin-wrapper ethos.
- **Maturity caveat:** BBS + its blind-issuance + pseudonym extensions are CFRG
  drafts, not finalized RFCs (the base BBS draft is the most mature; the blind +
  pseudonym extensions are earlier-stage). The spec pins a specific draft revision
  per document + a single ciphersuite, vendors them through ONE reviewed wrapper
  gated like the MLS one (`check:p2p-bbs-wrapper`, no deep imports), and ships the
  pinned draft test vectors; revisit on RFC finalization. If draft risk is
  unacceptable at build time, ship the §10 ZK-accumulator alternative instead.
  This dependency churn is the single largest risk of Tier-2 and is THE reason it
  is staged behind Tier-1 rather than shipped now.

## 10. Alternatives

- **ZK set-membership + nullifier (Semaphore-style).** The room publishes a
  per-epoch Merkle accumulator of device commitments; the announce is a SNARK
  proving membership + a per-context nullifier. *No issuance* (membership IS the
  credential) and battle-tested, but a browser SNARK prover (Groth16 needs a
  per-circuit trusted setup; Halo2 avoids it but is heavy) blows the bundle /
  dependency budget. Prefer ONLY if BBS draft-maturity is a blocker AND the
  prover weight is acceptable behind the lazy chunk.
- **Light Ed25519 revealed tokens.** Cheapest (reuses Ed25519, no new dep) but
  LINKABLE across buckets — a §15.3.2 regression. Acceptable only for a
  deployment that explicitly drops per-bucket unlinkability; NOT recommended.

## 11. Migration & rollout

1. Add `ncommit` to the device record (`member.add`) behind a manifest flag; old
   devices have none and run Tier-1.
2. Ship the server `presence_proof`/`presence_nym` columns (additive §8.2
   allowlist extension + migration) and the per-epoch `ipk_e` publication; the
   server verifies when present, fail-opens when absent.
3. Enable Tier-2 per room via the manifest flag once all the room's devices
   carry `ncommit`. Mixed rooms run safely (unverified records ride Tier-1).
4. The §8.2 gate (`check:private-rendezvous-schema`) is updated to the new
   allowlist; the no-server-content / no-CID-egress gates are unaffected (the new
   fields are pseudonymous proofs, not content/CIDs).

## 12. Acceptance criteria & tests

- **Cap:** with Tier-2 enabled, a single device produces ≤ 1 slot per
  `(epoch, bucket)`; a forged extra `nym` (no credential) is rejected — proven by
  a test that a flood without credentials yields no extra accepted slots.
- **Unlinkability:** a device's `nym` differs across buckets and epochs (a
  property test over the BBS-pseudonym derivation).
- **Forward secrecy:** a removed device's proof fails against the post-removal
  `ipk_e`.
- **Fail-open:** a server with no `ipk_e`, and a client with no credential, both
  fall through to Tier-1 (no honest lock-out) — proven by a degradation test.
- **Downgrade:** a stripped `presence_proof` gains only Tier-1 dilution, no cap
  exemption.
- **Perf:** O(1) verification; a published bound on proof size + verify time;
  the BBS code stays in the lazy chunk (no initial-bundle regression — the
  `check:private-p2p-split` gate).
- **Vectors:** BBS sign/verify/pseudonym pinned to the draft's test vectors
  (mirroring the RFC-vector discipline of HKDF/HPKE/MLS).

## 13. Open questions & risks

- BBS draft churn — pin + gate; revisit on RFC.
- Long-epoch re-issuance cadence vs. admin-liveness assumptions — tune per the
  §33 operational mode (a high-risk room may prefer shorter epochs).
- Whether the per-bucket granularity is the right cap unit, or whether a coarser
  per-epoch `nym` (accepting within-epoch linkage) is an acceptable
  simplification for low-risk rooms.

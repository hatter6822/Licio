# Licio Private P2P Rooms — End-to-End Architecture Specification

**Document status:** refined architecture specification v0.2  
**Prepared:** 2026-06-15  
**Project:** Licio (`hatter6822/Licio`)  
**Scope:** real private rooms whose content, threads, comments, media, membership internals, and private search state are end-to-end encrypted and hosted by members' devices rather than the Licio main server.  
**Primary decision:** private P2P rooms are a separate storage, sync, trust, and authority plane. They must not be implemented as a stronger flag on the existing server-hosted private-room model.

---

## Table of contents

1. Executive summary
2. Current Licio baseline and required architectural break
3. Definitions and normative language
4. Product model: three room classes, not two
5. Privacy, trust, and threat model
6. Non-goals and honest user promises
7. High-level architecture
8. Data-residency rules and server non-storage contract
9. IPFS, Helia, and libp2p design
10. Cryptographic architecture
11. Identity, devices, and room authority
12. Membership, invites, removal, and recovery
13. Private room data model
14. Operation log, conflict handling, and deterministic reduction
15. P2P sync protocol
16. Local storage, pinning, backup, and availability
17. Media and attachment pipeline
18. Search, ranking, recommendations, notifications, and analytics
19. Moderation, reports, trust, and safety
20. User experience requirements and mandatory copy
21. Server API specification
22. Client architecture and package layout
23. Integration changes for the current Licio codebase
24. Migration from existing server-private rooms
25. Efficiency and performance plan
26. Security, privacy, and correctness test plan
27. Operational controls and incident response
28. Workstreams and rollout plan
29. Launch checklist
30. Open questions
31. References

---

## 1. Executive summary

Licio's current private-room behavior is **server-hosted containment**: content is room-owned, private rooms force `room_only`, global surfaces exclude room-only items, and reads are gated by server membership checks. That is useful, but it is not real cryptographic privacy because the server stores the content, has the authority path, and can process private-room metadata through server subsystems.

This specification defines a new architecture for **P2P private rooms**:

- Room content is encrypted locally before storage or sync.
- IPFS-compatible content addressing is used only for encrypted blocks.
- The public IPFS DHT, public gateways, delegated routing, public provider advertisements, and public IPNI are not used for private-room content.
- Members' devices exchange encrypted operation logs and encrypted media blocks directly over room-scoped libp2p protocols.
- Licio's main server may provide only minimal directory stubs and blind rendezvous/signaling. It must not receive private story IDs, thread IDs, contribution IDs, plaintext, private CIDs, operation heads, member lists, activity state, search terms, or room keys.
- Room authority comes from cryptographic room keys and signed capability operations, not from platform admins or server ACLs.
- Platform staff cannot read, alter, recover, moderate, add members to, or delete private-room content because the platform does not possess content, keys, heads, or authoritative membership state.

The implementation should keep Licio's existing public forum and ranking architecture intact. Public rooms remain server-hosted. Existing private/restricted rooms should be renamed in the UI as **restricted server rooms** or **members-only server rooms**. Only the new `private_p2p` model should be described as private in the strong sense.

The highest-trust design also addresses the largest web-app weakness: a PWA is code delivered by a server. If Licio's server can silently ship new JavaScript that exfiltrates room keys, cryptographic storage alone is not enough. This spec therefore requires release transparency, signed/reproducible private-mode bundles, service-worker update pinning, strict CSP/Trusted Types, no remote dynamic code, and an optional hardened local key agent for users who want stronger protection against malicious future web updates.

> **Relationship to `docs/OFFLINE_SPEC.md` (LCAP).** This spec owns the **authority and confidentiality** plane for private rooms (room keys, MLS, server non-storage). LCAP owns a complementary, content-neutral **availability and transport** plane for delay-tolerant sync. They compose: a Private P2P room MAY carry its encrypted blocks over LCAP transports and reuse LCAP's `.licio-bundle` pack as its offline CAR-equivalent, its lane scheduler (so membership/control material outruns media), and its honest liveness/trust labelling — but LCAP only ever handles **ciphertext and opaque room hints** for private rooms, never plaintext, keys, op heads, or real room IDs. The two planes pin **different cryptographic suites on purpose** (Ed25519/MLS here for group-key alignment; ECDSA P-256 in LCAP for zero-dependency WebCrypto ubiquity) and never share keys. Where the two documents overlap for private-room content, this spec is authoritative.

---

## 2. Current Licio baseline and required architectural break

The existing Licio model is already structured around the hierarchy:

```text
Room -> Content / Story -> Thread -> Contributions
```

Current server-hosted content has a `room_id`, `visibility`, story lifecycle state, media upload reference, canonical URL, search vector, and related database indexes. The current submission path validates a server `room_id`, derives server visibility, creates a server story and thread shell, and emits server events. The current thread and contribution paths read/write server stores and use server-side visibility gates.

That design is correct for public and restricted server rooms, but it conflicts with the requested privacy guarantee. For real private rooms:

- `stories` must not contain private-room stories.
- server threads must not exist for private-room content.
- server contributions must not exist for private-room comments.
- upload rows must not own private-room media.
- search indexes, ranking candidates, signal ledgers, freshness features, embeddings, summaries, review queues, and content events must not contain private-room content or metadata.
- platform stewards/admins must not be able to satisfy a room read bar because the room content is not server-readable.

The required change is therefore not merely adding E2EE to existing rows. It is a **separate private plane** with its own schemas, sync, reducer, local storage, crypto, and UI.

---

## 3. Definitions and normative language

The terms **MUST**, **MUST NOT**, **REQUIRED**, **SHALL**, **SHALL NOT**, **SHOULD**, **SHOULD NOT**, **RECOMMENDED**, **MAY**, and **OPTIONAL** are to be interpreted as described in BCP 14 (RFC 2119, RFC 8174), and only when shown in all uppercase. Lowercase uses are descriptive. TypeScript and SQL sketches are illustrative; the zod schemas in `packages/private-p2p/src/schemas/`, the canonical-encoding rules, and the official cryptographic test vectors (§26.2) are normative where a sketch and an implementation could diverge.

### 3.1 Terms

| Term | Meaning |
|---|---|
| P2P private room | A Licio room whose content and membership internals are encrypted and synced among members' devices, not hosted by Licio's main server. |
| Restricted server room | A server-hosted room with membership-gated reads. This may be private from ordinary users, but not from server operators or platform processes. |
| Directory stub | Minimal server-side bootstrap record for a P2P room. It contains no content, private CIDs, operation heads, member list, or activity data. |
| Room manifest | Encrypted, signed room configuration and root pointers. Stored and synced as encrypted IPFS/IPLD blocks. |
| Operation log | Signed, encrypted append-only DAG of room changes: story creation, thread updates, contribution creation, edits, tombstones, membership changes, summaries, and attachment manifests. |
| Epoch | A cryptographic membership/key generation. Every add/remove operation creates a new epoch. |
| Member | A room participant. A member can have multiple devices. |
| Device | One browser profile, installed PWA context, local agent, or member-operated node participating in a room. |
| Room key authority | The set of private keys and signed capability operations that define who can read, post, invite, moderate, or administer a P2P room. |
| Blind rendezvous | Server-assisted peer discovery where the server sees only opaque time-bucketed identifiers and encrypted signaling data. |
| Private CID | A CID of encrypted private-room data. Private CIDs MUST NOT be announced to public routing systems or logged server-side. |

### 3.2 Security classes

The P2P private-room system has three explicit security tiers:

| Tier | Name | Key custody | Update-channel protection | Intended users |
|---|---|---|---|---|
| Tier 1 | PWA private | Browser IndexedDB/WebCrypto | Signed bundle + service-worker pinning | Most users |
| Tier 2 | Hardened PWA | Browser plus passkey-bound key wrapping and strict update approval | Code transparency + manual update approval | Privacy-conscious users |
| Tier 3 | Local key agent | Room keys held outside the web origin by a local agent, extension, or member-run node | Web code cannot directly export keys | Highest-trust users and room stewards |

Licio MUST NOT claim that Tier 1 protects users from a malicious Licio web update. Tier 1 protects against passive server storage compromise and ordinary platform administration because the server does not have content or keys. Tier 2 and Tier 3 reduce update-channel risk.

---

## 4. Product model: three room classes, not two

Licio should expose three room classes:

| Internal class | Suggested UI label | Storage | Authority | Server can read? | Server can rank/search? | Typical use |
|---|---|---|---|---:|---:|---|
| `public_server` | Public room | Licio server | Platform + room roles | Yes | Yes | Public social news and discussion |
| `restricted_server` | Members-only server room | Licio server | Platform + room roles | Yes | Limited to server gates | Existing restricted/private behavior, legacy rooms |
| `private_p2p` | Private P2P room | Member devices / member-operated encrypted pins | Room keys only | No | No | Real private rooms |

### 4.1 Required schema axes

Add room axes without overloading the current `visibility` enum:

```ts
export const ROOM_STORAGE_MODES = ['server', 'p2p'] as const;
export const ROOM_AUTHORITY_MODELS = ['platform', 'room_keys'] as const;
export const ROOM_DIRECTORY_MODES = ['listed', 'unlisted', 'detached'] as const;
```

Required coherence:

```text
storage_mode = 'server' -> authority_model = 'platform'
storage_mode = 'p2p'    -> authority_model = 'room_keys'
storage_mode = 'p2p'    -> visibility = 'private'
storage_mode = 'p2p'    -> join_model = 'invite'
storage_mode = 'p2p'    -> posting_policy is advisory UI only; actual posting is capability-gated by room ops
```

### 4.2 Directory modes

| Directory mode | Server knows | Discovery | Default? | Privacy tradeoff |
|---|---|---|---:|---|
| `listed` | Public display name, description, stub key commitment | Room directory/search can show the room shell | No | Leaks existence and topic. No content. |
| `unlisted` | Opaque stub reachable only with invite/bootstrap token | Invite/link required | Yes | Server knows a stub exists but not meaningful metadata. |
| `detached` | Nothing, unless rendezvous is used later | Manual QR/file/contact exchange | No | Maximum privacy, weakest usability. |

Default for P2P private rooms MUST be `unlisted`. `listed` requires explicit user action and plain-language disclosure.

---

## 5. Privacy, trust, and threat model

### 5.1 Primary privacy goals

P2P private rooms MUST provide:

1. **Content confidentiality:** only current or historically authorized members with retained epoch keys can decrypt content from corresponding epochs.
2. **Content integrity:** every object is authenticated by AEAD and signed by a valid room device key.
3. **Room-key authority:** platform admins cannot add members, decrypt content, rotate keys, or rewrite history.
4. **Server non-knowledge:** the main server does not receive private content, private CIDs, op heads, member lists, thread IDs, or private search/ranking data.
5. **Metadata minimization:** the server sees only the minimum needed for optional directory and blind rendezvous operation.
6. **Availability transparency:** the UI honestly shows whether enough member devices/pins hold encrypted copies.
7. **Update-channel accountability:** private-room code is signed, reproducible, hash-pinned, and visible in a transparency log.

### 5.2 Adversaries

| Adversary | Capability | Expected protection |
|---|---|---|
| Ordinary outsider | No keys, may know app exists | Cannot read content or join room. |
| Network observer | Sees traffic timing, endpoints, sizes | Cannot read payloads; metadata reduced by relay/padding/jitter. |
| Public IPFS observer | Watches public DHT/gateway/provider metadata | Should see no private-room CIDs by default. |
| Licio database attacker | Reads DB backups and event stores | Finds no private content or keys. |
| Licio admin/operator | Has production DB/admin access | Cannot read or mutate private-room content. |
| Licio rendezvous operator | Sees blind rendezvous records | Cannot map records to content, room name, members, or CIDs in unlisted/detached rooms. |
| Malicious current member | Has legitimate room access | Can copy content they can read; cannot forge other members' signed operations. |
| Removed member | Retains old keys/content | Can read old content they already received; cannot decrypt future epochs. |
| Compromised member device | Local malware/browser compromise | Can expose local plaintext/keys until removed and rekeyed. |
| Malicious future web update | Licio serves hostile JS | Mitigated by signed/pinned bundles and optional local key agent; not fully solved by PWA-only key custody. |

### 5.3 Trust boundary matrix

| Boundary | Server-hosted rooms | P2P private rooms |
|---|---|---|
| Content storage | Server DB/object storage | Member devices only |
| Content encryption | Transport/database controls | End-to-end before IPFS/blockstore |
| Authorization | Server session + RBAC | Room cryptographic capabilities |
| Moderation | Platform + room roles | Room-local only; voluntary disclosure to platform |
| Search | Server index | Local-only decrypted index |
| Ranking | Server PWAtt/retrievers | No server ranking; local sorting only |
| Logs | Server IDs/events | No private IDs/content/CIDs in server logs |
| Backups | Server backups | Member export/replication only |
| Recovery | Account/support flows | Room keys/recovery kit/other admins only |

### 5.4 Metadata minimization objectives

The design MUST minimize leakage of:

- room existence;
- room topic/name;
- member list;
- membership changes;
- message count;
- online presence;
- unread counts;
- thread titles;
- private CIDs;
- operation heads;
- exact activity time;
- content sizes for small text objects;
- public-account-to-room membership linkage.

Mitigations include unlisted stubs, detached rooms, blind rendezvous, rotating room-scoped PeerIDs, batched announcements, coarse time buckets, padding for small operations, relay-only transport mode, local-only notifications, and no server analytics.

---

## 6. Non-goals and honest user promises

P2P private rooms MUST be honest about these limits:

1. **No protection from members copying content.** Any member can screenshot, copy, export, quote, or leak what they can read.
2. **No retroactive erasure.** Removing a member prevents future access but cannot claw back content or keys already delivered.
3. **No guaranteed availability.** If no authorized device or member-operated encrypted pin has the blocks, the room may be temporarily or permanently unavailable.
4. **No full anonymity.** Direct P2P connections can reveal IP/network metadata to peers. Relay-only mode reduces but does not eliminate metadata.
5. **No platform rescue.** Licio cannot recover lost room keys, add a member, or decrypt content for support.
6. **No proactive platform moderation.** The platform cannot scan content it cannot read. Members may voluntarily disclose report packages.
7. **No complete protection against malicious client updates in basic PWA mode.** Stronger update pinning and local key agents are required for that threat.

Mandatory creation disclosure:

```text
This is a Private P2P room. Licio does not host the room's content and cannot read, moderate, recover, or add members to it. The room is available only while enough members' devices or member-operated encrypted pins keep copies. Removed members may keep content they already received. Members can still copy or disclose content. Keep a recovery kit if you cannot afford to lose access.
```

---

## 7. High-level architecture

```text
                  ┌────────────────────────────────────────────┐
                  │              Licio main server             │
                  │                                            │
                  │ Public/restricted server rooms:            │
                  │   BFF, Postgres, Redis, ranking, search,   │
                  │   uploads, moderation, event pipeline       │
                  │                                            │
                  │ P2P private rooms:                         │
                  │   optional directory stubs + blind          │
                  │   rendezvous/signaling only                 │
                  │                                            │
                  │ Forbidden for P2P rooms: content, CIDs,     │
                  │ op heads, private search, member lists,     │
                  │ ranking events, private uploads, keys       │
                  └────────────────────────────────────────────┘
                                      │
                                      │ optional bootstrap only
                                      │ opaque, no private content
                                      ▼
┌────────────────────────────┐     encrypted P2P sync      ┌────────────────────────────┐
│ Member device A             │◀───────────────────────────▶│ Member device B             │
│ PWA + Helia/libp2p          │                             │ PWA + Helia/libp2p          │
│ IndexedDB blockstore        │                             │ IndexedDB blockstore        │
│ local op DAG + reducer      │                             │ local op DAG + reducer      │
│ local encrypted keys        │                             │ local encrypted keys        │
│ local private search        │                             │ local private search        │
└────────────────────────────┘                             └────────────────────────────┘
              ▲                                                        ▲
              │ encrypted CAR/block sync                               │ encrypted block sync
              ▼                                                        ▼
┌────────────────────────────┐                             ┌────────────────────────────┐
│ Member-operated encrypted   │                             │ Member-operated relay or    │
│ pinning node / local agent  │                             │ rendezvous node             │
│ no plaintext                │                             │ no content authority        │
└────────────────────────────┘                             └────────────────────────────┘
```

### 7.1 Core architectural rules

1. Public and restricted server rooms continue to use existing Licio server architecture.
2. P2P private rooms use local encrypted operation logs and encrypted IPFS-compatible blocks.
3. The server may assist with account login, feature discovery, stub creation, and blind rendezvous, but not with private room authority.
4. P2P private rooms render from local decrypted state, not from `/v1/stories`, `/v1/threads`, or `/v1/contributions`.
5. Every private-room object is content-addressed after encryption, never before.
6. Every private-room operation is signed by a device key and authorized by room capability state.
7. Private-room sync must continue to work between members even if the Licio BFF is unavailable, provided peers can reach one another through configured transport paths.

---

## 8. Data-residency rules and server non-storage contract

### 8.1 Absolute server forbiddance list

For `rooms.storage_mode = 'p2p'`, the main server MUST NOT store or derive:

- plaintext room manifest;
- encrypted room manifest, unless explicitly allowed by an opt-in member-operated pin outside main server scope;
- private CIDs;
- operation heads;
- story IDs;
- thread IDs;
- contribution IDs;
- thread titles;
- contribution bodies;
- media bytes or thumbnails;
- media manifests;
- search indexes;
- embeddings;
- private topics;
- private URL/canonical URL data;
- private content events;
- ranking candidates;
- attention aggregates;
- member lists;
- per-room member counts;
- per-room latest activity;
- unread counts;
- push notification content;
- key material;
- invite secrets;
- recovery secrets.

### 8.2 Allowed server-side data

For a listed or unlisted P2P room, the server MAY store a minimal stub:

```ts
type PrivateRoomStub = {
  stub_id: string;
  room_server_id: string;
  directory_mode: 'listed' | 'unlisted';

  // Present only for listed rooms.
  display_name?: string;
  display_description?: string;
  display_avatar_public_cid?: string;

  // Cryptographic commitments, not decrypting material.
  room_public_key: string;
  manifest_key_commitment: string;
  latest_manifest_commitment?: string;

  // Bootstrap/rendezvous policy, not private content.
  rendezvous_policy: 'licio_blind' | 'member_rendezvous' | 'manual_only';
  bootstrap_hints: Array<{
    kind: 'licio_blind' | 'member_relay' | 'manual';
    value: string;
  }>;

  // The room-signed body.  A CLOSED set of PUBLIC commitments — see §21.1.
  signed_stub: {
    schema: 'licio.private.directory_stub.v2';
    room_public_key: string;
    manifest_key_commitment: string;
  };
  stub_signature: string;

  // The §21.2 capability, in its OWN column and NEVER projected.
  bootstrap_blind_id: string;

  created_by_account_id?: string;
  created_at: string;
  updated_at: string;
};
```

For `directory_mode = 'detached'`, no stub is stored. Invites are exchanged outside Licio or through blind rendezvous without a persistent room stub.

### 8.3 Database guard

Every server table or store that can reference a room MUST reject P2P room IDs unless it is explicitly a stub/rendezvous table.

Forbidden FK paths:

```text
stories.room_id -> p2p room
threads.room_id -> p2p room
contributions -> thread in p2p room
uploads.owner_story_id -> p2p story
search index -> p2p story/thread/contribution
ranking candidate -> p2p story/thread
review queue story_id -> p2p story
signal ledger -> p2p content
content events -> p2p room
```

### 8.4 Server-side event policy

P2P private-room activity MUST NOT emit existing public/restricted content events such as:

- `content.submitted`
- `content.normalized`
- `content.visibility.changed`
- `contribution.created`
- `evidence.added`
- ranking lifecycle events
- attention events
- freshness events

If operational metrics are required for the rendezvous service, they MUST be aggregate-only and unlinkable to room identity. Example allowed counters:

```text
private_rendezvous.announcements_total
private_rendezvous.signals_total
private_rendezvous.rate_limited_total
private_room_stubs.created_total
```

Forbidden metrics:

```text
private_room.<room_id>.peers
private_room.<room_id>.messages
private_room.<room_id>.latest_activity
private_room.<room_id>.member_count
private_room.<room_id>.cid_requests
```

---

## 9. IPFS, Helia, and libp2p design

> **Superseded implementation, preserved requirement (maintainer decision).**
> The shipped plane does **not** run Helia or libp2p. It takes the
> *lighter-transport path*: a dependency-free CIDv1-over-ciphertext profile
> (`packages/private-p2p/src/crypto/cid.ts`, pinned byte-for-byte against
> `multiformats`), plain `RTCPeerConnection` data channels driven by
> `apps/web/src/private-p2p/connect-peer.ts`, and the §15.9 encrypted archive
> (`sync/archive.ts`) as the CAR-equivalent. The §6.12.12 dependency budget and
> the private-chunk bundle budget are what made a full IPFS stack in the initial
> payload untenable.
>
> **§9.1 is unchanged and still binding**: the CID identifies ciphertext, and a
> plaintext CID for private-room content must never exist. So are the §9.3
> forbidden-behaviour rules — with no public DHT, gateway, delegated router,
> IPNI, or reprovide loop in the tree, there is simply nothing left to disable,
> which is why the §29 checklist marks that item not-applicable rather than
> done. §9.2's package list and the libp2p configuration below describe the
> *considered* stack; read them as design rationale for what the requirements
> are, not as a description of what is imported.

### 9.1 Design stance

IPFS-compatible content addressing is useful for integrity, deduplication within encrypted datasets, offline transfer, and member-operated pinning. It is not a privacy layer. Therefore:

```text
private plaintext -> canonical encode -> optional compress -> pad -> encrypt -> chunk -> CID encrypted chunks
```

The CID MUST identify ciphertext. A plaintext CID MUST never exist for private-room content.

### 9.2 Recommended implementation stack

Use **Helia** as the browser-friendly TypeScript IPFS implementation, with custom libp2p configuration for private-room operation. Helia is a modern TypeScript implementation of IPFS for JavaScript and browser environments and supports modular blockstore/datastore configuration.

Recommended packages/modules:

```text
helia
@helia/dag-cbor
@helia/unixfs only for encrypted binary blobs, not plaintext filenames
multiformats
libp2p
@libp2p/webrtc
@libp2p/webtransport where supported
@libp2p/websockets for relay/rendezvous fallback
idb-backed blockstore/datastore
```

### 9.3 Private Helia profile

P2P private rooms MUST use a separate Helia/libp2p node or namespace from public content:

```ts
type LicioPrivateHeliaProfile = {
  profile: 'licio-private-helia-v1';
  publicDht: false;
  publicGateways: false;
  delegatedRouting: false;
  ipni: false;
  reprovide: false;
  mdns: 'off' | 'local_only_explicit';
  relayMode: 'direct_allowed' | 'relay_preferred' | 'relay_only';
  peerIdScope: 'room_epoch';
  blockBrokers: ['licio-private-peer-block-protocol'];
};
```

The private profile MUST disable:

- public DHT routing;
- public gateway fallback;
- delegated routing;
- IPNI advertisement;
- public Bitswap with unknown peers;
- public provider records;
- automatic reproviding of private CIDs;
- permanent cross-room PeerIDs.

### 9.4 CID profile

Use CIDv1 with deterministic private-room import settings for ciphertext blocks:

```text
cid_version: 1
base: base32 for string representation
hash: sha2-256 initially; multihash agility reserved
small object codec: dag-cbor envelope over ciphertext metadata
large chunk codec: raw encrypted bytes
small chunk size: 256 KiB
large media chunk size: 1 MiB to 4 MiB, selected by media class
DAG layout: balanced for media, append-friendly op log manifests
```

CIDv1 is preferred for new browser-facing work because it includes version/codec information and is safer for browser contexts than CIDv0.

### 9.5 Public IPFS avoidance

Private-room content MUST NOT be fetched via:

- `https://ipfs.io/ipfs/...`
- any public gateway URL;
- public DHT provider lookup;
- delegated public routing;
- public IPNI lookup;
- generic public Bitswap sessions.

The client MUST reject any private-room render path that attempts to construct a public gateway URL.

### 9.6 Private block exchange protocols

Define Licio-specific libp2p protocols:

```text
/licio/private/handshake/1
/licio/private/heads/1
/licio/private/block-request/1
/licio/private/block-response/1
/licio/private/snapshot/1
/licio/private/range/1
/licio/private/health/1
```

Only peers that prove room membership through current epoch credentials may speak these protocols for a room. Public libp2p peers must not be able to request arbitrary private CIDs.

### 9.7 Native-device interpretation

Because Licio is PWA-first, “native on the device” means:

1. The installed PWA can run Helia/libp2p and store encrypted blocks in browser storage.
2. Advanced users may run a member-operated local node or key agent on their own device for better uptime/key isolation.
3. No Licio-controlled backend node is part of the private content storage plane.

A browser PWA cannot be assumed to be an always-on daemon. Availability therefore depends on visible replication health and optional member-operated pins.

### 9.8 Dependency budget and bundle strategy

The private-room stack — Helia, libp2p and its transports, an MLS implementation, an HPKE implementation, and a memory-hard KDF — is large and would, if added to `apps/web`, violate Licio's hard limits: `apps/web` < 15 direct production dependencies and initial JS < 200 KB gz (CLAUDE.md; SPEC §6.12.12). The architecture MUST therefore isolate it:

1. **All P2P dependencies live in `packages/private-p2p` and the lazily-loaded `apps/web/src/private-p2p/` module**, never in `apps/web`'s top-level `package.json`. Workspace (`workspace:*`) dependencies are excluded from the `apps/web` direct-dependency count, so the core app's budget is unaffected.
2. **Private-mode code is a separate, dynamically-imported route chunk** loaded only when a user opens or creates a Private P2P room. The build gate `scripts/check-bundle-size.ts` enforces **two** JS ceilings — a 200 KiB gzipped *initial-load* budget (entry + preloads) **and a 320 KiB gzipped *total-JS* budget summed across every built asset, lazy chunks included**. Code-splitting keeps the private chunk out of the *initial-load* figure, but a Helia/libp2p/MLS chunk would still blow the *total* budget. The gate MUST therefore be updated to give the private chunk its **own measured budget**, excluded from the core 320 KiB total (keyed on the chunk's stable name). Then the public PWA's first-load AND core-total figures are unaffected, and the private chunk is bounded against its own documented ceiling — never silently exempt.
3. **No heavy P2P code ships to users who never open a private room.** Helia/libp2p/MLS instantiation is deferred until first private-room use, behind a dynamic `import()`.
4. **The reproducible private-mode bundle (Tiers 1–3, WS-P2P-10) is exactly this chunk**, giving update-channel transparency (signing + hash-pinning, §20.6) a well-bounded artifact to attest.
5. **Dependency review still applies** (CLAUDE.md checklist): each library must be actively maintained, install-script-free, and license-compatible (AGPL-3.0-or-later). The MLS/HPKE/curve-library choices are tracked in open questions §30.1–§30.2 and §10.7.

A dedicated, documented `check:deps` allowance for the private-p2p workspace keeps the heavy stack from silently creeping into the core web bundle.

---

## 10. Cryptographic architecture

### 10.1 Principles

1. Encrypt before content addressing.
2. Authenticate every object with AEAD and an author signature.
3. Use standard group key management; do not invent ad hoc group crypto.
4. Rotate keys on every membership change.
5. Use domain-separated key derivation labels.
6. Use fresh nonces and object keys for every encrypted object.
7. Avoid deterministic encryption for private content to prevent CID equality leakage.
8. Keep server code out of room authority.
9. Prefer audited libraries and external review over hand-written primitives.
10. Treat WebCrypto as low-level; wrap it behind small, testable, reviewed modules.

### 10.1.1 Canonical encoding

Every structure that is hashed into a CID, supplied to an AEAD as AAD, covered by a signature, or compared for reducer determinism MUST use one **canonical encoding**: the **DAG-CBOR deterministic profile** (RFC 8949 §4.2.1 core deterministic encoding, which the `dag-cbor` codec already selected in §9.4 mandates). The rules match LCAP's LDC profile (`docs/OFFLINE_SPEC.md` §9.1): shortest-form integers, definite-length items only, map keys sorted in bytewise lexicographic order of their encodings, no duplicate keys, no floating point, optional fields omitted rather than `null`-filled, and UTF-8/NFC text. `packages/private-p2p/src/crypto/canonical.ts` is the single implementation, pinned by the §26.1 canonical-encoding stability tests. All references to `canonical(...)` in this document mean this function.

### 10.2 Group key agreement

Use **Messaging Layer Security (MLS), RFC 9420** for room group state.

Mapping:

| MLS concept | Licio P2P room mapping |
|---|---|
| MLS group | One private room |
| MLS client | One member device |
| MLS epoch | Room membership/key epoch |
| Add | Add device/member |
| Remove | Remove device/member |
| Commit | Authoritative key-state transition |
| Welcome | Encrypted join material for a new device |
| Exporter secret | Basis for application-level room epoch keys |

Application secrets are derived from the **MLS exporter secret of the current epoch** (RFC 9420 §8.5). Because the exporter secret is fresh per epoch and uniformly random, the room epoch secret is bound to the epoch automatically:

```text
room_epoch_secret = MLS-Exporter(
  label   = "licio.private-room.v1.epoch",
  context = canonical([room_id_commitment, epoch, manifest_commitment]),
  length  = 32
)                                  // RFC 9420 §8.5 ExpandWithLabel over the epoch exporter_secret
```

Per-purpose keys are derived with **HKDF-Expand-Label**, a labeled HKDF (HKDF SHA-256, RFC 5869) in the style of TLS 1.3 / MLS so each label/length is unambiguously bound:

```text
HKDF-Expand-Label(secret, label, context, length) =
  HKDF-Expand(secret, encode(length, "licio-priv1 " || label, context), length)
       // PRK = secret (already uniformly random ⇒ no separate Extract step)
       // Hash = SHA-256, output length = 32 bytes unless noted

content_wrap_key = HKDF-Expand-Label(room_epoch_secret, "content-wrap.v1",  room_id_commitment, 32)
sync_topic_key   = HKDF-Expand-Label(room_epoch_secret, "sync-topic.v1",    room_id_commitment, 32)
rendezvous_key   = HKDF-Expand-Label(room_epoch_secret, "rendezvous.v1",    room_id_commitment, 32)
snapshot_key     = HKDF-Expand-Label(room_epoch_secret, "snapshot.v1",      room_id_commitment, 32)
report_key       = HKDF-Expand-Label(room_epoch_secret, "voluntary-report.v1", room_id_commitment, 32)
```

The `"licio-priv1 "` prefix and the per-purpose `label` provide domain separation: a key minted for one purpose, room, or protocol version can never collide with another. `context` is the canonical-encoded (§14.3 canonical rules) byte string, never an ad-hoc concatenation, so `room_id || epoch` ambiguity (e.g. `"r1" || "23"` vs `"r12" || "3"`) cannot arise. Deriving every operational key from `room_epoch_secret` means a single MLS Commit (add/remove) rotates **all** of them at once (§10.9).

### 10.3 Invite encryption

Use **HPKE, RFC 9180** for invites and one-to-one bootstrap messages before the recipient is part of the MLS group.

Invite material:

```ts
type InviteSecretV1 = {
  schema: 'licio.private.invite_secret.v1';
  room_stub_ref?: string;        // the §21 room_server_id, if the room has a record
  bootstrap_blind_id?: string;   // the §21.2 capability for that record
  room_public_key: Uint8Array;
  invite_id: string;
  invite_secret: Uint8Array;
  expires_at: string;
  max_uses: number;
  granted_role: 'member' | 'moderator' | 'admin';
  requires_admin_approval: boolean;
};
```

The two directory fields travel together and only for a room that registered a
stub. They ride the SEALED invite rather than the §12.3 grant for two reasons.

The recipient needs them BEFORE being admitted: an `unlisted` record answers
`not_found` to any reader without the token, so an invitee who received the
capability only after admission could not check what Licio publishes about the
room they were being asked to enter, and a `listed` room's public name would
reach them last rather than first.

And a grant is the wrong CARRIER. It is copy-pasted over an out-of-band channel
and only its Welcome and archive are cryptographically protected — every other
field is plaintext to whoever sees the message. `bootstrap_blind_id` does not
rotate, so an observer of that channel would hold a capability resolving an
`unlisted` record forever, including after a delist. The invite is HPKE-sealed
to one recipient and lives only in a URL fragment, so it is the one delivery
that keeps the capability to the member it was issued to. A joiner therefore
retains the fields from the invite it has already opened, and the grant carries
none.

What resolving the record establishes, and what it does not, is worth stating
because a client's copy must not overclaim. It establishes that the record
exists and that this invite carries the token that opens it — a token derived
from the room's epoch-0 rendezvous key, so its holder had something only the
room holds. It does NOT bind the record to the invite by cryptographic
identity: the stub's `room_public_key` is the founder device's signing key while
the invite's is the manifest's HPKE invite key, so a client that "verified" one
against the other would warn on every honest invite. A capability that is
present and resolves nothing is the case worth flagging.

Invite URL format:

```text
https://licio.app/private/join#invite=<base64url-sealed-invite>
```

The secret MUST be in the fragment, not the path or query string, so ordinary HTTP requests do not transmit it to the server.

### 10.4 Object envelope

Every private object is wrapped in an encrypted envelope:

```ts
type PrivateEncryptedEnvelopeV1 = {
  schema: 'licio.private.envelope.v1';
  envelope_version: 1;

  room_id_hash: string;              // HMAC-derived or hash commitment, not raw room ID when avoidable
  room_epoch: number;
  object_type:
    | 'room_manifest'
    | 'membership_op'
    | 'story_op'
    | 'thread_op'
    | 'contribution_op'
    | 'attachment_manifest'
    | 'media_chunk'
    | 'snapshot'
    | 'local_index_shard';

  plaintext_schema: string;
  cid_profile: 'licio-private-cid-v1';
  created_at_bucket: string;         // coarse bucket, not exact if not needed
  author_device_id_blind: string;
  author_seq: number;
  parent_op_ids: string[];

  aead: {
    algorithm: 'AES-256-GCM' | 'XCHACHA20-POLY1305';
    nonce: string;
    aad_hash: string;
  };

  key_wrap: {
    mode: 'mls_exporter_aead_wrap';
    wrapping_epoch: number;
    wrapped_object_key: string;
  };

  ciphertext: string | { chunk_cids: string[] };
  padding_policy: 'none' | 'small-op-4k' | 'small-op-16k' | 'custom';
  signature: string;
};
```

### 10.5 AEAD additional authenticated data

Each private object is encrypted under a **fresh per-object content key**, which is itself wrapped under the epoch `content_wrap_key`. Two AEAD operations are therefore involved, and each binds an AAD that MUST be a **canonical-encoded fixed-shape structure (§10.1.1), never an ad-hoc concatenation** — otherwise field-boundary ambiguity (`"r1"||"23"` vs `"r12"||"3"`) becomes a forgery vector.

**Object-body AEAD** (per-object key over plaintext):

```text
object_key   = random 32 bytes                       // fresh per object, never reused
nonce        = random 96 bits (AES-GCM) | 192 bits (XChaCha20-Poly1305)   // fresh per encryption
body_aad     = canonical([
  "licio-priv1.body",        // domain tag
  envelope_version,          // uint
  room_id_commitment,        // bstr
  room_epoch,                // uint
  object_type,               // tstr
  plaintext_schema,          // tstr
  parent_op_ids,             // [tstr]  (sorted, canonical)
  author_device_id_blind,    // tstr
  author_seq,                // uint
  capability_root_at_seq,    // bstr — capability state the author cites
  chunk_index, chunk_total   // uint, uint (0,1 for unchunked)
])
ciphertext   = AEAD-Seal(object_key, nonce, plaintext, body_aad)
```

**Key-wrap AEAD** (`content_wrap_key` over `object_key`, the `key_wrap` field of §10.4):

```text
wrap_nonce   = random nonce (fresh)
wrap_aad     = canonical([
  "licio-priv1.keywrap",
  wrapping_epoch,            // uint — the epoch whose content_wrap_key is used
  room_id_commitment,        // bstr
  object_type                // tstr
])
wrapped_object_key = wrap_nonce || AEAD-Seal(content_wrap_key, wrap_nonce, object_key, wrap_aad)
```

A verifier reconstructs both AADs from the envelope's authenticated metadata and the local epoch state; any mismatch fails the AEAD open and the object is quarantined (§14.2). Binding `wrapping_epoch` into the wrap AAD prevents replaying an object key from one epoch into an envelope that claims another.

### 10.6 Nonce and key rules

- A fresh object key MUST be generated for every object.
- A fresh random nonce MUST be generated for every AEAD encryption under a given object key.
- Object keys MUST be wrapped by epoch-derived wrapping keys.
- Nonce reuse under the same key is a fatal error.
- Clients MUST maintain local nonce/key-use assertions in tests.
- Deterministic/convergent encryption MUST NOT be used for private-room content (it would leak plaintext equality through CID equality).
- **Compression-before-encryption is restricted to avoid CRIME/BREACH-class oracles.** The rule by object class:
  - *Forbidden* for any object that mixes one member's secret with another member's attacker-influenceable input in the same compression context — in practice all contribution/op bodies. These are padded to a size bucket (§25.4), not compressed.
  - *Allowed* only for objects that are single-author and already-incompressible or whose length is not secret: already-compressed media chunks (which gain nothing and so SHOULD NOT be compressed anyway), and a member's own local search-index shards that never mix in other members' adversarial content.
  - When in doubt, **do not compress; pad instead.** Fixed shared dictionaries MUST NOT be used across the secret/attacker boundary.

### 10.7 Signatures

Every operation and envelope MUST be signed by an authorized device signing key. Signatures cover the canonical encoded envelope and all public envelope metadata. Device keys are room-scoped or room-epoch-scoped to reduce linkability.

Recommended initial algorithm:

```text
Ed25519 for operation signatures
X25519/HPKE suite for one-to-one invite bootstrap, depending on chosen HPKE library support
MLS cipher suite selected from audited library defaults
```

Final cipher-suite selection MUST be pinned in the spec before implementation and tested with official vectors where available.

**Browser-compatibility note.** Ed25519 is the right signature choice here because it matches the MLS cipher suite (`MLS_128_DHKEMX25519_..._Ed25519_...`), keeping one curve family across the group-key, invite-HPKE, and signing layers. However, WebCrypto Ed25519 is recent and not uniform across the older Android browsers in Licio's target matrix (open question §30.5). The implementation MUST therefore:

- use WebCrypto `Ed25519`/`X25519` when `crypto.subtle` advertises support, and
- otherwise fall back to a small audited library (e.g. the `@noble/*` curves family or a libsodium-WASM build) loaded **inside the lazily code-split private-p2p chunk** (§9.8 dependency-budget note), never in Licio's core bundle.

This Ed25519/X25519 choice is independent of the offline-availability plane (`docs/OFFLINE_SPEC.md`, LCAP), which standardizes on `ECDSA P-256` because that suite is natively present in WebCrypto everywhere and needs no fallback. The two planes deliberately pin different suites for different reasons — MLS-suite alignment here, zero-dependency ubiquity there — and never share keys.

### 10.8 Key storage tiers

| Tier | Storage | Notes |
|---|---|---|
| Basic | IndexedDB encrypted by a key derived from passphrase or platform secret | Usable but web-origin compromise is high impact. |
| WebCrypto non-extractable wrapping key | Object keys wrapped by non-extractable CryptoKey where supported | Helps accidental export, not a full malicious-JS defense. |
| Passkey-assisted wrapping | WebAuthn/passkey-derived or PRF-assisted wrapping where available | Requires compatibility review. |
| Local key agent | Keys held outside Licio web origin; web app asks agent to sign/decrypt | Best protection against malicious web updates. |

The default should be secure enough for ordinary users and transparent about its limitations. High-risk rooms SHOULD require local key agent or strict update pinning.

### 10.9 Post-compromise and removal

Member/device removal:

```text
remove device/member -> MLS Remove commit -> new epoch -> new sync topics -> new rendezvous blind IDs -> new content wrapping keys -> future content unreadable to removed device
```

Old content already delivered remains readable to the removed member. The UI MUST disclose this.

---

## 11. Identity, devices, and room authority

### 11.1 Identity separation

| Identity | Scope | Storage | Purpose |
|---|---|---|---|
| Licio account | Global, optional for P2P room membership | Server | Login, stub creation rate limits, public identity if user chooses |
| Room member ID | One room | Encrypted membership log | Room-local participant identity |
| Device ID | One device within one room | Encrypted membership log | Operation signing and MLS client identity |
| Room PeerID | One room epoch or short rotation window | Local/private rendezvous | libp2p connection identity |
| Room root key | One room | Manifest and local key store | Authenticates room authority |

Default P2P rooms SHOULD use room-scoped display names and room-scoped IDs. Linking a global Licio handle inside a private room must be explicit.

### 11.2 Device model

A member may have multiple devices. Each device has:

```ts
type PrivateRoomDevice = {
  device_id: string;
  member_id: string;
  signing_public_key: string;
  hpke_public_key: string;
  mls_credential: unknown;
  created_at: string;
  last_seen_bucket?: string;
  verified_by: Array<{ member_id: string; verified_at: string }>;
  status: 'active' | 'removed' | 'lost';
};
```

Devices are first-class because removal, compromise, and recovery often happen at the device level rather than the human-member level.

### 11.3 Capability model

Capabilities are room-local and signed into the operation log:

```ts
type Capability =
  | 'read'
  | 'post'
  | 'invite'
  | 'moderate'
  | 'summarize'
  | 'admin'
  | 'rotate_keys'
  | 'recover';
```

Suggested roles:

| Role | Capabilities |
|---|---|
| `member` | read, post |
| `moderator` | read, post, moderate, summarize |
| `admin` | read, post, invite, moderate, summarize, admin, rotate_keys |
| `recovery_admin` | rotate_keys, recover, invite, admin |

Capabilities, not platform roles, govern private rooms.

### 11.4 Platform role exclusion

No platform role can authorize private-room operations.

Forbidden:

```text
if user.roles.includes('admin') then privateRoomCanRead = true
if user.roles.includes('steward') then privateRoomCanModerate = true
support override key
emergency access key
server-side member add
server-side room unlock
```

Platform staff may delist a public directory stub or suspend a Licio account's access to Licio-hosted services, but cannot decrypt or mutate P2P room state.

### 11.5 Member verification

The UI SHOULD support safety-number verification:

```text
room_safety_number = HASH(
  room_public_key ||
  mls_epoch_authenticator ||
  sorted(active_device_public_keys) ||
  manifest_policy_hash
)
```

Members can compare QR codes or short authentication strings out of band. A room header should show whether membership/device state is verified, changed, or unverified.

---

## 12. Membership, invites, removal, and recovery

### 12.1 Room creation

Creation steps:

1. User chooses `Private P2P room`.
2. UI shows mandatory privacy/recovery disclosure.
3. Client generates room root key, local device keys, MLS group, initial manifest, and first membership operation.
4. Client encrypts manifest and first ops locally.
5. Client stores encrypted blocks in local Helia blockstore.
6. If directory mode is `listed` or `unlisted`, server creates a minimal stub.
7. Client starts private rendezvous only if policy allows.
8. Room opens from local reducer state.

The server never receives the room manifest plaintext, member list, or operation heads.

### 12.2 Invite flow

```text
admin/member with invite capability
  -> creates invite capability op locally
  -> seals invite using HPKE / invite secret
  -> sends invite link, QR, or file
  -> recipient opens invite locally
  -> recipient creates device keys and MLS KeyPackage
  -> recipient sends blinded join request over rendezvous or direct channel
  -> authorized admin device validates invite and commits MLS Add
  -> admin sends MLS Welcome and encrypted room bootstrap heads
  -> recipient syncs encrypted blocks from peers
```

Invite capability:

```ts
type InviteCapabilityOp = {
  type: 'member.invite.create';
  invite_id: string;
  granted_role: 'member' | 'moderator' | 'admin';
  max_uses: number;
  expires_at: string;
  requires_approval: boolean;
  created_by_member_id: string;
  note?: string;
};
```

### 12.3 Join request

```ts
type JoinRequestV1 = {
  schema: 'licio.private.join_request.v1';
  invite_id_blind: string;
  recipient_device_key_package: unknown;
  proposed_display_name: string;
  proof_of_invite_secret: string;
  requested_at_bucket: string;
};
```

The rendezvous server sees only an encrypted blob and a blind routing key.

### 12.4 Removal flow

```text
admin/threshold approval
  -> member.remove or device.remove op
  -> MLS Remove commit
  -> new epoch
  -> new manifest commitment
  -> new sync topic
  -> new rendezvous blind ID
  -> future ops encrypted under new epoch
```

Removal op:

```ts
type MemberRemoveOp = {
  type: 'member.remove';
  member_id: string;
  device_ids: string[];
  reason_code?: 'left' | 'lost_device' | 'compromise' | 'room_policy' | 'other';
  effective_epoch: number;
};
```

### 12.5 Key rotation cadence

Required rotations:

- every member add;
- every member/device remove;
- suspected compromise;
- admin-triggered manual rotation.

Recommended rotations:

- periodic monthly rotation for high-risk rooms;
- after a recovery kit is used;
- after code transparency violation or client compromise incident.

### 12.6 Recovery options

| Recovery method | Description | Privacy risk | Availability benefit |
|---|---|---|---|
| Existing device adds new device | User scans QR from old device | Low | High |
| Admin re-adds member | Room admin removes lost device and adds new one | Admin can deny; no server recovery | High |
| Recovery kit | Encrypted local export containing member recovery capability | User must secure kit | High |
| Threshold recovery | M-of-N admins authorize new device | More complex | Very high |
| Platform support | Not available | Would break privacy | None |

Recovery kit contents MUST be encrypted with a strong passphrase or hardware-bound key and should support printed/manual backup codes only if carefully designed and audited.

#### 12.6.1 Threshold recovery mechanism

Threshold recovery is **capability-based, not secret-sharing-based**, by default. M-of-N recovery does not split the room root key with Shamir; instead, a new device is admitted only when **M distinct holders of the `recover`/`rotate_keys` capability each sign a recovery-authorization op** referencing the same new-device KeyPackage, and the threshold of valid signatures triggers an MLS Add + epoch rotation:

```text
recovery_request(new_device_key_package)
  -> collect M signed RecoveryAuthorizeOp from distinct recovery_admins   // each is a normal signed op
  -> when M reached and validated: MLS Add(new_device) + Commit -> new epoch
  -> Welcome + bootstrap heads sent to the new device
```

This keeps recovery inside the same signed-op + MLS authority model (no offline key reconstruction, no single point that holds a reassembled root key), and the threshold is enforced by the deterministic reducer (§14.3) counting valid distinct authorizations. The `threshold` policy in the manifest (§13.1) pins `required` (M) and the eligible role.

Splitting an actual secret (e.g. a Shamir-shared recovery seed across trustees) is an **optional, separately-audited** alternative for rooms that need to recover even when fewer than M admins remain reachable; it is deferred (§30.8) and MUST NOT be the default because reconstructing a real key materially raises the blast radius of trustee compromise.

### 12.7 Lost all keys

If all admin/recovery devices are lost and no recovery kit exists, the room is unrecoverable. Licio support MUST NOT offer a false recovery path.

---

## 13. Private room data model

### 13.1 Plaintext manifest

```ts
type PrivateRoomManifestPlainV1 = {
  schema: 'licio.private.room_manifest.v1';
  room_id: string;
  created_at: string;

  // The §12.1 founder — the ONLY identity permitted to author the genesis
  // self-add.  Committed by the manifest commitment, so every device that
  // verifies the manifest pins the same genesis author and a forged competing
  // genesis (a member self-adding as admin on an empty fold) is rejected
  // network-wide (§14.2 genesis rule).
  founder: { member_id: string; device_id: string };

  profile: {
    name: string;
    description?: string;
    room_type:
      | 'global_topic'
      | 'local_geographic'
      | 'professional_domain'
      | 'event'
      | 'learning'
      | 'steward';
    avatar_attachment_id?: string;
  };

  policy: {
    directory_mode: 'listed' | 'unlisted' | 'detached';
    membership_change: 'admin' | 'threshold';
    threshold?: { required: number; eligible_role: 'admin' | 'recovery_admin' };
    posting_policy: 'all_members' | 'role_gated';
    role_gated_posters?: Array<'moderator' | 'admin'>;
    allow_member_invites: boolean;
    default_new_member_role: 'member';
    transport_mode: 'direct_allowed' | 'relay_preferred' | 'relay_only';
    replication_target: number;
    small_op_padding: '4k' | '16k' | 'off';
    allow_blind_push: boolean;
  };

  crypto: {
    room_public_key: string;
    mls_group_id: string;
    current_epoch: number;
    mls_cipher_suite: string;
    envelope_profile: 'licio-private-envelope-v1';
    cid_profile: 'licio-private-cid-v1';
  };

  roots: {
    membership_log_root: string;
    capability_log_root: string;
    operation_log_root: string;
    latest_snapshot?: string;
  };
};
```

### 13.2 Operation envelope plaintext

```ts
type PrivateRoomOpPlainV1 = {
  schema: 'licio.private.op.v1';
  room_id: string;
  epoch: number;

  // op_id is DERIVED, never author-chosen: op_id = base32/64(sha256(canonical
  // ['licio.private.op-id.v1', author_device_id, author_seq])).  This makes it
  // "fully determined by op content" (§14.3.2) and non-forgeable across authors:
  // two ops from different devices can never share an id, and `openOp` rejects any
  // envelope whose op_id != deriveOpId(author_device_id, author_seq).  A free-string
  // op_id would let a member squat another member's id and displace their op via
  // the device-fork resolver.
  op_id: string;
  author_member_id: string;
  author_device_id: string;
  author_seq: number;

  created_at: string;
  created_at_bucket: string;
  lamport: string;
  parents: string[];

  body:
    | MemberAddOp
    | MemberRemoveOp
    | RoleGrantOp
    | RoleRevokeOp
    | StoryCreateOp
    | StoryEditOp
    | StoryTombstoneOp
    | ThreadStateOp
    | ContributionCreateOp
    | ContributionEditOp
    | ContributionTombstoneOp
    | SummaryCreateOp
    | AttachmentAddOp
    | SnapshotCommitOp;
};
```

### 13.3 Story/content ops

Private rooms preserve Licio's content taxonomy while keeping it local.

```ts
type StoryCreateOp = {
  type: 'story.create';
  story_id: string;
  thread_id: string;
  title: string;
  submission_type:
    | 'link'
    | 'original_brief'
    | 'question'
    | 'evidence_card'
    | 'local_update'
    | 'live_thread'
    | 'image_post'
    | 'video_post';
  topic_ids: string[];
  language?: string;
  sensitivity_labels?: string[];
  location_scope?: unknown;
  submission_metadata: unknown;
  attachment_refs?: string[];
};
```

`submission_metadata` MUST validate against a private equivalent of the existing Licio story schema. For private links, canonical URL normalization MUST happen locally and MUST NOT call server URL normalization or server safety services.

### 13.4 Thread state

```ts
type ThreadStateOp = {
  type: 'thread.state';
  thread_id: string;
  conversation_state: 'active' | 'deepening' | 'tense' | 'under_review' | 'resolved' | 'archived';
  safety_state: 'normal' | 'elevated' | 'under_review' | 'restricted';
  reason?: string;
};
```

Private rooms may use room-local safety states, but these are not platform moderation decisions.

### 13.5 Contribution ops

```ts
type ContributionCreateOp = {
  type: 'contribution.create';
  contribution_id: string;
  thread_id: string;
  // The op.v1 WIRE vocabulary is FROZEN (an op is immutable signed history):
  // every historically-valid value still parses; retired values NORMALIZE to
  // the live model at parse time (retired contribution types → 'comment' —
  // the same map server migration 0076 applies to mutable rows).  New writes
  // emit the live two-type taxonomy only.
  contribution_type: 'comment' | 'correction'; // normalized; wire accepts op.v1's historical set
  body_markdown_lite: string;
  citations: Citation[];
  metadata: Record<string, unknown>;
  target_claim_id?: string;
  parent_contribution_id?: string;
  lens_id?: string;
  attachment_refs?: string[];
  client_draft_id: string;
};
```

Private contribution validation SHOULD mirror server-hosted rules: typed body caps, at least one citation on a correction, maximum tree depth, lens belongs to room, and attachment validation.

### 13.6 Attachment manifest

```ts
type PrivateAttachmentManifestPlainV1 = {
  schema: 'licio.private.attachment_manifest.v1';
  attachment_id: string;
  room_id: string;
  created_by_member_id: string;
  created_at: string;

  media_kind: 'image' | 'video' | 'audio' | 'document' | 'caption' | 'other';
  content_type: string;
  byte_size_exact_encrypted: number;
  byte_size_class: 'tiny' | 'small' | 'medium' | 'large' | 'huge';

  encrypted_chunks: Array<{
    index: number;
    cid: string;
    size: number;
    plaintext_hash_commitment: string;
    ciphertext_hash: string;
  }>;

  accessibility: {
    alt_text?: string;
    captions_attachment_id?: string;
  };

  local_safety: {
    metadata_stripped: boolean;
    user_confirmed_right_to_share: boolean;
  };
};
```

The exact plaintext size SHOULD be hidden for small objects through padding. Large media can expose approximate size classes unless users choose high-padding mode.

### 13.7 Local-only search index shard

```ts
type PrivateLocalSearchShardPlainV1 = {
  schema: 'licio.private.local_search_shard.v1';
  room_id: string;
  snapshot_root: string;
  shard_id: string;
  index_kind: 'title' | 'body' | 'citation' | 'attachment_alt';
  terms: unknown; // implementation-specific local encrypted index payload
};
```

This object is optional and SHOULD remain local by default. Syncing encrypted search shards between devices owned by the same member MAY be supported, but cross-member search-index sync is not required and can leak metadata if poorly designed.

---

## 14. Operation log, conflict handling, and deterministic reduction

### 14.1 Log structure

The private room operation log is a signed encrypted DAG:

```text
op_1 ──┐
       ├── op_3 ── op_5
op_2 ──┘       └── op_6
op_4 ─────────────┘
```

Each op includes parent op IDs. Devices exchange heads, fetch missing ancestors, validate, and reduce.

### 14.2 Validation pipeline

For every fetched op:

1. CID exists in local blockstore.
2. Envelope decodes under the private CID profile.
3. Envelope signature verifies.
4. AEAD opens using an authorized epoch key.
5. Plaintext schema validates strictly.
6. `room_id` matches the room.
7. Epoch is valid for the operation type.
8. Author device existed and had not been removed at the operation epoch.
9. Author sequence number is monotonic per device.
10. Parents exist or are queued as missing dependencies.
11. Capability check passes for the operation type.
12. Type-specific semantic validation passes.
13. Operation is inserted into the accepted DAG or quarantined with reason.

Quarantined operations MUST NOT render.

### 14.3 Deterministic reducer

The reducer is a **pure fold over the accepted operations in one canonical total order**. Two devices holding the same accepted op set MUST produce byte-identical state.

Reducer input:

```text
accepted ops (validated per §14.2) + current trust policy + local member settings
```

Reducer output:

```text
room state
story list
thread projections
contribution trees
member/capability state
local moderation overlays
replication state
```

#### 14.3.1 Lamport clock

Each op carries `lamport`, a non-negative integer Lamport timestamp **serialized as a decimal string** so it stays exact beyond 2^53 (JavaScript `number` cannot represent large integers losslessly). On creation:

```text
lamport(op) = 1 + max( { lamport(p) : p ∈ op.parents } ∪ { local_lamport } )
```

Validation adds one rule to §14.2: an op's `lamport` MUST be strictly greater than every parent's `lamport`, else the op is rejected. This makes the Lamport order a **linear extension of causality** — a parent always precedes its child.

#### 14.3.2 Canonical total order

Accepted ops are sorted ascending by the tuple:

```text
( lamport (as big integer), created_at_bucket, author_device_id, op_id )
```

Because `lamport(child) > lamport(parent)` always holds (§14.3.1), this single sort already respects every causal edge; the remaining three components only break ties between **truly concurrent** ops, and each is fully determined by op content, so every device derives the identical sequence. The reducer folds the ordered ops through the per-type transition functions.

#### 14.3.3 Determinism requirements

- The fold MUST NOT depend on local wall-clock time, network arrival order, map/object iteration order, or floating point.
- "Latest valid author edit wins" (§14.4) is decided by position in this total order, never by `created_at` timestamps (which are untrusted, §14.4).
- Canonical encoding (§10.1.1) governs every hashed/compared structure, so equal logical state yields equal bytes.
- A CI property test (§26.1) asserts byte-identical reducer output across shuffled op-delivery orders over generated DAGs.

### 14.4 Conflict policy

| Conflict | Resolution |
|---|---|
| Two story edits by same author | Latest valid author edit wins; edit history retained. |
| Concurrent edits by different unauthorized users | Unauthorized edits rejected. |
| Moderator tombstone vs author edit | Valid moderator tombstone hides current display. Edit history remains encrypted in log. |
| Member removed while posting | Ops after effective removal epoch rejected. |
| Same `client_draft_id` posted twice | Idempotent dedup per author device. |
| Parent contribution missing | Queue until parent arrives; do not render. |
| Parent invalid/tombstoned | Render according to tombstone policy; invalid parent rejects child unless policy allows orphan display. |
| Unknown future op schema | Store encrypted block, do not render, show “unsupported room update” locally. |

### 14.5 Snapshots

Snapshots prevent unbounded replay cost.

```ts
type SnapshotCommitOp = {
  type: 'snapshot.commit';
  snapshot_id: string;
  includes_ops_up_to: string[];
  state_merkle_root: string;
  snapshot_body_cid: string;
  created_by_member_id: string;
};
```

Rules:

- Snapshots are optimization hints, not absolute authority.
- A snapshot is trusted only if signed by an authorized role and verified against accepted ops.
- Clients MAY keep old ops for audit and conflict recovery.
- Clients MAY prune old decrypted derived state, but encrypted operation history should be retained unless room policy allows compaction and enough members agree.

### 14.6 Local moderation overlays

Members may maintain local-only overlays:

```ts
type LocalOverlay = {
  hidden_members: string[];
  hidden_contributions: string[];
  muted_threads: string[];
  blocked_media: string[];
};
```

Local overlays are not synced unless the user explicitly exports/imports their preferences.

---

## 15. P2P sync protocol

### 15.1 Sync principles

1. Sync encrypted blocks and signed ops only.
2. Do not reveal private CIDs to non-members.
3. Do not announce private CIDs to public routing systems.
4. Use room-epoch-scoped peer identities where practical.
5. Batch and jitter network announcements.
6. Support offline-first operation.
7. Prefer lazy fetching to reduce bandwidth.
8. Treat peers as untrusted transport sources; validate everything locally.

### 15.2 Peer discovery modes

| Mode | Description | Use case |
|---|---|---|
| Local mDNS explicit | Discover peers on same LAN only after user enables it | Homes/offices with trusted LANs |
| Licio blind rendezvous | Licio relays opaque peer-discovery/signaling records | Default usability path |
| Member rendezvous | A member-operated rendezvous server | Higher trust rooms |
| Manual rendezvous | QR/file copy of peer addresses and encrypted CAR files | Maximum privacy |

### 15.3 Blind rendezvous key derivation

Blind IDs are derived from `rendezvous_key`, the per-epoch key from the §10.2 schedule (`rendezvous_key = HKDF-Expand-Label(room_epoch_secret, "rendezvous.v1", room_id_commitment, 32)`). Inputs are `canonical(...)`-encoded (§10.1.1), never raw `||` concatenation, so field-boundary ambiguity cannot create blind-ID collisions:

```text
room_blind_id = HMAC-SHA256(rendezvous_key, canonical(["room", epoch, time_bucket]))
peer_blind_id = HMAC-SHA256(rendezvous_key, canonical(["peer", device_id, epoch, time_bucket]))
```

The rendezvous server stores only:

```ts
type BlindRendezvousRecord = {
  room_blind_id: string;
  peer_blind_id: string;
  encrypted_announcement: string;   // E2E-encrypted under rendezvous_key; server cannot open
  expires_at: string;
};
```

TTL SHOULD be short, for example 5 to 30 minutes.

#### 15.3.1 Authorization

Knowledge of `rendezvous_key` **is** the rendezvous capability: only current-epoch members can compute a room's `room_blind_id`, so only they can announce under it or poll it. The server performs no ACL check — it cannot, because it does not know which account maps to which `room_blind_id`. A non-member cannot derive the blind ID, and a **removed member loses it at the next epoch** (§10.9) because `rendezvous_key` rotates with `room_epoch_secret`. Polling an unknown `room_blind_id` returns the same bounded, opaque result whether or not records exist, so the endpoint is not a room-existence oracle for outsiders.

#### 15.3.2 Residual metadata and mitigations

Blind rendezvous is honest about what the server still sees (cf. §5.4):

- **Approximate concurrent size.** Within one `time_bucket`, distinct `peer_blind_id`s announcing under the same `room_blind_id` reveal an approximate count of currently-online devices. Mitigate with coarser buckets, per-peer announcement jitter, optional cover/dummy announcements for high-risk rooms, and member-operated rendezvous (§15.2) for rooms that do not want Licio to see even this.
- **Timing.** Announcement and poll timing leak coarse activity. Mitigate with batching, jitter, and relay-only mode.
- **Endpoint correlation.** The transport endpoint (IP) reaching the rendezvous service is visible to it; this is decoupled from room identity but not from the announcing device. Relay-only mode and standard network-privacy tooling are the user's levers.

High-risk rooms SHOULD prefer `member_rendezvous` or `manual` discovery (§15.2) and disable Licio blind rendezvous entirely.

### 15.4 WebRTC signaling

Signaling messages MUST be encrypted end-to-end before they reach the server. The server only routes opaque blobs.

```ts
type EncryptedSignal = {
  room_blind_id: string;
  sender_blind_id: string;
  recipient_blind_id?: string;
  ciphertext: string;
  expires_at: string;
};
```

ICE candidates can reveal network information. Relay-only mode SHOULD be available for rooms whose members do not want to reveal IP addresses to one another.

### 15.5 Handshake

Private libp2p handshake:

```text
1. Transport connection established.
2. Peers exchange protocol version and ephemeral peer keys.
3. Each peer proves membership by signing a challenge with a room-valid device key.
4. Peers derive a pairwise session key from current epoch material and ephemeral ECDH.
5. Peers exchange encrypted head summaries.
6. Peers request missing blocks.
```

Handshake transcript MUST be bound to room ID commitment, epoch, protocol version, and peer ephemeral keys to prevent replay or cross-room confusion.

### 15.6 Head announcement

```ts
type HeadAnnouncementPlainV1 = {
  schema: 'licio.private.heads.v1';
  room_id: string;
  epoch: number;
  device_id: string;
  known_heads: string[];
  latest_snapshot?: string;
  op_count_bucket: string;
  want_ranges?: Array<{ from?: string; to?: string }>;
};
```

This object is encrypted on the pairwise sync channel. It is not sent to the main server.

### 15.7 Missing block protocol

```ts
type BlockRequestV1 = {
  schema: 'licio.private.block_request.v1';
  cids: string[];
  priority: 'manifest' | 'ops' | 'thread' | 'media' | 'snapshot';
  max_bytes: number;
};

type BlockResponseV1 = {
  schema: 'licio.private.block_response.v1';
  blocks: Array<{ cid: string; bytes: Uint8Array }>;
  missing: string[];
};
```

Peers MAY refuse large requests or require backoff. All returned blocks are verified by CID, signature, and encryption before use.

### 15.8 Sync priority

Fetch order:

1. room manifest and current epoch metadata;
2. membership/capability ops;
3. operation heads and missing ancestors;
4. thread/story index ops;
5. visible text contributions for current viewport;
6. summaries;
7. media manifests;
8. media chunks on demand;
9. old archives and snapshots.

This improves perceived performance and minimizes bandwidth.

### 15.9 Offline CAR exchange

Every room SHOULD support encrypted CAR export/import:

```text
Export selected encrypted blocks -> CAR file -> share via USB/AirDrop/manual upload -> import -> verify -> reduce
```

CAR exports MUST contain ciphertext only. The container MAY be either a standard IPLD CAR or the LCAP `.licio-bundle` pack (`docs/OFFLINE_SPEC.md` §14), which adds streaming parse under resource caps, dependency-first ordering, byte-range resume, and quarantine-before-render — all valuable for hostile-transport import. Either way, the importer re-runs the full §14.2 validation pipeline (CID, signature, AEAD, schema, capability) before any block is rendered; the container format never confers trust. Export UI MUST distinguish:

- encrypted backup for members;
- decrypted personal archive;
- voluntary report package.

---

## 16. Local storage, pinning, backup, and availability

### 16.1 Browser storage

Use IndexedDB-backed blockstore/datastore for the PWA.

Stores:

```text
licio_private_rooms
licio_private_blocks
licio_private_ops
licio_private_heads
licio_private_keys
licio_private_snapshots
licio_private_local_search
licio_private_outbox
licio_private_replication
```

### 16.2 Storage encryption

Private blocks are already encrypted at object level. Key material and derived local indexes require additional local protection.

Local key store:

```ts
type LocalPrivateKeyRecord = {
  key_id: string;
  room_id: string;
  protection_mode:
    | 'passphrase_argon2id'
    | 'webcrypto_non_extractable_wrap'
    | 'passkey_assisted'
    | 'local_key_agent';
  encrypted_key_material: string;
  created_at: string;
  last_verified_at?: string;
};
```

The implementation SHOULD use Argon2id or a similarly reviewed memory-hard KDF for passphrase-protected exports. If platform/browser support is insufficient, the UI must warn users and encourage multi-device recovery.

### 16.3 Availability model

Because installed PWAs are not reliable always-on background daemons, private-room availability depends on replicas.

Room replication targets:

| Room size | Recommended encrypted replicas |
|---:|---:|
| 2 members | 2 devices + 1 optional pin |
| 3-10 members | 3 devices minimum |
| 11-50 members | 5 devices or pins |
| High-value room | threshold-admin devices + encrypted pin policy |

### 16.4 Replication health UI

Room header MUST show:

```text
Replication: 2/3 recommended copies online recently
Last full sync: 2026-06-15 13:42 local
Missing blocks: 0 text, 3 media chunks
Backup: recovery kit not created
Transport: relay preferred
```

The UI SHOULD avoid showing exact peer identities unless the user opens a detailed member panel.

### 16.5 Member-operated encrypted pinning

P2P private rooms MAY support member-operated encrypted pins:

- a local desktop node;
- a NAS or home server;
- a VPS controlled by a member;
- a browser profile on another device.

Pinning nodes receive ciphertext and room authorization sufficient to fetch/store encrypted blocks. Ideally they do not receive plaintext keys unless they are also a member device. A “dumb encrypted pin” can store blocks without decrypting them.

Licio-controlled default pinning is out of scope for maximum privacy. If added later, it must be explicit, separate from the main server, blind to room identity/content, and never enabled by default.

### 16.6 Backups

Backup types:

| Backup | Contents | Who can use it |
|---|---|---|
| Encrypted block backup | Ciphertext blocks only | Members with keys |
| Recovery kit | Member/device recovery secret | Owner or threshold recovery group |
| Decrypted personal archive | Plaintext export | Exporting user; highly sensitive |
| Voluntary report package | Selected plaintext + proofs | Licio safety team if submitted |

Backups MUST be clearly labeled. Decrypted exports require a strong warning.

---

## 17. Media and attachment pipeline

### 17.1 Local-only media handling

P2P private media MUST NOT use server upload scan gates or server object storage. The client handles:

1. file selection;
2. local MIME sniffing and size checks;
3. local metadata stripping;
4. optional local thumbnail/poster generation;
5. required alt text for images;
6. caption support for video;
7. chunking;
8. encryption;
9. encrypted manifest creation;
10. P2P block sync.

### 17.2 Metadata stripping

Images and videos SHOULD have metadata stripped locally before encryption. If a file type cannot be safely stripped, the UI must warn:

```text
This file may contain metadata such as device, location, author, or edit history. Licio cannot inspect private-room files on the server, so metadata removal must happen on your device.
```

### 17.3 Local safety controls

Because server scanning is impossible without disclosure, members get local controls:

- never auto-download large media;
- blur unknown media by default;
- hide media from unverified members;
- block file types locally;
- per-member media mute;
- report/export package for selected media;
- optional client-side perceptual hash warning for the user's own blocked library, without server lookup.

### 17.4 Streaming

Large media should use encrypted chunk manifests with range-like retrieval:

```text
media manifest -> chunk index -> fetch encrypted chunks lazily -> decrypt locally -> stream to media element via MediaSource where supported
```

The client SHOULD prefetch only the next few chunks and SHOULD not fetch full large videos automatically.

### 17.5 Accessibility

Image posts require alt text. Video posts SHOULD support captions through encrypted caption attachments or inline caption text. Accessibility requirements do not weaken privacy: alt text and captions are private-room content and encrypted like everything else.

---

## 18. Search, ranking, recommendations, notifications, and analytics

### 18.1 Search

P2P private search is local-only.

Forbidden:

```text
server full-text indexing
server embeddings
server query suggestions
server query logs
server private content snippets
server typo correction
server semantic search API
```

Allowed:

```text
local decrypted in-memory search
local encrypted index shards
per-device search history stored locally only
manual encrypted index sync between a user's own devices
```

### 18.2 Ranking and recommendations

P2P private content MUST NOT enter Licio PWAtt ranking, public feeds, topic surfaces, global search, cross-room recommendations, invariant services, or attention pipelines.

Private room UI may use local sorting:

- unread first;
- recent local activity;
- pinned by room-local moderators;
- thread state;
- user-selected filters;
- local-only “needs reply” markers.

Local sorting must be explainable and must not create global distribution signals.

### 18.3 Attention and analytics

No private-room attention data leaves the device.

Allowed local-only data:

- local read/unread state;
- local draft state;
- local notification preferences;
- local last-opened timestamp;
- local media download choices.

Forbidden server data:

- dwell time;
- scroll depth;
- thread open counts;
- private notification opens;
- contribution impressions;
- per-room activity analytics;
- private-room funnel metrics.

### 18.4 Notifications

Notification modes:

| Mode | Payload | Server knowledge | Default |
|---|---|---|---:|
| Local-only | Generated while app/device has state | None | Yes |
| Blind push ping | “Open app to sync” with opaque payload | Timing + push endpoint | Optional |
| Content push | Thread title/body/sender | Too much | Forbidden |

Blind push payload:

```ts
type BlindPrivatePushV1 = {
  schema: 'licio.private.blind_push.v1';
  opaque_room_hint: string;
  wake_reason: 'sync_available';
  nonce: string;
};
```

Even blind push can leak timing. High-risk rooms should disable it.

---

## 19. Moderation, reports, trust, and safety

### 19.1 Room-local moderation

Room-local moderators may create signed ops:

- contribution tombstone;
- thread restriction;
- member warning;
- member removal;
- media hide recommendation;
- room rule update;
- summary/steward note.

These are private-room operations. They are not platform moderation decisions.

### 19.2 Member-local controls

Every member can:

- leave room;
- delete local room data;
- hide a contribution locally;
- mute/block a member locally;
- disable media auto-fetch;
- export encrypted backup;
- create a voluntary report package.

### 19.3 Platform moderation boundary

Licio platform staff can moderate only:

- listed directory names/descriptions/avatars;
- abuse of Licio-controlled rendezvous infrastructure;
- public spam linking to invites;
- voluntary report packages submitted by a member.

They cannot proactively inspect private content.

### 19.4 Voluntary report package

```ts
type VoluntaryPrivateReportPackageV1 = {
  schema: 'licio.private.report_package.v1';
  report_id: string;
  reporter_account_id?: string;
  room_stub_id?: string;
  disclosed_items: Array<{
    kind: 'story' | 'thread' | 'contribution' | 'media' | 'membership_op';
    plaintext_json?: unknown;
    plaintext_media_file?: string;
    envelope_cid?: string;
    signatures: string[];
    author_device_keys: string[];
    context_notes?: string;
  }>;
  redaction_notes: string;
  reporter_attestation: string;
  created_at: string;
};
```

The UI MUST preview exactly what will be disclosed. Submission is an intentional privacy boundary crossing.

### 19.5 Trust indicators

Private room UI should show:

- verified/unverified member devices;
- recent membership changes;
- room safety number changed warning;
- update-channel trust state;
- replication health;
- backup health;
- transport mode;
- whether blind push is enabled.

---

## 20. User experience requirements and mandatory copy

### 20.1 Naming

Use these labels consistently:

- **Public room**: server-hosted and public.
- **Members-only server room**: server-hosted and membership-gated; Licio can technically access content.
- **Private P2P room**: end-to-end encrypted and member-hosted.

Do not call server-hosted restricted rooms “private” without a qualifier.

### 20.2 Creation screen requirements

Creation screen fields:

```text
Room name
Directory mode: unlisted default, listed optional, detached advanced
Transport mode: relay preferred default
Replication target
Allow blind push: off by default for high privacy, on optional
Require admin approval for invites: on by default
Recovery kit: create now / remind later
```

Mandatory acknowledgment checkboxes:

- Licio cannot read or recover this room.
- If keys are lost, access can be lost permanently.
- Members can copy or disclose content.
- Removing a member does not delete content they already received.
- Availability depends on member devices or member-operated pins.

### 20.3 Room header requirements

Display compact status:

```text
Private P2P · Unlisted · Relay preferred · 3/3 replicas · Backup created · Safety number verified
```

Clicking expands details.

### 20.4 Invite UX

Invite screen MUST show:

- role granted;
- expiration;
- max uses;
- approval requirement;
- warning not to paste invite links in public spaces;
- copy/QR/export options;
- revoke invite action.

### 20.5 Removal UX

Removal dialog MUST say:

```text
This stops the member from reading future room updates after keys rotate. It cannot delete or recall content they already downloaded or copied.
```

### 20.6 Update trust UX

If the current private-mode client bundle is not in the transparency log, not signed by required maintainers, or differs from the pinned hash, private rooms should lock with a clear message:

```text
Private room locked: this Licio build has not passed private-mode code verification. Your room keys were not unlocked. You can keep using public Licio, review the update, or switch to a verified build.
```

---

## 21. Server API specification

### 21.1 Create private room stub

```http
POST /v1/private-rooms
```

Request:

```ts
type PrivateRoomCreateStubRequest = {
  directory_mode: 'listed' | 'unlisted';
  display_name?: string;
  display_description?: string;
  display_avatar_public_cid?: string;
  rendezvous_policy: 'licio_blind' | 'member_rendezvous' | 'manual_only';
  bootstrap_hints?: unknown[];
  // A CLOSED set of PUBLIC commitments — see the validation notes below.
  signed_stub: {
    schema: 'licio.private.directory_stub.v2';
    room_public_key: string;
    manifest_key_commitment: string;
  };
  stub_signature: string;
  // The §21.2 capability, sent BESIDE the signed body, stored in its own column.
  bootstrap_blind_id: string;
};
```

Response:

```ts
type PrivateRoomCreateStubResponse = {
  room_server_id: string;
  stub_id: string;
  bootstrap_endpoints: string[];
  created_at: string;
};
```

Validation:

- Authenticated account required for listed/unlisted stub creation.
- No private CIDs allowed.
- No operation heads allowed.
- No member list allowed.
- Display fields allowed only for `listed` rooms.
- Rate limit by non-reversible account reference, not IP in app logic.

The first four are enforced by SHAPE, not by a handler check: the request
schema is `.strict()`, so a forbidden key is rejected because no such field
exists. The fifth is an explicit REFUSAL rather than a silent strip — an
`unlisted` request carrying a display name is rejected, because dropping it
quietly would leave the client believing the directory serves a name it can
see locally. `signed_stub` gets its own treatment, in three layers. It is
one jsonb column, so the §8.2 column allowlist cannot see inside it — and a
free-form body behind a strict envelope is a hole in the strictness, not an
extension point. So the body is itself a CLOSED, `.strict()` set: a schema tag
and two PUBLIC commitments (`room_public_key`, `manifest_key_commitment`).
There is no legal place to put a member list, and no nesting to hide one in.
Behind that, the §8.1 key-class scan still runs on every write — an independent
guard that would catch a future widening of the shape before it reached the
column. It scans at every depth and REFUSES a body that nests past the depth
bound, since a scan that stops looking cannot report clean.

The third layer is what is NOT in the body. `bootstrap_blind_id` used to live
inside it, and a jsonb blob is projected wholesale or not at all — so the §21.2
capability rode every projection of that blob, including the OPEN read a
`listed` room serves. With §21.2's directory enumerating listed room ids, that
is a harvest: one anonymous GET per room yields a token that keeps resolving the
record after its creator delists it, which is the precise state delisting
exists to prevent. It is therefore its OWN column (migration `0120`), named in
the §8.2 allowlist, absent from every response type, and compared in constant
time against the `?token=` a reader presents. Signing it bought nothing —
the signature is verified against `room_public_key`, which the signed body
itself carries, so it means something only to a reader who already knows the
room's key independently, i.e. a member, who holds the token. What the
capability needs is secrecy, which a signature does not provide. Gating the
projection would have closed the leak that was found; moving the secret out of
the projected structure closes the ones in endpoints not yet written.

`room_public_key` and `manifest_key_commitment` are absent from the REQUEST for
the same reason in a different key: they exist as columns the server serves AND
inside the signed body, and nothing bound the two, so a client could publish one
pair and sign another. The bootstrap response then presented unsigned
commitments beside a signature verifying over different ones. The columns are
now DERIVED from the signed body on write — one value, so there is no second
copy to disagree, at this write site or at the next one.

`detached` is absent from the create enum on purpose — a detached room stores
no stub at all, which the `private_room_stubs_not_detached` CHECK also pins.

The endpoint mints the P2P room SHELL and its stub in one transaction, with
all four §4.1 axes (`storage_mode='p2p'`, `authority_model='room_keys'`,
`visibility='private'`, `join_model='invite'`) written together so the §23.2
coherence CHECKs decide validity rather than the call site. The shell's
`name`/`slug` are OPAQUE in both directory modes: they are NOT NULL columns
feeding a generated `search_vector`, so a real title there would put a private
room's name into the server's full-text index. A `listed` room's display
metadata lives only on the stub.

### 21.2 Fetch bootstrap stub

```http
GET /v1/private-rooms/:roomServerId/bootstrap
```

For listed rooms, returns public stub fields. For unlisted rooms, requires an
invite-derived blind token.

The token is a **capability the room derives and the server merely stores**, so
the server can check it while holding no room key: at create time the client
sends `bootstrap_blind_id` — derived from the room's rendezvous key, exactly as
the §15.3 blind ids are — as its own top-level field, the server keeps it in its
own column, and the reader presents the same value as `?token=`. The server
compares the two in constant time. It learns nothing from either: the value is
an HMAC output over material it does not hold.

It is deliberately NOT inside `signed_stub`. That body is projected wholesale to
anonymous readers of a `listed` room, so a secret placed in it is published to
everyone — see §21.1. Signing the token would add nothing anyway: the signature
verifies against `room_public_key`, which the signed body itself carries, so it
means something only to a reader who already knows the room's key — a member,
who holds the token.

The token is derived from the room's **epoch-0** rendezvous key and therefore
**does NOT rotate**, unlike the §15.3 rendezvous blind ids it is built the same
way as. That is deliberate and load-bearing: an invite handed out today must
still resolve the record tomorrow, and after the next membership change. A
rotating capability would strand every outstanding invite at each epoch, which
for a bootstrap pointer is a correctness bug rather than a hardening measure.

The honest cost: a **removed member keeps a working token**. What it resolves is
a record of commitments and bootstrap policy — no content, no keys, no member
list, and for an `unlisted` room not even a name. Nothing there is anything an
ex-member did not already know, having been in the room; rotating it would
break every honest invite to withhold information the adversary already holds.
Every stub therefore carries a token, whatever directory mode it was created
in, because a `listed` record can always be delisted later and must stay
resolvable for its members when it is (§21.4).

**A wrong token, a missing token, an unknown room id, and a MALFORMED room id
all return the identical 404.** This is §15.3.1's no-existence-oracle property
applied to the directory: distinguishing them would turn the endpoint into a
probe for which private rooms exist, which is precisely what `unlisted` mode is
for. A `detached` room has no stub, so it 404s too — correctly, since it never
asked to be reachable this way.

P2P rooms are also absent from `GET /v1/rooms`. Listing the shell would publish
the existence of every `unlisted` room, and would render a `listed` one through
a server room summary whose join/steward/lens affordances do not apply to it.
The private-room endpoints below are the only directory reads.

**Browse the listed directory.**

```http
GET /v1/private-rooms/directory?limit=<1..50>&cursor=<opaque>
```

```ts
type PrivateRoomDirectoryResponse = {
  entries: Array<{
    room_server_id: string;
    display_name: string | null;
    display_description: string | null;
    display_avatar_public_cid: string | null;
    created_at: string;
  }>;
  next_cursor: string | null;
};
```

§4.2 defines `listed` as the mode where *“room directory/search can show the
room shell”*, so this is the endpoint that makes the mode real; without it
`listed` and `unlisted` differed only in what the server was permitted to store.
Four properties hold:

- **`listed` only.** The mode is filtered in the QUERY, not by the caller.
  `unlisted` existence is exactly what must never be enumerable (§15.3.1), and
  `detached` rooms have no stub at all.
- **Display metadata only.** The commitments, the bootstrap hints and the signed
  body stay behind `GET /bootstrap`. The CAPABILITY is not in any of them — it is
  its own never-projected column (§21.1) — but a browse row is a browse row: it
  publishes what a room chose to publish, and a reader who wants the record's
  commitments can ask for the record.
- **Unauthenticated,** like the listed bootstrap read: the contents are public by
  the creator's explicit choice, and requiring an account would only add an
  identity to a read that needs none.
- **Keyset paging** on `(created_at, stub_id)` descending. An offset would skip
  or repeat rows as stubs are created and delisted underneath the reader.

Delisting removes a room from this surface immediately (§21.4) — that is what
delisting IS, and the bootstrap record survives it.

Being in the directory is not a way in: a P2P room is `join_model='invite'` and
the server holds no key that could admit anyone, so the client must not present a
join affordance here. What the directory buys a reader is knowing the room exists
and whom to ask.

### 21.3 Update stub

```http
PATCH /v1/private-rooms/:roomServerId
```

Allowed updates:

- listed display name/description/avatar;
- rendezvous policy;
- bootstrap hints;
- latest manifest commitment.

Forbidden updates:

- member list;
- private CIDs;
- op heads;
- content metadata;
- activity timestamps;
- unread counts;
- the record's IDENTITY.

The last one is not a data class but a property, and it is enforced: a
`signed_stub` replacement whose `room_public_key` differs from the stored one is
refused. `room_public_key` is how a member decides the record was authored by
their room rather than by the server storing it, and ANY member device can build
a signed body — signing it with its own key. So an ordinary commitment refresh
from a device that is not the founder's would silently re-identify the record,
and every member who verifies would conclude their room's entry was forged.
`latest_manifest_commitment` is a plain column outside the signed body, which is
why refreshing it needs no re-signing at all.

**Bootstrap hints are POINTERS, in a closed format per kind, at the primitive's
exact size.** `value` was a
free 1 KiB string, which is the `signed_stub` defect one field along: a strict
outer object around an unrestricted value channel, persisted and re-served
verbatim through a column §8.2 permits precisely because a pointer is not
content. Each kind now names what it can be — `licio_blind` and `manual` are
32-byte base64url (a blind id, an out-of-band exchange code; NOT prose, and not
a bounded string either: an HMAC output has one size, so anything else is a
payload), and `member_relay` is an `https://` or `wss://` endpoint with no
credentials, query or fragment, which is where a payload would otherwise ride a
legitimate-looking URL.

The same rule governs the commitment fields. `room_public_key`,
`manifest_key_commitment`, `bootstrap_blind_id` and `latest_manifest_commitment`
are 32-byte base64url; `stub_signature` is 64. Unpadded base64url of n bytes is
exactly `ceil(n·4/3)` characters, so each is a total constraint rather than a
bound — a field whose name says "commitment" and whose schema says "up to 512
characters" is a content channel, and the strict object and the §8.1 key scan
see only legal field NAMES.

**Every staff delist is recorded BEFORE it is taken.** The moderation audit and
the stub store hold separate connections, so they cannot share a transaction;
the ORDER carries the guarantee instead. An append that fails refuses the action
(503, nothing changed), because the demotion is irreversible and a record
written afterwards could not be rolled back to match. The residual is the
opposite direction — an entry for a demotion that the owner performed in the
same instant, or that was the owner's own — and both are compensated by a
following entry rather than left standing: an over-recorded trail is readable
and correctable, while an under-recorded one hides the use of a power.

### 21.4 Delete/delist stub

```http
DELETE /v1/private-rooms/:roomServerId
POST /v1/private-rooms/:roomServerId/delist
```

**Delist** demotes `listed → unlisted` and drops the display metadata in one
statement (the `private_room_stubs_listed_display_only` CHECK requires those
columns NULL once the mode is no longer `listed`, so a two-step would violate
it midway). The bootstrap record survives, so existing members still resolve
the room; it simply stops advertising itself. Together with delete, this is the
ONLY power platform staff hold over a P2P room — §11.4 holds verbatim.

**Delete** removes the stub AND the room shell. Deleting a stub does not delete
member-held content: the UI must say “remove Licio directory/bootstrap record,”
not “delete private room for everyone,” and the response says so in those
words. The shell goes too rather than surviving as `detached`, because a
lingering shell row still asserts *“this account created a private room at time
T”* — a §8.1 activity trace outliving the very action taken to erase the
server's record. Nothing else ever referenced the id (§8.3 guarantees it), so
the stub is the only dependent row.

### 21.5 Blind rendezvous endpoints

```http
POST /v1/private-rendezvous/announce
POST /v1/private-rendezvous/poll
POST /v1/private-rendezvous/signal
```

All payloads are opaque:

```ts
type RendezvousAnnounceRequest = {
  room_blind_id: string;
  peer_blind_id: string;
  encrypted_announcement: string;
  ttl_seconds: number;
};
```

Limits:

- short TTL;
- bounded payload size;
- blind ID rate limiting;
- aggregate abuse metrics only;
- no content inspection;
- no long-term storage.

### 21.6 Guard existing endpoints

Existing endpoints MUST reject P2P rooms:

```text
POST /v1/stories with p2p room_id -> 409 p2p_room_requires_client_sync
POST /v1/contributions with p2p thread_id -> 409 p2p_room_requires_client_sync
GET /v1/rooms/:id/feed for p2p room -> the unknown-room 404 (identical body)
GET /v1/search -> never returns p2p content
admin APIs -> cannot expose p2p content
```

Response example:

```json
{
  "error": {
    "code": "p2p_room_requires_client_sync",
    "message": "Private P2P rooms are stored and synced on members' devices, not through this server endpoint."
  }
}
```

---

## 22. Client architecture and package layout

### 22.1 New shared package

`packages/private-p2p` is the browser-safe protocol core: schemas, crypto,
the reducer, and the transport-independent sync decision plane. It depends on
`@licio/shared` and `zod` only, never on `@licio/db` and never on
`@licio/lcap` (§1 — the two planes share no keys and no code). The shipped
layout:

```text
packages/private-p2p/src/
  schemas/       common · envelope · manifest · ops · invite · attachment
                 · report · search        (the §3 NORMATIVE zod surface)
  crypto/        canonical (DAG-CBOR) · cid · hkdf · aead · hpke · ecdh
                 · signatures · mls (the ONLY ts-mls importer, §10.7)
                 · epoch · key-store (the four §10.8 tiers) · recovery
                 · safety-number · attachment · device-blind
                 · record-encoding · runtime
    bbs/         suite · signature · blind · proof · pseudonym
  reducer/       validate-op · validate · reduce · state · order · op-id
                 · capabilities · conflicts-by-policy (in `reduce`)
                 · snapshot · snapshot-seal · snapshot-state · overlay
                 · search · recovery-threshold · intake-context
  sync/          rendezvous · signaling · secure-channel · handshake
                 · head-sync · op-exchange · fragment · archive (the §15.9
                 offline encrypted-archive exchange)
  rendezvous-cap/ credential · announcement · poll-filter · session
                 · coordinator
  engine/        room-engine · room-lifecycle · invite · migration
```

Two deviations from the original sketch are deliberate. There is **no
`src/ipld/` directory**: the maintainer-chosen lighter-transport path drops
Helia, so content addressing is the dependency-free CIDv1-over-ciphertext
profile in `crypto/cid.ts` (pinned byte-for-byte against `multiformats`), and
the CAR-equivalent is `sync/archive.ts`. There is **no `src/testing/`
directory**: vectors and generators live beside the code they pin, under
`src/**/__tests__/` (including the RFC-vector fixtures in
`crypto/bbs/__tests__/fixtures/`).

### 22.2 Web integration

The web side holds only what needs the browser — IndexedDB persistence, the
WebRTC carrier, and the HTTP rendezvous transport — so the protocol core stays
environment-free and testable in Node. It is a flat module directory, not a
mirror of §22.1:

```text
apps/web/src/private-p2p/
  storage.ts               the `licio_private_p2p` IndexedDB adapter
  room-manager.ts          PrivateRoomSession: create / load / connect
  session-store.ts         in-tab session state
  connect-peer.ts          the live WebRTC carrier (rendezvous → sealed
                           signaling → membership handshake → PeerChannel)
  sync-session.ts          drives the §15.7 op exchange over a PeerChannel
  rendezvous-client.ts     zod-validated fetch transport for
                           POST /v1/private-rendezvous/*
  rendezvous-cap-manager.ts  peer-side Tier-2 cap enrolment
  ice-config.ts            VITE_ICE_SERVERS parsing (fails closed to none)
  migrate.ts               re-authoring a frozen server room into a P2P room
  e2e-room-harness.ts      Playwright entry points (real-browser convergence)
  e2e-carrier-harness.ts

apps/web/src/components/private-rooms/
  CreatePrivateRoomWizard   PrivateRoomView   InvitePanel
  JoinPanel                 SafetyNumberPanel
```

The enforced boundary is narrower than "this directory is lazy", and the
distinction matters when one of the two mechanisms breaks. What
`check:private-p2p-split` forbids is a static VALUE import of the
`@licio/private-p2p` PACKAGE — the protocol/crypto core — so that core is
reached only through `await import(…)`. The web glue above is ordinary module
code and IS statically imported by its consumers (`CreatePrivateRoomWizard`
imports `room-manager.ts` directly, for instance); what keeps it out of first
paint is route code-splitting plus the measured initial-payload budget in
`check-bundle-size.ts`, which also fails if `index.html` preloads a plane
chunk. Reading the rule as "the whole directory is dynamic" would send a future
change at the wrong invariant.

### 22.3 Worker architecture

Use dedicated workers for expensive/private operations:

```text
main UI thread
  -> private room worker: reducer, local search, sync orchestration
  -> crypto worker: encryption/decryption/signing where possible
  -> media worker: metadata stripping, chunking, thumbnails
```

Workers reduce UI blocking and isolate private code paths. They do not remove the need for update-channel protection.

### 22.4 Service worker role

The service worker may:

- cache the verified private-mode bundle;
- enforce update pinning;
- receive blind push wakeups;
- trigger a sync attempt when allowed by browser lifecycle;
- serve local app assets offline.

It must not be treated as an always-on P2P daemon.

### 22.5 Key agent interface

For Tier 3, define local agent calls:

```text
POST http://127.0.0.1:<random>/licio/private/sign
POST http://127.0.0.1:<random>/licio/private/decrypt-key
POST http://127.0.0.1:<random>/licio/private/mls-commit
POST http://127.0.0.1:<random>/licio/private/export-recovery
```

The local agent must authenticate the web origin, display user approval for sensitive operations, and never expose raw room keys to web JavaScript.

---

## 23. Integration changes for the current Licio codebase

### 23.1 Shared schemas

Update `packages/shared/src/schemas/room.ts`:

- add `storage_mode`, `authority_model`, `directory_mode`;
- add coherence checks;
- add `privateRoomStubSchema`;
- ensure `can_post` is false or omitted for P2P rooms in server projections because posting happens locally.

Add `packages/private-p2p` schemas rather than mixing private op schemas into server story/contribution schemas.

### 23.2 Database

Add enums/tables:

```sql
CREATE TYPE room_storage_mode AS ENUM ('server', 'p2p');
CREATE TYPE room_authority_model AS ENUM ('platform', 'room_keys');
CREATE TYPE room_directory_mode AS ENUM ('listed', 'unlisted', 'detached');

ALTER TABLE rooms
  ADD COLUMN storage_mode room_storage_mode NOT NULL DEFAULT 'server',
  ADD COLUMN authority_model room_authority_model NOT NULL DEFAULT 'platform',
  ADD COLUMN directory_mode room_directory_mode NULL,
  ADD COLUMN p2p_stub_id uuid NULL;

-- Enforce the §4.1 coherence rules structurally, not by convention.
ALTER TABLE rooms
  ADD CONSTRAINT rooms_storage_authority_coherence CHECK (
    (storage_mode = 'server' AND authority_model = 'platform')
    OR (storage_mode = 'p2p' AND authority_model = 'room_keys')
  ),
  ADD CONSTRAINT rooms_p2p_requires_directory_mode CHECK (
    storage_mode = 'server' OR directory_mode IS NOT NULL
  ),
  ADD CONSTRAINT rooms_p2p_visibility_private CHECK (
    storage_mode = 'server' OR visibility = 'private'
  ),
  ADD CONSTRAINT rooms_p2p_join_model_invite CHECK (
    storage_mode = 'server' OR join_model = 'invite'
  ),
  ADD CONSTRAINT rooms_server_has_no_stub CHECK (
    storage_mode = 'p2p' OR p2p_stub_id IS NULL
  );
```

These CHECKs make it impossible to persist a row that violates §4.1 (e.g. a `p2p` room with `platform` authority, a non-private P2P room, a P2P room with an `open`/`request_approval` join model, or a server room carrying a P2P stub), mirroring the expand→backfill→contract migration discipline already used for the WS-Q content-and-room work.

Create `private_room_stubs` and `private_rendezvous_records` with strict field allowlists (the §8.1 forbiddance list is the column denylist for these tables; only §8.2 fields may appear).

### 23.3 Ingestion submission guard

In `apps/api/src/ingestion/submission.ts`, before auto-joining or visibility derivation:

```ts
if (room.storageMode === 'p2p') {
  return {
    ok: false,
    rejection: {
      status: 409,
      code: 'p2p_room_requires_client_sync',
      message: 'Private P2P rooms are created and synced locally.'
    }
  };
}
```

This prevents the existing path from creating `stories` and thread shells for P2P rooms.

### 23.4 Forum contribution guard

In server contribution routes/services, reject P2P thread/room IDs. In practice P2P thread IDs should never exist server-side, so this is mostly defense in depth.

### 23.5 Ranking retrievers

Every retriever must include:

```text
rooms.storage_mode = 'server'
```

Global, topic, and room surfaces must never retrieve P2P private content.

### 23.6 Search

Server search indexing and query results must include only server-hosted rooms:

```text
stories.room_id -> rooms.storage_mode = 'server'
```

### 23.7 Event pipeline

Add a validation gate:

```text
if event payload references p2p room -> reject + security metric
```

Because private-room events should never be emitted, this gate catches bugs.

### 23.8 Uploads

Server upload endpoints must not attach uploads to P2P room content. P2P media uses local encrypted attachments. If a user tries to use server upload UI inside a P2P room, the client should hide it and the server should reject it.

### 23.9 API routing

Add:

```text
apps/api/src/routes/private-rooms.ts
apps/api/src/routes/private-rendezvous.ts
```

Mount under `/v1/private-rooms` and `/v1/private-rendezvous`.

### 23.10 CI invariants

Add gates:

```text
check:no-p2p-server-content
check:no-private-cid-egress
check:private-rendezvous-schema
check:private-bundle-transparency
check:p2p-endpoint-rejections
check:p2p-ranking-exclusion
check:p2p-search-exclusion
```

---

## 24. Migration from existing server-private rooms

### 24.1 Core rule

Existing server-hosted private/restricted rooms cannot be silently upgraded into real private rooms. Their historical content has already existed on the server. Migration creates a new P2P room and optionally imports history through a member's client.

### 24.2 Migration phases

#### Phase 1 — Rename and disclose

- Rename current “private” rooms in the UI to “Members-only server rooms” or “Restricted server rooms.”
- Add explanation: visible only to members in the app, but hosted on Licio servers.

#### Phase 2 — Create P2P destination

- Room owner creates a new P2P private room.
- Client generates keys and manifest locally.
- Server stores only a stub if unlisted/listed.

#### Phase 3 — Choose import mode

| Import mode | Description | Disclosure |
|---|---|---|
| Fresh start | No old content imported | Best privacy going forward |
| Selected import | User selects threads/posts to re-encrypt locally | Imported items were previously server-hosted |
| Full import | Client fetches all old room content and re-encrypts into P2P | Highest convenience, not retroactive privacy |
| Redacted import | Titles/summaries only | Lower leakage of old content |

#### Phase 4 — Re-invite members

Server subscriptions do not grant P2P access. Members must join through P2P invites.

#### Phase 5 — Freeze old room

Old server room becomes read-only with a banner pointing to the P2P replacement.

#### Phase 6 — Purge/minimize server history

Where policy and law permit, purge or minimize old server data:

- stories;
- threads;
- contributions;
- media uploads;
- search documents;
- ranking candidates;
- content events;
- review queues;
- derived summaries;
- caches.

Any retained legal/audit records must be disclosed as server-retained historical artifacts, not private P2P content.

### 24.3 Migration warning copy

```text
This migration improves privacy from this point forward. Imported history was previously stored on Licio servers, so migration cannot make past server access impossible. You may start fresh instead.
```

---

## 25. Efficiency and performance plan

### 25.1 Efficiency goals

- Open a private room shell in under 1 second from local cache.
- Show recent thread list before all media is synced.
- Sync text ops before media chunks.
- Avoid repeated full DAG replay through snapshots.
- Avoid public routing overhead.
- Keep small-operation overhead bounded despite padding.
- Support low-bandwidth and intermittent mobile devices.

### 25.2 Lazy sync

Fetch sequence:

```text
manifest -> membership/capabilities -> heads -> recent text ops -> current thread viewport -> summaries -> media manifests -> media chunks
```

### 25.3 Batching

Batch:

- head announcements;
- block requests;
- small ops into encrypted CAR segments;
- membership verification updates;
- local search index rebuilds.

Do not batch unrelated rooms together in a way that links them.

### 25.4 Padding policy

Suggested default:

| Object class | Padding |
|---|---|
| membership ops | 4 KiB or 16 KiB |
| small contribution ops | 4 KiB |
| story/thread metadata | 4 KiB |
| search shards | 16 KiB+ |
| media manifests | 4 KiB |
| media chunks | no full padding by default; size class disclosed |

High-privacy room mode can pad more aggressively at higher bandwidth cost.

### 25.5 Set reconciliation

v1 can use simple head exchange and ancestor fetch. v2 SHOULD add efficient set reconciliation:

- sorted op ID ranges;
- compact Bloom/Golomb filters;
- Merkle segment trees;
- per-thread sub-DAG summaries.

Avoid exposing op IDs to non-members.

### 25.6 Snapshot cadence

Suggested:

- create snapshot every 1,000 accepted ops or 7 days, whichever comes first;
- create immediate snapshot after large import;
- create snapshot after membership churn;
- allow manual “optimize room storage” action.

### 25.7 Local search indexing

Build search indexes incrementally in a worker. Index only decrypted local content. Encrypt index shards at rest. Rebuild on schema upgrade or snapshot verification failure.

### 25.8 Media optimization

- Generate local encrypted thumbnails/posters.
- Stream video chunks lazily.
- Support pause/resume.
- Deduplicate identical encrypted chunks only within the same object where it does not leak cross-object equality.
- Do not use convergent encryption for cross-user media deduplication.

### 25.9 Battery/network controls

User settings:

- sync on Wi-Fi only;
- do not auto-fetch media;
- low-power mode disables background sync attempts;
- relay-only mode;
- manual sync only;
- export/import via file.

---

## 26. Security, privacy, and correctness test plan

### 26.1 Unit tests

- strict zod schema tests for every private type;
- canonical encoding stability tests;
- KDF domain separation tests;
- nonce uniqueness tests;
- envelope encrypt/decrypt tests;
- signature verification tests;
- capability validation matrix;
- reducer determinism tests;
- conflict-resolution tests;
- snapshot verification tests.

### 26.2 Cryptographic tests

- Use official vectors for HPKE.
- Use MLS library test vectors where available.
- Differential-test canonical encodings.
- Fuzz malformed envelopes and ops.
- Property-test that unauthorized ops never render.
- Property-test that removed members cannot decrypt future epoch test objects.

### 26.3 Network/privacy tests

Automated Playwright/browser tests with request capture:

- create room;
- invite member;
- post story;
- comment;
- attach media;
- sync;
- remove member;
- create future content.

Assert no outbound HTTP/WebSocket request contains:

- private title/body;
- private URL;
- private CID;
- op ID;
- thread ID;
- contribution ID;
- member list;
- invite fragment;
- plaintext key;
- exact room ID for unlisted/detached rooms.

### 26.4 Server database tests

After P2P activity, assert:

```sql
SELECT count(*) FROM stories WHERE room_id = :p2p_room_id = 0;
SELECT count(*) FROM threads WHERE room_id = :p2p_room_id = 0;
SELECT count(*) FROM event_store WHERE payload::text LIKE '%p2p_room%' = 0;
SELECT count(*) FROM search_index WHERE room_id = :p2p_room_id = 0;
SELECT count(*) FROM ranking_candidates WHERE room_id = :p2p_room_id = 0;
```

Exact table names should match implementation.

### 26.5 P2P sync tests

- two peers online;
- offline edits on both peers;
- conflict merge;
- missing parent fetch;
- media partial fetch;
- snapshot restore;
- CAR export/import;
- relay-only mode;
- rendezvous unavailable;
- malicious peer sends invalid op;
- malicious peer sends wrong block for CID;
- malicious peer replays old epoch op;
- removed peer attempts sync.

### 26.6 Update-channel tests

- unsigned private-mode bundle locks room;
- transparency-log mismatch locks room;
- service worker cannot silently load dynamic remote private code;
- CSP blocks inline/eval paths;
- private keys are not unlocked before bundle verification;
- local key agent refuses unverified origin/bundle.

### 26.7 Manual security review gates

Before launch:

- external cryptography review;
- browser storage/key management review;
- rendezvous metadata review;
- red-team malicious server update scenario;
- malicious member scenario;
- incident drill for leaked invite;
- incident drill for compromised member device;
- usability study for recovery warnings.

---

## 27. Operational controls and incident response

### 27.1 Operational logging

Allowed logs:

```text
private_room_stub_created
private_rendezvous_rate_limited
private_rendezvous_payload_too_large
private_bundle_verification_failed
```

Forbidden logs:

```text
private CID
private op ID
private room name for unlisted/detached rooms
invite fragment
member list
thread title
message body
media filename
exact per-room activity
```

### 27.2 Abuse controls for rendezvous

Because the server cannot inspect payloads, use:

- payload size limits;
- TTL limits;
- blind-ID rate limits;
- proof-of-work or account-scoped blind tokens if needed;
- aggregate anomaly detection without room identity;
- automatic expiry and deletion.

### 27.3 Incident: leaked invite

User actions:

- revoke invite capability;
- rotate room epoch if invite may have been used;
- review pending/accepted members;
- show membership changes since invite creation.

Server action:

- cannot remove private members;
- may rate-limit invite spam on Licio public surfaces;
- may delist public stub if directory abuse.

### 27.4 Incident: compromised device

Room admin actions:

- remove device;
- rotate epoch;
- create new recovery kit;
- mark old device compromised;
- optionally tombstone suspicious ops after review.

Disclosure:

```text
Future room content is protected after rotation. Content already present on the compromised device may have been exposed.
```

### 27.5 Incident: malicious client update

Controls:

- transparency log detects or prevents untrusted bundle;
- private rooms lock before key unlock;
- publish signed incident notice;
- rotate room keys after verified safe client is installed;
- encourage local key agent for high-risk rooms.

---

## 28. Workstreams and rollout plan

### WS-P2P-0 — Specification and terminology

- Rename current private server rooms in UI/docs.
- Add room class model to SPEC.
- Add user-facing privacy promise matrix.

### WS-P2P-1 — Server schema and hard non-storage gates

- Add room storage/authority/directory axes.
- Add private room stubs.
- Add rendezvous tables with TTL.
- Add endpoint rejection guards.
- Add DB/CI no-storage tests.

### WS-P2P-2 — Private schemas and canonical encoding

- Create `packages/private-p2p`.
- Add zod schemas.
- Add canonical CBOR/IPLD encoding.
- Add envelope profile and tests.

### WS-P2P-3 — Crypto foundation

- Integrate reviewed MLS and HPKE libraries.
- Implement key derivation and envelope encryption.
- Implement local key store.
- Implement recovery kit.
- Add crypto vectors and fuzzing.

### WS-P2P-4 — Helia/libp2p private profile

- Add separate private Helia node/profile.
- Disable public DHT/gateways/delegated routing/IPNI/reprovide.
- Add private block protocol.
- Add IDB blockstore.

### WS-P2P-5 — Operation log and reducer

- Implement membership/capability ops.
- Implement story/thread/contribution ops.
- Implement deterministic reducer.
- Implement snapshots.
- Implement local-only search.

### WS-P2P-6 — Sync and rendezvous

- Implement blind rendezvous.
- Implement encrypted signaling.
- Implement peer handshake.
- Implement head exchange and block fetch.
- Implement relay-only mode.

### WS-P2P-7 — Private room UI

- Creation wizard.
- Room shell.
- Composer.
- Thread view.
- Invite/member panels.
- Replication/backup/trust indicators.

### WS-P2P-8 — Media

- Local metadata stripping.
- Attachment manifests.
- Media chunking/streaming.
- Alt text/captions.
- Local media safety controls.

### WS-P2P-9 — Migration

- Restricted server room disclosure.
- Migration wizard.
- Selected import and full import.
- Archive old room.
- Purge/minimization tooling.

### WS-P2P-10 — Hardened trust

- Reproducible private-mode bundle.
- Signed release manifest.
- Code transparency log.
- Service worker update pinning.
- Optional local key agent.

### WS-P2P-11 — Audit and launch

- External crypto review.
- Privacy red-team.
- Malicious update drill.
- UX recovery study.
- Documentation and support runbooks.

---

## 29. Launch checklist

P2P private rooms are launch-ready only if every item is true. A checked box
means the property is enforced in the tree AND covered by a test or CI gate —
not that someone believes it holds. The unchecked items are the honest residue;
`docs/private-p2p/README.md` carries the per-card mapping.

### Product and UX

- [x] Current server-private rooms are no longer labeled simply “private.” (The §20.1 "Members-only server room" labels are BLOCKING copy in `packages/shared/src/constants/private-rooms.ts`, pinned by the prohibited-language copy-lint.)
- [x] P2P private creation includes mandatory disclosures. (`CreatePrivateRoomWizard` — the five §20.2 acknowledgments, each blocking.)
- [x] Removal disclosure explains no retroactive deletion. (§10.9 copy in the same SSOT; `DELETE /v1/private-rooms/:id` says it removes Licio's directory record, not the room.)
- [x] Recovery UX is clear and tested. (`crypto/recovery.ts` portable kit + `reducer/recovery-threshold.ts`; the §12.7 terminality copy states that losing every member key is unrecoverable.)
- [x] Replication health is visible. (`PrivateRoomView` surfaces peer/sync state from `sync-session.ts`.)
- [x] Invite risks are clear. (`InvitePanel`/`JoinPanel` carry the §12 disclosures.)

### Server non-storage

- [x] P2P rooms cannot create server stories. (Submission guard → `409 p2p_room_requires_client_sync`, plus the migration-`0045` `stories_no_p2p_room` trigger.)
- [x] P2P rooms cannot create server contributions. (Contribution guard → `404`, plus the `threads_no_p2p_room` trigger.)
- [x] P2P rooms never enter ranking/search. (`check:p2p-ranking-exclusion`, `check:p2p-search-exclusion`; `roomVisibleToUser` also keeps the shell out of `GET /v1/rooms`.)
- [x] P2P content events cannot be emitted. (The event router refuses any content event referencing a p2p room and counts the refusal.)
- [x] Server logs exclude private CIDs/op IDs/invite fragments. (`check:no-private-cid-egress`.)
- [x] DB tests prove no private content rows after E2E tests. (`private-no-server-content.audit.test.ts` + the `checkPrivateServerTables()` column allowlist.)

### Crypto

- [x] MLS add/remove works across devices. (`crypto/mls.ts` over `ts-mls`, RFC 9420; the cross-epoch sync suite.)
- [x] HPKE invites use reviewed libraries and vectors. (RFC 9180 suite A.1 over WebCrypto, pinned to an `@hpke/core` interop ciphertext + RFC 7748 §6.1 DH.)
- [x] Epoch rotation works. (`crypto/epoch.ts` — atomic rotation per commit, manifest-fork divergence.)
- [x] Removed devices fail to decrypt future content. (The forward-secrecy property suite.)
- [x] Nonce uniqueness tests pass. (The §3.7 nonce-uniqueness + fail-closed fuzz suite.)
- [ ] External crypto review complete. — **OPEN.** `ts-mls` also carries its own not-yet-audited disclaimer; it is isolated behind the one-file wrapper (`check:p2p-mls-wrapper`) for a future swap.

### P2P/IPFS

- [x] Private CIDs never go to public gateways. (`check:no-private-cid-egress`; the CID profile is the dependency-free `crypto/cid.ts` over ciphertext.)
- [x] Block exchange validates CID/signature/AEAD. (§14.2 stage-1 runs on every envelope, including on archive import — no container-conferred trust.)
- [x] Relay-only mode works. (§15.4 ICE suppression; note that relay-only needs a TURN entry in `VITE_ICE_SERVERS`.)
- [x] Offline CAR import/export works. (`sync/archive.ts`, the §15.9 encrypted-archive exchange.)
- [ ] Private Helia profile disables public DHT/gateways/delegated routing/IPNI/reprovide. — **NOT APPLICABLE as written.** The maintainer chose the lighter-transport path: there is no Helia node in the private plane, so there is no public-routing surface to disable. The property it protected (no private data reaches public routing) is carried by the gate above.

### Trust/update channel

- [x] Bundle hash is signed and in transparency log. (`gen:update-manifest` — Ed25519 signature + RFC 9162 inclusion proof.)
- [x] Service worker pins verified private bundle. (`apps/web/src/update/` + the SW pin.)
- [x] Private rooms lock on unverified bundle. (`ensurePrivateBundleTrusted()` in `PrivateRoomSession.{create,load}`; typed lock reasons, room keys stay sealed.)
- [x] CSP/Trusted Types/no dynamic code checks pass. (`check:csp-parity`, `check:sw`, `lint:security`, `check:private-bundle-transparency`.)
- [x] Local key agent prototype or documented Tier 1 limitation exists. (The §10.8 `local-key-agent` tier is modelled in `crypto/key-store.ts`; the Tier-1 limitation is stated in §3.2 and in the creation copy.)
- [ ] Private-mode bundle is reproducible. — **OPEN.** The bundle is signed and transparency-logged, but independent byte-for-byte reproduction (§30 Q9) is not yet demonstrated.

### Safety

- [x] Local moderation ops work. (`reducer/overlay.ts` — the §14.6 device-local moderation overlays.)
- [x] Member block/hide works. (Same overlay plane.)
- [x] Voluntary report package preview works. (The §19.4 report schema; the package is member-assembled and member-sent.)
- [x] Directory abuse tools work for listed stubs. (`POST /v1/private-rooms/:id/delist` — the ONLY thing platform staff can do to a P2P room, per §11.4, and it requires the same per-session MFA every other steward action does. `DELETE /v1/private-rooms/:id` is creator-owned: staff can stop a room advertising itself, and cannot remove its bootstrap record, because members holding the token must keep resolving it. Every staff delist writes an actor/target entry to the moderation audit trail.)
- [x] Support docs do not promise impossible recovery/moderation. (The copy-lint rejects "secure"/"deleted everywhere" framing in the §6/§20 SSOT.)

---

## 30. Open questions

Four of the original ten were settled by implementation; they are kept with
their answers rather than deleted, because the answer is the part a reader
needs and a silently-dropped question reads as a question nobody asked.

**Settled**

1. ~~Which audited MLS implementation?~~ → **`ts-mls`**, RFC 9420, suite
   `MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519` pinned at module load. It
   exports secrets cleanly (the §10.4 epoch bridge derives `room_epoch_secret`
   through the MLS Exporter) and passes its RFC vectors. It is **not yet
   formally audited** — its own disclaimer — so it is confined to the single
   wrapper `crypto/mls.ts`, with `check:p2p-mls-wrapper` forbidding a deep
   import anywhere else so a swap stays a one-file change. The external review
   remains open (§29).
2. ~~Which HPKE suite and library?~~ → **RFC 9180 suite A.1**, DHKEM(X25519,
   HKDF-SHA256) / HKDF-SHA256 / AES-128-GCM, hand-rolled over WebCrypto
   primitives (no HPKE dependency) and pinned to an `@hpke/core` interop
   ciphertext plus the RFC 7748 §6.1 DH vector.
5. ~~Browser support matrix / where is the curve fallback required?~~ → The
   plane targets **WebRTC data channels** (no WebTransport/libp2p dependency),
   and `@noble/curves` is the pinned audited fallback wherever WebCrypto
   `Ed25519`/`X25519` is absent — `crypto/signatures.ts` is cross-validated
   byte-for-byte against it.
8. ~~Threshold membership changes / is Shamir in scope?~~ → **Threshold
   recovery shipped; Shamir did not, and deliberately.**
   `reducer/recovery-threshold.ts` counts *M distinct recover-capable admins*
   — a CAPABILITY threshold, so the operation carries no key material at all —
   and a successful recovery is an ordinary `member.add` (MLS Add + epoch
   rotation). Secret-sharing was the wrong tool for the requirement and is not
   deferred so much as declined.

**Open**

3. Is the Tier 3 local key agent in scope for v1 launch, or will v1 launch with
   Tier 1/Tier 2 disclosures only? (The `local-key-agent` tier is modelled in
   the §10.8 key store; no agent binary ships.)
4. Should detached rooms be available in the first release or hidden behind an
   advanced flag?
6. What local metadata-stripping library is acceptable for images and videos
   without server scanning?
7. What is the default padding policy for mobile users with limited bandwidth?
9. How will private-mode reproducible builds be independently verified and
   displayed to users? (The bundle is signed and transparency-logged today;
   independent byte-for-byte reproduction is not yet demonstrated — §29.)
10. How much old server-private history should migration import by default?

---

## 31. References

These references informed the design and should be linked from the implementation PR/spec update:

1. IPFS Privacy and Encryption Best Practices: https://docs.ipfs.tech/how-to/privacy-best-practices/
2. IPFS Content Identifiers / CIDv1 guidance: https://docs.ipfs.tech/concepts/content-addressing/
3. Helia TypeScript IPFS implementation: https://github.com/ipfs/helia
4. libp2p transport documentation: https://docs.libp2p.io/concepts/transports/overview/
5. RFC 9420, Messaging Layer Security: https://www.rfc-editor.org/rfc/rfc9420
6. RFC 9180, Hybrid Public Key Encryption: https://www.rfc-editor.org/rfc/rfc9180
7. MDN WebRTC signaling overview: https://developer.mozilla.org/en-US/docs/Web/API/WebRTC_API/Signaling_and_video_calling
8. MDN Service Worker API: https://developer.mozilla.org/en-US/docs/Web/API/Service_Worker_API
9. MDN Web Crypto API: https://developer.mozilla.org/en-US/docs/Web/API/Web_Crypto_API
10. RFC 8291, Message Encryption for Web Push: https://www.rfc-editor.org/rfc/rfc8291
11. BCP 14 (RFC 2119 + RFC 8174), normative keyword interpretation: https://www.rfc-editor.org/info/bcp14
12. RFC 5869, HKDF (HMAC-based key derivation): https://www.rfc-editor.org/rfc/rfc5869
13. RFC 8439, ChaCha20 and Poly1305 AEAD: https://www.rfc-editor.org/rfc/rfc8439
14. RFC 9106, Argon2 memory-hard password hashing: https://www.rfc-editor.org/rfc/rfc9106
15. RFC 8949, CBOR and §4.2.1 core deterministic encoding (DAG-CBOR canonical form): https://www.rfc-editor.org/rfc/rfc8949
16. IPLD CAR (Content-Addressable aRchives) format: https://ipld.io/specs/transport/car/

---

## Appendix A — Minimal P2P room creation sequence

```text
1. User clicks “Create Private P2P Room”.
2. Client shows disclosure and requires acknowledgement.
3. Client verifies private-mode app bundle signature/hash.
4. Client generates device signing key and HPKE key.
5. Client creates MLS group.
6. Client derives epoch 0 app secrets.
7. Client creates encrypted room manifest and membership op.
8. Client stores encrypted blocks in local blockstore.
9. Client optionally creates server stub with no content/CIDs/heads.
10. Client starts blind rendezvous if enabled.
11. UI renders from local reducer state.
```

## Appendix B — Minimal invite sequence

```text
1. Admin creates invite op.
2. Client creates sealed invite URL with fragment secret.
3. Recipient opens invite.
4. Recipient client generates device keys and KeyPackage.
5. Recipient sends encrypted blinded join request.
6. Admin device validates and commits MLS Add.
7. Admin sends MLS Welcome and encrypted bootstrap heads.
8. Recipient syncs encrypted blocks from peers.
9. Recipient verifies room safety number.
```

## Appendix C — Minimal removal sequence

```text
1. Admin selects member/device removal.
2. UI warns removal is not retroactive deletion.
3. Admin signs remove op.
4. MLS Remove commit creates new epoch.
5. Sync/rendezvous topics rotate.
6. Future content uses new epoch keys.
7. Removed device can no longer authenticate or decrypt future ops.
```

## Appendix D — Server no-content assertion pseudocode

```ts
async function assertNoP2PServerContent(roomId: string) {
  expect(await db.stories.count({ roomId })).toBe(0);
  expect(await db.threads.count({ roomId })).toBe(0);
  expect(await db.search.count({ roomId })).toBe(0);
  expect(await db.rankingCandidates.count({ roomId })).toBe(0);
  expect(await db.events.countPayloadContaining(roomId)).toBe(0);
  expect(await db.uploads.countOwnedByRoom(roomId)).toBe(0);
}
```

## Appendix E — Required user-facing privacy matrix

| Question | Public room | Members-only server room | Private P2P room |
|---|---|---|---|
| Can Licio host content? | Yes | Yes | No |
| Can Licio admins technically access content? | Yes | Yes | No |
| Can content be globally ranked? | Yes | No, except server-local surfaces | No |
| Can Licio recover lost access? | Account-dependent | Account-dependent | No |
| Can members leak content? | Yes | Yes | Yes |
| Can removed members read old downloaded content? | Yes | Yes | Yes |
| Does availability depend on member devices? | No | No | Yes |
| Are public IPFS gateways used? | Maybe for public content if ever added | No need | Forbidden |

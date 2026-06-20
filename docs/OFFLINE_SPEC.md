# LCAP v0.2 — Licio Content Availability Protocol

**Document status:** Reviewed and refined draft implementation specification (protocol v0.2)  
**Prepared date:** June 13, 2026  
**Last refined:** June 15, 2026  
**Target project:** [`hatter6822/Licio`](https://github.com/hatter6822/Licio)  
**Primary platform:** Licio Progressive Web App, with first-class native-courier (Capacitor), browser-P2P (WebTransport/WebRTC), IPFS-public-bridge, and relay components (consent-gated, off by default; elevated 2026-06)  
**Primary objective:** maximize useful verified data availability, liveness, and throughput under intermittent connectivity, hostile networks, cheap older smartphones, limited battery, limited storage, and incomplete trust

---

## 0. Executive decision

LCAP should remain a **delay-tolerant, content-addressed, signed synchronization protocol**, but v0.2 tightens the architecture in four important ways:

1. **Separate record identity from signature bytes.** v0.1 treated a signed object as the main CID. That is simple, but it is not ideal for browser-first ECDSA because ECDSA signatures can be nondeterministic and malleable unless carefully normalized. v0.2 defines a stable `record_cid` over deterministic record bytes, and stores signatures as detached proof objects. This improves deduplication, fork detection, and multi-proof/witness handling.
2. **Use standard COSE-style detached signatures.** LCAP should not invent a signature envelope. The required browser-compatible suite remains P-256 ECDSA with SHA-256, but the structure should follow COSE concepts: protected headers, explicit algorithm identifiers, detached payload signing, domain separation, and low-S normalization for ECDSA proofs.
3. **Split the protocol into control, text, evidence, and bulk lanes.** Throughput is not just “compress more.” The protocol must guarantee that tiny trust/liveness objects always move before media. v0.2 defines lane scheduling, byte reservations, pack ordering, and explicit starvation prevention.
4. **Make liveness measurable.** A record is not merely “synced” or “not synced.” v0.2 defines liveness states: local, packed, exported, peer-stored, relay-stored, server-stored, accepted, checkpointed, and witnessed. Each state has different trust and availability meaning.

The recommended v0.2 architecture is:

```text
┌─────────────────────────────────────────────────────────────────────┐
│ Licio application semantics                                         │
│ rooms · typed contributions · moderation · evidence · visibility    │
├─────────────────────────────────────────────────────────────────────┤
│ LCAP trust plane                                                    │
│ detached proofs · device certs · room capabilities · revocations    │
│ transparency checkpoints · witness statements · trust projection    │
├─────────────────────────────────────────────────────────────────────┤
│ LCAP record plane                                                   │
│ deterministic record bodies · record_cids · block_cids · DAG deps   │
├─────────────────────────────────────────────────────────────────────┤
│ LCAP sync plane                                                     │
│ pulse + exchange · anti-entropy · resumable ranges · packfiles      │
│ lane scheduler · custody/storage receipts · liveness state machine  │
├─────────────────────────────────────────────────────────────────────┤
│ Convergence transports                                              │
│ HTTPS · manual bundles · QR · local relay · WebTransport (HTTP/3)   │
│ WebRTC P2P · IPFS public bridge · native courier (Capacitor)        │
└─────────────────────────────────────────────────────────────────────┘
```

LCAP v0.2 MUST remain useful when the only available transport is a PWA performing brief HTTPS requests. Manual `.licio-bundle` transfer MUST remain a first-class transport, not a fallback. The WebTransport, WebRTC, public-IPFS, and native-Android-courier (Nearby Connections / Wi-Fi Direct / Bluetooth) transports are **first-class, in-scope deliverables** (maintainer decision, 2026-06) — but elevating them to *required to build* does not make any of them *required to run*: the **core protocol's correctness MUST NOT depend on any single transport**, and HTTPS + manual bundle MUST stay sufficient on their own. Erasure-coded broadcast and other future transports MAY be added later under the same rule.

---

## 1. Design objective

LCAP’s actual optimization target is not raw bandwidth. It is:

```text
useful_verified_availability_per_cost
```

where:

```text
useful_verified_availability =
    user_relevance
  × priority
  × trust_completeness
  × dependency_completeness
  × freshness
  × scarcity
  × expected_acceptance_probability
  × safety_value

cost =
    bytes
  + round_trips
  + battery
  + memory
  + storage pressure
  + CPU
  + privacy leakage
  + user attention
  + risk of rendering stale or unsafe information
```

This means the protocol MUST prefer:

```text
revocation over image
capability over payload
checkpoint over thumbnail
small signed text over bulk media
missing dependency over dependent record
user-pinned content over ambient cache
fresh public safety notice over old low-priority thread
```

The design goal is **maximum useful convergence under interruption**, not maximum theoretical mesh complexity.

---

## 2. Normative language

The capitalized words **MUST**, **MUST NOT**, **REQUIRED**, **SHALL**, **SHALL NOT**, **SHOULD**, **SHOULD NOT**, **RECOMMENDED**, **MAY**, and **OPTIONAL** are to be interpreted as described in BCP 14 (RFC 2119, RFC 8174) — and only when, per RFC 8174, they appear in all uppercase.

Lowercase uses are descriptive. TypeScript type sketches are illustrative; the **zod schemas in `packages/lcap/src/schemas/` and the conformance vectors in `packages/lcap/src/test-vectors/` are normative** where a sketch and an implementation could diverge.

---

## 3. Non-negotiable constraints

LCAP v0.2 MUST respect the following constraints.

### 3.1 PWA-first

The baseline implementation MUST work inside Licio’s PWA using HTTPS, service workers, IndexedDB, browser crypto, ordinary file import/export, and explicit user interaction. Native device-to-device radio APIs MUST be optional.

### 3.2 Old-phone viability

The protocol MUST avoid mandatory heavy computation, unbounded memory allocation, unlimited background work, and large JavaScript dependency additions. Large optional features MUST be gated behind capability negotiation and storage/battery policy.

### 3.3 Every transport is untrusted

Objects may arrive by HTTPS, file, QR, relay, courier, laptop, USB stick, messaging app, or hostile local network. The path of arrival MUST NOT confer trust.

### 3.4 Every connection is short-lived

A sync session may die after only a few kilobytes. The first bytes sent MUST therefore be the most valuable bytes.

### 3.5 Offline trust is provisional

A phone cannot know the latest canonical room state, policy epoch, revocation epoch, or moderation decision until it receives fresh checkpoints and revocation data. The UI and API MUST expose this uncertainty.

### 3.6 User safety beats automatic discovery

The protocol MUST NOT silently advertise private room membership, political interests, contacts, device identity, or local presence. Nearby discovery MUST be explicit, scoped, and disableable.

### 3.7 Licio doctrine remains intact

LCAP MUST NOT replicate raw attention traces, likes, votes, reactions, follower counts, payment-for-rank signals, client IP/location data, or any field forbidden by Licio’s existing privacy and no-applause doctrine.

---

## 4. Core definitions

**Record**  
A deterministic LCAP data body: event, capability, device certificate, revocation, checkpoint, manifest, receipt, witness statement, availability advertisement, or policy object.

**Record CID (`record_cid`)**  
The SHA-256 content identifier of the deterministic encoded record body. This excludes detached signatures and transfer framing.

**Proof**  
A detached signature or authority statement over a record body. A record is not trusted until at least one valid proof chain authorizes it.

**Proof CID (`proof_cid`)**  
The SHA-256 content identifier of the deterministic proof object.

**Block**  
A content-addressed byte payload such as text body, source snapshot, thumbnail, encrypted payload, or chunk of media.

**Block CID (`block_cid`)**  
The SHA-256 content identifier of the block’s canonical uncompressed bytes unless the block explicitly declares a compressed representation as its canonical form.

**Pack**  
A transfer container containing a header, object table, record bodies, proofs, and blocks. A pack may be saved as a `.licio-bundle` file or sent over HTTPS/courier/relay.

**Lane**  
A scheduling class: control, text, evidence, media, bulk. Lanes determine transfer ordering and byte reservations.

**Checkpoint**  
A signed room-log commitment containing a Merkle root, tree size, policy epoch, revocation epoch, and previous checkpoint reference.

**Witness statement**  
A signed statement by an independent witness that it observed a room checkpoint or fork evidence.

**Capability**  
A bounded signed authorization: subject device, scope, operations, room, validity interval, quotas, and policy epoch.

**Liveness state**  
A local state describing how far a record has propagated: local, packed, exported, peer-stored, relay-stored, server-stored, accepted, checkpointed, witnessed.

### 4.1 Common type aliases

These aliases are referenced throughout the schemas below. They are gathered here so every later type is self-contained.

```ts
// Scheduling.
type LcapLane = "C0" | "T1" | "E2" | "M3" | "B4";        // §15.1
type LcapPriority = 0 | 1 | 2 | 3 | 4;                    // §15.1.1, lower = sooner

// Every deterministic record body's `kind`.
type LcapRecordKind =
  | "contribution_event" | "device_certificate" | "room_capability"
  | "revocation" | "bundle_manifest" | "room_checkpoint"
  | "inclusion_proof" | "consistency_proof" | "witness_statement"
  | "receipt" | "fork_evidence" | "availability_advertisement"
  | "policy_object";

// Operations a room capability may authorize (gates contribution `event_type`s and roles).
type LcapOperation =
  | "post" | "reply" | "edit" | "tombstone" | "moderate"
  | "source_snapshot" | "summary" | "invite";

// Crypto / compression negotiation identifiers.
type CryptoSuiteId = "ES256" | "Ed25519";                // Ed25519 reserved, §10.3/§10.4
type CompressionId = "none" | "gzip" | "deflate" | "zstd";

// A serialized pack (§14) as transferred over any transport.
type PackBytes = Uint8Array;

// Proof helper types (§10.2).
type CoseUnprotectedHeader = Record<string, unknown>;    // never signature-covered
type ProofScope = { room_id_hash?: Uint8Array; not_after_ms?: number };

// Block helper types (§13).
type ChunkingDescriptorV2 = {
  chunk_size: number; chunk_count: number; chunk_cids: string[];
};
type CompressionDescriptorV2 = {
  algorithm: CompressionId; compressed_size: number; uncompressed_size: number;
  uncompressed_sha256: Uint8Array; max_expansion_ratio: number;
};

// Sync-pulse helper types (§16.2).
type CapabilityFrontierV2 = {
  room_id_hash: Uint8Array; capability_id: string; not_after_ms: number;
};
type LaneSummaryV2 = {
  lane: LcapLane; pending_count: number; pending_bytes: number;
};
type ExchangeWarningV2 = {
  code:
    | "stale_checkpoint" | "stale_revocation" | "quota_near_limit"
    | "private_metadata_stripped" | "budget_truncated";
  detail?: string;
};
```

---

## 5. What changed from v0.1

v0.2 makes the following changes.

### 5.1 Stable record IDs

v0.1 indexed signed events by the CID of the signed object. v0.2 indexes records by deterministic body CID and stores signatures separately.

Reason:

```text
same semantic record + different ECDSA signature bytes = duplicate signed-object CIDs
same record body + multiple witnesses = useful multi-proof without changing record ID
same event body + invalid signature = same body CID but not accepted
```

The stable `record_cid` lets clients deduplicate, detect forks, exchange receipts, and request dependencies without being confused by signature encoding differences.

### 5.2 Detached proof graph

A valid contribution is now:

```text
record body
  + device signature proof
  + device certificate proof
  + room capability proof
  + non-revocation knowledge
  + optional room checkpoint proof
  + optional witness statement
```

This creates an explicit trust DAG.

### 5.3 Sync pulse before bulk transfer

Every exchange begins with a tiny **sync pulse** embedded at the front of the request/response. The pulse carries only:

```text
protocol version
node capabilities
budgets
revocation frontier
checkpoint frontier
wanted critical CIDs
offered critical CIDs
```

If the session dies after the pulse, useful trust/liveness data may still have moved.

### 5.4 Lane scheduler

v0.2 requires a deterministic scheduling policy. A sender MUST NOT allow media or source snapshots to starve revocations, checkpoints, capabilities, or small text events.

### 5.5 Explicit liveness accounting

Each local record tracks:

```text
created_at_local
first_packed_at
first_exported_at
first_peer_receipt_at
first_relay_receipt_at
first_server_stored_at
first_server_accepted_at
first_checkpointed_at
first_witnessed_at
```

These timestamps are local observations, not global truth, but they make delivery health measurable.

---

## 6. System model

LCAP assumes:

- intermittent cellular data;
- brief Wi-Fi access;
- networks with captive portals, filtering, throttling, or total outages;
- local Wi-Fi without internet;
- device-to-device transfer through files, the native courier (Capacitor), or browser P2P (WebRTC);
- untrusted local relays;
- old Android phones and low-end browsers;
- unreliable browser background execution;
- wrong device clocks;
- limited storage;
- users at personal risk if interests or contacts are revealed;
- adversaries who can drop, delay, reorder, replay, modify, inject, or flood traffic.

LCAP does not guarantee delivery during total isolation. It guarantees that useful objects can be created, verified, carried, resumed, imported, gossiped, and eventually reconciled through any available path.

---

## 7. Threat model

### 7.1 Adversaries

**Passive observer**  
Observes traffic timing, volume, radio discovery, visible filenames, DNS/SNI where applicable, local network access patterns, and bundle movement.

**Active network attacker**  
Drops, delays, reorders, duplicates, truncates, modifies, injects, or replays packets and files.

**Malicious relay**  
Stores selectively, censors, withholds, replays, lies about availability, floods clients, or correlates clients.

**Malicious peer/courier**  
Offers forged records, malformed packs, stale checkpoints, old revocation state, or adversarially large dependencies.

**Compromised device key**  
Signs valid-looking records until revocation or capability expiry is known.

**Equivocating server or room authority**  
Issues different room checkpoints to different clients.

**Resource exhaustion attacker**  
Uses huge bundles, dependency bombs, nested manifests, many invalid signatures, or compression bombs to exhaust storage, memory, CPU, or battery.

**UI deception attacker**  
Tries to make provisional, stale, or untrusted content look accepted and current.

### 7.2 Security goals

LCAP MUST provide:

- content integrity by hash;
- authorship integrity by signature;
- authorization by scoped capability;
- revocation propagation;
- fork/equivocation detection where evidence is available;
- dependency completeness before trusted rendering;
- idempotent ingestion;
- safe handling of malformed input;
- explicit trust states;
- privacy-preserving sync hints;
- denial-of-service limits.

### 7.3 Non-goals

LCAP does not provide:

- perfect anonymity;
- perfect metadata hiding;
- instant offline revocation;
- guaranteed deletion from other phones;
- protection against a fully compromised browser/runtime;
- protection against physical coercion;
- globally final ordering while offline;
- trust in any relay merely because it stores data.

---

## 8. Architecture overview

LCAP has four planes.

### 8.1 Record plane

The record plane defines deterministic data bodies and CIDs.

```text
record_body --deterministic CBOR--> bytes --SHA-256--> record_cid
block_bytes -----------------------> bytes --SHA-256--> block_cid
```

Record bodies are immutable. Edits, deletions, moderation actions, policy changes, and revocations create new records referencing earlier records.

### 8.2 Trust plane

The trust plane determines whether a record is renderable and how it should be labeled.

```text
account authority
  ↓
device certificate
  ↓
room capability
  ↓
record signature proof
  ↓
local revocation knowledge
  ↓
room checkpoint and optional witness statements
```

Trust is a projection over records and proofs. The same record may move between states as new proofs, revocations, checkpoints, or consistency proofs arrive.

### 8.3 Sync plane

The sync plane compares frontiers, schedules lanes, transfers packs, verifies records, stores receipts, and updates liveness states.

### 8.4 Transport plane

The transport plane moves packs over:

```text
HTTPS fetch
manual .licio-bundle files
QR micro-bundles
local relay endpoints
WebTransport (HTTP/3) server transport
WebRTC browser↔browser data-channel P2P
browser IPFS/libp2p public-block bridge (public blocks only)
native Android courier (Capacitor: Nearby Connections / Wi-Fi Direct / Bluetooth / hotspot / USB)
```

All transports move the *same* packs through the *same* `validate(record_cid)` (no parallel data model or trust path), and correctness never depends on any single transport. **HTTPS fetch and manual `.licio-bundle` files are the always-available baseline** (a plain PWA uses them with no opt-in); the **discovery/P2P transports** (WebTransport, WebRTC, the IPFS public-block bridge, and the native courier) are **off by default and consent-gated** per operational mode, and disabled in Stealth/Emergency.

Transport never decides trust.

---

## 9. Data identity and canonicalization

### 9.1 Deterministic encoding

LCAP record bodies, proof bodies, and every object whose CID or signature must be reproducible MUST be encoded with the **LCAP Deterministic CBOR profile (LDC)**. LDC is RFC 8949 §4.2.1 *Core Deterministic Encoding* plus the additional restrictions below. Two conforming encoders MUST produce byte-identical output for the same logical value, and a decoder MUST reject any input that is not in LDC form when the context requires determinism (anything that is hashed into a CID or covered by a signature).

#### 9.1.1 Core rules (RFC 8949 §4.2.1)

- Integers and all length/count arguments use the **shortest-form (preferred) encoding**: `23` is one byte, never a 2/4/8-byte form, and there are no leading-zero argument bytes.
- Only **definite-length** encodings are used for byte strings, text strings, arrays, and maps. Indefinite-length items (`0x5f`, `0x7f`, `0x9f`, `0xbf`) MUST be rejected.
- **Map keys are sorted in ascending bytewise lexicographic order of their deterministic CBOR encodings.** Duplicate keys (equal encoded key bytes) MUST be rejected, never merged or last-wins.

#### 9.1.2 LCAP restrictions (beyond core)

- **No floating point.** Major-type-7 floats (half/single/double) MUST NOT appear in any v0.2 record, proof, or pack schema. All quantities are integers; time is integer milliseconds since the Unix epoch. NaN/Infinity therefore cannot occur.
- **No CBOR tags** except those on an explicit per-schema allowlist. v0.2 defines no permitted tags inside record bodies, so any tag fails closed.
- **No `undefined` and no simple values** other than `false`, `true`, and `null`. `null` is permitted only where a field's schema explicitly allows it and MUST NOT stand in for an absent optional field (see 9.1.3).
- **Text strings** (major type 3) that act as identifiers, map keys, domain separators, or any value covered by a signature or CID MUST be valid UTF-8 and **Unicode NFC-normalized**; invalid UTF-8 MUST be rejected. Identity-bearing text is the only text allowed in a deterministic body. Free-form human text (a note, a body) is carried in a **block**, not in the record body, so normalization choices can never perturb a `record_cid`.
- **Byte strings** (major type 2) carry every binary value (public keys, signatures, hashes, nonces). Binary MUST NOT be smuggled as base64 text inside a deterministic body.

#### 9.1.3 Optional fields

An optional field is encoded by **omitting its map key** when absent; it MUST NOT be encoded as `key: null`. "Absent" and "present-but-null" are therefore distinct, and there is exactly one canonical byte sequence per logical record.

#### 9.1.4 Unknown and critical fields

Record, proof, capability, certificate, revocation, and checkpoint bodies are **closed schemas**: a map key not defined by the object's schema MUST cause rejection (`rejected_bad_schema`), never silent acceptance. This "reject unknown critical fields" rule is what lets a verifier treat a successfully parsed body as fully understood *before* computing trust. Forward-compatible extension is introduced by **bumping `record_version`** (a new closed schema), never by adding stray keys to an existing version.

#### 9.1.5 Conformance vectors

LDC is normatively pinned by the `packages/lcap/src/test-vectors/` corpus (§32.1): for each record kind, a logical value, its canonical LDC bytes (hex), and the resulting `record_cid`. Any encoder/decoder change that alters a published vector is a breaking change and MUST bump the profile version.

### 9.2 CID construction

All LCAP CIDs share one binary layout and one string form, so a single verified routine produces and checks every CID kind.

**Binary form.**

```text
cid_bytes = lcap_prefix || multihash
lcap_prefix = 0x01 (cid_format_version) || kind_code
kind_code   = 0x01 record | 0x02 proof | 0x03 block | 0x04 chunk
multihash   = 0x12 (sha2-256) || 0x20 (digest length = 32) || digest[32]
```

**String form.**

```text
cid_string = human_prefix || base32(cid_bytes)
human_prefix = "lcapr_" record | "lcapp_" proof | "lcapb_" block | "lcapc_" chunk
base32       = RFC 4648 §6 lower-case, no padding (alphabet a–z 2–7, URL-safe)
```

The `kind_code` is bound into the hash preimage's CID, not just the string, so a record digest can never be reinterpreted as a block digest. `sha2-256` is fixed in v0.2; the multihash code/length bytes reserve agility for a future hash without changing the layout.

```text
record_cid = "lcapr_" || base32(0x01 0x01 || 0x12 0x20 || sha256(deterministic_record_body))
```

The CID input MUST be **only** the deterministic record body (§9.1) — never the proof bytes, transfer framing, or compression wrapper.

### 9.3 Proof CID

```text
proof_cid = "lcapp_" || base32(0x01 0x02 || 0x12 0x20 || sha256(deterministic_proof_body))
```

A proof object references by value the `record_cid` it proves. The proof body that is hashed for `proof_cid` includes the `record_cid`, the protected header, and the signature bytes, so the same record may carry several distinct proofs (multi-witness) with distinct `proof_cid`s.

### 9.4 Block CID

For ordinary blocks:

```text
block_cid = "lcapb_" || base32(0x01 0x03 || 0x12 0x20 || sha256(block_bytes))
chunk_cid = "lcapc_" || base32(0x01 0x04 || 0x12 0x20 || sha256(chunk_bytes))
```

If a block declares compression as canonical, the block descriptor MUST include:

```text
canonical_encoding
compressed_size
uncompressed_size
uncompressed_sha256
compression_algorithm
max_expansion_ratio
```

v0.2 SHOULD avoid canonical compressed blocks for small text. Prefer pack-level or HTTP-level compression so CIDs remain stable over uncompressed logical bytes.

### 9.5 Domain separation

Every signature context MUST include a domain separator. The separator is a US-ASCII string with this exact grammar:

```text
separator = "LCAP-v0.2:" network_id ":" object_kind ":" purpose
network_id  = "prod" | "staging" | "test" | <deployment label, [a-z0-9_-]+>
object_kind = "record" | "proof" | "checkpoint" | "bundle" | "receipt"
purpose     = <lower_snake_case label, e.g. contribution_event, device_signature>
```

Examples:

```text
LCAP-v0.2:prod:record:contribution_event
LCAP-v0.2:prod:proof:device_signature
LCAP-v0.2:prod:checkpoint:room_log
LCAP-v0.2:prod:bundle:manifest
```

The separator is never concatenated ad hoc with payload bytes. It is carried as the **first element of the `external_aad` structure** (§10.2), which is itself LDC-encoded so that the bound context — separator, protocol version, network id, and record kind — has exactly one byte representation. Domain separation prevents a signature minted for one network, object kind, or protocol version from validating in another, and it closes cross-protocol signature-reuse attacks.

---

## 10. Cryptographic profile

### 10.1 Required profile

LCAP v0.2 REQUIRED baseline:

```text
Hash:       SHA-256
Encoding:   deterministic CBOR
Signature:  ES256-style P-256 ECDSA with SHA-256
Envelope:   COSE-style detached signature proof
ECDSA form: raw fixed-width r || s
Malleability rule: reject high-S signatures; normalize client-generated signatures to low-S before storage/transmission
AEAD:       AES-256-GCM for local draft/block encryption where already used by Licio
```

The P-256 baseline is chosen because `ECDSA P-256 / SHA-256` is available in **WebCrypto on every target browser and in Node `crypto`** with no added dependency, satisfying §3.1 (PWA-first) and §3.2 (old-phone viability). Ed25519 MAY be added as an optional suite only after browser support, dependency footprint, and audit posture are acceptable (see §10.3). Note that the private P2P-rooms plane (`docs/PRIVATE_SPEC.md`) standardizes on Ed25519 to align with its MLS cipher suite; the two planes are independent and each pins its own suite.

#### 10.1.1 ECDSA canonicalization (mandatory)

ECDSA signatures are malleable: `(r, s)` and `(r, n − s)` both verify. LCAP removes that freedom so a signature has exactly one valid encoding.

```text
let n = the P-256 group order (0xFFFF...BCE6FAADA7179E84F3B9CAC2FC632551)
signature bytes = r (32-byte big-endian) || s (32-byte big-endian)   // 64 bytes total

On signing:
  if s > n/2 then s := n − s          // low-S normalization
On verifying, REJECT (status rejected_high_s_signature) unless:
  0 < r < n  and  0 < s ≤ n/2          // r,s in range AND s is low
```

Implementations MUST reject the DER-wrapped form on the wire (raw `r || s` only), MUST reject `r = 0` or `s = 0`, and MUST reject any `r`/`s` ≥ `n`. WebCrypto's `ECDSA` already emits raw `r || s`; the low-S check is applied on top.

### 10.2 Detached proof shape

A proof object has this logical shape:

```ts
type DetachedProofV2 = {
  proof_version: 2;
  proof_kind: "device_signature" | "authority_signature" | "witness_signature";
  record_cid: string;            // the record this proof authenticates
  record_kind: LcapRecordKind;

  cose_protected: Uint8Array;    // LDC-encoded protected header map, e.g. {1: -7}
  cose_unprotected?: CoseUnprotectedHeader;
  external_aad: Uint8Array;      // LDC-encoded context array (see 10.2.2)
  signature: Uint8Array;         // raw r||s, low-S (64 bytes for ES256)

  signer_key_id: string;
  created_at_claim_ms?: number;
  proof_scope?: ProofScope;
};
```

LCAP signs with **COSE_Sign1 detached payload** semantics (RFC 9052 §4.4). The fields above are not concatenated by hand; the signature is computed over a canonical `Sig_structure`.

#### 10.2.1 Protected header

`cose_protected` is the LDC encoding of a COSE header map whose only mandatory entry is the algorithm (label `1`):

```text
ES256 (P-256 / SHA-256)  -> { 1: -7 }
EdDSA (Ed25519, future)  -> { 1: -8 }
```

The algorithm is in the **protected** (signed) header, never the unprotected one, so it cannot be stripped or downgraded (§10.3). `cose_unprotected` MAY carry non-security hints (e.g. a key-id echo) and is never covered by the signature.

#### 10.2.2 External AAD

`external_aad` is the LDC encoding of a fixed-shape array that binds the signing context:

```text
external_aad = LDC([
  domain_separator,   // tstr, §9.5 grammar, e.g. "LCAP-v0.2:prod:proof:device_signature"
  protocol_version,   // uint, 2
  network_id,         // tstr, e.g. "prod"
  record_kind,        // tstr, e.g. "contribution_event"
  proof_kind          // tstr, e.g. "device_signature"
])
```

Because the array is LDC-encoded, the bound context has exactly one byte representation, eliminating canonicalization ambiguity in the AAD itself.

#### 10.2.3 What is signed

The COSE detached **payload is the deterministic record body bytes** (the same `deterministic_record_body` that produced `record_cid` in §9.2). The signer builds and signs:

```text
Sig_structure = [
  "Signature1",                 // context, COSE_Sign1
  cose_protected,               // bstr: the protected header bytes
  external_aad,                 // bstr: the §10.2.2 context bytes
  deterministic_record_body     // bstr: the detached payload
]
ToBeSigned = LDC(Sig_structure)
signature  = ECDSA-low-S( signer_private_key, SHA-256, ToBeSigned )   // §10.1.1
```

#### 10.2.4 Verification

```text
1. Recompute record_cid' = CID(deterministic_record_body); REJECT if record_cid' != proof.record_cid.
2. Parse cose_protected; REJECT if alg is absent, unknown, or a disabled/weaker suite (no downgrade, §10.3).
3. Rebuild external_aad from local (protocol_version, network_id, record_kind, proof_kind, expected separator);
   REJECT if it does not byte-match proof.external_aad.
4. Rebuild Sig_structure and ToBeSigned exactly as in 10.2.3.
5. REJECT (rejected_high_s_signature) unless the signature is canonical low-S (§10.1.1).
6. Verify ECDSA(signer_public_key, ToBeSigned, signature); REJECT (rejected_bad_signature) on failure.
```

Signing the body (not just the CID) keeps LCAP proofs verifiable by any off-the-shelf COSE_Sign1 implementation, while step 1 still binds the proof to the stable `record_cid`. Because `record_cid` is independent of the signature bytes (§5.1), one record body MAY carry multiple proofs (device + witnesses) without changing its identity.

### 10.3 Algorithm agility

Every proof MUST identify its algorithm. Unknown algorithms MUST fail closed unless the record is explicitly treated as an opaque untrusted object.

Algorithm negotiation MUST NOT permit downgrade. A node that supports both ES256 and Ed25519 MUST NOT accept a weaker or disabled algorithm because a peer omitted the stronger one.

### 10.4 Future post-quantum path

v0.2 MUST NOT require post-quantum signatures for cheap-phone PWA operation. It SHOULD reserve algorithm identifiers and schema space for future hybrid proofs:

```text
classical proof + post-quantum proof over the same record_cid
```

This allows high-risk deployments to add long-term authenticity later without changing record identity.

### 10.5 Key storage

Device signing keys SHOULD be generated locally. When browser support permits, private keys SHOULD be non-extractable. Loss of browser storage may destroy a device key; therefore device certificates and capabilities MUST be revocable and replaceable.

The server MUST NOT require a device private signing key to be exportable.

---

## 11. Identity, certificates, and capabilities

### 11.1 Identity chain

```text
Licio account authority
  signs DeviceCertificate
DeviceCertificate
  binds account_id to device_key_id and public key
RoomAuthority
  signs RoomCapability for device_key_id/account_id
Device key
  signs contribution records
```

### 11.2 Device certificate record

```ts
type DeviceCertificateRecordV2 = {
  record_version: 2;
  kind: "device_certificate";
  account_id: string;
  device_id: string;
  device_key_id: string;
  public_key_cose: Uint8Array;
  issued_at_ms: number;
  not_before_ms: number;
  not_after_ms: number;
  issuer: "licio_account_authority";
  account_epoch: number;
  flags?: {
    offline_signing_allowed?: boolean;
    courier_allowed?: boolean;
    high_risk?: boolean;
  };
};
```

A device certificate is valid only with an authority proof.

### 11.3 Capability record

```ts
type CapabilityRecordV2 = {
  record_version: 2;
  kind: "room_capability";
  capability_id: string;

  subject_account_id: string;
  subject_device_id: string;
  subject_device_key_id: string;

  room_id: string;
  visibility_scope: "public" | "in_room" | "private";
  operations: LcapOperation[];

  policy_epoch: number;
  revocation_epoch_floor: number;

  not_before_ms: number;
  not_after_ms: number;

  quotas: {
    max_offline_events: number;
    max_total_payload_bytes: number;
    max_single_event_bytes: number;
    max_media_bytes: number;
    max_export_count?: number;
  };

  transfer_policy: {
    may_export_bundle: boolean;
    may_share_with_relay: boolean;
    may_share_with_courier: boolean;
    may_share_with_unknown_peer: boolean;
  };
};
```

Capabilities MUST be short-lived for high-risk rooms and moderation roles. Long-lived public-room posting capabilities MAY exist but SHOULD have strict quotas.

### 11.4 Capability consumption

Clients MUST track local capability usage before signing offline records. Servers MUST enforce final usage independently.

Capability consumption is keyed by:

```text
capability_id + subject_device_key_id + device_seq
```

`device_seq` is a **single monotonic counter per `device_key_id`, global across all of that device's capabilities and rooms** (§12.2). It is the device's signing-sequence number, not a per-capability counter, so the sequence a device emits may interleave records authorized by different capabilities. Quota accounting is therefore independent of the sequence: each accepted record debits its `capability_cid`'s `quotas` (event count, payload bytes, media bytes), while `device_seq` exists only to make the device's signing history a verifiable hash chain.

A server MUST treat repeated valid submissions of the same event (same `record_cid`) as idempotent (§24.3) and MUST treat two distinct `record_cid`s sharing the same `(subject_device_key_id, device_seq)` as device-fork evidence (§12.2) — regardless of whether they cite the same capability.

### 11.5 Revocation record

```ts
type RevocationRecordV2 = {
  record_version: 2;
  kind: "revocation";
  revocation_id: string;
  revoked_kind: "device" | "capability" | "account" | "room_policy" | "proof";
  revoked_id: string;
  room_id?: string;
  account_id?: string;
  effective_at_ms: number;
  revocation_epoch: number;
  reason_code?: string;
  replacement_cid?: string;
};
```

Revocations are P0 control records and MUST be scheduled before all non-control content.

---

## 12. Event records

### 12.1 Contribution event record

```ts
type ContributionEventRecordV2 = {
  record_version: 2;
  kind: "contribution_event";

  event_type:
    | "post"
    | "question"
    | "answer"
    | "evidence"
    | "correction"
    | "synthesis"
    | "counterexample"
    | "clarification"
    | "edit"
    | "tombstone"
    | "moderation_action"
    | "source_snapshot_ref";

  home_room_id: string;
  visibility_scope: "public" | "in_room" | "private";

  author_account_id: string;
  author_device_id: string;
  author_device_key_id: string;

  device_seq: number;
  prev_device_record_cid?: string;

  capability_cid: string;
  policy_epoch_claim: number;
  revocation_epoch_claim: number;

  parent_record_cids?: string[];
  replaces_record_cid?: string;
  thread_root_cid?: string;

  body_block_cid?: string;
  attachment_manifest_cid?: string;
  source_snapshot_cids?: string[];

  created_at_claim_ms?: number;
  client_nonce: Uint8Array;
  priority: 0 | 1 | 2 | 3 | 4;

  licio_contribution_type?: string;
  markdown_profile?: "licio_markdown_lite_v1";

  privacy_flags?: {
    contains_private_room_metadata?: boolean;
    safe_for_unknown_relay?: boolean;
    safe_for_manual_export?: boolean;
  };
};
```

### 12.2 Device sequence chain

Each device MUST maintain a monotonic `device_seq`. Every signed contribution after the first SHOULD reference `prev_device_record_cid`.

Fork detection:

```text
same author_device_key_id + same device_seq + different record_cid = device fork evidence
```

Fork evidence MUST be P0 and SHOULD be gossiped.

### 12.3 Edit and deletion semantics

Edits and deletions MUST be new records. They MUST NOT mutate previous records.

```text
edit record -> replaces_record_cid
moderation tombstone -> target_record_cid
source correction -> target_source_snapshot_cid
```

The visible UI state is a deterministic projection over the append-only record graph plus moderation policy.

### 12.4 Ordering

LCAP MUST NOT trust phone clocks for canonical ordering.

Display ordering SHOULD use:

1. server/room log sequence when known;
2. causal parent/reference order;
3. device sequence order;
4. checkpoint inclusion order;
5. claimed timestamp as weak hint;
6. local receipt/import time as last resort.

---

## 13. Blocks, chunking, and attachments

### 13.1 Block descriptor

```ts
type BlockDescriptorV2 = {
  block_cid: string;
  role:
    | "body_text"
    | "source_snapshot_text"
    | "thumbnail"
    | "image"
    | "video"
    | "encrypted_payload"
    | "proof_blob"
    | "misc";
  media_type: string;
  size_bytes: number;
  sha256: Uint8Array;
  priority: 0 | 1 | 2 | 3 | 4;
  chunking?: ChunkingDescriptorV2;
  compression?: CompressionDescriptorV2;
};
```

### 13.2 Chunking

v0.2 SHOULD use fixed-size chunks for PWA simplicity.

Recommended defaults:

```text
unstable/old-phone/mobile-data: 16 KiB or 32 KiB
normal HTTPS:                   64 KiB
LAN relay/courier Wi-Fi:        128 KiB or 256 KiB
very large media:               adaptive, never required for initial render
```

Each chunk MUST have:

```ts
type ChunkDescriptorV2 = {
  parent_block_cid: string;
  chunk_index: number;
  offset: number;
  length: number;
  chunk_sha256: Uint8Array;
};
```

The receiver MUST verify both each chunk hash and the final block hash after reassembly.

### 13.3 Content-defined chunking

Content-defined chunking MAY improve deduplication for source snapshots and repeated media, but it is CPU-expensive and more complex. It SHOULD NOT be required on cheap phones in v0.2. It MAY be added server-side or relay-side after profiling.

### 13.4 Attachment laziness

A contribution with media SHOULD be split:

```text
contribution event record       P1
body text block                 P1
thumbnail block                 P2
attachment manifest             P2
full image/video chunks         P3
```

The UI MUST be able to render the signed text and trust state without full media.

### 13.5 Compression

Pack-level compression is preferred over object-level compression for v0.2.

Rules:

- do not compress tiny records;
- compress source snapshots and text packs when beneficial;
- prefer browser-native gzip/deflate where available;
- allow server-side zstd for clients that explicitly advertise support;
- bound decompressed sizes;
- enforce expansion ratio limits;
- reject compression bombs;
- compute record/block CIDs over canonical uncompressed content unless the block explicitly declares canonical compression.

---

## 14. Packfile and `.licio-bundle` format

### 14.1 Design goals

The pack format MUST support:

- streaming parse;
- early metadata inspection;
- bounded memory;
- dependency-first ordering;
- byte-range resume;
- partial import;
- media laziness;
- untrusted transport;
- deterministic object identity independent of pack framing.

### 14.2 File extension and MIME type

Recommended:

```text
Extension: .licio-bundle
MIME:      application/vnd.licio.lcap-pack
Magic:     LCAPACK2\n
```

High-risk exports SHOULD allow generic filenames that do not reveal rooms or topics.

### 14.3 Pack structure

```text
magic:        "LCAPACK2\n"
header_len:   uvarint
header_cbor:  deterministic CBOR PackHeaderV2
table_len:    uvarint
table_cbor:   deterministic CBOR PackTableV2
frames:       repeated PackFrameV2
trailer:      optional PackTrailerV2
```

The object table appears before frames so the receiver can decide whether to import, skip, or request only selected ranges.

### 14.4 Pack header

```ts
type PackHeaderV2 = {
  pack_version: 2;
  created_by_node_id?: string;
  created_at_claim_ms?: number;
  transport_profile:
    | "https"
    | "manual_bundle"
    | "qr"
    | "relay"
    | "courier"
    | "test";
  privacy_label:
    | "public"
    | "contains_in_room_metadata"
    | "contains_private_encrypted"
    | "manual_user_selected";
  compression?: "none" | "gzip" | "deflate" | "zstd";
  max_uncompressed_bytes: number;
  contains_lanes: LcapLane[];
  critical_cids?: string[];
  manifest_record_cid?: string;
};
```

### 14.5 Pack table entry

```ts
type PackTableEntryV2 = {
  cid: string;
  cid_kind: "record" | "proof" | "block" | "chunk";
  record_kind?: LcapRecordKind;
  lane: LcapLane;
  priority: 0 | 1 | 2 | 3 | 4;
  offset: number;
  length: number;
  uncompressed_length?: number;
  deps?: string[];
  provides_proof_for?: string;
  room_id_hash?: Uint8Array;
  flags?: {
    critical?: boolean;
    renderable_without_media?: boolean;
    encrypted?: boolean;
    private_metadata?: boolean;
  };
};
```

### 14.6 Frame

```ts
type PackFrameV2 = {
  frame_kind: "record_body" | "proof" | "block" | "chunk";
  cid: string;
  payload_len: number;
  payload: Uint8Array;
};
```

A receiver MUST verify:

```text
frame length <= configured max
payload hash matches cid
record schema is valid
proof matches record_cid
dependencies are known or declared missing
critical fields are understood
privacy policy permits import/render/export
```

### 14.7 Partial import

A pack MAY be partially imported. If a pack contains media the user does not want, the client SHOULD import the event, proof, text, capability, checkpoint, and thumbnail while skipping full media chunks.

### 14.8 Bundle manifest record

A bundle manifest is a record body, not an authority statement.

```ts
type BundleManifestRecordV2 = {
  record_version: 2;
  kind: "bundle_manifest";
  entries: PackTableEntryV2[];
  purpose:
    | "manual_export"
    | "relay_offer"
    | "courier_transfer"
    | "server_response"
    | "qr_microbundle";
  export_scope?: {
    room_ids?: string[];
    priority_floor?: 0 | 1 | 2 | 3 | 4;
    include_private_encrypted?: boolean;
    include_media?: boolean;
  };
};
```

A manifest signature proves who prepared the bundle; it does not make the contained records trusted.

---

## 15. Lanes and scheduler

### 15.1 Lanes

```text
C0 control      P0/P1 trust and liveness material
T1 text         signed contribution records and body text
E2 evidence     source snapshots, citations, thumbnails, correction context
M3 media        images, video, large attachments
B4 bulk         nonessential cache, debug, analytics-safe aggregate material
```

Priority and lane are related but not identical. A P0 record is normally in C0. A P1 text body is normally in T1. A source snapshot might be P2 in E2.

#### 15.1.1 Canonical priority ↔ lane mapping

Three names for the same axis appear across this spec: the wire field `priority: 0 | 1 | 2 | 3 | 4`, the replication **priority class** `P0–P4` (§21.1), and the **lane** `C0–B4`. They are one ordering. This table is the single source of truth; `Pn` and `priority: n` are identical, and the lane is the default scheduling class for that priority.

| `priority` | Class | Default lane | Meaning | Typical objects |
|---:|---|---|---|---|
| 0 | P0 | C0 | Emergency / trust control | revocations, checkpoints, fork evidence, device/capability updates, safety notices |
| 1 | P1 | T1 | Text and core semantics | contribution records, edits, corrections, moderation actions, body text |
| 2 | P2 | E2 | Evidence / context | source snapshots, citations, thumbnails, compact summaries |
| 3 | P3 | M3 | Media | images, video, large attachments |
| 4 | P4 | B4 | Nonessential bulk | debug-safe aggregates, old cache, optional material |

The lane is a **default**, not a lock: an object MAY be scheduled in a lane other than its priority's default when the closure rules require it (a P1 text body that depends on a P0 capability still ships behind C0), but an object MUST NOT be promoted into C0 unless it is genuinely P0 trust/liveness material. Lower `priority` number = scheduled earlier and protected from starvation (§15.2).

### 15.2 Mandatory ordering invariant

A sender MUST NOT send M3/B4 data before all currently schedulable C0 objects in the same budget are sent.

A sender SHOULD NOT send a dependent object before dependencies needed to verify or render it.

### 15.3 Byte reservation

Default response budget allocation:

```text
C0 control:  first 8 KiB minimum, then at least 25% until exhausted
T1 text:     at least 40% after C0 minimum
E2 evidence: up to 25% when budget allows
M3 media:    up to 10% unless user explicitly requested media
B4 bulk:     0% by default; only when idle/unmetered/charging/opt-in
```

For very small sessions:

```text
<= 8 KiB:     only C0 pulse/checkpoint/revocation/frontier material
<= 32 KiB:    C0 + smallest T1 records
<= 128 KiB:   C0 + T1 + critical proofs/dependencies
<= 512 KiB:   add E2 summaries/thumbnails
> 512 KiB:    allow selected E2 and optional M3
```

### 15.4 Scheduler algorithm

The sender SHOULD use dependency-aware deficit round robin:

```text
1. Build candidate set from wants, interests, local outbox, missing deps.
2. Remove objects forbidden by privacy policy, storage budget, or capability.
3. Promote missing dependencies of selected objects.
4. Assign each candidate a lane and score.
5. Reserve initial bytes for C0.
6. Run deficit round robin over lanes with lane weights.
7. Within each lane, use shortest-verifiable-object-first with deadline boost.
8. Stop before budget overflow.
9. Emit pack table in transfer order.
```

Suggested score:

```text
score =
  priority_weight
  × explicit_want_weight
  × dependency_weight
  × freshness_weight
  × user_interest_weight
  × scarcity_weight
  × trust_probability
  × deadline_weight
  ÷ (bytes × estimated_cpu × privacy_risk)
```

Every factor MUST be clamped to a strictly positive finite range before use (e.g. each weight in `[0.01, 100]`, every divisor `≥ 1`) so the score is always finite and an object is never permanently un-schedulable by a single zero factor; the C0 byte reservation (§15.3), not the score, is what guarantees control traffic moves. Equivalently, implementations MAY compute the score in log-additive form to avoid underflow. The exact numeric weights MAY be tuned, but two invariants hold regardless of weights: **C0 and dependency closure cannot starve**, and scoring is applied **only to break ties within a lane after** the byte reservations and dependency-promotion rules (§15.3–§15.4 steps 3, 5–7) have run.

### 15.5 Scarcity boost

Objects with fewer known replicas SHOULD receive a scarcity boost. Storage receipts are not trusted proofs, but they are useful hints.

```text
replica_count = distinct recent receipts for record_cid or block_cid
scarcity_weight increases as replica_count decreases
```

### 15.6 User-pinned override

User-pinned content MAY override normal lane weights after C0 obligations are satisfied.

---

## 16. Sync protocol

### 16.1 Sync modes

LCAP v0.2 defines three sync modes:

```text
pulse     tiny trust/liveness frontier exchange
exchange  normal bidirectional pack exchange
fetch     range/object fetch for selected blocks/chunks
```

The normal HTTPS endpoint SHOULD combine pulse and exchange into one request/response, but the pulse MUST be logically first.

### 16.2 Sync pulse

```ts
type SyncPulseV2 = {
  lcap_version: 2;
  node_id: string;
  session_nonce: Uint8Array;
  transport_profile: "https" | "relay" | "courier" | "manual_import" | "qr";
  privacy_mode: "public" | "contacts_only" | "manual" | "stealth";

  budgets: ExchangeBudgetV2;
  supported_suites: CryptoSuiteId[];
  supported_compression: CompressionId[];
  supported_pack_versions: number[];

  checkpoint_frontier: CheckpointFrontierV2[];
  revocation_frontier: RevocationFrontierV2[];
  capability_frontier?: CapabilityFrontierV2[];

  critical_have?: string[];
  critical_want?: string[];
  lane_summary?: LaneSummaryV2[];
};
```

### 16.3 Exchange request

```ts
type ExchangeRequestV2 = {
  pulse: SyncPulseV2;
  interests: InterestDescriptorV2[];
  known_summaries?: ObjectSummaryV2[];
  ack_receipts?: ReceiptRecordV2[];
  push_pack?: PackBytes;
  want?: WantRequestV2[];
};
```

### 16.4 Exchange response

```ts
type ExchangeResponseV2 = {
  pulse: SyncPulseV2;
  status: "ok" | "partial" | "rate_limited" | "retry_later" | "auth_required";
  accepted_push?: ObjectStatusV2[];
  wanted_from_client?: WantRequestV2[];
  offer_summary?: ObjectSummaryV2[];
  response_pack?: PackBytes;
  receipts?: ReceiptRecordV2[];
  retry_after_ms?: number;
  warnings?: ExchangeWarningV2[];
};
```

### 16.5 Budgets

```ts
type ExchangeBudgetV2 = {
  max_request_bytes: number;
  max_response_bytes: number;
  max_pack_table_entries: number;
  max_frame_bytes: number;
  max_uncompressed_bytes: number;
  max_records: number;
  max_proofs: number;
  max_blocks: number;
  time_budget_ms?: number;
  priority_floor: 0 | 1 | 2 | 3 | 4;
  allow_evidence: boolean;
  allow_media: boolean;
  allow_private_encrypted: boolean;
  metered_connection?: boolean;
  battery_saver?: boolean;
  minimal_mode?: boolean;
};
```

Clients SHOULD shrink budgets under battery saver, metered data, low storage, high memory pressure, or high-risk privacy mode.

### 16.6 Interest descriptor

```ts
type InterestDescriptorV2 = {
  interest_version: 2;
  room_id?: string;
  room_id_hash?: Uint8Array;
  visibility_scope?: "public" | "in_room" | "private";
  record_kinds?: LcapRecordKind[];
  lanes?: LcapLane[];
  min_priority?: 0 | 1 | 2 | 3 | 4;
  since_checkpoint_cid?: string;
  since_tree_size?: number;
  include_dependencies: boolean;
  include_proofs: boolean;
  privacy_level: "public" | "trusted_peer_only" | "manual_only";
};
```

A client MUST NOT expose private or sensitive room interests to arbitrary peers or relays.

### 16.7 Object summary

```ts
type ObjectSummaryV2 = {
  cid: string;
  cid_kind: "record" | "proof" | "block" | "chunk";
  record_kind?: LcapRecordKind;
  lane: LcapLane;
  priority: 0 | 1 | 2 | 3 | 4;
  size_bytes: number;
  deps?: string[];
  room_id_hash?: Uint8Array;
  trust_hint?: "unknown" | "locally_verified" | "checkpointed" | "revoked";
  replica_hint?: number;
};
```

Summaries are hints only. The receiver MUST verify actual payloads.

### 16.8 Wants

```ts
type WantRequestV2 = {
  cid: string;
  cid_kind: "record" | "proof" | "block" | "chunk";
  reason:
    | "missing_dependency"
    | "explicit_user_request"
    | "checkpoint_gap"
    | "revocation_gap"
    | "room_interest"
    | "resume_partial"
    | "scarce_replica";
  max_bytes?: number;
  range?: { offset: number; length: number };
  priority_override?: 0 | 1 | 2 | 3 | 4;
};
```

### 16.9 Idempotence

All ingestion operations MUST be idempotent.

Repeated submission of the same record body and equivalent proof MUST NOT duplicate application semantics.

### 16.10 Resume

Large blocks MUST support range fetch:

```text
GET /api/lcap/v2/blocks/:blockCid/range?offset=N&length=M
```

A range response MUST include:

```text
block_cid
chunk index or byte range
offset
length
total length
chunk hash or range hash context
```

The receiver MUST verify the reassembled block CID.

### 16.11 ACK and status

```ts
type ObjectStatusV2 = {
  cid: string;
  cid_kind: "record" | "proof" | "block" | "chunk";
  status:
    | "accepted"
    | "already_have"
    | "stored_pending"
    | "stored_unverified"
    | "quarantined_missing_dependency"
    | "quarantined_unknown_key"
    | "quarantined_stale_checkpoint"
    | "quarantined_policy_review"
    | "conflict_device_fork"
    | "rejected_bad_cid"
    | "rejected_bad_schema"
    | "rejected_bad_signature"
    | "rejected_high_s_signature"
    | "rejected_revoked"
    | "rejected_capability_expired"
    | "rejected_policy_denied"
    | "rejected_quota"
    | "rejected_resource_limit";
  missing_cids?: string[];
  detail_code?: string;
  receipt_cid?: string;
};
```

---

## 17. Reconciliation and anti-entropy

### 17.1 Frontiers before filters

v0.2 SHOULD avoid large raw object lists in normal sync. It SHOULD reconcile in this order:

1. revocation frontier;
2. room checkpoint frontier;
3. policy epoch frontier;
4. device sequence frontier for relevant devices;
5. explicit missing dependency wants;
6. recent object summaries;
7. optional filters for large caches.

### 17.2 Room checkpoint frontier

```ts
type CheckpointFrontierV2 = {
  room_id_hash: Uint8Array;
  latest_checkpoint_cid?: string;
  latest_tree_size?: number;
  latest_policy_epoch?: number;
  latest_revocation_epoch?: number;
};
```

For authenticated HTTPS to the Licio API, `room_id` MAY be used directly. For peers/relays, hashed or opaque room identifiers SHOULD be used where possible.

### 17.3 Revocation frontier

```ts
type RevocationFrontierV2 = {
  scope: "global" | "room" | "account";
  scope_hash?: Uint8Array;
  revocation_epoch: number;
  latest_revocation_checkpoint_cid?: string;
};
```

If peer A’s revocation frontier is behind peer B’s, B SHOULD prioritize revocation records and summaries.

### 17.4 Filters

Bloom filters, Golomb-coded sets, invertible Bloom lookup tables, or other set-reconciliation structures MAY be added as optional hints. They MUST NOT be authoritative, because false positives can suppress needed transfers.

### 17.5 Dependency closure

When sending a renderable contribution, the sender SHOULD include the minimal trust/render dependency closure:

```text
device certificate record + authority proof
room capability record + authority proof
contribution record + device proof
body text block
parent/root records if needed for context
latest known room checkpoint summary
```

Large media and old ancestor context MAY be omitted unless requested.

---

## 18. Trust projection

### 18.1 Trust inputs

Trust projection uses:

```text
record schema validity
record CID validity
proof validity
signer key status
device certificate validity
capability validity
capability quota/policy
revocation knowledge
room policy epoch
room checkpoint inclusion
checkpoint consistency
witness statements
server acceptance receipts
local risk mode
```

### 18.2 Trust states

```text
raw_unverified
  Bytes exist, CID may or may not be checked.

integrity_verified
  CID and schema are valid.

proof_verified
  A valid detached proof over record_cid exists.

authorized_provisional
  Device certificate and capability validate against local knowledge.

stale_authorized
  Local authorization chain validates, but revocation/checkpoint frontier is stale.

server_stored
  Server says it stored the record, but not necessarily accepted into room state.

server_accepted
  Server/room authority accepted the record into pending/canonical room processing.

checkpointed
  Record is included in a signed room checkpoint with valid inclusion proof.

witnessed
  Checkpoint has been observed by one or more configured witnesses.

conflicting
  Fork, sequence conflict, incompatible policy, or checkpoint conflict exists.

revoked
  Device, capability, account, proof, or policy was revoked according to known revocation state.

rejected
  Record failed schema, CID, signature, policy, quota, or moderation acceptance.
```

The UI MUST NOT collapse these states into a simple “verified” badge.

### 18.3 Validation algorithm

```text
function validate(record_cid):
  1. Load deterministic record body.
  2. Verify record_cid = hash(record body).
  3. Parse schema with strict unknown-critical-field rejection.
  4. Load proofs referencing record_cid.
  5. Verify at least one applicable proof signature.
  6. Load signer key and device certificate.
  7. Verify certificate authority proof.
  8. Load capability referenced by record.
  9. Verify capability authority proof.
 10. Check operation/scope/room/visibility/policy/quotas.
 11. Check known revocations.
 12. Check device sequence chain/fork evidence.
 13. Check room checkpoint inclusion if available.
 14. Check checkpoint consistency if available.
 15. Return trust state and missing dependencies.
```

### 18.4 No transport trust

A record imported from a trusted friend and a record imported from a hostile relay go through the same validation pipeline. Human trust may affect import willingness, but it MUST NOT bypass cryptographic or policy validation.

---

## 19. Room logs, checkpoints, and witnesses

### 19.1 Room log

Each room SHOULD maintain an append-only canonical log of accepted records.

The room log sequence is not the same as creation time. It is the canonical acceptance order for that room.

#### 19.1.1 Merkle tree definition

A room log is a Merkle tree over its accepted records, using **RFC 6962 / RFC 9162 domain-separated hashing** to prevent second-preimage and leaf/node confusion attacks:

```text
empty tree hash : MTH({})        = SHA-256("")
leaf hash       : MTH({ d })     = SHA-256(0x00 || record_cid_bytes(d))
node hash       : MTH(D)         = SHA-256(0x01 || MTH(D_left) || MTH(D_right))
```

where the leaf input is the 36-byte `cid_bytes` of the accepted record (§9.2: `0x01 || kind_code || 0x12 || 0x20 || digest[32]`), and the split point follows RFC 6962 §2.1 (largest power of two strictly less than the leaf count). `tree_size` is the number of leaves; `merkle_root` is `MTH` over all of them.

`tree_algorithm` selects the hashing/proof rules:

- **`RFC9162_SHA256`** (RECOMMENDED) — the rules above, byte-for-byte compatible with RFC 9162 so a standard Certificate-Transparency verifier can check LCAP inclusion and consistency proofs unchanged.
- **`LCAP_MERKLE_V2`** — identical leaf/node hashing, but the leaf prefix is `0x00 || domain_separator_hash || record_cid_bytes` where `domain_separator_hash = SHA-256("LCAP-v0.2:" || network_id || ":checkpoint:room_log")`. This binds a tree to one network and rejects cross-network proof replay, at the cost of off-the-shelf CT interop. Deployments that do not need CT-tool interop SHOULD prefer it.

A verifier MUST use the `tree_algorithm` named in the checkpoint and MUST reject a proof computed under a different algorithm.

#### 19.1.2 Proof verification

Inclusion and consistency proofs are verified by the standard RFC 9162 algorithms:

- **Inclusion** (§2.1.3): from `(leaf_index, tree_size, proof_hashes, leaf_cid)`, recompute a candidate root and REQUIRE it equals the checkpoint's `merkle_root`.
- **Consistency** (§2.1.4): from `(old_tree_size, new_tree_size, proof_hashes)`, REQUIRE that the new root provably extends the old root with no leaf rewritten or removed. A failed consistency check between two checkpoints the same authority signed is **fork/equivocation evidence** (§19.6).

### 19.2 Checkpoint record

```ts
type RoomCheckpointRecordV2 = {
  record_version: 2;
  kind: "room_checkpoint";
  room_id: string;
  tree_algorithm: "RFC9162_SHA256" | "LCAP_MERKLE_V2";
  tree_size: number;
  merkle_root: Uint8Array;
  previous_checkpoint_cid?: string;
  accepted_record_range?: { first_seq: number; last_seq: number };
  policy_epoch: number;
  revocation_epoch: number;
  issued_at_ms: number;
  signer_authority_id: string;
};
```

The checkpoint requires an authority proof.

### 19.3 Inclusion proof

```ts
type InclusionProofRecordV2 = {
  record_version: 2;
  kind: "inclusion_proof";
  room_id: string;
  checkpoint_cid: string;
  target_record_cid: string;
  leaf_index: number;
  tree_size: number;
  proof_hashes: Uint8Array[];
};
```

### 19.4 Consistency proof

```ts
type ConsistencyProofRecordV2 = {
  record_version: 2;
  kind: "consistency_proof";
  room_id: string;
  old_checkpoint_cid: string;
  new_checkpoint_cid: string;
  old_tree_size: number;
  new_tree_size: number;
  proof_hashes: Uint8Array[];
};
```

### 19.5 Witness statement

```ts
type WitnessStatementRecordV2 = {
  record_version: 2;
  kind: "witness_statement";
  witness_id: string;
  observed_checkpoint_cid: string;
  observed_tree_size: number;
  observed_merkle_root: Uint8Array;
  observed_at_claim_ms?: number;
  gossip_context?: "https" | "manual_bundle" | "qr" | "relay" | "courier";
};
```

Witnesses do not create canonical room state. They increase confidence that a room authority is not equivocating silently.

### 19.6 Fork evidence

If a client observes two signed checkpoints for the same room and tree size with different Merkle roots, it MUST create or store fork evidence:

```text
checkpoint A
checkpoint B
authority proofs
observed context
```

Fork evidence is C0/P0 and SHOULD be gossiped.

---

## 20. Liveness model

### 20.1 Liveness states

```text
local_created
  User created record locally.

local_signed
  Device proof exists.

queued
  Record is in durable outbox.

packed
  Record has been included in at least one pack.

exported
  User saved/shared a pack containing the record.

peer_stored
  A peer/courier receipt claims storage.

relay_stored
  A relay receipt claims storage.

server_stored
  Licio API stored the record pending validation/reconciliation.

server_accepted
  Licio API accepted the record into room processing.

checkpointed
  A room checkpoint includes the record.

witnessed
  A witness observed the checkpoint.
```

### 20.2 Liveness guarantees

LCAP can guarantee only local properties while offline:

- local events can be signed and queued;
- queued records are not evicted by normal cache GC;
- every sync opportunity attempts C0 then queued P1 records;
- manual export can produce a transferable pack;
- imported records are verifiable independent of path;
- interrupted large transfers can resume.

LCAP cannot guarantee global delivery without some path to other devices, relays, or the server.

### 20.3 Liveness targets

Suggested targets for public content:

```text
C0 revocations/checkpoints/fork evidence: target every eligible sync peer; never below 8 known replicas where possible
T1 signed text contributions:              target 3–5 distinct storage receipts before relaxing
E2 source snapshots/thumbnails:            target 2 distinct replicas when storage permits
M3 media:                                  target 1 server/relay copy plus explicit user demand
B4 bulk:                                   no liveness target
```

For private rooms, replication targets depend on group policy and encryption metadata risk.

### 20.4 Receipts

```ts
type ReceiptRecordV2 = {
  record_version: 2;
  kind: "receipt";
  receipt_type:
    | "stored"
    | "accepted"
    | "rejected"
    | "quarantined"
    | "evicted"
    | "checkpointed";
  issuer_node_id: string;
  subject_cids: string[];
  issued_at_claim_ms?: number;
  storage_until_claim_ms?: number;
  status_detail?: ObjectStatusV2[];
};
```

Receipts are availability hints and audit evidence. They do not prove truth of content.

### 20.5 Outbox durability

The PWA MUST pin:

```text
local drafts
signed outbox records
required proofs for local outbox records
body blocks for local outbox records
export history metadata
server rejection/acceptance receipts
```

Pinned outbox data MUST NOT be evicted by normal LCAP garbage collection.

---

## 21. Replication policy

### 21.1 Priority classes

```text
P0 emergency/trust control
  revocations, checkpoints, fork evidence, device/capability updates, safety notices

P1 text and core semantics
  contributions, edits, corrections, moderation actions, text bodies

P2 evidence/context
  source snapshots, citations, thumbnails, compact summaries

P3 media
  images, video, large attachments

P4 nonessential bulk
  debug-safe aggregates, old cache, optional material
```

### 21.2 Pinning classes

```text
hard_pin
  local outbox, drafts, own proofs, active cert/capability, fresh revocations

user_pin
  saved threads, saved source snapshots, explicit offline packs

policy_pin
  room checkpoint frontier, current room policy, recent moderation state

cache_pin
  recently viewed subscribed room content

courier_pin
  opt-in public replication cache

relay_pin
  relay operator configured storage
```

Eviction MUST respect this order:

```text
P4 ambient cache
old M3 media
old E2 evidence not user-pinned
old P1 from unsubscribed rooms
quarantine overflow
never: hard_pin unless user explicitly deletes account/app data
```

### 21.3 Storage modes

Suggested defaults:

```text
Minimal:      25–50 MB, text/control only, no media prefetch
Standard:     100–250 MB, text + evidence + thumbnails
Courier:      500 MB–2 GB, explicit opt-in public replication
Relay:        operator configured, preferably plugged-in/storage-rich
Stealth:      smallest practical cache, no automatic local discovery/export hints
```

The app SHOULD request persistent storage where available and SHOULD show storage pressure honestly.

### 21.4 Privacy-aware replication

Public content MAY be replicated opportunistically.

In-room content MUST follow room policy.

Private-room content MUST NOT be exported, relayed, or advertised unless encrypted and explicitly allowed by room policy and user selection.

---

## 22. Transport profiles

### 22.1 HTTPS profile

Required endpoints:

```text
POST /api/lcap/v2/exchange
POST /api/lcap/v2/pulse
POST /api/lcap/v2/packs
GET  /api/lcap/v2/records/:recordCid
GET  /api/lcap/v2/proofs/:proofCid
GET  /api/lcap/v2/blocks/:blockCid
GET  /api/lcap/v2/blocks/:blockCid/range
GET  /api/lcap/v2/rooms/:roomId/checkpoint
GET  /api/lcap/v2/rooms/:roomId/proofs/inclusion
GET  /api/lcap/v2/rooms/:roomId/proofs/consistency
POST /api/lcap/v2/bundles/import
GET  /api/lcap/v2/bundles/export
```

The `exchange` endpoint SHOULD be the main path. The `pulse` endpoint is for ultra-small sync opportunities or captive/unstable links.

HTTPS transport SHOULD use app-level chunk/range resume. HTTP/2 or HTTP/3 MAY improve performance where available, but correctness MUST NOT depend on a particular HTTP version.

#### 22.1.1 HTTP status mapping

Transport-level HTTP status is **separate** from per-object `ObjectStatusV2` (§16.11): a `200` exchange routinely carries a body in which individual objects are `quarantined_*` or `rejected_*`. The request-level mapping is:

| HTTP | When | Body |
|---:|---|---|
| `200 OK` | Exchange/pulse processed; per-object outcomes inside | `ExchangeResponseV2` / `PulseResponse` |
| `202 Accepted` | Pack accepted for asynchronous reconciliation | `PackIngestResponse` with `pack_status: "partial"` |
| `400 Bad Request` | Malformed framing, bad magic, undecodable header/table | error object |
| `401 Unauthorized` | Endpoint requires a Licio session the caller lacks | error object |
| `403 Forbidden` | Authenticated but capability/policy forbids the operation | error object |
| `409 Conflict` | Device/checkpoint fork detected at the request level | `ObjectStatusV2[]` incl. `conflict_device_fork` |
| `413 Payload Too Large` | Request exceeds `max_request_bytes`/`max_frame_bytes` (§16.5) | error object |
| `422 Unprocessable` | Schema-valid framing but a hard semantic violation | error object |
| `429 Too Many Requests` | Rate/quota limited; MUST set `Retry-After` and `retry_after_ms` | `{ status: "rate_limited", retry_after_ms }` |
| `503 Service Unavailable` | Server shedding load; client SHOULD back off and retry C0 first | `{ status: "retry_later", retry_after_ms }` |

A client MUST treat `429`/`503` as retriable with exponential backoff and MUST NOT treat `400`/`422` as retriable without changing the request. Per-object `rejected_*` outcomes are **not** retriable; per-object `quarantined_*` outcomes become retriable once the named `missing_cids` are supplied.

### 22.2 Manual bundle profile

Manual bundle exchange is REQUIRED.

Export flow:

```text
choose scope
show privacy warning
estimate size
show included lanes/priorities
stream pack
save/share file
record exported liveness state
```

Import flow:

```text
select file
check size and magic
parse header and table under caps
show summary before rendering
stream frames
verify CIDs
verify schemas
verify proofs
quarantine missing deps
commit verified/provisional records
update liveness states
```

### 22.3 QR micro-bundle profile

QR is for tiny records and control material:

```text
checkpoint frontier
revocation frontier
room invite/contact card
tiny signed emergency notice
small manifest pointer
relay contact card
```

QR MUST show a human-readable summary before display or import. Multi-QR large content SHOULD be deferred unless carefully designed and tested.

### 22.4 Local relay profile

Relays are untrusted object stores.

A relay MAY:

- store records/proofs/blocks by CID;
- exchange pulses and packs;
- enforce quotas;
- verify CIDs and basic schemas;
- optionally verify signatures for resource protection;
- gossip public C0/P1 content upstream;
- serve LAN clients without internet.

A relay MUST NOT:

- mark content globally accepted;
- rewrite records;
- bypass proof validation;
- require private room metadata disclosure;
- store private content unless encrypted and policy permits;
- silently advertise users.

### 22.5 Android courier profile

**Status (maintainer decision, 2026-06): first-class, required v0.2 transport** (previously optional). The native Android courier is now an in-scope deliverable, packaged as a **Capacitor** shell that loads the *unchanged* Licio PWA (same CSP, Trusted Types, service worker, and `lcap_v2` IndexedDB) and exposes the native radio links through a typed plugin. Elevating its priority does **not** relax doctrine: the courier MUST move the *same* packs through the *same* `validate(record_cid)` and lane scheduler (no separate data model or trust path), MUST be off by default and consent-gated (disabled in Stealth/Emergency), and MUST never let a radio/peer identifier enter an LCAP schema. **Correctness MUST NOT depend on the courier** — HTTPS + manual bundle remain sufficient alone.

The courier MUST move the same packs as every other transport.

It MAY use:

```text
Nearby Connections
Wi-Fi Direct
Bluetooth file transfer
local hotspot
USB/import/export
local encrypted cache
```

It MUST expose explicit controls for:

```text
discovery on/off
advertising on/off
who can exchange
which rooms/priorities are shared
storage budget
battery budget
private content exclusion
```

The courier MUST NOT create a separate data model or trust path.

### 22.6 WebTransport/WebRTC profile

**Status (maintainer decision, 2026-06): first-class, required v0.2 transports** (previously deferred).

- **WebTransport (HTTP/3 / QUIC) server transport.** A lower-latency, loss-tolerant browser↔server alternative to the HTTPS profile (§22.1) for flaky mobile links. It uses the platform `WebTransport` API (no npm dependency), reuses the §16 exchange protocol + scheduler order + the single `validate`, preserves the same session/auth/CSRF posture via a session-bound handshake, and MUST fall back to HTTPS when unsupported or blocked.
- **WebRTC data-channel P2P transport.** A browser↔browser transport over `RTCDataChannel` that moves the *same* packs directly between two clients. Signaling (SDP/ICE) rides the existing Licio HTTPS API (a session-bound rendezvous) with public STUN for NAT discovery; an optional, self-hosted TURN relay (off by default) MAY mask peer IPs ("relay-only ICE"). The heavier WebRTC/IPFS browser code lives in a dedicated, **code-split** optional module so the initial-bundle and dependency budgets (§31.1) are not regressed.

Both reuse the *same* packs, the single `validate(record_cid)`, the lane scheduler, and the trust pipeline (no parallel data model or trust path, §18.4). Both are **off by default and consent-gated** per operational mode (disabled in Stealth/Emergency, §33). A WebRTC connection's peer IPs/ICE candidates are a *live-connection* property (as with any HTTPS request) that MUST be disclosed in the connection-privacy UI and MUST NOT be written into any LCAP record/proof/receipt/log schema (§26.4). **Correctness MUST NOT depend on either transport** — HTTPS + manual bundle remain sufficient alone.

### 22.7 Public IPFS/libp2p bridge

**Status (maintainer decision, 2026-06): first-class, required v0.2 transport** (previously deferred), constrained to **public blocks only** and gated on review.

LCAP already content-addresses every block (§9), but the LCAP `block_cid` is a **custom §9 layout, not an IPFS CID**, so the bridge defines a fixed, **verification-preserving mapping** between the two. Because every LCAP block CID embeds a `sha2-256` multihash (`0x12 0x20 || digest`, §9.2), the bridge announces and requests over bitswap under the **standard IPFS CIDv1 with the `raw` multicodec (0x55) and that same `sha2-256` multihash** — i.e. `ipfs_cid = CIDv1(raw, 0x12 0x20 || digest)`, sharing the exact digest of the `block_cid`. On every fetched block it recomputes and verifies the LCAP `block_cid` over the received bytes **before any use**, so DHT/bitswap interop never weakens LCAP hash verification (the IPFS CID is only an interop wrapper; the LCAP `block_cid` remains the trust anchor). The bridge is a browser **Helia / js-libp2p** integration (in the same code-split optional module as the WebRTC transport, §31.1) that publishes and fetches **public** blocks by this mapping. It MUST:

- use the fixed **`CIDv1(raw, sha2-256) ⇄ block_cid`** mapping (shared `sha2-256` digest) to announce/request blocks, and recompute + verify the LCAP `block_cid` on every fetched block before use;
- publish/serve **only `public`-visibility blocks** — never `in_room`, `private`, ciphertext, or any private-room hint (structurally enforced against the room/visibility model and takedown state);
- pass a **required privacy/moderation/abuse-review gate** before any block reaches the public DHT, with auditable provenance and takedown-driven republication halt;
- verify every fetched block against its `block_cid` exactly like any other ingress (no transport trust, §18.4);
- stay off by default and never expose libp2p multiaddrs/peer ids into an LCAP schema (§26.4).

The bridge is an additional *egress/availability* path, never the base layer — the base layer stays HTTPS + manual bundle, and **correctness MUST NOT depend on IPFS** (§37.2).

---

## 23. PWA local storage

### 23.1 IndexedDB stores

LCAP uses a **dedicated `lcap_v2` IndexedDB database, separate from Licio's existing `licio` offline database** (`apps/web/src/offline/db.ts`, which holds saved stories, drafts, thread snapshots, the signal ledger, and the sync queue). Keeping the databases separate lets LCAP versioning, hard-pin GC (§20.5/§21.2), and quarantine evolve without migrating the established WS-C offline stores, and keeps LCAP's content-addressed objects out of the application-level caches. The PWA SHOULD create `lcap_v2` with stores:

```text
records
  record_cid -> body, kind, lane, priority, room_hash, state, size, deps

proofs
  proof_cid -> proof_body, record_cid, signer_key_id, verification_state

blocks
  block_cid -> blob/chunk bytes, descriptor, state, size

chunks
  block_cid + chunk_index -> bytes, hash, received, verified

manifests
  record_cid -> bundle/pack manifest metadata

outbox
  record_cid -> local status, retries, next_retry, capability_id, body_block_cid

quarantine
  cid -> reason, first_seen, source_hint, missing_deps, byte_size

trust_projection
  record_cid -> current trust state, missing deps, last evaluated

liveness
  cid -> local_created, packed, exported, peer_stored, relay_stored, server_stored, accepted, checkpointed, witnessed

frontiers
  room/account/global -> checkpoint/revocation/policy frontier

receipts
  receipt_cid -> receipt body, issuer, subject cids

gc_index
  cid -> pin class, last access, evictable, size
```

### 23.2 IndexedDB best practices

The client SHOULD:

- use indexes for room, priority, state, and pin class;
- avoid loading large stores with `getAll`;
- use cursors/streaming for bundle import/export;
- store large blocks as blobs or chunk records;
- keep metadata and blobs separate;
- commit verification state transactionally;
- cap transaction size for old phones;
- retry on transient quota errors;
- degrade to text/control mode under storage pressure.

### 23.3 Service worker responsibilities

The service worker SHOULD:

- cache the app shell;
- serve cached thread/room snapshots;
- queue failed submissions;
- trigger sync on regain of connectivity where supported;
- avoid relying solely on background sync;
- never import remote scripts dynamically;
- respect data/battery/privacy mode;
- keep C0 sync tiny and fast.

The app itself SHOULD also sync on open, focus, user action, and online events.

---

## 24. Server ingestion and reconciliation

### 24.1 Pipeline

```text
receive pack/request
  ↓
parse under resource caps
  ↓
verify CIDs
  ↓
strict schema validation
  ↓
store raw verified records/proofs/blocks in CAS
  ↓
resolve dependencies
  ↓
verify proofs and authority chain
  ↓
check revocations and policy epochs
  ↓
check capability scopes and quotas
  ↓
check device sequence and forks
  ↓
quarantine or accept
  ↓
append accepted records to room log
  ↓
update room checkpoint schedule
  ↓
return statuses/receipts/wants
```

### 24.2 Quarantine before commit

The server MAY store a record pending dependencies, but it MUST NOT emit it into canonical Licio application state until validation and policy checks pass.

### 24.3 Idempotent acceptance

Canonical acceptance is keyed by `record_cid` and semantic uniqueness constraints.

A repeated event with the same `record_cid` is `already_have`.

A different `record_cid` with the same `(author_device_key_id, device_seq)` is fork evidence.

### 24.4 Topological reconciliation

The server SHOULD process dependency DAGs topologically:

```text
certs/capabilities/revocations/checkpoints first
parents before children where needed
text before media
moderation policy before affected content
```

### 24.5 Receipts

The server SHOULD return signed or authenticated receipts for:

```text
stored
accepted
rejected
quarantined_missing_dependency
checkpointed
```

Receipts help clients display liveness and retry only useful missing items.

---

## 25. Conflict handling

### 25.1 Conflict table

```text
bad CID
  reject

bad schema
  reject

bad signature
  reject proof; keep record body only as untrusted if useful for forensics

unknown key/cert/capability
  quarantine and request missing deps

expired capability
  reject or quarantine according to room policy

revoked key/capability
  mark revoked; do not render as trusted

device sequence fork
  mark conflicting; create/gossip fork evidence

edit conflict
  deterministic projection; preserve full edit chain

moderation conflict
  stricter visible state wins locally until fresh checkpoint/policy resolves

checkpoint fork
  severe consistency warning; gossip fork evidence
```

### 25.2 Deterministic projection

For each thread, visible state is computed from:

```text
canonical room log order if known
valid moderation actions
valid edits/tombstones
room policy
local trust state
user safety mode
```

No client should silently discard conflicting evidence.

---

## 26. Privacy requirements

### 26.1 Interest privacy

LCAP MUST NOT reveal private room membership to unknown peers or relays.

Interest descriptors for unknown peers SHOULD use:

```text
public room IDs only
hashed/opaque room hints where possible
coarse priorities
no contact graph
no account social graph
```

### 26.2 Bundle privacy warnings

Before export, the UI MUST show:

- rooms included;
- whether in-room/private metadata is present;
- whether encrypted private payloads are present;
- approximate size;
- whether media is included;
- whether identities/device IDs are included;
- that recipients may copy the bundle onward.

### 26.3 Stealth mode

Stealth mode SHOULD:

- disable automatic local discovery;
- disable courier advertising;
- disable background relay sync;
- avoid descriptive filenames;
- prefer C0-only sync unless user initiates;
- require confirmation before exports;
- minimize local cache.

### 26.4 Metadata limits

Encrypted content still leaks size, timing, contact, and room-access patterns. Private-room relay/courier support MUST remain conservative until metadata protections are reviewed.

---

## 27. Denial-of-service controls

### 27.1 Resource caps

Every parser MUST enforce:

```text
max pack size
max header size
max table entries
max frame size
max uncompressed size
max compression ratio
max manifest entries
max dependency depth
max missing dependencies per object
max proofs per record
max signature failures per import
max quarantine bytes
max CPU time per import batch
```

### 27.2 Malicious dependency graphs

The validator MUST detect:

- cycles;
- excessive fan-out;
- excessive depth;
- duplicate dependencies;
- private metadata in public exports;
- unknown critical fields.

### 27.3 Relay quotas

Relays SHOULD reserve capacity:

```text
C0 reserved space
T1 reserved space
per-peer quota
per-room quota
max object size
max invalid object ratio
max unverified quarantine
```

### 27.4 Proof-of-work

Proof-of-work is NOT RECOMMENDED for client posting in v0.2 because it wastes battery and hurts low-end devices. Relay-specific abuse controls MAY be evaluated later.

---

## 28. Private rooms and encryption

### 28.1 v0.2 stance

v0.2 should focus on public and in-room plaintext robustness first. Private-room offline replication MUST be conservative.

> **Relationship to `docs/PRIVATE_SPEC.md`.** Fully end-to-end-encrypted, member-hosted **Private P2P rooms** are specified separately in `docs/PRIVATE_SPEC.md`, which owns the room-key authority, MLS group keying, blind rendezvous, and server non-storage contract. The two specs compose rather than overlap: PRIVATE_SPEC is the E2EE *authority and confidentiality* plane; LCAP is a delay-tolerant *availability and transport* substrate. A Private P2P room MAY reuse LCAP mechanisms — the `.licio-bundle` pack as its encrypted offline-exchange (CAR-equivalent) format, the lane scheduler so control/membership material outruns media, liveness states and receipts for replication-health UI, and the "no transport trust / honest trust labels" doctrine — provided LCAP only ever sees **ciphertext blocks and opaque room hints** for such rooms. The encrypted-payload envelope of §28.2 is the minimal LCAP-side carrier; the authoritative private-room envelope, key schedule, and AAD construction are PRIVATE_SPEC §10. Where the two disagree for private-room content, PRIVATE_SPEC wins.

### 28.2 Encrypted payload envelope

```ts
type EncryptedPayloadDescriptorV2 = {
  encryption_version: 2;
  suite: "AES-256-GCM" | "MLS-derived-AEAD";
  key_epoch_id: string;
  nonce: Uint8Array;
  aad_context: Uint8Array;
  ciphertext_block_cid: string;
  plaintext_sha256?: Uint8Array;
  plaintext_size?: number;
};
```

AAD MUST bind:

```text
record_cid
room or opaque group id
key epoch
visibility scope
record kind
sender or sender-blinded context
```

### 28.3 Group keying

Private group encryption SHOULD use MLS or another audited asynchronous group protocol. LCAP MUST NOT invent custom group ratchets.

### 28.4 Revocation in private rooms

Private-room member removal requires a new key epoch. Offline devices that have not received the new epoch MUST be clearly stale and MUST NOT receive newly encrypted content.

---

## 29. API specification

### 29.1 `POST /api/lcap/v2/pulse`

Request:

```ts
type PulseRequest = SyncPulseV2;
```

Response:

```ts
type PulseResponse = {
  pulse: SyncPulseV2;
  critical_pack?: PackBytes;
  retry_after_ms?: number;
};
```

Purpose: tiny C0 exchange under severe bandwidth constraints.

### 29.2 `POST /api/lcap/v2/exchange`

Main bidirectional sync endpoint.

Request: `ExchangeRequestV2`  
Response: `ExchangeResponseV2`

Must be idempotent.

### 29.3 `POST /api/lcap/v2/packs`

Uploads a pack without requiring a full exchange response.

Response:

```ts
type PackIngestResponse = {
  pack_status: "accepted" | "partial" | "rejected";
  object_statuses: ObjectStatusV2[];
  wanted_missing_deps?: WantRequestV2[];
  receipts?: ReceiptRecordV2[];
};
```

### 29.4 `GET /api/lcap/v2/records/:recordCid`

Returns record body plus optional proofs if authorized.

### 29.5 `GET /api/lcap/v2/proofs/:proofCid`

Returns proof object.

### 29.6 `GET /api/lcap/v2/blocks/:blockCid/range`

Returns resumable block ranges.

### 29.7 Checkpoint endpoints

```text
GET /api/lcap/v2/rooms/:roomId/checkpoint
GET /api/lcap/v2/rooms/:roomId/proofs/inclusion?record_cid=...
GET /api/lcap/v2/rooms/:roomId/proofs/consistency?old=...&new=...
```

### 29.8 Bundle import/export endpoints

These are convenience endpoints for web UI flows. They MUST use the same pack validation as every other path.

---

## 30. Database additions

Suggested tables:

```text
lcap_records
  record_cid PK
  kind
  body_bytes
  body_sha256
  lane
  priority
  home_room_id nullable
  visibility_scope
  first_seen_at
  validation_state

lcap_proofs
  proof_cid PK
  record_cid FK
  proof_kind
  signer_key_id
  algorithm
  proof_bytes
  verification_state

lcap_blocks
  block_cid PK
  size_bytes
  media_type
  role
  storage_uri
  sha256
  state

lcap_chunks
  block_cid
  chunk_index
  offset
  length
  chunk_sha256
  storage_uri

lcap_device_certs
  record_cid PK
  account_id
  device_id
  device_key_id
  not_before
  not_after
  account_epoch
  state

lcap_capabilities
  record_cid PK
  capability_id
  subject_device_key_id
  room_id
  operations
  policy_epoch
  revocation_epoch_floor
  not_after
  quotas
  state

lcap_capability_usage
  capability_id
  subject_device_key_id
  device_seq
  record_cid
  bytes_used

lcap_revocations
  record_cid PK
  revoked_kind
  revoked_id
  revocation_epoch
  effective_at

lcap_room_log
  room_id
  room_seq
  record_cid
  accepted_at
  checkpoint_cid nullable

lcap_room_checkpoints
  record_cid PK
  room_id
  tree_size
  merkle_root
  policy_epoch
  revocation_epoch
  issued_at

lcap_receipts
  record_cid PK
  receipt_type
  issuer_node_id
  subject_cids
  issued_at

lcap_quarantine
  cid
  cid_kind
  reason
  missing_cids
  first_seen_at
  source_hint
  bytes

lcap_fork_evidence
  evidence_cid PK
  evidence_kind
  room_id nullable
  device_key_id nullable
  related_cids
  severity
  first_seen_at
```

Database writes MUST preserve Licio’s existing trust-boundary validation style.

---

## 31. Implementation package layout

Recommended monorepo additions:

```text
packages/lcap/
  src/cbor/                 deterministic CBOR profile
  src/cid/                  hash and CID utilities
  src/cose/                 detached proof envelope helpers
  src/schemas/              zod schemas for records/proofs/packs
  src/validate/             trust projection and dependency validation
  src/pack/                 streaming pack writer/reader
  src/scheduler/            lane scheduler and budgets
  src/sync/                 exchange types and state machine
  src/test-vectors/         canonical bytes, CIDs, signatures

apps/web/src/lcap/
  db.ts                     IndexedDB schema and migrations
  outbox.ts                 local signing/queueing
  sync.ts                   pulse/exchange/fetch orchestration
  bundleExport.ts           streaming export
  bundleImport.ts           safe import/quarantine
  trustBadges.tsx           UI state projection (React)
  storagePolicy.ts          GC and storage modes
  transports/               code-split transport chunk (WebTransport, and the
                            lazy entry to @licio/lcap-p2p); never in the initial bundle

packages/lcap-p2p/          OPTIONAL workspace package (@licio/lcap-p2p): WebRTC
  src/webrtc/               data-channel transport + HTTPS-signaling client
  src/ipfs/                 Helia/js-libp2p public-block bridge (public blocks only)
                            — carries the heavier deps behind a workspace boundary so
                            apps/web's <15 direct-dep budget and the initial-bundle gate hold

apps/courier/               OPTIONAL Capacitor Android native shell: loads the unchanged
  android/                  web client; a typed Nearby Connections / Wi-Fi Direct plugin
  src/plugin/               streams the same packs over native radio links. @capacitor/*
                            deps are build/native-scoped, not apps/web production deps

apps/api/src/lcap/
  routes.ts                 Hono endpoints (incl. the P2P-signaling rendezvous + WebTransport)
  ingest.ts                 pack ingestion
  verify.ts                 proof/capability/revocation checks
  reconcile.ts              room log append and dependency resolution
  checkpoints.ts            Merkle checkpointing
  receipts.ts               receipt emission

packages/db/src/schema/lcap.ts
  Drizzle schema additions
```

`apps/web` MUST NOT import `@licio/db`. `packages/lcap` MUST be a pure shared package with **zero** runtime npm dependencies and no database dependency. `@licio/lcap-p2p`'s only permitted **workspace** dependencies are `@licio/shared` + `@licio/lcap` (never `@licio/db`); it additionally carries the reviewed transport **npm** dependencies it exists to isolate — Helia / js-libp2p (and any WebRTC helper) — each of which passes the §31.1 dependency-addition checklist and stays out of the core bundle because the package is consumed by `apps/web` solely through the lazily-loaded `apps/web/src/lcap/transports/` chunk (excluded from the `apps/web` `< 15` direct-production-dep count).

### 31.1 Dependency budget and bundle strategy

LCAP MUST fit Licio's existing budgets (CLAUDE.md): `apps/web` < 15 and `apps/api` < 20 direct production dependencies, initial JS < 200 KB gz, and the `check:workspace-deps` boundaries.

- **Prefer Web platform APIs.** SHA-256 and ECDSA come from **WebCrypto** (`crypto.subtle`); pack/HTTP compression comes from **Compression Streams** (§13.5); chunk storage from **IndexedDB**. None of these is an npm dependency.
- **Hand-roll the deterministic CBOR subset.** LDC (§9.1) is a small, closed grammar — integers, byte/text strings, arrays, maps, three simple values. A purpose-built encoder/decoder in `packages/lcap/src/cbor/` is a few hundred lines, avoids a general-purpose CBOR/COSE dependency, and is easier to pin to the conformance vectors than a third-party library. The same applies to the COSE_Sign1 `Sig_structure` (§10.2), which is one fixed array shape.
- **Zero-dependency core.** `packages/lcap` (the codec/CID/COSE/schema/validate/pack/scheduler/sync core) MUST carry **zero** runtime npm dependencies and is `workspace:*` (excluded from the `apps/web` direct-dep count). The web LCAP module (`apps/web/src/lcap/`) MUST be **code-split** and loaded only when sync/bundle features are used, so the initial-load bundle-size gate is unaffected.
- **Isolate the elevated optional-transport dependencies (WebRTC, Helia/js-libp2p, Capacitor).** The 2026-06 elevation of WebTransport/WebRTC/IPFS/courier to first-class transports introduces reviewed dependencies that MUST be structurally prevented from regressing the budgets: (a) **WebTransport** uses the platform `WebTransport` API — no dependency; (b) the **WebRTC** plumbing and the **Helia/js-libp2p** browser bridge live in a dedicated optional workspace package `@licio/lcap-p2p` (`workspace:*`, excluded from the `apps/web` `<15` direct-production-dep count) loaded **only** from a separately code-split `apps/web/src/lcap/transports/` chunk, so they never enter the < 200 KB initial bundle; (c) the **native courier's** `@capacitor/*` dependencies live in the `apps/courier` native-shell project (build/native scope), not in `apps/web` production deps. Each such dependency MUST pass the CLAUDE.md §6.12.12 dependency-addition checklist (no install scripts, AGPL-compatible license, transitive count reviewed, SBOM updated). A CI gate asserts the P2P deps never reach `apps/web`'s direct-dep set or the initial bundle.
- **No new `any`, no raw egress, no transport-metadata in schemas.** LCAP schemas pass the same trust-boundary zod validation as the rest of Licio and MUST satisfy `check:no-raw-egress` and `check:no-applause` (§3.7): no attention traces, no client IP/location, no like/vote/karma fields anywhere in LCAP records, proofs, or receipts. The elevated transports add no exception: WebRTC peer IPs/ICE candidates, libp2p multiaddrs/peer ids, and courier radio identifiers are live-connection properties that MUST NOT appear in any LCAP schema (a new `check:lcap-schema-egress` gate scans `packages/lcap`, `@licio/lcap-p2p`, and `apps/courier`).

---

## 32. Testing and verification

### 32.1 Deterministic test vectors

Create vectors for:

- deterministic CBOR encoding;
- record CID computation;
- proof CID computation;
- ES256 low-S signature verification;
- rejected high-S signature;
- detached proof domain separation;
- pack parsing;
- chunk verification;
- checkpoint inclusion proof;
- checkpoint consistency proof.

### 32.2 Property tests

Properties:

```text
encoding same semantic record always yields same bytes
unknown critical fields fail closed
record_cid never depends on signature bytes
duplicate imports are idempotent
malformed packs never render trusted content
all visible records have dependency closure or clear provisional label
C0 lane cannot be starved by M3/B4 lane
outbox hard pins are never GCed by normal eviction
forked device sequence is detected
checkpoint forks are detected
```

### 32.3 Network simulation

Build a simulator with:

- random partitions;
- short contacts;
- asymmetric links;
- message loss;
- duplicate/replay delivery;
- malicious relays;
- storage pressure;
- wrong clocks;
- stale revocation state;
- device key compromise;
- server checkpoint equivocation.

Metrics:

```text
P0 propagation time
P1 text convergence time
bytes per accepted record
outbox age
quarantine ratio
checkpoint freshness
fork detection latency
media starvation prevention
battery/storage budget compliance
```

### 32.4 Security tests

Test:

- zip/pack bombs;
- CBOR duplicate keys;
- invalid lengths;
- nested manifests;
- signature malleability;
- unknown algorithms;
- downgrade attempts;
- replay attacks;
- revoked capabilities;
- capability quota overuse;
- import of private metadata into public mode;
- malicious Markdown payloads through existing Licio UGC sink.

### 32.5 Interoperability tests

A record signed in browser MUST verify in Node. A record signed in Node MUST verify in browser. A bundle exported from one browser profile MUST import into another without semantic changes.

---

## 33. Operational modes

### 33.1 Minimal mode

```text
C0 + T1 only
no media prefetch
small storage budget
manual sync emphasized
aggressive GC
```

### 33.2 Standard mode

```text
C0 + T1 + selected E2
thumbnails allowed
source snapshots for saved/subscribed threads
normal storage budget
```

### 33.3 Courier mode

```text
explicit opt-in
public C0/T1/E2 replication
larger cache
clear battery/storage warnings
no private content by default
```

### 33.4 Relay mode

```text
operator-controlled storage
LAN-first
upstream sync opportunistic
strict quotas
observability without user surveillance
```

### 33.5 Stealth/high-risk mode

```text
no automatic discovery
no local advertising
manual-only bundle exchange
generic filenames
small cache
clear trust warnings
private metadata minimized
```

### 33.6 Emergency text mode

```text
text/control only
all media disabled
P0/P1 only
one-tap export of selected public emergency thread
QR checkpoint/revocation support
```

---

## 34. User-visible language

LCAP’s UI MUST be honest.

Recommended labels:

```text
Saved on this device
Queued for sync
Shared in exported bundle
Stored by nearby relay
Received by Licio server
Accepted by room
Included in room checkpoint
Witnessed by independent checkpoint watcher
Verified locally, but checkpoint is stale
Cannot verify yet: missing key/capability
Conflict detected
Revoked
Rejected by room policy
```

Avoid labels like:

```text
secure
trusted
delivered
final
safe
```

unless the exact meaning is shown.

---

## 35. Roadmap

### Phase 0 — Record identity and proofs

Shipped as the `@licio/lcap` package (WS-R.0; `docs/lcap/README.md`).

```text
[x] deterministic CBOR v2 profile        (packages/lcap/src/cbor)
[x] record_cid independent of proof bytes (packages/lcap/src/cid + cose; property-pinned)
[x] detached proof object                 (COSE_Sign1, packages/lcap/src/cose/sign1.ts)
[x] ES256 low-S test vectors              (packages/lcap/src/cose/ecdsa.ts + test-vectors/sign1.json)
[x] strict zod schemas                    (packages/lcap/src/schemas)
```

### Phase 1 — PWA outbox and HTTPS exchange

The identity/record + **sync-decision** protocol core for this phase ships in
`@licio/lcap` (WS-R.1/R.2 and the WS-R.6/R.7 pulse/exchange/reconciliation
logic); the IndexedDB, HTTP endpoint, server-ingestion, and UI bindings below are
the remaining (I/O) deliverable.

```text
[x] device enrollment             (cert core: packages/lcap/src/identity/cert.ts)
[x] capability issuance           (core: packages/lcap/src/identity/capability.ts)
[x] offline text event signing    (record + proof core: packages/lcap/src/records + cose)
[ ] IndexedDB lcap_v2 stores
[ ] pulse/exchange endpoint       (decision core: packages/lcap/src/sync — pulse/exchange/budgets/interests/wants; HTTP endpoint = WS-R.12.4)
[ ] idempotent server ingestion   (idempotency keying: packages/lcap/src/sync/ingest.ts; durable server store = WS-R.12)
[ ] trust projection UI           (projection logic ships in packages/lcap/src/validate; UI pending)
```

### Phase 2 — Packfiles and manual bundles

The pack **codec** (streaming writer/reader, partial import + quarantine logic,
malicious-bundle hardening) ships in `@licio/lcap` (WS-R.4); the file-system /
UI bindings remain.

```text
[x] streaming pack writer         (packages/lcap/src/pack/writer.ts)
[x] streaming pack reader         (packages/lcap/src/pack/reader.ts)
[ ] manual export/import          (codec ships in packages/lcap/src/pack/import.ts; file/UI binding pending)
[ ] quarantine UI                 (import-quarantine logic ships in packages/lcap/src/pack; UI pending)
[ ] storage budget UI
[x] malicious bundle tests        (packages/lcap/src/__tests__/pack.test.ts: cap/tamper/CID matrix)
```

### Phase 3 — Checkpoints and liveness

The entire **protocol core** of this phase ships in `@licio/lcap`
(WS-R.9/R.10); durable server persistence of the room log is WS-R.12.

```text
[x] room log append               (append logic: packages/lcap/src/checkpoint/log.ts; durable store = WS-R.12)
[x] signed checkpoints            (packages/lcap/src/checkpoint/record.ts)
[x] inclusion proofs              (RFC 9162: packages/lcap/src/checkpoint/merkle.ts + inclusion.ts)
[x] consistency proofs            (RFC 9162: packages/lcap/src/checkpoint/merkle.ts + consistency.ts)
[x] liveness state machine        (packages/lcap/src/liveness/states.ts)
[x] receipts                      (packages/lcap/src/liveness/receipts.ts)
```

### Phase 4 — Relay and WebTransport

```text
[ ] untrusted relay service
[ ] relay quotas
[ ] relay pulse/exchange
[ ] upstream sync
[ ] LAN documentation
[ ] WebTransport (HTTP/3) server transport + HTTPS fallback
```

### Phase 5 — Native courier and browser P2P (required, 2026-06)

```text
[ ] Capacitor native shell loading the unchanged web client + native-build CI
[ ] shared LcapTransport seam (HTTPS/relay/courier/WebRTC all implement it)
[ ] Nearby Connections typed plugin + chunked pack streaming
[ ] Wi-Fi Direct / hotspot / Bluetooth / USB channels (USB == .licio-bundle)
[ ] courier controls + private-content exclusion + radio-metadata disclosure
[ ] WebRTC data-channel P2P transport + HTTPS signaling + STUN
[ ] WebRTC NAT traversal + connection-privacy controls (optional TURN, off by default)
[ ] off by default; disabled in Stealth/Emergency; no transport metadata in schemas
```

### Phase 6 — IPFS public bridge, transport hardening, and advanced trust/privacy

```text
[ ] browser Helia/js-libp2p public-block bridge (code-split, public blocks only)
[ ] IPFS publish review gate + public-only structural enforcement + takedown halt
[ ] transport dependency-budget + schema-egress CI gates (P2P deps isolated)
[ ] transport network-simulation scenarios + correctness-independent-of-transport
[ ] witness network
[ ] private-room MLS design
[ ] optional Ed25519/PQ hybrid proofs
[ ] smarter set reconciliation
[ ] optional erasure coding for one-way broadcast
[ ] external security audit (incl. the P2P/courier transport surface)
```

---

## 36. Acceptance gates

LCAP v0.2 is not production-ready for high-risk use until:

```text
[ ] record_cid/proof separation implemented
[ ] deterministic encoding vectors are stable
[ ] browser and Node crypto interop vectors pass
[ ] malformed pack fuzz tests pass
[ ] C0 starvation tests pass
[ ] outbox durability tests pass
[ ] revocation propagation tests pass
[ ] checkpoint consistency tests pass
[ ] UI trust labels are reviewed
[ ] no raw attention/IP/location data appears in LCAP schemas
[ ] storage pressure behavior is tested on low-end Android
[ ] import/export privacy warnings are implemented
[ ] threat model is reviewed by an external security reviewer
[ ] private-room replication is disabled or separately audited
[ ] every transport (HTTPS, bundle, QR, relay, WebTransport, WebRTC, IPFS, courier) funnels through the one validate/LcapTransport seam
[ ] correctness-independent-of-transport: any transport subset (HTTPS-only included) reaches the identical accepted set + trust state
[ ] no peer IP / multiaddr / radio identifier appears in any LCAP schema (check:lcap-schema-egress over @licio/lcap-p2p + apps/courier)
[ ] WebRTC/IPFS deps stay code-split + workspace-excluded (initial-bundle < 200 KB gz and apps/web < 15 direct-dep budgets hold)
[ ] IPFS publishes public blocks only, behind the privacy/moderation/abuse-review gate, with takedown-driven republication halt
[ ] all P2P/courier transport reach is off by default and disabled in Stealth/Emergency
[ ] the apps/courier Capacitor native build is green in CI and loads the unchanged web client
```

---

## 37. Rejected or deferred alternatives

### 37.1 Full BPv7 implementation

Deferred. BPv7 is the right architectural inspiration but too heavy for the first Licio PWA implementation.

### 37.2 Public IPFS as the *base layer*

Still rejected **as the base layer**: the base transport stays HTTPS + manual bundle, and correctness MUST NOT depend on any DHT. The moderation/privacy/abuse complexity of public DHT participation is real and is the reason the in-scope IPFS bridge (§22.7, elevated 2026-06) is constrained to **public blocks only, behind a required privacy/moderation/abuse-review gate**, as an additional egress — not a foundation.

### 37.3 Browser Bluetooth mesh

*Browser* Bluetooth/Wi-Fi mesh (the Web Bluetooth API) remains rejected for v0.2 — it is not portable enough for the baseline PWA. This does **not** defer P2P: browser-to-browser transfer is delivered by the in-scope **WebRTC** data-channel transport (§22.6), and native Bluetooth / Wi-Fi Direct / Nearby Connections are delivered by the in-scope **Capacitor courier** (§22.5) — both elevated to first-class in 2026-06.

### 37.4 Proof-of-work posting

Rejected for v0.2 because it burns scarce battery and disadvantages low-end phones.

### 37.5 Media-first replication

Rejected. Media must never block control or text liveness.

### 37.6 Custom group crypto

Rejected. Private group encryption must use audited protocols.

### 37.7 Signature bytes as semantic event ID

Rejected. `record_cid` must be independent of proof bytes for deduplication, multi-proof support, and ECDSA robustness.

---

## 38. Risk register

| Risk | Impact | Mitigation |
|---|---:|---|
| Browser storage eviction | High | persistent storage request, hard pins, export reminders, liveness states |
| Device key loss | Medium | replaceable device certs, revocation, clear device state UI |
| Malicious bundle import | High | streaming parser, caps, quarantine, schema validation, no render before trust projection |
| Revocation delay | High | short-lived capabilities, P0 revocation lane, stale labels |
| Media clogging | High | lane scheduler, byte reservations, lazy media |
| Private metadata leak | High | manual mode, private replication disabled by default, opaque room hints |
| Server equivocation | High | signed checkpoints, consistency proofs, witness gossip |
| Relay censorship | Medium | multiple relays, manual bundles, receipts as hints, no relay trust |
| Old-phone CPU limits | High | fixed chunking, no mandatory FEC/CDC/PQ, small batches |
| False UI certainty | High | explicit trust/liveness labels |
| Dependency bombs | High | caps on depth/fan-out/missing deps |
| Algorithm downgrade | High | fail-closed suite negotiation |
| WebRTC/courier peer-IP & radio-metadata exposure | High | transport-layer only, never in schemas; pre-connection disclosure; off by default; Stealth/Emergency-disabled; optional relay-only-ICE (TURN) to mask IP |
| Public DHT (IPFS) abuse / moderation evasion | High | public blocks only; required privacy/moderation/abuse-review gate; takedown-driven republication halt; content-addressed; never private/in-room/ciphertext |
| Heavy P2P dependency (Helia/js-libp2p) supply chain | Medium | confined to the code-split `@licio/lcap-p2p` workspace pkg; §6.12.12 dependency-addition review; install-script ban; SBOM; `pnpm audit` gate |
| Native courier attack surface (Capacitor shell) | Medium | loads the unchanged web client (same CSP/Trusted Types); reuses the single validate pipeline; no parallel data model; native deps build-scoped |
| NAT traversal / TURN operational cost & privacy | Medium | STUN-first; TURN optional, self-hosted, off by default; correctness independent of any transport |

---

## 39. Reference standards and design anchors

These are anchors for implementers. The LCAP spec should cite exact versions when merged into the repository.

- BCP 14 (RFC 2119, RFC 8174) — normative keyword interpretation.
- RFC 4648 — Base16/Base32/Base64 data encodings, especially base32 (§6) used for CID string form.
- RFC 8949 — Concise Binary Object Representation (CBOR), especially §4.2.1 core deterministic encoding.
- RFC 9052 / RFC 9053 — CBOR Object Signing and Encryption (COSE) structures and algorithms.
- RFC 9171 — Bundle Protocol Version 7, especially store-carry-forward and convergence-layer separation.
- RFC 9172 — Bundle Protocol Security, especially the lesson that disrupted networks need object/bundle-layer integrity and confidentiality.
- RFC 6962 — Certificate Transparency v1, the origin of the domain-separated leaf/node Merkle hashing reused in §19.1.1.
- RFC 9162 — Certificate Transparency v2, especially Merkle inclusion and consistency proofs (§2.1.3/§2.1.4).
- RFC 9420 / RFC 9750 — Messaging Layer Security protocol and architecture for future private-room group keying.
- RFC 9000 / RFC 9114 — QUIC and HTTP/3, the substrate for the WebTransport server transport (§22.6).
- W3C WebTransport API — the browser↔server WebTransport transport (§22.6); uses the platform API, no dependency.
- W3C WebRTC 1.0 + IETF RTCWEB (RFC 8825/8826/8827/8829 — overview, security, security architecture, JSEP) — the browser↔browser data-channel transport (§22.6).
- libp2p specifications (Kademlia DHT, bitswap, multiformats/CID, multiaddr) and the Helia/js-libp2p implementations — the public-block IPFS bridge (§22.7), public blocks only behind review; code-split to protect the bundle/dependency budgets (§31.1).
- RFC 8878 / RFC 9659 — zstd media/content coding and window limits, optional negotiated compression.
- RFC 6330 / RFC 8681 — optional future erasure/FEC designs for one-way or lossy broadcast; not required in v0.2.
- NIST FIPS 203/204/205 — post-quantum key encapsulation and signature standards for future algorithm agility.
- MDN Web Crypto, Service Worker, IndexedDB, StorageManager, Background Sync, and Compression Streams documentation for PWA implementation constraints.
- Android Nearby Connections and Wi-Fi Direct documentation, and the Capacitor framework, for the first-class native courier (§22.5): a Capacitor shell loads the unchanged web client and a typed plugin bridges the native radio links.
- Briar and Bridgefy security analyses as practical lessons: offline mesh can be useful, but unaudited or misleading security claims can endanger users.

---

## Appendix A. Minimal record/proof example

### A.1 Event body

```jsonc
{
  "record_version": 2,
  "kind": "contribution_event",
  "event_type": "correction",
  "home_room_id": "room_123",
  "visibility_scope": "public",
  "author_account_id": "acct_abc",
  "author_device_id": "dev_abc_phone",
  "author_device_key_id": "key_abc",
  "device_seq": 42,
  "prev_device_record_cid": "lcapr_...",
  "capability_cid": "lcapr_cap_...",
  "policy_epoch_claim": 7,
  "revocation_epoch_claim": 19,
  "parent_record_cids": ["lcapr_parent_..."],
  "body_block_cid": "lcapb_body_...",
  "client_nonce": "base64url-random",
  "priority": 1,
  "licio_contribution_type": "correction",
  "markdown_profile": "licio_markdown_lite_v1"
}
```

The `record_cid` is computed over the deterministic CBOR encoding of that body.

### A.2 Detached proof

```jsonc
{
  "proof_version": 2,
  "proof_kind": "device_signature",
  "record_cid": "lcapr_event_...",
  "record_kind": "contribution_event",
  "signer_key_id": "key_abc",
  "external_aad": "LCAP-v0.2:prod:proof:device_signature",
  "cose_protected": "...",
  "signature": "raw-r-s-low-S"
}
```

The proof signs the record body as detached payload.

---

## Appendix B. Example sync flows

### B.1 Brief mobile-data window

```text
1. User opens Licio with 15 seconds of weak data.
2. Client sends exchange pulse with revocation/checkpoint frontier and small outbox pack.
3. Server processes P0/P1 first.
4. Server responds with revocations, fresh checkpoint, acceptance receipt, and small text updates.
5. Media is not transferred.
6. UI shows local post as server accepted or explains the missing dependency.
```

### B.2 Manual ferry

```text
1. User exports public C0/T1 bundle from phone A.
2. Bundle is moved by USB/Bluetooth OS share/SD card/messaging app.
3. Phone B imports.
4. B verifies CIDs and proofs.
5. B renders locally authorized records with provisional/stale labels where appropriate.
6. Later B syncs to server and receives checkpoint proofs.
```

### B.3 Relay in clinic

```text
1. Clinic relay runs on local Wi-Fi with intermittent satellite.
2. Phones exchange C0/T1 packs with relay.
3. Relay stores by CID and returns storage receipts.
4. Relay cannot mark content accepted.
5. When satellite returns, relay syncs upstream.
6. Phones later receive room checkpoints and acceptance receipts.
```

### B.4 Checkpoint fork

```text
1. User A receives checkpoint C1 for room R at tree size 500.
2. User B receives checkpoint C2 for room R at tree size 500.
3. C1 and C2 have different Merkle roots but valid authority proofs.
4. A and B exchange checkpoints by QR or bundle.
5. Both clients detect fork evidence.
6. Fork evidence is C0 and gossiped.
7. UI shows severe consistency warning.
```

---

## Appendix C. Minimal implementation checklist

```text
[ ] deterministic CBOR encoder/decoder with vectors
[ ] record_cid excludes proof/signature bytes
[ ] detached proof schema with domain separation
[ ] ES256 low-S sign/verify interop browser ↔ Node
[ ] device certificate records and proofs
[ ] room capability records and proofs
[ ] revocation records and P0 lane scheduling
[ ] contribution event records with device sequence chain
[ ] IndexedDB lcap_v2 stores and hard-pin GC
[ ] /api/lcap/v2/pulse
[ ] /api/lcap/v2/exchange
[ ] streaming pack writer/reader
[ ] manual .licio-bundle import/export
[ ] trust projection state machine
[ ] liveness state machine
[ ] server quarantine before commit
[ ] idempotent ingestion
[ ] room checkpoints and inclusion/consistency proof stubs
[ ] malicious pack tests
[ ] storage pressure tests
[ ] UI labels for provisional/stale/conflict/revoked/rejected
[ ] no raw attention traces or client location/IP fields in LCAP schemas
[ ] documentation warns against relying on private/offline high-risk use before audit
```

---

# End of specification
